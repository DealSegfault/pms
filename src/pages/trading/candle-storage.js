// ── Candle Cache — localStorage persistence layer ────────────
// Persists kline data per symbol+timeframe to avoid re-fetching
// the full 500-bar history on every page load. Only missing (newer)
// candles are fetched from the server.

const STORAGE_PREFIX = 'pms_candles_';
const MAX_CANDLES = 600;          // keep at most 600 bars per key
const MAX_CACHED_KEYS = 20;       // evict oldest keys beyond this
const CACHE_VERSION = 1;

/**
 * Load cached candles from localStorage.
 * @returns {{ data: object[], lastTime: number } | null}
 */
export function loadFromStorage(symbol, interval) {
    try {
        const raw = localStorage.getItem(_key(symbol, interval));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed.v !== CACHE_VERSION || !Array.isArray(parsed.d) || !parsed.d.length) return null;
        return { data: parsed.d, lastTime: parsed.lt };
    } catch {
        return null;
    }
}

/**
 * Persist candles to localStorage (write-through).
 */
export function saveToStorage(symbol, interval, candles, lastTime) {
    try {
        // Trim to MAX_CANDLES (keep most recent)
        const trimmed = candles.length > MAX_CANDLES
            ? candles.slice(candles.length - MAX_CANDLES)
            : candles;

        const payload = JSON.stringify({
            v: CACHE_VERSION,
            d: trimmed,
            lt: lastTime,
            ts: Date.now(),
        });

        localStorage.setItem(_key(symbol, interval), payload);
        _evictOldKeys();
    } catch (e) {
        // Storage full — evict aggressively and retry once
        if (e.name === 'QuotaExceededError') {
            _evictOldKeys(5);
            try {
                const trimmed = candles.length > MAX_CANDLES
                    ? candles.slice(candles.length - MAX_CANDLES)
                    : candles;
                localStorage.setItem(_key(symbol, interval), JSON.stringify({
                    v: CACHE_VERSION,
                    d: trimmed,
                    lt: lastTime,
                    ts: Date.now(),
                }));
            } catch { /* give up silently */ }
        }
    }
}

/**
 * Remove cache for a specific symbol (all timeframes).
 */
export function clearSymbolCache(symbol) {
    const prefix = _key(symbol, '');
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
}

// ── Internal helpers ──────────────────────────────────────────

function _key(symbol, interval) {
    return `${STORAGE_PREFIX}${symbol}_${interval}`;
}

/** Evict oldest cache keys when we exceed MAX_CACHED_KEYS. */
function _evictOldKeys(forceEvictCount = 0) {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
            try {
                const raw = localStorage.getItem(k);
                const parsed = JSON.parse(raw);
                entries.push({ key: k, ts: parsed.ts || 0 });
            } catch {
                entries.push({ key: k, ts: 0 });
            }
        }
    }

    if (entries.length <= MAX_CACHED_KEYS && forceEvictCount <= 0) return;

    // Sort oldest first
    entries.sort((a, b) => a.ts - b.ts);

    const removeCount = Math.max(
        entries.length - MAX_CACHED_KEYS,
        forceEvictCount,
    );
    for (let i = 0; i < removeCount && i < entries.length; i++) {
        localStorage.removeItem(entries[i].key);
    }
}

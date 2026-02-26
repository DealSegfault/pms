import Redis from 'ioredis';

let redis = null;
const RISK_SNAPSHOT_TTL_SEC = parseInt(process.env.RISK_SNAPSHOT_TTL_SEC || '120', 10);
const STREAM_MAXLEN = parseInt(process.env.REDIS_STREAM_MAXLEN || '20000', 10);



export function getRedis() {
    if (!redis) {
        redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                if (times > 5) return null; // Stop retrying after 5 attempts
                return Math.min(times * 200, 2000);
            },
            lazyConnect: true,
        });

        redis.on('error', (err) => {
            if (err.code !== 'ECONNREFUSED') {
                console.error('[Redis] Error:', err.message);
            }
        });

        redis.on('connect', () => {
            console.log('[Redis] Connected');
        });
    }
    return redis;
}

function _serializePayload(payload) {
    if (payload == null) return '{}';
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload);
    } catch {
        return '{}';
    }
}

function _parseStreamFields(fieldsArray) {
    const obj = {};
    for (let i = 0; i < fieldsArray.length; i += 2) {
        obj[fieldsArray[i]] = fieldsArray[i + 1];
    }
    return obj;
}

/**
 * Try connecting to Redis. Returns true if connected, false if unavailable.
 * PMS works without Redis (falls back to in-memory) but with reduced performance.
 */
export async function initRedis() {
    try {
        const r = getRedis();
        await r.connect();
        await r.ping();
        console.log('[Redis] ✓ Ready');
        return true;
    } catch (err) {
        console.warn('[Redis] ⚠ Not available — running without Redis (in-memory fallback)');
        redis = null;
        return false;
    }
}

// ── Redis Stream Helpers ───────────────────────────

export async function streamAdd(stream, fields = {}, maxlen = STREAM_MAXLEN) {
    if (!redis) return null;
    const argv = ['MAXLEN', '~', String(maxlen), '*'];
    for (const [key, value] of Object.entries(fields)) {
        argv.push(String(key), String(value));
    }
    return redis.xadd(stream, ...argv);
}

export async function streamEnsureGroup(stream, group, startId = '0') {
    if (!redis) return false;
    try {
        await redis.xgroup('CREATE', stream, group, startId, 'MKSTREAM');
        return true;
    } catch (err) {
        if (String(err?.message || '').includes('BUSYGROUP')) return true;
        throw err;
    }
}

export async function streamReadGroup(stream, group, consumer, { count = 50, blockMs = 5000 } = {}) {
    if (!redis) return [];
    const rows = await redis.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', String(count),
        'BLOCK', String(blockMs),
        'STREAMS', stream, '>',
    );
    if (!rows || !rows.length) return [];
    const entries = rows[0]?.[1] || [];
    return entries.map(([id, fields]) => ({
        id,
        fields: _parseStreamFields(fields),
    }));
}

export async function streamAutoClaim(
    stream,
    group,
    consumer,
    minIdleMs = 60000,
    startId = '0-0',
    { count = 50 } = {},
) {
    if (!redis) return { nextId: startId, entries: [] };
    const rows = await redis.xautoclaim(
        stream,
        group,
        consumer,
        String(minIdleMs),
        startId,
        'COUNT',
        String(count),
    );
    if (!rows || !Array.isArray(rows) || rows.length < 2) {
        return { nextId: startId, entries: [] };
    }

    const nextId = String(rows[0] || startId);
    const claimed = Array.isArray(rows[1]) ? rows[1] : [];
    const entries = claimed.map(([id, fields]) => ({
        id,
        fields: Array.isArray(fields)
            ? _parseStreamFields(fields)
            : (fields && typeof fields === 'object' ? fields : {}),
    }));
    return { nextId, entries };
}

export async function streamAck(stream, group, id) {
    if (!redis) return 0;
    return redis.xack(stream, group, id);
}

export async function streamReadFrom(stream, lastId = '$', { count = 10, blockMs = 5000 } = {}) {
    if (!redis) return [];
    const rows = await redis.xread(
        'COUNT', String(count),
        'BLOCK', String(blockMs),
        'STREAMS', stream, lastId,
    );
    if (!rows || !rows.length) return [];
    const entries = rows[0]?.[1] || [];
    return entries.map(([id, fields]) => ({
        id,
        fields: _parseStreamFields(fields),
    }));
}



// ── Order Mapping ────────────────────────────────
// Maps exchange order IDs to sub-account ownership

export async function setOrderMapping(exchangeOrderId, data) {
    if (!redis) return;
    // data = { subAccountId, clientOrderId, symbol, side, userId }
    await redis.set(`pms:order:${exchangeOrderId}`, JSON.stringify(data), 'EX', 86400);
}

export async function getOrderMapping(exchangeOrderId) {
    if (!redis) return null;
    const raw = await redis.get(`pms:order:${exchangeOrderId}`);
    return raw ? JSON.parse(raw) : null;
}

// ── Sub-Account Rate Limiting ────────────────────

export async function checkRateLimit(subAccountId, maxPerMinute = 30) {
    if (!redis) return true; // No Redis = no rate limiting
    const key = `pms:rate:${subAccountId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return count <= maxPerMinute;
}

// ── Live Risk Snapshots ────────────────────────────
// Per-account live risk payload (equity, margin ratio, dynamic liq prices, per-position marks/uPnL)

export async function setRiskSnapshot(subAccountId, snapshot, ttlSec = RISK_SNAPSHOT_TTL_SEC) {
    if (!redis || !subAccountId || !snapshot) return false;
    await redis.set(`pms:risk:${subAccountId}`, JSON.stringify(snapshot), 'EX', ttlSec);
    return true;
}

export async function getRiskSnapshot(subAccountId) {
    if (!redis || !subAccountId) return null;
    const raw = await redis.get(`pms:risk:${subAccountId}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function deleteRiskSnapshot(subAccountId) {
    if (!redis || !subAccountId) return false;
    await redis.del(`pms:risk:${subAccountId}`);
    return true;
}

// ── Shared Price Cache ────────────────────────────
// Cross-system price truth layer: both JS and Python write here.
// If one side's WS dies, the other's fresh prices are available.

const PRICE_CACHE_TTL_SEC = 30; // Prices auto-expire after 30s of no updates

export async function setPriceCache(symbol, mark, source = 'js') {
    if (!redis || !symbol || !mark) return false;
    try {
        const data = JSON.stringify({ mark, ts: Date.now(), source });
        await redis.set(`pms:price:${symbol}`, data, 'EX', PRICE_CACHE_TTL_SEC);
        return true;
    } catch { return false; }
}

export async function getPriceCache(symbol) {
    if (!redis || !symbol) return null;
    try {
        const raw = await redis.get(`pms:price:${symbol}`);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}

export async function getAllPriceCaches() {
    if (!redis) return new Map();
    try {
        const result = new Map();
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'pms:price:*', 'COUNT', '100');
            cursor = nextCursor;
            if (keys.length > 0) {
                const values = await redis.mget(keys);
                for (let i = 0; i < keys.length; i++) {
                    const symbol = keys[i].replace('pms:price:', '');
                    try { result.set(symbol, JSON.parse(values[i])); } catch { }
                }
            }
        } while (cursor !== '0');
        return result;
    } catch { return new Map(); }
}

// ── Reconciliation Locks ──────────────────────────
// Prevents concurrent reconciliation of the same symbol from proxy-stream + position-sync.

export async function acquireReconcileLock(key, ttlMs = 5000) {
    if (!redis) return true; // No Redis = no locking (single instance is fine)
    try {
        const result = await redis.set(`lock:reconcile:${key}`, '1', 'PX', ttlMs, 'NX');
        return result === 'OK';
    } catch (err) {
        // Fail-CLOSED: skip reconciliation if Redis errors to prevent double-close
        console.warn(`[Redis] Lock acquire failed for ${key}: ${err.message} — failing CLOSED`);
        return false;
    }
}

export async function releaseReconcileLock(key) {
    if (!redis) return;
    try {
        await redis.del(`lock:reconcile:${key}`);
    } catch { /* best-effort */ }
}

// ── Cleanup ──────────────────────────────────────

export async function closeRedis() {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_GLOBAL_MAX_BYTES = 12 * 1024 * 1024;
const encoder = new TextEncoder();

function estimateSizeBytes(value) {
    try {
        return encoder.encode(JSON.stringify(value)).length;
    } catch {
        return 0;
    }
}

function normalizeKeyPart(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(normalizeKeyPart).join(',');
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function removeEntry(store, key, budgetTracker) {
    const entry = store.get(key);
    if (!entry) return;
    store.delete(key);
    budgetTracker.bytes = Math.max(0, budgetTracker.bytes - entry.sizeBytes);
}

export function buildTcaCacheKey({
    scope = 'tca',
    subAccountId = '',
    strategySessionId = '',
    symbol = '',
    executionScope = '',
    ownershipConfidence = '',
    sections = [],
    from = '',
    to = '',
    bucketMs = '',
    maxPoints = '',
    eventsPage = '',
    eventsPageSize = '',
} = {}) {
    const normalizedSections = Array.from(new Set((sections || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))).sort();
    return [
        scope,
        normalizeKeyPart(subAccountId),
        normalizeKeyPart(strategySessionId),
        normalizeKeyPart(symbol),
        normalizeKeyPart(executionScope),
        normalizeKeyPart(ownershipConfidence),
        normalizeKeyPart(normalizedSections),
        normalizeKeyPart(from),
        normalizeKeyPart(to),
        normalizeKeyPart(bucketMs),
        normalizeKeyPart(maxPoints),
        normalizeKeyPart(eventsPage),
        normalizeKeyPart(eventsPageSize),
    ].join('|');
}

export function createScopedAsyncCache({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = 50,
    maxBytes = 2 * 1024 * 1024,
    globalBudget = null,
} = {}) {
    const store = new Map();
    const inflight = new Map();
    const budgetTracker = {
        bytes: 0,
        maxBytes,
    };
    const sharedBudget = globalBudget || { bytes: 0, maxBytes: DEFAULT_GLOBAL_MAX_BYTES };

    function evictExpired() {
        const now = Date.now();
        for (const [key, entry] of store.entries()) {
            if (entry.expiresAt <= now) {
                removeEntry(store, key, budgetTracker);
            }
        }
    }

    function evictToFit(sizeBytes) {
        evictExpired();
        if (sizeBytes > maxBytes || sizeBytes > sharedBudget.maxBytes) return false;
        while (
            store.size > 0
            && (
                store.size >= maxEntries
                || budgetTracker.bytes + sizeBytes > maxBytes
                || sharedBudget.bytes + sizeBytes > sharedBudget.maxBytes
            )
        ) {
            const oldestKey = store.keys().next().value;
            removeEntry(store, oldestKey, budgetTracker);
        }
        return budgetTracker.bytes + sizeBytes <= maxBytes && sharedBudget.bytes + sizeBytes <= sharedBudget.maxBytes;
    }

    function get(key) {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            removeEntry(store, key, budgetTracker);
            return undefined;
        }
        return entry.value;
    }

    function set(key, value) {
        const sizeBytes = estimateSizeBytes(value);
        if (!sizeBytes) return value;

        if (store.has(key)) {
            removeEntry(store, key, budgetTracker);
        }
        if (!evictToFit(sizeBytes)) {
            return value;
        }

        const entry = {
            value,
            sizeBytes,
            expiresAt: Date.now() + ttlMs,
        };
        store.set(key, entry);
        budgetTracker.bytes += sizeBytes;
        sharedBudget.bytes += sizeBytes;
        return value;
    }

    async function getOrCreate(key, loader) {
        const cached = get(key);
        if (cached !== undefined) return cached;
        if (inflight.has(key)) return inflight.get(key);

        const promise = (async () => {
            const value = await loader();
            set(key, value);
            return value;
        })().finally(() => {
            inflight.delete(key);
        });

        inflight.set(key, promise);
        return promise;
    }

    function invalidate(key) {
        removeEntry(store, key, budgetTracker);
        inflight.delete(key);
    }

    function clear() {
        for (const key of store.keys()) {
            removeEntry(store, key, budgetTracker);
        }
        inflight.clear();
    }

    return {
        get,
        set,
        getOrCreate,
        invalidate,
        clear,
        get size() {
            evictExpired();
            return store.size;
        },
        get bytes() {
            evictExpired();
            return budgetTracker.bytes;
        },
        get inflightSize() {
            return inflight.size;
        },
    };
}

const globalTcaCacheBudget = {
    bytes: 0,
    maxBytes: DEFAULT_GLOBAL_MAX_BYTES,
};

export const modalCache = createScopedAsyncCache({
    ttlMs: 10_000,
    maxEntries: 32,
    maxBytes: 8 * 1024 * 1024,
    globalBudget: globalTcaCacheBudget,
});

export const embedCache = createScopedAsyncCache({
    ttlMs: 30_000,
    maxEntries: 16,
    maxBytes: 2 * 1024 * 1024,
    globalBudget: globalTcaCacheBudget,
});

export const __tcaCacheTestHooks = {
    estimateSizeBytes,
    globalTcaCacheBudget,
};

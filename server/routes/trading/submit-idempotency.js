import { getRedis, isRedisHealthy } from '../../redis.js';

const memoryStore = new Map();
const DEFAULT_TTL_MS = Number.parseInt(process.env.IDEMPOTENCY_TTL_MS || '600000', 10);

function nowMs() {
    return Date.now();
}

function extractKey(req) {
    const key = req.get('x-idempotency-key') || req.get('idempotency-key') || '';
    return String(key).trim();
}

function makeScopeKey(req, scope, key) {
    const userId = req.user?.id || 'anon';
    return `pms:idempotency:${scope}:${userId}:${key}`;
}

function pruneMemoryStore() {
    const now = nowMs();
    for (const [k, v] of memoryStore.entries()) {
        if (!v || v.expiresAt <= now) {
            memoryStore.delete(k);
        }
    }
}

function parseJson(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function beginIdempotentRequest(req, scope, { ttlMs = DEFAULT_TTL_MS } = {}) {
    const key = extractKey(req);
    if (!key) return null;

    const scopeKey = makeScopeKey(req, scope, key);
    const pendingPayload = {
        state: 'pending',
        createdAt: nowMs(),
        expiresAt: nowMs() + ttlMs,
    };

    if (isRedisHealthy() && getRedis()) {
        const redis = getRedis();
        const ok = await redis.set(scopeKey, JSON.stringify(pendingPayload), 'PX', String(ttlMs), 'NX');
        if (ok === 'OK') {
            return { key: scopeKey, rawKey: key, ttlMs };
        }
        const existingRaw = await redis.get(scopeKey);
        const existing = parseJson(existingRaw);
        if (existing?.state === 'done' && existing.response) {
            return { replay: existing.response, rawKey: key };
        }
        return { conflict: true, rawKey: key };
    }

    pruneMemoryStore();
    const existing = memoryStore.get(scopeKey);
    if (!existing) {
        memoryStore.set(scopeKey, pendingPayload);
        return { key: scopeKey, rawKey: key, ttlMs };
    }
    if (existing.state === 'done' && existing.response) {
        return { replay: existing.response, rawKey: key };
    }
    return { conflict: true, rawKey: key };
}

export async function completeIdempotentRequest(lock, response) {
    if (!lock?.key) return;
    const payload = {
        state: 'done',
        createdAt: nowMs(),
        expiresAt: nowMs() + (lock.ttlMs || DEFAULT_TTL_MS),
        response,
    };
    if (isRedisHealthy() && getRedis()) {
        const redis = getRedis();
        await redis.set(lock.key, JSON.stringify(payload), 'PX', String(lock.ttlMs || DEFAULT_TTL_MS));
        return;
    }
    memoryStore.set(lock.key, payload);
}

export async function releaseIdempotentRequest(lock) {
    if (!lock?.key) return;
    if (isRedisHealthy() && getRedis()) {
        const redis = getRedis();
        await redis.del(lock.key);
        return;
    }
    memoryStore.delete(lock.key);
}

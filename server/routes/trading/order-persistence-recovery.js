import { randomUUID } from 'crypto';
import prisma from '../../db/prisma.js';
import {
    getRedis,
    isRedisHealthy,
    streamAck,
    streamAdd,
    streamEnsureGroup,
    streamReadGroup,
} from '../../redis.js';

const PERSIST_STREAM = process.env.PENDING_ORDER_PERSIST_STREAM || 'pms:orders:persist:retry';
const PERSIST_GROUP = process.env.PENDING_ORDER_PERSIST_GROUP || 'pms-orders-persist';
const LOOP_MS = Number.parseInt(process.env.PENDING_ORDER_PERSIST_LOOP_MS || '1500', 10);
const BATCH_SIZE = Number.parseInt(process.env.PENDING_ORDER_PERSIST_BATCH || '25', 10);

const inMemoryQueue = [];
let workerTimer = null;
let running = false;
let redisGroupReady = false;
const consumerId = `persist-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const stats = {
    queuedTotal: 0,
    recoveredTotal: 0,
    alreadyExistsTotal: 0,
    retryFailTotal: 0,
    invalidDroppedTotal: 0,
    lastError: null,
    lastRecoveredAt: 0,
};

function safeJsonParse(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function persistTask(task) {
    const data = task?.orderData;
    if (!data || typeof data !== 'object') return { ok: false, reason: 'missing orderData' };
    const exchangeOrderId = data.exchangeOrderId || null;

    if (exchangeOrderId) {
        const existing = await prisma.pendingOrder.findFirst({
            where: { exchangeOrderId },
            select: { id: true },
        });
        if (existing) {
            return { ok: true, recovered: false, reason: 'already_exists', orderId: existing.id };
        }
    }

    const order = await prisma.pendingOrder.create({ data });
    return { ok: true, recovered: true, orderId: order.id };
}

async function drainInMemoryQueue() {
    let processed = 0;
    while (inMemoryQueue.length > 0 && processed < BATCH_SIZE) {
        const task = inMemoryQueue.shift();
        try {
            const result = await persistTask(task);
            if (!result.ok) {
                stats.invalidDroppedTotal += 1;
                console.warn(`[PersistRecovery] Invalid task dropped (${result.reason || 'unknown'})`);
            } else if (result.recovered) {
                stats.recoveredTotal += 1;
                stats.lastRecoveredAt = Date.now();
            } else if (result.reason === 'already_exists') {
                stats.alreadyExistsTotal += 1;
            }
        } catch (err) {
            stats.retryFailTotal += 1;
            stats.lastError = err?.message || String(err);
            inMemoryQueue.push(task);
            console.warn(`[PersistRecovery] In-memory task retry scheduled: ${err.message}`);
            break;
        }
        processed += 1;
    }
}

async function drainRedisStream() {
    if (!isRedisHealthy()) return;
    const redis = getRedis();
    if (!redis) return;

    if (!redisGroupReady) {
        await streamEnsureGroup(PERSIST_STREAM, PERSIST_GROUP, '0');
        redisGroupReady = true;
    }

    const rows = await streamReadGroup(PERSIST_STREAM, PERSIST_GROUP, consumerId, {
        count: BATCH_SIZE,
        blockMs: 1,
    });
    if (!rows.length) return;

    for (const row of rows) {
        const id = row.id;
        const fields = row.fields || {};
        const task = safeJsonParse(fields.payload || '{}');
        try {
            const result = await persistTask(task);
            if (!result.ok) {
                stats.invalidDroppedTotal += 1;
                console.warn(`[PersistRecovery] Invalid stream task dropped (${result.reason || 'unknown'})`);
            } else if (result.recovered) {
                stats.recoveredTotal += 1;
                stats.lastRecoveredAt = Date.now();
            } else if (result.reason === 'already_exists') {
                stats.alreadyExistsTotal += 1;
            }
            await streamAck(PERSIST_STREAM, PERSIST_GROUP, id);
        } catch (err) {
            stats.retryFailTotal += 1;
            stats.lastError = err?.message || String(err);
            console.warn(`[PersistRecovery] Stream task retry kept pending: ${err.message}`);
        }
    }
}

async function loopOnce() {
    await drainInMemoryQueue();
    await drainRedisStream();
}

export function startPendingOrderPersistenceRecovery() {
    if (running) return;
    running = true;
    workerTimer = setInterval(() => {
        loopOnce().catch((err) => {
            console.warn(`[PersistRecovery] Loop error: ${err.message}`);
        });
    }, Math.max(500, LOOP_MS));
    if (typeof workerTimer?.unref === 'function') workerTimer.unref();
}

export function stopPendingOrderPersistenceRecovery() {
    running = false;
    redisGroupReady = false;
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }
}

export async function enqueuePendingOrderPersistence(task) {
    const enriched = {
        id: randomUUID(),
        queuedAt: Date.now(),
        ...task,
    };
    if (isRedisHealthy() && getRedis()) {
        await streamAdd(PERSIST_STREAM, {
            payload: JSON.stringify(enriched),
            ts: String(Date.now()),
        });
        stats.queuedTotal += 1;
        return { queued: 'redis_stream' };
    }
    inMemoryQueue.push(enriched);
    stats.queuedTotal += 1;
    return { queued: 'memory' };
}

export async function persistPendingOrderWithRecovery(data, contextLabel, meta = {}) {
    try {
        const order = await prisma.pendingOrder.create({ data });
        return { order, persistencePending: false, persistenceError: null };
    } catch (err) {
        const message = err?.message || String(err);
        console.error(`[${contextLabel}] Persist pending order failed after C++ ACK: ${message}`);
        try {
            const queued = await enqueuePendingOrderPersistence({
                contextLabel,
                orderData: data,
                meta,
            });
            return {
                order: null,
                persistencePending: true,
                persistenceError: message,
                recoveryQueue: queued.queued,
            };
        } catch (queueErr) {
            return {
                order: null,
                persistencePending: true,
                persistenceError: `${message}; recovery queue failed: ${queueErr?.message || queueErr}`,
                recoveryQueue: 'failed',
            };
        }
    }
}

export async function getPendingOrderPersistenceRecoveryStats() {
    let redisStreamLen = null;
    if (isRedisHealthy() && getRedis()) {
        try {
            redisStreamLen = await getRedis().xlen(PERSIST_STREAM);
        } catch (err) {
            stats.lastError = err?.message || String(err);
        }
    }

    let oldestPendingMs = 0;
    if (inMemoryQueue.length > 0) {
        const oldest = inMemoryQueue[0]?.queuedAt || Date.now();
        oldestPendingMs = Math.max(0, Date.now() - oldest);
    }

    return {
        running,
        queueBackend: (isRedisHealthy() && getRedis()) ? 'redis_stream' : 'memory',
        inMemoryQueueDepth: inMemoryQueue.length,
        redisStreamLen,
        oldestPendingMs,
        queuedTotal: stats.queuedTotal,
        recoveredTotal: stats.recoveredTotal,
        alreadyExistsTotal: stats.alreadyExistsTotal,
        retryFailTotal: stats.retryFailTotal,
        invalidDroppedTotal: stats.invalidDroppedTotal,
        lastError: stats.lastError,
        lastRecoveredAt: stats.lastRecoveredAt || null,
    };
}

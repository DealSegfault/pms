/**
 * redis-proxy.js — Helpers for proxying trade commands to Python via Redis.
 *
 * Pattern:
 *   JS Express → LPUSH pms:cmd:{queue} → Python BLPOP → process → SET pms:result:{requestId}
 *   JS polls GET pms:result:{requestId} → returns to client
 *
 * Used by thin trading routes after Python engine migration.
 */
import { v4 as uuidv4 } from 'uuid';

let redis = null;

export function setRedisClient(client) {
    redis = client;
}

/**
 * Wait for Python to write a result to pms:result:{requestId}.
 * Polls every 50ms up to timeoutMs.
 *
 * @param {string} requestId
 * @param {number} timeoutMs
 * @returns {Promise<Object|null>}
 */
export async function waitForResult(requestId, timeoutMs = 5000) {
    if (!redis) return null;
    const deadline = Date.now() + timeoutMs;
    const key = `pms:result:${requestId}`;

    while (Date.now() < deadline) {
        const result = await redis.get(key);
        if (result) {
            await redis.del(key);
            try { return JSON.parse(result); } catch { return null; }
        }
        await new Promise(r => setTimeout(r, 50));
    }
    return null;  // Timeout
}

/**
 * Push a command to a Redis queue and wait for result.
 *
 * @param {string} queue - Redis queue name (e.g., 'pms:cmd:trade')
 * @param {Object} payload - Command payload (requestId auto-added)
 * @param {number} timeoutMs - Max wait time
 * @returns {Promise<Object>}
 */
export async function pushAndWait(queue, payload, timeoutMs = 5000) {
    if (!redis) throw new Error('Redis not available');

    const requestId = uuidv4();
    const command = { requestId, ...payload };

    await redis.lpush(queue, JSON.stringify(command));
    const result = await waitForResult(requestId, timeoutMs);

    if (!result) {
        return { success: false, error: 'Execution timeout — Python engine may be unavailable' };
    }
    return result;
}

/**
 * Express middleware factory: proxy a route to a Redis command queue.
 * Extracts fields from request body, pushes to queue, waits for result.
 *
 * Usage:
 *   router.post('/chase-limit', requireOwnership('body'), proxyToRedis('pms:cmd:chase'));
 *
 * @param {string} queue - Redis queue name
 * @param {Function} [extractFields] - Optional function(req) to extract/transform fields
 * @returns {Function} Express middleware
 */
export function proxyToRedis(queue, extractFields = null) {
    return async (req, res) => {
        try {
            const startedAt = Date.now();
            const payload = extractFields ? extractFields(req) : {
                ...req.body,
                ...(req.params.id ? { id: req.params.id } : {}),
                ...(req.params.subAccountId ? { subAccountId: req.params.subAccountId } : {}),
            };

            const result = await pushAndWait(queue, payload);
            const serverLatencyMs = Date.now() - startedAt;
            res.set('X-Server-Latency-Ms', String(serverLatencyMs));

            if (!result.success) {
                return res.status(400).json(result);
            }
            res.status(201).json({ ...result, serverLatencyMs });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    };
}

/**
 * Subscribe to all PMS event channels from Python and forward via broadcast function.
 * Call this once at startup after Redis is connected.
 *
 * @param {Function} broadcastFn - Function(type, data) to send to clients
 */
export async function subscribeToPmsEvents(broadcastFn) {
    if (!redis) {
        console.warn('[RedisProxy] Redis not available — PMS events will not be forwarded');
        return;
    }

    // Create a separate subscriber connection (ioredis requires this for pub/sub)
    try {
        const sub = redis.duplicate();

        sub.on('error', (err) => {
            console.error('[RedisProxy] Subscriber error:', err.message);
        });

        // ioredis with lazyConnect needs explicit connect
        if (sub.status === 'wait') {
            await sub.connect();
            console.log('[RedisProxy] Subscriber connection established (status:', sub.status, ')');
        }

        await sub.psubscribe('pms:events:*');

        sub.on('pmessage', (pattern, channel, message) => {
            try {
                const data = JSON.parse(message);
                const type = channel.replace('pms:events:', '');
                console.log(`[RedisProxy] ◀ ${type} (subAccountId: ${data.subAccountId || 'none'})`);
                broadcastFn(type, data);
            } catch (err) {
                console.error('[RedisProxy] Failed to parse PMS event:', err.message);
            }
        });

        console.log('[RedisProxy] ✓ Subscribed to pms:events:* — forwarding to WebSocket clients');
    } catch (err) {
        console.error('[RedisProxy] Failed to set up PUB/SUB subscriber:', err.message, err.stack);
    }
}

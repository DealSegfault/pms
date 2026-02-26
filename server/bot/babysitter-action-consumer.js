/**
 * Babysitter Action Consumer
 *
 * Consumes close-position intents from Redis stream and executes them via risk engine.
 * This is the resilient action path replacing direct HTTP callbacks from a child process.
 */

import {
    BBS_ACTION_GROUP,
    BBS_ACTION_STREAM,
    getRedis,
    publishBabysitterAction,
    streamAutoClaim,
    streamAck,
    streamEnsureGroup,
    streamReadGroup,
} from '../redis.js';
import riskEngine from '../risk/index.js';
import { closePositionViaCpp } from '../routes/trading/close-utils.js';

const CONSUMER_NAME = `pms-node-${process.pid}`;
const CLAIM_IDLE_MS = parseInt(process.env.BBS_ACTION_CLAIM_IDLE_MS || '30000', 10);

class BabysitterActionConsumer {
    constructor() {
        this._running = false;
        this._task = null;
        this._claimCursor = '0-0';
        this._autoClaimEnabled = true;
    }

    async start() {
        if (this._running) return;

        const redis = getRedis();
        if (!redis) {
            console.warn('[BabysitterActions] Redis unavailable — consumer disabled');
            return;
        }

        this._running = true;
        this._claimCursor = '0-0';
        this._autoClaimEnabled = true;
        try {
            await streamEnsureGroup(BBS_ACTION_STREAM, BBS_ACTION_GROUP, '0');
        } catch (err) {
            this._running = false;
            console.warn('[BabysitterActions] Failed to create stream group:', err.message);
            return;
        }

        this._task = this._runLoop();
    }

    async stop() {
        this._running = false;
        if (this._task) {
            try { await this._task; } catch (_) { }
            this._task = null;
        }
    }

    async _runLoop() {
        while (this._running) {
            try {
                let entries = [];

                if (this._autoClaimEnabled) {
                    try {
                        const claimed = await streamAutoClaim(
                            BBS_ACTION_STREAM,
                            BBS_ACTION_GROUP,
                            CONSUMER_NAME,
                            CLAIM_IDLE_MS,
                            this._claimCursor,
                            { count: 20 },
                        );
                        this._claimCursor = claimed.nextId || this._claimCursor;
                        entries = claimed.entries || [];
                    } catch (err) {
                        if (String(err?.message || '').includes('unknown command')) {
                            this._autoClaimEnabled = false;
                            console.warn('[BabysitterActions] XAUTOCLAIM unsupported by Redis, pending recovery disabled');
                        } else {
                            throw err;
                        }
                    }
                }

                if (!entries.length) {
                    entries = await streamReadGroup(
                        BBS_ACTION_STREAM,
                        BBS_ACTION_GROUP,
                        CONSUMER_NAME,
                        { count: 20, blockMs: 5000 },
                    );
                }
                if (!entries.length) continue;

                for (const entry of entries) {
                    const shouldAck = await this._handleEntry(entry);
                    if (shouldAck) {
                        await streamAck(BBS_ACTION_STREAM, BBS_ACTION_GROUP, entry.id);
                    }
                }
            } catch (err) {
                if (this._running) {
                    console.warn('[BabysitterActions] Stream read failed:', err.message);
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
    }

    async _handleEntry(entry) {
        const action = String(entry.fields?.action || '').trim();
        const rawPayload = entry.fields?.payload || '{}';

        let payload = {};
        try { payload = JSON.parse(rawPayload); } catch { }
        const retry = Number(payload.retry || 0);

        if (action !== 'close_position') {
            return true;
        }

        const positionId = String(payload.positionId || '').trim();
        const closePrice = Number(payload.closePrice || 0);
        const reason = String(payload.reason || 'BABYSITTER_TP');

        if (!positionId || !closePrice || Number.isNaN(closePrice)) {
            return true;
        }

        try {
            const result = await closePositionViaCpp(positionId, reason);
            if (result?.success) {
                return true;
            }

            const errMsg = String(result?.error || '');
            if (errMsg.includes('already closed') || errMsg.includes('not found')) {
                // Idempotent terminal states.
                return true;
            }

            if (retry < 3) {
                const nextId = await publishBabysitterAction('close_position', {
                    ...payload,
                    retry: retry + 1,
                    retriedAt: Date.now(),
                });
                if (!nextId) {
                    // Leave message pending; it can be recovered by auto-claim loop.
                    return false;
                }
            } else {
                console.warn(`[BabysitterActions] dropping ${positionId} after ${retry} retries: ${errMsg || 'unknown error'}`);
            }
            return true;
        } catch (err) {
            console.warn(`[BabysitterActions] close failed for ${positionId}:`, err.message);
            if (retry < 3) {
                const nextId = await publishBabysitterAction('close_position', {
                    ...payload,
                    retry: retry + 1,
                    retriedAt: Date.now(),
                });
                if (!nextId) {
                    return false;
                }
            }
            return true;
        }
    }
}

const babysitterActionConsumer = new BabysitterActionConsumer();
export default babysitterActionConsumer;

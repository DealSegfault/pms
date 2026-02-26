/**
 * Trail Stop Engine — trailing stop market orders with Redis crash resilience.
 *
 * Tracks price extremes (HWM for longs, LWM for shorts) via WS price stream.
 * When price retraces by the configured callback %, triggers a market close.
 * State is persisted to Redis on every update so trail stops survive restarts.
 */
import { Router } from 'express';
import riskEngine, { prisma } from '../../risk/index.js';
import exchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership } from '../../ownership.js';
import { getRedis } from '../../redis.js';

const router = Router();

// ── Redis persistence helpers ─────────────────────

const TS_REDIS_PREFIX = 'pms:trailstop:';
const TS_TTL_SEC = 86400; // 24 hours max

async function saveToRedis(ts) {
    try {
        const r = getRedis();
        if (!r) return;
        const { _unsubPrice, ...data } = ts;
        await r.set(TS_REDIS_PREFIX + ts.id, JSON.stringify(data), 'EX', TS_TTL_SEC);
    } catch (err) {
        console.warn('[TrailStop-Redis] Save failed:', err.message);
    }
}

async function deleteFromRedis(id) {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(TS_REDIS_PREFIX + id);
    } catch { /* ignore */ }
}

// ── Trail Stop Engine ─────────────────────────────

const activeTrailStops = new Map(); // id → TrailStopState
const MAX_ACTIVE_TRAIL_STOPS = 500;

function generateId() {
    return `ts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute trigger price from extreme and callback percentage.
 * LONG: trigger = extreme * (1 - callbackPct / 100)   — sell when price drops
 * SHORT: trigger = extreme * (1 + callbackPct / 100)   — buy when price rises
 */
function computeTriggerPrice(side, extremePrice, callbackPct) {
    if (side === 'LONG') {
        return extremePrice * (1 - callbackPct / 100);
    }
    return extremePrice * (1 + callbackPct / 100);
}

/**
 * Check if price has crossed the trigger.
 * LONG:  triggered when price <= trigger  (price dropped from HWM)
 * SHORT: triggered when price >= trigger  (price rose from LWM)
 */
function isTriggered(side, price, triggerPrice) {
    if (side === 'LONG') return price <= triggerPrice;
    return price >= triggerPrice;
}

/**
 * Check if activation price is reached.
 * LONG:  activate when price >= activationPrice  (price rose to target)
 * SHORT: activate when price <= activationPrice  (price fell to target)
 */
function isActivated(side, price, activationPrice) {
    if (!activationPrice) return true; // no activation price = always active
    if (side === 'LONG') return price >= activationPrice;
    return price <= activationPrice;
}

let _lastRedisSaveTs = 0;
const REDIS_SAVE_THROTTLE_MS = 1000; // save to Redis at most once per second per trail stop

function handlePriceTick(ts, price) {
    if (!activeTrailStops.has(ts.id)) return;
    if (ts.status !== 'active') return;
    if (!price || !Number.isFinite(price) || price <= 0) return;

    // Check activation
    if (!ts.activated) {
        if (!isActivated(ts.side, price, ts.activationPrice)) {
            return; // not yet activated
        }
        ts.activated = true;
        ts.extremePrice = price;
        ts.triggerPrice = computeTriggerPrice(ts.side, ts.extremePrice, ts.callbackPct);
        console.log(`[TrailStop ${ts.id}] Activated at $${price.toFixed(2)} — tracking ${ts.side === 'LONG' ? 'HWM' : 'LWM'}`);
    }

    // Update extreme price
    let extremeUpdated = false;
    if (ts.side === 'LONG' && price > ts.extremePrice) {
        ts.extremePrice = price;
        extremeUpdated = true;
    } else if (ts.side === 'SHORT' && price < ts.extremePrice) {
        ts.extremePrice = price;
        extremeUpdated = true;
    }

    if (extremeUpdated) {
        ts.triggerPrice = computeTriggerPrice(ts.side, ts.extremePrice, ts.callbackPct);
    }

    // Check trigger
    if (isTriggered(ts.side, price, ts.triggerPrice)) {
        console.log(`[TrailStop ${ts.id}] TRIGGERED — ${ts.symbol} ${ts.side} @ $${price.toFixed(2)} (extreme: $${ts.extremePrice.toFixed(2)}, trigger: $${ts.triggerPrice.toFixed(2)}, callback: ${ts.callbackPct}%)`);
        executeTrailStopClose(ts, price);
        return;
    }

    // Throttled Redis save + WS broadcast
    const now = Date.now();
    if (now - (ts._lastSaveTs || 0) > REDIS_SAVE_THROTTLE_MS) {
        ts._lastSaveTs = now;
        saveToRedis(ts);
        broadcast('trail_stop_progress', {
            trailStopId: ts.id,
            subAccountId: ts.subAccountId,
            positionId: ts.positionId,
            symbol: ts.symbol,
            side: ts.side,
            callbackPct: ts.callbackPct,
            extremePrice: ts.extremePrice,
            triggerPrice: ts.triggerPrice,
            currentPrice: price,
            activated: ts.activated,
            activationPrice: ts.activationPrice,
        });
    }
}

async function executeTrailStopClose(ts, price) {
    ts.status = 'triggered';
    ts.triggeredAt = Date.now();
    ts.triggeredPrice = price;

    // Unsubscribe from price updates
    if (ts._unsubPrice) {
        ts._unsubPrice();
        ts._unsubPrice = null;
    }

    try {
        // Close the position via risk engine
        const result = await riskEngine.closePosition(ts.positionId, 'TRAIL_STOP');
        ts.closeSuccess = result.success;

        if (result.success) {
            console.log(`[TrailStop ${ts.id}] Position ${ts.positionId} closed successfully`);
        } else {
            console.warn(`[TrailStop ${ts.id}] Close failed:`, result.error || result.errors);
        }
    } catch (err) {
        ts.closeSuccess = false;
        console.error(`[TrailStop ${ts.id}] Close exception:`, err.message);
    }

    // Cleanup
    activeTrailStops.delete(ts.id);
    deleteFromRedis(ts.id);

    broadcast('trail_stop_triggered', {
        trailStopId: ts.id,
        subAccountId: ts.subAccountId,
        positionId: ts.positionId,
        symbol: ts.symbol,
        side: ts.side,
        extremePrice: ts.extremePrice,
        triggerPrice: ts.triggerPrice,
        triggeredPrice: price,
        closeSuccess: ts.closeSuccess,
    });
}

function finishTrailStop(ts, reason) {
    ts.status = reason; // 'cancelled'
    if (ts._unsubPrice) {
        ts._unsubPrice();
        ts._unsubPrice = null;
    }
    activeTrailStops.delete(ts.id);
    deleteFromRedis(ts.id);
    console.log(`[TrailStop ${ts.id}] ${reason}: ${ts.symbol} ${ts.side}`);
    broadcast(`trail_stop_${reason}`, {
        trailStopId: ts.id,
        subAccountId: ts.subAccountId,
        positionId: ts.positionId,
        symbol: ts.symbol,
        side: ts.side,
    });
}

/**
 * Subscribe to price updates for a trail stop.
 * Returns an unsubscribe function.
 */
function subscribeToPriceUpdates(ts) {
    exchange.subscribeToPrices([ts.symbol]);
    const handler = ({ symbol, mark }) => {
        if (symbol === ts.symbol) {
            handlePriceTick(ts, mark);
        }
    };
    exchange.on('price', handler);
    return () => exchange.off('price', handler);
}

// ── Routes ────────────────────────────────────────

// POST /api/trade/trail-stop — Start a trail stop for a position
router.post('/trail-stop', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, positionId, callbackPct, activationPrice } = req.body;
        if (!subAccountId || !positionId || !callbackPct) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, positionId, callbackPct' });
        }

        const parsedCallback = parseFloat(callbackPct);
        if (!Number.isFinite(parsedCallback) || parsedCallback <= 0 || parsedCallback > 50) {
            return res.status(400).json({ error: 'callbackPct must be between 0.01 and 50' });
        }

        const parsedActivation = activationPrice ? parseFloat(activationPrice) : null;
        if (parsedActivation !== null && (!Number.isFinite(parsedActivation) || parsedActivation <= 0)) {
            return res.status(400).json({ error: 'activationPrice must be a positive number or omitted' });
        }

        // Find the position
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
            select: { id: true, subAccountId: true, symbol: true, side: true, status: true, entryPrice: true },
        });

        if (!position || position.status !== 'OPEN') {
            return res.status(404).json({ error: 'Position not found or not open' });
        }
        if (position.subAccountId !== subAccountId) {
            return res.status(403).json({ error: 'Position does not belong to this sub-account' });
        }

        // Check for duplicate trail stop on same position
        for (const [, existing] of activeTrailStops) {
            if (existing.positionId === positionId) {
                return res.status(409).json({ error: `Trail stop already active for this position (${existing.id})` });
            }
        }

        // Get current price to initialize extreme
        let currentPrice = exchange.getLatestPrice(position.symbol);
        if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
            try {
                const ticker = await exchange.fetchTicker(position.symbol);
                currentPrice = Number(ticker?.mark || ticker?.last || ticker?.price);
            } catch { /* ignore */ }
        }
        if (!currentPrice || currentPrice <= 0) {
            return res.status(500).json({ error: 'Cannot get current price for this symbol' });
        }

        const id = generateId();
        const activated = isActivated(position.side, currentPrice, parsedActivation);

        const ts = {
            id,
            subAccountId,
            positionId,
            symbol: position.symbol,
            side: position.side,
            callbackPct: parsedCallback,
            activationPrice: parsedActivation,
            activated,
            extremePrice: activated ? currentPrice : null,
            triggerPrice: activated ? computeTriggerPrice(position.side, currentPrice, parsedCallback) : null,
            startedAt: Date.now(),
            status: 'active',
            _unsubPrice: null,
            _lastSaveTs: 0,
        };

        if (activeTrailStops.size >= MAX_ACTIVE_TRAIL_STOPS) {
            return res.status(429).json({ error: `Maximum concurrent trail stops (${MAX_ACTIVE_TRAIL_STOPS}) reached` });
        }

        activeTrailStops.set(id, ts);
        ts._unsubPrice = subscribeToPriceUpdates(ts);
        saveToRedis(ts);

        console.log(`[TrailStop ${id}] Started: ${position.symbol} ${position.side}, callback ${parsedCallback}%, ${activated ? `tracking from $${currentPrice.toFixed(2)}` : `waiting for activation at $${parsedActivation}`}`);

        res.status(201).json({
            success: true,
            trailStopId: id,
            symbol: position.symbol,
            side: position.side,
            callbackPct: parsedCallback,
            activationPrice: parsedActivation,
            activated,
            extremePrice: ts.extremePrice,
            triggerPrice: ts.triggerPrice,
            currentPrice,
        });
    } catch (err) {
        console.error('[TrailStop] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/trail-stop/active/:subAccountId
router.get('/trail-stop/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const results = [];
        for (const [, ts] of activeTrailStops) {
            if (ts.subAccountId === req.params.subAccountId) {
                results.push({
                    trailStopId: ts.id,
                    positionId: ts.positionId,
                    symbol: ts.symbol,
                    side: ts.side,
                    callbackPct: ts.callbackPct,
                    activationPrice: ts.activationPrice,
                    activated: ts.activated,
                    extremePrice: ts.extremePrice,
                    triggerPrice: ts.triggerPrice,
                    startedAt: new Date(ts.startedAt).toISOString(),
                    status: ts.status,
                });
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/trail-stop/:trailStopId
router.delete('/trail-stop/:trailStopId', async (req, res) => {
    try {
        const ts = activeTrailStops.get(req.params.trailStopId);
        if (!ts) return res.status(404).json({ error: 'Trail stop not found or already completed' });

        // Ownership check
        if (req.user?.role !== 'ADMIN') {
            const account = await prisma.subAccount.findUnique({
                where: { id: ts.subAccountId },
                select: { userId: true },
            });
            if (account?.userId !== req.user?.id) {
                return res.status(403).json({ error: 'You do not own this trail stop' });
            }
        }

        finishTrailStop(ts, 'cancelled');
        console.log(`[TrailStop ${ts.id}] Cancelled by user`);

        res.json({
            success: true,
            trailStopId: ts.id,
            symbol: ts.symbol,
            side: ts.side,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Resume active trail stops from Redis on server restart ──

export async function resumeActiveTrailStops() {
    const r = getRedis();
    if (!r) return;

    let resumed = 0;

    try {
        const keys = await r.keys(TS_REDIS_PREFIX + '*');
        for (const key of keys) {
            try {
                const raw = await r.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);

                if (activeTrailStops.has(data.id)) continue; // already running

                // Check if position is still open
                try {
                    const pos = await prisma.virtualPosition.findUnique({
                        where: { id: data.positionId },
                        select: { status: true },
                    });
                    if (!pos || pos.status !== 'OPEN') {
                        console.log(`[TrailStop-Resume] ${data.id} — position ${data.positionId} no longer open, cleaning up`);
                        await r.del(key);
                        continue;
                    }
                } catch (err) {
                    console.warn(`[TrailStop-Resume] ${data.id} — failed to check position:`, err.message);
                    // Continue anyway, the close will fail gracefully later if position is gone
                }

                // Restore state
                data._unsubPrice = null;
                data._lastSaveTs = 0;

                activeTrailStops.set(data.id, data);

                // Re-subscribe to price stream
                exchange.subscribeToPrices([data.symbol]);
                data._unsubPrice = subscribeToPriceUpdates(data);

                resumed++;
                console.log(`[TrailStop-Resume] Resumed ${data.id}: ${data.symbol} ${data.side}, callback ${data.callbackPct}%, extreme $${data.extremePrice?.toFixed(2) || '—'}, trigger $${data.triggerPrice?.toFixed(2) || '—'}`);
                saveToRedis(data);
            } catch (err) {
                console.warn(`[TrailStop-Resume] Failed to restore ${key}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('[TrailStop-Resume] Scan failed:', err.message);
    }

    if (resumed > 0) {
        console.log(`[TrailStop-Resume] ✓ Resumed ${resumed} active trail stop(s) from Redis`);
    }
}

// ── Auto-cleanup: listen for position_closed events ──
// If a position is closed externally (liquidation, manual close, etc.),
// cancel any active trail stop for that position.

export function initTrailStopCleanup() {
    // This is called once at startup.
    // We check for stale trail stops periodically (every 60s).
    setInterval(async () => {
        for (const [, ts] of activeTrailStops) {
            try {
                const pos = await prisma.virtualPosition.findUnique({
                    where: { id: ts.positionId },
                    select: { status: true },
                });
                if (!pos || pos.status !== 'OPEN') {
                    console.log(`[TrailStop] Position ${ts.positionId} no longer open — auto-cancelling ${ts.id}`);
                    finishTrailStop(ts, 'cancelled');
                }
            } catch { /* ignore */ }
        }
    }, 60000);
}

export default router;

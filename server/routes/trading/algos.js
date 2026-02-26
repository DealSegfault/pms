/**
 * Algo Routes — Thin Redis proxies for all algo commands.
 *
 * All algo logic lives in Python. JS just forwards commands via Redis.
 * Each route: LPUSH → pms:cmd:{algo} → Python processes → SET pms:result:{requestId} → JS reads
 */
import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { proxyToRedis, pushAndWait } from '../../redis-proxy.js';

const router = Router();

// ── Chase Limit ──

router.post('/chase-limit', requireOwnership('body'), proxyToRedis('pms:cmd:chase'));

router.delete('/chase-limit/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:chase_cancel', { chaseId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Scalper ──

router.post('/scalper', requireOwnership('body'), proxyToRedis('pms:cmd:scalper'));

router.delete('/scalper/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:scalper_cancel', { scalperId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── TWAP ──

router.post('/twap', requireOwnership('body'), proxyToRedis('pms:cmd:twap'));
router.post('/twap-basket', requireOwnership('body'), proxyToRedis('pms:cmd:twap_basket'));

router.delete('/twap/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:twap_cancel', { twapId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Trail Stop ──

router.post('/trail-stop', requireOwnership('body'), proxyToRedis('pms:cmd:trail_stop'));

router.delete('/trail-stop/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:trail_stop_cancel', { trailStopId: req.params.id });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Active State GET Endpoints (read from Redis hashes) ──

async function getActiveFromRedis(prefix, subAccountId, mapFn = null) {
    const { getRedis } = await import('../../redis.js');
    const redis = getRedis();
    const key = `${prefix}:${subAccountId}`;
    const raw = await redis.hgetall(key);
    const items = Object.values(raw || {}).map(v => {
        try {
            const parsed = JSON.parse(v);
            return mapFn ? mapFn(parsed) : parsed;
        } catch { return null; }
    }).filter(Boolean);
    return items;
}

// Map chase data to frontend expected format
function mapChaseItem(c) {
    return {
        chaseId: c.id,
        subAccountId: c.subAccountId,
        symbol: c.symbol,
        side: c.side,
        quantity: c.quantity,
        sizeUsd: c.sizeUsd || 0,
        stalkMode: c.stalkMode || 'none',
        stalkOffsetPct: c.stalkOffsetPct || 0,
        maxDistancePct: c.maxDistancePct || 0,
        repriceCount: c.repriceCount || 0,
        currentOrderPrice: c.currentOrderPrice || null,
        startedAt: c.startedAt,
        status: c.status,
    };
}

router.get('/chase-limit/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_chase', req.params.subAccountId, mapChaseItem);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/scalper/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_scalper', req.params.subAccountId);
        res.json(items.map(s => ({
            scalperId: s.id, subAccountId: s.subAccountId, symbol: s.symbol,
            numLayers: s.numLayers, quantity: s.quantity, status: s.status,
            totalFillCount: s.totalFillCount || 0,
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/twap/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_twap', req.params.subAccountId);
        res.json(items.map(t => ({
            twapId: t.id, subAccountId: t.subAccountId, symbol: t.symbol, side: t.side,
            totalSize: t.totalQuantity, totalLots: t.numLots, filledLots: t.filledLots || 0,
            filledSize: t.filledQuantity || 0, durationMinutes: Math.round((t.intervalSeconds * t.numLots) / 60),
            status: t.status, estimatedEnd: Date.now() + ((t.numLots - (t.filledLots || 0)) * t.intervalSeconds * 1000),
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/trail-stop/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_trail_stop', req.params.subAccountId);
        res.json(items.map(ts => ({
            trailStopId: ts.id, subAccountId: ts.subAccountId, symbol: ts.symbol, side: ts.side,
            quantity: ts.quantity, trailPct: ts.trailPct, activationPrice: ts.activationPrice,
            extremePrice: ts.extremePrice, triggerPrice: ts.triggerPrice,
            activated: ts.activated, status: ts.status,
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Validate (dry run) ──

router.post('/validate', requireOwnership('body'), proxyToRedis('pms:cmd:validate'));

export default router;

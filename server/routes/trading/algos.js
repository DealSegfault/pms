/**
 * Algo Routes — Thin Redis proxies for all algo commands.
 *
 * All algo logic lives in Python. JS just forwards commands via Redis.
 * Each route: LPUSH → pms:cmd:{algo} → Python processes → SET pms:result:{requestId} → JS reads
 *
 * State mappings use contracts/events.js for consistent shapes.
 */
import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { proxyToRedis, pushAndWait } from '../../redis-proxy.js';

const router = Router();

// ── Chase Limit ──

router.post('/chase-limit', requireOwnership('body'), proxyToRedis('pms:cmd:chase'));

router.delete('/chase-limit/:id', async (req, res) => {
    try {
        const chaseId = req.params.id;

        // Ownership check: look up chase state from Redis (#7)
        const { getRedis } = await import('../../redis.js');
        const r = getRedis();
        const stateJson = await r.get(`pms:chase:${chaseId}`);
        if (stateJson) {
            const state = JSON.parse(stateJson);
            if (state.subAccountId && req.user?.role !== 'ADMIN') {
                const account = await (await import('../../db/prisma.js')).default.subAccount.findUnique({
                    where: { id: state.subAccountId }, select: { userId: true },
                });
                if (account && account.userId !== req.user?.id) {
                    return res.status(403).json({ error: 'You do not own this chase order' });
                }
            }
        }

        const result = await pushAndWait('pms:cmd:chase_cancel', { chaseId });

        // Chase already gone from Python's active map — treat as success.
        if (!result.success) {
            try {
                const keys = [];
                for await (const key of r.scanIterator({ MATCH: 'pms:active_chase:*', COUNT: 100 })) {
                    keys.push(key);
                }
                for (const key of keys) {
                    await r.hdel(key, chaseId);
                }
                await r.del(`pms:chase:${chaseId}`);
            } catch (_) { /* non-fatal cleanup */ }

            return res.json({ success: true, alreadyCancelled: true });
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Scalper ──

router.post('/scalper', requireOwnership('body'), proxyToRedis('pms:cmd:scalper'));

router.delete('/scalper/:id', async (req, res) => {
    try {
        const scalperId = req.params.id;

        // Ownership check (#7)
        const { getRedis } = await import('../../redis.js');
        const r = getRedis();
        const stateJson = await r.get(`pms:scalper:${scalperId}`);
        if (stateJson) {
            const state = JSON.parse(stateJson);
            if (state.subAccountId && req.user?.role !== 'ADMIN') {
                const account = await (await import('../../db/prisma.js')).default.subAccount.findUnique({
                    where: { id: state.subAccountId }, select: { userId: true },
                });
                if (account && account.userId !== req.user?.id) {
                    return res.status(403).json({ error: 'You do not own this scalper' });
                }
            }
        }

        // Forward close param from query string (#16)
        const closePositions = req.query.close === '1' || req.query.close === 'true';
        const result = await pushAndWait('pms:cmd:scalper_cancel', { scalperId, closePositions });

        // Scalper already gone — clean leftover Redis state and return success
        if (!result.success) {
            try {
                const keys = [];
                for await (const key of r.scanIterator({ MATCH: 'pms:active_scalper:*', COUNT: 100 })) {
                    keys.push(key);
                }
                for (const key of keys) {
                    await r.hdel(key, scalperId);
                }
                await r.del(`pms:scalper:${scalperId}`);
            } catch (_) { /* non-fatal */ }

            return res.json({ success: true, alreadyCancelled: true });
        }

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

router.get('/twap-basket/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_twap_basket', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/twap-basket/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:twap_basket_cancel', { twapBasketId: req.params.id });
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

async function getActiveFromRedis(prefix, subAccountId) {
    const { getRedis } = await import('../../redis.js');
    const redis = getRedis();
    const key = `${prefix}:${subAccountId}`;
    const raw = await redis.hgetall(key);
    const items = Object.values(raw || {}).map(v => {
        try { return JSON.parse(v); }
        catch { return null; }
    }).filter(Boolean);
    return items;
}

// Chase: Python to_dict() output passed through directly
router.get('/chase-limit/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_chase', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scalper: Python to_dict() output passed through directly
router.get('/scalper/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_scalper', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// TWAP: Python to_dict() output passed through directly
router.get('/twap/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_twap', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trail Stop: Python to_dict() output passed through directly
router.get('/trail-stop/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const items = await getActiveFromRedis('pms:active_trail_stop', req.params.subAccountId);
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Validate (dry run) ──

router.post('/validate', requireOwnership('body'), proxyToRedis('pms:cmd:validate'));

export default router;

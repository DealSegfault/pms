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

// ── Validate (dry run) ──

router.post('/validate', requireOwnership('body'), proxyToRedis('pms:cmd:validate'));

export default router;

/**
 * Limit Orders Routes — THIN PROXY VERSION
 *
 * Forwards limit/scale/cancel commands to Python via Redis.
 * Read-only order queries still use Prisma.
 */
import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { requireOwnership } from '../../ownership.js';
import { proxyToRedis, pushAndWait } from '../../redis-proxy.js';

const router = Router();

// POST /api/trade/limit — Place limit order via Python
router.post('/limit', requireOwnership('body'), proxyToRedis('pms:cmd:limit', (req) => ({
    subAccountId: req.body.subAccountId,
    symbol: req.body.symbol,
    side: req.body.side,
    quantity: req.body.quantity,
    price: req.body.price,
    leverage: req.body.leverage,
    reduceOnly: req.body.reduceOnly || false,
})));

// POST /api/trade/scale — Scale/grid orders via Python
router.post('/scale', requireOwnership('body'), proxyToRedis('pms:cmd:scale', (req) => ({
    subAccountId: req.body.subAccountId,
    symbol: req.body.symbol,
    side: req.body.side,
    leverage: req.body.leverage,
    levels: req.body.levels,
})));

// DELETE /api/trade/orders/:id — Cancel single order via Python
router.delete('/orders/:id', async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:cancel', {
            clientOrderId: req.params.id,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/cancel-all — Cancel all orders for symbol via Python
router.post('/cancel-all', requireOwnership('body'), proxyToRedis('pms:cmd:cancel_all', (req) => ({
    symbol: req.body.symbol,
    subAccountId: req.body.subAccountId,
})));

// ── Read-Only ──

// GET /api/trade/orders/:subAccountId — Pending orders from DB
router.get('/orders/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const orders = await prisma.pendingOrder.findMany({
            where: {
                subAccountId: req.params.subAccountId,
                status: { in: ['PENDING'] },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

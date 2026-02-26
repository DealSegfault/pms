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

// GET /api/trade/orders/:subAccountId — Active orders from Redis (Python OrderManager writes here)
router.get('/orders/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { getRedis } = await import('../../redis.js');
        const redis = getRedis();
        const key = `pms:open_orders:${req.params.subAccountId}`;
        const raw = await redis.hgetall(key);
        const orders = Object.values(raw || {}).map(v => {
            try {
                const o = JSON.parse(v);
                // Map Python OrderState fields → frontend expected fields
                return {
                    id: o.clientOrderId,
                    exchangeOrderId: o.exchangeOrderId,
                    subAccountId: o.subAccountId,
                    symbol: o.symbol.replace('USDT', '/USDT'),
                    side: o.side === 'BUY' ? 'LONG' : 'SHORT',
                    type: o.orderType || 'LIMIT',
                    price: o.price || 0,
                    quantity: o.quantity || 0,
                    filledQty: o.filledQty || 0,
                    leverage: o.leverage || 1,
                    reduceOnly: o.reduceOnly || false,
                    origin: o.origin || 'MANUAL',
                    state: o.state,
                    createdAt: o.createdAt ? new Date(o.createdAt * 1000).toISOString() : new Date().toISOString(),
                };
            } catch { return null; }
        }).filter(Boolean);
        // Sort by createdAt desc
        orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

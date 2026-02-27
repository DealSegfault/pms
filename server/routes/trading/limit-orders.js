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
    levels: req.body.orders || req.body.levels,
})));

// DELETE /api/trade/orders/all/:subAccountId — Cancel ALL orders for account via Python
router.delete('/orders/all/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const result = await pushAndWait('pms:cmd:cancel_all', {
            subAccountId: req.params.subAccountId,
        });
        res.json({ cancelled: result.cancelledCount || 0, failed: result.failedCount || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/orders/:id — Cancel single order via Python
router.delete('/orders/:id', async (req, res) => {
    try {
        const clientOrderId = req.params.id;

        // Ownership check: extract subAccountId from clientOrderId prefix (#7)
        // Format: PMS{sub[:8]}_{type}_{uuid} — first 8 chars after PMS are sub-account prefix
        if (req.user?.role !== 'ADMIN') {
            const { getRedis } = await import('../../redis.js');
            const r = getRedis();
            // Scan open orders hashes to find which account owns this order
            let foundSubAccountId = null;
            let cursor = '0';
            do {
                const [nextCursor, keys] = await r.scan(cursor, 'MATCH', 'pms:open_orders:*', 'COUNT', 100);
                cursor = nextCursor;
                for (const key of keys) {
                    const orderJson = await r.hget(key, clientOrderId);
                    if (orderJson) {
                        const order = JSON.parse(orderJson);
                        foundSubAccountId = order.subAccountId;
                        break;
                    }
                }
                if (foundSubAccountId) break;
            } while (cursor !== '0');
            if (foundSubAccountId) {
                const account = await prisma.subAccount.findUnique({
                    where: { id: foundSubAccountId }, select: { userId: true },
                });
                if (account && account.userId !== req.user?.id) {
                    return res.status(403).json({ error: 'You do not own this order' });
                }
            }
        }

        const result = await pushAndWait('pms:cmd:cancel', {
            clientOrderId,
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
// Python to_event_dict() is the sole contract — passed through as-is.
router.get('/orders/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { getRedis } = await import('../../redis.js');
        const redis = getRedis();
        const key = `pms:open_orders:${req.params.subAccountId}`;
        const raw = await redis.hgetall(key);
        const orders = Object.values(raw || {}).map(v => {
            try { return JSON.parse(v); }
            catch { return null; }
        }).filter(o => {
            if (!o) return false;
            // Filter out terminal-state ghosts (filled orders stuck in Redis)
            const st = (o.state || o.status || '').toLowerCase();
            return st !== 'filled' && st !== 'cancelled' && st !== 'expired' && st !== 'failed';
        });
        // Sort by createdAt desc (seconds float)
        orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

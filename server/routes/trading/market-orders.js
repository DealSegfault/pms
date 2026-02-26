/**
 * Market Orders Routes — THIN PROXY VERSION
 *
 * Forwards trade commands to Python via Redis.
 * Read-only queries (positions, history, margin) still use Prisma/Redis directly.
 */
import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { getRiskSnapshot } from '../../redis.js';
import { requireOwnership, requirePositionOwnership } from '../../ownership.js';
import { proxyToRedis, pushAndWait } from '../../redis-proxy.js';

const router = Router();

// POST /api/trade — Forward to Python engine
router.post('/', requireOwnership('body'), proxyToRedis('pms:cmd:trade', (req) => ({
    subAccountId: req.body.subAccountId,
    symbol: req.body.symbol,
    side: req.body.side,
    quantity: req.body.quantity,
    leverage: req.body.leverage,
    fallbackPrice: req.body.fallbackPrice,
    reduceOnly: req.body.reduceOnly || false,
})));

// POST /api/trade/close/:positionId — Close a position via Python
router.post('/close/:positionId', requirePositionOwnership(), async (req, res) => {
    try {
        const position = await prisma.virtualPosition.findUnique({
            where: { id: req.params.positionId },
        });
        if (!position || position.status !== 'OPEN') {
            return res.status(404).json({ error: 'Position not found or already closed' });
        }

        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const result = await pushAndWait('pms:cmd:close', {
            subAccountId: position.subAccountId,
            symbol: position.symbol,
            side: closeSide,
            quantity: position.quantity,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/close-all/:subAccountId — Close all positions via Python
router.post('/close-all/:subAccountId', requireOwnership(), proxyToRedis('pms:cmd:close_all', (req) => ({
    subAccountId: req.params.subAccountId,
})));

// POST /api/trade/validate — Pre-trade validation via Python
router.post('/validate', requireOwnership('body'), proxyToRedis('pms:cmd:validate'));

// ── Read-Only Routes (stay in JS — read from DB/Redis directly) ──

// GET /api/trade/positions/:subAccountId — Open positions with live PnL
router.get('/positions/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;

        // Try Redis snapshot first (written by Python RiskEngine)
        const snapshot = await getRiskSnapshot(subAccountId);
        if (snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000) {
            return res.json(snapshot);
        }

        // Fallback to DB
        const positions = await prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
            select: { currentBalance: true },
        });

        res.json({
            balance: account?.currentBalance || 0,
            positions: positions.map(p => ({
                id: p.id,
                symbol: p.symbol,
                side: p.side,
                entryPrice: p.entryPrice,
                quantity: p.quantity,
                margin: p.margin,
                leverage: p.leverage,
                liquidationPrice: p.liquidationPrice,
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/margin/:subAccountId — Margin info (from Redis snapshot)
router.get('/margin/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const snapshot = await getRiskSnapshot(req.params.subAccountId);
        if (snapshot) {
            return res.json(snapshot);
        }
        res.json({ balance: 0, equity: 0, marginUsed: 0, availableMargin: 0, positions: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/history/:subAccountId — Trade history (read from DB)
router.get('/history/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [trades, total] = await Promise.all([
            prisma.tradeExecution.findMany({
                where: { subAccountId: req.params.subAccountId },
                orderBy: { timestamp: 'desc' },
                take: parseInt(limit),
                skip,
            }),
            prisma.tradeExecution.count({
                where: { subAccountId: req.params.subAccountId },
            }),
        ]);

        res.json({ trades, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

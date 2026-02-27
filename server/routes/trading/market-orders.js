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
        const positionId = req.params.positionId;
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
        });
        if (!position || position.status !== 'OPEN') {
            return res.status(404).json({ error: 'Position not found or already closed' });
        }

        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        let result;
        try {
            result = await pushAndWait('pms:cmd:close', {
                subAccountId: position.subAccountId,
                symbol: position.symbol,
                side: closeSide,
                quantity: position.quantity,
                positionId,
            });
        } catch (cmdErr) {
            // pushAndWait timed out or Python not running —
            // check if position actually exists in the live snapshot
            const snapshot = await getRiskSnapshot(position.subAccountId);
            const livePositions = snapshot?.positions || [];
            const existsLive = livePositions.some(p =>
                (p.id === positionId || p.positionId === positionId)
            );

            if (!existsLive) {
                // Ghost: in DB but not in Python's live book
                await prisma.virtualPosition.update({
                    where: { id: positionId },
                    data: { status: 'CLOSED', closedAt: new Date(), realizedPnl: 0 },
                });
                console.warn(`[close] Force-closed ghost position ${positionId.slice(0, 8)} (Python unreachable, not in live snapshot)`);
                try {
                    const { getRedis } = await import('../../redis.js');
                    await (getRedis()).del(`pms:risk:${position.subAccountId}`);
                } catch (_) { /* non-fatal */ }
                return res.json({ success: true, staleCleanup: true, positionId });
            }
            // Position exists live but Python timed out — real error
            return res.status(500).json({ error: cmdErr.message });
        }

        // Python successfully cleaned the ghost position from its side
        if (result.staleCleanup) {
            return res.json({ success: true, staleCleanup: true, positionId });
        }

        // Python failed to close AND failed to find the position in its book.
        if (!result.success) {
            const errorStr = (result.error || '').toLowerCase();
            const isGhost = errorStr.includes('reduceonly')
                || errorStr.includes('reduce only')
                || errorStr.includes('no position found')
                || errorStr.includes('close order failed');

            if (isGhost) {
                await prisma.virtualPosition.update({
                    where: { id: positionId },
                    data: { status: 'CLOSED', closedAt: new Date(), realizedPnl: 0 },
                });
                console.warn(`[close] Force-closed ghost position ${positionId.slice(0, 8)} from DB (not on exchange)`);
                try {
                    const { getRedis } = await import('../../redis.js');
                    await (getRedis()).del(`pms:risk:${position.subAccountId}`);
                } catch (_) { /* non-fatal */ }
                return res.json({ success: true, staleCleanup: true, positionId });
            }

            return res.status(400).json(result);
        }

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
        if (snapshot?.balance != null) {
            const balance = snapshot.balance || 0;
            const marginUsed = snapshot.marginUsed || 0;
            const equity = snapshot.equity || balance;
            const positions = snapshot.positions || [];
            const openOrders = snapshot.openOrders || [];
            const totalExposure = positions.reduce((s, p) => s + (p.quantity * (p.markPrice || p.entryPrice)), 0);
            const unrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
            return res.json({
                positions,
                openOrders,
                summary: {
                    balance,
                    equity,
                    marginUsed,
                    availableMargin: snapshot.availableMargin || Math.max(0, equity - marginUsed),
                    totalExposure,
                    unrealizedPnl,
                    marginRatio: equity > 0 ? marginUsed / equity : 0,
                    positionCount: positions.length,
                    accountLiqPrice: null,
                },
            });
        }

        // Fallback to DB
        const positions = await prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });
        const account = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
            select: { currentBalance: true, maintenanceRate: true },
        });

        const balance = account?.currentBalance || 0;
        const maintenanceRate = account?.maintenanceRate || 0.005;

        // Compute summary fields from positions
        const marginUsed = positions.reduce((s, p) => s + (p.margin || 0), 0);
        const totalExposure = positions.reduce((s, p) => s + (p.notional || 0), 0);
        // Without live prices, unrealized PnL = 0
        const unrealizedPnl = 0;
        const equity = balance + unrealizedPnl;
        const availableMargin = Math.max(0, equity - marginUsed);
        const marginRatio = equity > 0 ? marginUsed / equity : 0;

        // Align with PositionSnapshot.to_dict() shape
        const mappedPositions = positions.map(p => ({
            id: p.id,
            subAccountId: p.subAccountId,
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            notional: p.notional,
            margin: p.margin,
            leverage: p.leverage,
            liquidationPrice: p.liquidationPrice,
            markPrice: p.entryPrice,
            unrealizedPnl: 0,
            pnlPercent: 0,
            openedAt: p.openedAt,
        }));

        res.json({
            positions: mappedPositions,
            summary: {
                balance,
                equity,
                marginUsed,
                availableMargin,
                totalExposure,
                unrealizedPnl,
                marginRatio,
                positionCount: positions.length,
                accountLiqPrice: null,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/margin/:subAccountId — Margin info (from Redis snapshot)
router.get('/margin/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const snapshot = await getRiskSnapshot(subAccountId);
        if (snapshot?.balance != null) {
            // Enrich with rules if not present
            if (!snapshot.rules) {
                const rule = await prisma.riskRule.findFirst({ where: { subAccountId } });
                if (rule) {
                    snapshot.rules = {
                        maxNotionalPerTrade: rule.maxNotionalPerTrade,
                        maxTotalExposure: rule.maxTotalExposure,
                        maxLeverage: rule.maxLeverage,
                    };
                }
            }
            return res.json(snapshot);
        }

        // DB fallback — compute from positions + account
        const [account, positions, rule] = await Promise.all([
            prisma.subAccount.findUnique({ where: { id: subAccountId }, select: { currentBalance: true } }),
            prisma.virtualPosition.findMany({ where: { subAccountId, status: 'OPEN' } }),
            prisma.riskRule.findFirst({ where: { subAccountId } }),
        ]);

        const balance = account?.currentBalance || 0;
        const marginUsed = positions.reduce((s, p) => s + (p.margin || 0), 0);
        const equity = balance;
        const availableMargin = Math.max(0, equity - marginUsed);

        res.json({
            balance,
            equity,
            marginUsed,
            availableMargin,
            positions: positions.map(p => ({
                id: p.id, symbol: p.symbol, side: p.side,
                entryPrice: p.entryPrice, quantity: p.quantity,
                margin: p.margin, leverage: p.leverage,
                notional: p.notional,
                liquidationPrice: p.liquidationPrice,
                markPrice: p.entryPrice,
                unrealizedPnl: 0,
            })),
            ...(rule ? {
                rules: {
                    maxNotionalPerTrade: rule.maxNotionalPerTrade,
                    maxTotalExposure: rule.maxTotalExposure,
                    maxLeverage: rule.maxLeverage,
                },
            } : {}),
        });
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

// GET /api/trade/chart-data/:subAccountId — Data for chart annotations (positions, orders, trades)
router.get('/chart-data/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'symbol required' });

        const subAccountId = req.params.subAccountId;
        const { getRedis } = await import('../../redis.js');

        // Normalize symbol for comparison: 'RAVE/USDT:USDT' → 'RAVEUSDT'
        const normSymbol = symbol.replace('/', '').replace(':USDT', '').toUpperCase();
        // Also create a slash form for matching snapshot positions: 'RAVE/USDT'
        const slashSymbol = normSymbol.replace('USDT', '/USDT');

        // 1. Positions from Redis risk snapshot — passthrough
        let positions = [];
        const { getRiskSnapshot } = await import('../../redis.js');
        const snapshot = await getRiskSnapshot(subAccountId);
        if (snapshot && Array.isArray(snapshot.positions)) {
            positions = snapshot.positions.filter(p => {
                const pNorm = (p.symbol || '').replace('/', '').replace(':USDT', '').toUpperCase();
                return pNorm === normSymbol;
            });
        }

        // 2. Open orders from Redis hash — passthrough (Python to_event_dict() shape)
        const redis = getRedis();
        const rawOrders = await redis.hgetall(`pms:open_orders:${subAccountId}`);
        const openOrders = Object.values(rawOrders || {}).map(v => {
            try {
                const o = JSON.parse(v);
                const oNorm = (o.symbol || '').replace('/', '').replace(':USDT', '').toUpperCase();
                if (oNorm !== normSymbol) return null;
                // Filter out terminal-state ghosts (filled orders stuck in Redis)
                const st = (o.state || o.status || '').toLowerCase();
                if (st === 'filled' || st === 'cancelled' || st === 'expired' || st === 'failed') return null;
                return o;
            } catch { return null; }
        }).filter(Boolean);

        // 3. Recent trades from DB
        const trades = await prisma.tradeExecution.findMany({
            where: { subAccountId, symbol },
            orderBy: { timestamp: 'desc' },
            take: 200,
        });

        res.json({ positions, trades, openOrders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

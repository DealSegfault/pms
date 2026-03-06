/**
 * Market Orders Routes — THIN PROXY VERSION
 *
 * Forwards trade commands to Python via Redis.
 * Read-only queries (positions, history, margin) still use Prisma/Redis directly.
 */
import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { buildApiErrorBody, commandFailureResponse } from '../../http/api-taxonomy.js';
import { getRiskSnapshot } from '../../redis.js';
import { requireOwnership, requirePositionOwnership } from '../../ownership.js';
import { proxyToRedis, pushAndWait } from '../../redis-proxy.js';

const router = Router();

function computeReservedMargin(totalNotional, leverageCap = 100) {
    const cap = Number(leverageCap) > 0 ? Number(leverageCap) : 1;
    return totalNotional / cap;
}

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
        const dbPosition = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
        });
        const subAccountId = req.body?.subAccountId || req.subAccountId || dbPosition?.subAccountId || null;
        const snapshot = subAccountId ? await getRiskSnapshot(subAccountId) : null;
        const livePositions = snapshot?.positions || [];
        const livePosition = livePositions.find((p) =>
            (p.id === positionId || p.positionId === positionId)
        );

        if (!livePosition && (!dbPosition || dbPosition.status !== 'OPEN')) {
            return res.status(404).json(buildApiErrorBody({
                code: 'POSITION_NOT_FOUND',
                category: 'VALIDATION',
                message: 'Position not found or already closed',
            }));
        }

        const position = livePosition || dbPosition;
        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const closeQty = livePosition?.quantity ?? dbPosition?.quantity;
        const closeSubAccountId = subAccountId || dbPosition?.subAccountId;
        let result;
        try {
            result = await pushAndWait('pms:cmd:close', {
                subAccountId: closeSubAccountId,
                symbol: position.symbol,
                side: closeSide,
                quantity: closeQty,
                positionId,
            });
        } catch (cmdErr) {
            // pushAndWait timed out or Python not running —
            // check if position actually exists in the live snapshot
            const freshSnapshot = closeSubAccountId ? await getRiskSnapshot(closeSubAccountId) : null;
            const freshPositions = freshSnapshot?.positions || [];
            const existsLive = freshPositions.some(p =>
                (p.id === positionId || p.positionId === positionId)
            );

            if (!existsLive) {
                // Ghost: in DB but not in Python's live book
                if (dbPosition) {
                    await prisma.virtualPosition.update({
                        where: { id: positionId },
                        data: { status: 'CLOSED', closedAt: new Date(), realizedPnl: 0 },
                    });
                }
                console.warn(`[close] Force-closed ghost position ${positionId.slice(0, 8)} (Python unreachable, not in live snapshot)`);
                try {
                    const { getRedis } = await import('../../redis.js');
                    if (closeSubAccountId) {
                        await (getRedis()).del(`pms:risk:${closeSubAccountId}`);
                    }
                } catch (_) { /* non-fatal */ }
                return res.json({ success: true, staleCleanup: true, positionId });
            }
            // Position exists live but Python timed out — real error
            return res.status(504).json(buildApiErrorBody({
                code: 'INFRA_TIMEOUT',
                category: 'TIMEOUT',
                message: cmdErr.message || 'Execution timeout — Python engine may be unavailable',
                retryable: true,
            }));
        }

        // Python successfully cleaned the ghost position from its side
        if (result.staleCleanup) {
            return res.json({ success: true, staleCleanup: true, positionId });
        }

        // Python failed to close AND failed to find the position in its book.
        if (!result.success) {
            if (livePosition) {
                return res.status(409).json(buildApiErrorBody({
                    code: result.errorCode || 'AMBIGUOUS_CLOSE_REJECTED',
                    category: result.errorCategory || 'AMBIGUITY',
                    message: result.error || 'Close rejected while position is still live',
                    retryable: Boolean(result.retryable),
                    details: result.details,
                }));
            }
            const errorStr = (result.error || '').toLowerCase();
            const isGhost = errorStr.includes('reduceonly')
                || errorStr.includes('reduce only')
                || errorStr.includes('no position found')
                || errorStr.includes('close order failed');

            if (isGhost) {
                if (dbPosition) {
                    await prisma.virtualPosition.update({
                        where: { id: positionId },
                        data: { status: 'CLOSED', closedAt: new Date(), realizedPnl: 0 },
                    });
                }
                console.warn(`[close] Force-closed ghost position ${positionId.slice(0, 8)} from DB (not on exchange)`);
                try {
                    const { getRedis } = await import('../../redis.js');
                    if (closeSubAccountId) {
                        await (getRedis()).del(`pms:risk:${closeSubAccountId}`);
                    }
                } catch (_) { /* non-fatal */ }
                return res.json({ success: true, staleCleanup: true, positionId });
            }

            const failure = commandFailureResponse(result);
            return res.status(failure.status).json(failure.body);
        }

        res.json(result);
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'INTERNAL_CLOSE_ERROR',
            category: 'INFRA',
            message: err.message || 'Close request failed',
            retryable: true,
        }));
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
        const [account, rule] = await Promise.all([
            prisma.subAccount.findUnique({
                where: { id: subAccountId },
                select: { currentBalance: true, maintenanceRate: true },
            }),
            prisma.riskRule.findFirst({ where: { subAccountId } }),
        ]);

        const balance = account?.currentBalance || 0;
        const reserveLeverage = rule?.maxLeverage || 100;

        // Compute summary fields from positions
        const totalExposure = positions.reduce((s, p) => s + (p.notional || 0), 0);
        const marginUsed = computeReservedMargin(totalExposure, reserveLeverage);
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
        const totalExposure = positions.reduce((s, p) => s + (p.notional || 0), 0);
        const marginUsed = computeReservedMargin(totalExposure, rule?.maxLeverage || 100);
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

// GET /api/trade/position-history/:subAccountId — Position history with fee enrichment
router.get('/position-history/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const { symbol, period, status: statusFilter, limit = 200, offset = 0 } = req.query;

        // Build time filter
        let fromDate = null;
        if (period) {
            const now = new Date();
            if (period === 'today') fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            else if (period === '7d') fromDate = new Date(now - 7 * 86400000);
            else if (period === '30d') fromDate = new Date(now - 30 * 86400000);
        }

        // Which statuses to include
        const statuses = statusFilter
            ? statusFilter.split(',').map(s => s.trim().toUpperCase())
            : ['CLOSED', 'LIQUIDATED', 'TAKEN_OVER'];
        const includeOpen = !statusFilter || statusFilter.toUpperCase().includes('OPEN');

        // Build where clause for closed/liquidated positions
        const where = { subAccountId, status: { in: statuses } };
        if (symbol) {
            const normalizedSymbol = symbol.toUpperCase().includes('/') ? symbol : `${symbol.toUpperCase()}/USDT:USDT`;
            where.symbol = normalizedSymbol;
        }
        if (fromDate) {
            where.closedAt = { gte: fromDate };
        }

        // Query closed positions
        const closedPositions = await prisma.virtualPosition.findMany({
            where,
            orderBy: { closedAt: 'desc' },
            take: parseInt(limit),
            skip: parseInt(offset),
        });

        const closedTotal = await prisma.virtualPosition.count({ where });

        // Get fee totals per position from TradeExecution
        const positionIds = closedPositions.map(p => p.id);
        let feesByPosition = {};
        let tradeCountByPosition = {};
        if (positionIds.length > 0) {
            const feeAgg = await prisma.tradeExecution.groupBy({
                by: ['positionId'],
                where: { positionId: { in: positionIds } },
                _sum: { fee: true },
                _count: true,
            });
            for (const row of feeAgg) {
                feesByPosition[row.positionId] = row._sum.fee || 0;
                tradeCountByPosition[row.positionId] = row._count || 0;
            }
        }

        // Enrich closed positions
        const enrichedClosed = closedPositions.map(p => {
            const totalFees = feesByPosition[p.id] || 0;
            const grossPnl = p.realizedPnl || 0;
            const netPnl = grossPnl - totalFees;
            const durationMs = p.closedAt && p.openedAt
                ? new Date(p.closedAt).getTime() - new Date(p.openedAt).getTime()
                : null;
            return {
                id: p.id,
                symbol: p.symbol,
                side: p.side,
                entryPrice: p.entryPrice,
                quantity: p.quantity,
                notional: p.notional,
                leverage: p.leverage,
                status: p.status,
                realizedPnl: grossPnl,
                totalFees,
                netPnl,
                durationMs,
                tradeCount: tradeCountByPosition[p.id] || 0,
                openedAt: p.openedAt,
                closedAt: p.closedAt,
            };
        });

        // Include OPEN positions from Redis
        let openPositions = [];
        if (includeOpen) {
            const snapshot = await getRiskSnapshot(subAccountId);
            if (snapshot?.positions?.length > 0) {
                let livePositions = snapshot.positions;
                if (symbol) {
                    const normalizedSymbol = symbol.toUpperCase().includes('/') ? symbol : `${symbol.toUpperCase()}/USDT:USDT`;
                    livePositions = livePositions.filter(p => {
                        const ps = (p.symbol || '').toUpperCase();
                        return ps === normalizedSymbol.toUpperCase() || ps === normalizedSymbol.replace(':USDT', '').toUpperCase();
                    });
                }
                openPositions = livePositions.map(p => ({
                    id: p.id || p.positionId,
                    symbol: p.symbol,
                    side: p.side,
                    entryPrice: p.entryPrice,
                    quantity: p.quantity,
                    notional: p.notional || (p.quantity * (p.markPrice || p.entryPrice)),
                    leverage: p.leverage,
                    status: 'OPEN',
                    realizedPnl: 0,
                    unrealizedPnl: p.unrealizedPnl || 0,
                    markPrice: p.markPrice || 0,
                    totalFees: 0,
                    netPnl: p.unrealizedPnl || 0,
                    durationMs: p.openedAt ? Date.now() - new Date(p.openedAt).getTime() : null,
                    tradeCount: 0,
                    openedAt: p.openedAt,
                    closedAt: null,
                }));
            }
        }

        // Merge: open positions first, then closed
        const allPositions = [...openPositions, ...enrichedClosed];

        // Build per-symbol rollups
        const symbolMap = {};
        for (const p of allPositions) {
            const sym = p.symbol;
            if (!symbolMap[sym]) {
                symbolMap[sym] = {
                    symbol: sym,
                    count: 0,
                    openCount: 0,
                    closedCount: 0,
                    wins: 0,
                    losses: 0,
                    cumulativePnl: 0,
                    totalFees: 0,
                    netPnl: 0,
                    totalDurationMs: 0,
                    durationCount: 0,
                    pnlSeries: [], // for sparkline
                };
            }
            const r = symbolMap[sym];
            r.count++;
            if (p.status === 'OPEN') {
                r.openCount++;
                r.cumulativePnl += p.unrealizedPnl || 0;
                r.netPnl += p.unrealizedPnl || 0;
            } else {
                r.closedCount++;
                const pnl = p.realizedPnl || 0;
                if (pnl > 0) r.wins++;
                else if (pnl < 0) r.losses++;
                r.cumulativePnl += pnl;
                r.totalFees += p.totalFees;
                r.netPnl += p.netPnl;
                if (p.durationMs) {
                    r.totalDurationMs += p.durationMs;
                    r.durationCount++;
                }
                // Add to PnL series (sorted by closedAt for sparkline)
                r.pnlSeries.push({ ts: p.closedAt, pnl });
            }
        }

        const symbolRollups = Object.values(symbolMap).map(r => {
            // Sort PnL series by time and compute cumulative
            r.pnlSeries.sort((a, b) => new Date(a.ts) - new Date(b.ts));
            let cumulative = 0;
            const sparklineData = r.pnlSeries.map(s => {
                cumulative += s.pnl;
                return cumulative;
            });
            return {
                symbol: r.symbol,
                count: r.count,
                openCount: r.openCount,
                closedCount: r.closedCount,
                wins: r.wins,
                losses: r.losses,
                winRate: r.closedCount > 0 ? r.wins / r.closedCount : 0,
                cumulativePnl: r.cumulativePnl,
                totalFees: r.totalFees,
                netPnl: r.netPnl,
                avgDurationMs: r.durationCount > 0 ? r.totalDurationMs / r.durationCount : null,
                sparklineData,
            };
        }).sort((a, b) => Math.abs(b.cumulativePnl) - Math.abs(a.cumulativePnl));

        res.json({
            positions: allPositions,
            symbolRollups,
            total: closedTotal + openPositions.length,
            closedTotal,
            openTotal: openPositions.length,
        });
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

// GET /api/trade/stats/:subAccountId — Account stats for My Account page
router.get('/stats/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        // All close trades (actions that realize PnL)
        const closeTrades = await prisma.tradeExecution.findMany({
            where: { subAccountId, action: { notIn: ['OPEN', 'ADD'] } },
            orderBy: { timestamp: 'asc' },
        });

        const allTrades = await prisma.tradeExecution.findMany({
            where: { subAccountId },
            orderBy: { timestamp: 'asc' },
        });

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const week = new Date(now - 7 * 86400000);
        const month = new Date(now - 30 * 86400000);

        function pnlForPeriod(trades, from) {
            const filtered = from ? trades.filter(t => new Date(t.timestamp) >= from) : trades;
            const rpnl = filtered.reduce((s, t) => s + (t.realizedPnl || 0), 0);
            const wins = filtered.filter(t => (t.realizedPnl || 0) > 0).length;
            const losses = filtered.filter(t => (t.realizedPnl || 0) < 0).length;
            const totalFees = filtered.reduce((s, t) => s + (t.fee || 0), 0);
            return { rpnl, count: filtered.length, wins, losses, totalFees };
        }

        const periods = {
            today: pnlForPeriod(closeTrades, todayStart),
            week: pnlForPeriod(closeTrades, week),
            month: pnlForPeriod(closeTrades, month),
            all: pnlForPeriod(closeTrades, null),
        };

        // Activity stats
        const totalTrades = allTrades.length;
        const totalFees = allTrades.reduce((s, t) => s + (t.fee || 0), 0);
        const avgPnl = periods.all.count > 0 ? periods.all.rpnl / periods.all.count : 0;
        const pnls = closeTrades.map(t => t.realizedPnl || 0);
        const bestTrade = pnls.length > 0 ? Math.max(...pnls) : 0;
        const worstTrade = pnls.length > 0 ? Math.min(...pnls) : 0;
        const grossProfit = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
        const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((s, p) => s + p, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

        // Equity curve from balance logs
        const balanceLogs = await prisma.balanceLog.findMany({
            where: { subAccountId },
            orderBy: { timestamp: 'asc' },
            select: { timestamp: true, balanceAfter: true },
        });

        res.json({
            account: { id: account.id, name: account.name, balance: account.currentBalance },
            periods,
            activity: { totalTrades, totalFees, avgPnl, bestTrade, worstTrade, profitFactor },
            equityCurve: balanceLogs.map(l => ({ time: l.timestamp, value: l.balanceAfter })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

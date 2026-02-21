/**
 * Market Orders Routes — place trades, close positions, validate, positions, history, chart-data, margin, stats.
 */
import { Router } from 'express';
import riskEngine, { prisma } from '../../risk/index.js';
import exchange from '../../exchange.js';
import { getRiskSnapshot } from '../../redis.js';
import { requireOwnership, requirePositionOwnership } from '../../ownership.js';

const router = Router();

// POST /api/trade - Place a new trade
router.post('/', requireOwnership('body'), async (req, res) => {
    try {
        const startedAt = Date.now();
        const { subAccountId, symbol, side, quantity, leverage, fastExecution, fallbackPrice, babysitterExcluded, reduceOnly } = req.body;

        if (!subAccountId || !symbol || !side || !quantity || !leverage) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side, quantity, leverage' });
        }

        const validSides = ['LONG', 'SHORT'];
        if (!validSides.includes(side.toUpperCase())) {
            return res.status(400).json({ error: 'side must be LONG or SHORT' });
        }

        const parsedFallbackPrice = Number.parseFloat(fallbackPrice);
        const normalizedFallbackPrice = Number.isFinite(parsedFallbackPrice) && parsedFallbackPrice > 0
            ? parsedFallbackPrice
            : undefined;

        const result = await riskEngine.executeTrade(
            subAccountId,
            symbol,
            side.toUpperCase(),
            parseFloat(quantity),
            parseFloat(leverage),
            'MARKET',
            {
                fastExecution: fastExecution !== false,
                fallbackPrice: normalizedFallbackPrice,
                origin: 'MANUAL',
                ...(typeof babysitterExcluded === 'boolean' ? { babysitterExcluded } : {}),
                ...(reduceOnly ? { reduceOnly: true } : {}),
            },
        );


        if (!result.success) {
            // Structured errors: [{ code, message }]
            return res.status(400).json({
                success: false,
                errors: result.errors,
                // Legacy compat
                error: result.errors.map(e => e.message || e).join('; '),
                reasons: result.errors.map(e => e.message || e),
            });
        }

        const serverLatencyMs = Date.now() - startedAt;
        res.set('X-Server-Latency-Ms', String(serverLatencyMs));
        res.status(201).json({ ...result, serverLatencyMs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/close/:positionId - Close a position
router.post('/close/:positionId', requirePositionOwnership(), async (req, res) => {
    try {
        const _t0 = Date.now();
        const result = await riskEngine.closePosition(req.params.positionId, 'CLOSE');
        if (!result.success) {
            return res.status(400).json({ error: 'Close failed', reasons: result.errors });
        }
        console.log(`[Perf] POST /trade/close ${Date.now() - _t0}ms`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/close-all/:subAccountId - Close all open positions
router.post('/close-all/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const positions = await prisma.virtualPosition.findMany({
            where: { subAccountId: req.params.subAccountId, status: 'OPEN' },
        });
        if (positions.length === 0) return res.json({ closed: 0, results: [] });

        const results = [];
        for (const pos of positions) {
            try {
                const result = await riskEngine.closePosition(pos.id, 'CLOSE');
                results.push({ positionId: pos.id, symbol: pos.symbol, success: result.success, pnl: result.trade?.realizedPnl });
            } catch (err) {
                results.push({ positionId: pos.id, symbol: pos.symbol, success: false, error: err.message });
            }
        }
        res.json({ closed: results.filter(r => r.success).length, total: positions.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/limit-close/:positionId - Place reduce-only limit close
router.post('/limit-close/:positionId', requirePositionOwnership(), async (req, res) => {
    try {
        const { price } = req.body;
        if (!price) return res.status(400).json({ error: 'price is required' });

        const position = await prisma.virtualPosition.findUnique({ where: { id: req.params.positionId } });
        if (!position) return res.status(404).json({ error: 'Position not found' });
        if (position.status !== 'OPEN') return res.status(400).json({ error: 'Position is not open' });

        // ── Exchange sync guard ──────────────────────────────────────────────
        // Before placing a reduce-only limit order, verify a real exchange position
        // exists with the same side. A desynced position would create a bad order.
        try {
            const exchangePositions = await exchange.fetchPositions();
            const exchangePos = exchangePositions.find((p) => p.symbol === position.symbol);
            const exSide = (exchangePos?.side || '').toLowerCase();
            const virtualSide = position.side.toLowerCase(); // 'long' or 'short'

            if (!exchangePos) {
                console.warn(`[LimitClose] No exchange position found for ${position.symbol} — skipping order`);
                return res.status(400).json({
                    error: 'Position desynced with exchange — no matching exchange position, order not sent',
                    desync: true,
                    exchangeSide: null,
                    virtualSide: position.side,
                });
            }
            if (exSide !== virtualSide) {
                console.warn(`[LimitClose] Side mismatch for ${position.symbol} (exchange: ${exchangePos.side}, virtual: ${position.side}) — skipping order`);
                return res.status(400).json({
                    error: `Position desynced with exchange — side mismatch (exchange: ${exchangePos.side}, virtual: ${position.side}), order not sent`,
                    desync: true,
                    exchangeSide: exchangePos.side,
                    virtualSide: position.side,
                });
            }
        } catch (syncErr) {
            // Fail-safe: if we can't verify the exchange position, don't send an order
            console.error(`[LimitClose] Exchange sync check failed for ${position.symbol}:`, syncErr.message);
            return res.status(503).json({
                error: 'Exchange sync check failed — order not sent to avoid bad trade',
                desync: true,
            });
        }
        // ────────────────────────────────────────────────────────────────────

        // Close side is opposite of position side
        const closeSide = position.side === 'LONG' ? 'sell' : 'buy';

        await exchange.setLeverage(position.symbol, position.leverage);
        const exchangeResult = await exchange.createLimitOrder(
            position.symbol,
            closeSide,
            position.quantity,
            parseFloat(price),
            { reduceOnly: true },
        );

        // Store as pending order
        const order = await prisma.pendingOrder.create({
            data: {
                subAccountId: position.subAccountId,
                symbol: position.symbol,
                side: position.side === 'LONG' ? 'SHORT' : 'LONG',
                type: 'LIMIT',
                price: parseFloat(price),
                quantity: position.quantity,
                leverage: position.leverage,
                exchangeOrderId: exchangeResult.orderId,
                status: 'PENDING',
            },
        });

        res.status(201).json({ success: true, order });
    } catch (err) {
        console.error('[LimitClose] Failed:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/trade/validate - Validate a trade without executing
router.post('/validate', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, symbol, side, quantity, leverage } = req.body;
        const result = await riskEngine.validateTrade(
            subAccountId, symbol, side?.toUpperCase(), parseFloat(quantity), parseFloat(leverage)
        );
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/positions/:subAccountId - Open positions with live PnL
router.get('/positions/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const snapshot = await getRiskSnapshot(subAccountId);
        const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;

        if (snapshotFresh) {
            const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
            if (!account) return res.status(404).json({ error: 'Sub-account not found' });

            const rules = await riskEngine.getRules(subAccountId);
            return res.json({
                account,
                positions: snapshot.positions || [],
                summary: {
                    equity: snapshot.equity ?? account.currentBalance,
                    balance: snapshot.balance ?? account.currentBalance,
                    unrealizedPnl: snapshot.unrealizedPnl ?? 0,
                    marginUsed: snapshot.marginUsed ?? 0,
                    availableMargin: snapshot.availableMargin ?? account.currentBalance,
                    totalExposure: snapshot.totalExposure ?? 0,
                    maintenanceMargin: snapshot.maintenanceMargin ?? 0,
                    marginRatio: snapshot.marginRatio ?? 0,
                    accountLiqPrice: snapshot.accountLiqPrice ?? null,
                    positionCount: Array.isArray(snapshot.positions) ? snapshot.positions.length : 0,
                    liquidationMode: snapshot.liquidationMode || account.liquidationMode,
                },
                rules,
            });
        }

        const summary = await riskEngine.getAccountSummary(subAccountId);
        if (!summary) return res.status(404).json({ error: 'Sub-account not found' });
        return res.json(summary);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/balance/:subAccountId - Balance info
router.get('/balance/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const summary = await riskEngine.getAccountSummary(req.params.subAccountId);
        if (!summary) return res.status(404).json({ error: 'Sub-account not found' });
        res.json(summary.summary);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/history/:subAccountId - Trade history (with filters)
router.get('/history/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const { symbol, from, to, action } = req.query;

        const where = { subAccountId: req.params.subAccountId };
        if (symbol) where.symbol = symbol;
        if (action) where.action = action;
        if (from || to) {
            where.timestamp = {};
            if (from) where.timestamp.gte = new Date(from);
            if (to) where.timestamp.lte = new Date(to);
        }

        const [trades, total] = await Promise.all([
            prisma.tradeExecution.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                skip: offset,
                take: limit,
                include: { position: { select: { id: true, side: true, entryPrice: true, status: true } } },
            }),
            prisma.tradeExecution.count({ where }),
        ]);
        res.json({ trades, total, offset, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/margin/:subAccountId - Margin info for trading page
router.get('/margin/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const _t0 = Date.now();
        const subAccountId = req.params.subAccountId;

        // Fast path: use Redis snapshot if fresh (avoids slow getAccountSummary with REST prices)
        const snapshot = await getRiskSnapshot(subAccountId);
        const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;

        if (snapshotFresh) {
            const [account, rules] = await Promise.all([
                prisma.subAccount.findUnique({ where: { id: subAccountId }, select: { id: true, name: true, status: true, liquidationMode: true } }),
                riskEngine.getRules(subAccountId),
            ]);
            if (!account) return res.status(404).json({ error: 'Sub-account not found' });

            console.log(`[Perf] /trade/margin (snapshot) ${Date.now() - _t0}ms`);
            return res.json({
                account,
                equity: snapshot.equity ?? 0,
                balance: snapshot.balance ?? 0,
                unrealizedPnl: snapshot.unrealizedPnl ?? 0,
                marginUsed: snapshot.marginUsed ?? 0,
                availableMargin: snapshot.availableMargin ?? 0,
                totalExposure: snapshot.totalExposure ?? 0,
                maintenanceMargin: snapshot.maintenanceMargin ?? 0,
                marginRatio: snapshot.marginRatio ?? 0,
                accountLiqPrice: snapshot.accountLiqPrice ?? null,
                positionCount: snapshot.positionCount ?? 0,
                rules: {
                    maxNotionalPerTrade: rules.maxNotionalPerTrade,
                    maxLeverage: rules.maxLeverage,
                    maxTotalExposure: rules.maxTotalExposure,
                },
            });
        }

        // Slow path: compute from scratch
        const info = await riskEngine.getMarginInfo(subAccountId);
        if (!info) return res.status(404).json({ error: 'Sub-account not found' });
        console.log(`[Perf] /trade/margin (full) ${Date.now() - _t0}ms`);
        res.json(info);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/stats/:subAccountId - Account stats for My Account page
router.get('/stats/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        // All close trades
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
        const winRate = periods.all.count > 0 ? (periods.all.wins / periods.all.count * 100) : 0;
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
            activity: { totalTrades, totalFees, winRate, avgPnl, bestTrade, worstTrade, profitFactor },
            equityCurve: balanceLogs.map(l => ({ time: l.timestamp, value: l.balanceAfter })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/chart-data/:subAccountId - Data for chart annotations
router.get('/chart-data/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'symbol required' });

        const subAccountId = req.params.subAccountId;
        const snapshot = await getRiskSnapshot(subAccountId);
        const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;

        let positions = [];
        if (snapshotFresh && Array.isArray(snapshot.positions)) {
            positions = snapshot.positions
                .filter(p => p.symbol === symbol)
                .map(p => ({
                    id: p.id,
                    subAccountId,
                    symbol: p.symbol,
                    side: p.side,
                    entryPrice: p.entryPrice,
                    markPrice: p.markPrice,
                    quantity: p.quantity,
                    notional: p.notional,
                    leverage: p.leverage,
                    margin: p.margin,
                    liquidationPrice: p.liquidationPrice,
                    unrealizedPnl: p.unrealizedPnl,
                    pnlPercent: p.pnlPercent,
                    status: 'OPEN',
                    openedAt: p.openedAt || new Date(),
                }));
        } else {
            const summary = await riskEngine.getAccountSummary(subAccountId);
            positions = (summary?.positions || [])
                .filter(p => p.symbol === symbol)
                .map(p => ({
                    ...p,
                    subAccountId,
                    status: 'OPEN',
                }));
        }

        // Recent trades for this symbol (last 200)
        const trades = await prisma.tradeExecution.findMany({
            where: { subAccountId, symbol },
            orderBy: { timestamp: 'desc' },
            take: 200,
        });

        // Open orders for this symbol
        const openOrders = await prisma.pendingOrder.findMany({
            where: { subAccountId, symbol, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ positions, trades, openOrders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

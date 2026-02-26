/**
 * Market Orders Routes — place trades, close positions, validate, positions, history, chart-data, margin, stats.
 */
import { Router } from 'express';
import riskEngine, { prisma } from '../../risk/index.js';
import defaultExchange from '../../exchange.js';
import { fetchRawReferencePrice } from '../../exchange-public.js';
import { closePositionViaCpp, closeAllPositionsViaCpp } from './close-utils.js';
import { getRiskSnapshot } from '../../redis.js';
import { requireOwnership, requirePositionOwnership } from '../../ownership.js';
import { broadcast } from '../../ws.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { toCppSymbol } from './cpp-symbol.js';
import { makeCppClientOrderId } from './cpp-order-utils.js';
import {
    extractNotionalUsd,
    getSymbolMinNotional,
    normalizeOrderSizing,
    parsePositiveNumber,
} from './order-sizing.js';
import { persistPendingOrderWithRecovery } from './order-persistence-recovery.js';
import {
    beginIdempotentRequest,
    completeIdempotentRequest,
    releaseIdempotentRequest,
} from './submit-idempotency.js';
import { ensureSubmitPreflight } from './submit-preflight.js';

// V2: C++ engine handles all order execution. No JS fallback.


const router = Router();
let exchange = defaultExchange;

export function setMarketOrdersExchangeConnector(exchangeConnector) {
    exchange = exchangeConnector || defaultExchange;
}
const DEFAULT_CPP_MARKET_PRICE_LOOKUP_TIMEOUT_MS = 120;
const parsedPriceLookupTimeoutMs = Number.parseInt(process.env.CPP_MARKET_PRICE_LOOKUP_TIMEOUT_MS || `${DEFAULT_CPP_MARKET_PRICE_LOOKUP_TIMEOUT_MS}`, 10);
const CPP_MARKET_PRICE_LOOKUP_TIMEOUT_MS = Number.isFinite(parsedPriceLookupTimeoutMs) && parsedPriceLookupTimeoutMs > 0
    ? parsedPriceLookupTimeoutMs
    : DEFAULT_CPP_MARKET_PRICE_LOOKUP_TIMEOUT_MS;
const LOG_TRADE_ROUTE_PERF = process.env.LOG_TRADE_ROUTE_PERF === '1';

function allowHttpPriceLookup() {
    return process.env.CPP_MARKET_ALLOW_HTTP_PRICE_LOOKUP !== '0';
}

async function fetchBinanceReferencePrice(rawSymbol) {
    return fetchRawReferencePrice(rawSymbol, { timeoutMs: CPP_MARKET_PRICE_LOOKUP_TIMEOUT_MS });
}

// POST /api/trade - Place a new trade
router.post('/', requireOwnership('body'), async (req, res) => {
    let idem = null;
    try {
        const startedAt = Date.now();
        const {
            subAccountId,
            symbol,
            side,
            quantity,
            leverage,
            fastExecution,
            fallbackPrice,
            babysitterExcluded,
            reduceOnly,
        } = req.body;
        const requestedNotionalUsd = extractNotionalUsd(req.body);

        if (!subAccountId || !symbol || !side || !leverage || (!quantity && !requestedNotionalUsd)) {
            return res.status(400).json({
                error: 'Missing required fields: subAccountId, symbol, side, leverage, and quantity or notionalUsd',
            });
        }

        const validSides = ['LONG', 'SHORT'];
        if (!validSides.includes(side.toUpperCase())) {
            return res.status(400).json({ error: 'side must be LONG or SHORT' });
        }

        let sizing;
        try {
            sizing = await normalizeOrderSizing({
                symbol,
                side,
                quantity,
                fallbackPrice,
                notionalUsd: requestedNotionalUsd,
                payload: req.body,
                quantityPrecisionMode: 'nearest',
                pricePrecisionMode: 'nearest',
                allowPriceLookup: true,
                exchangeConnector: exchange,
            });
        } catch (sizingErr) {
            return res.status(400).json({ error: sizingErr.message });
        }
        const normalizedSymbol = sizing.symbol;
        const normalizedQty = sizing.quantity;

        const parsedFallbackPrice = parsePositiveNumber(fallbackPrice) || parsePositiveNumber(sizing.referencePrice);
        const normalizedFallbackPrice = parsedFallbackPrice
            ? Number.parseFloat(exchange.priceToPrecisionCached(normalizedSymbol, parsedFallbackPrice, { mode: 'nearest' }))
            : undefined;

        // ── V2: C++ Engine Write Path (ACK-first) ────────────────────────────
        idem = await beginIdempotentRequest(req, 'trade:market');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }

        try {
            const bridge = await ensureSubmitPreflight({
                getBridge: getSimplxBridge,
                subAccountId,
                sync: true,
            });

            const cppSide = side.toUpperCase() === 'LONG' ? 'BUY' : 'SELL';
            const rawSymbol = toCppSymbol(normalizedSymbol);
            const parsedLev = parseFloat(leverage);

            // C++ risk validation expects a reference price even for MARKET orders
            let commandPrice = normalizedFallbackPrice;
            if (!commandPrice) {
                const livePrice = exchange.getLatestPrice(normalizedSymbol);
                if (Number.isFinite(livePrice) && livePrice > 0) commandPrice = livePrice;
            }
            if (!commandPrice) {
                if (allowHttpPriceLookup()) {
                    const fetched = await fetchBinanceReferencePrice(rawSymbol);
                    if (fetched) commandPrice = fetched;
                }
            }
            if (commandPrice) {
                try { commandPrice = Number.parseFloat(exchange.priceToPrecisionCached(normalizedSymbol, commandPrice, { mode: 'nearest' })); } catch { /* best-effort */ }
            }

            const minNotional = reduceOnly ? 0 : getSymbolMinNotional(normalizedSymbol, exchange);
            if (minNotional > 0) {
                const notionalRefPrice = parsePositiveNumber(commandPrice)
                    || parsePositiveNumber(sizing.referencePrice)
                    || parsePositiveNumber(normalizedFallbackPrice);
                if (notionalRefPrice) {
                    const estimatedNotional = normalizedQty * notionalRefPrice;
                    if ((estimatedNotional + 1e-9) < minNotional) {
                        return res.status(400).json({
                            error: `Order notional too small for ${normalizedSymbol}: ${estimatedNotional.toFixed(4)} < min ${minNotional}`,
                            errors: [{
                                code: 'EXCHANGE_MIN_NOTIONAL',
                                message: `Order notional too small for ${normalizedSymbol}: ${estimatedNotional.toFixed(4)} < min ${minNotional}. Increase size or use reduce-only.`,
                            }],
                        });
                    }
                }
            }

            const clientOrderId = makeCppClientOrderId('mkt', subAccountId);
            const requestId = await bridge.sendCommand('new', {
                sub_account_id: subAccountId,
                client_order_id: clientOrderId,
                symbol: rawSymbol,
                side: cppSide,
                type: 'MARKET',
                qty: normalizedQty,
                leverage: parsedLev,
                ...(commandPrice ? { price: commandPrice } : {}),
                ...(reduceOnly ? { reduce_only: true } : {}),
            });

            const serverLatencyMs = Date.now() - startedAt;
            res.set('X-Server-Latency-Ms', String(serverLatencyMs));
            res.set('X-Source', 'cpp-engine');
            const responseBody = {
                success: true, accepted: true, source: 'cpp-engine',
                serverLatencyMs, requestId, clientOrderId, status: 'QUEUED',
                persistencePending: false,
            };
            await completeIdempotentRequest(idem, { statusCode: 202, body: responseBody });
            return res.status(202).json(responseBody);
        } catch (cppErr) {
            await releaseIdempotentRequest(idem);
            console.error(`[Trade] C++ submit failed: ${cppErr.message}`);
            return res.status(502).json({ success: false, error: `C++ submit failed: ${cppErr.message}` });
        }
    } catch (err) {
        await releaseIdempotentRequest(idem);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/close/:positionId - Close a position
router.post('/close/:positionId', requirePositionOwnership(), async (req, res) => {
    let idem = null;
    try {
        idem = await beginIdempotentRequest(req, 'trade:close');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }
        const result = await closePositionViaCpp(req.params.positionId, 'CLOSE');
        const responseBody = {
            ...result,
            source: 'cpp-engine',
            status: result?.status || 'QUEUED',
            persistencePending: false,
        };
        await completeIdempotentRequest(idem, { statusCode: 202, body: responseBody });
        res.status(202).json(responseBody);
    } catch (err) {
        await releaseIdempotentRequest(idem);
        res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
    }
});

// POST /api/trade/close-all/:subAccountId - Close all open positions
router.post('/close-all/:subAccountId', requireOwnership(), async (req, res) => {
    let idem = null;
    try {
        idem = await beginIdempotentRequest(req, 'trade:close-all');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }
        const result = await closeAllPositionsViaCpp(req.params.subAccountId, 'CLOSE');
        const responseBody = {
            ...result,
            source: 'cpp-engine',
            status: 'QUEUED',
            accepted: true,
            persistencePending: false,
        };
        await completeIdempotentRequest(idem, { statusCode: 200, body: responseBody });
        res.json(responseBody);
    } catch (err) {
        await releaseIdempotentRequest(idem);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/trade/limit-close/:positionId - Place reduce-only limit close
router.post('/limit-close/:positionId', requirePositionOwnership(), async (req, res) => {
    let idem = null;
    try {
        const { price } = req.body;
        const requestedPrice = parsePositiveNumber(price);
        if (!requestedPrice) return res.status(400).json({ error: 'price is required and must be positive' });

        const position = await prisma.virtualPosition.findUnique({ where: { id: req.params.positionId } });
        if (!position) return res.status(404).json({ error: 'Position not found' });
        if (position.status !== 'OPEN') return res.status(400).json({ error: 'Position is not open' });

        // ── Exchange sync guard ──────────────────────────────────────────────
        // Before placing a reduce-only limit order, verify a real exchange position
        // exists with the same side. A desynced position would create a bad order.
        try {
            const bridge = getSimplxBridge();
            let exchangePositions = [];

            if (bridge && typeof bridge.getExchangePositionsSnapshot === 'function') {
                const maxAgeMsRaw = Number.parseInt(process.env.CPP_EXCHANGE_POSITION_CACHE_MAX_AGE_MS || '7000', 10);
                const maxAgeMs = Number.isFinite(maxAgeMsRaw) && maxAgeMsRaw > 0 ? maxAgeMsRaw : 7000;
                let snap = bridge.getExchangePositionsSnapshot(maxAgeMs);

                if (!snap.fresh && typeof bridge.syncExchangePositions === 'function') {
                    await bridge.syncExchangePositions({ reason: 'limit_close', force: true });
                    snap = bridge.getExchangePositionsSnapshot(maxAgeMs);
                }
                exchangePositions = snap.positions || [];
            }

            if (!exchangePositions.length) {
                exchangePositions = await exchange.fetchPositions();
            }

            const positionSymbol = toCppSymbol(position.symbol);
            const exchangePos = exchangePositions.find((p) => toCppSymbol(p.symbol) === positionSymbol);
            const exSideRaw = String(exchangePos?.side || '').toUpperCase();
            const exSide = exSideRaw === 'LONG' || exSideRaw === 'BUY'
                ? 'long'
                : (exSideRaw === 'SHORT' || exSideRaw === 'SELL' ? 'short' : '');
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

        idem = await beginIdempotentRequest(req, 'trade:limit-close');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }

        const bridge = await ensureSubmitPreflight({
            getBridge: getSimplxBridge,
            subAccountId: position.subAccountId,
            sync: true,
        });

        const normalizedPrice = Number.parseFloat(
            exchange.priceToPrecisionCached(position.symbol, requestedPrice, { mode: 'nearest' }),
        );
        if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
            return res.status(400).json({ error: `Invalid limit close price: ${price}` });
        }

        const clientOrderId = makeCppClientOrderId('lmt', position.subAccountId);
        const requestId = await bridge.sendCommand('new', {
            sub_account_id: position.subAccountId,
            client_order_id: clientOrderId,
            symbol: toCppSymbol(position.symbol),
            side: position.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'LIMIT',
            qty: position.quantity,
            price: normalizedPrice,
            leverage: position.leverage || 20,
            reduce_only: true,
        });

        // Store as pending order (best effort after C++ ACK)
        const persisted = await persistPendingOrderWithRecovery({
            subAccountId: position.subAccountId,
            symbol: position.symbol,
            side: position.side === 'LONG' ? 'SHORT' : 'LONG',
            type: 'LIMIT',
            price: normalizedPrice,
            quantity: position.quantity,
            leverage: position.leverage,
            exchangeOrderId: clientOrderId,
            status: 'PENDING',
        }, 'LimitClose', { route: 'limit-close', requestId, clientOrderId, positionId: position.id });

        res.set('X-Source', 'cpp-engine');
        if (persisted.persistencePending) {
            res.set('X-Persistence-Pending', '1');
        }
        const responseBody = {
            success: true,
            accepted: true,
            source: 'cpp-engine',
            requestId,
            clientOrderId,
            status: persisted.persistencePending ? 'accepted_but_persist_pending' : 'QUEUED',
            persistencePending: persisted.persistencePending,
            persistenceError: persisted.persistencePending ? persisted.persistenceError : undefined,
            recoveryQueue: persisted.persistencePending ? persisted.recoveryQueue : undefined,
            order: persisted.order,
        };
        await completeIdempotentRequest(idem, { statusCode: 202, body: responseBody });
        res.status(202).json(responseBody);
    } catch (err) {
        await releaseIdempotentRequest(idem);
        console.error('[LimitClose] Failed:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/trade/validate - Validate a trade without executing
router.post('/validate', requireOwnership('body'), async (req, res) => {
    try {
        const { subAccountId, symbol, side, quantity, leverage, price, fallbackPrice } = req.body;
        const requestedNotionalUsd = extractNotionalUsd(req.body);
        if (!subAccountId || !symbol || !side || !leverage || (!quantity && !requestedNotionalUsd)) {
            return res.status(400).json({
                error: 'Missing required fields: subAccountId, symbol, side, leverage, and quantity or notionalUsd',
            });
        }
        let sizing;
        try {
            sizing = await normalizeOrderSizing({
                symbol,
                side,
                quantity,
                price,
                fallbackPrice,
                notionalUsd: requestedNotionalUsd,
                payload: req.body,
                quantityPrecisionMode: 'nearest',
                pricePrecisionMode: 'nearest',
                allowPriceLookup: true,
                exchangeConnector: exchange,
            });
        } catch (sizingErr) {
            return res.status(400).json({ error: sizingErr.message });
        }
        const result = await riskEngine.validateTrade(
            subAccountId,
            sizing.symbol,
            side?.toUpperCase(),
            sizing.quantity,
            parseFloat(leverage),
        );
        res.json({
            ...result,
            sizing: {
                symbol: sizing.symbol,
                quantity: sizing.quantity,
                requestedNotionalUsd: sizing.requestedNotionalUsd,
                referencePrice: sizing.referencePrice,
                priceSource: sizing.priceSource,
                derivedFromNotional: sizing.derivedFromNotional,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/positions/:subAccountId - Open positions with live PnL
router.get('/positions/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;

        // Phase 3: C++ SnapshotCache removed — positions served from Redis snapshot
        // or riskEngine.getAccountSummary (event-sourced, always fresh)

        const snapshot = await getRiskSnapshot(subAccountId);
        const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;

        if (snapshotFresh) {
            const [account, rules] = await Promise.all([
                prisma.subAccount.findUnique({ where: { id: subAccountId } }),
                riskEngine.getRules(subAccountId),
            ]);
            if (!account) return res.status(404).json({ error: 'Sub-account not found' });
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
        const { symbol, from, to, action, cursor } = req.query;

        const where = { subAccountId: req.params.subAccountId };
        if (symbol) where.symbol = symbol;
        if (action) where.action = action;
        if (from || to) {
            where.timestamp = {};
            if (from) where.timestamp.gte = new Date(from);
            if (to) where.timestamp.lte = new Date(to);
        }
        // Cursor-based pagination: fetch records older than the cursor ID
        if (cursor) {
            where.id = { lt: cursor };
        }

        const take = Math.min(limit, 1000);
        const [trades, total] = await Promise.all([
            prisma.tradeExecution.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                take,
                include: { position: { select: { id: true, side: true, entryPrice: true, status: true } } },
            }),
            prisma.tradeExecution.count({ where }),
        ]);

        const nextCursor = trades.length === take && trades.length > 0
            ? trades[trades.length - 1].id
            : null;

        res.json({ trades, total, count: trades.length, hasMore: trades.length === take, nextCursor, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/margin/:subAccountId - Margin info for trading page
router.get('/margin/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const _t0 = Date.now();
        const subAccountId = req.params.subAccountId;

        // Phase 3: C++ SnapshotCache removed — margin served from Redis snapshot
        // or riskEngine.getMarginInfo (event-sourced, always fresh)

        // Fast path: use Redis snapshot if fresh (avoids slow getMarginInfo with REST prices)
        const snapshot = await getRiskSnapshot(subAccountId);
        const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;

        if (snapshotFresh) {
            const [account, rules] = await Promise.all([
                prisma.subAccount.findUnique({ where: { id: subAccountId }, select: { id: true, name: true, status: true, liquidationMode: true } }),
                riskEngine.getRules(subAccountId),
            ]);
            if (!account) return res.status(404).json({ error: 'Sub-account not found' });

            if (LOG_TRADE_ROUTE_PERF) console.log(`[Perf] /trade/margin (snapshot) ${Date.now() - _t0}ms`);
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
        if (LOG_TRADE_ROUTE_PERF) console.log(`[Perf] /trade/margin (full) ${Date.now() - _t0}ms`);
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

// POST /api/trade/positions/:subAccountId/refresh - Force-sync virtual positions with exchange
router.post('/positions/:subAccountId/refresh', requireOwnership(), async (req, res) => {
    try {
        const subAccountId = req.params.subAccountId;
        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return res.status(404).json({ error: 'Sub-account not found' });

        // Fetch real positions from exchange
        const exchangePositions = await exchange.fetchPositions();
        const realPositions = exchangePositions.filter(p => {
            const amt = Math.abs(parseFloat(p.contracts || p.contractSize || 0));
            return amt > 0;
        });

        // Fetch virtual positions from DB
        const virtualPositions = await prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });

        const syncResults = { created: 0, closed: 0, updated: 0, unchanged: 0 };

        // Check for orphaned virtual positions (exist virtually but not on exchange)
        const exchangeSymbols = new Set(realPositions.map(p => p.symbol));
        for (const vp of virtualPositions) {
            if (!exchangeSymbols.has(vp.symbol)) {
                // Orphaned — close it virtually at latest known price
                try {
                    await closePositionViaCpp(vp.id, 'ORPHAN_RECONCILE');
                    syncResults.closed++;
                } catch (err) {
                    console.warn(`[Refresh] Failed to reconcile orphaned position ${vp.symbol}:`, err.message);
                }
            }
        }

        // Mark positions dirty so the risk engine reloads
        riskEngine.markPositionsDirty();

        // Return fresh data
        const summary = await riskEngine.getAccountSummary(subAccountId);
        res.json({
            syncResults,
            ...(summary || {}),
        });
    } catch (err) {
        console.error('[Refresh] Position refresh failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;

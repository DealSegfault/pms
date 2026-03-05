/**
 * Binance FAPI-compatible REST proxy.
 *
 * Allows bots (like v7 BinanceExecutor) to point their fapi_base at PMS.
 * PMS intercepts orders to: tag with sub-account, run risk checks, record,
 * then forward to Binance. Responses look identical to Binance FAPI.
 *
 * Auth: X-PMS-Key header or X-PMS-SubAccount header
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { botApiKeyMiddleware } from '../auth.js';
import { getRoutingPrefix, tagClientOrderId } from '../routing-prefix.js';
import {
    buildOrderIntentLifecycleEvent,
    buildOrderRejectedLifecycleEvent,
    LIFECYCLE_STREAM_EVENTS,
    publishLifecycleEvent,
} from '../lifecycle-stream.js';
import {
    setOrderMapping, getOrderMapping, checkRateLimit,
    getRiskSnapshot, getPriceCache,
} from '../redis.js';
import { proxyFailureResponse } from '../http/api-taxonomy.js';

const router = Router();

// The actual exchange instance (set via init)
let exchange = null;
let riskEngine = null;

export function initProxy(exchangeModule, riskEngineModule) {
    exchange = exchangeModule;
    riskEngine = riskEngineModule;
}

function computeReservedMargin(totalNotional, leverageCap = 100) {
    const cap = Number(leverageCap) > 0 ? Number(leverageCap) : 1;
    return totalNotional / cap;
}

function sendProxyFailure(res, errorLike, options = {}) {
    const failure = proxyFailureResponse(errorLike, options);
    return res.status(failure.status).json(failure.body);
}

function spreadBps(bid, ask, mid) {
    if (!(bid > 0) || !(ask > 0) || !(mid > 0)) return null;
    return ((ask - bid) / mid) * 10000;
}

async function getDecisionContext(symbol) {
    const snapshot = await getPriceCache(symbol);
    const bid = Number(snapshot?.bid);
    const ask = Number(snapshot?.ask);
    const mid = Number(snapshot?.mid);
    if (!(bid > 0) || !(ask > 0) || !(mid > 0)) {
        return {
            decisionBid: null,
            decisionAsk: null,
            decisionMid: null,
            decisionSpreadBps: null,
        };
    }
    return {
        decisionBid: bid,
        decisionAsk: ask,
        decisionMid: mid,
        decisionSpreadBps: spreadBps(bid, ask, mid),
    };
}

// ── Middleware: resolve sub-account from API key user ──

async function resolveSubAccount(req, res, next) {
    const subAccountId = req.headers['x-pms-subaccount'];
    if (subAccountId) {
        // Verify ownership
        const sa = await prisma.subAccount.findFirst({
            where: { id: subAccountId, userId: req.user.id },
        });
        if (!sa) return sendProxyFailure(res, { message: 'Sub-account not found or not owned by you' });
        if (sa.status !== 'ACTIVE') return sendProxyFailure(res, { message: 'Sub-account is not active' });
        req.subAccount = sa;
        return next();
    }

    // Auto-select: find the user's first active sub-account
    const sa = await prisma.subAccount.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
    });
    if (!sa) return sendProxyFailure(res, { message: 'No active sub-account. Create one first.' });
    req.subAccount = sa;
    next();
}

/**
 * Convert raw Binance symbol (BTCUSDT) to ccxt format (BTC/USDT:USDT)
 */
function rawToCcxt(rawSymbol) {
    // Simple heuristic: if it ends with USDT, split before USDT
    if (rawSymbol.endsWith('USDT')) {
        const base = rawSymbol.slice(0, -4);
        return `${base}/USDT:USDT`;
    }
    return rawSymbol;
}

// ── POST /fapi/v1/order — Place Order ──

router.post('/v1/order',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        let intentEvent = null;
        try {
            const { symbol, side, type, quantity, price, timeInForce, newClientOrderId, reduceOnly } = req.body;

            if (!symbol || !side || !type) {
                return sendProxyFailure(res, { message: 'Missing required parameters' }, { fallbackBinanceCode: -1100 });
            }

            // Rate limit
            const allowed = await checkRateLimit(req.subAccount.id);
            if (!allowed) {
                return sendProxyFailure(res, { message: 'Rate limit exceeded', code: -1015 }, { fallbackBinanceCode: -1015 });
            }

            const qty = parseFloat(quantity);
            const prc = price ? parseFloat(price) : null;
            const ccxtSymbol = rawToCcxt(symbol);
            const normalizedType = type?.toUpperCase();
            const taggedClientId = tagClientOrderId(req.subAccount, normalizedType, newClientOrderId);
            const decisionContext = await getDecisionContext(symbol);

            // If not reduceOnly, run risk checks
            if (!reduceOnly) {
                if (!riskEngine) {
                    // Python handles risk — skip JS-side validation
                } else {
                    // Infer leverage from existing rules or use 1
                    const rules = await riskEngine.getEffectiveRules(req.subAccount.id);
                    const leverage = rules.maxLeverage || 1;

                    // Get current price for notional calc
                    let markPrice = prc;
                    if (!markPrice) {
                        try {
                            const ticker = await exchange.fetchTicker(ccxtSymbol);
                            markPrice = ticker?.mark || ticker?.last;
                        } catch { }
                    }

                    if (markPrice) {
                        const notional = qty * markPrice;
                        const validation = await riskEngine.validateTrade(
                            req.subAccount.id, ccxtSymbol, side.toUpperCase(), qty, leverage,
                        );
                        if (!validation.valid) {
                            return sendProxyFailure(
                                res,
                                { message: `Risk check failed: ${validation.errors.join(', ')}`, code: -2027 },
                                { fallbackBinanceCode: -2027 },
                            );
                        }
                    }
                }
            }

            // Forward to Binance via ccxt
            intentEvent = buildOrderIntentLifecycleEvent({
                subAccount: req.subAccount,
                clientOrderId: taggedClientId,
                symbol,
                side: side.toUpperCase(),
                orderType: normalizedType,
                quantity: qty,
                price: prc,
                reduceOnly: Boolean(reduceOnly),
                origin: 'BOT',
                userId: req.user?.id || '',
                ...decisionContext,
            });
            await publishLifecycleEvent(LIFECYCLE_STREAM_EVENTS.ORDER_INTENT, intentEvent);

            const orderType = type.toLowerCase();
            const orderSide = side.toLowerCase();
            const params = {};
            if (timeInForce) params.timeInForce = timeInForce;
            if (reduceOnly) params.reduceOnly = true;
            if (taggedClientId) params.clientOrderId = taggedClientId;

            const ccxtOrder = await exchange.exchange.createOrder(
                ccxtSymbol, orderType, orderSide, qty, prc, params,
            );

            // Store order mapping in Redis
            const exchangeOrderId = String(ccxtOrder.id);
            await setOrderMapping(exchangeOrderId, {
                subAccountId: req.subAccount.id,
                routingPrefix: getRoutingPrefix(req.subAccount),
                clientOrderId: taggedClientId,
                symbol: ccxtSymbol,
                side: side.toUpperCase(),
                userId: req.user.id,
                ts: Date.now(),
            });

            const responseStatus = ccxtOrder.status?.toUpperCase() || 'NEW';
            if (responseStatus === 'REJECTED') {
                await publishLifecycleEvent(
                    LIFECYCLE_STREAM_EVENTS.ORDER_REJECTED,
                    buildOrderRejectedLifecycleEvent(intentEvent, 'Exchange rejected order'),
                );
            }

            // Return Binance-compatible response
            res.json({
                orderId: parseInt(exchangeOrderId) || exchangeOrderId,
                symbol,
                clientOrderId: taggedClientId,
                status: responseStatus,
                origQty: String(qty),
                executedQty: String(ccxtOrder.filled || 0),
                avgPrice: String(ccxtOrder.average || 0),
                type: type.toUpperCase(),
                side: side.toUpperCase(),
                timeInForce: timeInForce || 'GTC',
                updateTime: Date.now(),
            });

        } catch (err) {
            if (intentEvent) {
                await publishLifecycleEvent(
                    LIFECYCLE_STREAM_EVENTS.ORDER_REJECTED,
                    buildOrderRejectedLifecycleEvent(intentEvent, err.message),
                );
            }
            console.error('[Proxy] Order error:', err.message);
            sendProxyFailure(res, err, { fallbackBinanceCode: -1 });
        }
    },
);

// ── DELETE /fapi/v1/order — Cancel Order ──

router.delete('/v1/order',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        try {
            const { symbol, orderId } = req.query;
            if (!symbol || !orderId) {
                return sendProxyFailure(res, { message: 'symbol and orderId required' }, { fallbackBinanceCode: -1100 });
            }

            // Verify ownership via Redis mapping
            const mapping = await getOrderMapping(orderId);
            if (mapping && mapping.subAccountId !== req.subAccount.id) {
                return sendProxyFailure(res, { message: 'Order not owned by this sub-account' });
            }

            const ccxtSymbol = rawToCcxt(symbol);
            await exchange.exchange.cancelOrder(orderId, ccxtSymbol);

            res.json({ orderId, symbol, status: 'CANCELED' });
        } catch (err) {
            sendProxyFailure(res, err, { fallbackBinanceCode: -1 });
        }
    },
);

// ── PUT /fapi/v1/order — Amend Order ──

router.put('/v1/order',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        try {
            const { symbol, orderId, quantity, price, side } = req.body;
            if (!symbol || !orderId) {
                return sendProxyFailure(res, { message: 'symbol and orderId required' }, { fallbackBinanceCode: -1100 });
            }

            const mapping = await getOrderMapping(orderId);
            if (mapping && mapping.subAccountId !== req.subAccount.id) {
                return sendProxyFailure(res, { message: 'Order not owned by this sub-account' });
            }

            const ccxtSymbol = rawToCcxt(symbol);
            const qty = parseFloat(quantity);
            const prc = parseFloat(price);

            const order = await exchange.exchange.editOrder(
                orderId, ccxtSymbol, 'limit', side?.toLowerCase() || 'sell', qty, prc,
            );

            res.json({
                orderId: order.id,
                symbol,
                status: order.status?.toUpperCase() || 'NEW',
                origQty: String(qty),
                price: String(prc),
            });
        } catch (err) {
            sendProxyFailure(res, err, { fallbackBinanceCode: -1 });
        }
    },
);

// ── GET /fapi/v1/allOrders — Segregated Order History ──

router.get('/v1/allOrders',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        try {
            const { symbol, limit = 500, startTime, endTime } = req.query;

            const where = { subAccountId: req.subAccount.id };
            if (symbol) where.symbol = rawToCcxt(symbol);

            const filters = {};
            if (startTime) filters.gte = new Date(parseInt(startTime));
            if (endTime) filters.lte = new Date(parseInt(endTime));
            if (Object.keys(filters).length > 0) where.timestamp = filters;

            const trades = await prisma.tradeExecution.findMany({
                where,
                take: parseInt(limit),
                orderBy: { timestamp: 'desc' },
            });

            // Return Binance-compatible format
            res.json(trades.map(t => ({
                orderId: t.exchangeOrderId,
                symbol: t.symbol,
                clientOrderId: t.clientOrderId,
                status: t.status,
                origQty: String(t.quantity),
                executedQty: String(t.quantity),
                avgPrice: String(t.price),
                type: t.type,
                side: t.side,
                time: t.timestamp.getTime(),
                updateTime: t.timestamp.getTime(),
            })));
        } catch (err) {
            res.status(500).json({ code: -1, msg: err.message });
        }
    },
);

// ── GET /fapi/v2/positionRisk — Segregated Positions ──

router.get('/v2/positionRisk',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        try {
            const subAccountId = req.subAccount.id;
            const snapshot = await getRiskSnapshot(subAccountId);
            const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;
            let positions = [];

            if (snapshotFresh && Array.isArray(snapshot.positions)) {
                positions = snapshot.positions;
            } else {
                // Try Redis snapshot first (from Python), fallback to riskEngine
                const riskSnap = await getRiskSnapshot(subAccountId);
                if (riskSnap) {
                    positions = riskSnap.positions || [];
                } else if (riskEngine) {
                    const summary = await riskEngine.getAccountSummary(subAccountId);
                    positions = summary?.positions || [];
                }
            }

            // Return Binance-compatible format
            res.json(positions.map(p => ({
                symbol: p.symbol.replace('/', '').replace(':USDT', ''),
                positionSide: 'BOTH',
                positionAmt: String(p.side === 'LONG' ? p.quantity : -p.quantity),
                entryPrice: String(p.entryPrice),
                markPrice: String(p.markPrice ?? p.entryPrice ?? 0),
                unRealizedProfit: String(p.unrealizedPnl ?? 0),
                liquidationPrice: String(p.liquidationPrice ?? 0),
                leverage: String(p.leverage),
                notional: String(p.notional),
                marginType: 'cross',
                isolatedMargin: '0',
                updateTime: p.openedAt ? new Date(p.openedAt).getTime() : Date.now(),
            })));
        } catch (err) {
            res.status(500).json({ code: -1, msg: err.message });
        }
    },
);

// ── GET /fapi/v2/balance — Virtual Balance ──

router.get('/v2/balance',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        try {
            const sa = req.subAccount;
            const snapshot = await getRiskSnapshot(sa.id);
            const snapshotFresh = snapshot?.timestamp && (Date.now() - snapshot.timestamp) < 15_000;

            let marginUsed = 0;
            let available = sa.currentBalance;
            if (snapshotFresh) {
                marginUsed = snapshot.marginUsed || 0;
                available = Math.max(0, snapshot.availableMargin ?? available);
            } else {
                // Fallback to DB-only estimate
                const [positions, rule] = await Promise.all([
                    prisma.virtualPosition.findMany({
                        where: { subAccountId: sa.id, status: 'OPEN' },
                    }),
                    prisma.riskRule.findFirst({ where: { subAccountId: sa.id } }),
                ]);
                const totalExposure = positions.reduce((s, p) => s + (p.notional || 0), 0);
                marginUsed = computeReservedMargin(totalExposure, rule?.maxLeverage || 100);
                available = Math.max(0, sa.currentBalance - marginUsed);
            }

            res.json([{
                accountAlias: sa.name,
                asset: 'USDT',
                balance: String(sa.currentBalance),
                crossWalletBalance: String(sa.currentBalance),
                availableBalance: String(available),
                maxWithdrawAmount: String(available),
                marginAvailable: true,
                updateTime: Date.now(),
            }]);
        } catch (err) {
            res.status(500).json({ code: -1, msg: err.message });
        }
    },
);

// ── GET /fapi/v1/exchangeInfo — Passthrough ──

router.get('/v1/exchangeInfo', async (req, res) => {
    try {
        // Just return market data from ccxt
        const markets = exchange?.markets || {};
        if (!Object.keys(markets).length) {
            return res.json({ symbols: [] });
        }
        const symbols = Object.values(markets)
            .filter(m => m.linear && m.active)
            .slice(0, 100)
            .map(m => ({
                symbol: m.id,
                status: 'TRADING',
                baseAsset: m.base,
                quoteAsset: m.quote,
                pricePrecision: m.precision?.price || 2,
                quantityPrecision: m.precision?.amount || 3,
            }));

        res.json({ symbols });
    } catch (err) {
        res.status(500).json({ code: -1, msg: err.message });
    }
});

// ── POST /fapi/v1/listenKey — Create user stream listen key ──
// Returns a PMS listen key that maps to the user's sub-account.
// Bot connects to ws://pms-host/ws and subscribes with this key.

router.post('/v1/listenKey',
    botApiKeyMiddleware(),
    resolveSubAccount,
    async (req, res) => {
        try {
            const listenKey = crypto.randomBytes(30).toString('hex'); // 60 chars
            const mapping = JSON.stringify({
                userId: req.user.id,
                subAccountId: req.subAccount.id,
                createdAt: Date.now(),
            });

            // Store in Redis with 60-min TTL (matches Binance behavior)
            const { getRedis } = await import('../redis.js');
            const redis = getRedis();
            if (redis) {
                await redis.set(`pms:listen_key:${listenKey}`, mapping, 'EX', 3600);
            }

            res.json({ listenKey });
        } catch (err) {
            res.status(500).json({ code: -1, msg: err.message });
        }
    },
);

router.put('/v1/listenKey', botApiKeyMiddleware(), async (req, res) => {
    // Keepalive — extend TTL by 60 minutes
    try {
        const { listenKey } = req.body;
        if (listenKey) {
            const { getRedis } = await import('../redis.js');
            const redis = getRedis();
            if (redis) {
                await redis.expire(`pms:listen_key:${listenKey}`, 3600);
            }
        }
    } catch { /* non-critical */ }
    res.json({});
});

router.delete('/v1/listenKey', botApiKeyMiddleware(), async (req, res) => {
    try {
        const { listenKey } = req.body;
        if (listenKey) {
            const { getRedis } = await import('../redis.js');
            const redis = getRedis();
            if (redis) {
                await redis.del(`pms:listen_key:${listenKey}`);
            }
        }
    } catch { /* non-critical */ }
    res.json({});
});

export default router;

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
import crypto from 'crypto';
import { botApiKeyMiddleware } from '../auth.js';
import {
    setOrderMapping, getOrderMapping, checkRateLimit,
    getRiskSnapshot,
} from '../redis.js';

const router = Router();

// The actual exchange instance (set via init)
let exchange = null;
let riskEngine = null;

export function initProxy(exchangeModule, riskEngineModule) {
    exchange = exchangeModule;
    riskEngine = riskEngineModule;
}

// ── Middleware: resolve sub-account from API key user ──

async function resolveSubAccount(req, res, next) {
    const subAccountId = req.headers['x-pms-subaccount'];
    if (subAccountId) {
        // Verify ownership
        const sa = await prisma.subAccount.findFirst({
            where: { id: subAccountId, userId: req.user.id },
        });
        if (!sa) return res.status(403).json({ code: -1, msg: 'Sub-account not found or not owned by you' });
        if (sa.status !== 'ACTIVE') return res.status(403).json({ code: -1, msg: 'Sub-account is not active' });
        req.subAccount = sa;
        return next();
    }

    // Auto-select: find the user's first active sub-account
    const sa = await prisma.subAccount.findFirst({
        where: { userId: req.user.id, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
    });
    if (!sa) return res.status(403).json({ code: -1, msg: 'No active sub-account. Create one first.' });
    req.subAccount = sa;
    next();
}

// ── Helper: generate PMS-tagged clientOrderId ──

function tagClientOrderId(subAccountId, originalId) {
    const prefix = subAccountId.substring(0, 8);
    const id = originalId || crypto.randomBytes(8).toString('hex');
    return `PMS${prefix}_${id}`;
}

function parseClientOrderId(clientOrderId) {
    if (!clientOrderId?.startsWith('PMS')) return null;
    const parts = clientOrderId.split('_');
    if (parts.length < 2) return null;
    return {
        subAccountPrefix: parts[0].substring(3), // 8-char sub-account prefix
        originalId: parts.slice(1).join('_'),
    };
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
        try {
            const { symbol, side, type, quantity, price, timeInForce, newClientOrderId, reduceOnly } = req.body;

            if (!symbol || !side || !type) {
                return res.status(400).json({ code: -1100, msg: 'Missing required parameters' });
            }

            // Rate limit
            const allowed = await checkRateLimit(req.subAccount.id);
            if (!allowed) {
                return res.status(429).json({ code: -1015, msg: 'Rate limit exceeded' });
            }

            const qty = parseFloat(quantity);
            const prc = price ? parseFloat(price) : null;
            const ccxtSymbol = rawToCcxt(symbol);
            const taggedClientId = tagClientOrderId(req.subAccount.id, newClientOrderId);

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
                            return res.status(400).json({
                                code: -2027,
                                msg: `Risk check failed: ${validation.errors.join(', ')}`,
                            });
                        }
                    }
                }
            }

            // Forward to Binance via ccxt
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
                clientOrderId: taggedClientId,
                symbol: ccxtSymbol,
                side: side.toUpperCase(),
                userId: req.user.id,
                ts: Date.now(),
            });

            // Also record in PMS DB
            const sig = crypto.createHash('sha256')
                .update(`${req.subAccount.id}:${exchangeOrderId}:${Date.now()}`)
                .digest('hex').substring(0, 16);

            await prisma.tradeExecution.create({
                data: {
                    subAccountId: req.subAccount.id,
                    exchangeOrderId,
                    clientOrderId: taggedClientId,
                    symbol: ccxtSymbol,
                    side: side.toUpperCase(),
                    type: type.toUpperCase(),
                    price: ccxtOrder.average || ccxtOrder.price || prc || 0,
                    quantity: ccxtOrder.filled || qty,
                    notional: (ccxtOrder.average || prc || 0) * (ccxtOrder.filled || qty),
                    fee: ccxtOrder.fee?.cost || 0,
                    action: reduceOnly ? 'CLOSE' : 'OPEN',
                    originType: 'BOT',
                    status: ccxtOrder.status === 'closed' ? 'FILLED' : ccxtOrder.status?.toUpperCase() || 'PENDING',
                    signature: sig,
                },
            });

            // Return Binance-compatible response
            res.json({
                orderId: parseInt(exchangeOrderId) || exchangeOrderId,
                symbol,
                clientOrderId: taggedClientId,
                status: ccxtOrder.status?.toUpperCase() || 'NEW',
                origQty: String(qty),
                executedQty: String(ccxtOrder.filled || 0),
                avgPrice: String(ccxtOrder.average || 0),
                type: type.toUpperCase(),
                side: side.toUpperCase(),
                timeInForce: timeInForce || 'GTC',
                updateTime: Date.now(),
            });

        } catch (err) {
            console.error('[Proxy] Order error:', err.message);
            res.status(400).json({ code: -1, msg: err.message });
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
                return res.status(400).json({ code: -1100, msg: 'symbol and orderId required' });
            }

            // Verify ownership via Redis mapping
            const mapping = await getOrderMapping(orderId);
            if (mapping && mapping.subAccountId !== req.subAccount.id) {
                return res.status(403).json({ code: -1, msg: 'Order not owned by this sub-account' });
            }

            const ccxtSymbol = rawToCcxt(symbol);
            await exchange.exchange.cancelOrder(orderId, ccxtSymbol);

            res.json({ orderId, symbol, status: 'CANCELED' });
        } catch (err) {
            res.status(400).json({ code: -1, msg: err.message });
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
                return res.status(400).json({ code: -1100, msg: 'symbol and orderId required' });
            }

            const mapping = await getOrderMapping(orderId);
            if (mapping && mapping.subAccountId !== req.subAccount.id) {
                return res.status(403).json({ code: -1, msg: 'Order not owned by this sub-account' });
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
            res.status(400).json({ code: -1, msg: err.message });
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
                const positions = await prisma.virtualPosition.findMany({
                    where: { subAccountId: sa.id, status: 'OPEN' },
                });
                marginUsed = positions.reduce((s, p) => s + p.margin, 0);
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

// ── POST /fapi/v1/listenKey — User stream listen key ──

router.post('/v1/listenKey',
    botApiKeyMiddleware(),
    async (req, res) => {
        // Return a PMS-specific listen key (the user's API key hash)
        const listenKey = crypto.createHash('sha256')
            .update(req.user.id)
            .digest('hex').substring(0, 60);
        res.json({ listenKey });
    },
);

router.put('/v1/listenKey', botApiKeyMiddleware(), (req, res) => {
    res.json({});
});

router.delete('/v1/listenKey', botApiKeyMiddleware(), (req, res) => {
    res.json({});
});

export default router;

/**
 * Limit Orders Routes — place limit, scale (grid), list orders, cancel orders.
 */
import { Router } from 'express';
import { prisma } from '../../risk/index.js';
import defaultExchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership, requireOrderOwnership } from '../../ownership.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { toCppSymbol } from './cpp-symbol.js';
import { makeCppClientOrderId } from './cpp-order-utils.js';
import { extractNotionalUsd, getSymbolMinNotional, normalizeOrderSizing } from './order-sizing.js';
import { persistPendingOrderWithRecovery } from './order-persistence-recovery.js';
import {
    beginIdempotentRequest,
    completeIdempotentRequest,
    releaseIdempotentRequest,
} from './submit-idempotency.js';
import { ensureSubmitPreflight } from './submit-preflight.js';

const router = Router();
let exchange = defaultExchange;

export function setLimitOrdersExchangeConnector(exchangeConnector) {
    exchange = exchangeConnector || defaultExchange;
}
// V2: C++ engine handles all order execution. No JS fallback.

function isCppClientOrderId(orderId) {
    return /^cpp-(lmt|chase|mkt)-/i.test(String(orderId || ''));
}

// POST /api/trade/limit - Place a limit order
router.post('/limit', requireOwnership('body'), async (req, res) => {
    try {
        const startedAt = Date.now();
        const { subAccountId, symbol, side, quantity, price, leverage, reduceOnly } = req.body;
        const requestedNotionalUsd = extractNotionalUsd(req.body);
        if (!subAccountId || !symbol || !side || !price || !leverage || (!quantity && !requestedNotionalUsd)) {
            return res.status(400).json({
                error: 'Missing fields: subAccountId, symbol, side, price, leverage, and quantity or notionalUsd',
            });
        }

        const sizing = await normalizeOrderSizing({
            symbol,
            side,
            quantity,
            price,
            notionalUsd: requestedNotionalUsd,
            payload: req.body,
            quantityPrecisionMode: 'nearest',
            pricePrecisionMode: 'nearest',
            allowPriceLookup: false, // limit price is already provided
            exchangeConnector: exchange,
        });

        const normalizedSymbol = sizing.symbol;
        const parsedQty = sizing.quantity;
        const parsedPrice = Number.parseFloat(exchange.priceToPrecisionCached(normalizedSymbol, price, { mode: 'nearest' }));
        const parsedLeverage = parseFloat(leverage);
        const normalizedSide = side.toUpperCase();
        if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
            return res.status(400).json({ error: `Invalid limit price: ${price}` });
        }
        if (!Number.isFinite(parsedLeverage) || parsedLeverage <= 0) {
            return res.status(400).json({ error: `Invalid leverage: ${leverage}` });
        }

        const notional = parsedQty * parsedPrice;
        const minNotional = reduceOnly ? 0 : getSymbolMinNotional(normalizedSymbol, exchange);
        if (minNotional > 0 && (notional + 1e-9) < minNotional) {
            return res.status(400).json({
                error: `Order notional too small for ${normalizedSymbol}: ${notional.toFixed(4)} < min ${minNotional}`,
                errors: [{
                    code: 'EXCHANGE_MIN_NOTIONAL',
                    message: `Order notional too small for ${normalizedSymbol}: ${notional.toFixed(4)} < min ${minNotional}. Increase size or use reduce-only.`,
                }],
            });
        }

        // V2: C++ write path — ACK-first publish, no JS fallback.
        const idem = await beginIdempotentRequest(req, 'trade:limit');
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

            const cppSide = normalizedSide === 'LONG' ? 'BUY' : 'SELL';
            const rawSymbol = toCppSymbol(normalizedSymbol);
            const clientOrderId = makeCppClientOrderId('lmt', subAccountId);
            const requestId = await bridge.sendCommand('new', {
                sub_account_id: subAccountId,
                client_order_id: clientOrderId,
                symbol: rawSymbol,
                side: cppSide,
                type: 'LIMIT',
                qty: parsedQty,
                price: parsedPrice,
                leverage: parsedLeverage,
                ...(reduceOnly ? { reduce_only: true } : {}),
            });

            const persisted = await persistPendingOrderWithRecovery({
                subAccountId, symbol: normalizedSymbol, side: normalizedSide,
                type: 'LIMIT', price: parsedPrice, quantity: parsedQty,
                leverage: parsedLeverage, exchangeOrderId: clientOrderId, status: 'PENDING',
            }, 'Limit', { route: 'limit', requestId, clientOrderId });

            if (persisted.order) {
                broadcast('order_placed', {
                    subAccountId, symbol: normalizedSymbol, side: normalizedSide,
                    price: parsedPrice, quantity: parsedQty, notional,
                    orderId: persisted.order.id, exchangeOrderId: clientOrderId,
                });
            }

            const serverLatencyMs = Date.now() - startedAt;
            res.set('X-Server-Latency-Ms', String(serverLatencyMs));
            res.set('X-Source', 'cpp-engine');
            if (persisted.persistencePending) {
                res.set('X-Persistence-Pending', '1');
            }
            const responseBody = {
                success: true, accepted: true, source: 'cpp-engine',
                requestId,
                clientOrderId,
                status: persisted.persistencePending ? 'accepted_but_persist_pending' : 'QUEUED',
                persistencePending: persisted.persistencePending,
                persistenceError: persisted.persistencePending ? persisted.persistenceError : undefined,
                recoveryQueue: persisted.persistencePending ? persisted.recoveryQueue : undefined,
                order: persisted.order,
                serverLatencyMs,
            };
            await completeIdempotentRequest(idem, { statusCode: 202, body: responseBody });
            return res.status(202).json(responseBody);
        } catch (cppErr) {
            await releaseIdempotentRequest(idem);
            console.error('[Limit] C++ submit failed:', cppErr.message);
            return res.status(502).json({ success: false, error: `C++ submit failed: ${cppErr.message}` });
        }
    } catch (err) {
        console.error('[Limit] Order failed:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/trade/scale - Place a scale (grid) of limit orders
router.post('/scale', requireOwnership('body'), async (req, res) => {
    let idem = null;
    try {
        const startedAt = Date.now();
        const { subAccountId, symbol, side, leverage, orders } = req.body;
        if (!subAccountId || !symbol || !side || !leverage || !Array.isArray(orders)) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side, leverage, orders[]' });
        }
        if (orders.length < 5 || orders.length > 30) {
            return res.status(400).json({ error: `Order count must be between 5 and 30. Got ${orders.length}` });
        }

        // ── Validation: side/leverage and C++ write readiness ────────────────
        const normSide = String(side).toUpperCase();
        if (normSide !== 'LONG' && normSide !== 'SHORT') {
            return res.status(400).json({ error: `Invalid side '${side}'. Use LONG or SHORT.` });
        }
        const parsedLeverage = parseFloat(leverage);
        if (!Number.isFinite(parsedLeverage) || parsedLeverage <= 0 || parsedLeverage > 125) {
            return res.status(400).json({ error: `Invalid leverage ${leverage}. Must be 1–125.` });
        }

        idem = await beginIdempotentRequest(req, 'trade:scale');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }

        const bridge = await ensureSubmitPreflight({
            getBridge: getSimplxBridge,
            subAccountId,
            sync: true,
        });

        // ── Structural validation before any submit ──────────────────────────
        const validationErrors = [];
        const seenPrices = new Set();
        for (let i = 0; i < orders.length; i++) {
            const o = orders[i];
            const p = parseFloat(o.price);
            const q = parseFloat(o.quantity);
            if (!Number.isFinite(p) || p <= 0) {
                validationErrors.push({ code: 'SCALE_INVALID_ORDER', message: `Order #${i + 1}: invalid price ${o.price}` });
            } else if (seenPrices.has(p)) {
                validationErrors.push({ code: 'SCALE_INVALID_ORDER', message: `Order #${i + 1}: duplicate price $${p}` });
            } else {
                seenPrices.add(p);
            }
            if (!Number.isFinite(q) || q <= 0) {
                validationErrors.push({ code: 'SCALE_INVALID_ORDER', message: `Order #${i + 1}: invalid quantity ${o.quantity}` });
            }
        }
        if (validationErrors.length > 0) {
            return res.status(400).json({ error: 'Scale order validation failed', errors: validationErrors });
        }

        // ── C++ submit path (no direct venue writes from JS) ─────────────────
        const cppSide = normSide === 'LONG' ? 'BUY' : 'SELL';
        const results = Array.from({ length: orders.length }, () => null);
        const parsePositiveInt = (raw, fallback) => {
            const parsed = Number.parseInt(raw, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const configuredConcurrency = parsePositiveInt(process.env.SCALE_ORDER_CONCURRENCY, 4);
        const SCALE_ORDER_CONCURRENCY = Math.min(6, Math.max(1, configuredConcurrency));

        const placeSingleOrder = async (o, idx) => {
            const parsedPrice = parseFloat(o.price);
            const parsedQty = parseFloat(o.quantity);
            if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || !Number.isFinite(parsedQty) || parsedQty <= 0) {
                return { success: false, index: idx, error: `invalid order payload at #${idx + 1}` };
            }

            const sizing = await normalizeOrderSizing({
                symbol,
                side: normSide,
                quantity: parsedQty,
                price: parsedPrice,
                payload: o,
                quantityPrecisionMode: 'nearest',
                pricePrecisionMode: 'nearest',
                allowPriceLookup: false,
                exchangeConnector: exchange,
            });
            const normalizedSymbol = sizing.symbol;
            const normalizedPrice = Number.parseFloat(
                exchange.priceToPrecisionCached(normalizedSymbol, parsedPrice, { mode: 'nearest' }),
            );
            const minNotional = getSymbolMinNotional(normalizedSymbol, exchange);
            const notional = sizing.quantity * normalizedPrice;
            if (minNotional > 0 && (notional + 1e-9) < minNotional) {
                return {
                    success: false,
                    index: idx,
                    symbol: normalizedSymbol,
                    price: normalizedPrice,
                    quantity: sizing.quantity,
                    error: `Order notional too small for ${normalizedSymbol}: ${notional.toFixed(4)} < min ${minNotional}`,
                };
            }

            const clientOrderId = makeCppClientOrderId('lmt', subAccountId);
            const requestId = await bridge.sendCommand('new', {
                sub_account_id: subAccountId,
                client_order_id: clientOrderId,
                symbol: toCppSymbol(normalizedSymbol),
                side: cppSide,
                type: 'LIMIT',
                qty: sizing.quantity,
                price: normalizedPrice,
                leverage: parsedLeverage,
            });

            const persisted = await persistPendingOrderWithRecovery({
                subAccountId,
                symbol: normalizedSymbol,
                side: normSide,
                type: 'LIMIT',
                price: normalizedPrice,
                quantity: sizing.quantity,
                leverage: parsedLeverage,
                exchangeOrderId: clientOrderId,
                status: 'PENDING',
            }, 'Scale', { route: 'scale', requestId, clientOrderId, index: idx });

            if (persisted.order) {
                broadcast('order_placed', {
                    subAccountId,
                    symbol: normalizedSymbol,
                    side: normSide,
                    price: normalizedPrice,
                    quantity: sizing.quantity,
                    notional,
                    orderId: persisted.order.id,
                    exchangeOrderId: clientOrderId,
                    scaleIndex: idx,
                    scaleTotal: orders.length,
                });
            }

            return {
                success: true,
                index: idx,
                orderId: persisted.order?.id || null,
                requestId,
                clientOrderId,
                symbol: normalizedSymbol,
                price: normalizedPrice,
                quantity: sizing.quantity,
                status: persisted.persistencePending ? 'accepted_but_persist_pending' : 'QUEUED',
                persistencePending: persisted.persistencePending,
                persistenceError: persisted.persistencePending ? persisted.persistenceError : undefined,
                recoveryQueue: persisted.persistencePending ? persisted.recoveryQueue : undefined,
            };
        };

        let cursor = 0;
        const workerCount = Math.min(SCALE_ORDER_CONCURRENCY, orders.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < orders.length) {
                const idx = cursor++;
                const order = orders[idx];
                try {
                    results[idx] = await placeSingleOrder(order, idx);
                } catch (err) {
                    results[idx] = { success: false, index: idx, price: parseFloat(order.price), error: err.message };
                }
            }
        });

        await Promise.all(workers);

        const placed = results.filter(r => r.success).length;
        const persistedCount = results.filter(r => r.success && !r.persistencePending).length;
        const persistencePendingCount = results.filter(r => r.success && r.persistencePending).length;
        console.log(`[Scale] ${placed}/${results.length} orders queued via C++ for ${symbol} ${normSide} (concurrency=${workerCount})`);
        const serverLatencyMs = Date.now() - startedAt;
        res.set('X-Server-Latency-Ms', String(serverLatencyMs));
        res.set('X-Source', 'cpp-engine');
        if (persistencePendingCount > 0) {
            res.set('X-Persistence-Pending', String(persistencePendingCount));
        }
        const statusCode = placed > 0 ? 202 : 400;
        const responseBody = {
            success: placed > 0,
            accepted: placed > 0,
            source: 'cpp-engine',
            placed,
            persisted: persistedCount,
            persistencePending: persistencePendingCount,
            failed: results.length - placed,
            total: results.length,
            results,
            serverLatencyMs,
        };
        await completeIdempotentRequest(idem, { statusCode, body: responseBody });
        res.status(statusCode).json(responseBody);
    } catch (err) {
        await releaseIdempotentRequest(idem);
        console.error('[Scale] Failed:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// GET /api/trade/orders/:subAccountId - List pending orders
router.get('/orders/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const orders = await prisma.pendingOrder.findMany({
            where: { subAccountId: req.params.subAccountId, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
        });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/orders/:orderId - Cancel a pending order
router.delete('/orders/:orderId', requireOrderOwnership(), async (req, res) => {
    try {
        const order = await prisma.pendingOrder.findUnique({ where: { id: req.params.orderId } });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.status !== 'PENDING') return res.status(400).json({ error: 'Order is not pending' });

        // Cancel on exchange
        if (order.exchangeOrderId) {
            if (isCppClientOrderId(order.exchangeOrderId)) {
                const bridge = await ensureSubmitPreflight({
                    getBridge: getSimplxBridge,
                    subAccountId: order.subAccountId,
                    sync: false,
                });
                try {
                    await bridge.sendCommand('cancel', {
                        sub_account_id: order.subAccountId,
                        client_order_id: order.exchangeOrderId,
                    });
                } catch (err) {
                    return res.status(502).json({ error: `C++ cancel failed: ${err.message}` });
                }
            } else {
                try {
                    await exchange.cancelOrder(order.symbol, order.exchangeOrderId);
                } catch (err) {
                    console.warn('[Limit] Exchange cancel failed (may already be filled):', err.message);
                }
            }
        }

        // Update DB
        await prisma.pendingOrder.update({
            where: { id: req.params.orderId },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
        });

        // Broadcast cancel event to WS clients
        broadcast('order_cancelled', {
            subAccountId: order.subAccountId,
            orderId: order.id,
            orderType: order.type || null,
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            reason: 'USER_CANCELLED',
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/orders/all/:subAccountId - Cancel all pending orders (bulk via Binance API)
router.delete('/orders/all/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const orders = await prisma.pendingOrder.findMany({
            where: { subAccountId: req.params.subAccountId, status: 'PENDING' },
        });
        if (orders.length === 0) return res.json({ cancelled: 0, failed: 0, total: 0 });

        // Group orders by symbol for bulk cancel
        const bySymbol = new Map();
        for (const order of orders) {
            if (!bySymbol.has(order.symbol)) bySymbol.set(order.symbol, []);
            bySymbol.get(order.symbol).push(order);
        }

        let cancelled = 0;
        let failed = 0;
        let bridge = null;

        for (const [symbol, symbolOrders] of bySymbol) {
            const cppOrders = symbolOrders.filter((o) => isCppClientOrderId(o.exchangeOrderId));
            const venueOrders = symbolOrders.filter((o) => !isCppClientOrderId(o.exchangeOrderId));

            // Try bulk cancel first (single API call per symbol)
            let bulkSuccess = false;
            if (venueOrders.length > 0) {
                try {
                    await exchange.cancelAllOrders(symbol);
                    bulkSuccess = true;
                    console.log(`[CancelAll] Bulk cancelled ${venueOrders.length} order(s) for ${symbol}`);
                } catch (err) {
                    console.warn(`[CancelAll] Bulk cancel failed for ${symbol}, falling back to one-by-one:`, err.message);
                }
            }

            if (bulkSuccess) {
                // Bulk succeeded — mark all DB records as cancelled
                for (const order of venueOrders) {
                    try {
                        await prisma.pendingOrder.update({
                            where: { id: order.id },
                            data: { status: 'CANCELLED', cancelledAt: new Date() },
                        });
                        cancelled++;
                    } catch (err) {
                        console.error(`[CancelAll] DB update failed for ${order.id}:`, err.message);
                        failed++;
                    }
                }
            } else {
                // Fallback: cancel one-by-one
                for (const order of venueOrders) {
                    try {
                        if (order.exchangeOrderId) {
                            try {
                                await exchange.cancelOrder(order.symbol, order.exchangeOrderId);
                            } catch (err) {
                                console.warn(`[CancelAll] Exchange cancel failed for ${order.id}:`, err.message);
                            }
                        }
                        await prisma.pendingOrder.update({
                            where: { id: order.id },
                            data: { status: 'CANCELLED', cancelledAt: new Date() },
                        });
                        cancelled++;
                    } catch (err) {
                        console.error(`[CancelAll] DB update failed for ${order.id}:`, err.message);
                        failed++;
                    }
                }
            }

            for (const order of cppOrders) {
                try {
                    if (!bridge) {
                        bridge = await ensureSubmitPreflight({
                            getBridge: getSimplxBridge,
                            subAccountId: order.subAccountId,
                            sync: false,
                        });
                    }
                    await bridge.sendCommand('cancel', {
                        sub_account_id: order.subAccountId,
                        client_order_id: order.exchangeOrderId,
                    });
                    await prisma.pendingOrder.update({
                        where: { id: order.id },
                        data: { status: 'CANCELLED', cancelledAt: new Date() },
                    });
                    cancelled++;
                } catch (err) {
                    console.error(`[CancelAll] C++ cancel failed for ${order.id}:`, err.message);
                    failed++;
                }
            }
        }

        console.log(`[CancelAll] ${cancelled}/${orders.length} orders cancelled for ${req.params.subAccountId}`);
        res.json({ cancelled, failed, total: orders.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

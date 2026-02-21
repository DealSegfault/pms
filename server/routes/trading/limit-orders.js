/**
 * Limit Orders Routes — place limit, scale (grid), list orders, cancel orders.
 */
import { Router } from 'express';
import { prisma } from '../../risk/index.js';
import exchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership, requireOrderOwnership } from '../../ownership.js';

const router = Router();

// POST /api/trade/limit - Place a limit order
router.post('/limit', requireOwnership('body'), async (req, res) => {
    try {
        const startedAt = Date.now();
        const { subAccountId, symbol, side, quantity, price, leverage, reduceOnly } = req.body;
        if (!subAccountId || !symbol || !side || !quantity || !price || !leverage) {
            return res.status(400).json({ error: 'Missing fields: subAccountId, symbol, side, quantity, price, leverage' });
        }

        const notional = parseFloat(quantity) * parseFloat(price);
        if (notional < 6) {
            return res.status(400).json({
                error: `Min order is $100 notional. Got $${notional.toFixed(2)}`,
                errors: [{ code: 'EXCHANGE_MIN_NOTIONAL', message: `Min order is $6 notional. Got $${notional.toFixed(2)}. Increase margin or leverage.` }],
            });
        }

        // Set leverage and place on exchange
        await exchange.setLeverage(symbol, parseFloat(leverage));
        const orderSide = side.toUpperCase() === 'LONG' ? 'buy' : 'sell';
        const exchangeResult = await exchange.createLimitOrder(symbol, orderSide, parseFloat(quantity), parseFloat(price), reduceOnly ? { reduceOnly: true } : undefined);

        // Store in DB
        const order = await prisma.pendingOrder.create({
            data: {
                subAccountId,
                symbol,
                side: side.toUpperCase(),
                type: 'LIMIT',
                price: parseFloat(price),
                quantity: parseFloat(quantity),
                leverage: parseFloat(leverage),
                exchangeOrderId: exchangeResult.orderId,
                status: 'PENDING',
            },
        });

        // Broadcast order_placed to connected clients
        broadcast('order_placed', {
            subAccountId,
            symbol,
            side: side.toUpperCase(),
            price: parseFloat(price),
            quantity: parseFloat(quantity),
            notional,
            orderId: order.id,
            exchangeOrderId: exchangeResult.orderId,
        });

        const serverLatencyMs = Date.now() - startedAt;
        res.set('X-Server-Latency-Ms', String(serverLatencyMs));
        res.status(201).json({ success: true, order, serverLatencyMs });
    } catch (err) {
        console.error('[Limit] Order failed:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// POST /api/trade/scale - Place a scale (grid) of limit orders
router.post('/scale', requireOwnership('body'), async (req, res) => {
    try {
        const startedAt = Date.now();
        const { subAccountId, symbol, side, leverage, orders } = req.body;
        if (!subAccountId || !symbol || !side || !leverage || !Array.isArray(orders) || orders.length < 2) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side, leverage, orders[]' });
        }
        if (orders.length < 5 || orders.length > 30) {
            return res.status(400).json({ error: `Order count must be between 5 and 30. Got ${orders.length}` });
        }

        // ── Validation: side, leverage, per-order price/quantity ──
        const normSide = String(side).toUpperCase();
        if (normSide !== 'LONG' && normSide !== 'SHORT') {
            return res.status(400).json({ error: `Invalid side '${side}'. Use LONG or SHORT.` });
        }
        const parsedLeverage = parseFloat(leverage);
        if (!Number.isFinite(parsedLeverage) || parsedLeverage <= 0 || parsedLeverage > 125) {
            return res.status(400).json({ error: `Invalid leverage ${leverage}. Must be 1–125.` });
        }

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

        await exchange.setLeverage(symbol, parsedLeverage);
        const orderSide = side.toUpperCase() === 'LONG' ? 'buy' : 'sell';

        const results = Array.from({ length: orders.length }, () => null);
        const parsePositiveInt = (raw, fallback) => {
            const parsed = Number.parseInt(raw, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isExchangeRateLimitError = (err) => {
            const msg = String(err?.message || '').toLowerCase();
            return (
                msg.includes('rate limit')
                || msg.includes('too many requests')
                || msg.includes('429')
                || msg.includes('-1015')
            );
        };
        const isTransientExchangeError = (err) => {
            const msg = String(err?.message || '').toLowerCase();
            return (
                msg.includes('timeout')
                || msg.includes('timed out')
                || msg.includes('network')
                || msg.includes('temporarily unavailable')
                || msg.includes('service unavailable')
                || msg.includes('econnreset')
                || msg.includes('socket hang up')
            );
        };

        const configuredConcurrency = parsePositiveInt(process.env.SCALE_ORDER_CONCURRENCY, 3);
        const SCALE_ORDER_CONCURRENCY = Math.min(6, Math.max(1, configuredConcurrency));
        const SCALE_ORDER_MAX_RETRIES = Math.min(5, parsePositiveInt(process.env.SCALE_ORDER_MAX_RETRIES, 2));
        const exchangeRateLimitMs = parsePositiveInt(exchange?.exchange?.rateLimit, 50);
        const configuredRateLimitMs = parsePositiveInt(process.env.SCALE_ORDER_RATE_LIMIT_MS, exchangeRateLimitMs);
        const SCALE_ORDER_BACKOFF_MS = parsePositiveInt(
            process.env.SCALE_ORDER_BACKOFF_MS,
            Math.max(configuredRateLimitMs * 2, 220),
        );
        const SCALE_ORDER_BACKOFF_JITTER_MS = parsePositiveInt(process.env.SCALE_ORDER_BACKOFF_JITTER_MS, 80);

        const placeSingleOrder = async (o, idx) => {
            const qty = parseFloat(o.quantity);
            const price = parseFloat(o.price);
            const notional = qty * price;

            if (notional < 5) {
                return { success: false, price, error: `Notional $${notional.toFixed(2)} below $5 minimum` };
            }

            for (let attempt = 0; attempt <= SCALE_ORDER_MAX_RETRIES; attempt++) {
                try {
                    const exchangeResult = await exchange.createLimitOrder(symbol, orderSide, qty, price);
                    const dbOrder = await prisma.pendingOrder.create({
                        data: {
                            subAccountId,
                            symbol,
                            side: normSide,
                            type: 'LIMIT',
                            price,
                            quantity: qty,
                            leverage: parsedLeverage,
                            exchangeOrderId: exchangeResult.orderId,
                            status: 'PENDING',
                        },
                    });

                    // Broadcast each scale order placement
                    broadcast('order_placed', {
                        subAccountId,
                        symbol,
                        side: normSide,
                        price,
                        quantity: qty,
                        notional: qty * price,
                        orderId: dbOrder.id,
                        exchangeOrderId: exchangeResult.orderId,
                        scaleIndex: idx,
                        scaleTotal: orders.length,
                    });

                    return { success: true, orderId: dbOrder.id, price };
                } catch (err) {
                    const rateLimited = isExchangeRateLimitError(err);
                    const retryable = rateLimited || isTransientExchangeError(err);
                    if (!retryable || attempt >= SCALE_ORDER_MAX_RETRIES) throw err;

                    const jitter = SCALE_ORDER_BACKOFF_JITTER_MS > 0
                        ? Math.floor(Math.random() * SCALE_ORDER_BACKOFF_JITTER_MS)
                        : 0;
                    const backoffMs = (SCALE_ORDER_BACKOFF_MS * (attempt + 1)) + jitter;
                    const reason = rateLimited ? 'rate-limit' : 'transient';
                    console.warn(
                        `[Scale] ${reason} retry ${attempt + 1}/${SCALE_ORDER_MAX_RETRIES} for order ${idx + 1}/${orders.length} after ${backoffMs}ms`,
                    );
                    await sleep(backoffMs);
                }
            }

            return { success: false, price, error: 'Unexpected retry exit' };
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
                    results[idx] = { success: false, price: parseFloat(order.price), error: err.message };
                }
            }
        });

        await Promise.all(workers);

        const placed = results.filter(r => r.success).length;
        console.log(`[Scale] ${placed}/${results.length} orders placed for ${symbol} ${normSide} (concurrency=${workerCount})`);
        const serverLatencyMs = Date.now() - startedAt;
        res.set('X-Server-Latency-Ms', String(serverLatencyMs));
        res.status(placed > 0 ? 201 : 400).json({
            placed,
            failed: results.length - placed,
            total: results.length,
            results,
            serverLatencyMs,
        });
    } catch (err) {
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
            try {
                await exchange.cancelOrder(order.symbol, order.exchangeOrderId);
            } catch (err) {
                console.warn('[Limit] Exchange cancel failed (may already be filled):', err.message);
            }
        }

        // Update DB
        await prisma.pendingOrder.update({
            where: { id: req.params.orderId },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
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

        for (const [symbol, symbolOrders] of bySymbol) {
            // Try bulk cancel first (single API call per symbol)
            let bulkSuccess = false;
            try {
                await exchange.cancelAllOrders(symbol);
                bulkSuccess = true;
                console.log(`[CancelAll] Bulk cancelled ${symbolOrders.length} orders for ${symbol}`);
            } catch (err) {
                console.warn(`[CancelAll] Bulk cancel failed for ${symbol}, falling back to one-by-one:`, err.message);
            }

            if (bulkSuccess) {
                // Bulk succeeded — mark all DB records as cancelled
                for (const order of symbolOrders) {
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
                for (const order of symbolOrders) {
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
        }

        console.log(`[CancelAll] ${cancelled}/${orders.length} orders cancelled for ${req.params.subAccountId}`);
        res.json({ cancelled, failed, total: orders.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

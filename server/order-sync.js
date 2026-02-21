/**
 * Order Sync — Monitors pending limit orders for fills, cancels, and expiry.
 *
 * Periodically polls pending orders from the DB and checks their status
 * on the exchange. When an order is filled, it executes the trade through
 * the risk engine and broadcasts an `order_filled` event to the correct user.
 *
 * This is the missing piece that connects:
 *   PendingOrder (DB) → Exchange status → Risk Engine → WS Notification
 */

import prisma from './db/prisma.js';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import exchange from './exchange.js';
import riskEngine from './risk/index.js';
import { broadcast } from './ws.js';



let syncInterval = null;

// Track recently processed orders to avoid duplicate processing
const _recentlyProcessed = new Set();

// Orders older than this are considered stale and will be expired
const STALE_ORDER_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

function normalizeExchangeStatus(status) {
    return String(status || '').toUpperCase();
}

function toFiniteNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function startOrderSync(intervalMs = 300000) {
    // Primary fills come through proxy-stream → handleExchangeOrderUpdate (realtime)
    // This is just the safety-net backup (every 5min instead of 60s)
    console.log(`[OrderSync] Starting order monitor (every ${intervalMs / 1000}s)`);
    syncInterval = setInterval(syncOrders, intervalMs);
    // First run after warmup delay (exchange stream should handle most updates in realtime)
    setTimeout(syncOrders, 15000);
}

export function stopOrderSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

async function syncOrders() {
    try {
        if (!exchange.ready) return;

        const pendingOrders = await prisma.pendingOrder.findMany({
            where: {
                status: 'PENDING',
                type: { not: 'CHASE_LIMIT' }, // Chase engine manages its own lifecycle
            },
            orderBy: { createdAt: 'asc' },
        });

        if (pendingOrders.length === 0) return;

        // Process in parallel batches to respect exchange rate limits
        const BATCH_SIZE = 10;
        for (let i = 0; i < pendingOrders.length; i += BATCH_SIZE) {
            const batch = pendingOrders.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(
                batch.map(order => {
                    if (_recentlyProcessed.has(order.id)) return;
                    return checkOrder(order);
                })
            );
        }
    } catch (err) {
        console.error('[OrderSync] Sync cycle error:', err.message);
    }
}

async function checkOrder(order) {
    // 1. Check for stale orders (no exchange ID or very old)
    if (!order.exchangeOrderId) {
        const age = Date.now() - new Date(order.createdAt).getTime();
        if (age > STALE_ORDER_AGE_MS) {
            await expireOrder(order, 'No exchange order ID and stale');
        }
        return;
    }

    // 2. Query exchange for order status
    let exchangeOrder;
    try {
        exchangeOrder = await exchange.fetchOrder(order.symbol, order.exchangeOrderId);
    } catch (err) {
        // Order not found on exchange — might have been cancelled externally
        if (err.message?.includes('Order does not exist') ||
            err.message?.includes('Order was not found') ||
            err.message?.includes('-2013')) {

            const age = Date.now() - new Date(order.createdAt).getTime();
            if (age > 60_000) {
                // Give it a grace period of 60s before marking as expired
                await expireOrder(order, 'Not found on exchange');
            }
            return;
        }
        // Other errors — skip, will retry next cycle
        console.debug(`[OrderSync] Exchange query failed for ${order.id}: ${err.message}`);
        return;
    }

    if (!exchangeOrder) return;

    const status = exchangeOrder.status?.toUpperCase?.() || '';

    if (status === 'CLOSED' || status === 'FILLED') {
        await handleOrderFilled(order, exchangeOrder);
    } else if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED' || status === 'REJECTED') {
        await handleOrderCancelled(order, status);
    }
    // status === 'OPEN' or 'NEW' → still pending, do nothing
}

/**
 * Fast-path status handling from Binance user-stream events.
 * Used by proxy-stream to reduce fill/cancel latency vs periodic polling.
 *
 * @param {Object} update
 * @param {string|number} update.orderId
 * @param {string} update.status
 * @param {number} [update.avgPrice]
 * @param {number} [update.price]
 * @param {number} [update.filledQty]
 * @returns {Promise<boolean>} true if a pending order was found and processed
 */
export async function handleExchangeOrderUpdate(update = {}) {
    const exchangeOrderId = String(update.orderId || update.exchangeOrderId || '').trim();
    if (!exchangeOrderId) return false;

    const status = normalizeExchangeStatus(update.status);
    const isFilled = status === 'FILLED' || status === 'CLOSED';
    const isCancelled = status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED' || status === 'REJECTED';
    if (!isFilled && !isCancelled) return false;

    const order = await prisma.pendingOrder.findFirst({
        where: {
            exchangeOrderId,
            status: 'PENDING',
            type: { not: 'CHASE_LIMIT' }, // Chase engine manages its own lifecycle
        },
    });
    if (!order) return false;
    if (_recentlyProcessed.has(order.id)) return true;

    if (isFilled) {
        const avgPrice = toFiniteNumber(update.avgPrice, null);
        const fallbackPrice = toFiniteNumber(update.price, null);
        const filledQty = toFiniteNumber(update.filledQty, null);

        await handleOrderFilled(order, {
            status: 'FILLED',
            average: avgPrice ?? fallbackPrice ?? order.price,
            price: fallbackPrice ?? avgPrice ?? order.price,
            filled: filledQty ?? order.quantity,
        });
    } else {
        await handleOrderCancelled(order, status);
    }

    return true;
}

async function handleOrderFilled(order, exchangeOrder) {
    _recentlyProcessed.add(order.id);

    try {
        const fillPrice = exchangeOrder.average || exchangeOrder.price || order.price;
        const fillQty = exchangeOrder.filled || order.quantity;

        // Determine if this is a close order (reduce-only) or an open order
        // Close orders: the side is opposite to what we'd expect for opening
        // We can check if there's an existing open position on the same side
        const existingPosition = await prisma.virtualPosition.findFirst({
            where: {
                subAccountId: order.subAccountId,
                symbol: order.symbol,
                status: 'OPEN',
            },
        });

        const isCloseOrder = existingPosition &&
            ((existingPosition.side === 'LONG' && order.side === 'SHORT') ||
                (existingPosition.side === 'SHORT' && order.side === 'LONG'));

        if (isCloseOrder && existingPosition) {
            // This is a limit close order — close the position at the fill price
            const closeQty = Math.min(fillQty, existingPosition.quantity);
            const realizedPnl = existingPosition.side === 'LONG'
                ? (fillPrice - existingPosition.entryPrice) * closeQty
                : (existingPosition.entryPrice - fillPrice) * closeQty;

            if (Math.abs(closeQty - existingPosition.quantity) < 1e-8) {
                // Full close
                try {
                    await riskEngine.closeVirtualPositionByPrice(
                        existingPosition.id,
                        fillPrice,
                        'LIMIT_CLOSE',
                    );
                } catch (err) {
                    console.error(`[OrderSync] Risk engine close failed for ${existingPosition.id}:`, err.message);
                }
            } else {
                // Partial close — use partialClose
                const fraction = closeQty / existingPosition.quantity;
                try {
                    await riskEngine.partialClose(existingPosition.id, fraction, 'LIMIT_CLOSE');
                } catch (err) {
                    console.error(`[OrderSync] Risk engine partial close failed for ${existingPosition.id}:`, err.message);
                }
            }
        } else {
            // This is an open order — record the trade directly
            // (the exchange order already filled, so we just create DB records)
            try {
                await recordFilledOrder(order, fillPrice, fillQty);
            } catch (err) {
                console.error(`[OrderSync] Failed to record filled order ${order.id}:`, err.message);
            }
        }

        // Update pending order status
        await prisma.pendingOrder.update({
            where: { id: order.id },
            data: { status: 'FILLED', filledAt: new Date() },
        });

        // Broadcast to the correct user
        broadcast('order_filled', {
            subAccountId: order.subAccountId,
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            price: fillPrice,
            quantity: fillQty,
            exchangeOrderId: order.exchangeOrderId,
            ...(['CHASE_LIMIT', 'SURF_LIMIT', 'TWAP_SLICE'].includes(order.type) ? { suppressToast: true } : {}),
        });

        console.log(`[OrderSync] ✅ Order FILLED: ${order.side} ${order.symbol} @ $${fillPrice} (${order.subAccountId})`);

    } catch (err) {
        console.error(`[OrderSync] Error handling filled order ${order.id}:`, err.message);
    } finally {
        // Clean up dedup after a delay
        setTimeout(() => _recentlyProcessed.delete(order.id), 30000);
    }
}

/**
 * Record a filled limit open order as a virtual position.
 * The exchange order has already been filled, so we only create DB records.
 */
async function recordFilledOrder(order, fillPrice, fillQty) {
    const account = await prisma.subAccount.findUnique({ where: { id: order.subAccountId } });
    if (!account || account.status !== 'ACTIVE') {
        console.warn(`[OrderSync] Skipping fill for ${order.id} — account not active`);
        return;
    }

    const notional = fillPrice * fillQty;
    const margin = notional / order.leverage;

    const signature = crypto.createHash('sha256')
        .update(`${order.subAccountId}:LIMIT_FILL:${order.id}:${Date.now()}:${uuidv4()}`)
        .digest('hex');

    // Check for existing same-side position (to ADD to it)
    const existing = await prisma.virtualPosition.findFirst({
        where: { subAccountId: order.subAccountId, symbol: order.symbol, side: order.side, status: 'OPEN' },
    });

    const result = await prisma.$transaction(async (tx) => {
        let position;
        let tradeAction;

        if (existing) {
            // Average into existing position
            const newQty = existing.quantity + fillQty;
            const newEntry = (existing.entryPrice * existing.quantity + fillPrice * fillQty) / newQty;
            const newNotional = newEntry * newQty;
            const newMargin = newNotional / order.leverage;

            position = await tx.virtualPosition.update({
                where: { id: existing.id },
                data: {
                    entryPrice: newEntry,
                    quantity: newQty,
                    notional: newNotional,
                    leverage: order.leverage,
                    margin: newMargin,
                },
            });
            tradeAction = 'ADD';
        } else {
            // Create new position
            const liqPrice = riskEngine.calculateLiquidationPrice(
                order.side, fillPrice, order.leverage,
                account.currentBalance, notional,
            );

            position = await tx.virtualPosition.create({
                data: {
                    subAccountId: order.subAccountId,
                    symbol: order.symbol,
                    side: order.side,
                    entryPrice: fillPrice,
                    quantity: fillQty,
                    notional,
                    leverage: order.leverage,
                    margin,
                    liquidationPrice: liqPrice,
                    status: 'OPEN',
                    // Algo-managed positions: exclude from babysitter
                    // SURF, SCALPER_LIMIT, and CHASE_LIMIT manage their own lifecycle
                    ...(['SURF_LIMIT', 'SURF_DELEVERAGE', 'SURF_SCALP', 'SCALPER_LIMIT', 'CHASE_LIMIT'].some(t => order.type?.startsWith(t) || order.type === t)
                        ? { babysitterExcluded: true }
                        : {}),
                },
            });
            tradeAction = 'OPEN';
        }

        await tx.tradeExecution.create({
            data: {
                subAccountId: order.subAccountId,
                positionId: position.id,
                exchangeOrderId: order.exchangeOrderId,
                symbol: order.symbol,
                side: order.side === 'LONG' ? 'BUY' : 'SELL',
                type: 'LIMIT',
                price: fillPrice,
                quantity: fillQty,
                notional,
                fee: 0,
                action: tradeAction,
                status: 'FILLED',
                signature,
            },
        });

        return position;
    });

    // Sync to in-memory position book so risk engine tracks immediately
    // The next monitorPositions() call will also pick it up, but this is faster
    try {
        riskEngine.book.add(result, account);
    } catch {
        // Non-fatal — monitorPositions will catch up
    }

    // Ensure prices are being tracked
    exchange.subscribeToPrices([order.symbol]);
}

async function handleOrderCancelled(order, exchangeStatus) {
    _recentlyProcessed.add(order.id);

    try {
        const newStatus = exchangeStatus === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED';

        await prisma.pendingOrder.update({
            where: { id: order.id },
            data: { status: newStatus, cancelledAt: new Date() },
        });

        broadcast('order_cancelled', {
            subAccountId: order.subAccountId,
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            reason: exchangeStatus,
        });

        console.log(`[OrderSync] ❌ Order ${newStatus}: ${order.side} ${order.symbol} @ $${order.price} (${order.subAccountId})`);
    } catch (err) {
        console.error(`[OrderSync] Error handling cancelled order ${order.id}:`, err.message);
    } finally {
        setTimeout(() => _recentlyProcessed.delete(order.id), 30000);
    }
}

async function expireOrder(order, reason) {
    _recentlyProcessed.add(order.id);

    try {
        // Try to cancel on exchange if it still exists
        if (order.exchangeOrderId) {
            try {
                await exchange.cancelOrder(order.symbol, order.exchangeOrderId);
            } catch { /* ignore */ }
        }

        await prisma.pendingOrder.update({
            where: { id: order.id },
            data: { status: 'EXPIRED', cancelledAt: new Date() },
        });

        broadcast('order_cancelled', {
            subAccountId: order.subAccountId,
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            reason: 'EXPIRED',
        });

        console.log(`[OrderSync] ⏰ Order EXPIRED: ${order.symbol} (${reason})`);
    } catch (err) {
        console.error(`[OrderSync] Error expiring order ${order.id}:`, err.message);
    } finally {
        setTimeout(() => _recentlyProcessed.delete(order.id), 30000);
    }
}

/**
 * Process a chase order fill — called by the chase engine when it detects a fill.
 * Looks up the pendingOrder by exchangeOrderId (including CHASE_LIMIT type),
 * then delegates to handleOrderFilled() to create/update the virtual position.
 *
 * Note: during repricing the in-memory exchangeOrderId diverges from the DB record
 * (the DB is not updated on each reprice). We fallback to subAccountId+type+symbol.
 */
export async function processChaseOrderFill({ exchangeOrderId, subAccountId, symbol, fillPrice, fillQty }) {
    const eid = String(exchangeOrderId || '').trim();

    // Primary lookup by exchangeOrderId
    let order = eid
        ? await prisma.pendingOrder.findFirst({
            where: {
                exchangeOrderId: eid,
                subAccountId,
                status: 'PENDING',
                type: 'CHASE_LIMIT',
            },
        })
        : null;

    // Fallback: after repricing the DB exchangeOrderId is stale — find by symbol+type
    if (!order && symbol) {
        order = await prisma.pendingOrder.findFirst({
            where: {
                subAccountId,
                symbol,
                status: 'PENDING',
                type: 'CHASE_LIMIT',
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    if (!order) {
        console.warn(`[OrderSync] processChaseOrderFill: no PENDING CHASE_LIMIT order found (eid=${eid}, symbol=${symbol || '?'})`);
        return;
    }
    if (_recentlyProcessed.has(order.id)) return;

    // Sync the exchangeOrderId to the latest before processing
    if (eid && order.exchangeOrderId !== eid) {
        await prisma.pendingOrder.update({
            where: { id: order.id },
            data: { exchangeOrderId: eid },
        });
        order.exchangeOrderId = eid;
    }

    await handleOrderFilled(order, {
        status: 'FILLED',
        average: fillPrice,
        price: fillPrice,
        filled: fillQty ?? order.quantity,
    });

    console.log(`[OrderSync] ✅ Chase order fill processed: ${order.side} ${order.symbol} @ $${fillPrice}`);
}

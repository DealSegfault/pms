/**
 * Rejection & Cancel Handler — processes REJECTED/CANCELED/EXPIRED order_updates.
 *
 * @consumes order_update (from UDS bridge) — fields per v2_contracts.md:
 *   {status, account, client_order_id, symbol, side, type, reason, request_id, internal_order_id}
 *
 * @produces order_rejected / order_cancelled (WS broadcast)
 * @persists PendingOrder status update (async)
 */

import prisma from '../db/prisma.js';
import { broadcast } from '../ws.js';
import { fromCppSymbol } from '../routes/trading/cpp-symbol.js';
import { log } from '../structured-logger.js';

// Dedup
const _processed = new Set();
const MAX_KEYS = 5_000;
function addKey(key) {
    _processed.add(key);
    if (_processed.size > MAX_KEYS) _processed.delete(_processed.values().next().value);
}

/**
 * Handle a REJECTED or EXPIRED order_update.
 * Contract: uses msg.account (NOT msg.sub_account_id)
 */
export async function handleRejection(msg) {
    const clientOrderId = msg.client_order_id;
    const subAccountId = msg.account || msg.sub_account_id;
    const symbol = msg.symbol ? fromCppSymbol(msg.symbol) : null;
    const reason = msg.reason || `Order ${msg.status}`;
    const status = String(msg.status || '').toUpperCase();

    const dedupKey = msg._streamId ? `reject:${msg._streamId}` : `reject:${msg.request_id}:${clientOrderId || msg.internal_order_id}`;
    if (_processed.has(dedupKey)) return;
    addKey(dedupKey);

    // Broadcast to frontend immediately
    broadcast('order_rejected', {
        subAccountId: subAccountId || undefined,
        orderId: clientOrderId || msg.internal_order_id,
        symbol: symbol || undefined,
        side: msg.side || undefined,
        type: msg.type || undefined,
        reason, status,
        ts: msg.ts || Date.now(),
    });

    log.warn('rejection-handler', 'REJECTED', `${symbol || '?'} ${msg.side || ''}: ${reason}`, {
        subAccountId, symbol, clientOrderId, reason,
    });

    // Clean up PendingOrder in background
    if (clientOrderId) {
        _cleanupPendingOrder(clientOrderId, 'REJECTED').catch(() => { });
    }
}

/**
 * Handle a CANCELED order_update.
 * Contract: uses msg.client_order_id to find PendingOrder
 */
export async function handleCancel(msg) {
    const clientOrderId = msg.client_order_id;
    if (!clientOrderId) return;

    const dedupKey = msg._streamId ? `cancel:${msg._streamId}` : `cancel:${msg.request_id}:${clientOrderId}`;
    if (_processed.has(dedupKey)) return;
    addKey(dedupKey);

    try {
        const pending = await prisma.pendingOrder.findFirst({
            where: { exchangeOrderId: clientOrderId, status: 'PENDING' },
        });
        if (pending) {
            await prisma.pendingOrder.update({
                where: { id: pending.id },
                data: { status: 'CANCELLED', cancelledAt: new Date() },
            });
            broadcast('order_cancelled', {
                subAccountId: pending.subAccountId,
                orderId: pending.id,
                orderType: pending.type || null,
                symbol: pending.symbol,
                side: pending.side,
                price: pending.price,
                reason: 'CANCELED',
            });
        }
    } catch (err) {
        if (!err.message.includes('Record to update not found')) {
            log.warn('rejection-handler', 'CANCEL_PERSIST_ERROR', err.message, { clientOrderId });
        }
    }
}

async function _cleanupPendingOrder(clientOrderId, newStatus) {
    try {
        const pending = await prisma.pendingOrder.findFirst({
            where: { exchangeOrderId: clientOrderId, status: 'PENDING' },
        });
        if (pending) {
            await prisma.pendingOrder.update({
                where: { id: pending.id },
                data: { status: newStatus, cancelledAt: new Date() },
            });
        }
    } catch (err) {
        if (!err.message.includes('Record to update not found')) {
            log.warn('rejection-handler', 'CLEANUP_ERROR', err.message, { clientOrderId });
        }
    }
}

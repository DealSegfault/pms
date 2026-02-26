/**
 * close-utils.js — V2 position close via C++ engine
 * 
 * All position closes go through C++ as reduce_only MARKET orders.
 * fill-handler.js handles the fill → DB persist → WS broadcast.
 */
import prisma from '../../db/prisma.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { makeCppClientOrderId } from './cpp-order-utils.js';
import { toCppSymbol } from './cpp-symbol.js';
import { ensureSubmitPreflight } from './submit-preflight.js';
import { broadcast } from '../../ws.js';

/**
 * Close a virtual position via C++ engine (reduce_only MARKET order).
 * Returns immediately after ACK — fill processing is async via fill-handler.
 * 
 * @param {string} positionId - VirtualPosition UUID
 * @param {string} reason - Close reason for logging (CLOSE, TRAIL_STOP, SCALPER_CLEANUP, etc.)
 * @returns {{ success: boolean, accepted: boolean, positionId: string, reason: string }}
 */
export async function closePositionViaCpp(positionId, reason = 'CLOSE') {
    const pos = await prisma.virtualPosition.findUnique({ where: { id: positionId } });
    if (!pos) throw new Error(`Position ${positionId} not found`);
    if (pos.status !== 'OPEN') throw new Error(`Position ${positionId} is ${pos.status}, not OPEN`);

    const bridge = await ensureSubmitPreflight({
        getBridge: getSimplxBridge,
        subAccountId: pos.subAccountId,
        sync: true,
    });

    // ── Desync safety: clamp close qty to exchange position ──────────────
    let closeQty = pos.quantity;
    try {
        if (typeof bridge.getExchangePositionsSnapshot === 'function') {
            // Force-sync exchange positions to avoid stale cache
            let snap = bridge.getExchangePositionsSnapshot(7000);
            if (!snap.fresh && typeof bridge.syncExchangePositions === 'function') {
                await bridge.syncExchangePositions({ reason: 'close_desync_check', force: true });
                snap = bridge.getExchangePositionsSnapshot(7000);
            }

            const posSymbol = toCppSymbol(pos.symbol);
            const exchangePos = (snap.positions || []).find(p =>
                p.symbol === posSymbol
            );
            if (exchangePos) {
                const exQty = Math.abs(parseFloat(exchangePos.quantity || exchangePos.contracts || 0));
                if (exQty > 0 && exQty < closeQty) {
                    console.warn(`[Close] Desync: virtual qty=${closeQty} > exchange qty=${exQty} for ${pos.symbol}, clamping`);
                    closeQty = exQty;
                }
            } else {
                // No exchange position — close virtual only via DB, don't send market order
                console.warn(`[Close] No exchange position for ${pos.symbol}, closing virtual only`);
                await prisma.virtualPosition.update({
                    where: { id: positionId },
                    data: { status: 'CLOSED', closedAt: new Date(), quantity: 0 },
                });

                // Broadcast so frontend updates immediately
                broadcast('position_closed', {
                    subAccountId: pos.subAccountId,
                    positionId,
                    symbol: pos.symbol,
                    side: pos.side,
                    realizedPnl: 0,
                    reason: `${reason}_VIRTUAL_ONLY`,
                });

                return {
                    success: true,
                    accepted: true,
                    source: 'virtual-only',
                    status: 'CLOSED',
                    persistencePending: false,
                    positionId,
                    reason: `${reason}_VIRTUAL_ONLY`,
                };
            }
        }
    } catch (desyncErr) {
        console.warn(`[Close] Desync check failed: ${desyncErr.message}, using virtual qty`);
    }

    // Close = opposite-side reduce_only MARKET
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    const clientOrderId = makeCppClientOrderId('cls', pos.subAccountId);

    await bridge.sendCommand('new', {
        sub_account_id: pos.subAccountId,
        client_order_id: clientOrderId,
        symbol: toCppSymbol(pos.symbol),
        side: closeSide,
        type: 'MARKET',
        qty: closeQty,
        reduce_only: true,
        leverage: pos.leverage || 20,
    });

    console.log(`[Close] ${reason}: ${pos.side} ${pos.symbol} qty=${closeQty}${closeQty !== pos.quantity ? ` (clamped from ${pos.quantity})` : ''} → C++ reduce_only MARKET (${clientOrderId})`);
    return {
        success: true,
        accepted: true,
        source: 'cpp-engine',
        status: 'QUEUED',
        persistencePending: false,
        positionId,
        reason,
        clientOrderId,
    };
}


/**
 * Close all open positions for a sub-account via C++ engine.
 */
export async function closeAllPositionsViaCpp(subAccountId, reason = 'CLOSE') {
    const positions = await prisma.virtualPosition.findMany({
        where: { subAccountId, status: 'OPEN' },
    });
    if (positions.length === 0) return { closed: 0, total: 0, results: [] };

    const results = [];
    for (const pos of positions) {
        try {
            const result = await closePositionViaCpp(pos.id, reason);
            results.push({ positionId: pos.id, symbol: pos.symbol, success: true });
        } catch (err) {
            results.push({ positionId: pos.id, symbol: pos.symbol, success: false, error: err.message });
        }
    }
    return {
        success: true,
        accepted: true,
        source: 'cpp-engine',
        status: 'QUEUED',
        persistencePending: false,
        closed: results.filter(r => r.success).length,
        total: positions.length,
        results,
    };
}

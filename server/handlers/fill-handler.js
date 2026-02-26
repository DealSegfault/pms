/**
 * Fill Handler — processes FILLED order_update events from C++ engine.
 *
 * @consumes order_update (from UDS bridge) — fields per v2_contracts.md:
 *   {status, filled_qty, avg_fill_price, account, symbol, side, client_order_id,
 *    exchange_order_id, internal_order_id, request_id, qty, type, leverage, ts}
 *
 * @produces position_updated (WS broadcast) — fields:
 *   {subAccountId, positionId, symbol, side, entryPrice, quantity, notional, leverage, margin, action}
 *
 * @persists VirtualPosition, TradeExecution, PendingOrder (async, non-blocking)
 */

import prisma from '../db/prisma.js';
import { broadcast } from '../ws.js';
import { v4 as uuidv4 } from 'uuid';
import { fromCppSymbol } from '../routes/trading/cpp-symbol.js';
import { isRecentlyClosed } from '../recent-close.js';
import { log } from '../structured-logger.js';

// Dedup — prevent double-processing of the same fill
const _processed = new Set();
const MAX_KEYS = 10_000;

function addKey(key) {
    _processed.add(key);
    if (_processed.size > MAX_KEYS) {
        _processed.delete(_processed.values().next().value);
    }
}

// Risk engine reference (set during init)
let _riskEngine = null;
export function setRiskEngine(riskEngine) { _riskEngine = riskEngine; }

/**
 * Handle a FILLED order_update from the C++ engine.
 * Contract: uses msg.account (NOT msg.sub_account_id), msg.filled_qty, msg.avg_fill_price
 */
export async function handleFill(msg) {
    // ── 1. DEDUP ──
    const dedupKey = msg._streamId
        ? `fill:${msg._streamId}`
        : `fill:${msg.request_id ?? 'na'}:${msg.client_order_id || ''}:${msg.internal_order_id || ''}`;
    if (_processed.has(dedupKey)) return;
    addKey(dedupKey);

    // ── 2. PARSE (strict field names from v2_contracts.md) ──
    const subAccountId = msg.account || msg.sub_account_id;
    const symbol = fromCppSymbol(msg.symbol);
    const rawSide = String(msg.side || '').toUpperCase();
    const positionSide = rawSide === 'BUY' ? 'LONG' : (rawSide === 'SELL' ? 'SHORT' : rawSide);
    const fillPrice = Number(msg.avg_fill_price || 0);
    const fillQty = Number(msg.filled_qty || msg.qty || 0);
    const exchangeOrderId = msg.exchange_order_id ? String(msg.exchange_order_id) : null;
    const clientOrderId = msg.client_order_id || null;
    const leverage = Number(msg.leverage || 10);
    const orderType = String(msg.type || 'MARKET').toUpperCase();

    // ── 3. VALIDATE ──
    if (!subAccountId) {
        log.warn('fill-handler', 'MISSING_ACCOUNT', 'Fill missing account field', { msg });
        return;
    }
    if (!fillPrice || !fillQty || !symbol) {
        log.warn('fill-handler', 'MISSING_FIELDS', `price=${fillPrice} qty=${fillQty} symbol=${symbol}`, { msg });
        return;
    }

    log.info('fill-handler', 'FILL', `${symbol} ${positionSide} qty=${fillQty} @ ${fillPrice}`, { subAccountId, clientOrderId });

    // ── 4. GHOST GUARD ──
    const existingPosition = _riskEngine?.book?.getPosition(subAccountId, symbol, positionSide);
    const isCppOrder = clientOrderId && clientOrderId.startsWith('cpp-');
    if (!existingPosition && isRecentlyClosed(symbol) && !isCppOrder) {
        log.info('fill-handler', 'GHOST_SKIP', `${symbol} ${positionSide} — recently closed, not a C++ order`, { clientOrderId });
        return;
    }

    // ── 5. IN-MEMORY BOOK UPDATE (instant) ──
    const fillNotional = fillPrice * fillQty;
    const fillMargin = fillNotional / leverage;
    let positionId = existingPosition?.id || uuidv4();
    let tradeAction = existingPosition ? 'ADD' : 'OPEN';
    let newQty = fillQty;
    let newEntry = fillPrice;
    let newNotional = fillNotional;
    let newMargin = fillMargin;

    if (existingPosition) {
        newQty = existingPosition.quantity + fillQty;
        newEntry = (existingPosition.entryPrice * existingPosition.quantity + fillPrice * fillQty) / newQty;
        newNotional = newEntry * newQty;
        newMargin = newNotional / leverage;

        if (_riskEngine) {
            _riskEngine.book.updatePosition(positionId, subAccountId, {
                quantity: newQty, notional: newNotional, margin: newMargin, entryPrice: newEntry,
            });
        }
    } else {
        if (_riskEngine) {
            const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
            if (!account) {
                log.warn('fill-handler', 'ACCOUNT_NOT_FOUND', `${subAccountId} not in DB`, {});
                return;
            }
            _riskEngine.book.add({
                id: positionId, subAccountId, symbol, side: positionSide,
                entryPrice: newEntry, quantity: newQty, notional: newNotional,
                leverage, margin: newMargin, status: 'OPEN',
            }, account);
        }
    }

    // ── 6. WS BROADCAST (instant, <1ms) ──
    broadcast('position_updated', {
        subAccountId, positionId, symbol, side: positionSide,
        entryPrice: newEntry, quantity: newQty, notional: newNotional,
        leverage, margin: newMargin, liquidationPrice: 0, action: tradeAction,
    });

    // ── 7. DB PERSIST (async, fire-and-forget) ──
    const tradeId = uuidv4();
    prisma.$transaction(async (tx) => {
        let position;

        if (existingPosition) {
            const currentDb = await tx.virtualPosition.findFirst({
                where: { subAccountId, symbol, side: positionSide, status: 'OPEN' },
            });
            if (currentDb) {
                const updatedQty = currentDb.quantity + fillQty;
                const updatedEntry = (currentDb.entryPrice * currentDb.quantity + fillPrice * fillQty) / updatedQty;
                position = await tx.virtualPosition.update({
                    where: { id: currentDb.id },
                    data: {
                        entryPrice: updatedEntry, quantity: updatedQty,
                        notional: updatedEntry * updatedQty, leverage,
                        margin: (updatedEntry * updatedQty) / leverage,
                    },
                });
                positionId = position.id;
            }
        }

        if (!position) {
            // Ghost guard at DB level too
            const recentlyClosed = await tx.virtualPosition.findFirst({
                where: {
                    subAccountId, symbol, side: positionSide,
                    status: { in: ['CLOSED', 'LIQUIDATED'] },
                    closedAt: { gte: new Date(Date.now() - 60_000) },
                },
                orderBy: { closedAt: 'desc' },
            });
            if (recentlyClosed) {
                log.info('fill-handler', 'GHOST_DB_SKIP', `${symbol} ${positionSide} closed ${Math.round((Date.now() - recentlyClosed.closedAt.getTime()) / 1000)}s ago`);
                return;
            }

            position = await tx.virtualPosition.create({
                data: {
                    id: positionId, subAccountId, symbol, side: positionSide,
                    entryPrice: fillPrice, quantity: fillQty, notional: fillNotional,
                    leverage, margin: fillMargin, liquidationPrice: 0, status: 'OPEN',
                },
            });
        }

        await tx.tradeExecution.create({
            data: {
                id: tradeId, subAccountId, positionId: position.id,
                exchangeOrderId: exchangeOrderId || `cpp_${msg.internal_order_id || Date.now()}`,
                symbol, side: rawSide, type: orderType,
                price: fillPrice, quantity: fillQty, notional: fillNotional,
                fee: 0, action: tradeAction, status: 'FILLED',
                signature: `cpp:${msg.request_id}:${clientOrderId || ''}`,
            },
        });

        if (clientOrderId) {
            const pending = await tx.pendingOrder.findFirst({
                where: { exchangeOrderId: clientOrderId, status: 'PENDING' },
            });
            if (pending) {
                await tx.pendingOrder.update({
                    where: { id: pending.id },
                    data: { status: 'FILLED', filledAt: new Date() },
                });
            }
        }
    }).catch(err => {
        log.error('fill-handler', 'DB_PERSIST_FAILED', `${tradeAction} ${positionSide} ${symbol}: ${err.message}`, {
            subAccountId, symbol, stack: err.stack,
        });
    });
}

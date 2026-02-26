/**
 * Position Handler — processes position_update events from C++ engine.
 *
 * @consumes position_update (from UDS bridge) — fields per v2_contracts.md:
 *   {position_id, sub_account_id, symbol, side, entry_price, quantity,
 *    notional, margin, leverage, liquidation_price, status, realized_pnl}
 *
 * @produces position_updated / position_closed (WS broadcast)
 * @persists VirtualPosition close + BalanceLog (async for closes)
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

let _riskEngine = null;
export function setRiskEngine(riskEngine) { _riskEngine = riskEngine; }

/**
 * Handle a position_update from the C++ engine.
 * Contract: uses msg.sub_account_id (position_update uses sub_account_id, not account)
 */
export async function handlePositionUpdate(msg) {
    const positionId = msg.position_id;
    const subAccountId = msg.sub_account_id;
    if (!positionId || !subAccountId) return;

    const dedupKey = msg._streamId ? `posupd:${msg._streamId}` : `posupd:${msg.request_id}:${positionId}`;
    if (_processed.has(dedupKey)) return;
    addKey(dedupKey);

    const symbol = fromCppSymbol(msg.symbol);
    const isClosed = msg.status === 'CLOSED';

    if (isClosed) {
        await _handleClose(msg, subAccountId, symbol);
    }
    // Non-close updates: broadcast position state for frontend
    // (the enriched broadcast from fill-handler is authoritative for opens/adds)
}

async function _handleClose(msg, subAccountId, symbol) {
    const realizedPnl = Number(msg.realized_pnl || 0);

    try {
        const result = await prisma.$transaction(async (tx) => {
            const pos = await tx.virtualPosition.findFirst({
                where: { subAccountId, symbol, side: msg.side, status: 'OPEN' },
            });
            if (!pos) return null;

            const updated = await tx.virtualPosition.update({
                where: { id: pos.id },
                data: { status: 'CLOSED', realizedPnl, closedAt: new Date() },
            });

            // Apply balance delta
            const account = await tx.subAccount.findUnique({ where: { id: subAccountId } });
            const balanceBefore = account.currentBalance;
            const balanceAfter = balanceBefore + realizedPnl;

            await tx.subAccount.update({
                where: { id: subAccountId },
                data: { currentBalance: balanceAfter },
            });

            await tx.balanceLog.create({
                data: { subAccountId, balanceBefore, balanceAfter, delta: realizedPnl, reason: 'CPP_CLOSE' },
            });

            return { position: updated, newBalance: balanceAfter };
        });

        if (result) {
            if (_riskEngine) {
                _riskEngine.book.remove(result.position.id, subAccountId);
                _riskEngine.book.updateBalance(subAccountId, result.newBalance);
            }

            broadcast('position_closed', {
                subAccountId,
                positionId: result.position.id,
                symbol,
                side: msg.side,
                realizedPnl,
                newBalance: result.newBalance,
            });

            log.info('position-handler', 'CLOSED', `${symbol} ${msg.side} PnL=$${realizedPnl.toFixed(2)} Balance=$${result.newBalance.toFixed(2)}`, { subAccountId });
        }
    } catch (err) {
        log.error('position-handler', 'CLOSE_FAILED', `${symbol} ${msg.side}: ${err.message}`, {
            subAccountId, stack: err.stack,
        });
    }
}

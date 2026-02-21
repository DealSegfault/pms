/**
 * risk-math.js — Pure, side-effect-free calculation functions.
 *
 * Zero dependencies. No DB, no exchange, no WebSocket.
 * Every function is deterministic and fully testable without mocks.
 *
 * Extracted from trade-executor.js and index.js as part of Agent 05
 * risk engine restructure (SUB-0501).
 */
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// ── PnL ─────────────────────────────────────────────

/**
 * Compute realized or unrealized PnL for a position.
 * @param {'LONG'|'SHORT'} side
 * @param {number} entryPrice
 * @param {number} closePrice — current mark price or actual fill price
 * @param {number} quantity
 * @returns {number}
 */
export function computePnl(side, entryPrice, closePrice, quantity) {
    return side === 'LONG'
        ? (closePrice - entryPrice) * quantity
        : (entryPrice - closePrice) * quantity;
}

// ── Margin ──────────────────────────────────────────

/**
 * Compute available margin for a new trade.
 *
 * @param {Object} params
 * @param {number} params.balance        — account current balance
 * @param {number} params.maintenanceRate — e.g. 0.005
 * @param {number} params.totalUpnl      — total unrealized PnL across all positions
 * @param {number} params.totalNotional   — sum of open positions' notional
 * @param {number} params.oppositeNotional — notional of opposite-side position being closed (flip)
 * @param {number} params.oppositePnl    — PnL of opposite position at current price
 * @returns {{ equity: number, maintenanceMargin: number, availableMargin: number }}
 */
export function computeAvailableMargin({
    balance,
    maintenanceRate,
    totalUpnl,
    totalNotional,
    oppositeNotional = 0,
    oppositePnl = 0,
}) {
    const equity = balance + totalUpnl + oppositePnl;
    const maintenanceMargin = (totalNotional - oppositeNotional) * maintenanceRate;
    const availableMargin = equity - maintenanceMargin;
    return { equity, maintenanceMargin, availableMargin };
}

/**
 * Compute post-trade margin usage ratio.
 *
 * @param {Object} params
 * @param {number} params.equity       — account equity
 * @param {number} params.currentMarginUsed — margin used by existing positions (excluding opposite)
 * @param {number} params.newMargin    — margin required for the new trade
 * @returns {number} ratio (> 1 means over-margined)
 */
export function computeMarginUsageRatio({ equity, currentMarginUsed, newMargin }) {
    if (equity <= 0) return 999;
    return (currentMarginUsed + newMargin) / equity;
}

// ── Trade Signature ─────────────────────────────────

/**
 * Create a SHA-256 trade signature.
 * Deterministic given the same inputs + timestamp + nonce.
 *
 * @param {string} subAccountId
 * @param {string} action — e.g. 'CLOSE', 'LIQUIDATE', 'RECONCILE', 'ADL', 'FLIP_CLOSE'
 * @param {string} positionId
 * @returns {string} hex-encoded SHA-256 hash
 */
export function createTradeSignature(subAccountId, action, positionId) {
    return crypto.createHash('sha256')
        .update(`${subAccountId}:${action}:${positionId}:${Date.now()}:${uuidv4()}`)
        .digest('hex');
}

/**
 * Create a trade signature for an OPEN trade (different input shape).
 *
 * @param {string} subAccountId
 * @param {string} symbol
 * @param {string} side
 * @param {number} quantity
 * @returns {string} hex-encoded SHA-256 hash
 */
export function createOpenTradeSignature(subAccountId, symbol, side, quantity) {
    return crypto.createHash('sha256')
        .update(`${subAccountId}:${symbol}:${side}:${quantity}:${Date.now()}:${uuidv4()}`)
        .digest('hex');
}

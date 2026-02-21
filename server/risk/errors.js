/**
 * Structured error codes for the risk engine.
 * Reusable across all risk sub-modules.
 */

export const ERR = {
    ACCOUNT_NOT_FOUND: (msg) => ({ code: 'ACCOUNT_NOT_FOUND', message: msg || 'Sub-account not found' }),
    ACCOUNT_FROZEN: (s) => ({ code: 'ACCOUNT_FROZEN', message: `Sub-account is ${s}` }),
    INSUFFICIENT_MARGIN: (req, avail) => ({ code: 'INSUFFICIENT_MARGIN', message: `Insufficient margin: need $${req.toFixed(2)}, available $${avail.toFixed(2)}` }),
    MAX_LEVERAGE: (lev, max) => ({ code: 'MAX_LEVERAGE_EXCEEDED', message: `Leverage ${lev}x exceeds max ${max}x` }),
    MAX_NOTIONAL: (n, max) => ({ code: 'MAX_NOTIONAL_EXCEEDED', message: `Notional $${n.toFixed(2)} exceeds max $${max.toFixed(2)}` }),
    MAX_EXPOSURE: (total, max) => ({ code: 'MAX_EXPOSURE_EXCEEDED', message: `Total exposure $${total.toFixed(2)} would exceed max $${max.toFixed(2)}` }),
    MARGIN_RATIO_EXCEEDED: (ratio, threshold) => ({ code: 'MARGIN_RATIO_EXCEEDED', message: `Post-trade margin ratio ${(ratio * 100).toFixed(1)}% would breach liquidation threshold ${(threshold * 100).toFixed(0)}%. Reduce size or leverage.` }),
    NO_PRICE: () => ({ code: 'NO_PRICE', message: 'Cannot fetch current price' }),
    POSITION_NOT_FOUND: () => ({ code: 'POSITION_NOT_FOUND', message: 'Position not found' }),
    POSITION_CLOSED: () => ({ code: 'POSITION_CLOSED', message: 'Position already closed' }),
    SCALE_INVALID_RANGE: (msg) => ({ code: 'SCALE_INVALID_RANGE', message: msg || 'Invalid scale order price range' }),
    SCALE_INVALID_ORDER: (idx, msg) => ({ code: 'SCALE_INVALID_ORDER', message: `Order #${idx + 1}: ${msg}` }),
};

/**
 * Parse exchange (Binance) error responses into structured error objects.
 */
export function parseExchangeError(err) {
    const msg = err.message || '';
    const codeMatch = msg.match(/"code":\s*(-?\d+)/);
    const msgMatch = msg.match(/"msg":\s*"([^"]+)"/);
    const code = codeMatch ? parseInt(codeMatch[1]) : null;
    const binanceMsg = msgMatch ? msgMatch[1] : msg;

    const EXCHANGE_ERRORS = {
        '-4164': { code: 'EXCHANGE_MIN_NOTIONAL', message: `Binance: min notional not met. Notional = minQty * price. ${binanceMsg}` },
        '-2019': { code: 'EXCHANGE_MARGIN_INSUFFICIENT', message: `Binance: margin insufficient. ${binanceMsg}` },
        '-1111': { code: 'EXCHANGE_PRECISION', message: `Binance: quantity precision error. ${binanceMsg}` },
        '-1116': { code: 'EXCHANGE_INVALID_ORDER', message: `Binance: invalid order type. ${binanceMsg}` },
        '-4003': { code: 'EXCHANGE_QTY_TOO_SMALL', message: `Binance: quantity too small. ${binanceMsg}` },
    };

    if (code && EXCHANGE_ERRORS[String(code)]) {
        return EXCHANGE_ERRORS[String(code)];
    }
    return { code: 'EXCHANGE_REJECTED', message: `Exchange error: ${binanceMsg}` };
}

/**
 * Convert UI/ccxt symbols (e.g. BTC/USDT:USDT) to C++/exchange raw (BTCUSDT).
 */
export function toCppSymbol(symbol) {
    const upper = String(symbol || '').trim().toUpperCase();
    if (!upper) return '';

    if (upper.includes('/')) {
        const [base, quoteTail = ''] = upper.split('/');
        const quote = quoteTail.split(':')[0];
        if (base && quote) {
            return `${base}${quote}`.replace(/[^A-Z0-9]/g, '');
        }
    }

    return upper.replace(/[^A-Z0-9]/g, '');
}

/**
 * Convert raw Binance symbol (BTCUSDT) back to CCXT format (BTC/USDT:USDT).
 * Inverse of toCppSymbol.  Handles USDT-margined futures only.
 */
export function fromCppSymbol(rawSymbol) {
    const upper = String(rawSymbol || '').trim().toUpperCase();
    if (!upper) return '';
    // Already in CCXT format
    if (upper.includes('/')) return upper;
    // USDT-margined futures: BTCUSDT → BTC/USDT:USDT
    if (upper.endsWith('USDT')) {
        return `${upper.slice(0, -4)}/USDT:USDT`;
    }
    return upper;
}


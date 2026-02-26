// exchange/helpers: shared Binance REST signing + symbol normalization utilities.
import crypto from 'crypto';

export const FAPI_BASE = process.env.BINANCE_FAPI_URL || 'https://fapi.binance.com';

export function extractBanUntilMs(rawMessage = '') {
    const message = String(rawMessage || '');
    const match = message.match(/banned until\s+(\d{10,})/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

export function sign(secret, queryString) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

export function buildSignedQuery(secret, params = {}) {
    const queryParams = { ...params };
    queryParams.timestamp = Date.now();
    if (!queryParams.recvWindow) queryParams.recvWindow = 5000;

    const qs = Object.entries(queryParams)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

    const signature = sign(secret, qs);
    return `${qs}&signature=${signature}`;
}

/** Convert ccxt-style symbol to Binance raw: 'BTC/USDT:USDT' → 'BTCUSDT' */
export function toRawSymbol(symbol) {
    return String(symbol || '').replace('/', '').replace(':USDT', '').toUpperCase();
}

// exchange/market-data: read-only market/ticker symbol discovery operations.
import { toRawSymbol } from './helpers.js';

export async function fetchTicker(exchange, symbol) {
    const raw = toRawSymbol(symbol);
    const ticker = await exchange._publicGet(`/fapi/v1/ticker/24hr?symbol=${raw}`);
    return {
        symbol: exchange.normalizeSymbol(symbol),
        last: parseFloat(ticker.lastPrice),
        bid: parseFloat(ticker.bidPrice),
        ask: parseFloat(ticker.askPrice),
        mark: parseFloat(ticker.lastPrice),
        index: null,
        high: parseFloat(ticker.highPrice),
        low: parseFloat(ticker.lowPrice),
        percentage: parseFloat(ticker.priceChangePercent),
        change: parseFloat(ticker.priceChange),
        baseVolume: parseFloat(ticker.volume),
        quoteVolume: parseFloat(ticker.quoteVolume),
        fundingRate: null,
        openInterest: null,
        timestamp: ticker.closeTime,
    };
}

export async function fetchMarkPrice(exchange, symbol) {
    const raw = toRawSymbol(symbol);
    const pi = await exchange._publicGet(`/fapi/v1/premiumIndex?symbol=${raw}`);
    return parseFloat(pi.markPrice);
}

export async function fapiPublicGetPremiumIndex(exchange, params = {}) {
    const raw = toRawSymbol(params.symbol || '');
    return exchange._publicGet(`/fapi/v1/premiumIndex?symbol=${raw}`);
}

export async function searchSymbols(exchange, query) {
    const q = query.toUpperCase();
    const allMarkets = exchange.markets;

    if (!Object.keys(allMarkets).length) {
        return getPopularSymbols(exchange)
            .filter(s => s.toUpperCase().includes(q))
            .slice(0, 20)
            .map(s => ({ symbol: s, base: s.split('/')[0] }));
    }

    return Object.keys(allMarkets)
        .filter(s => s.toUpperCase().includes(q) && s.endsWith(':USDT'))
        .slice(0, 20)
        .map(s => ({
            symbol: s,
            base: allMarkets[s].base,
        }));
}

export function getPopularSymbols(exchange) {
    const popular = [
        'BTC/USDT:USDT',
        'ETH/USDT:USDT',
        'SOL/USDT:USDT',
        'DOGE/USDT:USDT',
        'XRP/USDT:USDT',
        'ADA/USDT:USDT',
        'AVAX/USDT:USDT',
        'LINK/USDT:USDT',
        'DOT/USDT:USDT',
        'MATIC/USDT:USDT',
    ];

    const allMarkets = exchange.markets;
    if (!Object.keys(allMarkets).length) return popular;
    return popular.filter(s => allMarkets[s]);
}

export async function fetchTickers(exchange) {
    const data = await exchange._publicGet('/fapi/v1/ticker/24hr');
    const result = {};

    for (const t of data) {
        const ccxtSymbol = exchange._rawToSymbol[t.symbol];
        if (!ccxtSymbol) continue;
        result[ccxtSymbol] = {
            symbol: ccxtSymbol,
            last: parseFloat(t.lastPrice),
            bid: parseFloat(t.bidPrice),
            ask: parseFloat(t.askPrice),
            high: parseFloat(t.highPrice),
            low: parseFloat(t.lowPrice),
            percentage: parseFloat(t.priceChangePercent),
            change: parseFloat(t.priceChange),
            baseVolume: parseFloat(t.volume),
            quoteVolume: parseFloat(t.quoteVolume),
            timestamp: t.closeTime,
            info: t,
        };
    }

    return result;
}

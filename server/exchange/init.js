// exchange/init: exchangeInfo bootstrap + readiness lifecycle.

import { extractBanUntilMs } from './helpers.js';

export function scheduleInitializeRetry(exchange, delayMs = 30000) {
    if (exchange._retryTimer) return;
    const safeDelay = Math.max(5000, Math.min(delayMs, 30 * 60 * 1000));
    exchange._retryTimer = setTimeout(async () => {
        exchange._retryTimer = null;
        try {
            await initialize(exchange, { allowDegraded: true });
        } catch {
            // best-effort retry loop
        }
    }, safeDelay);
}

export async function initialize(exchange, { allowDegraded = true } = {}) {
    try {
        const info = await exchange._publicGet('/fapi/v1/exchangeInfo');
        const symbols = info.symbols || [];

        exchange._markets = {};
        exchange._symbolMap = {};
        exchange._rawToSymbol = {};

        for (const s of symbols) {
            if (!s.symbol) continue;
            const raw = s.symbol;
            const ccxtStyle = `${s.baseAsset}/${s.quoteAsset}:${s.marginAsset || s.quoteAsset}`;

            const lotFilter = (s.filters || []).find(f => f.filterType === 'LOT_SIZE');
            const priceFilter = (s.filters || []).find(f => f.filterType === 'PRICE_FILTER');
            const minNotionalFilter = (s.filters || []).find(f => f.filterType === 'MIN_NOTIONAL');

            exchange._markets[raw] = {
                symbol: ccxtStyle,
                id: raw,
                base: s.baseAsset,
                quote: s.quoteAsset,
                active: s.status === 'TRADING',
                contractType: s.contractType,
                precision: {
                    amount: s.quantityPrecision,
                    price: s.pricePrecision,
                },
                limits: {
                    amount: {
                        min: lotFilter ? parseFloat(lotFilter.minQty) : undefined,
                        max: lotFilter ? parseFloat(lotFilter.maxQty) : undefined,
                    },
                    price: {
                        min: priceFilter ? parseFloat(priceFilter.minPrice) : undefined,
                        max: priceFilter ? parseFloat(priceFilter.maxPrice) : undefined,
                    },
                },
                info: s,
                filters: s.filters || [],
                stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : null,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : null,
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional || minNotionalFilter.minNotional) : null,
            };

            exchange._symbolMap[ccxtStyle] = raw;
            exchange._symbolMap[raw] = raw;
            exchange._rawToSymbol[raw] = ccxtStyle;
            exchange._symbolMap[`${s.baseAsset}/${s.quoteAsset}`] = raw;
        }

        exchange._ready = true;
        exchange._initError = null;
        console.log(`[Exchange] Connected to Binance Futures – ${symbols.length} markets loaded (vanilla API, no ccxt)`);
        return true;
    } catch (err) {
        exchange._ready = false;
        exchange._initError = err;
        console.error('[Exchange] Failed to connect:', err.message);

        const banUntilMs = extractBanUntilMs(err.message);
        if (banUntilMs) {
            const banUntilIso = new Date(banUntilMs).toISOString();
            console.warn(`[Exchange] REST IP ban detected until ${banUntilIso}; running in degraded mode.`);
            scheduleInitializeRetry(exchange, (banUntilMs - Date.now()) + 5000);
        } else {
            scheduleInitializeRetry(exchange, 30000);
        }

        if (!allowDegraded) throw err;
        return false;
    }
}

export function getMarketsView(exchange) {
    const result = {};
    for (const [raw, market] of Object.entries(exchange._markets)) {
        result[market.symbol] = market;
    }
    return result;
}

export function getInitErrorMessage(exchange) {
    return exchange._initError?.message || null;
}

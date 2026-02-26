// exchange/precision-cache: symbol normalization + precision formatting cache.

import { decimalsFromStep, roundToStep, stepFromAmountMarket, stepFromPriceMarket } from '../precision.js';
import { toRawSymbol } from './helpers.js';

export function cacheGet(exchange, map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.ts) > exchange._PRECISION_CACHE_TTL_MS) {
        map.delete(key);
        return null;
    }
    return entry.value;
}

export function cacheSet(exchange, map, key, value) {
    map.set(key, { value, ts: Date.now() });
    if (map.size > exchange._PRECISION_CACHE_MAX) {
        const overflow = map.size - exchange._PRECISION_CACHE_MAX;
        let removed = 0;
        for (const k of map.keys()) {
            map.delete(k);
            removed++;
            if (removed >= overflow) break;
        }
    }
    return value;
}

export function normalizeSymbol(exchange, symbol) {
    const raw = String(symbol || '').trim();
    if (!raw) return raw;
    const key = raw.toUpperCase();

    const cached = cacheGet(exchange, exchange._symbolResolveCache, key);
    if (cached) return cached;

    const rawBinance = exchange._symbolMap[raw] || exchange._symbolMap[key];
    if (rawBinance && exchange._rawToSymbol[rawBinance]) {
        return cacheSet(exchange, exchange._symbolResolveCache, key, exchange._rawToSymbol[rawBinance]);
    }

    return cacheSet(exchange, exchange._symbolResolveCache, key, raw);
}

export function getMarket(exchange, symbol) {
    const resolved = normalizeSymbol(exchange, symbol);
    const raw = exchange._symbolMap[resolved] || exchange._symbolMap[toRawSymbol(resolved)];
    return raw ? exchange._markets[raw] : null;
}

export function amountToPrecisionCached(exchange, symbol, amount, { mode = 'nearest' } = {}) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return String(amount);

    const market = getMarket(exchange, symbol);
    const step = stepFromAmountMarket(market);
    const rounded = roundToStep(n, step, mode);

    const cacheKey = `${symbol}|${mode}|${Number(rounded).toPrecision(16)}`;
    const cached = cacheGet(exchange, exchange._amountPrecisionCache, cacheKey);
    if (cached) return cached;

    const decimals = Math.min(12, decimalsFromStep(step || 0.00000001));
    const precise = rounded.toFixed(decimals).replace(/\.?0+$/, '');
    return cacheSet(exchange, exchange._amountPrecisionCache, cacheKey, precise);
}

export function priceToPrecisionCached(exchange, symbol, price, { mode = 'nearest' } = {}) {
    const n = Number(price);
    if (!Number.isFinite(n)) return String(price);

    const market = getMarket(exchange, symbol);
    const tick = stepFromPriceMarket(market);
    const rounded = roundToStep(n, tick, mode);

    const cacheKey = `${symbol}|${mode}|${Number(rounded).toPrecision(16)}`;
    const cached = cacheGet(exchange, exchange._pricePrecisionCache, cacheKey);
    if (cached) return cached;

    const decimals = Math.min(12, decimalsFromStep(tick || 0.00000001));
    const precise = rounded.toFixed(decimals).replace(/\.?0+$/, '');
    return cacheSet(exchange, exchange._pricePrecisionCache, cacheKey, precise);
}

export function amountToPrecision(exchange, symbol, amount) {
    return amountToPrecisionCached(exchange, symbol, amount);
}

export function priceToPrecision(exchange, symbol, price) {
    return priceToPrecisionCached(exchange, symbol, price);
}

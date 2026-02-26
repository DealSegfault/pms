import defaultExchange from '../../exchange.js';

let defaultExchangeConnector = defaultExchange;

export function setOrderSizingExchangeConnector(exchangeConnector) {
    defaultExchangeConnector = exchangeConnector || defaultExchange;
}

const NOTIONAL_FIELDS = [
    'notionalUsd',
    'notionalUSD',
    'notional',
    'sizeUsd',
    'sizeUSDT',
    'usdNotional',
    'usd',
];
const MIN_NOTIONAL_FALLBACK_USD = 5;

export function parsePositiveNumber(value) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function extractNotionalUsd(payload = {}) {
    for (const key of NOTIONAL_FIELDS) {
        const n = parsePositiveNumber(payload?.[key]);
        if (n) return n;
    }
    return null;
}

export function getSymbolMinNotional(symbol, exchangeConnector = defaultExchangeConnector, { fallback = MIN_NOTIONAL_FALLBACK_USD } = {}) {
    if (!symbol) {
        return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
    }
    try {
        const normalizedSymbol = exchangeConnector.normalizeSymbol
            ? exchangeConnector.normalizeSymbol(symbol)
            : symbol;
        const market = exchangeConnector.markets?.[normalizedSymbol] || exchangeConnector.markets?.[symbol];
        const filters = Array.isArray(market?.info?.filters) ? market.info.filters : [];
        const minNotionalFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'MIN_NOTIONAL');
        const notionalFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'NOTIONAL');
        const minNotional = Number.parseFloat(
            minNotionalFilter?.notional
            || minNotionalFilter?.minNotional
            || notionalFilter?.minNotional
            || market?.minNotional,
        );
        if (Number.isFinite(minNotional) && minNotional > 0) {
            return minNotional;
        }
    } catch { /* ignore */ }
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function pickBookPrice(side, bidAsk) {
    const s = String(side || '').toUpperCase();
    const bid = parsePositiveNumber(bidAsk?.bid);
    const ask = parsePositiveNumber(bidAsk?.ask);
    if (s === 'SHORT') return bid || ask || null;
    return ask || bid || null;
}

export async function resolveReferencePrice(symbol, side, explicitPrice, exchangeConnector = defaultExchangeConnector) {
    const direct = parsePositiveNumber(explicitPrice);
    if (direct) return { price: direct, source: 'request' };

    const fromBook = pickBookPrice(side, exchangeConnector.getLatestBidAsk?.(symbol));
    if (fromBook) return { price: fromBook, source: 'book' };

    const mark = parsePositiveNumber(exchangeConnector.getLatestPrice?.(symbol));
    if (mark) return { price: mark, source: 'mark' };

    try {
        const ticker = await exchangeConnector.fetchTicker?.(symbol);
        const fromTicker = pickBookPrice(side, ticker)
            || parsePositiveNumber(ticker?.mark)
            || parsePositiveNumber(ticker?.last);
        if (fromTicker) return { price: fromTicker, source: 'ticker' };
    } catch { /* ignore */ }

    return { price: null, source: 'none' };
}

export async function normalizeOrderSizing({
    symbol,
    side,
    quantity,
    price = null,
    fallbackPrice = null,
    notionalUsd = null,
    payload = null,
    quantityPrecisionMode = 'nearest',
    pricePrecisionMode = 'nearest',
    allowPriceLookup = true,
    exchangeConnector = defaultExchangeConnector,
} = {}) {
    const normalizedSymbol = exchangeConnector.normalizeSymbol
        ? exchangeConnector.normalizeSymbol(symbol)
        : symbol;

    const requestedNotionalUsd = parsePositiveNumber(notionalUsd) || extractNotionalUsd(payload || {});
    let rawQty = parsePositiveNumber(quantity);

    const explicitPrice = parsePositiveNumber(price) || parsePositiveNumber(fallbackPrice);
    let priceInfo = { price: explicitPrice, source: explicitPrice ? 'request' : 'none' };

    if (!rawQty) {
        if (!requestedNotionalUsd) {
            throw new Error('quantity or notionalUsd is required');
        }
        if (allowPriceLookup) {
            priceInfo = await resolveReferencePrice(normalizedSymbol, side, explicitPrice, exchangeConnector);
        }
        if (!parsePositiveNumber(priceInfo.price)) {
            throw new Error(`Cannot derive quantity from notional for ${normalizedSymbol}: missing valid reference price`);
        }
        rawQty = requestedNotionalUsd / priceInfo.price;
    }

    let normalizedQty = rawQty;
    if (exchangeConnector.amountToPrecisionCached) {
        normalizedQty = Number.parseFloat(
            exchangeConnector.amountToPrecisionCached(normalizedSymbol, rawQty, { mode: quantityPrecisionMode }),
        );
    }
    if (!Number.isFinite(normalizedQty) || normalizedQty <= 0) {
        throw new Error(`Invalid quantity after precision normalization: ${rawQty} → ${normalizedQty}`);
    }

    const referencePrice = parsePositiveNumber(priceInfo.price);
    let normalizedPrice = referencePrice;
    if (referencePrice && exchangeConnector.priceToPrecisionCached) {
        normalizedPrice = Number.parseFloat(
            exchangeConnector.priceToPrecisionCached(normalizedSymbol, referencePrice, { mode: pricePrecisionMode }),
        );
    }

    return {
        symbol: normalizedSymbol,
        side: String(side || '').toUpperCase(),
        quantity: normalizedQty,
        rawQuantity: rawQty,
        requestedNotionalUsd,
        referencePrice: normalizedPrice || referencePrice || null,
        priceSource: priceInfo.source,
        derivedFromNotional: !parsePositiveNumber(quantity) && !!requestedNotionalUsd,
        effectiveNotionalUsd: requestedNotionalUsd || (
            Number.isFinite(normalizedPrice) && normalizedPrice > 0 ? normalizedPrice * normalizedQty : null
        ),
    };
}

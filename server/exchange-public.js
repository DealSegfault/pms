/**
 * Public Binance Futures read client (no credentials).
 *
 * Centralizes raw FAPI HTTP calls that were scattered across routes so
 * exchange boundary behavior (URL, timeout, response checks) is consistent.
 */

const FAPI_BASE = process.env.BINANCE_FAPI_URL || 'https://fapi.binance.com';

async function fetchJson(path, params = {}, { signal } = {}) {
    const qp = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue;
        qp.set(key, String(value));
    }
    const qs = qp.toString();
    const url = `${FAPI_BASE}${path}${qs ? `?${qs}` : ''}`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) {
        throw new Error(`Binance public API ${resp.status} for ${path}`);
    }
    return resp.json();
}

export async function fetchRawReferencePrice(rawSymbol, { timeoutMs = 120 } = {}) {
    if (!rawSymbol) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
        const data = await fetchJson('/fapi/v2/ticker/price', { symbol: rawSymbol }, { signal: controller.signal });
        const price = Number.parseFloat(data?.price);
        return Number.isFinite(price) && price > 0 ? price : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchTicker24hAll() {
    const data = await fetchJson('/fapi/v1/ticker/24hr');
    return Array.isArray(data) ? data : [];
}

export async function fetchPremiumIndexAll() {
    const data = await fetchJson('/fapi/v1/premiumIndex');
    return Array.isArray(data) ? data : [];
}

export async function fetchAggTrades({ symbol, startTime, endTime, limit = 1000 } = {}) {
    const data = await fetchJson('/fapi/v1/aggTrades', { symbol, startTime, endTime, limit });
    return Array.isArray(data) ? data : [];
}

export async function fetchKlines({ symbol, interval, limit = 500, startTime, endTime } = {}) {
    const data = await fetchJson('/fapi/v1/klines', { symbol, interval, limit, startTime, endTime });
    return Array.isArray(data) ? data : [];
}

export default {
    fetchRawReferencePrice,
    fetchTicker24hAll,
    fetchPremiumIndexAll,
    fetchAggTrades,
    fetchKlines,
};

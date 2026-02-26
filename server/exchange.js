// exchange.js: facade/orchestrator for Binance exchange modules.
// Owns shared mutable state and preserves the historical `exchange` singleton API.
import dotenv from 'dotenv';
import { EventEmitter } from 'events';
import { buildSignedQuery, FAPI_BASE } from './exchange/helpers.js';
import {
    getInitErrorMessage as getInitErrorMessageOp,
    getMarketsView as getMarketsViewOp,
    initialize as initializeOp,
    scheduleInitializeRetry as scheduleInitializeRetryOp,
} from './exchange/init.js';
import {
    fapiPublicGetPremiumIndex as fapiPublicGetPremiumIndexOp,
    fetchMarkPrice as fetchMarkPriceOp,
    fetchTicker as fetchTickerOp,
    fetchTickers as fetchTickersOp,
    getPopularSymbols as getPopularSymbolsOp,
    searchSymbols as searchSymbolsOp,
} from './exchange/market-data.js';
import {
    fetchBalance as fetchBalanceOp,
    fetchMyTrades as fetchMyTradesOp,
    fetchOrderTrades as fetchOrderTradesOp,
    fetchOrders as fetchOrdersOp,
    fetchPositions as fetchPositionsOp,
    getOpenOrders as getOpenOrdersOp,
} from './exchange/account.js';
import {
    cancelAllOrders as cancelAllOrdersOp,
    cancelOrder as cancelOrderOp,
    createLimitOrder as createLimitOrderOp,
    createMarketOrder as createMarketOrderOp,
    fetchOrder as fetchOrderOp,
} from './exchange/orders.js';
import {
    cancelBatchOrders as cancelBatchOrdersOp,
    createBatchLimitOrders as createBatchLimitOrdersOp,
} from './exchange/orders-batch.js';
import {
    buildCombinedStreamUrl as buildCombinedStreamUrlOp,
    buildRawToCcxtMap as buildRawToCcxtMapOp,
    cleanupIdleStreams as cleanupIdleStreamsOp,
    connectCombinedStream as connectCombinedStreamOp,
    destroyStreams as destroyStreamsOp,
    forceResubscribe as forceResubscribeOp,
    getLatestBidAsk as getLatestBidAskOp,
    getLatestPrice as getLatestPriceOp,
    getLatestPriceTimestamp as getLatestPriceTimestampOp,
    getStaleSymbols as getStaleSymbolsOp,
    reconnectCombinedStream as reconnectCombinedStreamOp,
    subscribeToPrices as subscribeToPricesOp,
} from './exchange/streams.js';
import {
    amountToPrecision as amountToPrecisionOp,
    amountToPrecisionCached as amountToPrecisionCachedOp,
    normalizeSymbol as normalizeSymbolOp,
    priceToPrecision as priceToPrecisionOp,
    priceToPrecisionCached as priceToPrecisionCachedOp,
} from './exchange/precision-cache.js';

dotenv.config();

// Lazy TCA import to avoid circular dependencies at module load time
let _tca = null;
import('./tca-collector.js').then(m => { _tca = m.default; }).catch(() => { });

class ExchangeConnector extends EventEmitter {
    constructor() {
        super();

        // API credentials
        this._apiKey = process.env.api_key || '';
        this._apiSecret = process.env.secret || '';
        this._fapi = FAPI_BASE;

        // Market data caches
        this._markets = {};       // rawSymbol → market info from exchangeInfo
        this._symbolMap = {};     // ccxt-style → rawSymbol mapping
        this._rawToSymbol = {};   // raw → ccxt-style mapping

        this.priceStreams = new Map();
        this.latestPrices = new Map();
        this._lastRedisPriceWrite = new Map();
        this._lastTickTime = new Map();
        this._lastInterestTs = new Map();
        this._subscribedSymbols = new Set();
        this._combinedStreams = new Map();
        this._symbolToStreamId = new Map();
        this._lastEmitPerSymbol = new Map();
        this._ready = false;
        this._initError = null;
        this._retryTimer = null;

        // Idle stream cleanup
        this._idleCleanupTimer = setInterval(() => this._cleanupIdleStreams(), 60000);

        // REST call counter
        this._restCallCount = 0;
        this._restCallWindowStart = Date.now();
        this._restCallLog = setInterval(() => {
            const elapsed = (Date.now() - this._restCallWindowStart) / 1000;
            if (this._restCallCount > 10) {
                console.log(`[Exchange-REST] ${this._restCallCount} REST calls in last ${elapsed.toFixed(0)}s`);
            }
            this._restCallCount = 0;
            this._restCallWindowStart = Date.now();
        }, 60000);

        // Circuit breaker
        this._cbFailures = 0;
        this._cbOpen = false;
        this._cbOpenUntil = 0;
        this._CB_THRESHOLD = 5;
        this._CB_COOLDOWN_MS = 30000;

        // Precision caches
        this._symbolResolveCache = new Map();
        this._amountPrecisionCache = new Map();
        this._pricePrecisionCache = new Map();
        this._PRECISION_CACHE_TTL_MS = 2 * 60 * 1000;
        this._PRECISION_CACHE_MAX = 6000;
    }

    // ── Circuit breaker ──

    _checkCircuitBreaker() {
        if (!this._cbOpen) return true;
        if (Date.now() > this._cbOpenUntil) {
            this._cbOpen = false;
            this._cbFailures = 0;
            console.log('[Exchange] Circuit breaker CLOSED — resuming order flow');
            return true;
        }
        return false;
    }

    _recordCbSuccess() { this._cbFailures = 0; }

    _recordCbFailure(err) {
        this._cbFailures++;
        if (this._cbFailures >= this._CB_THRESHOLD && !this._cbOpen) {
            this._cbOpen = true;
            this._cbOpenUntil = Date.now() + this._CB_COOLDOWN_MS;
            console.error(`[Exchange] ⚠ Circuit breaker OPEN after ${this._cbFailures} consecutive failures — rejecting orders for ${this._CB_COOLDOWN_MS / 1000}s. Last error: ${err?.message}`);
        }
    }

    // ── Raw HTTP helpers ──

    async _publicGet(path) {
        this._restCallCount++;
        const res = await fetch(`${this._fapi}${path}`);
        const body = await res.json();
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status} — ${body?.msg || JSON.stringify(body)}`);
        return body;
    }

    async _signedRequest(method, path, params = {}) {
        this._restCallCount++;
        const qs = buildSignedQuery(this._apiSecret, params);
        const url = `${this._fapi}${path}?${qs}`;
        const res = await fetch(url, {
            method,
            headers: { 'X-MBX-APIKEY': this._apiKey },
        });
        const body = await res.json();
        if (!res.ok) {
            const msg = body?.msg || JSON.stringify(body);
            throw new Error(`${path}: HTTP ${res.status} — ${msg} (code: ${body?.code || 'unknown'})`);
        }
        return body;
    }

    // ── Initialization ──

    _scheduleInitializeRetry(delayMs = 30000) {
        return scheduleInitializeRetryOp(this, delayMs);
    }

    async initialize({ allowDegraded = true } = {}) {
        return initializeOp(this, { allowDegraded });
    }

    get ready() { return this._ready; }

    get markets() {
        return getMarketsViewOp(this);
    }

    get initErrorMessage() {
        return getInitErrorMessageOp(this);
    }

    // ── Precision helpers ──

    normalizeSymbol(symbol) {
        return normalizeSymbolOp(this, symbol);
    }

    amountToPrecision(symbol, amount) {
        return amountToPrecisionOp(this, symbol, amount);
    }

    priceToPrecision(symbol, price) {
        return priceToPrecisionOp(this, symbol, price);
    }

    amountToPrecisionCached(symbol, amount, { mode = 'nearest' } = {}) {
        return amountToPrecisionCachedOp(this, symbol, amount, { mode });
    }

    priceToPrecisionCached(symbol, price, { mode = 'nearest' } = {}) {
        return priceToPrecisionCachedOp(this, symbol, price, { mode });
    }

    // ── Market Data ──

    async fetchTicker(symbol) {
        return fetchTickerOp(this, symbol);
    }

    async fetchMarkPrice(symbol) {
        return fetchMarkPriceOp(this, symbol);
    }

    /** ccxt compat shim: fapiPublicGetPremiumIndex */
    async fapiPublicGetPremiumIndex(params = {}) {
        return fapiPublicGetPremiumIndexOp(this, params);
    }

    async searchSymbols(query) {
        return searchSymbolsOp(this, query);
    }

    getPopularSymbols() {
        return getPopularSymbolsOp(this);
    }

    // ── Trading ──

    _activeOrders = 0;
    _orderQueue = [];
    static MAX_CONCURRENT_ORDERS = 10;

    async _acquireOrderSlot() {
        if (this._activeOrders < ExchangeConnector.MAX_CONCURRENT_ORDERS) {
            this._activeOrders++;
            return;
        }
        return new Promise(resolve => this._orderQueue.push(resolve));
    }

    _releaseOrderSlot() {
        this._activeOrders--;
        if (this._orderQueue.length > 0) {
            this._activeOrders++;
            this._orderQueue.shift()();
        }
    }

    async createMarketOrder(symbol, side, quantity, params = {}) {
        return createMarketOrderOp(this, () => _tca, symbol, side, quantity, params);
    }

    async createLimitOrder(symbol, side, quantity, price, params = {}) {
        return createLimitOrderOp(this, () => _tca, symbol, side, quantity, price, params);
    }

    async fetchOrder(symbol, orderId) {
        return fetchOrderOp(this, symbol, orderId);
    }

    async cancelOrder(symbol, orderId) {
        return cancelOrderOp(this, () => _tca, symbol, orderId);
    }

    async cancelAllOrders(symbol) {
        return cancelAllOrdersOp(this, symbol);
    }

    // ── Batch Trading (Binance native /fapi/v1/batchOrders) ──

    async createBatchLimitOrders(orders) {
        return createBatchLimitOrdersOp(this, () => _tca, orders);
    }

    async cancelBatchOrders(symbol, orderIds) {
        return cancelBatchOrdersOp(this, symbol, orderIds);
    }

    async getOpenOrders(symbol) {
        return getOpenOrdersOp(this, symbol);
    }

    async fetchPositions() {
        return fetchPositionsOp(this);
    }

    async fetchBalance() {
        return fetchBalanceOp(this);
    }

    // ── ccxt compat: fetchOrderTrades ──

    async fetchOrderTrades(orderId, symbol) {
        return fetchOrderTradesOp(this, orderId, symbol);
    }

    /** Fetch all 24hr tickers (for hot scanner). Returns { symbol: tickerData } map. */
    async fetchTickers() {
        return fetchTickersOp(this);
    }

    /** Fetch order history for a symbol (for backfill). */
    async fetchOrders(symbol, since, limit = 500) {
        return fetchOrdersOp(this, symbol, since, limit);
    }

    /** Fetch user trades for a symbol (for backfill). */
    async fetchMyTrades(symbol, since, limit = 500) {
        return fetchMyTradesOp(this, symbol, since, limit);
    }

    // ── Price Streaming (Combined Binance Streams) ──

    static MAX_SYMBOLS_PER_CONNECTION = 100;

    subscribeToPrices(symbols) {
        return subscribeToPricesOp(this, symbols);
    }

    _cleanupIdleStreams() {
        return cleanupIdleStreamsOp(this);
    }

    _buildCombinedStreamUrl(symbols) {
        return buildCombinedStreamUrlOp(symbols);
    }

    _buildRawToCcxtMap(symbols) {
        return buildRawToCcxtMapOp(symbols);
    }

    _connectCombinedStream(streamId) {
        return connectCombinedStreamOp(this, streamId);
    }

    _reconnectCombinedStream(streamId) {
        return reconnectCombinedStreamOp(this, streamId);
    }

    getStaleSymbols(thresholdMs = 10000) {
        return getStaleSymbolsOp(this, thresholdMs);
    }

    forceResubscribe(symbol) {
        return forceResubscribeOp(this, symbol);
    }

    getLatestPriceTimestamp(symbol) {
        return getLatestPriceTimestampOp(this, symbol);
    }

    getLatestPrice(symbol) {
        return getLatestPriceOp(this, symbol);
    }

    getLatestBidAsk(symbol) {
        return getLatestBidAskOp(this, symbol);
    }

    // ── Cleanup ──

    destroy() {
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        if (this._restCallLog) {
            clearInterval(this._restCallLog);
            this._restCallLog = null;
        }
        destroyStreamsOp(this);
        this._symbolResolveCache.clear();
        this._amountPrecisionCache.clear();
        this._pricePrecisionCache.clear();
    }
}

// Singleton
const exchange = new ExchangeConnector();
export default exchange;

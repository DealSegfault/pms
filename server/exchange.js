import ccxt from 'ccxt';
import dotenv from 'dotenv';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { setPriceCache } from './redis.js';

dotenv.config();

function _extractBanUntilMs(rawMessage = '') {
    const message = String(rawMessage || '');
    const match = message.match(/banned until\s+(\d{10,})/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

class ExchangeConnector extends EventEmitter {
    constructor() {
        super();
        this.exchange = new ccxt.binance({
            apiKey: process.env.api_key,
            secret: process.env.secret,
            options: {
                defaultType: 'future',
                adjustForTimeDifference: true,
            },
            enableRateLimit: true,
        });
        this.priceStreams = new Map(); // symbol → ws
        this.latestPrices = new Map(); // symbol → { mark, bid, ask, timestamp }
        this._lastRedisPriceWrite = new Map(); // symbol → lastWriteTs (decoupled from event emit)
        this._lastTickTime = new Map(); // symbol → timestamp of last received tick
        this._ready = false;
        this._initError = null;
        this._retryTimer = null;

        // REST call counter for observability
        this._restCallCount = 0;
        this._restCallWindowStart = Date.now();
        this._restCallLog = setInterval(() => {
            const elapsed = (Date.now() - this._restCallWindowStart) / 1000;
            if (this._restCallCount > 0) {
                console.log(`[Exchange-REST] ${this._restCallCount} REST calls in last ${elapsed.toFixed(0)}s`);
            }
            this._restCallCount = 0;
            this._restCallWindowStart = Date.now();
        }, 60000);
    }

    _scheduleInitializeRetry(delayMs = 30000) {
        if (this._retryTimer) return;
        const safeDelay = Math.max(5000, Math.min(delayMs, 30 * 60 * 1000));
        this._retryTimer = setTimeout(async () => {
            this._retryTimer = null;
            try {
                await this.initialize({ allowDegraded: true });
            } catch {
                // initialize() handles degraded mode and logging internally.
            }
        }, safeDelay);
    }

    async initialize({ allowDegraded = true } = {}) {
        try {
            await this.exchange.loadMarkets();
            this._ready = true;
            this._initError = null;
            console.log(`[Exchange] Connected to Binance Futures – ${Object.keys(this.exchange.markets).length} markets loaded`);
            return true;
        } catch (err) {
            this._ready = false;
            this._initError = err;
            console.error('[Exchange] Failed to connect:', err.message);

            const banUntilMs = _extractBanUntilMs(err.message);
            if (banUntilMs) {
                const banUntilIso = new Date(banUntilMs).toISOString();
                console.warn(`[Exchange] REST IP ban detected until ${banUntilIso}; running in degraded mode.`);
                this._scheduleInitializeRetry((banUntilMs - Date.now()) + 5000);
            } else {
                this._scheduleInitializeRetry(30000);
            }

            if (!allowDegraded) throw err;
            return false;
        }
    }

    get ready() {
        return this._ready;
    }

    get markets() {
        return this.exchange?.markets || {};
    }

    get initErrorMessage() {
        return this._initError?.message || null;
    }

    // --- Market Data ---

    async fetchTicker(symbol) {
        this._restCallCount++;
        const ticker = await this.exchange.fetchTicker(symbol);
        return {
            symbol,
            last: ticker.last,
            bid: ticker.bid,
            ask: ticker.ask,
            mark: ticker.info?.markPrice ? parseFloat(ticker.info.markPrice) : ticker.last,
            index: ticker.info?.indexPrice ? parseFloat(ticker.info.indexPrice) : null,
            high: ticker.high,
            low: ticker.low,
            percentage: ticker.percentage,
            change: ticker.change,
            baseVolume: ticker.baseVolume,
            quoteVolume: ticker.quoteVolume,
            fundingRate: ticker.info?.lastFundingRate ? parseFloat(ticker.info.lastFundingRate) : null,
            openInterest: ticker.info?.openInterest ? parseFloat(ticker.info.openInterest) : null,
            timestamp: ticker.timestamp,
        };
    }

    async fetchMarkPrice(symbol) {
        try {
            const res = await this.exchange.fapiPublicGetPremiumIndex({ symbol: symbol.replace('/', '') });
            return parseFloat(res.markPrice);
        } catch {
            const ticker = await this.fetchTicker(symbol);
            return ticker.mark;
        }
    }

    async searchSymbols(query) {
        const q = query.toUpperCase();
        const markets = this.markets;
        if (!Object.keys(markets).length) {
            return this.getPopularSymbols()
                .filter((s) => s.includes(q))
                .slice(0, 20)
                .map((s) => ({ symbol: s, base: s.split('/')[0] }));
        }

        return Object.keys(markets)
            .filter(s => s.includes(q) && s.endsWith(':USDT'))
            .slice(0, 20)
            .map(s => ({
                symbol: s,
                base: markets[s].base,
            }));
    }

    getPopularSymbols() {
        const popular = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT',
            'ADA/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT', 'MATIC/USDT:USDT'];
        const markets = this.markets;
        if (!Object.keys(markets).length) return popular;
        return popular.filter(s => markets[s]);
    }

    // --- Trading ---

    // Concurrency limiter for exchange REST calls (Fix 6: backpressure)
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
        await this._acquireOrderSlot();
        try {
            const safeParams = (params && typeof params === 'object') ? { ...params } : {};
            const fastAck = safeParams.__fastAck === true;
            const fallbackPriceRaw = Number(safeParams.__fallbackPrice);
            const fallbackPrice = Number.isFinite(fallbackPriceRaw) && fallbackPriceRaw > 0 ? fallbackPriceRaw : null;
            delete safeParams.__fastAck;
            delete safeParams.__fallbackPrice;

            const order = await this.exchange.createOrder(symbol, 'market', side, quantity, undefined, safeParams);
            console.log(`[Exchange] Market ${side} ${quantity} ${symbol} → Order ID: ${order.id}`);

            let fee = order.fee?.cost || 0;
            let filledPrice = order.average || order.price;
            let filledQty = order.filled || order.amount || quantity;

            if (fastAck) {
                if ((!filledPrice || !Number.isFinite(filledPrice)) && fallbackPrice) {
                    filledPrice = fallbackPrice;
                }
                if ((!filledQty || !Number.isFinite(filledQty)) && Number.isFinite(quantity) && quantity > 0) {
                    filledQty = quantity;
                }
                if (!fee && filledPrice && filledQty) {
                    fee = filledPrice * filledQty * 0.0005;
                }
                return {
                    orderId: order.id,
                    symbol: order.symbol || symbol,
                    side: order.side || side,
                    price: filledPrice,
                    quantity: filledQty,
                    fee,
                    status: order.status,
                    timestamp: order.timestamp,
                };
            }

            // Binance often returns fee=0 on order response; fetch trades to get actual fees
            if (!fee && order.id) {
                try {
                    const trades = await this.exchange.fetchOrderTrades(order.id, symbol);
                    fee = trades.reduce((sum, t) => sum + (t.fee?.cost || 0), 0);
                } catch { }
            }

            // Re-fetch order if exchange didn't return fill data immediately
            // (Binance can return the order before fill is confirmed)
            if ((!filledPrice || !filledQty) && order.id) {
                try {
                    // Small delay to let the fill propagate
                    await new Promise(r => setTimeout(r, 200));
                    const fetched = await this.exchange.fetchOrder(order.id, symbol);
                    if (!filledPrice) {
                        filledPrice = fetched.average || fetched.price;
                        console.warn(`[Exchange] Re-fetched fill price for ${symbol}: ${filledPrice}`);
                    }
                    if (!filledQty) {
                        filledQty = fetched.filled || filledQty;
                        console.warn(`[Exchange] Re-fetched fill qty for ${symbol}: ${filledQty}`);
                    }
                    // Also pick up fees from the re-fetched order
                    if (!fee && fetched.fee?.cost) {
                        fee = fetched.fee.cost;
                    }
                } catch (refetchErr) {
                    console.warn(`[Exchange] Failed to re-fetch order ${order.id}: ${refetchErr.message}`);
                }
            }

            // Fallback: estimate 0.05% taker fee
            if (!fee && filledPrice && filledQty) {
                fee = filledPrice * filledQty * 0.0005;
            }

            return {
                orderId: order.id,
                symbol: order.symbol,
                side: order.side,
                price: filledPrice,
                quantity: filledQty,
                fee,
                status: order.status,
                timestamp: order.timestamp,
            };
        } catch (err) {
            console.error(`[Exchange] Order failed:`, err.message);
            throw err;
        } finally {
            this._releaseOrderSlot();
        }
    }

    async createLimitOrder(symbol, side, quantity, price, params = {}) {
        await this._acquireOrderSlot();
        try {
            const safeParams = (params && typeof params === 'object') ? { ...params } : {};
            const order = await this.exchange.createOrder(symbol, 'limit', side, quantity, price, safeParams);
            console.log(`[Exchange] Limit ${side} ${quantity} ${symbol} @ $${price} → Order ID: ${order.id}`);
            return {
                orderId: order.id,
                symbol: order.symbol,
                side: order.side,
                price: order.price || price,
                quantity: order.amount || quantity,
                fee: order.fee?.cost || 0,
                status: order.status,
                timestamp: order.timestamp,
            };
        } catch (err) {
            console.error(`[Exchange] Limit order failed:`, err.message);
            throw err;
        } finally {
            this._releaseOrderSlot();
        }
    }

    async fetchOrder(symbol, orderId) {
        try {
            const order = await this.exchange.fetchOrder(orderId, symbol);
            return {
                orderId: order.id,
                symbol: order.symbol,
                side: order.side,
                type: order.type,
                price: order.price,
                average: order.average,
                amount: order.amount,
                filled: order.filled,
                remaining: order.remaining,
                status: order.status,
                fee: order.fee?.cost || 0,
                timestamp: order.timestamp,
            };
        } catch (err) {
            console.error(`[Exchange] Fetch order failed:`, err.message);
            throw err;
        }
    }

    async cancelOrder(symbol, orderId) {
        try {
            const result = await this.exchange.cancelOrder(orderId, symbol);
            console.log(`[Exchange] Cancelled order ${orderId} for ${symbol}`);
            return result;
        } catch (err) {
            console.error(`[Exchange] Cancel order failed:`, err.message);
            throw err;
        }
    }

    async cancelAllOrders(symbol) {
        try {
            const result = await this.exchange.cancelAllOrders(symbol);
            console.log(`[Exchange] Bulk cancelled all orders for ${symbol}`);
            return result;
        } catch (err) {
            console.error(`[Exchange] Bulk cancel failed for ${symbol}:`, err.message);
            throw err;
        }
    }

    // --- Batch Trading (Binance native /fapi/v1/batchOrders) ---

    /**
     * Convert ccxt symbol (e.g. 'BTC/USDT:USDT') to Binance raw (e.g. 'BTCUSDT').
     */
    _toRawSymbol(ccxtSymbol) {
        return ccxtSymbol.replace('/', '').replace(':USDT', '');
    }

    /**
     * Place up to 5 limit orders in a single REST call.
     * Binance processes them concurrently (no guaranteed execution order).
     *
     * @param {Array<{symbol: string, side: string, quantity: number, price: number, params?: object}>} orders
     *   - symbol: ccxt format (e.g. 'BTC/USDT:USDT')
     *   - side:   'buy' or 'sell'
     *   - quantity: order quantity
     *   - price:   limit price
     *   - params:  optional { reduceOnly: true, newClientOrderId: '...' }
     * @returns {Array<{orderId: string|null, symbol: string, side: string, price: number, quantity: number, status: string, error: string|null}>}
     */
    async createBatchLimitOrders(orders) {
        if (!orders || orders.length === 0) return [];
        if (orders.length > 5) throw new Error('Binance batch limit is 5 orders per call');

        await this._acquireOrderSlot();
        try {
            this._restCallCount++;

            // Build Binance-native batch payload
            const batchOrders = orders.map((o, idx) => {
                const raw = this._toRawSymbol(o.symbol);
                const entry = {
                    symbol: raw,
                    side: o.side.toUpperCase(),
                    type: 'LIMIT',
                    timeInForce: 'GTC',
                    quantity: String(o.quantity),
                    price: String(o.price),
                };
                if (o.params?.reduceOnly) entry.reduceOnly = 'true';
                if (o.params?.newClientOrderId) entry.newClientOrderId = o.params.newClientOrderId;
                return entry;
            });

            const response = await this.exchange.fapiPrivatePostBatchOrders({
                batchOrders: JSON.stringify(batchOrders),
            });

            // Parse response — each element is either a success or an error
            const results = (Array.isArray(response) ? response : []).map((r, idx) => {
                const original = orders[idx];
                if (r.code && r.code !== 200) {
                    // Individual order failed
                    console.error(`[Exchange-Batch] Order ${idx} failed: ${r.msg || r.code}`);
                    return {
                        orderId: null,
                        symbol: original.symbol,
                        side: original.side,
                        price: original.price,
                        quantity: original.quantity,
                        status: 'error',
                        error: r.msg || `Error code ${r.code}`,
                    };
                }
                // Success
                const orderId = String(r.orderId || r.orderID || r.clientOrderId);
                console.log(`[Exchange-Batch] Limit ${original.side} ${original.quantity} ${original.symbol} @ $${original.price} → Order ID: ${orderId}`);
                return {
                    orderId,
                    symbol: original.symbol,
                    side: original.side,
                    price: r.price ? parseFloat(r.price) : original.price,
                    quantity: r.origQty ? parseFloat(r.origQty) : original.quantity,
                    fee: 0,
                    status: r.status || 'NEW',
                    timestamp: r.updateTime || Date.now(),
                    error: null,
                };
            });

            const successCount = results.filter(r => !r.error).length;
            console.log(`[Exchange-Batch] Placed ${successCount}/${orders.length} orders in single call`);
            return results;
        } catch (err) {
            console.error(`[Exchange-Batch] Batch order failed:`, err.message);
            throw err;
        } finally {
            this._releaseOrderSlot();
        }
    }

    /**
     * Cancel up to 10 orders on the same symbol in a single REST call.
     *
     * @param {string} symbol - ccxt format (e.g. 'BTC/USDT:USDT')
     * @param {Array<string|number>} orderIds - exchange order IDs to cancel
     * @returns {Array<{orderId: string, status: string, error: string|null}>}
     */
    async cancelBatchOrders(symbol, orderIds) {
        if (!orderIds || orderIds.length === 0) return [];
        if (orderIds.length > 10) throw new Error('Binance batch cancel limit is 10 orders per call');

        try {
            this._restCallCount++;
            const raw = this._toRawSymbol(symbol);
            const response = await this.exchange.fapiPrivateDeleteBatchOrders({
                symbol: raw,
                orderIdList: JSON.stringify(orderIds.map(id => Number(id))),
            });

            const results = (Array.isArray(response) ? response : []).map((r, idx) => {
                if (r.code && r.code !== 200) {
                    return {
                        orderId: String(orderIds[idx]),
                        status: 'error',
                        error: r.msg || `Error code ${r.code}`,
                    };
                }
                return {
                    orderId: String(r.orderId || orderIds[idx]),
                    status: r.status || 'CANCELED',
                    error: null,
                };
            });

            const successCount = results.filter(r => !r.error).length;
            console.log(`[Exchange-Batch] Cancelled ${successCount}/${orderIds.length} orders for ${symbol}`);
            return results;
        } catch (err) {
            console.error(`[Exchange-Batch] Batch cancel failed for ${symbol}:`, err.message);
            throw err;
        }
    }

    async getOpenOrders(symbol) {
        try {
            return await this.exchange.fetchOpenOrders(symbol);
        } catch (err) {
            console.error(`[Exchange] Fetch open orders failed:`, err.message);
            return [];
        }
    }

    async setLeverage(symbol, leverage) {
        // DISABLED: Never attempt to change leverage on real Binance account.
        // Binance rejects invalid leverage values (e.g. -4028).
        // Leverage must be configured manually on the exchange.
        return;
    }

    async fetchPositions() {
        const positions = await this.exchange.fetchPositions();
        return positions.filter(p => Math.abs(p.contracts) > 0);
    }

    async fetchBalance() {
        const balance = await this.exchange.fetchBalance();
        return {
            total: balance.total?.USDT || 0,
            free: balance.free?.USDT || 0,
            used: balance.used?.USDT || 0,
        };
    }

    // --- Price Streaming (Combined Binance Streams) ---

    // Binance combined stream: max 200 streams per connection
    // Each symbol uses 2 streams (markPrice + bookTicker), so max 100 symbols per connection
    static MAX_SYMBOLS_PER_CONNECTION = 100;

    subscribeToPrices(symbols) {
        // Filter to only new symbols not yet subscribed
        const newSymbols = symbols.filter(s => !this._subscribedSymbols?.has(s));
        if (newSymbols.length === 0) return;

        if (!this._subscribedSymbols) this._subscribedSymbols = new Set();
        if (!this._combinedStreams) this._combinedStreams = new Map(); // streamId → { ws, symbols, heartbeat }
        if (!this._symbolToStreamId) this._symbolToStreamId = new Map(); // symbol → streamId
        if (!this._lastEmitPerSymbol) this._lastEmitPerSymbol = new Map(); // symbol → lastEmitTs

        for (const symbol of newSymbols) {
            this._subscribedSymbols.add(symbol);
        }

        // Find existing stream with capacity, or create new ones
        const symbolsToAssign = [...newSymbols];

        while (symbolsToAssign.length > 0) {
            // Find a stream with capacity
            let targetStreamId = null;
            for (const [streamId, stream] of this._combinedStreams) {
                if (stream.symbols.size < ExchangeConnector.MAX_SYMBOLS_PER_CONNECTION) {
                    targetStreamId = streamId;
                    break;
                }
            }

            // Determine how many symbols go into this connection
            let streamSymbols;
            if (targetStreamId) {
                // Add to existing stream — but we need to tear down and reconnect with new symbols
                const existing = this._combinedStreams.get(targetStreamId);
                const capacity = ExchangeConnector.MAX_SYMBOLS_PER_CONNECTION - existing.symbols.size;
                const toAdd = symbolsToAssign.splice(0, capacity);
                for (const s of toAdd) {
                    existing.symbols.add(s);
                    this._symbolToStreamId.set(s, targetStreamId);
                }
                // Reconnect with all symbols
                this._reconnectCombinedStream(targetStreamId);
            } else {
                // Create new stream
                const batch = symbolsToAssign.splice(0, ExchangeConnector.MAX_SYMBOLS_PER_CONNECTION);
                const streamId = `combined_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                const symbolSet = new Set(batch);
                this._combinedStreams.set(streamId, { ws: null, symbols: symbolSet, heartbeat: null });
                for (const s of batch) {
                    this._symbolToStreamId.set(s, streamId);
                }
                this._connectCombinedStream(streamId);
            }
        }
    }

    _buildCombinedStreamUrl(symbols) {
        const streams = [];
        for (const symbol of symbols) {
            const clean = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
            streams.push(`${clean}@markPrice@1s`, `${clean}@bookTicker`);
        }
        return `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;
    }

    /** Build a reverse mapping from raw Binance symbol (e.g. 'btcusdt') to ccxt symbol (e.g. 'BTC/USDT:USDT') */
    _buildRawToCcxtMap(symbols) {
        const map = new Map();
        for (const symbol of symbols) {
            const raw = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
            map.set(raw, symbol);
        }
        return map;
    }

    _connectCombinedStream(streamId) {
        const stream = this._combinedStreams.get(streamId);
        if (!stream || stream.symbols.size === 0) return;

        const wsUrl = this._buildCombinedStreamUrl(stream.symbols);
        const rawToCcxt = this._buildRawToCcxtMap(stream.symbols);

        const ws = new WebSocket(wsUrl);
        let missedPongs = 0;

        const heartbeat = setInterval(() => {
            if (missedPongs >= 2) {
                console.warn(`[Exchange] Combined WS heartbeat timeout (stream ${streamId}) — terminating`);
                ws.terminate();
                return;
            }
            missedPongs++;
            try { ws.ping(); } catch { }
        }, 30000);

        ws.on('pong', () => { missedPongs = 0; });

        ws.on('open', () => {
            console.log(`[Exchange] Combined WS connected: ${stream.symbols.size} symbols (stream ${streamId})`);
            missedPongs = 0;
        });

        ws.on('message', (data) => {
            try {
                const wrapper = JSON.parse(data);
                const streamName = wrapper.stream || '';
                const parsed = wrapper.data || wrapper;

                // Extract raw symbol from stream name (e.g. 'btcusdt@markPrice@1s' → 'btcusdt')
                const rawSymbol = streamName.split('@')[0];
                const symbol = rawToCcxt.get(rawSymbol);
                if (!symbol) return;

                let price = null;

                if (parsed.e === 'markPriceUpdate') {
                    price = parseFloat(parsed.p);
                } else if (parsed.e === 'bookTicker') {
                    const bid = parseFloat(parsed.b);
                    const ask = parseFloat(parsed.a);
                    price = (bid + ask) / 2;
                    const existing = this.latestPrices.get(symbol) || {};
                    existing.bid = bid;
                    existing.ask = ask;
                    this.latestPrices.set(symbol, { ...existing, bid, ask });
                }

                if (price && price > 0) {
                    const existing = this.latestPrices.get(symbol) || {};
                    this.latestPrices.set(symbol, {
                        ...existing,
                        mark: price,
                        timestamp: parsed.E || Date.now(),
                    });
                    this._lastTickTime.set(symbol, Date.now());

                    // Write to Redis price cache (decoupled 500ms throttle)
                    const now = Date.now();
                    const lastRedisWrite = this._lastRedisPriceWrite.get(symbol) || 0;
                    if (now - lastRedisWrite >= 500) {
                        this._lastRedisPriceWrite.set(symbol, now);
                        setPriceCache(symbol, price, 'js').catch(() => { });
                    }

                    // Throttle event emission per symbol (50ms — fast tick delivery)
                    const lastEmit = this._lastEmitPerSymbol.get(symbol) || 0;
                    if (now - lastEmit >= 50) {
                        this._lastEmitPerSymbol.set(symbol, now);
                        this.emit('price', { symbol, mark: price, timestamp: parsed.E || now });
                    }
                }
            } catch { }
        });

        ws.on('error', (err) => {
            console.error(`[Exchange] Combined WS error (stream ${streamId}):`, err.message);
        });

        ws.on('close', () => {
            clearInterval(heartbeat);
            const s = this._combinedStreams.get(streamId);
            if (s && s.symbols.size > 0) {
                console.warn(`[Exchange] Combined WS closed (stream ${streamId}, ${s.symbols.size} symbols) — reconnecting in 3s`);
                s.ws = null;
                s.heartbeat = null;
                setTimeout(() => this._connectCombinedStream(streamId), 3000);
            }
        });

        // Store references
        stream.ws = ws;
        stream.heartbeat = heartbeat;

        // Also keep priceStreams populated for backward compat (getStaleSymbols checks it)
        for (const symbol of stream.symbols) {
            this.priceStreams.set(symbol, ws);
        }
    }

    _reconnectCombinedStream(streamId) {
        const stream = this._combinedStreams.get(streamId);
        if (!stream) return;
        // Tear down existing connection
        if (stream.ws) {
            try { stream.ws.terminate(); } catch { }
        }
        if (stream.heartbeat) {
            clearInterval(stream.heartbeat);
        }
        // Reconnect with updated symbol set
        this._connectCombinedStream(streamId);
    }

    /** Returns symbols that haven't received a tick within thresholdMs. */
    getStaleSymbols(thresholdMs = 10000) {
        const now = Date.now();
        const stale = [];
        const tracked = this._subscribedSymbols || this.priceStreams;
        for (const symbol of tracked) {
            // For Map, symbol is [key, value]; for Set it's the value
            const sym = Array.isArray(symbol) ? symbol[0] : symbol;
            const lastTick = this._lastTickTime.get(sym) || 0;
            if (now - lastTick > thresholdMs) stale.push(sym);
        }
        return stale;
    }

    /** Kill and reconnect a stale WS symbol. */
    forceResubscribe(symbol) {
        if (this._symbolToStreamId) {
            const streamId = this._symbolToStreamId.get(symbol);
            if (streamId) {
                this._lastTickTime.delete(symbol);
                this._reconnectCombinedStream(streamId);
                return;
            }
        }
        // Fallback for legacy per-symbol streams
        const ws = this.priceStreams.get(symbol);
        if (ws) {
            try { ws.terminate(); } catch { }
            this.priceStreams.delete(symbol);
        }
        this._lastTickTime.delete(symbol);
        this.subscribeToPrices([symbol]);
    }

    getLatestPrice(symbol) {
        return this.latestPrices.get(symbol)?.mark || null;
    }

    /** Get WS-sourced bid/ask for a symbol (from bookTicker stream). */
    getLatestBidAsk(symbol) {
        const data = this.latestPrices.get(symbol);
        if (!data || !data.bid || !data.ask) return null;
        return { bid: data.bid, ask: data.ask };
    }

    // --- Cleanup ---

    destroy() {
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        if (this._restCallLog) {
            clearInterval(this._restCallLog);
            this._restCallLog = null;
        }
        // Close combined streams
        if (this._combinedStreams) {
            for (const [, stream] of this._combinedStreams) {
                if (stream.heartbeat) clearInterval(stream.heartbeat);
                if (stream.ws) try { stream.ws.close(); } catch { }
            }
            this._combinedStreams.clear();
        }
        // Close any legacy per-symbol streams
        for (const [, ws] of this.priceStreams) {
            try { ws.close(); } catch { }
        }
        this.priceStreams.clear();
        if (this._subscribedSymbols) this._subscribedSymbols.clear();
        if (this._symbolToStreamId) this._symbolToStreamId.clear();
    }
}

// Singleton
const exchange = new ExchangeConnector();
export default exchange;

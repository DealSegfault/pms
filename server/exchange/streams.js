// exchange/streams: WebSocket stream lifecycle + live mark-price fanout/caching.
import { WebSocket } from 'ws';
import { setPriceCache } from '../redis.js';

export function subscribeToPrices(exchange, symbols) {
    const now = Date.now();
    for (const s of symbols) {
        exchange._lastInterestTs.set(s, now);
    }

    const newSymbols = symbols.filter(s => !exchange._subscribedSymbols.has(s));
    if (newSymbols.length === 0) return;

    for (const symbol of newSymbols) {
        exchange._subscribedSymbols.add(symbol);
    }

    const symbolsToAssign = [...newSymbols];

    while (symbolsToAssign.length > 0) {
        let targetStreamId = null;
        for (const [streamId, stream] of exchange._combinedStreams) {
            if (stream.symbols.size < exchange.constructor.MAX_SYMBOLS_PER_CONNECTION) {
                targetStreamId = streamId;
                break;
            }
        }

        if (targetStreamId) {
            const existing = exchange._combinedStreams.get(targetStreamId);
            const capacity = exchange.constructor.MAX_SYMBOLS_PER_CONNECTION - existing.symbols.size;
            const toAdd = symbolsToAssign.splice(0, capacity);
            for (const s of toAdd) {
                existing.symbols.add(s);
                exchange._symbolToStreamId.set(s, targetStreamId);
            }
            reconnectCombinedStream(exchange, targetStreamId);
        } else {
            const batch = symbolsToAssign.splice(0, exchange.constructor.MAX_SYMBOLS_PER_CONNECTION);
            const streamId = `combined_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const symbolSet = new Set(batch);
            exchange._combinedStreams.set(streamId, { ws: null, symbols: symbolSet, heartbeat: null });
            for (const s of batch) {
                exchange._symbolToStreamId.set(s, streamId);
            }
            connectCombinedStream(exchange, streamId);
        }
    }
}

export function cleanupIdleStreams(exchange) {
    if (!exchange._subscribedSymbols || exchange._subscribedSymbols.size === 0) return;

    const now = Date.now();
    const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
    const toRemove = [];

    for (const symbol of exchange._subscribedSymbols) {
        const lastInterest = exchange._lastInterestTs.get(symbol) || 0;
        if (now - lastInterest > IDLE_TIMEOUT_MS) {
            toRemove.push(symbol);
        }
    }

    if (toRemove.length === 0) return;

    console.log(`[Exchange] Cleaning up ${toRemove.length} idle price streams: ${toRemove.join(', ')}`);

    const affectedStreams = new Set();
    for (const symbol of toRemove) {
        exchange._subscribedSymbols.delete(symbol);
        exchange._lastInterestTs.delete(symbol);
        exchange.latestPrices.delete(symbol);

        const streamId = exchange._symbolToStreamId?.get(symbol);
        if (streamId) {
            const stream = exchange._combinedStreams.get(streamId);
            if (stream) {
                stream.symbols.delete(symbol);
                affectedStreams.add(streamId);
            }
            exchange._symbolToStreamId.delete(symbol);
        }
    }

    for (const streamId of affectedStreams) {
        const stream = exchange._combinedStreams.get(streamId);
        if (stream.symbols.size === 0) {
            if (stream.ws) stream.ws.terminate();
            if (stream.heartbeat) clearInterval(stream.heartbeat);
            exchange._combinedStreams.delete(streamId);
        } else {
            reconnectCombinedStream(exchange, streamId);
        }
    }
}

export function buildCombinedStreamUrl(symbols) {
    const streams = [];
    for (const symbol of symbols) {
        const clean = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
        streams.push(`${clean}@markPrice@1s`, `${clean}@bookTicker`);
    }
    return `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;
}

export function buildRawToCcxtMap(symbols) {
    const map = new Map();
    for (const symbol of symbols) {
        const raw = symbol.replace('/', '').replace(':USDT', '').toLowerCase();
        map.set(raw, symbol);
    }
    return map;
}

export function connectCombinedStream(exchange, streamId) {
    const stream = exchange._combinedStreams.get(streamId);
    if (!stream || stream.symbols.size === 0) return;

    const wsUrl = buildCombinedStreamUrl(stream.symbols);
    const rawToCcxt = buildRawToCcxtMap(stream.symbols);

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
                const existing = exchange.latestPrices.get(symbol) || {};
                existing.bid = bid;
                existing.ask = ask;
                exchange.latestPrices.set(symbol, { ...existing, bid, ask });
            }

            if (price && price > 0) {
                const existing = exchange.latestPrices.get(symbol) || {};
                exchange.latestPrices.set(symbol, {
                    ...existing,
                    mark: price,
                    timestamp: parsed.E || Date.now(),
                });
                exchange._lastTickTime.set(symbol, Date.now());

                const now = Date.now();
                const lastRedisWrite = exchange._lastRedisPriceWrite.get(symbol) || 0;
                if (now - lastRedisWrite >= 500) {
                    exchange._lastRedisPriceWrite.set(symbol, now);
                    setPriceCache(symbol, price, 'js').catch(() => { });
                }

                const lastEmit = exchange._lastEmitPerSymbol.get(symbol) || 0;
                if (now - lastEmit >= 50) {
                    exchange._lastEmitPerSymbol.set(symbol, now);
                    exchange.emit('price', { symbol, mark: price, timestamp: parsed.E || now });
                }
            }
        } catch { }
    });

    ws.on('error', (err) => {
        console.error(`[Exchange] Combined WS error (stream ${streamId}):`, err.message);
    });

    ws.on('close', () => {
        clearInterval(heartbeat);
        const s = exchange._combinedStreams.get(streamId);
        if (s && s.symbols.size > 0) {
            console.warn(`[Exchange] Combined WS closed (stream ${streamId}, ${s.symbols.size} symbols) — reconnecting in 3s`);
            s.ws = null;
            s.heartbeat = null;
            setTimeout(() => connectCombinedStream(exchange, streamId), 3000);
        }
    });

    stream.ws = ws;
    stream.heartbeat = heartbeat;

    for (const symbol of stream.symbols) {
        exchange.priceStreams.set(symbol, ws);
    }
}

export function reconnectCombinedStream(exchange, streamId) {
    const stream = exchange._combinedStreams.get(streamId);
    if (!stream) return;

    if (stream.ws) {
        try { stream.ws.terminate(); } catch { }
    }
    if (stream.heartbeat) {
        clearInterval(stream.heartbeat);
    }
    connectCombinedStream(exchange, streamId);
}

export function getStaleSymbols(exchange, thresholdMs = 10000) {
    const now = Date.now();
    const stale = [];
    const tracked = exchange._subscribedSymbols || exchange.priceStreams;
    for (const symbol of tracked) {
        const sym = Array.isArray(symbol) ? symbol[0] : symbol;
        const lastTick = exchange._lastTickTime.get(sym) || 0;
        if (now - lastTick > thresholdMs) stale.push(sym);
    }
    return stale;
}

export function forceResubscribe(exchange, symbol) {
    if (exchange._symbolToStreamId) {
        const streamId = exchange._symbolToStreamId.get(symbol);
        if (streamId) {
            exchange._lastTickTime.delete(symbol);
            reconnectCombinedStream(exchange, streamId);
            return;
        }
    }

    const ws = exchange.priceStreams.get(symbol);
    if (ws) {
        try { ws.terminate(); } catch { }
        exchange.priceStreams.delete(symbol);
    }

    exchange._lastTickTime.delete(symbol);
    subscribeToPrices(exchange, [symbol]);
}

export function getLatestPriceTimestamp(exchange, symbol) {
    return exchange.latestPrices.get(symbol)?.timestamp || 0;
}

export function getLatestPrice(exchange, symbol) {
    exchange._lastInterestTs.set(symbol, Date.now());
    const data = exchange.latestPrices.get(symbol);
    return data ? data.mark : null;
}

export function getLatestBidAsk(exchange, symbol) {
    const data = exchange.latestPrices.get(symbol);
    if (!data || !data.bid || !data.ask) return null;
    return { bid: data.bid, ask: data.ask };
}

export function destroyStreams(exchange) {
    if (exchange._combinedStreams) {
        for (const [, stream] of exchange._combinedStreams) {
            if (stream.heartbeat) clearInterval(stream.heartbeat);
            if (stream.ws) {
                try { stream.ws.close(); } catch { }
            }
        }
        exchange._combinedStreams.clear();
    }

    for (const [, ws] of exchange.priceStreams) {
        try { ws.close(); } catch { }
    }
    exchange.priceStreams.clear();

    if (exchange._subscribedSymbols) exchange._subscribedSymbols.clear();
    if (exchange._symbolToStreamId) exchange._symbolToStreamId.clear();
    exchange._lastInterestTs.clear();
    exchange._lastTickTime.clear();
    exchange._lastEmitPerSymbol.clear();
    exchange._lastRedisPriceWrite.clear();
}

// ── Trading Page – WebSocket Handlers ────────────────────────
import { formatPrice } from '../../core/index.js';
import { streams } from '../../lib/binance-streams.js';
import * as S from './state.js';
import { scheduleOrderBookRender, scheduleTradeTapeRender } from './orderbook.js';
import { _refreshEquityUpnl } from './order-form.js';
import { saveToStorage } from './candle-storage.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { onTrailPriceTick } from './trail-stop.js';
import { onChaseDepthTick } from './chase-limit.js';
import { setupTradingAppEventListeners } from './ws-app-events.js';

let pnlUiRafId = null;
let lastFallbackPositionSyncTs = 0;

// ── Stream Teardown ─────────────────────────────

export function teardownStreams() {
    if (S._klineUnsub) { S._klineUnsub(); S.set('_klineUnsub', null); }
    if (S._depthUnsub) { S._depthUnsub(); S.set('_depthUnsub', null); }
    if (S._tradeUnsub) { S._tradeUnsub(); S.set('_tradeUnsub', null); }
    if (S._tickerUnsub) { S._tickerUnsub(); S.set('_tickerUnsub', null); }

    // Flush any pending candle storage write
    if (S._candleStorageTimer) {
        clearTimeout(S._candleStorageTimer);
        S.set('_candleStorageTimer', null);
        const cacheKey = `${S.selectedSymbol}_${S.currentTimeframe}`;
        const cc = S.candleCache[cacheKey];
        if (cc) saveToStorage(S.selectedSymbol, S.currentTimeframe, cc.data, cc.lastTime);
    }
}

function _schedulePnlUiRefresh() {
    if (pnlUiRafId != null) return;
    pnlUiRafId = requestAnimationFrame(() => {
        pnlUiRafId = null;
        _refreshEquityUpnl();
    });
}

// ── Stream Init ─────────────────────────────────

export function initWebSockets() {
    teardownStreams();
    if (!S._tradingMounted) return;

    const symbol = S.rawSymbol;

    // ── Kline / 1s stream ─────────────────────────────────────────────
    // Binance Futures does NOT provide @kline_1s on the combined stream.
    // For 1s we build OHLCV candles ourselves from the @aggTrade stream.
    if (S.currentTimeframe === '1s') {
        // 1s candle builder state
        let _bar1s = null; // { time, open, high, low, close, volume }

        const unsub1s = streams.subscribe(`${symbol}@aggTrade`, (data) => {
            if (!S.chartReady || !S.candleSeries || S.currentTimeframe !== '1s') return;

            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const ts = Math.floor(data.T / 1000); // second-boundary timestamp

            if (!_bar1s || ts > _bar1s.time) {
                // Emit the completed bar first (if any)
                if (_bar1s) {
                    S.candleSeries.update(_bar1s);
                    if (S.volumeSeries) {
                        S.volumeSeries.update({
                            time: _bar1s.time,
                            value: _bar1s.volume,
                            color: _bar1s.close >= _bar1s.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
                        });
                    }
                }
                // Start a new bar
                _bar1s = { time: ts, open: price, high: price, low: price, close: price, volume: qty };
            } else {
                // Update current bar
                _bar1s.high = Math.max(_bar1s.high, price);
                _bar1s.low = Math.min(_bar1s.low, price);
                _bar1s.close = price;
                _bar1s.volume += qty;
                // Push a live update so the current candle follows price in real-time
                S.candleSeries.update({ time: _bar1s.time, open: _bar1s.open, high: _bar1s.high, low: _bar1s.low, close: _bar1s.close });
            }

            // Update current price display & side-effects
            S.set('currentPrice', price);
            const priceEl = document.getElementById('sym-price');
            if (priceEl) priceEl.textContent = formatPrice(price);

            for (const [, pos] of S._positionMap) {
                if (pos.symbol === S.selectedSymbol) pos.markPrice = price;
            }
            _schedulePnlUiRefresh();
            onTrailPriceTick(price);
        });
        S.set('_klineUnsub', unsub1s);

    } else {
        // Standard kline stream for all other timeframes
        S.set('_klineUnsub', streams.subscribe(`${symbol}@kline_${S.currentTimeframe}`, (data) => {
            if (!S.chartReady || !S.candleSeries) return;
            const k = data.k;
            if (!k) return;

            const candle = {
                time: k.t / 1000,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
            };
            S.candleSeries.update(candle);

            if (S.volumeSeries) {
                S.volumeSeries.update({
                    time: candle.time,
                    value: parseFloat(k.v),
                    color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
                });
            }

            // Update cache
            const cacheKey = `${S.selectedSymbol}_${S.currentTimeframe}`;
            if (S.candleCache[cacheKey]) {
                const arr = S.candleCache[cacheKey].data;
                const existing = arr.findIndex(c => c.time === candle.time);
                const fullCandle = { ...candle, volume: parseFloat(k.v) };
                if (existing >= 0) arr[existing] = fullCandle;
                else arr.push(fullCandle);
                S.candleCache[cacheKey].lastTime = candle.time * 1000;

                // Debounced write-through to localStorage (every 30s)
                if (!S._candleStorageTimer) {
                    S.set('_candleStorageTimer', setTimeout(() => {
                        S.set('_candleStorageTimer', null);
                        const cc = S.candleCache[cacheKey];
                        if (cc) saveToStorage(S.selectedSymbol, S.currentTimeframe, cc.data, cc.lastTime);
                    }, 30000));
                }
            }

            // Update current price display
            S.set('currentPrice', candle.close);
            const priceEl = document.getElementById('sym-price');
            if (priceEl) priceEl.textContent = formatPrice(candle.close);

            for (const [, pos] of S._positionMap) {
                if (pos.symbol === S.selectedSymbol) pos.markPrice = candle.close;
            }
            _schedulePnlUiRefresh();
            onTrailPriceTick(candle.close);
        }));
    }

    // Depth stream
    S.set('_depthUnsub', streams.subscribe(`${symbol}@depth10@100ms`, (data) => {
        if (!S._tradingMounted) return;
        S.set('orderBookAsks', (data.a || data.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]));
        S.set('orderBookBids', (data.b || data.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]));
        scheduleOrderBookRender(data.E || Date.now());

        // Live-update chase line from frontend orderbook feed
        onChaseDepthTick();
    }));

    // Trade stream
    S.set('_tradeUnsub', streams.subscribe(`${symbol}@trade`, (data) => {
        if (!S._tradingMounted) return;
        S.recentTrades.unshift({
            price: parseFloat(data.p),
            qty: parseFloat(data.q),
            time: data.T,
            isBuyerMaker: data.m,
        });
        if (S.recentTrades.length > 50) S.recentTrades.length = 50;
        scheduleTradeTapeRender(data.T || Date.now());
    }));

    // Ticker stream (24h stats)
    S.set('_tickerUnsub', streams.subscribe(`${symbol}@ticker`, (data) => {
        if (!S._tradingMounted) return;

        const pctChange = parseFloat(data.P);
        const absChange = parseFloat(data.p);

        const changeEl = document.getElementById('sym-24h');
        if (changeEl) {
            changeEl.textContent = `${formatPrice(absChange)} ${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`;
            changeEl.className = `sym-stat-value ${pctChange >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
        }

        const highEl = document.getElementById('sym-high');
        if (highEl) highEl.textContent = data.h ? formatPrice(parseFloat(data.h)) : '—';
        const lowEl = document.getElementById('sym-low');
        if (lowEl) lowEl.textContent = data.l ? formatPrice(parseFloat(data.l)) : '—';

        const volEl = document.getElementById('sym-vol');
        if (volEl) {
            const qv = parseFloat(data.q);
            volEl.textContent = qv ? (qv >= 1e9 ? `${(qv / 1e9).toFixed(2)}B` : qv >= 1e6 ? `${(qv / 1e6).toFixed(2)}M` : qv >= 1e3 ? `${(qv / 1e3).toFixed(1)}K` : qv.toFixed(0)) : '—';
        }
    }));
}

// ── App-Level Event Handlers ────────────────────

export function setupAppEventListeners() {
    setupTradingAppEventListeners({ schedulePnlUiRefresh: _schedulePnlUiRefresh });
}

// ── Compact-position poll ───────────────────────

export function startCompactPoll() {
    if (S._compactPollInterval) clearInterval(S._compactPollInterval);

    lastFallbackPositionSyncTs = 0;
    S.set('_compactPollInterval', setInterval(() => {
        if (!S._tradingMounted) return;

        _schedulePnlUiRefresh();

        const now = Date.now();
        // Force a full position+account resync every 10s to catch any post-HFT desyncs
        if ((now - lastFallbackPositionSyncTs) > 10000) {
            lastFallbackPositionSyncTs = now;
            scheduleTradingRefresh({ positions: true, account: true }, 0);
        }
    }, 2000));
}

export function stopCompactPoll() {
    if (S._compactPollInterval) { clearInterval(S._compactPollInterval); S.set('_compactPollInterval', null); }
    if (pnlUiRafId != null) {
        cancelAnimationFrame(pnlUiRafId);
        pnlUiRafId = null;
    }
}

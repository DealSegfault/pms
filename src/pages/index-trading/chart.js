import { api, formatPrice } from '../../core/index.js';
import { streams } from '../../lib/binance-streams.js';
import { st } from './state.js';
import { loadFromStorage, saveToStorage } from '../trading/candle-storage.js';
import { dedupeByTime } from '../trading/chart.js';
import { getActiveBaskets } from './active-baskets.js';

// ── In-memory kline cache ────────────────────────
// Key: `${symbol}|${interval}` → { data: candle[], lastTimeMs: number, fetchedAt: number }
const klineMemCache = new Map();
const KLINE_MEM_TTL_MS = 90_000; // 90s — within TTL we skip API entirely

function klineKey(symbol, interval) { return `${symbol}|${interval}`; }

function getMemCached(symbol, interval) {
    const entry = klineMemCache.get(klineKey(symbol, interval));
    if (!entry || !entry.data.length) return null;
    return entry;
}

function setMemCached(symbol, interval, data) {
    if (!data.length) return;
    const lastTimeMs = data[data.length - 1].time * 1000;
    klineMemCache.set(klineKey(symbol, interval), { data, lastTimeMs, fetchedAt: Date.now() });
}

// ── Helpers ──────────────────────────────────────

export function cleanupCompositeStreams() {
    for (const sym of Object.keys(st.compositeStreamUnsubs)) {
        try { st.compositeStreamUnsubs[sym](); } catch { }
    }
    st.compositeStreamUnsubs = {};
}

function streamSymbolFromMarketSymbol(symbol) {
    const raw = String(symbol || '').replace('/', '').replace(':USDT', '').toLowerCase();
    return raw.endsWith('usdt') ? raw : `${raw}usdt`;
}

function intervalToSeconds(interval) {
    const map = {
        '1m': 60, '5m': 300, '15m': 900,
        '1h': 3600, '4h': 14400, '1d': 86400,
    };
    return map[interval] || 300;
}

function toFixedNum(value, digits = 4) {
    return Number.parseFloat(Number(value).toFixed(digits));
}

export function updateCompositePriceDisplay(lastClose) {
    const priceEl = document.getElementById('idx-price');
    if (!priceEl || !Number.isFinite(lastClose)) return;
    const change = lastClose - 100;
    const color = change >= 0 ? 'var(--green)' : 'var(--red)';
    priceEl.innerHTML = `<span style="font-family:var(--font-mono); font-weight:700;">${lastClose.toFixed(2)}</span> <span style="color:${color}; font-size:12px; font-weight:600;">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</span>`;
}

function computeCompositeBarAtTime(context, time) {
    if (!context) return null;
    const { constituents, totalWeight, initPrices } = context;
    if (!Array.isArray(constituents) || totalWeight <= 0) return null;

    let open = 0, high = 0, low = 0, close = 0, totalVol = 0;

    for (const tm of constituents) {
        const candle = tm.map.get(time);
        const initPrice = initPrices[tm.symbol];
        if (!candle || !initPrice) return null;

        const weight = Math.abs(tm.factor) / totalWeight;
        const direction = tm.factor > 0 ? 1 : -1;
        const project = (field) => weight * (100 + direction * (((candle[field] / initPrice) * 100) - 100));

        open += project('o');
        high += project('h');
        low += project('l');
        close += project('c');
        totalVol += candle.qv || 0;
    }

    const realHigh = Math.max(open, high, low, close);
    const realLow = Math.min(open, high, low, close);
    return {
        time,
        open: toFixedNum(open, 4),
        high: toFixedNum(realHigh, 4),
        low: toFixedNum(realLow, 4),
        close: toFixedNum(close, 4),
        volume: toFixedNum(totalVol, 2),
        volumeColor: close >= open ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)',
    };
}

function subscribeCompositeStreams(context, loadVersion) {
    cleanupCompositeStreams();
    if (!context || !Array.isArray(context.constituents)) return;

    for (const constituent of context.constituents) {
        const sym = constituent.symbol;
        const wsSymbol = streamSymbolFromMarketSymbol(sym);
        const streamName = `${wsSymbol}@kline_${context.interval}`;

        st.compositeStreamUnsubs[sym] = streams.subscribe(streamName, (data) => {
            try {
                if (loadVersion !== st.compositeLoadVersion) return;
                if (!st.chartReady || !st.compositeSeries || !st.compositeContext) return;
                const k = data?.k;
                if (!k) return;

                const time = Number(k.t) / 1000;
                if (!Number.isFinite(time)) return;

                const nextBar = {
                    o: Number(k.o), h: Number(k.h),
                    l: Number(k.l), c: Number(k.c),
                    v: Number(k.v) || 0, qv: Number(k.q) || 0,
                };
                if (![nextBar.o, nextBar.h, nextBar.l, nextBar.c].every(Number.isFinite)) return;

                constituent.map.set(time, nextBar);
                // Also update in-memory cache with latest bar
                const memEntry = getMemCached(sym, context.interval);
                if (memEntry) {
                    const candleObj = { time, open: nextBar.o, high: nextBar.h, low: nextBar.l, close: nextBar.c, volume: nextBar.qv };
                    const lastIdx = memEntry.data.findIndex(c => c.time === time);
                    if (lastIdx >= 0) { memEntry.data[lastIdx] = candleObj; }
                    else { memEntry.data.push(candleObj); }
                    memEntry.lastTimeMs = time * 1000;
                }
                while (constituent.map.size > 1600) {
                    const oldest = constituent.map.keys().next().value;
                    if (oldest == null) break;
                    constituent.map.delete(oldest);
                }

                const compositeBar = computeCompositeBarAtTime(context, time);
                if (!compositeBar) return;

                st.compositeSeries.update({
                    time: compositeBar.time,
                    open: compositeBar.open,
                    high: compositeBar.high,
                    low: compositeBar.low,
                    close: compositeBar.close,
                });
                if (st.volumeSeries) {
                    st.volumeSeries.update({
                        time: compositeBar.time,
                        value: compositeBar.volume,
                        color: compositeBar.volumeColor,
                    });
                }
                updateCompositePriceDisplay(compositeBar.close);
            } catch { }
        });
    }
}

// ── Kline fetching with multi-tier cache ─────────

async function fetchKlinesForSymbol(symbol, interval) {
    const now = Date.now();

    // 1. Check in-memory cache first (fastest path)
    const mem = getMemCached(symbol, interval);
    if (mem && mem.data.length > 0 && (now - mem.fetchedAt) < KLINE_MEM_TTL_MS) {
        return mem.data;
    }

    // 2. Try localStorage cache + delta fetch
    const cached = loadFromStorage(symbol, interval);
    let finalCandles = [];

    if (cached && cached.data.length > 0) {
        try {
            const params = { symbol, interval, startTime: cached.lastTime + 1, limit: 500 };
            const delta = await api(`/trade/klines?${new URLSearchParams(params)}`);
            if (Array.isArray(delta) && delta.length > 0) {
                const newCandles = delta.map(k => ({
                    time: k[0] / 1000,
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[7]),
                }));
                finalCandles = dedupeByTime([...cached.data, ...newCandles]);
                saveToStorage(symbol, interval, finalCandles, finalCandles[finalCandles.length - 1].time * 1000);
            } else {
                finalCandles = cached.data;
            }
        } catch {
            finalCandles = cached.data;
        }
    } else {
        // 3. Full fetch
        const params = { symbol, interval, limit: 500 };
        const data = await api(`/trade/klines?${new URLSearchParams(params)}`);
        if (Array.isArray(data)) {
            finalCandles = data.map(k => ({
                time: k[0] / 1000,
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[7]),
            }));
            if (finalCandles.length > 0) {
                saveToStorage(symbol, interval, finalCandles, finalCandles[finalCandles.length - 1].time * 1000);
            }
        }
    }

    // Store in-memory
    if (finalCandles.length > 0) setMemCached(symbol, interval, finalCandles);
    return finalCandles;
}

// ── Build constituents from cached data ──────────

function buildConstituentsFromCache(formula, interval) {
    const constituents = [];
    for (const f of formula) {
        const mem = getMemCached(f.symbol, interval);
        if (!mem || mem.data.length === 0) return null; // missing data — need fetch
        const map = new Map();
        for (const c of mem.data) {
            map.set(c.time, { o: c.open, h: c.high, l: c.low, c: c.close, v: 0, qv: c.volume });
        }
        constituents.push({ map, factor: f.factor, symbol: f.symbol });
    }
    return constituents;
}

function computeFullComposite(constituents, formula) {
    const totalWeight = formula.reduce((s, f) => s + Math.abs(f.factor), 0);
    if (totalWeight === 0) return null;

    const allTimes = new Set();
    constituents.forEach(tm => tm.map.forEach((_, t) => allTimes.add(t)));
    const sortedTimes = [...allTimes].sort((a, b) => a - b);
    if (sortedTimes.length === 0) return null;

    const initPrices = {};
    for (const tm of constituents) {
        for (const t of sortedTimes) {
            if (tm.map.has(t)) { initPrices[tm.symbol] = tm.map.get(t).c; break; }
        }
    }

    const context = {
        interval: st.currentTimeframe,
        intervalSeconds: intervalToSeconds(st.currentTimeframe),
        totalWeight, initPrices, constituents,
    };

    const candleData = [];
    const volData = [];
    let lastClose = null;

    for (const t of sortedTimes) {
        const bar = computeCompositeBarAtTime(context, t);
        if (!bar) continue;
        candleData.push({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        volData.push({ time: bar.time, value: bar.volume, color: bar.volumeColor });
        lastClose = bar.close;
    }

    return { context, candleData, volData, lastClose };
}

// ── Public API ───────────────────────────────────

export function initChart() {
    const container = document.getElementById('idx-chart');
    if (!container || typeof LightweightCharts === 'undefined') {
        setTimeout(initChart, 300);
        return;
    }

    if (container.clientWidth === 0 || container.clientHeight === 0) {
        requestAnimationFrame(() => setTimeout(initChart, 50));
        return;
    }

    if (st.chart) { try { st.chart.remove(); } catch { } st.chart = null; }
    st.chartReady = false;

    const w = container.clientWidth || 600;
    const h = container.clientHeight || 400;

    st.chart = LightweightCharts.createChart(container, {
        layout: {
            background: { type: 'solid', color: '#0a0e17' },
            textColor: '#8b95a8',
            fontFamily: "'Inter', sans-serif",
            fontSize: 11,
        },
        grid: {
            vertLines: { color: 'rgba(255,255,255,0.04)' },
            horzLines: { color: 'rgba(255,255,255,0.06)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(99,102,241,0.3)', labelBackgroundColor: '#6366f1' },
            horzLine: { color: 'rgba(99,102,241,0.3)', labelBackgroundColor: '#6366f1' },
        },
        timeScale: {
            borderColor: 'rgba(255,255,255,0.06)',
            timeVisible: true,
            secondsVisible: false,
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        handleScroll: { vertTouchDrag: true },
        width: w,
        height: h,
    });

    st.compositeSeries = st.chart.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: 'rgba(34,197,94,0.6)', wickDownColor: 'rgba(239,68,68,0.6)',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    st.volumeSeries = st.chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
    });
    st.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    st.chartReady = true;

    const ro = new ResizeObserver(() => {
        if (st.chart && container.clientWidth > 0 && container.clientHeight > 0) {
            st.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
        }
    });
    ro.observe(container);
    st.cleanupFns.push(() => ro.disconnect());
}

/**
 * Recompute the composite chart from in-memory cached klines.
 * This is INSTANT (no API calls) — used when only weights/sides change.
 * Returns true if it succeeded (all symbols were in cache).
 */
export function recomputeCompositeFromCache() {
    if (!st.selectedIndex || !st.chartReady || !st.compositeSeries) return false;
    const formula = st.selectedIndex.formula;
    const totalWeight = formula.reduce((s, f) => s + Math.abs(f.factor), 0);
    if (totalWeight === 0) return false;

    const constituents = buildConstituentsFromCache(formula, st.currentTimeframe);
    if (!constituents) return false; // some symbols not cached yet

    const result = computeFullComposite(constituents, formula);
    if (!result || result.candleData.length === 0) return false;

    const loadVersion = ++st.compositeLoadVersion;
    st.compositeContext = result.context;

    st.compositeSeries.setData(result.candleData);
    if (st.volumeSeries) st.volumeSeries.setData(result.volData);
    st.chart.timeScale().fitContent();
    st.chart.priceScale('right').applyOptions({ autoScale: true });

    if (result.lastClose != null) updateCompositePriceDisplay(result.lastClose);
    updateEntryMarkers(result.candleData);
    subscribeCompositeStreams(result.context, loadVersion);
    return true;
}

/**
 * Full load: fetch klines (with caching) then compute composite.
 * This is the entry point for initial load / timeframe change / new symbol addition.
 */
export async function loadCompositeChart() {
    if (!st.selectedIndex || !st.chartReady || !st.compositeSeries) return;

    const formula = st.selectedIndex.formula;
    const totalWeight = formula.reduce((s, f) => s + Math.abs(f.factor), 0);
    if (totalWeight === 0) return;

    // Try instant recompute first — no API calls if all symbols cached
    if (recomputeCompositeFromCache()) return;

    const loadVersion = ++st.compositeLoadVersion;
    cleanupCompositeStreams();
    const selectedIdAtStart = st.selectedIndex.id;

    try {
        // Fetch klines in parallel (cache-aware — only missing data fetched)
        const results = await Promise.all(formula.map(async f => {
            try {
                const data = await fetchKlinesForSymbol(f.symbol, st.currentTimeframe);
                return { symbol: f.symbol, factor: f.factor, data };
            } catch (err) {
                console.warn(`[Index] Failed to fetch klines for ${f.symbol}:`, err);
                return { symbol: f.symbol, factor: f.factor, data: [] };
            }
        }));

        if (loadVersion !== st.compositeLoadVersion) return;
        if (!st.selectedIndex || st.selectedIndex.id !== selectedIdAtStart) return;

        const constituents = results.map(r => {
            const map = new Map();
            for (const c of r.data) {
                map.set(c.time, { o: c.open, h: c.high, l: c.low, c: c.close, v: 0, qv: c.volume });
            }
            return { map, factor: r.factor, symbol: r.symbol };
        });

        const allTimes = new Set();
        constituents.forEach(tm => tm.map.forEach((_, t) => allTimes.add(t)));
        const sortedTimes = [...allTimes].sort((a, b) => a - b);
        if (sortedTimes.length === 0) return;

        const initPrices = {};
        for (const tm of constituents) {
            for (const t of sortedTimes) {
                if (tm.map.has(t)) { initPrices[tm.symbol] = tm.map.get(t).c; break; }
            }
        }
        const context = {
            interval: st.currentTimeframe,
            intervalSeconds: intervalToSeconds(st.currentTimeframe),
            totalWeight, initPrices, constituents,
        };
        st.compositeContext = context;

        const candleData = [];
        const volData = [];
        let lastClose = null;

        for (const t of sortedTimes) {
            const bar = computeCompositeBarAtTime(context, t);
            if (!bar) continue;
            candleData.push({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
            volData.push({ time: bar.time, value: bar.volume, color: bar.volumeColor });
            lastClose = bar.close;
        }

        if (loadVersion !== st.compositeLoadVersion) return;

        st.compositeSeries.setData(candleData);
        if (st.volumeSeries) st.volumeSeries.setData(volData);
        st.chart.timeScale().fitContent();
        st.chart.priceScale('right').applyOptions({ autoScale: true });

        if (lastClose != null) updateCompositePriceDisplay(lastClose);
        updateEntryMarkers(candleData);
        subscribeCompositeStreams(context, loadVersion);
    } catch (err) {
        console.error('[Index] Failed to load composite chart:', err);
    }
}

// ── Entry price markers on chart ─────────────────

export function updateEntryMarkers(candleData) {
    if (!st.compositeSeries || !st.selectedIndex) return;

    // Remove old entry price line(s)
    if (st._entryPriceLines) {
        for (const line of st._entryPriceLines) {
            try { st.compositeSeries.removePriceLine(line); } catch { }
        }
    }
    st._entryPriceLines = [];

    const baskets = getActiveBaskets();
    const idx = st.selectedIndex;
    const matching = baskets.filter(b => {
        if (b.indexId && idx.id) return b.indexId === idx.id;
        return String(b.indexName || '') === String(idx.name || '');
    });

    if (matching.length === 0) {
        st.compositeSeries.setMarkers([]);
        return;
    }

    // Build a map of candle time → close for quick lookup
    const data = candleData || [];
    const closeByTime = new Map();
    for (const c of data) closeByTime.set(c.time, c);
    const times = data.map(c => c.time).sort((a, b) => a - b);

    const intervalSec = intervalToSeconds(st.currentTimeframe);
    const markers = [];

    for (const basket of matching) {
        const entryMs = basket.timestamp || basket.lastExecutionAt;
        if (!entryMs) continue;
        const rawTimeSec = Math.floor(entryMs / 1000);
        // Snap to candle boundary
        const snapped = Math.floor(rawTimeSec / intervalSec) * intervalSec;

        // Find nearest candle time
        let bestTime = snapped;
        if (!closeByTime.has(snapped) && times.length > 0) {
            // Find the closest candle time
            let lo = 0, hi = times.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (times[mid] < snapped) lo = mid + 1;
                else hi = mid;
            }
            // Check lo and lo-1 for closest
            if (lo > 0 && Math.abs(times[lo - 1] - snapped) < Math.abs(times[lo] - snapped)) {
                bestTime = times[lo - 1];
            } else {
                bestTime = times[lo];
            }
        }

        const candle = closeByTime.get(bestTime);
        if (!candle) continue;

        const isLong = basket.direction === 'LONG';
        const entryValue = candle.close;

        markers.push({
            time: bestTime,
            position: isLong ? 'belowBar' : 'aboveBar',
            color: isLong ? '#22c55e' : '#ef4444',
            shape: isLong ? 'arrowUp' : 'arrowDown',
            text: `${basket.direction} @ ${entryValue.toFixed(2)}`,
        });

        // Add a horizontal price line at the entry composite value
        const priceLine = st.compositeSeries.createPriceLine({
            price: entryValue,
            color: isLong ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)',
            lineWidth: 1,
            lineStyle: 2,  // dashed
            axisLabelVisible: true,
            title: `${basket.direction} Entry`,
        });
        st._entryPriceLines.push(priceLine);
    }

    markers.sort((a, b) => a.time - b.time);
    st.compositeSeries.setMarkers(markers);
}

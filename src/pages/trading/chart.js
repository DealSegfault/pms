// ── Trading Page – Chart Logic ───────────────────────────────
import { state, api, showToast, formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { loadChartAnnotations, refreshChartLeftAnnotationLabels } from './chart-annotations.js';
import { loadFromStorage, saveToStorage, clearSymbolCache } from './candle-storage.js';

// ── Chart ────────────────────────────────────────

export function resetChart() {
    Object.keys(S.candleCache).forEach(k => {
        if (k.startsWith(S.selectedSymbol)) delete S.candleCache[k];
    });
    clearSymbolCache(S.selectedSymbol);
    initChart();
    fetchSymbolInfo(S.selectedSymbol);
}

export function initChart() {
    const container = document.getElementById('tv-chart');
    if (!container || typeof LightweightCharts === 'undefined') {
        console.warn('[Chart] LightweightCharts not available, retrying...');
        setTimeout(initChart, 500);
        return;
    }

    const staleLeftLabels = document.getElementById('chart-left-annotation-layer');
    if (staleLeftLabels) {
        try { staleLeftLabels.remove(); } catch { }
    }

    if (S.chartResizeObserver) {
        try { S.chartResizeObserver.disconnect(); } catch { }
        S.set('chartResizeObserver', null);
    }

    if (S.chart) { try { S.chart.remove(); } catch { } S.set('chart', null); }
    S.set('chartReady', false);

    const newChart = LightweightCharts.createChart(container, {
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
            secondsVisible: S.currentTimeframe === '1s',
        },
        rightPriceScale: {
            borderColor: 'rgba(255,255,255,0.06)',
            entireTextOnly: false,
            ticksVisible: true,
        },
        handleScroll: { vertTouchDrag: true },
        width: container.clientWidth,
        height: container.clientHeight,
    });
    S.set('chart', newChart);

    const cs = S.chart.addCandlestickSeries({
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderUpColor: '#22c55e',
        borderDownColor: '#ef4444',
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
    });
    S.set('candleSeries', cs);

    // Apply saved chart settings (or defaults)
    let csTop = 0.05, csBot = 0.15, csPrec = 4, csGrid = 0.06;
    try {
        const saved = JSON.parse(localStorage.getItem('chart_settings'));
        if (saved) {
            csTop = saved.top ?? csTop;
            csBot = saved.bot ?? csBot;
            csPrec = saved.prec ?? csPrec;
            csGrid = saved.gridOp ?? csGrid;
        }
    } catch { }

    S.candleSeries.priceScale().applyOptions({
        scaleMargins: { top: csTop, bottom: csBot },
    });
    S.candleSeries.applyOptions({
        priceFormat: { type: 'price', precision: csPrec, minMove: 1 / Math.pow(10, csPrec) },
    });
    S.chart.applyOptions({
        grid: {
            horzLines: { color: `rgba(255,255,255,${csGrid})` },
            vertLines: { color: `rgba(255,255,255,${csGrid})` },
        },
    });



    const vs = S.chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: '',
    });
    S.set('volumeSeries', vs);

    S.volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
    });

    S.set('chartReady', true);

    // Keep custom left-side annotation labels aligned while panning/zooming.
    S.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        refreshChartLeftAnnotationLabels();
    });

    // Chart click → fill limit price input (LIMIT mode) or TWAP price limit (TWAP mode)
    S.chart.subscribeClick((param) => {
        if (!param.point || S.scaleMode || S.measureMode) return;
        const price = S.candleSeries.coordinateToPrice(param.point.y);
        if (price == null || price <= 0) return;

        if (S.orderType === 'LIMIT') {
            const priceInput = document.getElementById('limit-price');
            if (priceInput) {
                priceInput.value = formatPrice(price);
                showToast(`Limit price set to $${formatPrice(price)}`, 'info');
            }
        } else if (S.orderType === 'TWAP') {
            const twapInput = document.getElementById('twap-price-limit');
            if (twapInput) {
                twapInput.value = formatPrice(price);
                const label = S.selectedSide === 'SHORT' ? 'Min sell' : 'Max buy';
                showToast(`${label} price set to $${formatPrice(price)}`, 'info');
            }
        }
    });

    // Clear any stale data
    S.candleSeries.setData([]);
    S.volumeSeries.setData([]);

    // Load historical candles for CURRENT symbol
    loadCandles(S.currentTimeframe);

    // Handle resize
    const ro = new ResizeObserver(() => {
        if (S.chart && container.clientWidth > 0 && container.clientHeight > 0) {
            S.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
            refreshChartLeftAnnotationLabels();
        }
    });
    ro.observe(container);
    S.set('chartResizeObserver', ro);
}

export async function loadCandles(interval) {
    if (!S.chartReady || !S.candleSeries) return;

    // ── 1s: skip localStorage cache; REST now provides aggTrade-based history ──
    if (interval === '1s') {
        try {
            const params = new URLSearchParams({ symbol: S.selectedSymbol, interval: '1s', limit: '900' });
            const data = await api(`/trade/klines?${params}`);
            if (Array.isArray(data) && data.length > 0) {
                const candles = data.map(klineToCandle);
                S.candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
                if (S.volumeSeries) S.volumeSeries.setData(data.map(klineToVolume));
                S.chart.timeScale().fitContent();
            } else {
                S.candleSeries.setData([]);
                if (S.volumeSeries) S.volumeSeries.setData([]);
            }
        } catch { }
        loadChartAnnotations();
        import('./trail-stop.js').then(m => m.fetchAndDrawActiveTrailStops()).catch(() => { });
        requestAnimationFrame(() => {
            requestAnimationFrame(() => { autoDetectPrecision(); applyStoredChartSettings(); });
        });
        return;
    }

    const cacheKey = `${S.selectedSymbol}_${interval}`;

    // Hydrate in-memory cache from localStorage if empty
    if (!S.candleCache[cacheKey]) {
        const stored = loadFromStorage(S.selectedSymbol, interval);
        if (stored) {
            S.candleCache[cacheKey] = stored;
        }
    }

    const cached = S.candleCache[cacheKey];

    try {
        const params = { symbol: S.selectedSymbol, interval };

        if (cached && cached.data.length > 0) {
            const lastTime = cached.lastTime;
            params.startTime = lastTime + 1;
            params.limit = 500;

            const data = await api(`/trade/klines?${new URLSearchParams(params)}`);

            if (Array.isArray(data) && data.length > 0) {
                const newCandles = data.map(klineToCandle);
                const mergedCandles = [...cached.data.slice(0, -1), ...newCandles];
                const allCandles = dedupeByTime(mergedCandles);

                S.candleSeries.setData(allCandles.map(c => ({
                    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
                })));
                S.volumeSeries.setData(allCandles.map(c => ({
                    time: c.time, value: c.volume,
                    color: c.close >= c.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
                })));

                const lt = allCandles[allCandles.length - 1].time * 1000;
                S.candleCache[cacheKey] = { data: allCandles, lastTime: lt };
                saveToStorage(S.selectedSymbol, interval, allCandles, lt);
            } else {
                // No new data — serve from cache as-is
                S.candleSeries.setData(cached.data.map(c => ({
                    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
                })));
                S.volumeSeries.setData(cached.data.map(c => ({
                    time: c.time, value: c.volume,
                    color: c.close >= c.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
                })));
            }
        } else {
            params.limit = 500;
            const data = await api(`/trade/klines?${new URLSearchParams(params)}`);

            if (!Array.isArray(data) || data.length === 0) {
                console.warn('[Chart] No kline data received');
                return;
            }

            const candles = data.map(klineToCandle);
            const volumes = data.map(klineToVolume);

            S.candleSeries.setData(candles.map(c => ({
                time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
            })));
            S.volumeSeries.setData(volumes);

            const lt = candles[candles.length - 1].time * 1000;
            S.candleCache[cacheKey] = { data: candles, lastTime: lt };
            saveToStorage(S.selectedSymbol, interval, candles, lt);
        }

        S.chart.timeScale().fitContent();

        loadChartAnnotations();

        // Draw active trail stops for this symbol on chart
        import('./trail-stop.js').then(m => m.fetchAndDrawActiveTrailStops()).catch(() => { });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                autoDetectPrecision();
                applyStoredChartSettings();
            });
        });
    } catch (err) {
        console.error('[Chart] Failed to load candles:', err);
    }
}

export function applyStoredChartSettings() {
    if (!S.chart || !S.candleSeries) return;

    let csTop = 0.05, csBot = 0.15, csGrid = 0.06;
    try {
        const saved = JSON.parse(localStorage.getItem('chart_settings'));
        if (saved) {
            csTop = saved.top ?? csTop;
            csBot = saved.bot ?? csBot;
            csGrid = saved.gridOp ?? csGrid;
        }
    } catch { }

    S.candleSeries.priceScale().applyOptions({
        scaleMargins: { top: csTop, bottom: csBot },
    });
    S.chart.applyOptions({
        grid: {
            horzLines: { color: `rgba(255,255,255,${csGrid})` },
            vertLines: { color: `rgba(255,255,255,${csGrid})` },
        },
    });
}

export function autoDetectPrecision() {
    if (!S.candleSeries) return;

    try {
        const saved = JSON.parse(localStorage.getItem('chart_settings'));
        if (saved?.prec != null) {
            const prec = saved.prec;
            S.candleSeries.applyOptions({
                priceFormat: { type: 'price', precision: prec, minMove: 1 / Math.pow(10, prec) },
            });
            return;
        }
    } catch { }

    if (S.symbolInfo?.pricePrecision != null) {
        const prec = S.symbolInfo.pricePrecision;
        S.candleSeries.applyOptions({
            priceFormat: { type: 'price', precision: prec, minMove: 1 / Math.pow(10, prec) },
        });
        return;
    }

    const cacheKey = `${S.selectedSymbol}_${S.currentTimeframe}`;
    const cached = S.candleCache[cacheKey];
    if (!cached?.data?.length) return;

    let maxDecimals = 2;
    const sample = cached.data.slice(-100);
    for (const c of sample) {
        for (const val of [c.open, c.high, c.low, c.close]) {
            const str = val.toString();
            const dotIdx = str.indexOf('.');
            if (dotIdx >= 0) {
                const decimals = str.length - dotIdx - 1;
                if (decimals > maxDecimals) maxDecimals = decimals;
            }
        }
    }
    maxDecimals = Math.min(maxDecimals, 8);

    S.candleSeries.applyOptions({
        priceFormat: { type: 'price', precision: maxDecimals, minMove: 1 / Math.pow(10, maxDecimals) },
    });
}

export function klineToCandle(k) {
    return {
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[7]),
    };
}

export function klineToVolume(k) {
    return {
        time: k[0] / 1000,
        value: parseFloat(k[7]),
        color: parseFloat(k[4]) >= parseFloat(k[1]) ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
    };
}

export function dedupeByTime(candles) {
    const seen = new Map();
    for (const c of candles) {
        seen.set(c.time, c);
    }
    return Array.from(seen.values()).sort((a, b) => a.time - b.time);
}

export function setTimeframe(tf) {
    S.set('currentTimeframe', tf);
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));

    // Reconnect kline stream (use dynamic import to break circular dep)
    import('./ws-handlers.js').then(({ teardownStreams, initWebSockets }) => {
        teardownStreams();
        const container = document.getElementById('tv-chart');
        const isMobile = (container?.clientWidth || window.innerWidth) < 768;
        loadCandles(tf).then(() => { if (!isMobile) autoscaleChart(); });
        initWebSockets();
    });
}

export function autoscaleChart() {
    if (!S.chart || !S.candleSeries || !S.chartReady) return;

    const container = document.getElementById('tv-chart');
    const isMobile = (container?.clientWidth || window.innerWidth) < 768;

    const barsByTf = {
        '1s': isMobile ? 90 : 180,
        '1m': isMobile ? 40 : 60,
        '5m': isMobile ? 36 : 60,
        '15m': isMobile ? 32 : 48,
        '1h': isMobile ? 30 : 48,
        '4h': isMobile ? 28 : 42,
        '1d': isMobile ? 20 : 30,
    };

    // Enable/disable seconds on the time axis depending on TF
    if (S.chart) {
        S.chart.applyOptions({
            timeScale: { secondsVisible: S.currentTimeframe === '1s' },
        });
    }

    const marginsByScreen = isMobile
        ? { top: 0.02, bottom: 0.08 }
        : { top: 0.05, bottom: 0.12 };

    S.candleSeries.priceScale().applyOptions({
        scaleMargins: marginsByScreen,
        autoScale: true,
    });

    let csGrid = 0.06;
    try {
        const saved = JSON.parse(localStorage.getItem('chart_settings'));
        if (saved?.gridOp != null) csGrid = saved.gridOp;
    } catch { }
    S.chart.applyOptions({
        grid: {
            horzLines: { color: `rgba(255,255,255,${csGrid})` },
            vertLines: { color: `rgba(255,255,255,${csGrid})` },
        },
    });

    const barsToShow = barsByTf[S.currentTimeframe] || 50;
    const cacheKey = `${S.selectedSymbol}_${S.currentTimeframe}`;
    const cached = S.candleCache[cacheKey];

    if (cached?.data?.length > 0) {
        const totalBars = cached.data.length;
        const from = Math.max(0, totalBars - barsToShow);
        S.chart.timeScale().setVisibleLogicalRange({
            from,
            to: totalBars + 2,
        });
    } else {
        S.chart.timeScale().fitContent();
    }

    if (container && container.clientWidth > 0 && container.clientHeight > 0) {
        S.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }



    try {
        const existing = JSON.parse(localStorage.getItem('chart_settings')) || {};
        existing.top = marginsByScreen.top;
        existing.bot = marginsByScreen.bottom;
        localStorage.setItem('chart_settings', JSON.stringify(existing));
    } catch { }

    showToast('Chart auto-scaled', 'success');
}

export async function fetchTickerData() {
    try {
        const ticker = await api(`/trade/price/${encodeURIComponent(S.selectedSymbol)}`);
        S.set('currentPrice', ticker.mark || ticker.last);

        const priceEl = document.getElementById('sym-price');
        if (priceEl) priceEl.textContent = formatPrice(S.currentPrice);

        const markEl = document.getElementById('sym-mark');
        if (markEl) markEl.textContent = ticker.mark ? formatPrice(ticker.mark) : '—';

        const pctChange = ticker.percentage || 0;
        const absChange = ticker.change || 0;
        const changeEl = document.getElementById('sym-24h');
        if (changeEl) {
            changeEl.textContent = `${formatPrice(absChange)} ${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`;
            changeEl.className = `sym-stat-value ${pctChange >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
        }

        const highEl = document.getElementById('sym-high');
        if (highEl) highEl.textContent = ticker.high ? formatPrice(ticker.high) : '—';
        const lowEl = document.getElementById('sym-low');
        if (lowEl) lowEl.textContent = ticker.low ? formatPrice(ticker.low) : '—';

        const volEl = document.getElementById('sym-vol');
        if (volEl) {
            const qv = ticker.quoteVolume;
            volEl.textContent = qv ? (qv >= 1e9 ? `${(qv / 1e9).toFixed(2)}B` : qv >= 1e6 ? `${(qv / 1e6).toFixed(2)}M` : qv >= 1e3 ? `${(qv / 1e3).toFixed(1)}K` : qv.toFixed(0)) : '—';
        }

        const fundEl = document.getElementById('sym-funding');
        if (fundEl) {
            if (ticker.fundingRate != null) {
                const pct = (ticker.fundingRate * 100).toFixed(4);
                fundEl.textContent = `${pct}%`;
                fundEl.className = `sym-stat-value ${ticker.fundingRate >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
            } else {
                fundEl.textContent = '—';
            }
        }

        const oiEl = document.getElementById('sym-oi');
        if (oiEl) {
            const oi = ticker.openInterest;
            if (oi && S.currentPrice) {
                const oiUsdt = oi * S.currentPrice;
                oiEl.textContent = oiUsdt >= 1e9 ? `${(oiUsdt / 1e9).toFixed(2)}B` : oiUsdt >= 1e6 ? `${(oiUsdt / 1e6).toFixed(2)}M` : oiUsdt >= 1e3 ? `${(oiUsdt / 1e3).toFixed(1)}K` : oiUsdt.toFixed(0);
            } else {
                oiEl.textContent = '—';
            }
        }

        const { updatePreview } = await import('./order-form.js');
        updatePreview();
    } catch (err) {
        console.warn('[Ticker] Failed to fetch:', err.message);
    }
}

export async function fetchSymbolInfo(symbol) {
    try {
        const info = await api(`/trade/symbol-info/${encodeURIComponent(symbol)}`);
        S.set('symbolInfo', info);
        console.log(`[Trade] Symbol info: ${symbol} minNotional=$${info.minNotional} pricePrecision=${info.pricePrecision}`);

        if (S.candleSeries && info.pricePrecision != null) {
            S.candleSeries.applyOptions({
                priceFormat: {
                    type: 'price',
                    precision: info.pricePrecision,
                    minMove: 1 / Math.pow(10, info.pricePrecision),
                },
            });
        }
    } catch (err) {
        console.warn(`[Trade] Failed to fetch symbol info:`, err.message);
        S.set('symbolInfo', null);
    }
}

// ── Measure / Ruler Tool ─────────────────────────────────────
// Uses the chart's NATIVE subscribeClick + subscribeCrosshairMove APIs
// to avoid all issues with the canvas swallowing DOM mouse events.
// Two-click workflow: click1 = start, crosshair shows live preview, click2 = lock.

let _measureStart = null;   // { price, time, x, y }
let _measureBox = null;     // the dashed-rectangle overlay div
let _measureClickUnsub = null;
let _measureCrosshairUnsub = null;
let _measureKeyHandler = null;
let _measurePhase = 0;      // 0=idle, 1=waiting for start click, 2=dragging/preview

export function initMeasureTool() {
    const btn = document.getElementById('measure-tool-btn');
    if (!btn) return;
    btn.addEventListener('click', toggleMeasureMode);
}

function toggleMeasureMode() {
    const next = !S.measureMode;
    S.set('measureMode', next);

    const btn = document.getElementById('measure-tool-btn');
    if (btn) btn.classList.toggle('active', next);

    const container = document.getElementById('tv-chart');
    if (container) container.classList.toggle('measure-cursor', next);

    if (next) {
        enableMeasure();
    } else {
        disableMeasure();
    }
}

function enableMeasure() {
    if (!S.chart || !S.candleSeries) return;

    _measurePhase = 1; // waiting for first click
    clearMeasureOverlay();

    // Subscribe to chart's native click event
    const clickHandler = (param) => {
        if (!param.point || !S.measureMode) return;
        const price = S.candleSeries.coordinateToPrice(param.point.y);
        const time = S.chart.timeScale().coordinateToTime(param.point.x);

        if (_measurePhase === 1) {
            // First click — set start point
            _measureStart = { price, time, x: param.point.x, y: param.point.y };
            _measurePhase = 2;
            clearMeasureOverlay();
        } else if (_measurePhase === 2) {
            // Second click — lock the measurement and deactivate
            deactivateMeasure();
            return;
        }
    };
    S.chart.subscribeClick(clickHandler);
    _measureClickUnsub = () => S.chart.unsubscribeClick(clickHandler);

    // Subscribe to crosshair move for live preview
    const crosshairHandler = (param) => {
        if (_measurePhase !== 2 || !_measureStart || !param.point) return;
        const curPrice = S.candleSeries.coordinateToPrice(param.point.y);
        const curTime = S.chart.timeScale().coordinateToTime(param.point.x);
        drawMeasureOverlay(_measureStart, {
            price: curPrice, time: curTime,
            x: param.point.x, y: param.point.y,
        });
    };
    S.chart.subscribeCrosshairMove(crosshairHandler);
    _measureCrosshairUnsub = () => S.chart.unsubscribeCrosshairMove(crosshairHandler);

    // Escape key to cancel
    const onKey = (e) => { if (e.key === 'Escape') deactivateMeasure(); };
    document.addEventListener('keydown', onKey);
    _measureKeyHandler = onKey;
}

function disableMeasure() {
    if (_measureClickUnsub) { _measureClickUnsub(); _measureClickUnsub = null; }
    if (_measureCrosshairUnsub) { _measureCrosshairUnsub(); _measureCrosshairUnsub = null; }
    if (_measureKeyHandler) {
        document.removeEventListener('keydown', _measureKeyHandler);
        _measureKeyHandler = null;
    }
    _measurePhase = 0;
    _measureStart = null;
    clearMeasureOverlay();

    const container = document.getElementById('tv-chart');
    if (container) container.classList.remove('measure-cursor');
}

export function deactivateMeasure() {
    if (!S.measureMode) return;
    S.set('measureMode', false);
    const btn = document.getElementById('measure-tool-btn');
    if (btn) btn.classList.remove('active');
    disableMeasure();
}

function drawMeasureOverlay(start, end) {
    const container = document.getElementById('tv-chart');
    if (!container || !S.candleSeries) return;

    // Convert prices back to pixel coordinates for the rectangle
    const startY = S.candleSeries.priceToCoordinate(start.price);
    const endY = S.candleSeries.priceToCoordinate(end.price);
    const startX = start.x;
    const endX = end.x;

    if (startY == null || endY == null) return;

    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (!_measureBox) {
        _measureBox = document.createElement('div');
        _measureBox.className = 'measure-overlay';
        container.appendChild(_measureBox);
    }

    _measureBox.style.left = `${left}px`;
    _measureBox.style.top = `${top}px`;
    _measureBox.style.width = `${Math.max(2, width)}px`;
    _measureBox.style.height = `${Math.max(2, height)}px`;

    // Calculations
    const priceDiff = end.price - start.price;
    const pctChange = start.price !== 0 ? (priceDiff / start.price) * 100 : 0;

    let barCount = '';
    let timeDuration = '';
    if (start.time && end.time) {
        const tfSec = { '1s': 1, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
        const interval = tfSec[S.currentTimeframe] || 300;
        const bars = Math.round(Math.abs(end.time - start.time) / interval);
        barCount = `${bars} bar${bars !== 1 ? 's' : ''}`;

        // Human-readable duration
        const totalSec = bars * interval;
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        if (d > 0) timeDuration = `${d}d ${h}h`;
        else if (h > 0) timeDuration = `${h}h ${m}m`;
        else timeDuration = `${m}m`;
    }

    const sign = priceDiff >= 0 ? '+' : '';
    const pctClass = priceDiff >= 0 ? 'up' : 'down';

    let label = _measureBox.querySelector('.measure-label');
    if (!label) {
        label = document.createElement('div');
        label.className = 'measure-label';
        _measureBox.appendChild(label);
    }

    // Smart position
    const cw = container.clientWidth;
    if (left + width + 150 > cw) {
        label.style.right = 'auto';
        label.style.left = '-4px';
        label.style.transform = 'translate(-100%, -50%)';
    } else {
        label.style.left = 'auto';
        label.style.right = '-4px';
        label.style.transform = 'translate(100%, -50%)';
    }

    label.innerHTML = `
        <div class="ml-price">${sign}${formatPrice(priceDiff)}</div>
        <div class="ml-pct ${pctClass}">${sign}${pctChange.toFixed(2)}%</div>
        ${timeDuration ? `<div class="ml-bars">${timeDuration} · ${barCount}</div>` : ''}
    `;
}

function clearMeasureOverlay() {
    if (_measureBox) {
        _measureBox.remove();
        _measureBox = null;
    }
}

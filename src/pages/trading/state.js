// ── Trading Page – Shared State & Constants ──────────────────
// All mutable state lives here. Sub-modules import and mutate directly
// (ES module live bindings keep everything in sync).

// ── Symbol / Side / Leverage / Order ──────────────────────
export let selectedSymbol = localStorage.getItem('pms_last_symbol') || 'BTC/USDT:USDT';
export let rawSymbol = selectedSymbol.replace('/', '').replace(':USDT', '').toLowerCase();
if (!rawSymbol.endsWith('usdt')) rawSymbol += 'usdt';
export let selectedSide = localStorage.getItem('pms_trade_side') || 'LONG';
// ── Per-instrument leverage map (frontend-only) ─────────
let _rawLevMap = {};
try { _rawLevMap = JSON.parse(localStorage.getItem('pms_leverage_map') || '{}'); } catch { }
export let leverageMap = _rawLevMap;
export let leverage = leverageMap[selectedSymbol] || 1;
export let currentPrice = null;
export let cachedMarginInfo = null;
export let orderType = localStorage.getItem('pms_trade_order_type') || 'MARKET';
export let symbolInfo = null;
export let sizePercent = 0;

// ── Scale Order State ────────────────────────────────────
export let scaleMode = false;
export let measureMode = false;
export let scaleUpperPrice = null;
export let scaleLowerPrice = null;
export let scaleDistribution = 'linear';
export let scaleOrderCount = 10;
export let scaleSkew = 0;
export let scaleChartLines = [];
export let scaleClickCount = 0;
export let _scaleClickHandler = null;
export let _scaleBoundaryUpper = null;
export let _scaleBoundaryLower = null;
export let _scaleDragging = null;
export let _scaleDragMoveHandler = null;
export let _scaleDragUpHandler = null;
export let _scaleDragPreviewTimer = null;

// ── Stream / Lifecycle ───────────────────────────────────
export let streamUnsubs = [];
export let _klineUnsub = null;
export let _depthUnsub = null;
export let _tradeUnsub = null;
export let _tradingMounted = false;

// ── Compact Positions Panel State ────────────────────────
export let _compactMarkUnsubs = {};
export let _compactMarkPrices = {};
export let _compactPosListeners = {};
export let _compactPollInterval = null;
export let _chartRiskRefreshTimer = null;
export let _chartAnnotationFingerprint = null;
export let _chartAnnotationForceNext = false;


// ── Live Equity / UPNL ──────────────────────────────────
export let _cachedBalance = 0;
export let _cachedMarginUsed = 0;
export const _positionMap = new Map();
export let _negativeLockState = null;

// ── Document Click Handler ──────────────────────────────
export let _docClickHandler = null;

// ── WS Timing ───────────────────────────────────────────
export let _lastTradingWsPnlTs = 0;

// ── Chart ────────────────────────────────────────────────
export let chart = null;
export let candleSeries = null;
export let volumeSeries = null;
export let chartReady = false;
export let chartResizeObserver = null;

// ── Data Buffers ─────────────────────────────────────────
export let orderBookBids = [];
export let orderBookAsks = [];
export let recentTrades = [];

// ── Chart Annotation Tracking ────────────────────────────
export let chartPriceLines = [];
export const candleCache = {};

// ── Chart Annotations ────────────────────────────────────
export let _chartAnnotationTimer = null;
export let _chartAnnotationCache = null;
export let _chartAnnotationLastFetch = 0;
export let _chartAnnotationGeneration = 0;
export const CHART_ANNOTATION_MIN_INTERVAL = 5000;

// ── Timeframe ────────────────────────────────────────────
export let currentTimeframe = '5m';
export let _candleStorageTimer = null;

// ── Margin / PNL handlers ────────────────────────────────
export let _marginUpdateHandler = null;
export let _pnlUpdateHandler = null;

// ── Edit Mode (prefill-and-update complex orders) ─────────────
// { type: 'TWAP'|'TRAIL'|'CHASE'|'SCALPER', orderId: string }
export let _editState = null;

// ── LocalStorage Helpers ─────────────────────────────────
const LS_SYMBOLS_KEY = 'pms_perp_symbols';
const LS_SYMBOLS_TS_KEY = 'pms_perp_symbols_ts';
const SYMBOL_CACHE_TTL = 30 * 60 * 1000;

export function getCachedSymbols() {
    try {
        const ts = parseInt(localStorage.getItem(LS_SYMBOLS_TS_KEY) || '0');
        if (Date.now() - ts < SYMBOL_CACHE_TTL) {
            const data = localStorage.getItem(LS_SYMBOLS_KEY);
            if (data) return JSON.parse(data);
        }
    } catch { }
    return null;
}

export function setCachedSymbols(symbols) {
    try {
        localStorage.setItem(LS_SYMBOLS_KEY, JSON.stringify(symbols));
        localStorage.setItem(LS_SYMBOLS_TS_KEY, String(Date.now()));
    } catch { }
}

// ── Error Icons ──────────────────────────────────────────
export const ERROR_ICONS = {
    INSUFFICIENT_MARGIN: '⚠️',
    MAX_LEVERAGE_EXCEEDED: '🔒',
    MAX_NOTIONAL_EXCEEDED: '📊',
    MAX_EXPOSURE_EXCEEDED: '📈',
    ACCOUNT_FROZEN: '🧊',
    EXCHANGE_MIN_NOTIONAL: '❌',
    EXCHANGE_REJECTED: '❌',
    EXCHANGE_MARGIN_INSUFFICIENT: '⚠️',
    EXCHANGE_PRECISION: '🔢',
    EXCHANGE_QTY_TOO_SMALL: '❌',
    MARGIN_RATIO_EXCEEDED: '🔴',
    NO_PRICE: '📡',
};

// ── Setters (for reassigning module-level lets from other modules) ────
// ES modules export live bindings for `let`, but reassignment must happen
// in the declaring module. These helpers let sub-modules mutate state.

export function set(key, value) {
    switch (key) {
        case 'selectedSymbol': selectedSymbol = value; break;
        case 'rawSymbol': rawSymbol = value; break;
        case 'selectedSide': selectedSide = value; break;
        case 'leverage': leverage = value; break;
        case 'leverageMap': leverageMap = value; break;
        case 'currentPrice': currentPrice = value; break;
        case 'cachedMarginInfo': cachedMarginInfo = value; break;
        case 'orderType': orderType = value; break;
        case 'symbolInfo': symbolInfo = value; break;
        case 'sizePercent': sizePercent = value; break;
        case 'scaleMode': scaleMode = value; break;
        case 'measureMode': measureMode = value; break;
        case 'scaleUpperPrice': scaleUpperPrice = value; break;
        case 'scaleLowerPrice': scaleLowerPrice = value; break;
        case 'scaleDistribution': scaleDistribution = value; break;
        case 'scaleOrderCount': scaleOrderCount = value; break;
        case 'scaleSkew': scaleSkew = value; break;
        case 'scaleChartLines': scaleChartLines = value; break;
        case 'scaleClickCount': scaleClickCount = value; break;
        case '_scaleClickHandler': _scaleClickHandler = value; break;
        case '_scaleBoundaryUpper': _scaleBoundaryUpper = value; break;
        case '_scaleBoundaryLower': _scaleBoundaryLower = value; break;
        case '_scaleDragging': _scaleDragging = value; break;
        case '_scaleDragMoveHandler': _scaleDragMoveHandler = value; break;
        case '_scaleDragUpHandler': _scaleDragUpHandler = value; break;
        case '_scaleDragPreviewTimer': _scaleDragPreviewTimer = value; break;
        case 'streamUnsubs': streamUnsubs = value; break;
        case '_klineUnsub': _klineUnsub = value; break;
        case '_depthUnsub': _depthUnsub = value; break;
        case '_tradeUnsub': _tradeUnsub = value; break;
        case '_tradingMounted': _tradingMounted = value; break;
        case '_compactMarkUnsubs': _compactMarkUnsubs = value; break;
        case '_compactMarkPrices': _compactMarkPrices = value; break;
        case '_compactPosListeners': _compactPosListeners = value; break;
        case '_compactPollInterval': _compactPollInterval = value; break;
        case '_chartRiskRefreshTimer': _chartRiskRefreshTimer = value; break;
        case '_chartAnnotationFingerprint': _chartAnnotationFingerprint = value; break;
        case '_chartAnnotationForceNext': _chartAnnotationForceNext = value; break;
        case '_cachedBalance': _cachedBalance = value; break;
        case '_cachedMarginUsed': _cachedMarginUsed = value; break;
        case '_negativeLockState': _negativeLockState = value; break;
        case '_docClickHandler': _docClickHandler = value; break;
        case '_lastTradingWsPnlTs': _lastTradingWsPnlTs = value; break;
        case 'chart': chart = value; break;
        case 'candleSeries': candleSeries = value; break;
        case 'volumeSeries': volumeSeries = value; break;
        case 'chartReady': chartReady = value; break;
        case 'chartResizeObserver': chartResizeObserver = value; break;
        case 'orderBookBids': orderBookBids = value; break;
        case 'orderBookAsks': orderBookAsks = value; break;
        case 'recentTrades': recentTrades = value; break;
        case 'chartPriceLines': chartPriceLines = value; break;
        case '_chartAnnotationTimer': _chartAnnotationTimer = value; break;
        case '_chartAnnotationCache': _chartAnnotationCache = value; break;
        case '_chartAnnotationLastFetch': _chartAnnotationLastFetch = value; break;
        case '_chartAnnotationGeneration': _chartAnnotationGeneration = value; break;
        case 'currentTimeframe': currentTimeframe = value; break;
        case '_candleStorageTimer': _candleStorageTimer = value; break;
        case '_marginUpdateHandler': _marginUpdateHandler = value; break;
        case '_pnlUpdateHandler': _pnlUpdateHandler = value; break;
        case '_editState': _editState = value; break;
    }
}

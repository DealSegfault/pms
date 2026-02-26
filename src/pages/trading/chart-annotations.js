// ── Trading Page – Chart Annotations ──
// Draws position entry lines, liquidation lines, open order lines,
// and past trade markers on the TradingView chart.
import { state, api, formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { recordLatency } from './perf-metrics.js';

// ── Constants ───────────────────────────────────────

const LEFT_LABEL_LAYER_ID = 'chart-left-annotation-layer';
const LEFT_LABEL_MIN_GAP_PX = 18;
const CHART_DATA_FORCE_COALESCE_MS = 1500;

// ── State ───────────────────────────────────────────

export let _cachedLeftLabelSpecs = [];

// Live position price-line registry — keyed by `${symbol}|${side}`
// Populated by _drawChartAnnotations, read by compact-positions.js recalcCompactPnl.
export const _positionLineRegistry = new Map(); // key → IPriceLine
export const _orderLineRegistry = new Map(); // key (orderId) → IPriceLine

let _chartDataSnapshotCache = null;     // { key, ts, data }
let _chartDataSnapshotInflight = null;  // { key, promise }

function _perfNow() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
}

// ── Chart data snapshot ─────────────────────────────

async function _fetchChartDataSnapshot(subAccountId, symbol, { force = false } = {}) {
    if (!subAccountId || !symbol) return null;
    const key = `${subAccountId}|${symbol}`;
    const now = Date.now();

    if (_chartDataSnapshotInflight && _chartDataSnapshotInflight.key === key) {
        return _chartDataSnapshotInflight.promise;
    }

    if (_chartDataSnapshotCache && _chartDataSnapshotCache.key === key) {
        const ageMs = now - _chartDataSnapshotCache.ts;
        if (!force && ageMs < S.CHART_ANNOTATION_MIN_INTERVAL) {
            return _chartDataSnapshotCache.data;
        }
        if (force && ageMs < CHART_DATA_FORCE_COALESCE_MS) {
            return _chartDataSnapshotCache.data;
        }
    }

    const promise = api(`/trade/chart-data/${subAccountId}?symbol=${encodeURIComponent(symbol)}`)
        .then((data) => {
            _chartDataSnapshotCache = { key, ts: Date.now(), data };
            return data;
        })
        .finally(() => {
            if (_chartDataSnapshotInflight?.promise === promise) {
                _chartDataSnapshotInflight = null;
            }
        });

    _chartDataSnapshotInflight = { key, promise };
    return promise;
}

// ── Left-side label layer ───────────────────────────

function _ensureLeftLabelLayer() {
    const container = document.getElementById('tv-chart');
    if (!container) return null;
    let layer = document.getElementById(LEFT_LABEL_LAYER_ID);
    if (!layer) {
        layer = document.createElement('div');
        layer.id = LEFT_LABEL_LAYER_ID;
        layer.className = 'chart-left-annotation-layer';
        container.appendChild(layer);
    }
    return layer;
}

export function _clearLeftLabels() {
    const layer = document.getElementById(LEFT_LABEL_LAYER_ID);
    if (!layer) return;
    layer.innerHTML = '';
}

export function _renderLeftPriceLabels(specs = []) {
    _clearLeftLabels();
    if (!specs.length || !S.candleSeries) return;

    const container = document.getElementById('tv-chart');
    if (!container) return;

    const layer = _ensureLeftLabelLayer();
    if (!layer) return;

    const maxTop = Math.max(0, container.clientHeight - 16);
    const positioned = [];

    for (const spec of specs) {
        const price = Number(spec.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        const y = S.candleSeries.priceToCoordinate(price);
        if (!Number.isFinite(y)) continue;
        const top = Math.min(maxTop, Math.max(0, Math.round(y - 8)));
        positioned.push({ ...spec, top });
    }

    if (positioned.length === 0) return;

    positioned.sort((a, b) => a.top - b.top);
    for (let i = 1; i < positioned.length; i++) {
        const prev = positioned[i - 1];
        if (positioned[i].top < prev.top + LEFT_LABEL_MIN_GAP_PX) {
            positioned[i].top = Math.min(maxTop, prev.top + LEFT_LABEL_MIN_GAP_PX);
        }
    }

    for (const item of positioned) {
        const el = document.createElement('div');
        el.className = `chart-left-annotation-label ${item.tone || 'neutral'}`;
        el.style.top = `${item.top}px`;
        el.innerHTML = item.html || item.text;
        layer.appendChild(el);
    }
}

export function refreshChartLeftAnnotationLabels() {
    _renderLeftPriceLabels(_cachedLeftLabelSpecs);
}

// ── Chart annotations loading ───────────────────────

export function loadChartAnnotations(force = false) {
    if (force) {
        S.set('_chartAnnotationCache', null);
        S.set('_chartAnnotationLastFetch', 0);
        S.set('_chartAnnotationFingerprint', null);
    }
    S.set('_chartAnnotationForceNext', S._chartAnnotationForceNext || force);
    if (S._chartAnnotationTimer) clearTimeout(S._chartAnnotationTimer);
    S.set('_chartAnnotationTimer', setTimeout(_loadChartAnnotationsImpl, 300));
}

function _chartAnnotationDataFingerprint(data, showPositions, showOpenOrders, showPastOrders) {
    const posKey = (data.positions || [])
        .map(p => `${p.id}|${p.side}|${p.entryPrice}|${p.quantity}|${p.liquidationPrice}`)
        .sort()
        .join(';');
    const ordKey = (data.openOrders || [])
        .map(o => `${o.id}|${o.side}|${o.price}|${o.quantity}`)
        .sort()
        .join(';');
    const tradeKey = (data.trades || [])
        .map(t => `${t.id}`)
        .sort()
        .join(';');
    return `${showPositions}|${showOpenOrders}|${showPastOrders}||${posKey}||${ordKey}||${tradeKey}`;
}

async function _loadChartAnnotationsImpl() {
    S.set('_chartAnnotationTimer', null);
    const force = S._chartAnnotationForceNext;
    S.set('_chartAnnotationForceNext', false);
    if (!S.candleSeries || !S.chartReady || !state.currentAccount) return;

    const generation = S._chartAnnotationGeneration + 1;
    S.set('_chartAnnotationGeneration', generation);

    const showPositions = document.getElementById('cs-show-positions')?.checked ?? true;
    const showOpenOrders = document.getElementById('cs-show-open-orders')?.checked ?? true;
    const showPastOrders = document.getElementById('cs-show-past-orders')?.checked ?? true;

    try {
        const fetchStarted = _perfNow();
        const data = await _fetchChartDataSnapshot(
            state.currentAccount,
            S.selectedSymbol,
            { force: !!force }
        );
        recordLatency('refresh_chart_data_fetch_ms', _perfNow() - fetchStarted);
        if (!data) return;

        if (generation !== S._chartAnnotationGeneration) return;

        S.set('_chartAnnotationCache', data);
        S.set('_chartAnnotationLastFetch', Date.now());

        if (generation !== S._chartAnnotationGeneration) return;

        const fp = _chartAnnotationDataFingerprint(data, showPositions, showOpenOrders, showPastOrders);
        if (!force && fp === S._chartAnnotationFingerprint) {
            _renderLeftPriceLabels(_cachedLeftLabelSpecs);
            return;
        }
        S.set('_chartAnnotationFingerprint', fp);

        for (const line of S.chartPriceLines) {
            try { S.candleSeries.removePriceLine(line); } catch { }
        }
        S.set('chartPriceLines', []);
        S.candleSeries.setMarkers([]);
        _clearLeftLabels();
        _positionLineRegistry.clear();
        _orderLineRegistry.clear();

        _cachedLeftLabelSpecs = _drawChartAnnotations(data, showPositions, showOpenOrders, showPastOrders);
    } catch (err) {
        console.debug('[Chart] Annotations unavailable:', err.message);
    }
}

// ── Draw chart annotations ──────────────────────────

function _drawChartAnnotations(data, showPositions, showOpenOrders, showPastOrders) {
    if (!S.candleSeries) return [];
    const leftLabelSpecs = [];

    if (showPositions) {
        const grouped = {};
        for (const pos of data.positions) {
            const key = `${pos.symbol}|${pos.side}`;
            if (!grouped[key]) grouped[key] = { side: pos.side, totalQty: 0, weightedEntry: 0, liqPrice: 0, totalPnl: 0, totalMargin: 0, totalNotional: 0 };
            grouped[key].totalQty += pos.quantity;
            grouped[key].weightedEntry += pos.entryPrice * pos.quantity;
            grouped[key].totalPnl += pos.unrealizedPnl || 0;
            grouped[key].totalMargin += pos.margin || 0;
            grouped[key].totalNotional += pos.notional || 0;
            if (pos.side === 'LONG') {
                grouped[key].liqPrice = Math.max(grouped[key].liqPrice, pos.liquidationPrice || 0);
            } else {
                grouped[key].liqPrice = grouped[key].liqPrice > 0
                    ? Math.min(grouped[key].liqPrice, pos.liquidationPrice || Infinity)
                    : pos.liquidationPrice || 0;
            }
        }

        for (const [groupKey, g] of Object.entries(grouped)) {
            const avgEntry = g.totalQty > 0 ? g.weightedEntry / g.totalQty : 0;
            const isLong = g.side === 'LONG';
            const pnl = g.totalPnl;
            const pnlPct = g.totalMargin > 0 ? (pnl / g.totalMargin) * 100 : 0;
            const pnlSign = pnl >= 0 ? '+' : '';
            const sideLabel = isLong ? 'Long' : 'Short';

            const entryLine = S.candleSeries.createPriceLine({
                price: avgEntry,
                color: isLong ? '#22c55e' : '#ef4444',
                lineWidth: 2,
                lineStyle: 0,
                axisLabelVisible: true,
                title: '',
            });
            S.chartPriceLines.push(entryLine);
            _positionLineRegistry.set(groupKey, entryLine);
            leftLabelSpecs.push({
                price: avgEntry,
                html: `<span style="opacity:0.85">${sideLabel}</span> ${pnlSign}$${Math.abs(pnl).toFixed(2)} <span style="opacity:0.75">(${pnlSign}${pnlPct.toFixed(1)}%)</span>`,
                text: `${sideLabel} ${pnlSign}$${Math.abs(pnl).toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
                tone: isLong ? 'long' : 'short',
            });

            if (g.liqPrice > 0) {
                const liqLine = S.candleSeries.createPriceLine({
                    price: g.liqPrice,
                    color: '#f97316',
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: false,
                    title: '',
                });
                S.chartPriceLines.push(liqLine);
                leftLabelSpecs.push({
                    price: g.liqPrice,
                    text: 'Liq Price',
                    tone: 'liq',
                });
            }
        }
    }

    if (showOpenOrders && data.openOrders) {
        for (const order of data.openOrders) {
            const isLong = order.side === 'LONG';
            const orderLine = S.candleSeries.createPriceLine({
                price: order.price,
                color: isLong ? '#4ade80' : '#f87171',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: false,
                title: '',
            });
            S.chartPriceLines.push(orderLine);
            _orderLineRegistry.set(order.id, orderLine);
            leftLabelSpecs.push({
                price: order.price,
                text: `${order.side} Limit`,
                tone: isLong ? 'long' : 'short',
            });
        }
    }

    if (showPastOrders && data.trades && data.trades.length > 0) {
        const tfMap = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
        const tfStr = S.currentTimeframe || '5m';
        const tfUnit = tfStr.slice(-1);
        const tfNum = parseInt(tfStr) || 1;
        const candleSeconds = tfNum * (tfMap[tfUnit] || 60);

        const markers = data.trades
            .filter(t => t.timestamp)
            .map(t => {
                const isBuy = t.side === 'BUY';
                const isClose = t.action === 'CLOSE' || t.action === 'LIQUIDATE';
                const rawTime = Math.floor(new Date(t.timestamp).getTime() / 1000);
                const snappedTime = Math.floor(rawTime / candleSeconds) * candleSeconds;
                return {
                    time: snappedTime,
                    position: isBuy ? 'belowBar' : 'aboveBar',
                    color: isClose ? (t.realizedPnl >= 0 ? '#22c55e' : '#ef4444') : (isBuy ? '#22c55e' : '#ef4444'),
                    shape: isBuy ? 'arrowUp' : 'arrowDown',
                    text: '',
                };
            })
            .sort((a, b) => a.time - b.time);

        const seen = new Set();
        const uniqueMarkers = markers.filter(m => {
            const key = `${m.time}_${m.position}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (uniqueMarkers.length > 0) {
            S.candleSeries.setMarkers(uniqueMarkers);
        }
    }

    _renderLeftPriceLabels(leftLabelSpecs);
    return leftLabelSpecs;
}

// ── Schedule chart risk refresh ─────────────────────

export function scheduleChartRiskRefresh() {
    if (!S._tradingMounted || !state.currentAccount) return;
    if (S._chartRiskRefreshTimer) return;
    S.set('_chartRiskRefreshTimer', setTimeout(() => {
        S.set('_chartRiskRefreshTimer', null);
        loadChartAnnotations();
    }, 1200));
}

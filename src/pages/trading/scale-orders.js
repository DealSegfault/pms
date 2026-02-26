// ── Trading Page – Scale Orders ──────────────────────────────
import { state, api, showToast, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { showTradeError } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { beginOrderLatency, markOrderSent, markOrderAck, markOrderPaint } from './perf-metrics.js';

// ── Grid Generators ─────────────────────────────

export function generateLinearGrid(lower, upper, count) {
    const step = (upper - lower) / (count - 1);
    return Array.from({ length: count }, (_, i) => lower + step * i);
}

export function generateGeometricGrid(lower, upper, count) {
    if (lower <= 0) lower = 0.0001;
    const ratio = Math.pow(upper / lower, 1 / (count - 1));
    return Array.from({ length: count }, (_, i) => lower * Math.pow(ratio, i));
}

// ── Scale Preview Lines ─────────────────────────

export function clearScalePreviewLines() {
    if (!S.candleSeries) return;
    for (const line of S.scaleChartLines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    S.set('scaleChartLines', []);
}

export function removeScaleBoundaryLines() {
    if (!S.candleSeries) return;
    if (S._scaleBoundaryUpper) { try { S.candleSeries.removePriceLine(S._scaleBoundaryUpper); } catch { } S.set('_scaleBoundaryUpper', null); }
    if (S._scaleBoundaryLower) { try { S.candleSeries.removePriceLine(S._scaleBoundaryLower); } catch { } S.set('_scaleBoundaryLower', null); }
}

export function drawScaleBoundaryLines() {
    removeScaleBoundaryLines();
    if (!S.candleSeries || !S.scaleUpperPrice || !S.scaleLowerPrice) return;

    S.set('_scaleBoundaryUpper', S.candleSeries.createPriceLine({
        price: S.scaleUpperPrice,
        color: '#f59e0b',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `▲ $${formatPrice(S.scaleUpperPrice)}`,
    }));
    S.set('_scaleBoundaryLower', S.candleSeries.createPriceLine({
        price: S.scaleLowerPrice,
        color: '#f59e0b',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `▼ $${formatPrice(S.scaleLowerPrice)}`,
    }));

    if (!S._scaleDragMoveHandler) setupScaleDragHandlers();
}

// ── Scale Drag Handlers ─────────────────────────

export function setupScaleDragHandlers() {
    const container = document.getElementById('tv-chart');
    if (!container || !S.chart || !S.candleSeries) return;

    teardownScaleDragHandlers();

    const DRAG_THRESHOLD_PX = 12;

    const onMouseDown = (e) => {
        if (!S.scaleUpperPrice || !S.scaleLowerPrice || !S.candleSeries) return;

        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const upperY = S.candleSeries.priceToCoordinate(S.scaleUpperPrice);
        const lowerY = S.candleSeries.priceToCoordinate(S.scaleLowerPrice);

        if (upperY != null && Math.abs(y - upperY) < DRAG_THRESHOLD_PX) {
            S.set('_scaleDragging', 'upper');
            container.style.cursor = 'ns-resize';
            if (S.chart) S.chart.applyOptions({ handleScroll: false, handleScale: false });
            e.preventDefault();
        } else if (lowerY != null && Math.abs(y - lowerY) < DRAG_THRESHOLD_PX) {
            S.set('_scaleDragging', 'lower');
            container.style.cursor = 'ns-resize';
            if (S.chart) S.chart.applyOptions({ handleScroll: false, handleScale: false });
            e.preventDefault();
        }
    };

    const onMouseMove = (e) => {
        if (!S.candleSeries) return;
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top;

        if (S._scaleDragging) {
            const newPrice = S.candleSeries.coordinateToPrice(y);
            if (newPrice == null || newPrice <= 0) return;

            if (S._scaleDragging === 'upper') {
                S.set('scaleUpperPrice', Math.max(newPrice, S.scaleLowerPrice + 0.01));
            } else {
                S.set('scaleLowerPrice', Math.min(newPrice, S.scaleUpperPrice - 0.01));
            }

            drawScaleBoundaryLines();
            if (!S._scaleDragPreviewTimer) {
                S.set('_scaleDragPreviewTimer', setTimeout(() => {
                    S.set('_scaleDragPreviewTimer', null);
                    updateScalePreview();
                }, 80));
            }
            e.preventDefault();
        } else if (S.scaleUpperPrice && S.scaleLowerPrice) {
            const upperY = S.candleSeries.priceToCoordinate(S.scaleUpperPrice);
            const lowerY = S.candleSeries.priceToCoordinate(S.scaleLowerPrice);
            const nearUpper = upperY != null && Math.abs(y - upperY) < DRAG_THRESHOLD_PX;
            const nearLower = lowerY != null && Math.abs(y - lowerY) < DRAG_THRESHOLD_PX;
            container.style.cursor = (nearUpper || nearLower) ? 'ns-resize' : '';
        }
    };

    const onMouseUp = () => {
        if (S._scaleDragging) {
            S.set('_scaleDragging', null);
            container.style.cursor = '';
            if (S.chart) S.chart.applyOptions({ handleScroll: true, handleScale: true });
            if (S._scaleDragPreviewTimer) { clearTimeout(S._scaleDragPreviewTimer); S.set('_scaleDragPreviewTimer', null); }
            updateScalePreview();
        }
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    S.set('_scaleDragMoveHandler', { container, onMouseDown, onMouseMove, onMouseUp });
}

export function teardownScaleDragHandlers() {
    if (S._scaleDragMoveHandler) {
        const { container, onMouseDown, onMouseMove, onMouseUp } = S._scaleDragMoveHandler;
        container.removeEventListener('mousedown', onMouseDown);
        container.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        S.set('_scaleDragMoveHandler', null);
    }
    S.set('_scaleDragging', null);
}

// ── Scale Pick Mode ─────────────────────────────

export function enableScalePickMode() {
    if (!S.chart || !S.candleSeries || !S.chartReady) {
        showToast('Chart is not ready yet', 'warning');
        return;
    }
    S.set('scaleMode', true);
    S.set('scaleClickCount', 0);
    S.set('scaleUpperPrice', null);
    S.set('scaleLowerPrice', null);
    clearScalePreviewLines();
    removeScaleBoundaryLines();
    teardownScaleDragHandlers();

    S.chart.applyOptions({ handleScroll: false, handleScale: false });

    const pickBtn = document.getElementById('scale-pick-range');
    if (pickBtn) {
        pickBtn.textContent = '🎯 Click chart for 1st price...';
        pickBtn.style.background = 'var(--accent)';
        pickBtn.style.color = 'white';
    }

    showToast('Click the chart to set the first price level', 'info');

    if (S._scaleClickHandler) {
        try { S.chart.unsubscribeClick(S._scaleClickHandler); } catch { }
    }

    const handler = (param) => {
        if (!S.scaleMode || !param.point) return;
        const price = S.candleSeries.coordinateToPrice(param.point.y);
        if (price == null || price <= 0) return;

        S.set('scaleClickCount', S.scaleClickCount + 1);
        if (S.scaleClickCount === 1) {
            S.set('scaleUpperPrice', price);
            showToast(`First level: $${formatPrice(price)} — click for second level`, 'info');
            const pickBtn = document.getElementById('scale-pick-range');
            if (pickBtn) pickBtn.textContent = '🎯 Click chart for 2nd price...';
        } else {
            S.set('scaleLowerPrice', price);
            if (S.scaleLowerPrice > S.scaleUpperPrice) {
                const tmp = S.scaleUpperPrice;
                S.set('scaleUpperPrice', S.scaleLowerPrice);
                S.set('scaleLowerPrice', tmp);
            }
            S.set('scaleMode', false);
            S.chart.unsubscribeClick(handler);
            S.set('_scaleClickHandler', null);

            S.chart.applyOptions({ handleScroll: true, handleScale: true });

            const pickBtn = document.getElementById('scale-pick-range');
            if (pickBtn) {
                pickBtn.textContent = '📍 Select Range on Chart';
                pickBtn.style.background = '';
                pickBtn.style.color = 'var(--accent)';
            }

            drawScaleBoundaryLines();
            updateScalePreview();
            showToast(`Range: $${formatPrice(S.scaleLowerPrice)} → $${formatPrice(S.scaleUpperPrice)} · drag lines to adjust`, 'success');
        }
    };
    S.set('_scaleClickHandler', handler);
    S.chart.subscribeClick(handler);
}

// ── Skew Weights ────────────────────────────────

export function generateSkewWeights(count, skew) {
    const weights = [];
    const s = skew / 100;
    for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const w = Math.pow(3, s * (2 * t - 1));
        weights.push(w);
    }
    const total = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / total);
}

// ── Scale Preview ───────────────────────────────

export function updateScalePreview() {
    clearScalePreviewLines();
    if (!S.scaleUpperPrice || !S.scaleLowerPrice || !S.candleSeries) return;

    let prices;
    const basePrices = S.scaleDistribution === 'geometric'
        ? generateGeometricGrid(S.scaleLowerPrice, S.scaleUpperPrice, S.scaleOrderCount)
        : generateLinearGrid(S.scaleLowerPrice, S.scaleUpperPrice, S.scaleOrderCount);

    if (S.scaleSkew !== 0) {
        const exponent = Math.pow(2, -S.scaleSkew / 25);
        prices = Array.from({ length: S.scaleOrderCount }, (_, i) => {
            const t = S.scaleOrderCount === 1 ? 0.5 : i / (S.scaleOrderCount - 1);
            const skewed = Math.pow(t, exponent);
            return S.scaleLowerPrice + skewed * (S.scaleUpperPrice - S.scaleLowerPrice);
        });
    } else {
        prices = basePrices;
    }

    if (prices.length >= 2) {
        prices[0] = S.scaleLowerPrice;
        prices[prices.length - 1] = S.scaleUpperPrice;
    }

    const weights = generateSkewWeights(S.scaleOrderCount, S.scaleSkew);
    const totalSize = parseFloat(document.getElementById('trade-size')?.value) || 0;

    for (let i = 0; i < prices.length; i++) {
        const baseColor = S.selectedSide === 'LONG' ? [34, 197, 94] : [239, 68, 68];
        const line = S.candleSeries.createPriceLine({
            price: prices[i],
            color: `rgba(${baseColor.join(',')},0.4)`,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: false,
            title: '',
        });
        S.scaleChartLines.push(line);
    }

    const upperEl = document.getElementById('scale-upper');
    const lowerEl = document.getElementById('scale-lower');
    if (upperEl && document.activeElement !== upperEl) upperEl.value = formatPrice(S.scaleUpperPrice);
    if (lowerEl && document.activeElement !== lowerEl) lowerEl.value = formatPrice(S.scaleLowerPrice);

    const skewLabel = S.scaleSkew === 0 ? 'equal' : S.scaleSkew > 0 ? 'heavy upper' : 'heavy lower';
    const el = document.getElementById('scale-preview');
    if (el) {
        if (totalSize > 0) {
            const minSize = (Math.min(...weights) * totalSize).toFixed(2);
            const maxSize = (Math.max(...weights) * totalSize).toFixed(2);
            el.innerHTML = `${S.scaleOrderCount} orders · $${minSize}–$${maxSize}/ea · ${skewLabel}`;
        } else {
            el.innerHTML = `${S.scaleOrderCount} orders · ${S.scaleDistribution} · ${skewLabel} · enter size above`;
        }
    }
}

// ── Scale Order Submission ──────────────────────

export async function submitScaleOrder() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    if (S.cachedMarginInfo?.availableMargin != null && S.cachedMarginInfo.availableMargin < 0) {
        return showToast('⚠️ Insufficient balance — available margin is negative', 'error');
    }
    if (!S.scaleUpperPrice || !S.scaleLowerPrice) return showToast('Select a price range on the chart first', 'error');
    if (S.scaleUpperPrice <= S.scaleLowerPrice) return showToast('Upper price must be greater than lower price', 'error');

    const totalSize = parseFloat(document.getElementById('trade-size')?.value) || 0;
    if (totalSize <= 0) return showToast('Enter a total size', 'error');

    let prices;
    if (S.scaleSkew !== 0) {
        const exponent = Math.pow(2, -S.scaleSkew / 25);
        prices = Array.from({ length: S.scaleOrderCount }, (_, i) => {
            const t = S.scaleOrderCount === 1 ? 0.5 : i / (S.scaleOrderCount - 1);
            const skewed = Math.pow(t, exponent);
            return S.scaleLowerPrice + skewed * (S.scaleUpperPrice - S.scaleLowerPrice);
        });
    } else {
        prices = S.scaleDistribution === 'geometric'
            ? generateGeometricGrid(S.scaleLowerPrice, S.scaleUpperPrice, S.scaleOrderCount)
            : generateLinearGrid(S.scaleLowerPrice, S.scaleUpperPrice, S.scaleOrderCount);
    }

    if (prices.length >= 2) {
        prices[0] = S.scaleLowerPrice;
        prices[prices.length - 1] = S.scaleUpperPrice;
    }

    const weights = generateSkewWeights(S.scaleOrderCount, S.scaleSkew);
    const minNotional = S.symbolInfo?.minNotional || 5;

    const allOrders = prices.map((price, i) => ({
        price,
        quantity: (weights[i] * totalSize) / price,
        notional: weights[i] * totalSize,
    }));
    const validOrders = allOrders.filter(o => o.notional >= minNotional && o.quantity > 0);
    const skippedCount = allOrders.length - validOrders.length;

    if (validOrders.length === 0) {
        return showToast(`All ${allOrders.length} orders are below $${minNotional} min notional. Increase total size.`, 'error');
    }

    if (S.currentPrice && S.currentPrice > 0) {
        const rangeMid = (S.scaleUpperPrice + S.scaleLowerPrice) / 2;
        const distPct = Math.abs(rangeMid - S.currentPrice) / S.currentPrice;
        if (distPct > 0.5) {
            const ok = await cuteConfirm({
                title: '⚠️ Price Range Far from Market',
                message: `Your scale range midpoint ($${formatPrice(rangeMid)}) is ${(distPct * 100).toFixed(0)}% away from the current price ($${formatPrice(S.currentPrice)}). Continue?`,
                confirmText: 'Place Anyway',
                danger: true,
            });
            if (!ok) return;
        }

        const gridAbove = S.scaleLowerPrice > S.currentPrice;
        const gridBelow = S.scaleUpperPrice < S.currentPrice;
        if (S.selectedSide === 'LONG' && gridAbove) {
            return showToast('❌ Cannot LONG above market — your grid is entirely above the current price. Switch to SHORT.', 'error');
        } else if (S.selectedSide === 'SHORT' && gridBelow) {
            return showToast('❌ Cannot SHORT below market — your grid is entirely below the current price. Switch to LONG.', 'error');
        }
    }

    const totalNotional = validOrders.reduce((s, o) => s + o.notional, 0);
    const skippedNote = skippedCount > 0 ? `\n⚠️ ${skippedCount} order(s) below $${minNotional} min notional will be skipped.` : '';
    const confirmed = await cuteConfirm({
        title: `Scale ${S.selectedSide} ${S.selectedSymbol.split('/')[0]}`,
        message: `${validOrders.length} orders · $${formatPrice(S.scaleLowerPrice)} → $${formatPrice(S.scaleUpperPrice)}\nTotal: $${totalNotional.toFixed(2)} · Leverage: ${S.leverage}x · ${S.scaleDistribution}${skippedNote}`,
        confirmText: `Place ${validOrders.length} Orders`,
        danger: S.selectedSide === 'SHORT',
    });
    if (!confirmed) return;

    const orders = validOrders.map(o => ({ price: o.price, quantity: o.quantity }));

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = `Placing ${orders.length}...`; }
    const latencyId = beginOrderLatency('scale');

    try {
        markOrderSent(latencyId);
        const result = await api('/trade/scale', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                side: S.selectedSide,
                leverage: S.leverage,
                orders,
            },
        });
        markOrderAck(latencyId);
        requestAnimationFrame(() => markOrderPaint(latencyId));
        if (result.placed > 0) {
            showToast(`${result.placed}/${result.total} scale orders placed`, 'success');
        } else {
            showToast(`All ${result.total} orders failed`, 'error');
        }
        if (result.failed > 0 && result.placed > 0) {
            showToast(`${result.failed} orders failed`, 'warning');
        }
        clearScalePreviewLines();
        scheduleTradingRefresh({
            openOrders: true,
            annotations: true,
            forceAnnotations: true,
        }, 30);
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Scale order failed'}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = S.selectedSide === 'LONG' ? 'Buy / Long' : 'Sell / Short'; }
    }
}

// ── TWAP helpers (co-located for import simplicity) ──

export function updateTwapPreview() {
    const el = document.getElementById('twap-preview');
    if (!el) return;
    const lotsSlider = document.getElementById('twap-lots');
    const lotsValEl = document.getElementById('twap-lots-val');
    let lots = parseInt(lotsSlider?.value) || 10;
    const durMin = parseInt(document.getElementById('twap-duration')?.value) || 30;
    const sizeUsd = parseFloat(document.getElementById('trade-size')?.value) || 0;
    const submitBtn = document.getElementById('submit-trade');

    if (sizeUsd <= 0) {
        el.textContent = 'Enter a size above';
        if (submitBtn && S.orderType === 'TWAP') { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; }
        return;
    }

    const minNotional = S.symbolInfo?.minNotional || 6;

    // Auto-clamp slider max so per-lot always >= minNotional
    const maxLots = Math.max(2, Math.floor(sizeUsd / minNotional));
    if (lotsSlider) {
        lotsSlider.max = Math.min(50, maxLots);
        if (lots > maxLots) {
            lots = maxLots;
            lotsSlider.value = lots;
            if (lotsValEl) lotsValEl.textContent = lots;
        }
    }

    const perLot = sizeUsd / lots;
    const intervalSec = (durMin * 60) / lots;
    const end = new Date(Date.now() + durMin * 60 * 1000);
    const endStr = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (perLot < minNotional) {
        el.innerHTML = `<span style="color:var(--red);">⚠️ $${perLot.toFixed(2)}/lot is below $${minNotional} min. Max: ${maxLots} lots</span>`;
        if (submitBtn && S.orderType === 'TWAP') { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; }
        return;
    }

    // Valid — re-enable button
    if (submitBtn && S.orderType === 'TWAP') { submitBtn.disabled = false; submitBtn.style.opacity = ''; }
    el.textContent = `$${perLot.toFixed(2)}/lot · every ${intervalSec >= 60 ? (intervalSec / 60).toFixed(1) + 'min' : intervalSec.toFixed(0) + 's'} · done ~${endStr}`;
}

// ── Trading Page – Orchestrator ──────────────────────────────
// This module is the single entry point that wires all sub‑modules together.
// It replaces the original monolithic `renderTradingPage`, `cleanup`, and
// `attachEventListeners` functions.
//
// Public API surface (re‑exported by the shim `../trading.js`):
//   renderTradingPage(container)
//   cleanup()
// ─────────────────────────────────────────────────────────────

import { showToast, formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { buildTradingHTML } from './dom.js';
import {
    initChart, resetChart, autoscaleChart,
    fetchTickerData, fetchSymbolInfo, setTimeframe,
    initMeasureTool, deactivateMeasure,
} from './chart.js';
import {
    setSide, setLeverage, setSizePercent, updatePreview, submitTrade,
    submitLimitOrder, setOrderType, showSymbolPicker, showAccountPicker,
    updateAccountDisplay, prefetchSymbolsList, _switchBottomTab,
} from './order-form.js';
import {
    enableScalePickMode, clearScalePreviewLines, removeScaleBoundaryLines,
    teardownScaleDragHandlers, updateScalePreview, drawScaleBoundaryLines,
    submitScaleOrder, updateTwapPreview,
} from './scale-orders.js';
import { submitTwapOrder, cancelTwap } from './twap.js';
import { submitTrailStop, cancelTrailStop, refreshTrailPositionDropdown, updateTrailPreview, drawLiveTrailStop, clearAllTrailStopLines, fetchAndDrawActiveTrailStops, onTrailPriceTick } from './trail-stop.js';
import {
    loadOpenOrders, loadTradingPositions, loadChartAnnotations,
    cancelAllOrders, applySymbolFilter,
} from './positions-panel.js';
import { initWebSockets, teardownStreams, setupAppEventListeners, startCompactPoll, stopCompactPoll } from './ws-handlers.js';
import { clearTradingRefreshScheduler } from './refresh-scheduler.js';
import { startPerfMetrics, stopPerfMetrics } from './perf-metrics.js';

// ── Render ──────────────────────────────────────

export function renderTradingPage(container) {
    cleanup();
    S.set('_tradingMounted', true);

    container.innerHTML = buildTradingHTML();

    attachEventListeners();
    setupAppEventListeners();
    startCompactPoll();
    startPerfMetrics();

    requestAnimationFrame(() => {
        initChart();
        initMeasureTool();
        initWebSockets();
    });

    fetchTickerData();
    fetchSymbolInfo(S.selectedSymbol);
    updateAccountDisplay();
    prefetchSymbolsList();

    // Sync the submit button with the saved order type (e.g. CHASE → "Start Chase")
    if (S.orderType && S.orderType !== 'MARKET') setOrderType(S.orderType);
    // Ensure side toggle + submit button match the persisted side
    if (S.orderType !== 'SCALPER') setSide(S.selectedSide);
}

// ── Event Listeners ─────────────────────────────

function attachEventListeners() {
    // ── Trading tab switching (mobile only) ──
    document.querySelectorAll('.trading-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.trading-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            document.querySelectorAll('.tab-chart-item').forEach(el => el.classList.toggle('mob-hidden', target !== 'chart'));
            document.querySelectorAll('.tab-trade-item').forEach(el => el.classList.toggle('mob-hidden', target !== 'trade'));
            if (target === 'chart' && S.chart) {
                const ct = document.getElementById('tv-chart');
                if (ct && ct.clientWidth > 0 && ct.clientHeight > 0) {
                    S.chart.applyOptions({ width: ct.clientWidth, height: ct.clientHeight });
                }
            }
        });
    });

    // ── Symbol / Account Pickers ──
    document.getElementById('symbol-picker-trigger')?.addEventListener('click', showSymbolPicker);
    document.getElementById('form-account')?.addEventListener('click', showAccountPicker);

    // ── Side toggle ──
    document.getElementById('btn-long')?.addEventListener('click', () => setSide('LONG'));
    document.getElementById('btn-short')?.addEventListener('click', () => setSide('SHORT'));

    // ── Leverage dropdown ──
    document.getElementById('lev-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const dd = document.getElementById('lev-dropdown');
        if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    });
    document.querySelectorAll('#lev-presets button').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            setLeverage(parseInt(b.dataset.lev));
            const dd = document.getElementById('lev-dropdown');
            if (dd) dd.style.display = 'none';
        });
    });
    // close dropdown on outside click
    document.addEventListener('click', () => {
        const dd = document.getElementById('lev-dropdown');
        if (dd) dd.style.display = 'none';
    });

    // ── Size slider ──
    const slider = document.getElementById('size-slider');
    slider?.addEventListener('input', e => setSizePercent(parseInt(e.target.value)));

    document.querySelectorAll('.slider-diamond').forEach(d => {
        d.addEventListener('click', () => {
            const pct = parseInt(d.dataset.pct);
            if (slider) slider.value = pct;
            setSizePercent(pct);
        });
    });

    // ── Timeframe buttons ──
    document.querySelector('.chart-timeframes')?.addEventListener('click', e => {
        const btn = e.target.closest('.tf-btn');
        if (btn && !btn.id) setTimeframe(btn.dataset.tf);
    });

    // ── Chart controls ──
    document.getElementById('chart-reset')?.addEventListener('click', resetChart);
    document.getElementById('chart-autoscale')?.addEventListener('click', autoscaleChart);

    document.getElementById('chart-settings-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const panel = document.getElementById('chart-settings-panel');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });



    // ── Overlay checkboxes ──
    const overlayKeys = ['cs-show-positions', 'cs-show-open-orders', 'cs-show-past-orders'];
    try {
        const savedOverlays = JSON.parse(localStorage.getItem('chart_overlays'));
        if (savedOverlays) {
            overlayKeys.forEach(id => {
                const el = document.getElementById(id);
                if (el && savedOverlays[id] != null) el.checked = savedOverlays[id];
            });
        }
    } catch { }
    overlayKeys.forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            const overlayState = {};
            overlayKeys.forEach(k => { overlayState[k] = document.getElementById(k)?.checked ?? true; });
            try { localStorage.setItem('chart_overlays', JSON.stringify(overlayState)); } catch { }
            loadChartAnnotations();
        });
    });

    // ── Size input ↔ slider sync ──
    document.getElementById('trade-size')?.addEventListener('input', () => {
        const val = parseFloat(document.getElementById('trade-size')?.value) || 0;
        const available = S.cachedMarginInfo?.availableMargin || 0;
        const maxNotionalRule = S.cachedMarginInfo?.rules?.maxNotionalPerTrade || Infinity;
        const maxNotional = Math.min(available * S.leverage, maxNotionalRule);
        if (maxNotional > 0) {
            const pct = Math.round(Math.min(100, (val / maxNotional) * 100));
            S.set('sizePercent', pct);
            if (slider) slider.value = pct;
            const fill = document.getElementById('size-slider-fill');
            if (fill) fill.style.width = `${pct}%`;
            const label = document.getElementById('size-pct-label');
            if (label) label.textContent = `${pct}%`;
            document.querySelectorAll('.slider-diamond').forEach(d => {
                d.classList.toggle('active', parseInt(d.dataset.pct) <= pct);
            });
        }
        updatePreview();
        if (S.orderType === 'SCALE') updateScalePreview();
        if (S.orderType === 'TWAP') updateTwapPreview();
        if (S.orderType === 'SCALPER') import('./scalper.js').then(m => m.updateScalperPreview());
    });

    // ── Submit ──
    document.getElementById('submit-trade')?.addEventListener('click', () => {
        if (S.orderType === 'TWAP') submitTwapOrder();
        else if (S.orderType === 'TRAIL') submitTrailStop();
        else if (S.orderType === 'SCALE') submitScaleOrder();
        else if (S.orderType === 'LIMIT') submitLimitOrder();
        else if (S.orderType === 'CHASE') { import('./chase-limit.js').then(m => m.submitChase()); }
        else if (S.orderType === 'SCALPER') { import('./scalper.js').then(m => m.submitScalper()); }
        else submitTrade();
    });

    // ── Order type custom dropdown ──
    document.getElementById('ot-trigger')?.addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('ot-dropdown')?.classList.toggle('open');
    });
    document.querySelectorAll('#ot-menu .ot-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            setOrderType(opt.dataset.type);
            document.getElementById('ot-dropdown')?.classList.remove('open');
        });
    });
    // close dropdown on outside click (reuse existing doc click handler scope)
    document.addEventListener('click', () => {
        document.getElementById('ot-dropdown')?.classList.remove('open');
    });

    // ── TWAP controls ──
    document.getElementById('twap-lots')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 10;
        const el = document.getElementById('twap-lots-val');
        if (el) el.textContent = v;
        updateTwapPreview();
    });
    document.getElementById('twap-duration')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 30;
        const el = document.getElementById('twap-dur-val');
        if (el) el.textContent = v;
        updateTwapPreview();
    });
    document.getElementById('twap-jitter')?.addEventListener('change', () => updateTwapPreview());
    document.getElementById('twap-irregular')?.addEventListener('change', () => updateTwapPreview());

    // ── Trail stop controls ──
    document.getElementById('trail-callback')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value) || 1;
        const el = document.getElementById('trail-callback-val');
        if (el) el.textContent = `${v.toFixed(1)}%`;
        updateTrailPreview();
    });
    document.getElementById('trail-activation')?.addEventListener('change', () => updateTrailPreview());
    document.getElementById('trail-position')?.addEventListener('change', () => updateTrailPreview());

    // ── Chase controls ──
    document.getElementById('chase-offset')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value) || 0;
        const el = document.getElementById('chase-offset-val');
        if (el) el.textContent = `${v.toFixed(2)}%`;
        import('./chase-limit.js').then(m => m.updateChasePreview());
    });


    // ── Scalper controls ──
    document.getElementById('scalper-long-offset')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value) || 0;
        const el = document.getElementById('scalper-long-off-val');
        if (el) el.textContent = `${v.toFixed(3)}%`;
        import('./scalper.js').then(m => m.updateScalperPreview());
    });
    document.getElementById('scalper-short-offset')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value) || 0;
        const el = document.getElementById('scalper-short-off-val');
        if (el) el.textContent = `${v.toFixed(3)}%`;
        import('./scalper.js').then(m => m.updateScalperPreview());
    });
    document.getElementById('scalper-child-count')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 1;
        const el = document.getElementById('scalper-count-val');
        if (el) el.textContent = v;
        import('./scalper.js').then(m => m.updateScalperPreview());
    });
    document.getElementById('scalper-skew')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 0;
        const el = document.getElementById('scalper-skew-val');
        if (el) el.textContent = v > 0 ? `+${v}` : `${v}`;
        import('./scalper.js').then(m => m.updateScalperPreview());
    });
    // ── Neutral mode toggle (drives the global LONG/NEUTRAL/SHORT buttons) ──
    function _setScalperMode(mode) {
        const btnL = document.getElementById('btn-long');
        const btnN = document.getElementById('btn-neutral');
        const btnS = document.getElementById('btn-short');
        const settings = document.getElementById('scalper-neutral-settings');
        const ctrl = document.getElementById('scalper-controls');

        // Only show neutral button when Scalper is the active order type
        if (btnN) btnN.style.display = S.orderType === 'SCALPER' ? '' : 'none';


        // Visual reset all three
        if (btnL) { btnL.className = ''; btnL.style.outline = ''; }
        if (btnN) { btnN.style.background = 'transparent'; btnN.style.color = 'var(--text-muted)'; btnN.style.outline = ''; }
        if (btnS) { btnS.className = ''; btnS.style.outline = ''; }

        // Apply active state
        if (mode === 'LONG') { if (btnL) btnL.className = 'active-long'; }
        else if (mode === 'SHORT') { if (btnS) btnS.className = 'active-short'; }
        else /* NEUTRAL */ { if (btnN) { btnN.style.background = 'rgba(168,85,247,0.2)'; btnN.style.color = '#a855f7'; btnN.style.outline = '2px solid rgba(168,85,247,0.5)'; } }

        if (settings) settings.style.display = mode === 'NEUTRAL' ? 'block' : 'none';
        if (ctrl) ctrl.dataset.scalperMode = mode;
        S.set('selectedSide', mode);
        import('./scalper.js').then(m => m.updateScalperPreview());
    }
    // Default state — only apply scalper mode when SCALPER is the active order type
    if (S.orderType === 'SCALPER') {
        _setScalperMode(S.selectedSide || 'LONG');
    }
    document.getElementById('btn-long')?.addEventListener('click', () => {
        if (S.orderType !== 'SCALPER') return;
        _setScalperMode('LONG');
    });
    document.getElementById('btn-neutral')?.addEventListener('click', () => _setScalperMode('NEUTRAL'));
    document.getElementById('btn-short')?.addEventListener('click', () => {
        if (S.orderType !== 'SCALPER') return;
        _setScalperMode('SHORT');
    });
    // Re-sync active button whenever SCALPER order type becomes active
    document.addEventListener('scalper-active', () => {
        const ctrl = document.getElementById('scalper-controls');
        const currentMode = ctrl?.dataset?.scalperMode || 'LONG';
        _setScalperMode(currentMode);
    });


    // ── Pin-to-entry toggle (checkbox: disables input and delegates to backend) ──
    async function _applyEntryPin(side, pinned) {
        const inpId = side === 'LONG' ? 'scalper-long-max-price' : 'scalper-short-min-price';
        const inp = document.getElementById(inpId);
        if (!inp) return;
        if (pinned) {
            inp.dataset.previousValue = inp.value;
            inp.value = '';
            inp.placeholder = 'Pinned to current position';
            inp.disabled = true;
            inp.style.opacity = '0.5';
            showToast(`📌 ${side} pinned to rolling position entry`, 'info');
        } else {
            inp.placeholder = 'no limit';
            inp.value = inp.dataset.previousValue || '';
            inp.disabled = false;
            inp.style.opacity = '1';
        }
    }
    document.getElementById('scalper-pin-long-max')?.addEventListener('change', e => _applyEntryPin('LONG', e.target.checked));
    document.getElementById('scalper-pin-short-min')?.addEventListener('change', e => _applyEntryPin('SHORT', e.target.checked));


    document.getElementById('scalper-min-fill-spread')?.addEventListener('input', e => {
        const v = parseFloat(e.target.value) || 0;
        const el = document.getElementById('scalper-fill-spread-val');
        if (el) el.textContent = `${v.toFixed(2)}%`;
    });
    document.getElementById('scalper-fill-decay-halflife')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 30;
        const el = document.getElementById('scalper-fill-decay-val');
        if (el) el.textContent = `${v}s`;
    });
    document.getElementById('scalper-min-refill-delay')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 0;
        const el = document.getElementById('scalper-refill-delay-val');
        if (el) el.textContent = `${v}s`;
    });
    document.getElementById('scalper-allow-loss')?.addEventListener('change', () => {
        import('./scalper.js').then(m => m.updateScalperPreview());
    });
    document.getElementById('scalper-max-loss-close')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 0;
        const el = document.getElementById('scalper-max-loss-close-val');
        if (el) el.textContent = v > 0 ? `${v}bps` : 'off';
    });
    document.getElementById('scalper-max-fills-pm')?.addEventListener('input', e => {
        const v = parseInt(e.target.value) || 0;
        const el = document.getElementById('scalper-max-fills-pm-val');
        if (el) el.textContent = v > 0 ? `${v}/min` : 'off';
    });
    // ── PnL feedback mode 3-button toggle ──
    function _setFeedbackMode(mode) {
        const hidden = document.getElementById('scalper-feedback-mode');
        if (hidden) hidden.value = mode;
        ['off', 'soft', 'full'].forEach(m => {
            const btn = document.getElementById(`scalper-feedback-${m}`);
            if (!btn) return;
            const on = m === mode;
            btn.style.background = on ? 'var(--accent)' : 'transparent';
            btn.style.borderColor = on ? 'var(--accent)' : 'rgba(255,255,255,0.1)';
            btn.style.color = on ? 'white' : 'var(--text-muted)';
        });
    }
    ['off', 'soft', 'full'].forEach(m => {
        document.getElementById(`scalper-feedback-${m}`)?.addEventListener('click', () => _setFeedbackMode(m));
    });

    // ── Scale controls ──
    document.getElementById('scale-count')?.addEventListener('input', e => {
        S.set('scaleOrderCount', parseInt(e.target.value) || 10);
        const valEl = document.getElementById('scale-count-val');
        if (valEl) valEl.textContent = S.scaleOrderCount;
        updateScalePreview();
    });
    document.getElementById('scale-linear')?.addEventListener('click', () => {
        S.set('scaleDistribution', 'linear');
        document.getElementById('scale-linear').style.background = 'var(--accent)';
        document.getElementById('scale-linear').style.color = 'white';
        document.getElementById('scale-linear').style.borderColor = 'var(--accent)';
        document.getElementById('scale-geometric').style.background = '';
        document.getElementById('scale-geometric').style.color = '';
        document.getElementById('scale-geometric').style.borderColor = '';
        updateScalePreview();
    });
    document.getElementById('scale-geometric')?.addEventListener('click', () => {
        S.set('scaleDistribution', 'geometric');
        document.getElementById('scale-geometric').style.background = 'var(--accent)';
        document.getElementById('scale-geometric').style.color = 'white';
        document.getElementById('scale-geometric').style.borderColor = 'var(--accent)';
        document.getElementById('scale-linear').style.background = '';
        document.getElementById('scale-linear').style.color = '';
        document.getElementById('scale-linear').style.borderColor = '';
        updateScalePreview();
    });
    document.getElementById('scale-pick-range')?.addEventListener('click', enableScalePickMode);
    document.getElementById('scale-skew')?.addEventListener('input', e => {
        S.set('scaleSkew', parseInt(e.target.value) || 0);
        const valEl = document.getElementById('scale-skew-val');
        if (valEl) valEl.textContent = S.scaleSkew > 0 ? `+${S.scaleSkew}` : S.scaleSkew;
        updateScalePreview();
    });
    document.getElementById('scale-upper')?.addEventListener('change', e => {
        const v = parseFloat(e.target.value);
        if (!v || v <= 0) return;
        S.set('scaleUpperPrice', v);
        if (S.scaleLowerPrice && S.scaleUpperPrice <= S.scaleLowerPrice) S.set('scaleUpperPrice', S.scaleLowerPrice + 0.01);
        drawScaleBoundaryLines();
        updateScalePreview();
    });
    document.getElementById('scale-lower')?.addEventListener('change', e => {
        const v = parseFloat(e.target.value);
        if (!v || v <= 0) return;
        S.set('scaleLowerPrice', v);
        if (S.scaleUpperPrice && S.scaleLowerPrice >= S.scaleUpperPrice) S.set('scaleLowerPrice', S.scaleUpperPrice - 0.01);
        drawScaleBoundaryLines();
        updateScalePreview();
    });

    // ── Orderbook click → fill limit price / TWAP price limit / Scalper price filter ──
    const obClickHandler = (e) => {
        const row = e.target.closest('.ob-row');
        if (!row) return;
        const price = row.dataset.price;
        if (!price) return;
        const formatted = formatPrice(parseFloat(price));
        const side = row.closest('#ob-asks') ? 'ask' : 'bid'; // ask = sell side, bid = buy side

        if (S.orderType === 'SCALPER') {
            // Ask row clicked → sets max price for buying (LONG max price)
            // Bid row clicked → sets min price for selling (SHORT min price)
            if (side === 'ask') {
                const inp = document.getElementById('scalper-long-max-price');
                if (inp) { inp.value = formatted; showToast(`📌 LONG max set to $${formatted}`, 'info'); }
            } else {
                const inp = document.getElementById('scalper-short-min-price');
                if (inp) { inp.value = formatted; showToast(`📌 SHORT min set to $${formatted}`, 'info'); }
            }
            return;
        }

        if (S.orderType === 'TWAP') {
            // Fill TWAP price limit directly
            const twapInput = document.getElementById('twap-price-limit');
            if (twapInput) {
                twapInput.value = formatted;
                const label = S.selectedSide === 'SHORT' ? 'Min sell' : 'Max buy';
                showToast(`${label} price set to $${formatted}`, 'info');
            }
        } else {
            // Default: switch to LIMIT and fill limit price
            if (S.orderType !== 'LIMIT') setOrderType('LIMIT');
            const priceInput = document.getElementById('limit-price');
            if (priceInput) {
                priceInput.value = formatted;
                showToast(`Limit price set to $${formatted}`, 'info');
            }
        }
    };
    document.getElementById('ob-asks')?.addEventListener('click', obClickHandler);
    document.getElementById('ob-bids')?.addEventListener('click', obClickHandler);

    // ── Load orders + positions ──
    loadOpenOrders();
    document.getElementById('cancel-all-orders')?.addEventListener('click', cancelAllOrders);
    loadTradingPositions();

    // ── Symbol filter checkbox (Current only) ──
    const symFilterCb = document.getElementById('bp-filter-current-sym');
    if (symFilterCb) {
        try { symFilterCb.checked = localStorage.getItem('pms_bp_sym_filter') === '1'; } catch { }
        applySymbolFilter();
        symFilterCb.addEventListener('change', () => {
            try { localStorage.setItem('pms_bp_sym_filter', symFilterCb.checked ? '1' : '0'); } catch { }
            applySymbolFilter();
        });
    }

    // ── Bottom panel tabs ──
    const savedBpTab = localStorage.getItem('pms_bottom_panel_tab') || 'orders';
    _switchBottomTab(savedBpTab);
    document.querySelectorAll('.bp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.bp;
            if (target) _switchBottomTab(target);
        });
    });

}

// ── Cleanup ─────────────────────────────────────

export function cleanup() {
    S.set('_tradingMounted', false);
    teardownStreams();
    stopCompactPoll();
    clearTradingRefreshScheduler();
    stopPerfMetrics();

    if (S.chartResizeObserver) {
        try { S.chartResizeObserver.disconnect(); } catch { }
        S.set('chartResizeObserver', null);
    }

    if (S.chart) { try { S.chart.remove(); } catch { } S.set('chart', null); }

    if (S._marginUpdateHandler) { window.removeEventListener('margin_update', S._marginUpdateHandler); S.set('_marginUpdateHandler', null); }
    if (S._pnlUpdateHandler) { window.removeEventListener('pnl_update', S._pnlUpdateHandler); S.set('_pnlUpdateHandler', null); }
    if (S._docClickHandler) { document.removeEventListener('click', S._docClickHandler); S.set('_docClickHandler', null); }

    S._positionMap.clear();
    S.set('_cachedBalance', 0);
    S.set('_negativeLockState', null);
    S.set('_lastTradingWsPnlTs', 0);
    S.set('candleSeries', null);
    S.set('volumeSeries', null);
    S.set('chartReady', false);
    S.set('chartPriceLines', []);
    S.set('_chartAnnotationCache', null);
    S.set('_chartAnnotationLastFetch', 0);
    S.set('_chartAnnotationGeneration', 0);
    S.set('_chartAnnotationFingerprint', null);
    S.set('_chartAnnotationForceNext', false);
    if (S._chartAnnotationTimer) { clearTimeout(S._chartAnnotationTimer); S.set('_chartAnnotationTimer', null); }

    // Scale cleanup
    teardownScaleDragHandlers();
    clearAllTrailStopLines();
    S.set('scaleChartLines', []);
    S.set('scaleMode', false);
    deactivateMeasure();
    S.set('scaleUpperPrice', null);
    S.set('scaleLowerPrice', null);
    S.set('scaleSkew', 0);
    S.set('scaleClickCount', 0);
    S.set('_scaleClickHandler', null);
    S.set('_scaleBoundaryUpper', null);
    S.set('_scaleBoundaryLower', null);

    // Compact positions cleanup
    for (const sym of Object.keys(S._compactMarkUnsubs)) {
        try { S._compactMarkUnsubs[sym](); } catch { }
    }
    S.set('_compactMarkUnsubs', {});
    S.set('_compactMarkPrices', {});
    if (S._compactPollInterval) { clearInterval(S._compactPollInterval); S.set('_compactPollInterval', null); }

    const cpL = S._compactPosListeners;
    if (cpL._filled) window.removeEventListener('order_filled', cpL._filled);
    if (cpL._closed) window.removeEventListener('position_closed', cpL._closed);
    if (cpL._liquidation) window.removeEventListener('liquidation', cpL._liquidation);
    if (cpL._reduced) window.removeEventListener('position_reduced', cpL._reduced);
    if (cpL._position_updated) window.removeEventListener('position_updated', cpL._position_updated);
    if (cpL._twapProgress) window.removeEventListener('twap_progress', cpL._twapProgress);
    if (cpL._twapCompleted) window.removeEventListener('twap_completed', cpL._twapCompleted);
    if (cpL._twapCancelled) window.removeEventListener('twap_cancelled', cpL._twapCancelled);
    if (cpL._trailTriggered) window.removeEventListener('trail_stop_triggered', cpL._trailTriggered);
    if (cpL._trailCancelled) window.removeEventListener('trail_stop_cancelled', cpL._trailCancelled);
    S.set('_compactPosListeners', {});

    if (S._chartRiskRefreshTimer) { clearTimeout(S._chartRiskRefreshTimer); S.set('_chartRiskRefreshTimer', null); }
}

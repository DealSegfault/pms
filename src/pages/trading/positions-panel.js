// ── Trading Page – Positions Panel (Orchestrator) ──
// Re-exports from specialized modules for backward compatibility.
// Actual logic lives in: open-orders.js, compact-positions.js, chart-annotations.js
//
// This file keeps: formatRelativeTime, applySymbolFilter, prefillOrderForm, clearEditMode,
// and scheduleChartRiskRefresh (re-exported from chart-annotations.js).

import * as S from './state.js';

// ── Re-exports from sub-modules ─────────────────────
export { loadOpenOrders, cancelOrder, cancelAllOrders, cancelSmartOrder, invalidateOpenOrdersSnapshot } from './open-orders.js';
export { loadTradingPositions, connectCompactMarkStreams, recalcCompactPnl, marketClosePosition, updateCompactLiqForPosition } from './compact-positions.js';
export { loadChartAnnotations, refreshChartLeftAnnotationLabels, scheduleChartRiskRefresh, _positionLineRegistry, _orderLineRegistry } from './chart-annotations.js';

// ── Utilities (kept here to avoid circular deps) ────

export function formatRelativeTime(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
}

/**
 * Hide/show rows in both Open Orders and Positions panels
 * based on the "Current only" checkbox.
 */
export function applySymbolFilter() {
    const checked = document.getElementById('bp-filter-current-sym')?.checked;
    const sym = S.selectedSymbol;

    // Open orders rows
    document.querySelectorAll('#open-orders-list .oo-row').forEach(row => {
        const rowSym = row.querySelector('[data-oo-symbol]')?.dataset.ooSymbol;
        row.style.display = (checked && rowSym && rowSym !== sym) ? 'none' : '';
    });

    // Positions rows
    document.querySelectorAll('#compact-pos-list .compact-pos-row').forEach(row => {
        const rowSym = row.dataset.cpSymbol;
        row.style.display = (checked && rowSym && rowSym !== sym) ? 'none' : '';
    });
}

// ── Order Form Prefill ───────────────────────────
// Called when user clicks a complex order type badge in the open orders list.
// Switches the order form to the matching type and populates inputs with current params.
// Sets _editState so each submit function knows to cancel-then-restart.

export function clearEditMode() {
    S.set('_editState', null);
    const banner = document.getElementById('edit-mode-banner');
    if (banner) banner.remove();
    const btn = document.getElementById('submit-trade');
    if (btn && btn.dataset.editModeLabel) {
        btn.textContent = btn.dataset.origLabel || btn.textContent;
        delete btn.dataset.editModeLabel;
        delete btn.dataset.origLabel;
    }
}

export async function prefillOrderForm(params) {
    const { type, symbol, side } = params;

    const [{ setOrderType, setSide, switchSymbol }] = await Promise.all([
        import('./order-form.js'),
    ]);

    // Clear any previous edit mode first
    clearEditMode();

    // Switch symbol if different
    if (symbol && symbol !== (await import('./state.js').then(m => m.selectedSymbol))) {
        await switchSymbol(symbol);
    }

    // Switch side where applicable
    if (side && type !== 'TRAIL') {
        setSide(side);
    }

    // Switch order type (shows the right controls section)
    setOrderType(type);

    // Helper: set input value and fire 'input' event so display labels update
    const setInput = (id, value) => {
        const el = document.getElementById(id);
        if (!el || value == null) return;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!value;
    };

    // Short pause so the DOM has rendered the newly visible controls
    await new Promise(r => requestAnimationFrame(r));

    if (type === 'TWAP') {
        if (params.totalSize) setInput('trade-size', params.totalSize);
        setInput('twap-lots', params.lots ?? 10);
        setInput('twap-duration', params.durationMinutes ?? 30);
        setChecked('twap-jitter', params.jitter);
        setChecked('twap-irregular', params.irregular);
        setInput('twap-price-limit', params.priceLimit || '');
        import('./scale-orders.js').then(m => m.updateTwapPreview?.());
    } else if (type === 'TRAIL') {
        setInput('trail-callback', params.callbackPct ?? 1);
        setInput('trail-activation', params.activationPrice || '');
        if (params.positionId) {
            const sel = document.getElementById('trail-position');
            if (sel) sel.value = params.positionId;
        }
        import('./trail-stop.js').then(m => m.updateTrailPreview?.());
    } else if (type === 'CHASE') {
        if (params.sizeUsd) setInput('trade-size', params.sizeUsd);
        setInput('chase-offset', params.stalkOffsetPct ?? 0);
        setInput('chase-distance', params.maxDistancePct || '');
        if (params.stalkMode) {
            const radio = document.querySelector(`input[name="chase-stalk-mode"][value="${params.stalkMode}"]`);
            if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        import('./chase-limit.js').then(m => m.updateChasePreview?.());
    } else if (type === 'SCALPER') {
        if (params.totalSizeUsd) setInput('trade-size', params.totalSizeUsd);
        setInput('scalper-long-offset', params.longOffsetPct ?? 0.3);
        setInput('scalper-short-offset', params.shortOffsetPct ?? 0.3);
        setInput('scalper-child-count', params.childCount ?? 1);
        setInput('scalper-skew', params.skew ?? 0);
        setInput('scalper-long-max-price', params.longMaxPrice || '');
        setInput('scalper-short-min-price', params.shortMinPrice || '');
        const mode = params.neutralMode ? 'NEUTRAL' : (params.side === 'SHORT' ? 'SHORT' : 'LONG');
        const modeBtn = document.getElementById(`scalper-mode-${mode.toLowerCase()}`);
        if (modeBtn) {
            modeBtn.click();
        } else {
            const ctrl = document.getElementById('scalper-controls');
            if (ctrl) ctrl.dataset.scalperMode = mode;
        }
        setInput('scalper-min-fill-spread', (params.minFillSpreadPct || 0).toFixed(2));
        setInput('scalper-fill-decay-halflife', Math.round((params.fillDecayHalfLifeMs || 30000) / 1000));
        setInput('scalper-min-refill-delay', Math.round((params.minRefillDelayMs || 0) / 1000));
        setChecked('scalper-allow-loss', params.allowLoss ?? false);
        import('./scalper.js').then(m => m.updateScalperPreview?.());


        // ── Set edit mode ──
        if (params.orderId) {
            S.set('_editState', { type, orderId: params.orderId });

            const btn = document.getElementById('submit-trade');
            if (btn) {
                btn.dataset.origLabel = btn.textContent;
                btn.dataset.editModeLabel = '1';
                const labels = { TWAP: 'Update TWAP', TRAIL: 'Update Trail', CHASE: 'Update Chase', SCALPER: 'Update Scalper' };
                btn.textContent = `✏️ ${labels[type] || 'Update'}`;
            }

            const existing = document.getElementById('edit-mode-banner');
            if (existing) existing.remove();
            const banner = document.createElement('div');
            banner.id = 'edit-mode-banner';
            banner.style.cssText = 'background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.4); border-radius:5px; padding:5px 10px; font-size:10px; color:#f59e0b; display:flex; align-items:center; justify-content:space-between; margin:4px 10px 4px;';
            banner.innerHTML = `<span>✏️ Editing ${type} — submit will cancel & restart</span><span id="edit-mode-clear" style="cursor:pointer; opacity:0.7; font-size:12px; padding:0 4px;" title="Cancel edit">✕</span>`;
            const submitBtn = document.getElementById('submit-trade');
            submitBtn?.parentNode?.insertBefore(banner, submitBtn);
            banner.querySelector('#edit-mode-clear')?.addEventListener('click', () => clearEditMode());
        }
    }
}

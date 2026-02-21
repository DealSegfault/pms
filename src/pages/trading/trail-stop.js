// ── Trading Page – Trail Stop Orders ─────────────────────────
// Handles submission, cancellation, chart preview lines, and live trail stop
// visualization on the chart.
import { state, api, showToast, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { showTradeError } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';

// ── Chart line management ───────────────────────

// Preview lines shown while configuring (before submission)
let _previewLines = [];

// Live lines shown for active trail stops (after submission, from WS events)
let _liveLines = [];

// Local mirror of the active trail stop state for the current symbol.
// Allows the frontend to recompute trigger on every price tick.
let _activeTrailState = null;  // { side, callbackPct, extremePrice, triggerPrice, trailStopId }

function clearPreviewLines() {
    if (!S.candleSeries) return;
    for (const line of _previewLines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    _previewLines = [];
}

function clearLiveLines() {
    if (!S.candleSeries) return;
    for (const line of _liveLines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    _liveLines = [];
    _activeTrailState = null;
    removeTrailBand();
}

export function clearAllTrailStopLines() {
    clearPreviewLines();
    clearLiveLines();
}

// ── Chart Preview (before submission) ───────────

/**
 * Draw preview trigger lines on the chart.
 * Shows where the trail stop would trigger based on:
 *  - current price as extreme
 *  - callback percentage from slider
 *  - side of selected position
 */
export function updateTrailPreview() {
    clearPreviewLines();

    const el = document.getElementById('trail-preview');
    const callbackPct = parseFloat(document.getElementById('trail-callback')?.value) || 1;
    const price = S.currentPrice;

    if (!price || !S.candleSeries) {
        if (el) el.textContent = `Callback: ${callbackPct}%`;
        return;
    }

    // Determine side from selected position
    const posSelect = document.getElementById('trail-position');
    const posId = posSelect?.value;
    let side = null;
    if (posId) {
        const row = document.querySelector(`.compact-pos-row[data-cp-id="${posId}"]`);
        side = row?.dataset.cpSide || null;
    }

    if (side) {
        // Position selected — draw single trigger line
        const isLong = side === 'LONG';
        const trigger = isLong
            ? price * (1 - callbackPct / 100)
            : price * (1 + callbackPct / 100);

        // Trigger line (dashed, orange)
        _previewLines.push(S.candleSeries.createPriceLine({
            price: trigger,
            color: '#f59e0b',
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `Trail ${isLong ? '▼' : '▲'} ${callbackPct}%`,
        }));

        // Extreme reference line (dotted, subtle)
        _previewLines.push(S.candleSeries.createPriceLine({
            price,
            color: 'rgba(148,163,184,0.4)',
            lineWidth: 1,
            lineStyle: 3, // dotted
            axisLabelVisible: false,
            title: `${isLong ? 'HWM' : 'LWM'} (current)`,
        }));

        if (el) el.textContent = `${side}: trigger ≈ $${formatPrice(trigger)} (${callbackPct}% from $${formatPrice(price)})`;
    } else {
        // No position selected — show both sides as guide
        const triggerLong = price * (1 - callbackPct / 100);
        const triggerShort = price * (1 + callbackPct / 100);

        _previewLines.push(S.candleSeries.createPriceLine({
            price: triggerLong,
            color: 'rgba(34,197,94,0.5)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: false,
            title: `Long trail ${callbackPct}%`,
        }));
        _previewLines.push(S.candleSeries.createPriceLine({
            price: triggerShort,
            color: 'rgba(239,68,68,0.5)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: false,
            title: `Short trail ${callbackPct}%`,
        }));

        if (el) el.textContent = `LONG: ≈$${formatPrice(triggerLong)} · SHORT: ≈$${formatPrice(triggerShort)}`;
    }
}

// ── Live Trail Stop Visualization ───────────────

let _trailBandEl = null;
let _trailBandRafId = null;
let _trailBandData = null;

function removeTrailBand() {
    if (_trailBandRafId) { cancelAnimationFrame(_trailBandRafId); _trailBandRafId = null; }
    if (_trailBandEl) { _trailBandEl.remove(); _trailBandEl = null; }
    _trailBandData = null;
}

function createTrailBandEl() {
    const container = document.getElementById('tv-chart');
    if (!container) return null;

    const el = document.createElement('div');
    el.id = 'trail-stop-band';
    el.style.cssText = `
        position: absolute; left: 0; right: 54px; pointer-events: none; z-index: 5;
        display: flex; flex-direction: column; justify-content: space-between;
        border-radius: 2px; transition: top 0.08s linear, height 0.08s linear;
        overflow: hidden; min-height: 6px;
    `;
    el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:1px 8px; font-size:9px; font-weight:700; white-space:nowrap;">
            <span id="tsb-extreme-label"></span>
            <span id="tsb-pct" style="opacity:0.9;"></span>
        </div>
        <div id="tsb-current-marker" style="position:absolute; right:8px; font-size:9px; font-weight:600; opacity:0.8;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; padding:1px 8px; font-size:9px; font-weight:700; white-space:nowrap;">
            <span id="tsb-trigger-label"></span>
            <span style="opacity:0.6;">⚡ trigger</span>
        </div>
    `;
    container.appendChild(el);
    return el;
}

function repositionTrailBand() {
    if (!_trailBandEl || !_trailBandData || !S.candleSeries) {
        removeTrailBand();
        return;
    }

    const { extremePrice, triggerPrice, side, callbackPct, currentPrice } = _trailBandData;
    const isLong = side === 'LONG';

    const extremeY = S.candleSeries.priceToCoordinate(extremePrice);
    const triggerY = S.candleSeries.priceToCoordinate(triggerPrice);

    if (extremeY == null || triggerY == null) {
        _trailBandEl.style.display = 'none';
        _trailBandRafId = requestAnimationFrame(repositionTrailBand);
        return;
    }

    const top = Math.min(extremeY, triggerY);
    const height = Math.max(Math.abs(triggerY - extremeY), 6);

    _trailBandEl.style.display = '';
    _trailBandEl.style.top = `${top}px`;
    _trailBandEl.style.height = `${height}px`;

    const bg = isLong
        ? 'linear-gradient(180deg, rgba(34,197,94,0.18) 0%, rgba(245,158,11,0.25) 100%)'
        : 'linear-gradient(0deg, rgba(239,68,68,0.18) 0%, rgba(245,158,11,0.25) 100%)';
    _trailBandEl.style.background = bg;
    _trailBandEl.style.borderTop = isLong ? '1px solid rgba(34,197,94,0.5)' : '1px solid rgba(245,158,11,0.5)';
    _trailBandEl.style.borderBottom = isLong ? '1px solid rgba(245,158,11,0.5)' : '1px solid rgba(239,68,68,0.5)';

    // Labels
    const extremeLabel = _trailBandEl.querySelector('#tsb-extreme-label');
    const triggerLabel = _trailBandEl.querySelector('#tsb-trigger-label');
    const pctLabel = _trailBandEl.querySelector('#tsb-pct');
    const currentMarker = _trailBandEl.querySelector('#tsb-current-marker');

    if (extremeLabel) extremeLabel.textContent = `${isLong ? '▲ HWM' : '▼ LWM'} $${formatPrice(extremePrice)}`;
    if (triggerLabel) triggerLabel.textContent = `⚡ $${formatPrice(triggerPrice)}`;
    if (pctLabel) pctLabel.textContent = `${callbackPct}%`;

    if (extremeLabel) extremeLabel.style.color = isLong ? '#22c55e' : '#ef4444';
    if (triggerLabel) triggerLabel.style.color = '#f59e0b';
    if (pctLabel) pctLabel.style.color = '#f59e0b';

    // Current price marker inside the band
    if (currentMarker && currentPrice) {
        const curY = S.candleSeries.priceToCoordinate(currentPrice);
        if (curY != null) {
            const relY = curY - top;
            currentMarker.style.top = `${Math.max(0, Math.min(height - 12, relY - 6))}px`;
            currentMarker.textContent = `◀ $${formatPrice(currentPrice)}`;
            currentMarker.style.color = 'var(--text-muted)';
        }
    }

    _trailBandRafId = requestAnimationFrame(repositionTrailBand);
}

/**
 * Draw live trail stop band + lines on the chart.
 * Called from WS trail_stop_progress events.
 */
export function drawLiveTrailStop(data) {
    clearLiveLines();
    if (!S.candleSeries) return;
    if (!data.triggerPrice) return;

    // Store state so onTrailPriceTick can update locally
    _activeTrailState = {
        side: data.side,
        callbackPct: data.callbackPct,
        extremePrice: data.extremePrice || data.triggerPrice,
        triggerPrice: data.triggerPrice,
        trailStopId: data.trailStopId,
    };

    _drawTriggerLine(data.triggerPrice);
}

function _drawTriggerLine(triggerPrice) {
    // Remove existing lines (without clearing state)
    if (S.candleSeries) {
        for (const line of _liveLines) {
            try { S.candleSeries.removePriceLine(line); } catch { }
        }
    }
    _liveLines = [];
    if (!S.candleSeries || !triggerPrice) return;

    _liveLines.push(S.candleSeries.createPriceLine({
        price: triggerPrice,
        color: '#f59e0b',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: 'trail',
    }));
}

/**
 * Called on every frontend price tick to locally update the trail stop line.
 * Mirrors the backend computeTriggerPrice logic for smooth real-time updates.
 */
export function onTrailPriceTick(price) {
    if (!_activeTrailState || !price || !Number.isFinite(price)) return;
    const ts = _activeTrailState;

    // Update extreme price locally
    let changed = false;
    if (ts.side === 'LONG' && price > ts.extremePrice) {
        ts.extremePrice = price;
        changed = true;
    } else if (ts.side === 'SHORT' && price < ts.extremePrice) {
        ts.extremePrice = price;
        changed = true;
    }

    if (changed) {
        // Recompute trigger
        ts.triggerPrice = ts.side === 'LONG'
            ? ts.extremePrice * (1 - ts.callbackPct / 100)
            : ts.extremePrice * (1 + ts.callbackPct / 100);
        _drawTriggerLine(ts.triggerPrice);
    }
}

// ── Fetch & Draw Active Trail Stops ─────────────

/**
 * Fetch all active trail stops for the current account + symbol
 * and render them on the chart. Called on:
 *  - Page load / chart init (after candles are loaded)
 *  - Symbol switch
 */
export async function fetchAndDrawActiveTrailStops() {
    if (!state.currentAccount || !S.candleSeries) return;
    try {
        const trailStops = await api(`/trade/trail-stop/active/${state.currentAccount}`);
        if (!Array.isArray(trailStops) || trailStops.length === 0) {
            clearLiveLines();
            return;
        }
        // Find trail stop for the currently viewed symbol
        const ts = trailStops.find(t => t.symbol === S.selectedSymbol && t.activated);
        if (ts && ts.extremePrice && ts.triggerPrice) {
            drawLiveTrailStop({
                trailStopId: ts.trailStopId,
                symbol: ts.symbol,
                side: ts.side,
                callbackPct: ts.callbackPct,
                extremePrice: ts.extremePrice,
                triggerPrice: ts.triggerPrice,
                currentPrice: S.currentPrice || ts.extremePrice,
                activated: ts.activated,
            });
        } else {
            clearLiveLines();
        }
    } catch (err) {
        console.debug('[TrailStop] Failed to fetch active trail stops:', err.message);
    }
}

// ── Submit / Cancel ─────────────────────────────

export async function submitTrailStop() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');

    // ── Edit mode: cancel old Trail Stop first ─────────────────────
    const editState = S._editState?.type === 'TRAIL' ? S._editState : null;
    if (editState) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.());
        try { await api(`/trade/trail-stop/${editState.orderId}`, { method: 'DELETE' }); } catch { }
    }

    const posSelect = document.getElementById('trail-position');

    const positionId = posSelect?.value;
    if (!positionId) return showToast('Select a position to attach trail stop', 'error');

    const callbackPct = parseFloat(document.getElementById('trail-callback')?.value) || 1;
    const activationPriceRaw = parseFloat(document.getElementById('trail-activation')?.value);
    const activationPrice = Number.isFinite(activationPriceRaw) && activationPriceRaw > 0 ? activationPriceRaw : null;

    const selectedOption = posSelect.options[posSelect.selectedIndex];
    const posLabel = selectedOption?.textContent || positionId;

    const confirmed = await cuteConfirm({
        title: `Trail Stop`,
        message: `Position: ${posLabel}\nCallback: ${callbackPct}%${activationPrice ? `\nActivation: $${formatPrice(activationPrice)}` : '\nActivation: Immediate'}`,
        confirmText: 'Start Trail Stop',
        danger: true,
    });
    if (!confirmed) return;

    try {
        const result = await api('/trade/trail-stop', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                positionId,
                callbackPct,
                ...(activationPrice ? { activationPrice } : {}),
            },
        });
        if (result.success) {
            showToast(`Trail stop started: ${result.symbol} ${result.side}, ${callbackPct}% callback`, 'success');

            // Clear preview and draw initial live lines
            clearPreviewLines();
            if (result.triggerPrice && result.extremePrice) {
                drawLiveTrailStop(result);
            }

            scheduleTradingRefresh({ positions: true, openOrders: true }, 30);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Trail stop failed to start'}`, 'error');
        }
    }
}

export async function cancelTrailStop(trailStopId) {
    showToast('Cancelling trail stop...', 'info');
    try {
        const result = await api(`/trade/trail-stop/${trailStopId}`, { method: 'DELETE' });
        showToast(`Trail stop cancelled (${result.symbol})`, 'success');
        clearLiveLines();
        scheduleTradingRefresh({ positions: true, openOrders: true }, 30);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

// ── Position Dropdown ───────────────────────────

export async function refreshTrailPositionDropdown() {
    const select = document.getElementById('trail-position');
    if (!select) return;

    const options = ['<option value="">— Select position —</option>'];

    const posRows = document.querySelectorAll('#compact-pos-list .compact-pos-row');
    posRows.forEach(row => {
        const posId = row.dataset.cpId;
        const sym = row.dataset.cpSymbol || '';
        const side = row.dataset.cpSide || '';
        const notional = row.dataset.cpNotional || '';
        if (posId) {
            const label = `${sym.split('/')[0]} ${side}${notional ? ` ($${parseFloat(notional).toFixed(0)})` : ''}`;
            options.push(`<option value="${posId}">${label}</option>`);
        }
    });

    if (options.length <= 1 && state.currentAccount) {
        try {
            const data = await api(`/trade/positions/${state.currentAccount}`);
            for (const pos of (data.positions || [])) {
                const label = `${pos.symbol.split('/')[0]} ${pos.side} ($${(pos.notional || 0).toFixed(0)})`;
                options.push(`<option value="${pos.id}">${label}</option>`);
            }
        } catch { /* ignore */ }
    }

    if (options.length <= 1) {
        select.innerHTML = '<option value="">No open positions</option>';
        return;
    }

    select.innerHTML = options.join('');
}

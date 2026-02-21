// ── Trading Page – SURF Orders ──────────────────────────────
// Handles submission, cancellation, chart line visualization, and live
// SURF updates on the chart.
import { state, api, showToast, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { showTradeError } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';

// ── Chart line management ───────────────────────

// Active SURFs: pumpChaserId → { state, lines[] }
const _activePumpChasers = new Map();

function _removeLinesForPC(entry) {
    if (!S.candleSeries || !entry?.lines) return;
    for (const line of entry.lines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    entry.lines = [];
}

export function clearAllPumpChaserLines() {
    for (const [, entry] of _activePumpChasers) _removeLinesForPC(entry);
    _activePumpChasers.clear();
}

// Legacy compat exports (continuous mode removed)
export function getContinuousConfig() { return null; }
export function clearContinuousMode() { }

// ── Live SURF Visualization ─────────────────────

/**
 * Draw/update live SURF lines on the chart.
 * Called from WS pump_chaser_progress events.
 * Shows: Extreme (red/green), Gate (amber), Start Price (gray), Fill prices, Deleverage level.
 */
export function drawLivePumpChaser(data) {
    if (!S.candleSeries) return;
    if (!data.pumpChaserId) return;

    // Only draw lines for SURFs on the currently viewed symbol
    if (data.symbol && data.symbol !== S.selectedSymbol) return;

    const id = data.pumpChaserId;
    let entry = _activePumpChasers.get(id);
    if (!entry) {
        entry = { state: null, lines: [], fillLines: [] };
        _activePumpChasers.set(id, entry);
    }

    entry.state = data;

    // Redraw all lines
    _removeLinesForPC(entry);

    const sym = data.symbol?.split('/')[0] || '';
    const isShort = data.side === 'SHORT';

    // Extreme line (HWM for SHORT = red, LWM for LONG = green)
    if (data.extreme) {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: data.extreme,
            color: isShort ? '#ef4444' : '#22c55e',
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: isShort ? `🔺 HWM` : `🔻 LWM`,
        }));
    }

    // Gate line (floor for SHORT = amber, ceiling for LONG = amber)
    if (data.gate) {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: data.gate,
            color: '#f59e0b',
            lineWidth: 2,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: isShort ? `🛡️ Floor` : `🛡️ Ceiling`,
        }));
    }

    // Start price (faint gray dotted)
    if (data.startPrice && data.startPrice !== data.extreme) {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: data.startPrice,
            color: 'rgba(148,163,184,0.3)',
            lineWidth: 1,
            lineStyle: 3, // dotted
            axisLabelVisible: false,
            title: `${sym} start`,
        }));
    }

    // Last fill price
    if (data.lastFillPrice) {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: data.lastFillPrice,
            color: isShort ? '#f97316' : '#22c55e',
            lineWidth: 1,
            lineStyle: 0, // solid
            axisLabelVisible: true,
            title: `💰 Last fill`,
        }));
    }

    // Chase price line (live fill trigger level)
    if (data.chasePrice && data.state !== 'DELEVERAGING' && data.state !== 'IDLE') {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: data.chasePrice,
            color: '#06b6d4', // cyan
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `🎯 Chase`,
        }));
    }

    // Pending scalp round-trip orders (purple dotted)
    const pendingScalps = Array.isArray(data.scalp?.pending) ? data.scalp.pending : [];
    for (const scalp of pendingScalps) {
        if (!scalp.price) continue;
        entry.lines.push(S.candleSeries.createPriceLine({
            price: scalp.price,
            color: '#a855f7', // purple
            lineWidth: 1,
            lineStyle: 3, // dotted
            axisLabelVisible: false,
            title: `💜 Scalp`,
        }));
    }

    // Deleverage order line (when in DELEVERAGING state)
    if (data.deleverage?.price) {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: data.deleverage.price,
            color: '#f43f5e', // rose
            lineWidth: 2,
            lineStyle: 1, // long dashed
            axisLabelVisible: true,
            title: `📉 Unwind`,
        }));
    }

    // Update the status panel if it exists
    _updateStatusPanel(data);
}

/** Remove a single SURF by ID. */
export function removePumpChaser(pumpChaserId) {
    const entry = _activePumpChasers.get(pumpChaserId);
    if (entry) {
        _removeLinesForPC(entry);
        _activePumpChasers.delete(pumpChaserId);
    }
    _clearStatusPanel();
}

// ── Status panel (inline in the form area) ──────

function _updateStatusPanel(data) {
    const panel = document.getElementById('surf-status-panel');
    if (!panel) return;

    const coreUnrealized = data.core?.unrealized ?? 0;
    const netPnl = data.netPnl ?? 0;
    const pnlColor = netPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const scalpColor = (data.scalp?.totalProfit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)';
    const sideLabel = data.side === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const posNotional = data.positionNotional || 0;
    const maxNotional = data.maxNotional || 0;
    const posPct = maxNotional > 0 ? Math.round((posNotional / maxNotional) * 100) : 0;
    const isDeleveraging = data.state === 'DELEVERAGING';

    panel.style.display = '';
    panel.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-muted); margin-bottom:3px;">
            <span>${sideLabel} · State: <b style="color:${isDeleveraging ? '#f43f5e' : 'var(--text)'};">${data.state || '—'}</b></span>
            <span>Fills: <b style="color:var(--text);">${data.fillCount || 0}</b></span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:2px;">
            <span style="color:var(--text-muted);">Position</span>
            <span style="color:var(--text); font-weight:600;">$${posNotional.toFixed(0)} / $${maxNotional.toFixed(0)} <small style="color:var(--text-muted);">(${posPct}%)</small></span>
        </div>
        <div style="background:var(--surface-1, #1a1a2e); border-radius:3px; height:4px; margin-bottom:4px; overflow:hidden;">
            <div style="width:${posPct}%; height:100%; background:${isDeleveraging ? '#f43f5e' : 'var(--accent)'}; transition:width 0.3s;"></div>
        </div>
        ${isDeleveraging && data.deleverage ? `
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:2px;">
            <span style="color:#f43f5e;">📉 Unwind order</span>
            <span style="color:var(--text); font-weight:600;">${data.deleverage.qty} @ $${formatPrice(data.deleverage.price)}</span>
        </div>` : ''}
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:2px;">
            <span style="color:var(--text-muted);">Amp</span>
            <span style="color:var(--text); font-weight:600;">${(data.amplitude || 0).toFixed(2)}%</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:2px;">
            <span style="color:var(--text-muted);">Core</span>
            <span style="color:var(--text); font-weight:600;">${(data.core?.qty || 0).toFixed(1)} @ $${formatPrice(data.core?.vwap || 0)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:2px;">
            <span style="color:var(--text-muted);">Scalp P&L</span>
            <span style="font-weight:600; color:${scalpColor};">+$${(data.scalp?.totalProfit || 0).toFixed(3)}</span>
        </div>
        ${(data.deleverageCount || 0) > 0 ? `
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:2px;">
            <span style="color:var(--text-muted);">Deleverages</span>
            <span style="color:var(--text); font-weight:600;">${data.deleverageCount}</span>
        </div>` : ''}
        <div style="display:flex; justify-content:space-between; font-size:10px; border-top:1px solid var(--border); padding-top:3px; margin-top:2px;">
            <span style="color:var(--text-muted);">Net P&L</span>
            <span style="font-weight:700; color:${pnlColor};">${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}</span>
        </div>
    `;
}

function _clearStatusPanel() {
    const panel = document.getElementById('surf-status-panel');
    if (panel) { panel.innerHTML = ''; panel.style.display = 'none'; }
}

// ── Submit / Cancel ─────────────────────────────

export async function submitPumpChaser() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');

    // ── Edit mode: cancel old SURF first ───────────────────────────
    const editState = S._editState?.type === 'SURF' ? S._editState : null;
    if (editState) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.());
        try { await api(`/trade/pump-chaser/${editState.orderId}`, { method: 'DELETE' }); } catch { }
    }

    const maxNotional = parseFloat(document.getElementById('surf-max-pos')?.value) || 0;

    if (maxNotional < 10) return showToast('Max position must be at least $10', 'error');

    const side = S.selectedSide || 'SHORT';
    const scalpRatio = parseFloat(document.getElementById('surf-scalp-ratio')?.value) / 100 || 0.6;
    const volOffsetBps = parseFloat(document.getElementById('surf-offset-bps')?.value) || 0.3;

    const leverage = S.leverage;
    const sideLabel = side === 'LONG' ? 'Long' : 'Short';

    const confirmed = await cuteConfirm({
        title: `🏄 Surf ${sideLabel}`,
        message: `${S.selectedSymbol.split('/')[0]} — ${sideLabel} SURF\n` +
            `Max position: $${maxNotional.toFixed(0)}\n` +
            `Strategy: ${(scalpRatio * 100).toFixed(0)}% scalp / ${((1 - scalpRatio) * 100).toFixed(0)}% hold\n` +
            `Offset: ${volOffsetBps.toFixed(1)} bps\n` +
            `Leverage: ${leverage}×\n` +
            `♻️ Auto-deleverages at cap, recycles capital`,
        confirmText: `Surf ${sideLabel}`,
        danger: false,
    });
    if (!confirmed) return;

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const result = await api('/trade/pump-chaser', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                maxNotional,
                leverage,
                side,
                scalpRatio,
                volOffsetBps,
            },
        });
        if (result.success) {
            showToast(`🏄 SURF ${sideLabel} started: ${result.symbol?.split('/')[0] || ''} — $${maxNotional} max (${result.profile})`, 'success');
            scheduleTradingRefresh({ openOrders: true }, 500);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'SURF failed'}`, 'error');
        }
    } finally {
        const sideLabel2 = side === 'LONG' ? 'Long' : 'Short';
        if (btn) { btn.disabled = false; btn.textContent = `🏄 Surf ${sideLabel2}`; }
    }
}

export async function cancelPumpChaser(pumpChaserId) {
    showToast('Stopping SURF...', 'info');
    try {
        const result = await api(`/trade/pump-chaser/${pumpChaserId}`, { method: 'DELETE' });
        const sym = result.symbol ? result.symbol.split('/')[0] : '';
        const sideLabel = result.side === 'LONG' ? 'L' : 'S';
        showToast(`SURF ${sideLabel} stopped (${sym}) — Scalp: +$${(result.scalpProfit || 0).toFixed(3)} — Net: $${(result.netPnl || 0).toFixed(2)}`, 'success');
        removePumpChaser(pumpChaserId);
        scheduleTradingRefresh({ openOrders: true, positions: true }, 300);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

// ── Preview update ──────────────────────────────

export function updatePumpChaserPreview() {
    const el = document.getElementById('surf-preview');
    if (!el) return;

    const maxNotional = parseFloat(document.getElementById('surf-max-pos')?.value) || 0;
    const scalpRatio = parseFloat(document.getElementById('surf-scalp-ratio')?.value) || 60;
    const side = S.selectedSide || 'SHORT';

    if (maxNotional < 10) {
        el.textContent = 'Enter max position ≥ $10';
        return;
    }

    const price = S.currentPrice;
    if (!price) {
        el.textContent = 'Waiting for price...';
        return;
    }

    const baseNotional = (maxNotional / 15).toFixed(0);
    const sideIcon = side === 'LONG' ? '📈' : '📉';

    el.innerHTML = `
        <span style="color:var(--text);">${sideIcon} Max $${maxNotional} · ~$${baseNotional}/fill</span> · 
        <span>${scalpRatio}% scalp</span> · 
        <span style="color:#f43f5e;">♻️ auto-deleverage</span>
    `;
}

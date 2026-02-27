// ── Trading Page – Scalper (Double Chase) ────────────────────
// Submit, cancel, offset preview for the Scalper order type.
// Chart visualization is handled automatically by drawLiveChase
// since child chases are regular (non-internal) chase orders.
import { state, api, showToast } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { showTradeError } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';

// ── Preview (before submission) ───────────────────────────────

export function updateScalperPreview() {
    const el = document.getElementById('scalper-preview');
    const longOff = parseFloat(document.getElementById('scalper-long-offset')?.value) || 0;
    const shortOff = parseFloat(document.getElementById('scalper-short-offset')?.value) || 0;
    const count = parseInt(document.getElementById('scalper-child-count')?.value) || 1;
    const skew = parseInt(document.getElementById('scalper-skew')?.value) || 0;
    if (!el) return;

    const totalSizeUsd = parseFloat(document.getElementById('trade-size')?.value) || 0;
    const perSideUsd = totalSizeUsd;
    const price = S.currentPrice || 0;
    const weights = _computeSkewWeights(count, skew);
    const longLayers = _computePreviewOffsets(longOff, count);
    const shortLayers = _computePreviewOffsets(shortOff, count);
    const minNotional = _minLayerNotional(perSideUsd, count, skew, price);
    const tooSmall = minNotional + 0.001 < MIN_NOTIONAL && price > 0 && perSideUsd > 0;

    const scalperMode = document.getElementById('scalper-controls')?.dataset?.scalperMode || 'LONG';
    const maxW = Math.max(...weights);

    // ── Mini orderbook display ─────────────────────────────────
    // Short layers (sells) at top, long layers at bottom — mimics an OB
    const mkRow = (offsets, ws, side) => offsets.map((off, i) => {
        const layerUsd = perSideUsd > 0 ? ws[i] * perSideUsd : null;
        const barPct = Math.round((ws[i] / maxW) * 100);
        const sideColor = side === 'long' ? 'var(--cyan,#06b6d4)' : 'var(--orange,#f97316)';
        const barBg = side === 'long' ? 'rgba(6,182,212,0.22)' : 'rgba(249,115,22,0.22)';
        const barAlign = side === 'long' ? 'right' : 'left';
        const sizeStr = layerUsd != null ? `$${layerUsd.toFixed(1)}` : '';
        const barStyle = side === 'long'
            // Long bar fills from RIGHT (mimics bid side of OB)
            ? `background:linear-gradient(to left, ${barBg} ${barPct}%, transparent ${barPct}%)`
            : `background:linear-gradient(to right, ${barBg} ${barPct}%, transparent ${barPct}%)`;
        return `<div style="display:flex; justify-content:space-between; align-items:center; padding:1px 0; font-size:9px; ${barStyle}">
  <span style="color:${sideColor}; font-family:var(--font-mono); font-weight:600; min-width:48px;">${off.toFixed(3)}%</span>
  <span style="color:var(--text-muted); font-size:8px;">L${i + 1}</span>
  <span style="color:${sideColor}; font-family:var(--font-mono); min-width:40px; text-align:right;">${sizeStr}</span>
</div>`;
    }).join('');

    // Render: SHORT on top, spread label in middle, LONG on bottom
    const shortRows = mkRow([...shortLayers].reverse(), [...weights].reverse(), 'short');
    const longRows = mkRow(longLayers, weights, 'long');

    let html = `<div style="border:1px solid rgba(255,255,255,0.07); border-radius:5px; overflow:hidden; margin-bottom:4px;">`;
    if (scalperMode !== 'LONG') {
        html += `<div style="padding:0 4px;">${shortRows}</div>`;
    }
    // Spread divider
    const spreadPct = longOff + shortOff;
    html += `<div style="text-align:center; font-size:8px; color:var(--text-muted); padding:2px 4px; background:rgba(255,255,255,0.03); border-top:${scalperMode !== 'LONG' ? '1px solid rgba(255,255,255,0.07)' : 'none'}; border-bottom:${scalperMode !== 'SHORT' ? '1px solid rgba(255,255,255,0.07)' : 'none'};">`;
    html += `⟺ spread ${spreadPct.toFixed(3)}%`;
    if (price > 0) html += ` · $${(price * spreadPct / 100).toFixed(2)}`;
    html += `</div>`;
    if (scalperMode !== 'SHORT') {
        html += `<div style="padding:0 4px;">${longRows}</div>`;
    }
    html += `</div>`;

    if (tooSmall) {
        const minWeight = Math.min(...weights);
        const minSize = (MIN_NOTIONAL / minWeight).toFixed(0);
        const skewNote = skew !== 0 ? ' (adjusted for skew)' : ` (${count} layers × $${MIN_NOTIONAL})`;
        html += `<span style="color:#f43f5e; font-size:10px;">⚠ Min size: $${minSize}/side${skewNote}</span>`;
    }
    if (scalperMode === 'NEUTRAL') {
        html += `<br><span style="color:#a855f7; font-size:9px; font-weight:600;">🧲 NEUTRAL — both legs open, position rides freely</span>`;
    }

    el.innerHTML = html;
}

function _computePreviewOffsets(baseOffset, count, maxSpread = 2.0) {
    if (count <= 1) return [baseOffset];
    const step = Math.log(maxSpread) / (count - 1);
    return Array.from({ length: count }, (_, i) =>
        baseOffset * Math.exp(-Math.log(maxSpread) / 2 + step * i)
    );
}

function _computeSkewWeights(count, skew) {
    if (count <= 1) return [1];
    const s = skew / 100;
    const w = Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        return Math.pow(8, s * (2 * t - 1));
    });
    const total = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / total);
}

const MIN_NOTIONAL = 5; // USD, Binance limit

/** Returns the smallest layer notional in USD for the opening leg. */
function _minLayerNotional(perSideUsd, count, skew, price) {
    if (!price || price <= 0) return Infinity;
    const weights = _computeSkewWeights(count, skew);
    return Math.min(...weights.map(w => w * perSideUsd));
}

// ── Submit / Cancel ───────────────────────────────────────────

export async function submitScalper() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');

    // ── Edit mode: cancel old Scalper first ────────────────────────
    const editState = S._editState?.type === 'SCALPER' ? S._editState : null;
    if (editState) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.());
        try { await api(`/trade/scalper/${editState.orderId}`, { method: 'DELETE' }); } catch { }
    }

    const sizeInput = document.getElementById('trade-size');
    const totalSizeUsd = parseFloat(sizeInput?.value) || 0;
    if (totalSizeUsd <= 0) return showToast('Enter a trade size', 'error');


    const longOff = parseFloat(document.getElementById('scalper-long-offset')?.value) || 0;
    const shortOff = parseFloat(document.getElementById('scalper-short-offset')?.value) || 0;
    const count = parseInt(document.getElementById('scalper-child-count')?.value) || 1;
    const skew = parseInt(document.getElementById('scalper-skew')?.value) || 0;

    const perSideUsd = totalSizeUsd;

    // Client-side guard: block if any layer would be < $5
    const minLayerNotional = _minLayerNotional(perSideUsd, count, skew, S.currentPrice || 0);
    if (S.currentPrice > 0 && minLayerNotional + 0.001 < MIN_NOTIONAL) {
        const weights = _computeSkewWeights(count, skew);
        const minWeight = Math.min(...weights);
        const minNeeded = (MIN_NOTIONAL / minWeight).toFixed(0);
        return showToast(`Min size is $${minNeeded} ($${MIN_NOTIONAL} min per layer, adjusted for skew)`, 'error');
    }

    const scalperMode = document.getElementById('scalper-controls')?.dataset?.scalperMode || 'LONG';
    const _neutralMode = scalperMode === 'NEUTRAL';
    // For NEUTRAL, we start both legs so startSide is LONG by convention (server handles it)
    const startSide = _neutralMode ? 'LONG' : scalperMode; // LONG | SHORT

    const confirmed = await cuteConfirm({
        title: `⚔️ Start Scalper — ${S.selectedSymbol.split('/')[0]}`,
        message:
            `Mode: ${scalperMode}\n` +
            `Long offset: ${longOff.toFixed(3)}% · Short offset: ${shortOff.toFixed(3)}%\n` +
            `${count} layer${count > 1 ? 's' : ''}/side · $${perSideUsd.toFixed(2)}/side · skew ${skew}\n` +
            `Leverage: ${S.leverage}×\n` +
            (_neutralMode
                ? '🧲 Neutral Mode: both legs open, position rides freely'
                : `${scalperMode === 'LONG' ? 'Short orders are reduce-only' : 'Long orders are reduce-only'}`),
        confirmText: 'Start Scalper',
        danger: false,
    });
    if (!confirmed) return;

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const result = await api('/trade/scalper', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                startSide,
                leverage: S.leverage,
                longOffsetPct: longOff,
                shortOffsetPct: shortOff,
                childCount: count,
                skew,
                longSizeUsd: perSideUsd,
                shortSizeUsd: perSideUsd,
                longMaxPrice: parseFloat(document.getElementById('scalper-long-max-price')?.value) || null,
                shortMinPrice: parseFloat(document.getElementById('scalper-short-min-price')?.value) || null,
                pinLongToEntry: document.getElementById('scalper-pin-long-max')?.checked ?? false,
                pinShortToEntry: document.getElementById('scalper-pin-short-min')?.checked ?? false,
                // Neutral mode + anti-overtrading
                neutralMode: _neutralMode,
                minFillSpreadPct: parseFloat(document.getElementById('scalper-min-fill-spread')?.value) || 0,
                fillDecayHalfLifeMs: (parseInt(document.getElementById('scalper-fill-decay-halflife')?.value) || 30) * 1000,
                minRefillDelayMs: (parseInt(document.getElementById('scalper-min-refill-delay')?.value) || 0) * 1000,
                allowLoss: document.getElementById('scalper-allow-loss')?.checked ?? false,
                // Risk guards (from trade analysis)
                maxLossPerCloseBps: parseInt(document.getElementById('scalper-max-loss-close')?.value) || 0,
                maxFillsPerMinute: parseInt(document.getElementById('scalper-max-fills-pm')?.value) || 0,
                pnlFeedbackMode: document.getElementById('scalper-feedback-mode')?.value || 'off',
            },
        });

        if (result.success) {
            try { const _snd = new Audio('/start_engine.mp3'); _snd.play(); setTimeout(() => { _snd.pause(); _snd.currentTime = 0; }, 5000); } catch { }
            showToast(
                `⚔️ Scalper started: ${result.symbol?.split('/')[0]} · ` +
                `${result.longLayers}L + ${result.shortLayers}S layers`,
                'success'
            );
            scheduleTradingRefresh({ openOrders: true }, 30);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Scalper failed'}`, 'error');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '⚔️ Start Scalper';
        }
    }
}

/**
 * Called by ws-handlers when scalper_cancelled fires.
 * Removes all child chase chart lines that belong to this scalper.
 * Without this, lines from child chases linger on the chart after stop.
 */
export async function clearScalperById(scalperId) {
    if (!scalperId) return;
    try {
        const { removeChase } = await import('./chase-limit.js');
        // Remove chart lines for each child chase in the drawer
        const drawer = document.querySelector(`[data-scalper-drawer="${scalperId}"]`);
        if (drawer) {
            drawer.querySelectorAll('[data-chase-id]').forEach(el => {
                removeChase(el.dataset.chaseId);
            });
        }
        // Optimistically remove the scalper parent row + drawer from DOM
        document.querySelector(`[data-scalper-id="${scalperId}"]`)?.remove();
        drawer?.remove();
    } catch { /* ignore — chart might not be mounted */ }
}

export async function cancelScalper(scalperId) {
    const confirmed = await cuteConfirm({
        title: 'Stop Scalper',
        message: 'Stop scalper orders only, or also close any open positions?',
        confirmText: '🧹 Stop & Close',
        cancelText: '⏹ Stop Only',
        // Three-way: the user can dismiss (no action), click Stop Only, or Stop & Close
    });
    // confirmed = true → Stop & Close, false → Stop Only (not dismissed)
    // null / undefined → dismissed (do nothing)
    if (confirmed === undefined || confirmed === null) {
        // Actually cuteConfirm only returns true/false, false = cancel button = "Stop Only"
        // We hijack the cancel button as "Stop Only"
    }

    const closePositions = confirmed === true;
    showToast(closePositions ? 'Stopping scalper & closing positions...' : 'Stopping scalper...', 'info');
    try {
        await api(`/trade/scalper/${scalperId}${closePositions ? '?close=1' : ''}`, { method: 'DELETE' });
        showToast(closePositions ? 'Scalper stopped & positions closed' : 'Scalper stopped', 'success');
        scheduleTradingRefresh({ openOrders: true }, 30);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

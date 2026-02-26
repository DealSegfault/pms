// ── Trading Page – Order Form Logic ──────────────────────────
import { state, api, showToast, formatPrice, formatUsd } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import { cuteKittenSearch, cuteWallet } from '../../lib/cute-empty.js';
import { submitTwapOrder } from './twap.js';
import { submitTrailStop } from './trail-stop.js';
import { submitChase } from './chase-limit.js';
import { submitScalper } from './scalper.js';
import { submitAgent } from './agents.js';
import { submitSmartOrder } from './smart-order.js';
import * as S from './state.js';
import { formatQty } from './orderbook.js';
import { initChart, fetchTickerData, fetchSymbolInfo } from './chart.js';
import { clearScalePreviewLines, removeScaleBoundaryLines, teardownScaleDragHandlers, updateTwapPreview } from './scale-orders.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { beginOrderLatency, markOrderSent, markOrderAck, markOrderPaint } from './perf-metrics.js';

// ── Side / Leverage / Size ──────────────────────

export function setSide(side) {
    S.set('selectedSide', side);
    localStorage.setItem('pms_trade_side', side);
    const btnL = document.getElementById('btn-long');
    const btnN = document.getElementById('btn-neutral');
    const btnS = document.getElementById('btn-short');
    if (btnL) btnL.className = side === 'LONG' ? 'active-long' : '';
    if (btnN) btnN.className = side === 'NEUTRAL' ? 'active-neutral' : '';
    if (btnS) btnS.className = side === 'SHORT' ? 'active-short' : '';

    refreshSubmitButton();

    // Update TWAP price limit label/hint for current side
    const plLabel = document.getElementById('twap-price-limit-label');
    if (plLabel) plLabel.textContent = side === 'SHORT' ? 'Min Sell Price' : 'Max Buy Price';
    const plHint = document.getElementById('twap-price-limit-hint');
    if (plHint) plHint.textContent = side === 'SHORT' ? 'TWAP will skip lots if price drops below this' : 'TWAP will skip lots if price rises above this';
    updatePreview();
}

export function refreshSubmitButton() {
    const btn = document.getElementById('submit-trade');
    if (!btn) return;

    const type = S.orderType;
    const side = S.selectedSide;
    const isScalperNeutral = type === 'SCALPER' && side === 'NEUTRAL';
    const isSmartNeutral = type === 'SMART' && side === 'NEUTRAL';

    if (type === 'TRAIL') {
        btn.textContent = '⚡ Set Trail Stop';
        btn.className = 'btn-submit';
        btn.style.background = '#f59e0b';
        btn.style.color = '#000';
    } else if (type === 'CHASE') {
        btn.textContent = '🎯 Start Chase';
        btn.className = 'btn-submit';
        btn.style.background = '#06b6d4';
        btn.style.color = '#000';
    } else if (type === 'SCALPER') {
        btn.textContent = isScalperNeutral ? 'Start Scalper (Neutral)' : '⚔️ Start Scalper';
        btn.className = `btn-submit ${isScalperNeutral ? 'submit-neutral' : ''}`;
        btn.style.background = 'linear-gradient(90deg, #06b6d4 0%, #f97316 100%)';
        btn.style.color = '#000';
    } else if (type === 'AGENT') {
        btn.textContent = '🤖 Start Agent';
        btn.className = 'btn-submit';
        btn.style.background = 'linear-gradient(135deg, #8b5cf6 0%, #06b6d4 50%, #22c55e 100%)';
        btn.style.color = '#fff';
    } else if (type === 'SMART') {
        btn.textContent = isSmartNeutral ? 'Start SmartOrder (Neutral)' : '🧠 Start SmartOrder';
        btn.className = `btn-submit ${isSmartNeutral ? 'submit-neutral' : ''}`;
        btn.style.background = 'linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 100%)';
        btn.style.color = '#fff';
    } else if (type === 'SCALE') {
        btn.textContent = side === 'LONG' ? 'Ladder Buy' : 'Ladder Sell';
        btn.className = `btn-submit btn-submit-${side.toLowerCase()}`;
        btn.style.background = '';
        btn.style.color = '';
    } else {
        btn.textContent = side === 'LONG' ? 'Buy / Long' : 'Sell / Short';
        btn.className = `btn-submit btn-submit-${side.toLowerCase()}`;
        btn.style.background = '';
        btn.style.color = '';
    }
}

export function setLeverage(val) {
    S.set('leverage', Math.max(1, Math.min(125, parseInt(val) || 1)));
    // update inline button label
    const levBtn = document.getElementById('lev-btn');
    if (levBtn) levBtn.textContent = `${S.leverage}×`;
    // highlight active preset in dropdown
    document.querySelectorAll('#lev-presets button').forEach(b => {
        const isActive = parseInt(b.dataset.lev) === S.leverage;
        b.style.background = isActive ? 'var(--accent)' : 'var(--surface-2)';
        b.style.color = isActive ? 'white' : 'var(--text)';
        b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    });
    // persist per-instrument
    S.leverageMap[S.selectedSymbol] = S.leverage;
    try { localStorage.setItem('pms_leverage_map', JSON.stringify(S.leverageMap)); } catch { }
    updatePreview();
    // re-sync slider notional
    setSizePercent(S.sizePercent);
}

export function setSizePercent(pct) {
    const availBal = S.cachedMarginInfo?.availableMargin;
    if (availBal != null && availBal < 0) {
        S.set('sizePercent', 0);
        return;
    }

    S.set('sizePercent', Math.max(0, Math.min(100, pct)));

    const fill = document.getElementById('size-slider-fill');
    if (fill) fill.style.width = `${S.sizePercent}%`;
    const label = document.getElementById('size-pct-label');
    if (label) label.textContent = `${S.sizePercent}%`;

    document.querySelectorAll('.slider-diamond').forEach(d => {
        d.classList.toggle('active', parseInt(d.dataset.pct) <= S.sizePercent);
    });

    if (!state.currentAccount) return;
    const available = S.cachedMarginInfo?.availableMargin || 0;
    const maxNotionalRule = S.cachedMarginInfo?.rules?.maxNotionalPerTrade || Infinity;
    const maxNotional = Math.min(available * S.leverage, maxNotionalRule);
    const notional = maxNotional * (S.sizePercent / 100);

    const input = document.getElementById('trade-size');
    if (input) input.value = notional.toFixed(2);

    const buyLabel = document.getElementById('size-buy-label');
    const sellLabel = document.getElementById('size-sell-label');
    if (buyLabel) buyLabel.textContent = `Buy ${notional.toFixed(2)} USDT`;
    if (sellLabel) sellLabel.textContent = `Sell ${notional.toFixed(2)} USDT`;

    updatePreview();
    if (S.orderType === 'SCALPER') {
        import('./scalper.js').then(m => m.updateScalperPreview());
    }
}

export function updatePreview() {
    const notional = parseFloat(document.getElementById('trade-size')?.value);
    const preview = document.getElementById('order-preview');
    if (!notional || notional <= 0 || !S.currentPrice) {
        if (preview) preview.style.display = 'none';
        return;
    }
    if (preview) preview.style.display = 'block';

    const margin = notional / S.leverage;
    const qty = notional / S.currentPrice;
    const el = (id) => document.getElementById(id);
    el('prev-notional').textContent = `$${notional.toFixed(2)}`;

    const minRow = document.getElementById('prev-min-row');
    if (S.symbolInfo?.minNotional && minRow) {
        minRow.style.display = '';
        el('prev-min').textContent = `$${S.symbolInfo.minNotional}`;
    }

    const account = state.accounts.find(a => a.id === state.currentAccount);
    const balance = account?.currentBalance || margin;
    const maintenanceRate = 0.005;
    const liqThreshold = 0.90;
    const mm = notional * maintenanceRate;
    const equityFloor = mm / liqThreshold;
    const maxLoss = balance - equityFloor;
    let liqPrice = S.selectedSide === 'LONG'
        ? S.currentPrice - (maxLoss / qty)
        : S.currentPrice + (maxLoss / qty);
    if (liqPrice < 0) liqPrice = 0;
    el('prev-liq').textContent = `$${formatPrice(liqPrice)}`;
}

// ── Error Handling ──────────────────────────────

export function showTradeError(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
        showToast('Trade rejected — unknown reason', 'error');
        return;
    }
    for (const err of errors) {
        const icon = S.ERROR_ICONS[err.code] || '❌';
        const msg = err.message || err;
        showToast(`${icon} ${msg}`, 'error');
    }
}

// ── Trade Submission ────────────────────────────

export async function submitTrade() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    const isReduceOnly = document.getElementById('reduce-only-toggle')?.checked;
    if (!isReduceOnly && S.cachedMarginInfo?.availableMargin != null && S.cachedMarginInfo.availableMargin < 0) {
        return showToast('⚠️ Insufficient balance — available margin is negative', 'error');
    }
    const sizeUsd = parseFloat(document.getElementById('trade-size')?.value);
    if (!sizeUsd || sizeUsd <= 0) return showToast('Enter a valid size', 'error');
    if (!S.currentPrice) return showToast('Waiting for price...', 'warning');

    const notional = sizeUsd;
    const quantity = notional / S.currentPrice;

    const minNotional = S.symbolInfo?.minNotional || 5;
    if (notional < minNotional) {
        showToast(`Min order is $${minNotional} notional. You entered $${notional.toFixed(2)}`, 'error');
        return;
    }

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
    const latencyId = beginOrderLatency('market');

    try {
        markOrderSent(latencyId);
        const babysitterChecked = document.getElementById('babysitter-toggle')?.checked ?? false;
        const reduceOnly = document.getElementById('reduce-only-toggle')?.checked ?? false;
        const result = await api('/trade', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                side: S.selectedSide,
                quantity,
                notionalUsd: notional,
                leverage: S.leverage,
                fastExecution: true,
                fallbackPrice: S.currentPrice,
                babysitterExcluded: !babysitterChecked,
                ...(reduceOnly ? { reduceOnly: true } : {}),
            },
        });
        markOrderAck(latencyId);
        requestAnimationFrame(() => markOrderPaint(latencyId));
        if (result.success) {
            showToast(`${S.selectedSide} ${S.selectedSymbol.split('/')[0]} opened`, 'success');
            document.getElementById('trade-size').value = '';
            document.getElementById('order-preview').style.display = 'none';
            const slider = document.getElementById('size-slider');
            if (slider) slider.value = 0;
            setSizePercent(0);
        }
        refreshAccountsInBackground();
        scheduleTradingRefresh({
            positions: true,
            account: true,
            annotations: true,
            forceAnnotations: true,
        }, 40);
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Trade failed'}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; refreshSubmitButton(); }
    }
}

export async function submitLimitOrder() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    const isReduceOnly = document.getElementById('reduce-only-toggle')?.checked;
    if (!isReduceOnly && S.cachedMarginInfo?.availableMargin != null && S.cachedMarginInfo.availableMargin < 0) {
        return showToast('⚠️ Insufficient balance — available margin is negative', 'error');
    }
    const sizeUsd = parseFloat(document.getElementById('trade-size')?.value);
    if (!sizeUsd || sizeUsd <= 0) return showToast('Enter a valid size', 'error');

    const limitPrice = parseFloat(document.getElementById('limit-price')?.value);
    if (!limitPrice || limitPrice <= 0) return showToast('Enter a valid limit price', 'error');

    const notional = sizeUsd;
    const quantity = notional / limitPrice;

    const minNotional = S.symbolInfo?.minNotional || 5;
    if (notional < minNotional) {
        showToast(`Min order is $${minNotional} notional. You entered $${notional.toFixed(2)}`, 'error');
        return;
    }

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
    const latencyId = beginOrderLatency('limit');

    try {
        markOrderSent(latencyId);
        const babysitterChecked = document.getElementById('babysitter-toggle')?.checked ?? false;
        const reduceOnly = document.getElementById('reduce-only-toggle')?.checked ?? false;
        const result = await api('/trade/limit', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                side: S.selectedSide,
                quantity,
                notionalUsd: notional,
                price: limitPrice,
                leverage: S.leverage,
                babysitterExcluded: !babysitterChecked,
                ...(reduceOnly ? { reduceOnly: true } : {}),
            },
        });
        markOrderAck(latencyId);
        requestAnimationFrame(() => markOrderPaint(latencyId));
        if (result.success) {
            showToast(`Limit ${S.selectedSide} ${S.selectedSymbol.split('/')[0]} @ $${formatPrice(limitPrice)}`, 'success');
            document.getElementById('trade-size').value = '';
            document.getElementById('limit-price').value = '';
            document.getElementById('order-preview').style.display = 'none';
            scheduleTradingRefresh({
                openOrders: true,
                annotations: true,
                forceAnnotations: true,
            }, 40);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Limit order failed'}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; refreshSubmitButton(); }
    }
}

// ── Order Type ──────────────────────────────────

export function setOrderType(type) {
    // If user manually changes order type, clear any pending edit mode
    if (S._editState && S._editState.type !== type) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.()).catch(() => { });
    }

    S.set('orderType', type);
    localStorage.setItem('pms_trade_order_type', type);

    // Sync the custom dropdown trigger
    const LABELS = { MARKET: 'Market', LIMIT: 'Limit', SCALE: 'Scale', TWAP: 'TWAP', TRAIL: 'Trail Stop', CHASE: 'Chase', SCALPER: 'Scalper', AGENT: 'Agent', SMART: 'SmartOrder' };
    const ICONS = { MARKET: '⚡', LIMIT: '📌', SCALE: '📊', TWAP: '⏱️', TRAIL: '🛡️', CHASE: '🎯', SCALPER: '⚔️', AGENT: '🤖', SMART: '🧠' };
    const labelEl = document.getElementById('ot-selected-label');
    const iconEl = document.getElementById('ot-selected-icon');
    if (labelEl) labelEl.textContent = LABELS[type] || type;
    if (iconEl) iconEl.textContent = ICONS[type] || '⚡';
    document.querySelectorAll('#ot-menu .ot-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.type === type);
    });

    const priceGroup = document.getElementById('limit-price-group');
    const scaleControls = document.getElementById('scale-controls');
    const twapControls = document.getElementById('twap-controls');
    const trailControls = document.getElementById('trail-stop-controls');
    const chaseControls = document.getElementById('chase-controls');
    const scalperControls = document.getElementById('scalper-controls');
    const agentControls = document.getElementById('agent-controls');
    const smartControls = document.getElementById('smart-order-controls');

    if (priceGroup) priceGroup.style.display = type === 'LIMIT' ? '' : 'none';
    if (type === 'LIMIT') {
        const priceInput = document.getElementById('limit-price');
        if (priceInput && S.currentPrice) priceInput.value = formatPrice(S.currentPrice);
    }

    // Show/hide Neutral button — only for SCALPER and SMART
    const btnNeutral = document.getElementById('btn-neutral');
    if (btnNeutral) btnNeutral.style.display = (type === 'SCALPER' || type === 'SMART') ? '' : 'none';
    // If entering SCALPER, fire event so index.js can sync mode button state
    if (type === 'SCALPER') document.dispatchEvent(new CustomEvent('scalper-active'));
    // If we're leaving SCALPER/SMART and current side is NEUTRAL, snap back to LONG
    if (type !== 'SCALPER' && type !== 'SMART' && S.selectedSide === 'NEUTRAL') setSide('LONG');

    if (scaleControls) scaleControls.style.display = type === 'SCALE' ? '' : 'none';

    if (twapControls) twapControls.style.display = type === 'TWAP' ? '' : 'none';
    if (type === 'TWAP') updateTwapPreview();

    if (trailControls) trailControls.style.display = type === 'TRAIL' ? '' : 'none';
    if (chaseControls) chaseControls.style.display = type === 'CHASE' ? '' : 'none';
    if (scalperControls) scalperControls.style.display = type === 'SCALPER' ? '' : 'none';
    if (agentControls) agentControls.style.display = type === 'AGENT' ? '' : 'none';
    if (smartControls) smartControls.style.display = type === 'SMART' ? '' : 'none';

    // TRAIL hides all controls. SCALPER keeps size visible but hides babysitter.
    // SCALPER keeps size input visible (total budget) but hides babysitter.
    const hideControls = type === 'TRAIL';
    const hideOnlyBabysitter = type === 'SCALPER' || type === 'AGENT' || type === 'SMART';
    const babysitterGroup = document.getElementById('babysitter-toggle-group');
    const sideToggle = document.querySelector('.side-toggle-mini');
    const sizeGroup = document.getElementById('size-slider-track')?.parentElement;
    const tradeSizeInput = document.getElementById('trade-size')?.parentElement;
    const orderPreview = document.getElementById('order-preview');
    const submitBtn = document.getElementById('submit-trade');
    if (babysitterGroup) babysitterGroup.style.display = (hideControls || hideOnlyBabysitter) ? 'none' : '';
    const reduceOnlyGroup = document.getElementById('reduce-only-toggle-group');
    if (reduceOnlyGroup) reduceOnlyGroup.style.display = (hideControls || hideOnlyBabysitter) ? 'none' : '';
    if (sideToggle) sideToggle.style.display = hideControls ? 'none' : '';
    if (sizeGroup) sizeGroup.style.display = hideControls ? 'none' : '';
    if (tradeSizeInput) tradeSizeInput.style.display = hideControls ? 'none' : '';
    if (orderPreview && hideControls) orderPreview.style.display = 'none';
    refreshSubmitButton();

    if (type === 'TRAIL') {
        import('./trail-stop.js').then(m => {
            m.refreshTrailPositionDropdown();
            m.updateTrailPreview();
        });
    }

    if (type === 'CHASE') {
        import('./chase-limit.js').then(m => {
            m.updateChasePreview();
        });
    }

    if (type === 'SCALPER') {
        import('./scalper.js').then(m => {
            m.updateScalperPreview();
        });
    }

    if (type === 'AGENT') {
        import('./agents.js').then(m => {
            m.updateAgentPreview();
        });
    }

    if (type !== 'SCALE') {
        clearScalePreviewLines();
        removeScaleBoundaryLines();
        teardownScaleDragHandlers();
        if (S.scaleMode && S.chart && S._scaleClickHandler) {
            S.chart.unsubscribeClick(S._scaleClickHandler);
            S.set('_scaleClickHandler', null);
        }
        if (S.chart) S.chart.applyOptions({ handleScroll: true, handleScale: true });
        S.set('scaleMode', false);
    }

    if (type !== 'TRAIL') {
        // Clear trail stop preview lines when leaving Trail tab
        import('./trail-stop.js').then(m => m.clearAllTrailStopLines()).catch(() => { });
    }

    if (type !== 'CHASE') {
        import('./chase-limit.js').then(m => m.clearAllChaseLines()).catch(() => { });
    }


}

// ── Symbol & Account Pickers (delegated) ────────
// Re-exported from ./symbol-picker.js for backward compatibility
export { prefetchSymbolsList, showSymbolPicker, switchSymbol, showAccountPicker } from './symbol-picker.js';


// ── Helpers ─────────────────────────────────────

export function refreshAccountsInBackground() {
    api('/sub-accounts')
        .then((accounts) => {
            if (!Array.isArray(accounts)) return;
            state.accounts = accounts;
            if (S._tradingMounted) updateAccountDisplay();
        })
        .catch(() => { });
}

export async function updateAccountDisplay() {
    const account = state.accounts.find(a => a.id === state.currentAccount);
    const nameEl = document.getElementById('form-account');
    const availEl = document.getElementById('form-available');
    if (nameEl) nameEl.textContent = account?.name || 'Select';

    const accountId = state.currentAccount;
    if (accountId) {
        try {
            const [margin, posData] = await Promise.all([
                api(`/trade/margin/${accountId}`),
                api(`/trade/positions/${accountId}`).catch(() => null),
            ]);
            S.set('cachedMarginInfo', margin);

            const avEl = document.getElementById('acct-available');
            const avail = margin.availableMargin ?? 0;
            if (avEl) avEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;
            if (availEl) availEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;
            _applyNegativeBalanceLock(avail, { force: true });

            S.set('_cachedBalance', margin.balance || 0);
            S.set('_cachedMarginUsed', margin.marginUsed || 0);

            if (posData?.positions) {
                S._positionMap.clear();
                for (const p of posData.positions) {
                    S._positionMap.set(p.id, {
                        symbol: p.symbol,
                        side: p.side,
                        entryPrice: p.entryPrice,
                        quantity: p.quantity,
                        markPrice: p.markPrice || p.entryPrice,
                    });
                }
            }

            _refreshEquityUpnl();
        } catch { }
    } else {
        if (availEl) availEl.textContent = '$0.00';
        _applyNegativeBalanceLock(0, { force: true });
    }
}

// ── Negative Balance Lock ───────────────────────

export function _applyNegativeBalanceLock(availableMargin, opts = {}) {
    const force = !!opts.force;
    const isNegative = availableMargin != null && availableMargin < 0;
    if (!force && S._negativeLockState === isNegative) return;
    S.set('_negativeLockState', isNegative);

    const slider = document.getElementById('size-slider');
    const sizeInput = document.getElementById('trade-size');
    const submitBtn = document.getElementById('submit-trade');
    const avEl = document.getElementById('acct-available');
    const availEl = document.getElementById('form-available');

    if (slider) slider.disabled = isNegative;
    if (sizeInput) sizeInput.disabled = isNegative;
    if (submitBtn) {
        submitBtn.disabled = isNegative;
        if (isNegative) submitBtn.style.opacity = '0.4';
        else submitBtn.style.opacity = '';
    }

    document.querySelectorAll('.slider-diamond').forEach(d => {
        d.style.pointerEvents = isNegative ? 'none' : '';
        d.style.opacity = isNegative ? '0.3' : '';
    });

    const sliderTrack = document.getElementById('size-slider-track');
    if (sliderTrack) sliderTrack.style.opacity = isNegative ? '0.3' : '';

    const balColor = isNegative ? 'var(--red, #ef4444)' : 'var(--green)';
    if (avEl) avEl.style.color = balColor;
    if (availEl) availEl.style.color = balColor;

    if (isNegative) {
        if (slider) slider.value = 0;
        const fill = document.getElementById('size-slider-fill');
        if (fill) fill.style.width = '0%';
        const label = document.getElementById('size-pct-label');
        if (label) label.textContent = '0%';
        if (sizeInput) sizeInput.value = '';
        document.querySelectorAll('.slider-diamond').forEach(d => d.classList.remove('active'));
        const preview = document.getElementById('order-preview');
        if (preview) preview.style.display = 'none';
    }
}

// ── Equity / UPNL ──────────────────────────────

export function _refreshEquityUpnl() {
    if (!S._cachedBalance && S._positionMap.size === 0) return;

    let totalUpnl = 0;
    for (const [, pos] of S._positionMap) {
        const mark = (pos.symbol === S.selectedSymbol && S.currentPrice)
            ? S.currentPrice
            : (S._compactMarkPrices[pos.symbol] || pos.markPrice);
        if (!mark) continue;
        totalUpnl += pos.side === 'LONG'
            ? (mark - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - mark) * pos.quantity;
    }
    const equity = S._cachedBalance + totalUpnl;
    const eqEl = document.getElementById('equity-value');
    const upnlEl = document.getElementById('upnl-value');
    if (eqEl) eqEl.textContent = `$${equity.toFixed(2)}`;
    if (upnlEl) {
        upnlEl.textContent = `${totalUpnl >= 0 ? '+' : ''}$${totalUpnl.toFixed(2)}`;
        upnlEl.style.color = totalUpnl > 0 ? 'var(--green)' : totalUpnl < 0 ? 'var(--red, #ef4444)' : 'var(--text-muted)';
    }

    const liveAvail = equity - S._cachedMarginUsed;
    const avEl = document.getElementById('acct-available');
    const availEl = document.getElementById('form-available');
    if (avEl) avEl.textContent = `${liveAvail < 0 ? '-' : ''}$${Math.abs(liveAvail).toFixed(2)}`;
    if (availEl) availEl.textContent = `${liveAvail < 0 ? '-' : ''}$${Math.abs(liveAvail).toFixed(2)}`;
    if (S.cachedMarginInfo) S.cachedMarginInfo.availableMargin = liveAvail;

    const isNegative = liveAvail < 0;
    if (S._negativeLockState == null || S._negativeLockState !== isNegative) {
        _applyNegativeBalanceLock(liveAvail);
    }
}

// ── Bottom-panel tab switching ──────────────────
export function _switchBottomTab(target) {
    document.querySelectorAll('.bp-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.bp === target);
    });
    document.querySelectorAll('.bp-pane').forEach(p => {
        p.classList.toggle('active', p.id === `bp-${target}`);
    });
    const cancelBtn = document.getElementById('cancel-all-orders');
    if (cancelBtn) {
        cancelBtn.style.display = (target === 'orders' && cancelBtn.dataset.hasOrders === '1') ? '' : 'none';
    }
    localStorage.setItem('pms_bottom_panel_tab', target);
}

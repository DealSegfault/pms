// ── Trading Page – TWAP Orders ───────────────────────────────
import { state, api, showToast, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { showTradeError, setSizePercent } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { beginOrderLatency, markOrderSent, markOrderAck, markOrderPaint } from './perf-metrics.js';

export async function submitTwapOrder() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');
    if (S.cachedMarginInfo?.availableMargin != null && S.cachedMarginInfo.availableMargin < 0) {
        return showToast('⚠️ Insufficient balance — available margin is negative', 'error');
    }

    // ── Edit mode: cancel old TWAP first ───────────────────────────
    const editState = S._editState?.type === 'TWAP' ? S._editState : null;
    if (editState) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.());
        try { await api(`/trade/twap/${editState.orderId}`, { method: 'DELETE' }); } catch { }
    }

    const totalSize = parseFloat(document.getElementById('trade-size')?.value) || 0;
    if (totalSize <= 0) return showToast('Enter a total size', 'error');

    const lots = parseInt(document.getElementById('twap-lots')?.value) || 10;
    const durationMinutes = parseInt(document.getElementById('twap-duration')?.value) || 30;
    const jitter = document.getElementById('twap-jitter')?.checked || false;
    const irregular = document.getElementById('twap-irregular')?.checked || false;
    const priceLimitRaw = parseFloat(document.getElementById('twap-price-limit')?.value);
    const priceLimit = Number.isFinite(priceLimitRaw) && priceLimitRaw > 0 ? priceLimitRaw : null;

    const minNotional = S.symbolInfo?.minNotional || 6;
    const perLot = totalSize / lots;
    if (perLot < minNotional) {
        const maxLots = Math.floor(totalSize / minNotional);
        return showToast(`Each lot $${perLot.toFixed(2)} < $${minNotional} min. Reduce lots to ${maxLots} or increase size.`, 'error');
    }

    const intervalSec = (durationMinutes * 60) / lots;
    const confirmed = await cuteConfirm({
        title: editState ? `Update TWAP — ${S.selectedSymbol.split('/')[0]}` : `TWAP ${S.selectedSide} ${S.selectedSymbol.split('/')[0]}`,
        message: `${lots} lots · $${perLot.toFixed(2)} each · every ${intervalSec >= 60 ? (intervalSec / 60).toFixed(1) + 'min' : intervalSec.toFixed(0) + 's'}\nTotal: $${totalSize.toFixed(2)} · Leverage: ${S.leverage}x · Duration: ${durationMinutes}min${jitter ? ' · Jitter' : ''}${irregular ? ' · Irregular' : ''}${priceLimit ? `\n${S.selectedSide === 'SHORT' ? 'Min sell' : 'Max buy'} price: $${priceLimit}` : ''}`,
        confirmText: editState ? 'Update TWAP' : 'Start TWAP',
        danger: S.selectedSide === 'SHORT',
    });
    if (!confirmed) return;

    const btn = document.getElementById('submit-trade');
    if (btn) { btn.disabled = true; btn.textContent = editState ? 'Updating...' : 'Starting TWAP...'; }
    const latencyId = beginOrderLatency('twap');

    try {
        markOrderSent(latencyId);
        const babysitterChecked = document.getElementById('babysitter-toggle')?.checked ?? false;
        const result = await api('/trade/twap', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                side: S.selectedSide,
                totalSize,
                lots,
                durationMinutes,
                leverage: S.leverage,
                jitter,
                irregular,
                babysitterExcluded: !babysitterChecked,
                ...(priceLimit ? { priceLimit } : {}),
            },
        });
        markOrderAck(latencyId);
        requestAnimationFrame(() => markOrderPaint(latencyId));
        if (result.success) {
            showToast(`TWAP started: ${lots} lots over ${durationMinutes}min`, 'success');
            document.getElementById('trade-size').value = '';
            document.getElementById('order-preview').style.display = 'none';
            const slider = document.getElementById('size-slider');
            if (slider) slider.value = 0;
            setSizePercent(0);
            scheduleTradingRefresh({ openOrders: true, annotations: true, forceAnnotations: true }, 30);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'TWAP failed to start'}`, 'error');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = S.selectedSide === 'LONG' ? 'Buy / Long' : 'Sell / Short'; }
    }
}

export async function cancelTwap(twapId) {
    showToast('Cancelling TWAP...', 'info');
    try {
        const result = await api(`/trade/twap/${twapId}`, { method: 'DELETE' });
        showToast(`TWAP cancelled (${result.filledLots}/${result.totalLots} lots filled)`, 'success');
        scheduleTradingRefresh({ openOrders: true }, 30);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

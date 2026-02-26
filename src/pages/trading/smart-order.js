import { state, api, showToast } from '../../core/index.js';
import * as S from './state.js';

export async function submitSmartOrder() {
    if (!S.selectedSymbol) {
        showToast('Please select a symbol first', 'error');
        return;
    }

    // Determine configured size based on side
    let longSizeUsd = 0;
    let shortSizeUsd = 0;

    const inputSizeNum = parseFloat(document.getElementById('trade-size')?.value) || 0;
    if (inputSizeNum <= 0) {
        showToast('Please enter a valid size', 'error');
        return;
    }

    if (S.selectedSide === 'LONG') {
        longSizeUsd = inputSizeNum;
    } else if (S.selectedSide === 'SHORT') {
        shortSizeUsd = inputSizeNum;
    } else if (S.selectedSide === 'NEUTRAL') {
        longSizeUsd = inputSizeNum / 2;
        shortSizeUsd = inputSizeNum / 2;
    }

    // Read config fields from DOM
    const getVal = (id, def) => {
        const el = document.getElementById(id);
        return el ? Number(el.value) : def;
    };

    const targetPnlVelocity = getVal('smart-velocity', 5.0);
    const maxAdverseSelectionBps = getVal('smart-adverse', 10.0);
    const maxDrawdownUsd = getVal('smart-drawdown', 100.0);
    const childCount = getVal('smart-child-count', 4);
    const offsetPct = getVal('smart-offset', 0.05);
    const skew = getVal('smart-skew', 50);

    const payload = {
        subAccountId: state.currentAccount,
        symbol: S.selectedSymbol,
        side: S.selectedSide,
        leverage: S.leverage,
        longSizeUsd,
        shortSizeUsd,
        maxNotionalUsd: inputSizeNum,
        targetPnlVelocity,
        maxAdverseSelectionBps,
        maxDrawdownUsd,
        childCount,
        longOffsetPct: offsetPct,
        shortOffsetPct: offsetPct,
        skew
    };

    try {
        const btn = document.querySelector('.btn-submit');
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Starting...';

        const result = await api('/trade/smart-order', {
            method: 'POST',
            body: payload
        });

        if (result.success) {
            showToast('SmartOrder started successfully', 'success');
            // Refresh open orders panel so the SmartOrder row appears immediately
            import('./refresh-scheduler.js').then(({ scheduleTradingRefresh }) => {
                scheduleTradingRefresh({ openOrders: true, account: true }, 500);
            }).catch(() => { });
            // Hide order form (switch back to chart tab on mobile)
            document.querySelectorAll('.tab-btn').forEach(b => {
                if (b.dataset.tab === 'chart') b.click();
            });
        }
    } catch (err) {
        showToast(err.message || 'Failed to start SmartOrder', 'error');
    } finally {
        const btn = document.querySelector('.btn-submit');
        if (btn) {
            btn.disabled = false;
            btn.textContent = S.selectedSide === 'NEUTRAL' ? 'Start SmartOrder (Neutral)' : '🧠 Start SmartOrder';
        }
    }
}

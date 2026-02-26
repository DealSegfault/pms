// Compact position UI helpers for trading WS events.
// Owns optimistic compact-position row add/update/remove and chart overlay resets.

import { formatPrice } from '../../core/index.js';
import * as S from './state.js';
import { _refreshEquityUpnl } from './order-form.js';
import { scheduleChartRiskRefresh, loadChartAnnotations } from './chart-annotations.js';
import { updateCompactLiqForPosition, connectCompactMarkStreams, marketClosePosition } from './compact-positions.js';
import { clearAllTrailStopLines } from './trail-stop.js';

export function removeCompactPositionFromUi(positionId) {
    if (!positionId) return;

    const row = document.querySelector(`.compact-pos-row[data-cp-id="${positionId}"]`);
    if (row) row.remove();

    S._positionMap.delete(positionId);

    const countEl = document.getElementById('compact-pos-count');
    if (countEl) countEl.textContent = S._positionMap.size;

    if (S._positionMap.size === 0) {
        const list = document.getElementById('compact-pos-list');
        if (list) {
            list.innerHTML = '<div style="padding:6px 8px; color:var(--text-muted); text-align:center; font-size:10px;">No positions</div>';
        }
        connectCompactMarkStreams([]);
    }

    _refreshEquityUpnl();
}

export function resetChartPositionOverlays({ clearTrail = false } = {}) {
    for (const line of S.chartPriceLines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    S.set('chartPriceLines', []);
    S.set('_chartAnnotationCache', null);
    S.set('_chartAnnotationFingerprint', null);

    if (clearTrail) {
        clearAllTrailStopLines();
    }

    loadChartAnnotations(true);
}

function _wireCompactRowCloseButton(newRow, positionId, symbol) {
    newRow.querySelector('[data-cp-close]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        marketClosePosition(positionId, symbol);
    });
}

function _wireCompactRowSymbolSwitch(newRow, symbol, scheduleTradingRefresh) {
    newRow.querySelector('.cpr-name')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (symbol !== S.selectedSymbol) {
            import('./order-form.js').then(({ switchSymbol }) => {
                switchSymbol(symbol);
                scheduleTradingRefresh({ positions: true, openOrders: true, account: true }, 30);
            });
        }
    });
}

function _wireCompactRowBabysitter(newRow) {
    const bbsBtn = newRow.querySelector('[data-cp-bbs]');
    if (!bbsBtn) return;

    bbsBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();

        const positionId = bbsBtn.dataset.cpBbs;
        const currentlyExcluded = bbsBtn.dataset.cpBbsExcluded === '1';
        if (!positionId || S._compactBabysitterBusy.has(positionId)) return;

        S._compactBabysitterBusy.add(positionId);

        const newExcluded = !currentlyExcluded;
        const newOn = !newExcluded;

        bbsBtn.disabled = true;
        bbsBtn.textContent = newOn ? 'On' : 'Off';
        bbsBtn.className = `cpr-bbs ${newOn ? 'on' : 'off'}`;
        bbsBtn.dataset.cpBbsExcluded = newExcluded ? '1' : '0';
        bbsBtn.style.opacity = '0.5';

        try {
            const { showToast, api: apiCall } = await import('../../core/index.js');
            showToast(newOn ? 'Enabling babysitter…' : 'Disabling babysitter…', 'info');
            const route = currentlyExcluded
                ? `/bot/babysitter/position/${positionId}/include`
                : `/bot/babysitter/position/${positionId}/exclude`;
            await apiCall(route, { method: 'POST' });
            showToast(newOn ? 'Babysitter enabled for position' : 'Babysitter disabled for position', 'success');
        } catch (err) {
            const revertOn = !newOn;
            bbsBtn.textContent = revertOn ? 'On' : 'Off';
            bbsBtn.className = `cpr-bbs ${revertOn ? 'on' : 'off'}`;
            bbsBtn.dataset.cpBbsExcluded = currentlyExcluded ? '1' : '0';
            import('../../core/index.js').then(({ showToast }) => showToast(`${err.message}`, 'error')).catch(() => { });
        } finally {
            bbsBtn.disabled = false;
            bbsBtn.style.opacity = '';
            S._compactBabysitterBusy.delete(positionId);
        }
    });
}

function _createCompactPositionRow(d, scheduleTradingRefresh) {
    const list = document.getElementById('compact-pos-list');
    if (!list) return;

    const noPos = list.querySelector('div[style*="text-align:center"]');
    if (noPos && list.children.length === 1) list.innerHTML = '';

    const isLong = d.side === 'LONG';
    const mark = S._compactMarkPrices[d.symbol] || d.entryPrice;
    const notional = d.notional || (d.quantity * mark) || 0;
    const lev = d.leverage || 1;
    const margin = d.margin || 0;
    const liqPrice = d.liquidationPrice || 0;
    const babysitterExcluded = d.babysitterExcluded ?? false;
    const babysitterOn = !babysitterExcluded;

    const tmp = document.createElement('div');
    tmp.innerHTML = `
      <div class="compact-pos-row" data-cp-symbol="${d.symbol}" data-cp-side="${d.side}"
           data-cp-id="${d.positionId}" data-cp-entry="${d.entryPrice}" data-cp-qty="${d.quantity || 0}" data-cp-margin="${margin}" data-cp-notional="${notional}">
        <span class="cpr-sym">
          <span class="cpr-name">${d.symbol.split('/')[0]}</span>
          <span class="cpr-badge ${isLong ? 'cpr-long' : 'cpr-short'}">${isLong ? 'L' : 'S'}</span>
          <span class="cpr-lev">${lev}x</span>
        </span>
        <span class="cpr-size" data-cpsize-id="${d.positionId}">$${notional.toFixed(2)}</span>
        <span class="cpr-entry">${formatPrice(d.entryPrice)}</span>
        <span class="cpr-mark" data-cpmark-id="${d.positionId}">${formatPrice(mark)}</span>
        <span class="cpr-liq" data-cpliq-id="${d.positionId}">${liqPrice > 0 ? formatPrice(liqPrice) : '—'}</span>
        <span class="cpr-pnl pnl-up" data-cppnl-id="${d.positionId}" data-cp-prev-pnl="0">
          +0.00 <small>(+0.0%)</small>
        </span>
        <button class="cpr-bbs ${babysitterOn ? 'on' : 'off'}" data-cp-bbs="${d.positionId}" data-cp-bbs-excluded="${babysitterExcluded ? '1' : '0'}" title="Toggle babysitter for this position">${babysitterOn ? 'On' : 'Off'}</button>
        <span class="cpr-close" data-cp-close="${d.positionId}" data-cp-close-sym="${d.symbol}" title="Market Close">✕</span>
      </div>
    `;

    const newRow = tmp.firstElementChild;
    list.appendChild(newRow);

    _wireCompactRowCloseButton(newRow, d.positionId, d.symbol);
    _wireCompactRowSymbolSwitch(newRow, d.symbol, scheduleTradingRefresh);
    _wireCompactRowBabysitter(newRow);

    const countEl = document.getElementById('compact-pos-count');
    if (countEl) countEl.textContent = S._positionMap.size;

    connectCompactMarkStreams([...S._positionMap.values()]);
}

export function handlePositionUpdatedEvent(d, {
    schedulePnlUiRefresh,
    scheduleTradingRefresh,
} = {}) {
    if (!d?.positionId) return;

    const existing = S._positionMap.get(d.positionId) || {};
    S._positionMap.set(d.positionId, {
        symbol: d.symbol || existing.symbol,
        side: d.side || existing.side,
        entryPrice: d.entryPrice ?? existing.entryPrice,
        quantity: d.quantity ?? existing.quantity ?? 0,
        markPrice: existing.markPrice ?? d.entryPrice,
        liquidationPrice: d.liquidationPrice ?? existing.liquidationPrice ?? 0,
    });

    let row = document.querySelector(`.compact-pos-row[data-cp-id="${d.positionId}"]`);

    if (!row && d.symbol && d.side && d.entryPrice != null) {
        _createCompactPositionRow(d, scheduleTradingRefresh);
        row = document.querySelector(`.compact-pos-row[data-cp-id="${d.positionId}"]`);
    }

    if (row) {
        if (d.entryPrice != null) {
            row.dataset.cpEntry = d.entryPrice;
            const entryEl = row.querySelector('.cpr-entry');
            if (entryEl) entryEl.textContent = formatPrice(d.entryPrice);
        }
        if (d.quantity != null) {
            row.dataset.cpQty = d.quantity;
        }
        if (d.margin != null) {
            row.dataset.cpMargin = d.margin;
        }
        if (d.notional != null) {
            row.dataset.cpNotional = d.notional;
            const sizeEl = row.querySelector(`[data-cpsize-id="${d.positionId}"]`);
            if (sizeEl) sizeEl.textContent = `$${d.notional.toFixed(2)}`;
        }
        if (d.liquidationPrice != null) {
            updateCompactLiqForPosition(d.positionId, d.liquidationPrice);
        }
    }

    if (schedulePnlUiRefresh) schedulePnlUiRefresh();
    scheduleChartRiskRefresh();
}

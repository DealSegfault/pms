// Trading app-level WS event bootstrap.
// Owns global margin/pnl/doc listeners and delegates domain events to focused modules.

import * as S from './state.js';
import { _applyNegativeBalanceLock } from './order-form.js';
import { updateCompactLiqForPosition } from './compact-positions.js';
import {
    registerOrderAndPositionEventHandlers,
} from './ws-events-orders-positions.js';
import {
    registerAlgoAndAgentEventHandlers,
} from './ws-events-algos-agents.js';

let lastPnlUiTs = 0;

export function setupTradingAppEventListeners({ schedulePnlUiRefresh }) {
    const marginHandler = (e) => {
        if (!S._tradingMounted || !e.detail) return;

        const payload = e.detail || {};
        const update = payload.update || payload;
        const subAccountId = payload.subAccountId || update.subAccountId;

        if (subAccountId !== (window.__pmsState || {}).currentAccount) return;

        S.set('cachedMarginInfo', update);

        const avail = update.availableMargin ?? 0;
        const avEl = document.getElementById('acct-available');
        const availEl = document.getElementById('form-available');
        if (avEl) avEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;
        if (availEl) availEl.textContent = `${avail < 0 ? '-' : ''}$${Math.abs(avail).toFixed(2)}`;

        S.set('_cachedBalance', update.balance || 0);
        S.set('_cachedMarginUsed', update.marginUsed || 0);

        _applyNegativeBalanceLock(avail);
        schedulePnlUiRefresh();
    };

    S.set('_marginUpdateHandler', marginHandler);
    window.addEventListener('margin_update', marginHandler);

    const pnlHandler = (e) => {
        if (!S._tradingMounted || !e.detail) return;

        const d = e.detail;
        if (d.subAccountId && d.subAccountId !== (window.__pmsState || {}).currentAccount) return;

        const now = Date.now();
        S.set('_lastTradingWsPnlTs', now);

        if (d.positionId) {
            const existing = S._positionMap.get(d.positionId) || {};
            S._positionMap.set(d.positionId, {
                symbol: d.symbol || existing.symbol,
                side: d.side || existing.side,
                entryPrice: d.entryPrice ?? existing.entryPrice,
                quantity: d.quantity || existing.quantity || 0,
                markPrice: d.markPrice ?? existing.markPrice,
                liquidationPrice: d.liquidationPrice ?? existing.liquidationPrice ?? 0,
            });
            updateCompactLiqForPosition(d.positionId, d.liquidationPrice);
        }

        if (now - lastPnlUiTs < 30) {
            schedulePnlUiRefresh();
            return;
        }

        lastPnlUiTs = now;
        schedulePnlUiRefresh();
    };

    S.set('_pnlUpdateHandler', pnlHandler);
    window.addEventListener('pnl_update', pnlHandler);

    const docClick = (e) => {
        const panel = document.getElementById('chart-settings-panel');
        const btn = document.getElementById('chart-settings-btn');
        if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== btn) {
            panel.style.display = 'none';
        }
    };

    S.set('_docClickHandler', docClick);
    document.addEventListener('click', docClick);

    const compactListeners = {};
    const mkHandler = (eventName, fn) => {
        const handler = fn;
        compactListeners[`_${eventName}`] = handler;
        window.addEventListener(eventName, handler);
    };

    registerOrderAndPositionEventHandlers({ mkHandler, schedulePnlUiRefresh });
    registerAlgoAndAgentEventHandlers({ mkHandler });

    S.set('_compactPosListeners', compactListeners);
}

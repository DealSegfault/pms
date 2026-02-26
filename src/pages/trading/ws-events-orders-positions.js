// Trading WS order/position event handlers.
// Owns optimistic order-row + compact-position updates for engine lifecycle events.

import { formatPrice } from '../../core/index.js';
import * as S from './state.js';
import {
    refreshChartLeftAnnotationLabels,
    _orderLineRegistry,
} from './chart-annotations.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import {
    removeCompactPositionFromUi,
    resetChartPositionOverlays,
    handlePositionUpdatedEvent,
} from './ws-position-updates.js';

function removeOrderRow(orderId) {
    if (!orderId) return;
    const row = document.querySelector(`[data-order-id="${orderId}"]`);
    if (row) row.remove();
}

function removeOrderLine(orderId) {
    if (!orderId || !_orderLineRegistry.has(orderId)) return;
    try { S.candleSeries.removePriceLine(_orderLineRegistry.get(orderId)); } catch { }
    _orderLineRegistry.delete(orderId);
    refreshChartLeftAnnotationLabels();
}

function removeOrderRowAndLine(orderId) {
    removeOrderRow(orderId);
    removeOrderLine(orderId);
}

export function registerOrderAndPositionEventHandlers({ mkHandler, schedulePnlUiRefresh }) {
    mkHandler('order_rejected', (e) => {
        if (!S._tradingMounted) return;
        const d = e?.detail || {};
        removeOrderRowAndLine(d.orderId);
        scheduleTradingRefresh({ openOrders: true, account: true }, 500);
    });

    mkHandler('order_acked', (e) => {
        if (!S._tradingMounted) return;

        const d = e?.detail || {};
        const isAlgoAck = !!d.suppressToast;

        if (!isAlgoAck && d.symbol && d.type && /LIMIT/i.test(d.type)) {
            const sym = d.symbol.split('/')[0];
            const priceStr = d.price ? ` @ $${formatPrice(d.price)}` : '';
            import('../../core/index.js').then(({ showToast }) => {
                showToast(`✅ Limit ${d.side || ''} accepted: ${sym}${priceStr}`, 'success');
            }).catch(() => { });
        }

        scheduleTradingRefresh({ openOrders: true }, 500);
    });

    mkHandler('order_filled', (e) => {
        if (!S._tradingMounted) return;

        const d = e?.detail || {};
        const isAlgoFill = !!d.suppressToast;

        removeOrderLine(d.orderId);

        if (isAlgoFill) {
            scheduleTradingRefresh({
                openOrders: true,
                account: true,
            }, 1000);
            return;
        }

        removeOrderRow(d.orderId);

        scheduleTradingRefresh({
            positions: true,
            account: true,
            annotations: true,
            forceAnnotations: true,
        }, 300);
    });

    mkHandler('order_cancelled', (e) => {
        if (!S._tradingMounted) return;

        const d = e?.detail || {};
        const isAlgoCancel = !!d.suppressToast;

        removeOrderLine(d.orderId);

        if (isAlgoCancel) {
            scheduleTradingRefresh({
                openOrders: true,
                account: true,
            }, 1000);
            return;
        }

        removeOrderRow(d.orderId);

        scheduleTradingRefresh({
            account: true,
        }, 500);
    });

    mkHandler('position_closed', (e) => {
        if (!S._tradingMounted) return;

        const d = e?.detail || {};
        removeCompactPositionFromUi(d.positionId);

        resetChartPositionOverlays();

        scheduleTradingRefresh({
            positions: true,
            account: true,
        }, 50);
    });

    mkHandler('liquidation', (e) => {
        if (!S._tradingMounted) return;

        const d = e?.detail || {};
        removeCompactPositionFromUi(d.positionId);

        resetChartPositionOverlays();

        scheduleTradingRefresh({
            positions: true,
            account: true,
        }, 50);
    });

    mkHandler('position_reduced', () => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({ account: true }, 500);
    });

    mkHandler('position_updated', (e) => {
        if (!S._tradingMounted) return;

        handlePositionUpdatedEvent(e?.detail || {}, {
            schedulePnlUiRefresh,
            scheduleTradingRefresh,
        });
    });

    mkHandler('trade_execution', () => {
        if (!S._tradingMounted) return;

        scheduleTradingRefresh({
            positions: true,
            account: true,
        }, 1500);
    });

    mkHandler('positions_resync', () => {
        if (!S._tradingMounted) return;
        scheduleTradingRefresh({ positions: true, account: true }, 50);
    });
}

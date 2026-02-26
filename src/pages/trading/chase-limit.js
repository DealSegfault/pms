// ── Trading Page – Chase Limit Orders ────────────────────────
// Handles submission, cancellation, chart preview lines, and live chase
// visualization on the chart.
import { state, api, showToast, formatPrice } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import * as S from './state.js';
import { showTradeError } from './order-form.js';
import { scheduleTradingRefresh } from './refresh-scheduler.js';
import { beginOrderLatency, markOrderSent, markOrderAck, markOrderPaint } from './perf-metrics.js';

// ── Chart line management ───────────────────────

// Preview lines shown while configuring (before submission)
let _previewLines = [];

// Active chase orders: chaseId → { state, lines[] }
const _activeChases = new Map();

function clearPreviewLines() {
    if (!S.candleSeries) return;
    for (const line of _previewLines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    _previewLines = [];
}

function _removeLinesForChase(entry) {
    if (!S.candleSeries || !entry?.lines) return;
    for (const line of entry.lines) {
        try { S.candleSeries.removePriceLine(line); } catch { }
    }
    entry.lines = [];
}

export function clearAllChaseLines() {
    clearPreviewLines();
    clearActiveChase();
}

// ── Chart Preview (before submission) ───────────

/**
 * Draw preview lines on the chart showing where the chase order would be placed.
 * Uses current bid/ask from orderbook state + stalk offset.
 */
export function updateChasePreview() {
    clearPreviewLines();

    const el = document.getElementById('chase-preview');
    const offsetPct = parseFloat(document.getElementById('chase-offset')?.value) || 0;
    const bids = S.orderBookBids;
    const asks = S.orderBookAsks;

    if (!S.candleSeries || !bids?.length || !asks?.length) {
        if (el) el.textContent = offsetPct > 0 ? `Stalk offset: ${offsetPct}%` : 'Chase at best quote';
        return;
    }

    const bestBid = bids[0][0];
    const bestAsk = asks[0][0];
    const side = S.selectedSide;

    if (side === 'LONG') {
        const target = offsetPct > 0 ? bestBid * (1 - offsetPct / 100) : bestBid;
        _previewLines.push(S.candleSeries.createPriceLine({
            price: target,
            color: '#06b6d4',
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `Chase Buy ${offsetPct > 0 ? `(-${offsetPct}%)` : ''}`,
        }));

        _previewLines.push(S.candleSeries.createPriceLine({
            price: bestBid,
            color: 'rgba(34,197,94,0.3)',
            lineWidth: 1,
            lineStyle: 3, // dotted
            axisLabelVisible: false,
            title: 'Best Bid',
        }));

        if (el) el.textContent = `Buy @ $${formatPrice(target)}${offsetPct > 0 ? ` (${offsetPct}% below bid $${formatPrice(bestBid)})` : ` (best bid)`}`;
    } else {
        const target = offsetPct > 0 ? bestAsk * (1 + offsetPct / 100) : bestAsk;
        _previewLines.push(S.candleSeries.createPriceLine({
            price: target,
            color: '#06b6d4',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `Chase Sell ${offsetPct > 0 ? `(+${offsetPct}%)` : ''}`,
        }));

        _previewLines.push(S.candleSeries.createPriceLine({
            price: bestAsk,
            color: 'rgba(239,68,68,0.3)',
            lineWidth: 1,
            lineStyle: 3,
            axisLabelVisible: false,
            title: 'Best Ask',
        }));

        if (el) el.textContent = `Sell @ $${formatPrice(target)}${offsetPct > 0 ? ` (${offsetPct}% above ask $${formatPrice(bestAsk)})` : ` (best ask)`}`;
    }
}

// ── Live Chase Visualization (multi-chase) ──────

/**
 * Draw/update live chase order price line on the chart.
 * Each chase order gets its own independent line, keyed by chaseId.
 * Called from WS chase_progress events.
 */
export function drawLiveChase(data) {
    if (!S.candleSeries) return;
    if (!data.currentOrderPrice || !data.chaseId) return;

    // Only draw lines for chases on the currently viewed symbol
    if (data.symbol && data.symbol !== S.selectedSymbol) return;

    const id = data.chaseId;
    let entry = _activeChases.get(id);
    if (!entry) {
        entry = { state: null, lines: [] };
        _activeChases.set(id, entry);
    }

    entry.state = {
        side: data.side,
        stalkOffsetPct: data.stalkOffsetPct || 0,
        initialPrice: data.initialPrice,
        currentOrderPrice: data.currentOrderPrice,
        symbol: data.symbol,
    };

    _renderOneChase(entry, data.currentOrderPrice,
        data.side === 'LONG' ? data.bid : data.ask);
}

/**
 * Called on every depth (orderbook) tick.
 * Recomputes every active chase's line position from live bid/ask.
 */
export function onChaseDepthTick() {
    if (_activeChases.size === 0 || !S.candleSeries) return;

    const bids = S.orderBookBids;
    const asks = S.orderBookAsks;
    if (!bids?.length || !asks?.length) return;

    const bestBid = bids[0][0];
    const bestAsk = asks[0][0];

    for (const [, entry] of _activeChases) {
        const st = entry.state;
        if (!st) continue;
        // Only update for current symbol
        if (st.symbol && st.symbol !== S.selectedSymbol) continue;

        let target, quoteRef;
        if (st.side === 'LONG') {
            target = st.stalkOffsetPct > 0 ? bestBid * (1 - st.stalkOffsetPct / 100) : bestBid;
            quoteRef = bestBid;
        } else {
            target = st.stalkOffsetPct > 0 ? bestAsk * (1 + st.stalkOffsetPct / 100) : bestAsk;
            quoteRef = bestAsk;
        }

        st.currentOrderPrice = target;
        _renderOneChase(entry, target, quoteRef);
    }
}

/** Remove a single chase by ID (on fill or cancel). */
export function removeChase(chaseId) {
    const entry = _activeChases.get(chaseId);
    if (entry) {
        _removeLinesForChase(entry);
        _activeChases.delete(chaseId);
    }
}

/** Clear all active chases (e.g. symbol switch). */
export function clearActiveChase() {
    for (const [, entry] of _activeChases) _removeLinesForChase(entry);
    _activeChases.clear();
}

function _renderOneChase(entry, price, quoteRef) {
    _removeLinesForChase(entry);
    if (!S.candleSeries) return;

    const st = entry.state;
    const isLong = st.side === 'LONG';
    const sym = st.symbol?.split('/')[0] || '';

    // Main chase price line (solid cyan)
    entry.lines.push(S.candleSeries.createPriceLine({
        price,
        color: '#06b6d4',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `🎯 ${sym} ${isLong ? 'Buy' : 'Sell'}${st.stalkOffsetPct > 0 ? ` ${st.stalkOffsetPct}%` : ''}`,
    }));

    // Initial price reference (faint)
    if (st.initialPrice && st.initialPrice !== price) {
        entry.lines.push(S.candleSeries.createPriceLine({
            price: st.initialPrice,
            color: 'rgba(148,163,184,0.25)',
            lineWidth: 1,
            lineStyle: 3,
            axisLabelVisible: false,
            title: `${sym} start`,
        }));
    }
}

// ── Submit / Cancel ─────────────────────────────

export async function submitChase() {
    if (!state.currentAccount) return showToast('Select an account first', 'error');

    // ── Edit mode: cancel old Chase first ──────────────────────────
    const editState = S._editState?.type === 'CHASE' ? S._editState : null;
    if (editState) {
        S.set('_editState', null);
        import('./positions-panel.js').then(m => m.clearEditMode?.());
        try { await api(`/trade/chase-limit/${editState.orderId}`, { method: 'DELETE' }); } catch { }
    }

    const sizeInput = document.getElementById('trade-size');
    const sizeUsdt = parseFloat(sizeInput?.value) || 0;
    if (sizeUsdt <= 0) return showToast('Enter a trade size', 'error');


    const offsetPct = parseFloat(document.getElementById('chase-offset')?.value) || 0;
    const maxDistancePct = parseFloat(document.getElementById('chase-distance')?.value) || 0;

    // Get stalk mode
    const stalkModeEl = document.querySelector('input[name="chase-stalk-mode"]:checked');
    const stalkMode = stalkModeEl?.value || 'none';

    // Calculate quantity from USDT size
    const price = S.currentPrice;
    if (!price || price <= 0) return showToast('Waiting for price data...', 'error');
    const quantity = sizeUsdt / price;

    const side = S.selectedSide;
    const leverage = S.leverage;

    const confirmed = await cuteConfirm({
        title: 'Chase Limit Order',
        message: `${side} ${S.selectedSymbol.split('/')[0]}\n` +
            `Size: $${sizeUsdt.toFixed(2)} (${quantity.toFixed(4)})\n` +
            `Leverage: ${leverage}×\n` +
            `Offset: ${offsetPct > 0 ? `${offsetPct}% (${stalkMode})` : 'None (best quote)'}` +
            `${maxDistancePct > 0 ? `\nMax distance: ${maxDistancePct}%` : '\nDistance: Infinite'}`,
        confirmText: 'Start Chase',
        danger: false,
    });
    if (!confirmed) return;

    try {
        const latencyId = beginOrderLatency('chase');
        markOrderSent(latencyId);
        const result = await api('/trade/chase-limit', {
            method: 'POST',
            body: {
                subAccountId: state.currentAccount,
                symbol: S.selectedSymbol,
                side,
                quantity,
                notionalUsd: sizeUsdt,
                leverage,
                stalkOffsetPct: offsetPct,
                stalkMode,
                maxDistancePct,
                // Send the orderbook bid/ask the user sees in the preview
                // so the backend places the order at the same price
                clientBid: S.orderBookBids?.[0]?.[0] || undefined,
                clientAsk: S.orderBookAsks?.[0]?.[0] || undefined,
            },
        });
        if (result.success) {
            markOrderAck(latencyId);
            requestAnimationFrame(() => markOrderPaint(latencyId));
            showToast(`Chase started: ${result.symbol.split('/')[0]} ${result.side} @ $${formatPrice(result.currentOrderPrice)}`, 'success');

            clearPreviewLines();

            // drawLiveChase stores state in the Map and renders chart lines
            if (result.currentOrderPrice && result.chaseId) {
                drawLiveChase(result);
            }

            scheduleTradingRefresh({ positions: true, openOrders: true }, 30);
        }
    } catch (err) {
        if (err.errors && Array.isArray(err.errors)) {
            showTradeError(err.errors);
        } else {
            showToast(`${err.message || 'Chase order failed'}`, 'error');
        }
    }
}

export async function cancelChase(chaseId) {
    showToast('Cancelling chase order...', 'info');
    try {
        const query = state.currentAccount
            ? `?subAccountId=${encodeURIComponent(state.currentAccount)}`
            : '';
        const result = await api(`/trade/chase-limit/${encodeURIComponent(chaseId)}${query}`, { method: 'DELETE' });
        showToast(`Chase cancelled (${result.symbol?.split('/')[0] || ''})`, 'success');
        removeChase(chaseId);
        scheduleTradingRefresh({ positions: true, openOrders: true }, 30);
    } catch (err) {
        showToast(`${err.message}`, 'error');
    }
}

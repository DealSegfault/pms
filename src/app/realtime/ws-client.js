function dispatchEvent(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

function getEventScope(data, currentAccount) {
    const eventAccount = data?.subAccountId;
    return !eventAccount || eventAccount === currentAccount;
}

export function createWsClient({
    state,
    getToken,
    showToast,
    formatPrice,
    onBotStatus = () => { },
    onPositionClosed = () => { },
}) {
    let reconnectTimeout = null;
    let reconnectEnabled = false;

    function clearReconnectTimeout() {
        if (!reconnectTimeout) return;
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    function setReconnectEnabled(enabled) {
        reconnectEnabled = !!enabled;
        if (!reconnectEnabled) clearReconnectTimeout();
    }

    function connect() {
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
        clearReconnectTimeout();

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/ws`);
        state.ws = ws;

        ws.onopen = () => {
            document.getElementById('connection-status')?.classList.replace('offline', 'online');
            state._wsReconnectDelay = 500; // Reset backoff on successful connect
            if (!state.currentAccount) return;
            ws.send(JSON.stringify({
                type: 'subscribe',
                subAccountId: state.currentAccount,
                token: getToken() || null,
            }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                const isMyEvent = getEventScope(msg.data, state.currentAccount);

                if (msg.type === 'pnl_update') {
                    if (isMyEvent) dispatchEvent('pnl_update', msg.data);
                    return;
                }

                if (msg.type === 'full_liquidation') {
                    if (!isMyEvent) return;
                    const modeLabels = {
                        INSTANT_CLOSE: 'Instant',
                        ADL_30_ESCALATED: 'ADL Escalated',
                        INSOLVENCY_GUARD: 'Insolvency Guard',
                    };
                    const mode = modeLabels[msg.data.mode] || msg.data.mode || 'Unknown';
                    showToast(`LIQUIDATION: Account fully liquidated (${mode}) | Margin: ${(msg.data.marginRatio * 100).toFixed(1)}%`, 'error');
                    dispatchEvent('liquidation', msg.data);
                    return;
                }

                if (msg.type === 'adl_triggered') {
                    if (!isMyEvent) return;
                    const pct = (msg.data.fraction * 100).toFixed(0);
                    showToast(`ADL Tier ${msg.data.tier}: ${pct}% of ${msg.data.symbol?.split('/')[0]} closed | Margin: ${(msg.data.marginRatio * 100).toFixed(1)}%`, 'warning');
                    dispatchEvent('liquidation', msg.data);
                    return;
                }

                if (msg.type === 'margin_warning') {
                    if (!isMyEvent) return;
                    showToast(msg.data.message, 'warning');
                    dispatchEvent('margin_warning', msg.data);
                    return;
                }

                if (msg.type === 'order_placed') {
                    if (!isMyEvent) return;
                    const d = msg.data;
                    const base = d.symbol?.split('/')[0];
                    const scaleInfo = d.scaleIndex != null ? ` [${d.scaleIndex + 1}/${d.scaleTotal}]` : '';
                    const twapInfo = d.twapLot != null ? ` [TWAP ${d.twapLot}/${d.twapTotal}]` : '';
                    showToast(`Limit placed: ${d.side} ${base} @ $${formatPrice(d.price)}${scaleInfo}${twapInfo}`, 'info');
                    dispatchEvent('order_placed', d);
                    return;
                }

                if (msg.type === 'order_filled') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    if (!d.suppressToast) {
                        const base = d.symbol?.split('/')[0] || d.symbol || 'Unknown';
                        const price = Number(d.price);
                        const qty = Number(d.quantity);
                        const priceText = Number.isFinite(price) ? formatPrice(price) : String(d.price || '—');
                        const qtyText = Number.isFinite(qty) && qty > 0 ? ` · qty ${qty.toFixed(4)}` : '';
                        const orderTag = d.orderId ? ` #${String(d.orderId).slice(-6)}` : '';
                        showToast(`Filled${orderTag}: ${d.side} ${base} @ $${priceText}${qtyText}`, 'success');
                    }
                    dispatchEvent('order_filled', { ...d, _serverTs: msg.timestamp || Date.now() });
                    return;
                }

                if (msg.type === 'order_cancelled') {
                    if (!isMyEvent) return;
                    showToast(`Order cancelled: ${msg.data.symbol?.split('/')[0]}`, 'warning');
                    dispatchEvent('order_cancelled', msg.data);
                    return;
                }

                if (msg.type === 'margin_update') {
                    if (isMyEvent) dispatchEvent('margin_update', msg.data);
                    return;
                }

                if (msg.type === 'position_closed') {
                    if (!isMyEvent) return;
                    const d = msg.data;
                    const pnlText = d.realizedPnl != null ? ` PnL: $${d.realizedPnl.toFixed(2)}` : '';
                    showToast(`Closed: ${d.symbol?.split('/')[0]}${pnlText}`, d.realizedPnl >= 0 ? 'success' : 'warning');
                    onPositionClosed(d);
                    dispatchEvent('position_closed', d);
                    return;
                }

                if (msg.type === 'position_reduced') {
                    if (!isMyEvent) return;
                    const d = msg.data;
                    const pct = d.closedQty && d.remainingQty != null
                        ? ((d.closedQty / (d.closedQty + d.remainingQty)) * 100).toFixed(0)
                        : '?';
                    showToast(`Reduced ${pct}%: ${d.symbol?.split('/')[0]}`, 'warning');
                    dispatchEvent('position_reduced', d);
                    return;
                }

                if (msg.type === 'position_updated') {
                    if (isMyEvent) dispatchEvent('position_updated', msg.data);
                    return;
                }

                if (msg.type === 'bot_status') {
                    onBotStatus(msg.data);
                    dispatchEvent('bot_status', msg.data);
                    return;
                }

                if (msg.type === 'bot_event') {
                    dispatchEvent('bot_event', msg.data);
                    return;
                }

                if (msg.type === 'babysitter_features') {
                    dispatchEvent('babysitter_features', msg.data);
                    return;
                }

                if (msg.type === 'twap_progress') {
                    if (isMyEvent) dispatchEvent('twap_progress', msg.data);
                    return;
                }

                if (msg.type === 'twap_completed') {
                    if (!isMyEvent) return;
                    const d = msg.data;
                    showToast(`TWAP done: ${d.symbol?.split('/')[0]} — ${d.filledLots}/${d.totalLots} lots`, 'success');
                    dispatchEvent('twap_completed', d);
                    return;
                }

                if (msg.type === 'twap_cancelled') {
                    if (!isMyEvent) return;
                    const d = msg.data;
                    showToast(`TWAP cancelled: ${d.symbol?.split('/')[0]} — ${d.filledLots}/${d.totalLots} lots`, 'warning');
                    dispatchEvent('twap_cancelled', d);
                    return;
                }

                if (msg.type === 'twap_basket_progress') {
                    if (isMyEvent) dispatchEvent('twap_basket_progress', msg.data);
                    return;
                }

                if (msg.type === 'twap_basket_completed') {
                    if (isMyEvent) dispatchEvent('twap_basket_completed', msg.data);
                    return;
                }

                if (msg.type === 'twap_basket_cancelled') {
                    if (isMyEvent) dispatchEvent('twap_basket_cancelled', msg.data);
                }

                // ── Chase Limit events ──
                if (msg.type === 'chase_progress') {
                    if (isMyEvent) dispatchEvent('chase_progress', msg.data);
                    return;
                }

                if (msg.type === 'chase_filled') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const base = d.symbol ? d.symbol.split('/')[0] : '';
                    const priceText = d.fillPrice ? `@ $${formatPrice(d.fillPrice)}` : '';
                    showToast(`🎯 Chase filled: ${d.side || ''} ${base} ${priceText}`, 'success');
                    dispatchEvent('chase_filled', d);
                    return;
                }

                if (msg.type === 'chase_cancelled') {
                    if (isMyEvent) dispatchEvent('chase_cancelled', msg.data);
                    return;
                }

                // ── SURF (Pump Chaser) events ──
                if (msg.type === 'pump_chaser_progress') {
                    if (isMyEvent) dispatchEvent('pump_chaser_progress', msg.data);
                    return;
                }

                if (msg.type === 'pump_chaser_fill') {
                    if (isMyEvent) dispatchEvent('pump_chaser_fill', msg.data);
                    return;
                }

                if (msg.type === 'pump_chaser_scalp') {
                    if (isMyEvent) dispatchEvent('pump_chaser_scalp', msg.data);
                    return;
                }

                if (msg.type === 'pump_chaser_stopped') {
                    if (isMyEvent) dispatchEvent('pump_chaser_stopped', msg.data);
                    return;
                }

                if (msg.type === 'pump_chaser_deleverage') {
                    if (isMyEvent) dispatchEvent('pump_chaser_deleverage', msg.data);
                    return;
                }

                // ── Trail Stop events ──
                if (msg.type === 'trail_stop_progress') {
                    if (isMyEvent) dispatchEvent('trail_stop_progress', msg.data);
                    return;
                }

                if (msg.type === 'trail_stop_triggered') {
                    if (isMyEvent) dispatchEvent('trail_stop_triggered', msg.data);
                    return;
                }

                if (msg.type === 'trail_stop_cancelled') {
                    if (isMyEvent) dispatchEvent('trail_stop_cancelled', msg.data);
                    return;
                }
            } catch {
                // Ignore malformed websocket payloads.
            }
        };

        ws.onclose = () => {
            state.ws = null;
            document.getElementById('connection-status')?.classList.replace('online', 'offline');

            if (!reconnectEnabled || !getToken()) return;
            // Exponential backoff: 500ms → 1s → 2s → max 5s
            const delay = state._wsReconnectDelay || 500;
            reconnectTimeout = setTimeout(() => {
                if (reconnectEnabled && getToken()) connect();
            }, delay);
            state._wsReconnectDelay = Math.min((delay || 500) * 2, 5000);
        };

        ws.onerror = () => ws.close();
    }

    function disconnect() {
        clearReconnectTimeout();

        const ws = state.ws;
        if (!ws) return;
        state.ws = null;

        try {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
        } catch {
            // Ignore close errors.
        }

        document.getElementById('connection-status')?.classList.replace('online', 'offline');
    }

    return {
        connect,
        disconnect,
        setReconnectEnabled,
    };
}

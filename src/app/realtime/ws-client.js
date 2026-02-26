function dispatchEvent(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

function getEventScope(data, currentAccount) {
    if (!data) return true;
    const eventAccount = data.subAccountId;
    if (!eventAccount) return true;
    return eventAccount === currentAccount;
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
            const wasReconnect = state._wsReconnectDelay > 500;
            state._wsReconnectDelay = 500;
            if (!state.currentAccount) return;
            ws.send(JSON.stringify({
                type: 'subscribe',
                subAccountId: state.currentAccount,
                token: getToken() || null,
            }));
            if (wasReconnect) {
                dispatchEvent('positions_resync', {});
            }
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
                    const d = msg.data || {};
                    const modeLabels = {
                        INSTANT_CLOSE: 'Instant',
                        ADL_30_ESCALATED: 'ADL Escalated',
                        INSOLVENCY_GUARD: 'Insolvency Guard',
                    };
                    const mode = modeLabels[d.mode] || d.mode || 'Unknown';
                    const marginPct = Number.isFinite(d.marginRatio) ? (d.marginRatio * 100).toFixed(1) : '?';
                    showToast(`LIQUIDATION: Account fully liquidated (${mode}) | Margin: ${marginPct}%`, 'error');
                    dispatchEvent('liquidation', d);
                    return;
                }

                if (msg.type === 'adl_triggered') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const pct = Number.isFinite(d.fraction) ? (d.fraction * 100).toFixed(0) : '?';
                    const marginPct = Number.isFinite(d.marginRatio) ? (d.marginRatio * 100).toFixed(1) : '?';
                    showToast(`ADL Tier ${d.tier || '?'}: ${pct}% of ${d.symbol?.split('/')[0]} closed | Margin: ${marginPct}%`, 'warning');
                    dispatchEvent('liquidation', d);
                    return;
                }

                if (msg.type === 'margin_warning') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    showToast(d.message || 'Margin warning', 'warning');
                    dispatchEvent('margin_warning', d);
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

                if (msg.type === 'order_acked') {
                    if (isMyEvent) dispatchEvent('order_acked', msg.data);
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
                    const d = msg.data || {};
                    if (!d.suppressToast) {
                        showToast(`Order cancelled: ${d.symbol?.split('/')[0]}`, 'warning');
                    }
                    dispatchEvent('order_cancelled', d);
                    return;
                }

                if (msg.type === 'order_rejected') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const base = d.symbol?.split('/')[0] || d.symbol || '';
                    const reason = d.reason || 'Unknown reason';
                    showToast(`Order rejected: ${base} — ${reason}`, 'error');
                    dispatchEvent('order_rejected', d);
                    return;
                }

                if (msg.type === 'order_error') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const reason = d.reason || d.message || 'Unknown error';
                    showToast(`Engine error: ${reason}`, 'error');
                    dispatchEvent('order_error', d);
                    return;
                }

                if (msg.type === 'margin_update') {
                    if (isMyEvent) dispatchEvent('margin_update', msg.data);
                    return;
                }

                if (msg.type === 'position_closed') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const pnlText = d.realizedPnl != null ? ` PnL: $${d.realizedPnl.toFixed(2)}` : '';
                    showToast(`Closed: ${d.symbol?.split('/')[0]}${pnlText}`, d.realizedPnl >= 0 ? 'success' : 'warning');
                    onPositionClosed(d);
                    dispatchEvent('position_closed', d);
                    return;
                }

                if (msg.type === 'position_reduced') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const total = (d.closedQty || 0) + (d.remainingQty || 0);
                    const pct = d.closedQty && total > 0
                        ? ((d.closedQty / total) * 100).toFixed(0)
                        : '?';
                    showToast(`Reduced ${pct}%: ${d.symbol?.split('/')[0]}`, 'warning');
                    dispatchEvent('position_reduced', d);
                    return;
                }

                if (msg.type === 'position_updated') {
                    if (isMyEvent) dispatchEvent('position_updated', msg.data);
                    return;
                }

                // ── C++ Engine Events (safety net — fills, snapshots, errors) ──
                if (msg.type === 'trade_execution') {
                    if (isMyEvent) dispatchEvent('trade_execution', msg.data);
                    return;
                }

                if (msg.type === 'margin_snapshot') {
                    // Reuse margin_update handler — C++ margin is authoritative
                    if (isMyEvent) dispatchEvent('margin_update', msg.data);
                    return;
                }

                if (msg.type === 'risk_snapshot') {
                    if (isMyEvent) dispatchEvent('risk_snapshot', msg.data);
                    return;
                }

                if (msg.type === 'positions_snapshot') {
                    // Treat like a resync — C++ position state is authoritative
                    if (isMyEvent) dispatchEvent('positions_resync', msg.data);
                    return;
                }

                if (msg.type === 'engine_error') {
                    if (isMyEvent) {
                        showToast(`Engine error: ${msg.data?.reason || msg.data?.message || 'unknown'}`, 'error');
                        dispatchEvent('engine_error', msg.data);
                    }
                    return;
                }

                // ── Smart Order Events ──
                if (msg.type === 'smart_order_progress') {
                    if (isMyEvent) dispatchEvent('smart_order_progress', msg.data);
                    return;
                }

                if (msg.type === 'smart_order_status') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    if (d.status === 'completed') {
                        showToast(`Smart order completed: ${d.symbol?.split('/')[0] || ''}`, 'success');
                    } else if (d.status === 'failed') {
                        showToast(`Smart order failed: ${d.reason || 'unknown'}`, 'error');
                    }
                    dispatchEvent('smart_order_status', d);
                    return;
                }

                if (msg.type === 'positions_resync') {
                    if (isMyEvent) dispatchEvent('positions_resync', msg.data);
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
                    return;
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

                // ── Scalper events ──
                if (msg.type === 'scalper_progress') {
                    if (isMyEvent) dispatchEvent('scalper_progress', msg.data);
                    return;
                }

                if (msg.type === 'scalper_filled') {
                    if (!isMyEvent) return;
                    const d = msg.data || {};
                    const base = d.symbol ? d.symbol.split('/')[0] : '';
                    const priceText = d.fillPrice ? `@ $${formatPrice(d.fillPrice)}` : '';
                    showToast(`Scalper filled: ${d.side || ''} ${base} ${priceText}`, 'success');
                    dispatchEvent('scalper_filled', d);
                    return;
                }

                if (msg.type === 'scalper_cancelled') {
                    if (isMyEvent) dispatchEvent('scalper_cancelled', msg.data);
                    return;
                }

                // ── Agent events ──
                if (msg.type === 'agent_started') {
                    if (isMyEvent) dispatchEvent('agent_started', msg.data);
                    return;
                }

                if (msg.type === 'agent_stopped') {
                    if (isMyEvent) dispatchEvent('agent_stopped', msg.data);
                    return;
                }

                if (msg.type === 'agent_status') {
                    if (isMyEvent) dispatchEvent('agent_status', msg.data);
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

/**
 * Engine Event Relay — broadcasts C++ engine events directly to frontend WS.
 *
 * V2: Always active (no CPP_ENGINE_UDS gate). Subscribes to UDS bridge events
 * and broadcasts to connected frontend WebSocket clients.
 *
 * Handles WS broadcasts only — zero persistence (handlers/ does DB writes).
 */

import { broadcast } from './ws.js';
import { log } from './structured-logger.js';

let _bridge = null;
let _initialized = false;
let _relayStats = {
    relayed: 0, orderUpdates: 0, positionUpdates: 0, tradeExecutions: 0,
    riskSnapshots: 0, marginSnapshots: 0, positionsSnapshots: 0, errors: 0,
    orderTypeProgress: 0,
};

export function initEventRelay(bridge) {
    if (_initialized || !bridge) return;
    _bridge = bridge;
    _initialized = true;

    // NOTE: order_update and position_update are handled by handlers/
    // (fill-handler, position-handler, rejection-handler) which persist + broadcast.
    // Relay only handles events that handlers DON'T cover:
    bridge.on('trade_execution', _onTradeExecution);
    bridge.on('risk_snapshot', _onRiskSnapshot);
    bridge.on('margin_snapshot', _onMarginSnapshot);
    bridge.on('positions_snapshot', _onPositionsSnapshot);
    bridge.on('error', _onEngineError);

    // Order-type progress events → broadcast to frontend WS
    bridge.on('event', _onOrderTypeProgress);

    console.log('[EventRelay] ✓ Initialized — relaying snapshots + errors + order progress to frontend WS');
}

export function shutdownEventRelay() {
    if (!_bridge) return;
    _bridge.off('trade_execution', _onTradeExecution);
    _bridge.off('risk_snapshot', _onRiskSnapshot);
    _bridge.off('margin_snapshot', _onMarginSnapshot);
    _bridge.off('positions_snapshot', _onPositionsSnapshot);
    _bridge.off('error', _onEngineError);
    _bridge.off('event', _onOrderTypeProgress);
    _bridge = null;
    _initialized = false;
}

export function getRelayStatus() {
    return { initialized: _initialized, stats: { ..._relayStats } };
}

// NOTE: order_update and position_update handled by handlers/ (fill, position, rejection)
// Relay only handles events below that handlers don't cover.


function _onTradeExecution(msg) {
    _relayStats.relayed++;
    _relayStats.tradeExecutions++;

    const subAccountId = msg.account || msg.sub_account_id || null;
    broadcast('trade_execution', {
        subAccountId, tradeId: msg.trade_id,
        internalOrderId: msg.internal_order_id, clientOrderId: msg.client_order_id,
        symbol: msg.symbol, side: msg.side, fillQty: msg.fill_qty,
        fillPrice: msg.fill_price, realizedPnl: msg.realized_pnl,
        remainingQty: msg.remaining_qty, success: msg.success,
        reason: msg.reason, ts: msg.ts || Date.now(),
    });
}

function _onRiskSnapshot(msg) {
    _relayStats.relayed++;
    _relayStats.riskSnapshots++;

    const subAccountId = msg.sub_account_id || null;
    broadcast('risk_snapshot', {
        subAccountId, balance: msg.balance, equity: msg.equity,
        equityRaw: msg.equity_raw, unrealizedPnl: msg.unrealized_pnl,
        marginUsed: msg.margin_used, reservedMargin: msg.reserved_margin,
        availableMargin: msg.available_margin, totalExposure: msg.total_exposure,
        maintenanceMargin: msg.maintenance_margin, marginRatio: msg.margin_ratio,
        positionCount: msg.position_count, pendingOrderCount: msg.pending_order_count,
        trigger: msg.trigger, ts: msg.ts || Date.now(),
    });
}

function _onMarginSnapshot(msg) {
    _relayStats.relayed++;
    _relayStats.marginSnapshots++;

    const subAccountId = msg.sub_account_id || null;
    broadcast('margin_snapshot', {
        subAccountId, balance: msg.balance, equity: msg.equity,
        equityRaw: msg.equity_raw, marginUsed: msg.margin_used,
        reservedMargin: msg.reserved_margin, availableMargin: msg.available_margin,
        marginRatio: msg.margin_ratio, unrealizedPnl: msg.unrealized_pnl,
        totalExposure: msg.total_exposure, positionCount: msg.position_count,
        pendingOrderCount: msg.pending_order_count, trigger: msg.trigger,
        ts: msg.ts || Date.now(),
    });
}

function _onPositionsSnapshot(msg) {
    _relayStats.relayed++;
    _relayStats.positionsSnapshots++;

    const subAccountId = msg.sub_account_id || null;
    broadcast('positions_snapshot', {
        subAccountId, positions: msg.positions || [],
        positionCount: msg.position_count, trigger: msg.trigger,
        ts: msg.ts || Date.now(),
    });
}

function _onEngineError(msg) {
    _relayStats.relayed++;
    _relayStats.errors++;

    log.error('event-relay', 'ENGINE_ERROR', msg.reason || msg.message || 'Unknown engine error', {
        op: msg.op, requestId: msg.request_id, code: msg.code,
        symbol: msg.symbol, account: msg.account || msg.sub_account_id,
    });

    broadcast('engine_error', {
        op: msg.op, reason: msg.reason,
        requestId: msg.request_id, ts: msg.ts || Date.now(),
    });
}

export default { initEventRelay, shutdownEventRelay, getRelayStatus };

// ── Order-type progress relay ────────────────────────────────────────────────
// Catch-all: any C++ event with stream starting with chase_/scalper_/trail_/twap_/smart_order_
// gets broadcast to frontend WS clients as-is.
const _ORDER_TYPE_PREFIXES = ['chase_', 'scalper_', 'trail_', 'twap_', 'smart_order_', 'basket_'];

function _onOrderTypeProgress(msg) {
    const stream = msg?.stream;
    if (!stream) return;

    const isOrderType = _ORDER_TYPE_PREFIXES.some(p => stream.startsWith(p));
    if (!isOrderType) return;

    _relayStats.relayed++;
    _relayStats.orderTypeProgress++;

    // Map C++ trail event names → frontend event names
    let wsType = stream;
    if (stream === 'trail_started' || stream === 'trail_progress' || stream === 'trail_activated') {
        wsType = 'trail_stop_progress';
    } else if (stream === 'trail_done') {
        const reason = msg.reason || '';
        wsType = reason === 'triggered' ? 'trail_stop_triggered' : 'trail_stop_cancelled';
    }

    // Broadcast under the mapped stream name so ws-client.js dispatches correctly
    broadcast(wsType, {
        ...msg,
        ts: msg.ts || Date.now(),
    });
}

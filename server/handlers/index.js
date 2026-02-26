/**
 * Handler Dispatcher — wires C++ engine events to clean handler functions.
 *
 * Replaces the monolithic simplx-event-persister.js init with explicit routing
 * per event type. No feature flags. No dual-mode.
 *
 * Usage:
 *   import { initHandlers, shutdownHandlers } from './handlers/index.js';
 *   initHandlers(bridge, riskEngine);
 */

import { handleFill, setRiskEngine as setFillRiskEngine } from './fill-handler.js';
import { handlePositionUpdate, setRiskEngine as setPositionRiskEngine } from './position-handler.js';
import { handleRejection, handleCancel } from './rejection-handler.js';
import { broadcast } from '../ws.js';
import { log } from '../structured-logger.js';

let _bridge = null;
let _initialized = false;

/**
 * Initialize all event handlers and subscribe to bridge events.
 * @param {object} bridge - SimplxUdsBridge instance
 * @param {object} riskEngine - JS RiskEngine (for in-memory book)
 */
export function initHandlers(bridge, riskEngine) {
    if (_initialized || !bridge) return;
    _bridge = bridge;
    _initialized = true;

    // Give handlers access to the risk engine
    setFillRiskEngine(riskEngine);
    setPositionRiskEngine(riskEngine);

    // Route events to handlers
    bridge.on('order_update', _routeOrderUpdate);
    bridge.on('position_update', handlePositionUpdate);
    bridge.on('cpp_error', _routeError);

    log.info('handlers', 'INIT', 'Event handlers initialized — fill, position, rejection');
}

export function shutdownHandlers() {
    if (!_initialized || !_bridge) return;
    _bridge.off('order_update', _routeOrderUpdate);
    _bridge.off('position_update', handlePositionUpdate);
    _bridge.off('cpp_error', _routeError);
    _initialized = false;
    log.info('handlers', 'SHUTDOWN', 'Event handlers shut down');
}

export function getHandlerStatus() {
    return { initialized: _initialized };
}

/**
 * Route order_update by status to the correct handler.
 * Simple switch — no business logic here.
 */
async function _routeOrderUpdate(msg) {
    try {
        const status = String(msg.status || '').toUpperCase();

        switch (status) {
            case 'FILLED':
            case 'PARTIALLY_FILLED':
                await handleFill(msg);
                break;

            case 'CANCELED':
                await handleCancel(msg);
                break;

            case 'REJECTED':
            case 'EXPIRED':
                await handleRejection(msg);
                break;

            case 'ACK':
            case 'ACCEPTED':
            case 'NEW': {
                const subAccountId = msg.account || msg.sub_account_id;
                broadcast('order_acked', {
                    subAccountId: subAccountId || undefined,
                    orderId: msg.client_order_id || msg.exchange_order_id || undefined,
                    symbol: msg.symbol || undefined,
                    side: msg.side || undefined,
                    type: msg.type || undefined,
                    price: msg.price || undefined,
                    suppressToast: !!msg.suppress_toast,
                    ts: msg.ts || Date.now(),
                });
                break;
            }

            default:
                break;
        }
    } catch (err) {
        log.error('handlers', 'ROUTE_ERROR', `order_update routing failed: ${err.message}`, {
            status: msg.status, symbol: msg.symbol, stack: err.stack,
        });
    }
}

function _routeError(msg) {
    const subAccountId = msg.account || msg.sub_account_id;
    broadcast('order_error', {
        subAccountId: subAccountId || undefined,
        reason: msg.reason || msg.message || 'Unknown engine error',
        op: msg.op || undefined,
        requestId: msg.request_id,
        ts: msg.ts || Date.now(),
    });
}

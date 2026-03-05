/**
 * contracts.js — Frontend event type definitions.
 *
 * JSDoc types for all WebSocket event payloads consumed by the trading page.
 * These match the Python contracts/events.py DTOs exactly.
 *
 * No runtime code — purely documentation for frontend developers.
 *
 * Convention:
 *   - Symbol: Binance-native (DOGEUSDT) — convert only at display boundary
 *   - Side: BUY/SELL for orders, LONG/SHORT for positions
 *   - Timestamps: milliseconds everywhere
 *   - REST and WS return identical shapes (Python to_dict() passthrough)
 *   - The WS message wrapper is: { type: string, data: EventPayload, timestamp: number }
 */

// ── Event Type Constants ────────────────────────────────────

export const WS_EVENTS = {
    // Order lifecycle
    ORDER_PLACED: 'order_placed',
    ORDER_ACTIVE: 'order_active',
    ORDER_PARTIAL: 'order_partial',
    ORDER_FILLED: 'order_filled',
    ORDER_CANCELLED: 'order_cancelled',
    ORDER_FAILED: 'order_failed',

    // Chase
    CHASE_PROGRESS: 'chase_progress',
    CHASE_FILLED: 'chase_filled',
    CHASE_CANCELLED: 'chase_cancelled',

    // Scalper
    SCALPER_PROGRESS: 'scalper_progress',
    SCALPER_FILLED: 'scalper_filled',
    SCALPER_CANCELLED: 'scalper_cancelled',

    // TWAP
    TWAP_PROGRESS: 'twap_progress',
    TWAP_COMPLETED: 'twap_completed',
    TWAP_CANCELLED: 'twap_cancelled',
    TWAP_BASKET_PROGRESS: 'twap_basket_progress',
    TWAP_BASKET_COMPLETED: 'twap_basket_completed',
    TWAP_BASKET_CANCELLED: 'twap_basket_cancelled',

    // Trail Stop
    TRAIL_STOP_PROGRESS: 'trail_stop_progress',
    TRAIL_STOP_TRIGGERED: 'trail_stop_triggered',
    TRAIL_STOP_CANCELLED: 'trail_stop_cancelled',

    // Position / Account
    PNL_UPDATE: 'pnl_update',
    POSITION_UPDATED: 'position_updated',
    POSITION_CLOSED: 'position_closed',
    POSITION_REDUCED: 'position_reduced',
    MARGIN_UPDATE: 'margin_update',
    MARGIN_WARNING: 'margin_warning',
    FULL_LIQUIDATION: 'full_liquidation',
    ADL_TRIGGERED: 'adl_triggered',
};

export const LIFECYCLE_STREAM_EVENTS = {
    ORDER_INTENT: 'ORDER_INTENT',
    ORDER_NEW: 'ORDER_NEW',
    ORDER_PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED',
    ORDER_FILLED: 'ORDER_FILLED',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    ORDER_EXPIRED: 'ORDER_EXPIRED',
    ORDER_REJECTED: 'ORDER_REJECTED',
};

// ── Event Payload Types ─────────────────────────────────────

/**
 * WS message wrapper.
 * @typedef {Object} WsMessage
 * @property {string} type       - One of WS_EVENTS
 * @property {Object} data       - Event-specific payload (see below)
 * @property {number} timestamp  - Server ms timestamp
 */

/**
 * @typedef {Object} OrderIntentLifecyclePayload
 * @property {"ORDER_INTENT"} type
 * @property {string} client_order_id
 * @property {string} sub_account_id
 * @property {string} routing_prefix
 * @property {string} symbol
 * @property {string} side
 * @property {string} order_type
 * @property {string|number} quantity
 * @property {string|number} price
 * @property {string|boolean} reduce_only
 * @property {string} origin
 * @property {string|number} decision_bid
 * @property {string|number} decision_ask
 * @property {string|number} decision_mid
 * @property {string|number} decision_spread_bps
 * @property {string|number} intent_ts
 * @property {string|number} source_ts
 * @property {string|number} ingested_ts
 */

/**
 * @typedef {Object} OrderRejectedLifecyclePayload
 * @property {"ORDER_REJECTED"} type
 * @property {string} client_order_id
 * @property {string} sub_account_id
 * @property {string} symbol
 * @property {string} side
 * @property {string} order_type
 * @property {string} error
 * @property {string} reason
 * @property {string} status
 * @property {string|number} rejected_ts
 * @property {string|number} source_ts
 * @property {string|number} ingested_ts
 */

/**
 * @typedef {Object} ChaseProgressPayload
 * @property {string} chaseId
 * @property {string} subAccountId
 * @property {string} symbol          - Binance-native
 * @property {string} side            - BUY / SELL
 * @property {number} quantity
 * @property {number} repriceCount
 * @property {string} status
 * @property {number} stalkOffsetPct
 * @property {number} initialPrice
 * @property {number|null} currentOrderPrice
 * @property {number} bid
 * @property {number} ask
 * @property {number} timestamp
 * @property {string} [parentScalperId]
 */

/**
 * @typedef {Object} ChaseFilledPayload
 * @property {string} chaseId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {number} quantity
 * @property {number} fillPrice
 * @property {number} repriceCount
 * @property {string} [parentScalperId]
 */

/**
 * @typedef {Object} ChaseCancelledPayload
 * @property {string} chaseId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {string} reason
 * @property {number} repriceCount
 */

/**
 * @typedef {Object} ScalperProgressPayload
 * @property {string} scalperId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} startSide
 * @property {string} status
 * @property {number} totalFillCount
 * @property {number|null} longMaxPrice
 * @property {number|null} shortMinPrice
 * @property {boolean} neutralMode
 * @property {Array<ScalperSlotPayload>} longSlots
 * @property {Array<ScalperSlotPayload>} shortSlots
 * @property {number} startedAt
 */

/**
 * @typedef {Object} ScalperSlotPayload
 * @property {number} layerIdx
 * @property {number} offsetPct
 * @property {number} qty
 * @property {boolean} active
 * @property {boolean} paused
 * @property {number|null} retryAt    - ms
 * @property {number} retryCount
 * @property {string|null} pauseReason
 * @property {number} fills
 */

/**
 * @typedef {Object} ScalperFilledPayload
 * @property {string} scalperId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {number} layerIdx
 * @property {number} fillPrice
 * @property {number} fillQty
 * @property {number} fillCount
 */

/**
 * @typedef {Object} TWAPProgressPayload
 * @property {string} twapId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {number} filledLots
 * @property {number} totalLots
 * @property {number} filledQuantity
 * @property {number} totalQuantity
 * @property {string} status
 */

/**
 * @typedef {Object} TrailStopProgressPayload
 * @property {string} trailStopId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side            - LONG / SHORT
 * @property {number} callbackPct
 * @property {number} extremePrice
 * @property {number} triggerPrice
 * @property {boolean} activated
 * @property {string|null} positionId
 * @property {number} quantity
 * @property {string} status
 */

/**
 * @typedef {Object} TrailStopTriggeredPayload
 * @property {string} trailStopId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {number} callbackPct
 * @property {number} extremePrice
 * @property {number} triggeredPrice
 * @property {string|null} positionId
 * @property {number} quantity
 */

/**
 * @typedef {Object} PositionClosedPayload
 * @property {string} subAccountId
 * @property {string} positionId
 * @property {string} symbol
 * @property {string} side
 * @property {number} realizedPnl
 * @property {number} closePrice
 * @property {boolean} [staleCleanup]
 * @property {string} [originType]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} PositionReducedPayload
 * @property {string} subAccountId
 * @property {string} positionId
 * @property {string} symbol
 * @property {number} closedQty
 * @property {number} remainingQty
 * @property {number} realizedPnl
 * @property {number} [liquidationPrice]
 * @property {string} [originType]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} OrderFilledPayload
 * @property {string} clientOrderId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {number} quantity
 * @property {number} price           - avgFillPrice
 * @property {string} orderType
 * @property {string} origin
 * @property {boolean} [suppressToast]
 */

// ── Display Helpers ─────────────────────────────────────────

/**
 * Extract base token from Binance-native symbol.
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @returns {string} - e.g. 'BTC'
 */
export function baseToken(symbol) {
    if (!symbol) return '';
    if (symbol.includes('/')) return symbol.split('/')[0];
    return symbol.replace('USDT', '');
}

/**
 * events.js — JSDoc type definitions for all PMS event types.
 *
 * These types match the Python contracts/events.py DTOs exactly.
 * They serve as documentation + dev-time validation for event consumers.
 *
 * Convention:
 *   - Symbol: Binance-native (BTCUSDT) — convert at display boundary
 *   - Side: BUY/SELL for orders, LONG/SHORT for positions
 *   - Timestamps: milliseconds everywhere
 *   - IDs: domain-specific (chaseId, scalperId, etc.)
 */

// ── Event Type Constants ────────────────────────────────────
export const EVENT_TYPES = {
    // Order lifecycle
    ORDER_PLACED: 'order_placed',
    ORDER_ACTIVE: 'order_active',
    ORDER_FILLED: 'order_filled',
    ORDER_CANCELLED: 'order_cancelled',
    ORDER_FAILED: 'order_failed',

    // Chase algo
    CHASE_PROGRESS: 'chase_progress',
    CHASE_FILLED: 'chase_filled',
    CHASE_CANCELLED: 'chase_cancelled',

    // Scalper algo
    SCALPER_PROGRESS: 'scalper_progress',
    SCALPER_FILLED: 'scalper_filled',
    SCALPER_CANCELLED: 'scalper_cancelled',

    // TWAP algo
    TWAP_PROGRESS: 'twap_progress',
    TWAP_COMPLETED: 'twap_completed',
    TWAP_CANCELLED: 'twap_cancelled',

    // TWAP basket
    TWAP_BASKET_PROGRESS: 'twap_basket_progress',
    TWAP_BASKET_COMPLETED: 'twap_basket_completed',
    TWAP_BASKET_CANCELLED: 'twap_basket_cancelled',

    // Trail stop
    TRAIL_STOP_PROGRESS: 'trail_stop_progress',
    TRAIL_STOP_TRIGGERED: 'trail_stop_triggered',
    TRAIL_STOP_CANCELLED: 'trail_stop_cancelled',

    // Position lifecycle
    POSITION_UPDATED: 'position_updated',
    POSITION_CLOSED: 'position_closed',
    POSITION_REDUCED: 'position_reduced',

    // Account
    MARGIN_UPDATE: 'margin_update',
    PNL_UPDATE: 'pnl_update',

    // Liquidation
    FULL_LIQUIDATION: 'full_liquidation',
    ADL_TRIGGERED: 'adl_triggered',
    MARGIN_WARNING: 'margin_warning',
};

// ── Chase State Shape (REST + Redis) ────────────────────────
/**
 * @typedef {Object} ChaseState
 * @property {string} chaseId
 * @property {string} subAccountId
 * @property {string} symbol                   - Binance-native (BTCUSDT)
 * @property {string} side                     - BUY / SELL
 * @property {number} quantity
 * @property {number} leverage
 * @property {string} stalkMode                - maintain / none
 * @property {number} stalkOffsetPct
 * @property {number} maxDistancePct
 * @property {string} status                   - ACTIVE / FILLED / CANCELLED
 * @property {number} repriceCount
 * @property {number} startedAt                - ms timestamp
 * @property {number|null} currentOrderPrice
 * @property {number} sizeUsd
 * @property {boolean} reduceOnly
 * @property {string|null} parentScalperId
 * @property {number|null} layerIdx
 * @property {boolean} [paused]
 * @property {number|null} [retryAt]           - ms timestamp
 */

// ── Scalper State Shape (REST + Redis) ──────────────────────
/**
 * @typedef {Object} ScalperSlot
 * @property {number} layerIdx
 * @property {string} side
 * @property {number} qty
 * @property {number} offsetPct
 * @property {boolean} active
 * @property {boolean} paused
 * @property {number|null} retryAt             - ms timestamp
 * @property {number} retryCount
 * @property {number} fills
 */

/**
 * @typedef {Object} ScalperState
 * @property {string} scalperId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} startSide                - LONG / SHORT
 * @property {number} childCount
 * @property {string} status
 * @property {number} totalFillCount
 * @property {number} longOffsetPct
 * @property {number} shortOffsetPct
 * @property {number} longSizeUsd
 * @property {number} shortSizeUsd
 * @property {boolean} neutralMode
 * @property {number} leverage
 * @property {number} skew
 * @property {number|null} longMaxPrice
 * @property {number|null} shortMinPrice
 * @property {number} minFillSpreadPct
 * @property {number} fillDecayHalfLifeMs
 * @property {number} minRefillDelayMs
 * @property {boolean} allowLoss
 * @property {number} startedAt                - ms timestamp
 */

// ── TWAP State Shape (REST + Redis) ─────────────────────────
/**
 * @typedef {Object} TWAPState
 * @property {string} twapId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side
 * @property {number} totalQuantity
 * @property {number} numLots
 * @property {number} intervalSeconds
 * @property {number} leverage
 * @property {number} filledLots
 * @property {number} filledQuantity
 * @property {string} status
 * @property {number} startedAt
 * @property {string} [basketId]
 */

// ── Trail Stop State Shape (REST + Redis) ───────────────────
/**
 * @typedef {Object} TrailStopState
 * @property {string} trailStopId
 * @property {string} subAccountId
 * @property {string} symbol
 * @property {string} side                     - LONG / SHORT
 * @property {number} quantity
 * @property {number} callbackPct              - Standardized name
 * @property {number|null} activationPrice
 * @property {number} extremePrice
 * @property {number} triggerPrice
 * @property {boolean} activated
 * @property {string} status
 * @property {string|null} positionId
 * @property {number} startedAt
 */

// ── Risk Snapshot Shape ─────────────────────────────────────
/**
 * @typedef {Object} PositionSnapshot
 * @property {string} id
 * @property {string} symbol
 * @property {string} side                     - LONG / SHORT
 * @property {number} entryPrice
 * @property {number} quantity
 * @property {number} notional
 * @property {number} margin
 * @property {number} leverage
 * @property {number} liquidationPrice
 * @property {number} unrealizedPnl
 * @property {number} pnlPercent
 * @property {number} markPrice
 * @property {number} openedAt
 */

/**
 * @typedef {Object} RiskSnapshot
 * @property {number} balance
 * @property {number} equity
 * @property {number} marginUsed
 * @property {number} availableMargin
 * @property {PositionSnapshot[]} positions
 * @property {Object[]} openOrders
 */

// ── Mapping Helpers ─────────────────────────────────────────
// REMOVED: mapChaseState, mapScalperState, mapTWAPState, mapTrailStopState
// Python to_dict() is the sole contract — JS passes Redis state through as-is.
// REST and WS now return identical shapes.

/**
 * Dev-mode validation: warn if an event is missing expected fields.
 * @param {string} type - Event type name
 * @param {Object} data - Event payload
 */
export function validateEvent(type, data) {
    if (process.env.NODE_ENV === 'production') return;
    if (!data) {
        console.warn(`[Contracts] Event ${type} has null data`);
        return;
    }
    if (!data.subAccountId && type !== 'connected') {
        console.warn(`[Contracts] Event ${type} missing subAccountId`);
    }
}

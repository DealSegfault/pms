/**
 * Event Schema — typed event contract between C++ engine and JS backend.
 *
 * This module is the JS-side canonical reference for all event types,
 * command types, and their required fields. Used for validation.
 *
 * Schema version 2 events include "v":2 in the JSON.
 */

// ── Event Types (C++ → JS) ──────────────────────────────────────────────

export const EVENT_TYPES = Object.freeze({
    ORDER_UPDATE: 'order_update',
    TRADE_EXECUTION: 'trade_execution',
    POSITION_UPDATE: 'position_update',
    ERROR: 'error',
    QUEUE_STATUS: 'queue_status',
    QUEUE_REJECT: 'queue_reject',
    RISK_SNAPSHOT: 'risk_snapshot',
    MARGIN_SNAPSHOT: 'margin_snapshot',
    POSITIONS_SNAPSHOT: 'positions_snapshot',
    STATS_SNAPSHOT: 'stats_snapshot',
    ENGINE_HEARTBEAT: 'ENGINE_HEARTBEAT',
    ENGINE_READY: 'ENGINE_READY',
});

// ── Command Types (JS → C++) ────────────────────────────────────────────

export const COMMAND_TYPES = Object.freeze({
    NEW: 'new',
    TRADE: 'trade',
    EXECUTE_TRADE: 'execute_trade',
    CANCEL: 'cancel',
    CANCEL_ORDER: 'cancel_order',
    UPSERT_ACCOUNT: 'upsert_account',
    UPSERT_RULE: 'upsert_rule',
    UPSERT_POSITION: 'upsert_position',
    UPSERT_EXCHANGE_POSITION: 'upsert_exchange_position',
    CLOSE: 'close',
    CLOSE_POSITION: 'close_position',
    CLOSE_ALL: 'close_all',
    CLOSE_ALL_POSITIONS: 'close_all_positions',
    CHASE_START: 'chase_start',
    CHASE_CANCEL: 'chase_cancel',
    SCALPER_START: 'scalper_start',
    SCALPER_CANCEL: 'scalper_cancel',
    TWAP_START: 'twap_start',
    TWAP_STOP: 'twap_stop',
    BASKET_START: 'basket_start',
    BASKET_STOP: 'basket_stop',
    TRAIL_START: 'trail_start',
    TRAIL_CANCEL: 'trail_cancel',
    SMART_ORDER: 'smart_order',
    SMART_ORDER_STOP: 'smart_order_stop',
    AGENT_START: 'agent_start',
    AGENT_STOP: 'agent_stop',
    GET_POSITIONS: 'get_positions',
    GET_MARGIN: 'get_margin',
    PING: 'ping',
});

// ── Required Fields Per Event Type ──────────────────────────────────────

export const REQUIRED_EVENT_FIELDS = Object.freeze({
    [EVENT_TYPES.ORDER_UPDATE]: [
        'request_id', 'internal_order_id', 'client_order_id',
        'symbol', 'side', 'status', 'qty', 'ts',
    ],
    [EVENT_TYPES.TRADE_EXECUTION]: [
        'request_id', 'trade_id', 'internal_order_id',
        'client_order_id', 'symbol', 'side', 'fill_qty', 'fill_price', 'ts',
    ],
    [EVENT_TYPES.POSITION_UPDATE]: [
        'request_id', 'position_id', 'sub_account_id',
        'symbol', 'side', 'entry_price', 'quantity', 'status',
    ],
    [EVENT_TYPES.ERROR]: [
        'request_id', 'op', 'reason',
    ],
    [EVENT_TYPES.QUEUE_STATUS]: [
        'request_id', 'internal_order_id', 'status', 'queue_depth',
    ],
    [EVENT_TYPES.QUEUE_REJECT]: [
        'request_id', 'internal_order_id', 'reason',
    ],
    [EVENT_TYPES.RISK_SNAPSHOT]: [
        'request_id', 'sub_account_id', 'balance', 'equity', 'margin_ratio',
    ],
    [EVENT_TYPES.MARGIN_SNAPSHOT]: [
        'request_id', 'sub_account_id', 'balance', 'margin_used',
    ],
    [EVENT_TYPES.POSITIONS_SNAPSHOT]: [
        'request_id', 'sub_account_id', 'positions',
    ],
    [EVENT_TYPES.STATS_SNAPSHOT]: [
        'request_id',
    ],
    [EVENT_TYPES.ENGINE_HEARTBEAT]: [
        'uptimeMs', 'ts',
    ],
    [EVENT_TYPES.ENGINE_READY]: [
        // No required fields
    ],
});

// ── Required Fields Per Command Type ────────────────────────────────────

export const REQUIRED_COMMAND_FIELDS = Object.freeze({
    [COMMAND_TYPES.NEW]: ['symbol', 'side', 'type', 'qty'],
    [COMMAND_TYPES.TRADE]: ['symbol', 'side', 'type', 'qty'],
    [COMMAND_TYPES.EXECUTE_TRADE]: ['symbol', 'side', 'type', 'qty'],
    [COMMAND_TYPES.CANCEL]: [], // order_id OR client_order_id (validated separately)
    [COMMAND_TYPES.CANCEL_ORDER]: [], // order_id OR client_order_id (validated separately)
    [COMMAND_TYPES.UPSERT_ACCOUNT]: ['sub_account_id', 'balance'],
    [COMMAND_TYPES.UPSERT_RULE]: ['sub_account_id', 'max_leverage'],
    [COMMAND_TYPES.UPSERT_POSITION]: ['sub_account_id', 'symbol', 'side', 'quantity'],
    [COMMAND_TYPES.UPSERT_EXCHANGE_POSITION]: ['symbol', 'side', 'quantity'],
    [COMMAND_TYPES.CLOSE]: ['sub_account_id', 'position_id'],
    [COMMAND_TYPES.CLOSE_POSITION]: ['position_id'],
    [COMMAND_TYPES.CLOSE_ALL]: ['sub_account_id'],
    [COMMAND_TYPES.CLOSE_ALL_POSITIONS]: ['sub_account_id'],
    [COMMAND_TYPES.CHASE_START]: ['sub_account_id', 'symbol', 'side', 'qty'],
    [COMMAND_TYPES.CHASE_CANCEL]: ['chase_id'],
    [COMMAND_TYPES.SCALPER_START]: ['sub_account_id', 'symbol'],
    [COMMAND_TYPES.SCALPER_CANCEL]: ['scalper_id'],
    [COMMAND_TYPES.TWAP_START]: ['sub_account_id', 'symbol', 'side'],
    [COMMAND_TYPES.TWAP_STOP]: ['twap_id'],
    [COMMAND_TYPES.BASKET_START]: ['sub_account_id', 'legs'],
    [COMMAND_TYPES.BASKET_STOP]: ['basket_id'],
    [COMMAND_TYPES.TRAIL_START]: ['sub_account_id', 'symbol', 'side', 'quantity', 'callback_pct'],
    [COMMAND_TYPES.TRAIL_CANCEL]: ['trail_id'],
    [COMMAND_TYPES.SMART_ORDER]: ['sub_account_id', 'symbol', 'direction'],
    [COMMAND_TYPES.SMART_ORDER_STOP]: ['smart_order_id'],
    [COMMAND_TYPES.AGENT_START]: ['sub_account_id'],
    [COMMAND_TYPES.AGENT_STOP]: ['agent_id'],
    [COMMAND_TYPES.GET_POSITIONS]: ['sub_account_id'],
    [COMMAND_TYPES.GET_MARGIN]: ['sub_account_id'],
    [COMMAND_TYPES.PING]: [],
});

export const SCHEMA_VERSION = 2;

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Validate an inbound C++ event against its schema.
 * @param {object} msg - Parsed JSON event
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEvent(msg) {
    if (!msg || typeof msg !== 'object') {
        return { valid: false, errors: ['msg is not an object'] };
    }

    const stream = msg.stream || msg.type;
    if (!stream) {
        return { valid: false, errors: ['missing stream/type field'] };
    }

    const required = REQUIRED_EVENT_FIELDS[stream];
    if (!required) {
        // Unknown event type — pass through but note it
        return { valid: true, errors: [] };
    }

    const errors = [];
    for (const field of required) {
        if (msg[field] === undefined || msg[field] === null) {
            errors.push(`missing '${field}'`);
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate an outbound JS command against its schema.
 * @param {string} op - Command type
 * @param {object} payload - Command payload
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCommand(op, payload) {
    const required = REQUIRED_COMMAND_FIELDS[op];
    if (!required) {
        return { valid: true, errors: [] };
    }

    const errors = [];
    for (const field of required) {
        if (payload[field] === undefined || payload[field] === null) {
            errors.push(`missing '${field}'`);
        }
    }

    // Special case: cancel requires at least one identifier
    if (op === COMMAND_TYPES.CANCEL || op === COMMAND_TYPES.CANCEL_ORDER) {
        if (!payload.order_id && !payload.client_order_id &&
            !payload.orderId && !payload.clientOrderId) {
            errors.push("cancel requires 'order_id' or 'client_order_id'");
        }
    }

    return { valid: errors.length === 0, errors };
}

export default {
    EVENT_TYPES,
    COMMAND_TYPES,
    REQUIRED_EVENT_FIELDS,
    REQUIRED_COMMAND_FIELDS,
    SCHEMA_VERSION,
    validateEvent,
    validateCommand,
};

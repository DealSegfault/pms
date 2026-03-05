import { streamAdd } from './redis.js';
import { getRoutingPrefix } from './routing-prefix.js';

export const TRADE_EVENT_STREAM = 'pms:stream:trade_events';

export const LIFECYCLE_STREAM_EVENTS = {
    ORDER_INTENT: 'ORDER_INTENT',
    ORDER_NEW: 'ORDER_NEW',
    ORDER_PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED',
    ORDER_FILLED: 'ORDER_FILLED',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    ORDER_EXPIRED: 'ORDER_EXPIRED',
    ORDER_REJECTED: 'ORDER_REJECTED',
    TRADE_LITE: 'TRADE_LITE',
    ACCOUNT_UPDATE: 'ACCOUNT_UPDATE',
};

function serializeFieldValue(value) {
    if (value == null) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return '';
        }
    }
    return String(value);
}

export function buildOrderIntentLifecycleEvent({
    subAccount,
    clientOrderId,
    symbol,
    side,
    orderType,
    quantity,
    price = null,
    reduceOnly = false,
    origin = 'BOT',
    parentId = '',
    userId = '',
    intentTs = Date.now(),
    decisionBid = null,
    decisionAsk = null,
    decisionMid = null,
    decisionSpreadBps = null,
}) {
    return {
        client_order_id: clientOrderId,
        sub_account_id: subAccount.id,
        routing_prefix: getRoutingPrefix(subAccount),
        symbol,
        side,
        order_type: orderType,
        quantity,
        price: price ?? '',
        reduce_only: reduceOnly,
        origin,
        parent_id: parentId,
        user_id: userId,
        execution_scope: 'SUB_ACCOUNT',
        venue: 'BINANCE',
        decision_bid: decisionBid ?? '',
        decision_ask: decisionAsk ?? '',
        decision_mid: decisionMid ?? '',
        decision_spread_bps: decisionSpreadBps ?? '',
        intent_ts: intentTs,
        source_ts: intentTs,
    };
}

export function buildOrderRejectedLifecycleEvent(intentEvent, error, rejectedTs = Date.now()) {
    return {
        ...intentEvent,
        status: 'REJECTED',
        error,
        reason: error,
        rejected_ts: rejectedTs,
        source_ts: rejectedTs,
    };
}

export async function publishLifecycleEvent(eventType, payload, stream = TRADE_EVENT_STREAM) {
    const now = Date.now();
    const fields = {
        type: eventType,
        ts: now,
        ingested_ts: now,
        source_ts: payload?.source_ts || payload?.intent_ts || payload?.event_time || payload?.order_trade_time || now,
        ...payload,
    };

    const serialized = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        serialized[key] = serializeFieldValue(value);
    }

    return streamAdd(stream, serialized);
}

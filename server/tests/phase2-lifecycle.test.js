import test from 'node:test';
import assert from 'node:assert/strict';

import { planRoutingPrefixBackfill } from '../db/subaccount-routing.js';
import {
    buildOrderIntentLifecycleEvent,
    buildOrderRejectedLifecycleEvent,
} from '../lifecycle-stream.js';

test('planRoutingPrefixBackfill only updates rows missing routing prefixes', () => {
    const updates = planRoutingPrefixBackfill([
        { id: '64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb', routing_prefix: null },
        { id: '2ef6d2e1-1111-2222-3333-444444444444', routing_prefix: 'abcd1234ef56' },
    ]);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, '64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb');
    assert.match(updates[0].routingPrefix, /^[a-f0-9]{12}$/);
});

test('planRoutingPrefixBackfill rejects duplicate routing prefixes', () => {
    assert.throws(
        () => planRoutingPrefixBackfill([
            { id: 'a', routing_prefix: 'deadbeefcafe' },
            { id: 'b', routing_prefix: 'deadbeefcafe' },
        ]),
        /routing prefix collision/,
    );
});

test('buildOrderIntentLifecycleEvent tags bot intents with routing identity', () => {
    const event = buildOrderIntentLifecycleEvent({
        subAccount: {
            id: '64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb',
            routingPrefix: '89b6f1f0f5aa',
        },
        clientOrderId: 'PMS89b6f1f0f5aa_LMT_deadbeef0001',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        quantity: 1.5,
        price: 101.25,
        reduceOnly: false,
        userId: 'user-1',
        intentTs: 1700000000123,
        decisionBid: 101.0,
        decisionAsk: 101.5,
        decisionMid: 101.25,
        decisionSpreadBps: 49.382716049382715,
    });

    assert.deepEqual(
        {
            client_order_id: event.client_order_id,
            sub_account_id: event.sub_account_id,
            routing_prefix: event.routing_prefix,
            order_type: event.order_type,
            decision_bid: event.decision_bid,
            decision_ask: event.decision_ask,
            decision_mid: event.decision_mid,
            intent_ts: event.intent_ts,
            source_ts: event.source_ts,
        },
        {
            client_order_id: 'PMS89b6f1f0f5aa_LMT_deadbeef0001',
            sub_account_id: '64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb',
            routing_prefix: '89b6f1f0f5aa',
            order_type: 'LIMIT',
            decision_bid: 101.0,
            decision_ask: 101.5,
            decision_mid: 101.25,
            intent_ts: 1700000000123,
            source_ts: 1700000000123,
        },
    );
});

test('buildOrderRejectedLifecycleEvent preserves the original lifecycle identity', () => {
    const intent = buildOrderIntentLifecycleEvent({
        subAccount: { id: 'sub-1', routingPrefix: 'abc123def456' },
        clientOrderId: 'PMSabc123def456_MKT_deadbeef0002',
        symbol: 'ETHUSDT',
        side: 'SELL',
        orderType: 'MARKET',
        quantity: 2,
        price: null,
        reduceOnly: true,
        intentTs: 1700000000456,
    });

    const rejected = buildOrderRejectedLifecycleEvent(intent, 'exchange rejected order', 1700000000789);

    assert.equal(rejected.client_order_id, intent.client_order_id);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.error, 'exchange rejected order');
    assert.equal(rejected.source_ts, 1700000000789);
});

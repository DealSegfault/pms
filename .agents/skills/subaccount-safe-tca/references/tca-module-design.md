# TCA Module Design

## Goal

Build a TCA subsystem that:

- runs independently from trading execution
- tracks full order lifecycle, not only fills
- stays segregated by virtual sub-account
- can distinguish virtual sub-account execution from raw main-account activity
- remains safe under reconnects, duplicate events, ambiguous exchange snapshots, and future order types

## Current Reality

The repo already has strong building blocks:

- explicit `subAccountId` in commands, order state, risk snapshots, and most events
- PMS-tagged `clientOrderId`
- managed-account guards in `OrderManager` and `RiskEngine`
- Redis Stream event bus for independent consumers
- per-sub-account Redis hashes/snapshots for open orders and risk

The gaps matter for TCA:

1. `trade_executions` is not a clean fill-only fact table.
2. `pending_orders` is not a full lifecycle table.
3. symbol format is mixed across Python and proxy/history paths.
4. raw exchange snapshots are aggregate and ownership-ambiguous.
5. stream delivery is at-least-once, so duplicates are expected.

## Design Choice

TCA must be an append-only read model built from lifecycle events, with exchange snapshots used only for reconciliation.

It should not derive ownership from aggregate exchange state after the fact.

## Proposed Runtime

### 1. `TCACollector`

Independent process / consumer group on `pms:stream:trade_events`.

Consumes:

- `ORDER_NEW`
- `ORDER_PARTIALLY_FILLED`
- `ORDER_FILLED`
- `ORDER_CANCELLED`
- `ORDER_EXPIRED`
- `ORDER_REJECTED`
- `TRADE_LITE`
- `ACCOUNT_UPDATE`
- new `ORDER_INTENT` event recommended below

Responsibilities:

- normalize and persist append-only lifecycle events
- upsert one lifecycle row per child order
- apply dedupe
- keep ownership confidence

### 2. `TCAMarketSampler`

Read-only subscriber to market data.

Responsibilities:

- capture decision-time bid/ask/mid/spread
- capture fill-time bid/ask/mid/spread
- compute markouts at 1s/5s/30s
- optionally capture imbalance/microprice/volatility when available

### 3. `TCAReconciler`

Periodic worker.

Responsibilities:

- mark lifecycles stale when exchange and stream disagree
- link recovered open orders to known lifecycle rows
- flag orphan/ambiguous rows
- never create `SUB_ACCOUNT` attribution from ambiguous evidence

### 4. `TCARollupWorker`

Periodic batch or incremental aggregator.

Responsibilities:

- per-order metrics
- per-strategy rollups
- per-sub-account rollups
- maker/taker and markout dashboards

## Required New Event

Add `ORDER_INTENT` before REST submission.

Without it, TCA cannot measure:

- decision timestamp
- arrival mid/spread
- queueing between decision and venue ack
- user intent versus recovered/external order discovery

Minimum payload:

- `subAccountId`
- `clientOrderId`
- `parentId`
- `origin`
- `symbol`
- `side`
- `orderType`
- `quantity`
- `price`
- `reduceOnly`
- `executionScope`
- `intentTs`
- `decisionBid`
- `decisionAsk`
- `decisionMid`
- `decisionSpreadBps`

## Recommended Data Model

### `tca_order_lifecycles`

One row per actual child order on the venue.

Suggested columns:

- `lifecycle_id`
- `execution_scope` (`SUB_ACCOUNT`, `MAIN_ACCOUNT`, `EXTERNAL_UNKNOWN`)
- `sub_account_id` nullable
- `venue`
- `venue_account_key`
- `ownership_confidence` (`HARD`, `SOFT`, `BACKFILL`, `UNKNOWN`)
- `origin_path` (`PYTHON_CMD`, `PROXY_BOT`, `BOT_FEED`, `RECOVERED`, `BACKFILL`)
- `strategy_type`
- `strategy_id`
- `parent_id`
- `client_order_id`
- `exchange_order_id`
- `symbol`
- `side`
- `order_type`
- `reduce_only`
- `requested_qty`
- `limit_price`
- `intent_ts`
- `ack_ts`
- `first_fill_ts`
- `done_ts`
- `final_status`
- `filled_qty`
- `avg_fill_price`
- `reprice_count`

Uniqueness:

- unique on `(venue, venue_account_key, client_order_id)` when client order id exists
- secondary uniqueness on `(venue, venue_account_key, exchange_order_id)` when exchange order id exists

### `tca_order_events`

Append-only event log.

Suggested columns:

- `event_pk`
- `lifecycle_id`
- `stream_event_id`
- `event_type`
- `source_ts`
- `ingested_ts`
- `payload_json`

Use this table for replay and audits.

### `tca_fill_facts`

One row per fill fragment.

Suggested columns:

- `fill_id`
- `lifecycle_id`
- `sub_account_id` nullable
- `fill_ts`
- `fill_qty`
- `fill_price`
- `fee`
- `maker_taker`
- `fill_bid`
- `fill_ask`
- `fill_mid`
- `fill_spread_bps`

### `tca_markouts`

Derived analytics per fill.

Suggested columns:

- `fill_id`
- `markout_1s_bps`
- `markout_5s_bps`
- `markout_30s_bps`
- `realized_spread_bps`

### `tca_strategy_sessions`

Needed for chase/scalper/TWAP lineage.

Suggested columns:

- `session_id`
- `sub_account_id`
- `strategy_type`
- `strategy_id`
- `symbol`
- `started_ts`
- `ended_ts`
- `config_json`

## Identity Rules For TCA

1. `sub_account_id` is required when `execution_scope = SUB_ACCOUNT`.
2. `sub_account_id` must stay null for `MAIN_ACCOUNT` unless a later hard-evidence event proves otherwise.
3. `ACCOUNT_UPDATE` can reconcile quantity for a known lifecycle or known position owner.
4. `ACCOUNT_UPDATE` cannot create new sub-account ownership.
5. A chase/scalper reprice creates a new child lifecycle linked to the same parent strategy/session.
6. Backfilled history is valid for coarse trade history, but low-confidence for fine TCA.

## Metrics To Build First

- arrival slippage versus decision mid
- ack latency (`ack_ts - intent_ts`)
- working time (`done_ts - ack_ts`)
- fill ratio
- cancel-to-fill ratio
- partial-fill count
- adverse markout 1s/5s/30s
- realized spread capture
- reprice count per fill
- per-sub-account and per-strategy rollups

## What Must Change In The Current System

1. Add `ORDER_INTENT`.
2. Normalize symbol storage for new TCA tables.
3. Introduce `execution_scope`, `venue_account_key`, and `ownership_confidence`.
4. Keep TCA tables separate from `trade_executions` and `pending_orders`.
5. Make proxy/bot path publish into the same lifecycle stream instead of only writing DB rows.

## Unknown Unknowns To Keep Visible

1. Proxy route writes `tradeExecution` rows at submit time, not only on fill.
2. Symbol format differs between Python execution paths and proxy/history paths.
3. External bot orders may appear first from feed, before any DB row exists.
4. Recovered orders and backfills may lack decision context and strategy lineage.
5. Redis Streams can replay old events after consumer restarts.
6. Exchange-side amend/replace semantics can produce new venue order IDs.
7. Current L1-only market data limits queue-aware TCA and realized-spread accuracy.

## Phased Delivery

### Phase 1

- add `ORDER_INTENT`
- add TCA tables
- run collector and reconciler
- compute arrival, ack, working-time, fill, cancel metrics

### Phase 2

- add fill-time market context and markouts
- add strategy session lineage
- add per-sub-account rollups

### Phase 3

- add L2 or microstructure features
- add queue-efficiency and toxicity metrics
- allow bounded auto-tuning on top of proven TCA metrics

## Stop Doing

- do not treat `trade_executions` as canonical lifecycle truth
- do not infer sub-account from symbol or currently selected UI account
- do not merge raw main-account activity into sub-account reports
- do not store new lifecycle facts in overloaded historical tables

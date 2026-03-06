import asyncio
from types import SimpleNamespace

import aiosqlite

from trading_engine_python.events.lifecycle_store import LifecycleStore


class MemoryDB:
    def __init__(self):
        self._conn = None

    async def connect(self):
        self._conn = await aiosqlite.connect(":memory:")
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(
            """
            CREATE TABLE strategy_sessions (
                id TEXT PRIMARY KEY,
                sub_account_id TEXT,
                origin TEXT,
                strategy_type TEXT,
                parent_strategy_session_id TEXT,
                root_strategy_session_id TEXT,
                session_role TEXT DEFAULT 'STANDALONE',
                symbol TEXT,
                side TEXT,
                started_at TIMESTAMP,
                ended_at TIMESTAMP,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE order_lifecycles (
                id TEXT PRIMARY KEY,
                execution_scope TEXT,
                sub_account_id TEXT,
                venue TEXT,
                venue_account_key TEXT,
                ownership_confidence TEXT,
                origin_path TEXT,
                strategy_type TEXT,
                strategy_session_id TEXT,
                parent_strategy_session_id TEXT,
                root_strategy_session_id TEXT,
                parent_id TEXT,
                client_order_id TEXT,
                exchange_order_id TEXT,
                symbol TEXT,
                side TEXT,
                order_type TEXT,
                order_role TEXT DEFAULT 'UNKNOWN',
                reduce_only INTEGER,
                requested_qty REAL,
                limit_price REAL,
                decision_bid REAL,
                decision_ask REAL,
                decision_mid REAL,
                decision_spread_bps REAL,
                intent_ts TIMESTAMP,
                ack_ts TIMESTAMP,
                first_fill_ts TIMESTAMP,
                done_ts TIMESTAMP,
                final_status TEXT,
                filled_qty REAL,
                avg_fill_price REAL,
                reprice_count INTEGER,
                reconciliation_status TEXT DEFAULT 'PENDING',
                reconciliation_reason TEXT,
                last_reconciled_at TIMESTAMP,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE order_lifecycle_events (
                id TEXT PRIMARY KEY,
                lifecycle_id TEXT,
                stream_event_id TEXT UNIQUE,
                event_type TEXT,
                source_ts TIMESTAMP,
                ingested_ts TIMESTAMP,
                payload_json TEXT,
                created_at TIMESTAMP
            );
            CREATE TABLE market_quotes (
                id TEXT PRIMARY KEY,
                symbol TEXT,
                ts TIMESTAMP,
                bid REAL,
                ask REAL,
                mid REAL,
                spread_bps REAL,
                source TEXT,
                created_at TIMESTAMP,
                UNIQUE(symbol, ts)
            );
            CREATE TABLE fill_facts (
                id TEXT PRIMARY KEY,
                lifecycle_id TEXT,
                sub_account_id TEXT,
                source_event_id TEXT UNIQUE,
                execution_scope TEXT,
                ownership_confidence TEXT,
                symbol TEXT,
                side TEXT,
                fill_ts TIMESTAMP,
                fill_qty REAL,
                fill_price REAL,
                fill_bid REAL,
                fill_ask REAL,
                fill_mid REAL,
                fill_spread_bps REAL,
                sampled_at TIMESTAMP,
                fee REAL,
                maker_taker TEXT,
                origin_type TEXT,
                created_at TIMESTAMP
            );
            CREATE TABLE fill_markouts (
                id TEXT PRIMARY KEY,
                fill_fact_id TEXT,
                horizon_ms INTEGER,
                measured_ts TIMESTAMP,
                mid_price REAL,
                mark_price REAL,
                markout_bps REAL,
                created_at TIMESTAMP,
                UNIQUE(fill_fact_id, horizon_ms)
            );
            CREATE TABLE algo_lineage_edges (
                id TEXT PRIMARY KEY,
                execution_scope TEXT,
                sub_account_id TEXT,
                ownership_confidence TEXT,
                parent_node_type TEXT,
                parent_node_id TEXT,
                child_node_type TEXT,
                child_node_id TEXT,
                relation_type TEXT,
                source_event_id TEXT,
                source_ts TIMESTAMP,
                ingested_ts TIMESTAMP,
                created_at TIMESTAMP,
                UNIQUE(parent_node_type, parent_node_id, child_node_type, child_node_id, relation_type)
            );
            CREATE TABLE sub_account_tca_rollups (
                id TEXT PRIMARY KEY,
                sub_account_id TEXT,
                execution_scope TEXT,
                ownership_confidence TEXT,
                quality_by_role_json TEXT,
                order_count INTEGER,
                terminal_order_count INTEGER,
                fill_count INTEGER,
                cancel_count INTEGER,
                reject_count INTEGER,
                total_requested_qty REAL,
                total_filled_qty REAL,
                total_fill_notional REAL,
                fill_ratio REAL,
                cancel_to_fill_ratio REAL,
                avg_arrival_slippage_bps REAL,
                avg_ack_latency_ms REAL,
                avg_working_time_ms REAL,
                avg_markout_1s_bps REAL,
                avg_markout_5s_bps REAL,
                avg_markout_30s_bps REAL,
                realized_pnl REAL DEFAULT 0,
                unrealized_pnl REAL DEFAULT 0,
                net_pnl REAL DEFAULT 0,
                fees_total REAL DEFAULT 0,
                last_sampled_at TIMESTAMP,
                total_reprice_count INTEGER,
                created_at TIMESTAMP,
                updated_at TIMESTAMP,
                UNIQUE(sub_account_id, execution_scope, ownership_confidence)
            );
            CREATE TABLE strategy_tca_rollups (
                id TEXT PRIMARY KEY,
                strategy_session_id TEXT,
                sub_account_id TEXT,
                strategy_type TEXT,
                rollup_level TEXT DEFAULT 'SESSION',
                execution_scope TEXT,
                ownership_confidence TEXT,
                quality_by_role_json TEXT,
                order_count INTEGER,
                terminal_order_count INTEGER,
                fill_count INTEGER,
                cancel_count INTEGER,
                reject_count INTEGER,
                total_requested_qty REAL,
                total_filled_qty REAL,
                total_fill_notional REAL,
                fill_ratio REAL,
                cancel_to_fill_ratio REAL,
                avg_arrival_slippage_bps REAL,
                avg_ack_latency_ms REAL,
                avg_working_time_ms REAL,
                avg_markout_1s_bps REAL,
                avg_markout_5s_bps REAL,
                avg_markout_30s_bps REAL,
                realized_pnl REAL DEFAULT 0,
                unrealized_pnl REAL DEFAULT 0,
                net_pnl REAL DEFAULT 0,
                fees_total REAL DEFAULT 0,
                open_qty REAL DEFAULT 0,
                open_notional REAL DEFAULT 0,
                close_count INTEGER DEFAULT 0,
                win_count INTEGER DEFAULT 0,
                loss_count INTEGER DEFAULT 0,
                win_rate REAL,
                max_drawdown_pnl REAL,
                max_runup_pnl REAL,
                last_sampled_at TIMESTAMP,
                total_reprice_count INTEGER,
                created_at TIMESTAMP,
                updated_at TIMESTAMP,
                UNIQUE(strategy_session_id, execution_scope, ownership_confidence, rollup_level)
            );
            CREATE TABLE tca_worker_cursors (
                worker_key TEXT PRIMARY KEY,
                cursor_json TEXT,
                last_run_started_at TIMESTAMP,
                last_run_completed_at TIMESTAMP,
                last_success_at TIMESTAMP,
                last_run_meta_json TEXT,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE tca_anomalies (
                id TEXT PRIMARY KEY,
                anomaly_key TEXT UNIQUE,
                anomaly_type TEXT,
                sub_account_id TEXT,
                root_strategy_session_id TEXT,
                strategy_session_id TEXT,
                lifecycle_id TEXT,
                fill_fact_id TEXT,
                severity TEXT DEFAULT 'WARN',
                status TEXT DEFAULT 'OPEN',
                payload_json TEXT,
                source_ts TIMESTAMP,
                first_seen_at TIMESTAMP,
                last_seen_at TIMESTAMP,
                resolved_at TIMESTAMP,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE algo_runtime_sessions (
                strategy_session_id TEXT PRIMARY KEY,
                sub_account_id TEXT,
                strategy_type TEXT,
                status TEXT,
                resume_policy TEXT DEFAULT 'RECREATE_CHILD_ORDERS',
                started_at TIMESTAMP,
                stopped_at TIMESTAMP,
                last_heartbeat_at TIMESTAMP,
                latest_checkpoint_id TEXT,
                initial_config_json TEXT,
                current_config_json TEXT,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE algo_runtime_checkpoints (
                id TEXT PRIMARY KEY,
                strategy_session_id TEXT,
                sub_account_id TEXT,
                strategy_type TEXT,
                checkpoint_seq INTEGER,
                checkpoint_ts TIMESTAMP,
                checkpoint_reason TEXT,
                status TEXT,
                snapshot_json TEXT,
                created_at TIMESTAMP,
                UNIQUE(strategy_session_id, checkpoint_seq)
            );
            CREATE TABLE strategy_position_lots (
                id TEXT PRIMARY KEY,
                sub_account_id TEXT,
                root_strategy_session_id TEXT,
                source_strategy_session_id TEXT,
                symbol TEXT,
                position_side TEXT,
                source_lifecycle_id TEXT,
                source_fill_fact_id TEXT,
                opened_ts TIMESTAMP,
                open_qty REAL,
                remaining_qty REAL,
                open_price REAL,
                open_fee REAL DEFAULT 0,
                status TEXT DEFAULT 'OPEN',
                closed_ts TIMESTAMP,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE strategy_lot_realizations (
                id TEXT PRIMARY KEY,
                lot_id TEXT,
                sub_account_id TEXT,
                root_strategy_session_id TEXT,
                source_strategy_session_id TEXT,
                close_lifecycle_id TEXT,
                close_fill_fact_id TEXT,
                realized_ts TIMESTAMP,
                allocated_qty REAL,
                open_price REAL,
                close_price REAL,
                gross_realized_pnl REAL,
                open_fee_allocated REAL DEFAULT 0,
                close_fee_allocated REAL DEFAULT 0,
                net_realized_pnl REAL,
                created_at TIMESTAMP
            );
            CREATE TABLE strategy_session_pnl_samples (
                id TEXT PRIMARY KEY,
                strategy_session_id TEXT,
                sub_account_id TEXT,
                sampled_at TIMESTAMP,
                mark_price REAL,
                realized_pnl REAL DEFAULT 0,
                unrealized_pnl REAL DEFAULT 0,
                net_pnl REAL DEFAULT 0,
                fees_total REAL DEFAULT 0,
                open_qty REAL DEFAULT 0,
                open_notional REAL DEFAULT 0,
                fill_count INTEGER DEFAULT 0,
                close_count INTEGER DEFAULT 0,
                win_count INTEGER DEFAULT 0,
                loss_count INTEGER DEFAULT 0,
                created_at TIMESTAMP,
                UNIQUE(strategy_session_id, sampled_at)
            );
            CREATE TABLE strategy_session_param_samples (
                id TEXT PRIMARY KEY,
                strategy_session_id TEXT,
                sub_account_id TEXT,
                sampled_at TIMESTAMP,
                sample_reason TEXT,
                status TEXT,
                start_side TEXT,
                neutral_mode INTEGER DEFAULT 0,
                allow_loss INTEGER DEFAULT 1,
                reduce_only_armed INTEGER DEFAULT 0,
                leverage INTEGER,
                child_count INTEGER,
                skew INTEGER,
                long_offset_pct REAL,
                short_offset_pct REAL,
                long_size_usd REAL,
                short_size_usd REAL,
                long_max_price REAL,
                short_min_price REAL,
                pin_long_to_entry INTEGER DEFAULT 0,
                pin_short_to_entry INTEGER DEFAULT 0,
                min_fill_spread_pct REAL,
                fill_decay_half_life_ms REAL,
                min_refill_delay_ms REAL,
                max_loss_per_close_bps INTEGER,
                max_fills_per_minute INTEGER,
                pnl_feedback_mode TEXT,
                last_known_price REAL,
                total_fill_count INTEGER DEFAULT 0,
                long_active_slots INTEGER DEFAULT 0,
                short_active_slots INTEGER DEFAULT 0,
                long_paused_slots INTEGER DEFAULT 0,
                short_paused_slots INTEGER DEFAULT 0,
                long_retrying_slots INTEGER DEFAULT 0,
                short_retrying_slots INTEGER DEFAULT 0,
                pause_reasons_json TEXT,
                created_at TIMESTAMP,
                UNIQUE(strategy_session_id, sampled_at, sample_reason)
            );
            CREATE TABLE pending_orders (
                id TEXT PRIMARY KEY,
                sub_account_id TEXT,
                client_order_id TEXT,
                exchange_order_id TEXT,
                status TEXT,
                created_at TIMESTAMP,
                filled_at TIMESTAMP,
                cancelled_at TIMESTAMP
            );
            """
        )
        await self._conn.commit()

    async def close(self):
        await self._conn.close()

    async def fetch_one(self, sql, params=()):
        cursor = await self._conn.execute(sql, params)
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def fetch_all(self, sql, params=()):
        cursor = await self._conn.execute(sql, params)
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def execute(self, sql, params=()):
        cursor = await self._conn.execute(sql, params)
        await self._conn.commit()
        return cursor.rowcount


def test_lifecycle_store_persists_intent_ack_and_fill_models():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)

        client_order_id = "PMSabc123def456_LMT_000000000001"
        parent_id = "scalper-session-1"
        await store.record({
            "_event_id": "1-0",
            "type": "ORDER_INTENT",
            "client_order_id": client_order_id,
            "sub_account_id": "sub-1",
            "symbol": "BTC/USDT:USDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "2.5",
            "price": "101.5",
            "decision_bid": "101.0",
            "decision_ask": "102.0",
            "decision_mid": "101.5",
            "decision_spread_bps": "98.52216748768473",
            "origin": "SCALPER",
            "parent_id": parent_id,
            "source_ts": "1709000000000",
            "ingested_ts": "1709000000001",
        })
        await store.record({
            "_event_id": "2-0",
            "type": "ORDER_STATE_NEW",
            "client_order_id": client_order_id,
            "exchange_order_id": "9001",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "2.5",
            "price": "101.5",
            "origin": "SCALPER",
            "parent_id": parent_id,
            "source_ts": "1709000000500",
            "ingested_ts": "1709000000501",
        })
        await store.record(
            {
                "_event_id": "3-0",
                "type": "ORDER_STATE_FILLED",
                "client_order_id": client_order_id,
                "exchange_order_id": "9001",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "2.5",
                "fill_qty": "2.5",
                "fill_price": "101.5",
                "avg_price": "101.5",
                "origin": "SCALPER",
                "parent_id": parent_id,
                "source_ts": "1709000001000",
                "ingested_ts": "1709000001001",
            },
            order=SimpleNamespace(
                client_order_id=client_order_id,
                exchange_order_id="9001",
                sub_account_id="sub-1",
                symbol="BTCUSDT",
                side="BUY",
                order_type="LIMIT",
                quantity=2.5,
                price=101.5,
                origin="SCALPER",
                parent_id=parent_id,
                reduce_only=False,
                filled_qty=2.5,
                avg_fill_price=101.5,
            ),
        )

        lifecycle = await db.fetch_one(
            "SELECT * FROM order_lifecycles WHERE client_order_id = ?",
            (client_order_id,),
        )
        assert lifecycle is not None
        assert lifecycle["symbol"] == "BTCUSDT"
        assert lifecycle["exchange_order_id"] == "9001"
        assert lifecycle["strategy_session_id"] == parent_id
        assert lifecycle["ack_ts"] is not None
        assert lifecycle["first_fill_ts"] is not None
        assert lifecycle["done_ts"] is not None
        assert lifecycle["decision_bid"] == 101.0
        assert lifecycle["decision_ask"] == 102.0
        assert lifecycle["decision_mid"] == 101.5
        assert lifecycle["final_status"] == "FILLED"
        assert lifecycle["filled_qty"] == 2.5
        assert lifecycle["avg_fill_price"] == 101.5

        events = await db.fetch_all("SELECT * FROM order_lifecycle_events ORDER BY stream_event_id")
        assert len(events) == 3

        fills = await db.fetch_all("SELECT * FROM fill_facts")
        assert len(fills) == 1
        assert fills[0]["source_event_id"] == "3-0"
        assert fills[0]["symbol"] == "BTCUSDT"
        assert fills[0]["fill_qty"] == 2.5

        strategy = await db.fetch_one("SELECT * FROM strategy_sessions WHERE id = ?", (parent_id,))
        assert strategy is not None
        assert strategy["strategy_type"] == "SCALPER"
        assert strategy["ended_at"] is not None

        await db.close()

    asyncio.run(run())


def test_lifecycle_store_is_idempotent_per_stream_event():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)

        event = {
            "_event_id": "1-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSdup12345678_LMT_000000000002",
            "sub_account_id": "sub-1",
            "symbol": "ETHUSDT",
            "side": "SELL",
            "order_type": "LIMIT",
            "quantity": "1.0",
            "price": "2500.0",
            "origin": "MANUAL",
            "source_ts": "1709000000000",
        }

        await store.record(event)
        await store.record(event)

        lifecycles = await db.fetch_all("SELECT * FROM order_lifecycles")
        events = await db.fetch_all("SELECT * FROM order_lifecycle_events")
        assert len(lifecycles) == 1
        assert len(events) == 1

        await db.close()

    asyncio.run(run())


def test_lifecycle_store_infers_root_scalper_type_from_root_session_id():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)

        await store.record({
            "_event_id": "root-1",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSroot12345678_LMT_000000000001",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1.0",
            "price": "100.0",
            "origin": "CHASE",
            "parent_id": "chase-1",
            "strategy_session_id": "chase-1",
            "parent_strategy_session_id": "scalper-1",
            "root_strategy_session_id": "scalper-1",
            "source_ts": "1709000000000",
        })

        root = await db.fetch_one("SELECT * FROM strategy_sessions WHERE id = ?", ("scalper-1",))
        child = await db.fetch_one("SELECT * FROM strategy_sessions WHERE id = ?", ("chase-1",))

        assert root is not None
        assert root["strategy_type"] == "SCALPER"
        assert root["origin"] == "SCALPER"
        assert root["session_role"] == "ROOT"
        assert child is not None
        assert child["strategy_type"] == "CHASE"
        assert child["session_role"] == "CHILD"

        await db.close()

    asyncio.run(run())


def test_lifecycle_store_marks_backfill_rows_low_confidence():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)

        await store.record({
            "_event_id": "9-0",
            "type": "ORDER_STATE_FILLED",
            "client_order_id": "PMSbackfill0001_LMT_000000000003",
            "exchange_order_id": "backfill-1",
            "sub_account_id": "sub-2",
            "symbol": "DOGE/USDT:USDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "10",
            "fill_qty": "10",
            "fill_price": "0.25",
            "avg_price": "0.25",
            "origin": "BACKFILL",
            "source_ts": "1709000005000",
        })

        lifecycle = await db.fetch_one("SELECT * FROM order_lifecycles")
        assert lifecycle["origin_path"] == "BACKFILL"
        assert lifecycle["ownership_confidence"] == "BACKFILL"
        assert lifecycle["final_status"] == "FILLED"

        fill = await db.fetch_one("SELECT * FROM fill_facts")
        assert fill["origin_type"] == "BACKFILL"
        assert fill["ownership_confidence"] == "BACKFILL"
        assert fill["symbol"] == "DOGEUSDT"

        await db.close()

    asyncio.run(run())


def test_lifecycle_store_materializes_lineage_edges_and_reprice_links():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)

        await store.record({
            "_event_id": "1-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSlineage001_LMT_000000000001",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "100",
            "origin": "CHASE",
            "parent_id": "chase-1",
            "order_role": "ENTRY",
            "strategy_session_id": "chase-1",
            "parent_strategy_session_id": "scalper-1",
            "root_strategy_session_id": "scalper-1",
            "source_ts": "1709000000000",
        })
        await store.record({
            "_event_id": "2-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSlineage001_LMT_000000000002",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "99.9",
            "origin": "CHASE",
            "parent_id": "chase-1",
            "order_role": "REPRICE",
            "strategy_session_id": "chase-1",
            "parent_strategy_session_id": "scalper-1",
            "root_strategy_session_id": "scalper-1",
            "replaces_client_order_id": "PMSlineage001_LMT_000000000001",
            "source_ts": "1709000000100",
        })

        lifecycles = await db.fetch_all("SELECT * FROM order_lifecycles ORDER BY client_order_id")
        edges = await db.fetch_all("SELECT * FROM algo_lineage_edges")
        assert len(lifecycles) == 2
        assert lifecycles[0]["order_role"] == "ENTRY"
        assert lifecycles[1]["order_role"] == "REPRICE"
        assert any(row["relation_type"] == "SPAWNS_SESSION" for row in edges)
        assert any(row["relation_type"] == "SUBMITS_ORDER" for row in edges)
        assert any(row["relation_type"] == "REPRICES_ORDER" for row in edges)

        await store.record({
            "_event_id": "2-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSlineage001_LMT_000000000002",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "99.9",
            "origin": "CHASE",
            "parent_id": "chase-1",
            "order_role": "REPRICE",
            "strategy_session_id": "chase-1",
            "replaces_client_order_id": "PMSlineage001_LMT_000000000001",
            "source_ts": "1709000000100",
        })
        deduped_edges = await db.fetch_all("SELECT * FROM algo_lineage_edges")
        assert len(deduped_edges) == len(edges)
        await db.close()

    asyncio.run(run())


def test_lifecycle_store_records_lineage_anomaly_for_unknown_role():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)

        await store.record({
            "_event_id": "3-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSlineage002_LMT_000000000001",
            "sub_account_id": "sub-1",
            "symbol": "ETHUSDT",
            "side": "SELL",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "3000",
            "origin": "SCALPER",
            "source_ts": "1709000000200",
        })

        lifecycle = await db.fetch_one(
            "SELECT * FROM order_lifecycles WHERE client_order_id = ?",
            ("PMSlineage002_LMT_000000000001",),
        )
        anomalies = await db.fetch_all(
            "SELECT * FROM order_lifecycle_events WHERE event_type = 'TCA_LINEAGE_ANOMALY'"
        )
        assert lifecycle is not None
        assert lifecycle["order_role"] == "UNKNOWN"
        assert len(anomalies) == 1
        await db.close()

    asyncio.run(run())

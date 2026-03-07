import asyncio
import json
import logging

from trading_engine_python.events.lifecycle_store import LifecycleStore
from trading_engine_python.tca.collector import TCACollector
from trading_engine_python.tca.market_sampler import TCAMarketSampler
from trading_engine_python.tca.quote_store import MarketQuoteStore
from trading_engine_python.tca.reconciler import TCAReconciler
from trading_engine_python.tca.rollups import TCARollupWorker
from trading_engine_python.tca.runtime_collector import ScalperRuntimeCollector
from trading_engine_python.tca.strategy_lot_ledger import StrategyLotLedgerWorker
from trading_engine_python.tca.strategy_sampler import StrategySessionSampler
from trading_engine_python.tests.test_lifecycle_store import MemoryDB


class FakeMarketData:
    def __init__(self):
        self._l1 = {}
        self.subscriptions = []

    def subscribe(self, symbol, callback):
        self.subscriptions.append((symbol, callback))

    def unsubscribe(self, symbol, callback):
        self.subscriptions = [item for item in self.subscriptions if item != (symbol, callback)]

    def get_l1(self, symbol):
        return self._l1.get(symbol)

    def set_l1(self, symbol, *, bid, ask, mid, ts):
        self._l1[symbol] = {"bid": bid, "ask": ask, "mid": mid, "ts": ts}


def test_tca_collector_replays_idempotently_from_stream():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))

        events = [
            {
                "_event_id": "1-0",
                "type": "ORDER_INTENT",
                "client_order_id": "PMScollector001_LMT_000000000001",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "1",
                "price": "100",
                "source_ts": "1709000000000",
            },
            {
                "_event_id": "2-0",
                "type": "ORDER_STATE_FILLED",
                "client_order_id": "PMScollector001_LMT_000000000001",
                "exchange_order_id": "5001",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "1",
                "fill_qty": "1",
                "fill_price": "100",
                "avg_price": "100",
                "source_ts": "1709000000100",
            },
        ]

        await collector.handle(events)
        await collector.handle(events)

        lifecycles = await db.fetch_all("SELECT * FROM order_lifecycles")
        lifecycle_events = await db.fetch_all("SELECT * FROM order_lifecycle_events")
        fill_facts = await db.fetch_all("SELECT * FROM fill_facts")

        assert len(lifecycles) == 1
        assert len(lifecycle_events) == 2
        assert len(fill_facts) == 1
        assert lifecycles[0]["final_status"] == "FILLED"

        await db.close()

    asyncio.run(run())


def test_tca_market_sampler_attaches_fill_context_and_markouts():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))
        quote_store = MarketQuoteStore(db)
        market_data = FakeMarketData()
        market_data.set_l1("BTCUSDT", bid=110.0, ask=111.0, mid=110.5, ts=1709000040.0)
        await quote_store.record_quote("BTCUSDT", bid=99.5, ask=100.5, mid=100.0, ts_ms=1709000000000)
        await quote_store.record_quote("BTCUSDT", bid=101.5, ask=102.5, mid=102.0, ts_ms=1709000001000)
        await quote_store.record_quote("BTCUSDT", bid=102.5, ask=103.5, mid=103.0, ts_ms=1709000005000)
        await quote_store.record_quote("BTCUSDT", bid=103.5, ask=104.5, mid=104.0, ts_ms=1709000030000)

        await collector.handle([{
            "_event_id": "1-0",
            "type": "ORDER_STATE_FILLED",
            "client_order_id": "PMSsampler001_LMT_000000000001",
            "exchange_order_id": "8101",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "fill_qty": "1",
            "fill_price": "100",
            "avg_price": "100",
            "source_ts": "1709000000000",
        }])

        sampler = TCAMarketSampler(db, market_data, horizons_ms=(1_000, 5_000, 30_000), quote_store=quote_store)
        summary = await sampler.sample_once()

        fill = await db.fetch_one("SELECT * FROM fill_facts")
        markouts = await db.fetch_all("SELECT * FROM fill_markouts ORDER BY horizon_ms")

        assert summary["fill_context_updates"] == 1
        assert summary["markouts_inserted"] == 3
        assert fill["fill_bid"] == 99.5
        assert fill["fill_ask"] == 100.5
        assert fill["fill_mid"] == 100.0
        assert fill["fill_spread_bps"] == 100.0
        assert [row["horizon_ms"] for row in markouts] == [1000, 5000, 30000]
        assert all(row["mid_price"] == 100.0 for row in markouts)
        assert [row["mark_price"] for row in markouts] == [102.0, 103.0, 104.0]

        await db.close()

    asyncio.run(run())


def test_tca_collector_keeps_ambiguous_activity_unattributed():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))

        await collector.handle([{
            "_event_id": "1-0",
            "type": "ORDER_STATE_FILLED",
            "exchange_order_id": "amb-1",
            "execution_scope": "EXTERNAL_UNKNOWN",
            "symbol": "ETH/USDT:USDT",
            "side": "SELL",
            "order_type": "MARKET",
            "quantity": "3",
            "fill_qty": "3",
            "fill_price": "2500",
            "avg_price": "2500",
            "origin": "BACKFILL",
            "source_ts": "1709000000000",
        }])

        lifecycle = await db.fetch_one("SELECT * FROM order_lifecycles WHERE exchange_order_id = ?", ("amb-1",))
        assert lifecycle is not None
        assert lifecycle["execution_scope"] == "EXTERNAL_UNKNOWN"
        assert lifecycle["sub_account_id"] is None
        assert lifecycle["ownership_confidence"] == "BACKFILL"
        assert lifecycle["symbol"] == "ETHUSDT"

        await db.close()

    asyncio.run(run())


def test_tca_market_sampler_subscribes_symbols_before_sampling():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)
        await store.record({
            "_event_id": "1-0",
            "type": "ORDER_STATE_FILLED",
            "client_order_id": "PMSsampler002_LMT_000000000001",
            "exchange_order_id": "8102",
            "sub_account_id": "sub-1",
            "symbol": "DOGEUSDT",
            "side": "SELL",
            "order_type": "LIMIT",
            "quantity": "5",
            "fill_qty": "5",
            "fill_price": "0.25",
            "avg_price": "0.25",
            "source_ts": "1709000000000",
        })

        market_data = FakeMarketData()
        sampler = TCAMarketSampler(db, market_data)
        await sampler.sample_once()

        assert market_data.subscriptions
        assert market_data.subscriptions[0][0] == "DOGEUSDT"

        await db.close()

    asyncio.run(run())


def test_tca_collector_persists_decision_context_from_intent():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))

        await collector.handle([{
            "_event_id": "1-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSintent001_LMT_000000000001",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "100",
            "decision_bid": "99.5",
            "decision_ask": "100.5",
            "decision_mid": "100.0",
            "decision_spread_bps": "100.0",
            "source_ts": "1709000000000",
        }])

        lifecycle = await db.fetch_one(
            "SELECT * FROM order_lifecycles WHERE client_order_id = ?",
            ("PMSintent001_LMT_000000000001",),
        )
        assert lifecycle["decision_bid"] == 99.5
        assert lifecycle["decision_ask"] == 100.5
        assert lifecycle["decision_mid"] == 100.0
        assert lifecycle["decision_spread_bps"] == 100.0

        await db.close()

    asyncio.run(run())


def test_tca_collector_links_repriced_children_to_one_strategy_session():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))

        parent_id = "scalper-parent-1"
        await collector.handle([
            {
                "_event_id": "1-0",
                "type": "ORDER_INTENT",
                "client_order_id": "PMSrepr001_LMT_000000000001",
                "sub_account_id": "sub-1",
                "symbol": "DOGEUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "10",
                "price": "0.25",
                "origin": "SCALPER",
                "parent_id": parent_id,
                "source_ts": "1709000000000",
            },
            {
                "_event_id": "2-0",
                "type": "ORDER_INTENT",
                "client_order_id": "PMSrepr001_LMT_000000000002",
                "sub_account_id": "sub-1",
                "symbol": "DOGEUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "10",
                "price": "0.24",
                "origin": "SCALPER",
                "parent_id": parent_id,
                "source_ts": "1709000000500",
            },
        ])

        sessions = await db.fetch_all("SELECT * FROM strategy_sessions")
        lifecycles = await db.fetch_all("SELECT * FROM order_lifecycles ORDER BY client_order_id")
        assert len(sessions) == 1
        assert len(lifecycles) == 2
        assert all(row["strategy_session_id"] == parent_id for row in lifecycles)
        assert all(row["origin_path"] == "PYTHON_CMD" for row in lifecycles)

        await db.close()

    asyncio.run(run())


def test_tca_collector_persists_nested_scalper_chase_lineage_edges():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))

        await collector.handle([
            {
                "_event_id": "10-0",
                "type": "ORDER_INTENT",
                "client_order_id": "PMSnest001_LMT_000000000001",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "SELL",
                "order_type": "LIMIT",
                "quantity": "1",
                "price": "101",
                "origin": "CHASE",
                "parent_id": "chase-1",
                "order_role": "UNWIND",
                "strategy_session_id": "chase-1",
                "parent_strategy_session_id": "scalper-1",
                "root_strategy_session_id": "scalper-1",
                "source_ts": "1709000001000",
            },
            {
                "_event_id": "11-0",
                "type": "ORDER_STATE_FILLED",
                "client_order_id": "PMSnest001_LMT_000000000001",
                "exchange_order_id": "nest-9001",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "SELL",
                "order_type": "LIMIT",
                "quantity": "1",
                "fill_qty": "1",
                "fill_price": "101",
                "avg_price": "101",
                "origin": "CHASE",
                "parent_id": "chase-1",
                "order_role": "UNWIND",
                "strategy_session_id": "chase-1",
                "parent_strategy_session_id": "scalper-1",
                "root_strategy_session_id": "scalper-1",
                "source_ts": "1709000001200",
            },
        ])

        edges = await db.fetch_all("SELECT * FROM algo_lineage_edges")
        assert any(e["relation_type"] == "SPAWNS_SESSION" for e in edges)
        assert any(e["relation_type"] == "SUBMITS_ORDER" for e in edges)
        assert any(e["relation_type"] == "GENERATES_FILL" for e in edges)
        await db.close()

    asyncio.run(run())


def test_tca_reconciler_marks_unacked_intents_stale():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)
        await store.record({
            "_event_id": "1-0",
            "type": "ORDER_INTENT",
            "client_order_id": "PMSstale001_LMT_000000000001",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "100",
            "source_ts": "1709000000000",
        })

        reconciler = TCAReconciler(db, intent_stale_after_sec=0.0, working_stale_after_sec=0.0)
        summary = await reconciler.reconcile_once()

        lifecycle = await db.fetch_one("SELECT * FROM order_lifecycles WHERE client_order_id = ?", ("PMSstale001_LMT_000000000001",))
        assert summary["stale"] == 1
        assert lifecycle["reconciliation_status"] == "STALE"
        assert lifecycle["reconciliation_reason"] == "MISSING_ACK"

        await db.close()

    asyncio.run(run())


def test_tca_reconciler_recovers_terminal_state_from_pending_orders():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)
        client_order_id = "PMSrecon001_LMT_000000000001"
        await store.record({
            "_event_id": "1-0",
            "type": "ORDER_INTENT",
            "client_order_id": client_order_id,
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "100",
            "source_ts": "1709000000000",
        })
        await store.record({
            "_event_id": "2-0",
            "type": "ORDER_STATE_NEW",
            "client_order_id": client_order_id,
            "exchange_order_id": "7001",
            "sub_account_id": "sub-1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "order_type": "LIMIT",
            "quantity": "1",
            "price": "100",
            "source_ts": "1709000000100",
        })
        await db.execute(
            """INSERT INTO pending_orders
               (id, sub_account_id, client_order_id, exchange_order_id, status, created_at, cancelled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("po-1", "sub-1", client_order_id, "7001", "CANCELLED", "2026-03-04 10:00:00", "2026-03-04 10:00:05"),
        )

        reconciler = TCAReconciler(db, intent_stale_after_sec=0.0, working_stale_after_sec=0.0)
        summary = await reconciler.reconcile_once()

        lifecycle = await db.fetch_one("SELECT * FROM order_lifecycles WHERE client_order_id = ?", (client_order_id,))
        reconcile_events = await db.fetch_all(
            "SELECT * FROM order_lifecycle_events WHERE event_type = 'TCA_RECONCILIATION'"
        )
        assert summary["recovered"] == 1
        assert lifecycle["final_status"] == "CANCELLED"
        assert lifecycle["reconciliation_status"] == "RECOVERED"
        assert lifecycle["reconciliation_reason"] == "PENDING_ORDER_CANCELLED"
        assert len(reconcile_events) == 1

        await db.close()

    asyncio.run(run())


def test_tca_reconciler_leaves_ambiguous_rows_unattributed():
    async def run():
        db = MemoryDB()
        await db.connect()
        store = LifecycleStore(db)
        await store.record({
            "_event_id": "1-0",
            "type": "ORDER_STATE_FILLED",
            "exchange_order_id": "amb-2",
            "execution_scope": "EXTERNAL_UNKNOWN",
            "symbol": "SOLUSDT",
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": "2",
            "fill_qty": "2",
            "fill_price": "150",
            "avg_price": "150",
            "source_ts": "1709000000000",
        })

        reconciler = TCAReconciler(db, intent_stale_after_sec=0.0, working_stale_after_sec=0.0)
        summary = await reconciler.reconcile_once()

        lifecycle = await db.fetch_one("SELECT * FROM order_lifecycles WHERE exchange_order_id = ?", ("amb-2",))
        assert summary["ambiguous"] == 1
        assert lifecycle["sub_account_id"] is None
        assert lifecycle["reconciliation_status"] == "AMBIGUOUS"
        assert lifecycle["reconciliation_reason"] == "EXTERNAL_OWNERSHIP_UNPROVEN"

        await db.close()

    asyncio.run(run())


def test_tca_rollup_worker_builds_subaccount_and_strategy_read_models():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = TCACollector(LifecycleStore(db))
        quote_store = MarketQuoteStore(db)
        market_data = FakeMarketData()
        market_data.set_l1("BTCUSDT", bid=101.0, ask=103.0, mid=102.0, ts=1709000040.0)
        await quote_store.record_quote("BTCUSDT", bid=99.5, ask=100.5, mid=100.0, ts_ms=1709000000300)
        await quote_store.record_quote("BTCUSDT", bid=101.0, ask=103.0, mid=102.0, ts_ms=1709000001300)
        await quote_store.record_quote("BTCUSDT", bid=101.0, ask=103.0, mid=102.0, ts_ms=1709000005300)
        await quote_store.record_quote("BTCUSDT", bid=101.0, ask=103.0, mid=102.0, ts_ms=1709000030300)

        parent_id = "twap-parent-1"
        await collector.handle([
            {
                "_event_id": "1-0",
                "type": "ORDER_INTENT",
                "client_order_id": "PMSroll001_LMT_000000000001",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "2",
                "price": "100",
                "decision_mid": "100",
                "origin": "TWAP",
                "parent_id": parent_id,
                "source_ts": "1709000000000",
            },
            {
                "_event_id": "2-0",
                "type": "ORDER_STATE_NEW",
                "client_order_id": "PMSroll001_LMT_000000000001",
                "exchange_order_id": "8201",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "2",
                "price": "100",
                "origin": "TWAP",
                "parent_id": parent_id,
                "source_ts": "1709000000200",
            },
            {
                "_event_id": "3-0",
                "type": "ORDER_STATE_FILLED",
                "client_order_id": "PMSroll001_LMT_000000000001",
                "exchange_order_id": "8201",
                "sub_account_id": "sub-1",
                "symbol": "BTCUSDT",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "2",
                "fill_qty": "2",
                "fill_price": "100",
                "avg_price": "100",
                "origin": "TWAP",
                "parent_id": parent_id,
                "source_ts": "1709000000300",
            },
            {
                "_event_id": "4-0",
                "type": "ORDER_STATE_FILLED",
                "exchange_order_id": "amb-roll-1",
                "execution_scope": "EXTERNAL_UNKNOWN",
                "symbol": "SOLUSDT",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "fill_qty": "1",
                "fill_price": "150",
                "avg_price": "150",
                "origin": "BACKFILL",
                "source_ts": "1709000000400",
            },
        ])

        sampler = TCAMarketSampler(db, market_data, quote_store=quote_store)
        await sampler.sample_once()

        rollups = TCARollupWorker(db)
        summary = await rollups.recompute_once()

        sub_rollups = await db.fetch_all("SELECT * FROM sub_account_tca_rollups")
        strategy_rollups = await db.fetch_all("SELECT * FROM strategy_tca_rollups")

        assert summary["sub_account_rollups"] == 1
        assert summary["strategy_rollups"] == 2
        assert len(sub_rollups) == 1
        assert len(strategy_rollups) == 2

        sub = sub_rollups[0]
        assert sub["sub_account_id"] == "sub-1"
        assert sub["execution_scope"] == "SUB_ACCOUNT"
        assert sub["ownership_confidence"] == "HARD"
        assert sub["order_count"] == 1
        assert sub["fill_count"] == 1
        assert sub["fill_ratio"] == 1.0
        assert sub["avg_arrival_slippage_bps"] == 0.0
        assert sub["avg_ack_latency_ms"] == 200.0
        assert sub["avg_working_time_ms"] == 100.0
        assert sub["avg_markout_1s_bps"] == 200.0
        quality_by_role = json.loads(sub["quality_by_role_json"])
        assert quality_by_role["UNKNOWN"]["lifecycleCount"] == 1
        assert quality_by_role["UNKNOWN"]["fillCount"] == 1

        by_level = {row["rollup_level"]: row for row in strategy_rollups}
        assert set(by_level) == {"SESSION", "ROOT"}
        strategy = by_level["SESSION"]
        assert strategy["strategy_session_id"] == parent_id
        assert strategy["strategy_type"] == "TWAP"
        assert strategy["sub_account_id"] == "sub-1"
        assert strategy["execution_scope"] == "SUB_ACCOUNT"
        assert strategy["ownership_confidence"] == "HARD"

        root = by_level["ROOT"]
        assert root["strategy_session_id"] == parent_id
        assert root["strategy_type"] == "TWAP"
        assert root["sub_account_id"] == "sub-1"
        assert root["execution_scope"] == "SUB_ACCOUNT"
        assert root["ownership_confidence"] == "HARD"

        cursor = await db.fetch_one("SELECT * FROM tca_worker_cursors WHERE worker_key = ?", ("tca_rollups",))
        assert cursor is not None

        await db.close()

    asyncio.run(run())


def test_tca_rollup_worker_sums_latest_session_economics_per_sub_account():
    async def run():
        db = MemoryDB()
        await db.connect()

        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("root-1", "sub-1", "SCALPER", "SCALPER", "root-1", "ROOT", "BTCUSDT", "LONG", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("root-2", "sub-1", "SCALPER", "SCALPER", "root-2", "ROOT", "ETHUSDT", "SHORT", "2026-03-05 10:05:00", "2026-03-05 10:05:00", "2026-03-05 10:05:00"),
        )
        await db.execute(
            """INSERT INTO strategy_session_pnl_samples
               (id, strategy_session_id, sub_account_id, sampled_at, realized_pnl, unrealized_pnl, net_pnl,
                fees_total, open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("sample-1a", "root-1", "sub-1", "2026-03-05 10:00:00", 4.0, 1.0, 5.0, 0.5, 1.0, 100.0, 2, 1, 1, 0, "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO strategy_session_pnl_samples
               (id, strategy_session_id, sub_account_id, sampled_at, realized_pnl, unrealized_pnl, net_pnl,
                fees_total, open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("sample-1b", "root-1", "sub-1", "2026-03-05 10:01:00", 6.0, 1.0, 7.0, 0.7, 0.5, 55.0, 3, 1, 1, 0, "2026-03-05 10:01:00"),
        )
        await db.execute(
            """INSERT INTO strategy_session_pnl_samples
               (id, strategy_session_id, sub_account_id, sampled_at, realized_pnl, unrealized_pnl, net_pnl,
                fees_total, open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("sample-2a", "root-2", "sub-1", "2026-03-05 10:02:00", 2.0, 1.0, 3.0, 0.3, 0.25, 40.0, 1, 1, 0, 1, "2026-03-05 10:02:00"),
        )

        worker = TCARollupWorker(db)
        summary = await worker.recompute_once()

        sub = await db.fetch_one(
            """SELECT * FROM sub_account_tca_rollups
               WHERE sub_account_id = ? AND execution_scope = ? AND ownership_confidence = ?""",
            ("sub-1", "SUB_ACCOUNT", "HARD"),
        )
        roots = await db.fetch_all(
            """SELECT * FROM strategy_tca_rollups
               WHERE execution_scope = ? AND ownership_confidence = ?
               ORDER BY strategy_session_id, rollup_level""",
            ("SUB_ACCOUNT", "HARD"),
        )

        assert summary["sub_account_rollups"] == 1
        assert summary["strategy_rollups"] == 4
        assert sub["realized_pnl"] == 8.0
        assert sub["unrealized_pnl"] == 2.0
        assert sub["net_pnl"] == 10.0
        assert sub["fees_total"] == 1.0
        assert sub["quality_by_role_json"] == "{}"

        root_1 = next(row for row in roots if row["strategy_session_id"] == "root-1" and row["rollup_level"] == "ROOT")
        root_2 = next(row for row in roots if row["strategy_session_id"] == "root-2" and row["rollup_level"] == "ROOT")
        assert root_1["net_pnl"] == 7.0
        assert root_1["open_qty"] == 0.5
        assert root_2["net_pnl"] == 3.0
        assert root_2["loss_count"] == 1

        await db.close()

    asyncio.run(run())


def test_tca_rollup_worker_incremental_run_targets_roots_not_whole_subaccounts():
    async def run():
        db = MemoryDB()
        await db.connect()

        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("root-1", "sub-1", "SCALPER", "SCALPER", "root-1", "ROOT", "BTCUSDT", "LONG", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("root-2", "sub-1", "SCALPER", "SCALPER", "root-2", "ROOT", "ETHUSDT", "SHORT", "2026-03-05 10:05:00", "2026-03-05 10:05:00", "2026-03-05 10:05:00"),
        )
        await db.execute(
            """INSERT INTO strategy_session_pnl_samples
               (id, strategy_session_id, sub_account_id, sampled_at, realized_pnl, unrealized_pnl, net_pnl,
                fees_total, open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("sample-1a", "root-1", "sub-1", "2026-03-05 10:00:00", 4.0, 1.0, 5.0, 0.5, 1.0, 100.0, 2, 1, 1, 0, "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO strategy_session_pnl_samples
               (id, strategy_session_id, sub_account_id, sampled_at, realized_pnl, unrealized_pnl, net_pnl,
                fees_total, open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("sample-2a", "root-2", "sub-1", "2026-03-05 10:02:00", 2.0, 1.0, 3.0, 0.3, 0.25, 40.0, 1, 1, 0, 1, "2026-03-05 10:02:00"),
        )

        worker = TCARollupWorker(db)
        await worker.recompute_once()

        queries = []
        original_fetch_all = db.fetch_all
        original_execute = db.execute

        async def recording_fetch_all(sql, params=()):
            queries.append(" ".join(str(sql).split()))
            return await original_fetch_all(sql, params)

        async def recording_execute(sql, params=()):
            queries.append(" ".join(str(sql).split()))
            return await original_execute(sql, params)

        db.fetch_all = recording_fetch_all  # type: ignore[method-assign]
        db.execute = recording_execute  # type: ignore[method-assign]

        await db.execute(
            """INSERT INTO strategy_session_pnl_samples
               (id, strategy_session_id, sub_account_id, sampled_at, realized_pnl, unrealized_pnl, net_pnl,
                fees_total, open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("sample-1b", "root-1", "sub-1", "2026-03-05 10:03:00", 6.0, 3.0, 9.0, 0.7, 0.5, 55.0, 3, 1, 1, 0, "2026-03-05 10:03:00"),
        )

        summary = await worker.recompute_once()

        sub = await original_fetch_all(
            """SELECT * FROM sub_account_tca_rollups
               WHERE sub_account_id = ? AND execution_scope = ? AND ownership_confidence = ?""",
            ("sub-1", "SUB_ACCOUNT", "HARD"),
        )
        roots = await original_fetch_all(
            """SELECT * FROM strategy_tca_rollups
               WHERE execution_scope = ? AND ownership_confidence = ?
               ORDER BY strategy_session_id, rollup_level""",
            ("SUB_ACCOUNT", "HARD"),
        )

        assert summary["reconcile_mode"] == "incremental"
        assert summary["impacted_sub_accounts"] == 1
        assert len(sub) == 1
        assert sub[0]["net_pnl"] == 12.0

        root_1 = next(row for row in roots if row["strategy_session_id"] == "root-1" and row["rollup_level"] == "ROOT")
        root_2 = next(row for row in roots if row["strategy_session_id"] == "root-2" and row["rollup_level"] == "ROOT")
        assert root_1["net_pnl"] == 9.0
        assert root_2["net_pnl"] == 3.0

        assert any("DELETE FROM strategy_tca_rollups WHERE strategy_session_id IN" in sql for sql in queries)
        assert any("COALESCE(root_strategy_session_id, strategy_session_id) IN" in sql for sql in queries)
        assert not any("FROM strategy_sessions WHERE sub_account_id IN" in sql for sql in queries)
        assert not any("FROM order_lifecycles WHERE sub_account_id IN" in sql for sql in queries)

        await db.close()

    asyncio.run(run())


def test_tca_rollup_worker_logs_only_when_rollup_snapshot_changes(caplog):
    async def run():
        stop_event = asyncio.Event()
        worker = TCARollupWorker(db=None, interval_sec=0.001)

        snapshots = iter([
            {
                "sub_account_rollups": 2,
                "strategy_rollups": 238,
                "change_digest": "snapshot-a",
            },
            {
                "sub_account_rollups": 2,
                "strategy_rollups": 238,
                "change_digest": "snapshot-a",
            },
            {
                "sub_account_rollups": 2,
                "strategy_rollups": 238,
                "change_digest": "snapshot-b",
            },
        ])

        async def fake_recompute_once():
            summary = next(snapshots)
            if summary["change_digest"] == "snapshot-b":
                stop_event.set()
            return summary

        worker.recompute_once = fake_recompute_once  # type: ignore[method-assign]
        await worker.run(stop_event)

    with caplog.at_level(logging.INFO, logger="trading_engine_python.tca.rollups"):
        asyncio.run(run())

    messages = [record.getMessage() for record in caplog.records if "TCARollupWorker rebuilt" in record.getMessage()]
    assert len(messages) == 2
    assert messages[0].startswith("TCARollupWorker rebuilt 2 sub-account rollup(s) and 238 strategy rollup(s)")
    assert messages[1].startswith("TCARollupWorker rebuilt 2 sub-account rollup(s) and 238 strategy rollup(s)")


def test_scalper_runtime_collector_persists_checkpoint_and_root_session():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = ScalperRuntimeCollector(db)

        snapshot = {
            "scalperId": "scalper-1",
            "subAccountId": "sub-1",
            "symbol": "BTCUSDT",
            "startSide": "LONG",
            "childCount": 2,
            "longOffsetPct": 0.2,
            "shortOffsetPct": 0.25,
            "longSizeUsd": 50.0,
            "shortSizeUsd": 55.0,
            "neutralMode": False,
            "allowLoss": True,
            "reduceOnlyArmed": False,
            "startedAt": 1709000000000,
            "status": "ACTIVE",
            "totalFillCount": 1,
            "longSlots": [],
            "shortSlots": [],
        }
        await collector.handle([{
            "type": "SCALPER_RUNTIME_SNAPSHOT",
            "strategy_session_id": "scalper-1",
            "sub_account_id": "sub-1",
            "strategy_type": "SCALPER",
            "checkpoint_seq": "1",
            "checkpoint_reason": "START",
            "status": "ACTIVE",
            "source_ts": "1709000000000",
            "snapshot_json": json.dumps(snapshot),
        }])
        await collector.handle([{
            "type": "SCALPER_RUNTIME_SNAPSHOT",
            "strategy_session_id": "scalper-1",
            "sub_account_id": "sub-1",
            "strategy_type": "SCALPER",
            "checkpoint_seq": "2",
            "checkpoint_reason": "HEARTBEAT",
            "status": "ACTIVE",
            "source_ts": "1709000005000",
            "snapshot_json": json.dumps({**snapshot, "lastKnownPrice": 101.0}),
        }])

        runtime_session = await db.fetch_one(
            "SELECT * FROM algo_runtime_sessions WHERE strategy_session_id = ?",
            ("scalper-1",),
        )
        checkpoints = await db.fetch_all(
            "SELECT * FROM algo_runtime_checkpoints WHERE strategy_session_id = ? ORDER BY checkpoint_seq",
            ("scalper-1",),
        )
        strategy_session = await db.fetch_one(
            "SELECT * FROM strategy_sessions WHERE id = ?",
            ("scalper-1",),
        )

        assert runtime_session is not None
        assert runtime_session["status"] == "ACTIVE"
        assert runtime_session["latest_checkpoint_id"] == "scalper-1:2"
        assert runtime_session["last_heartbeat_at"] is not None
        assert len(checkpoints) == 2
        assert strategy_session is not None
        assert strategy_session["session_role"] == "ROOT"
        assert strategy_session["root_strategy_session_id"] == "scalper-1"

        await db.close()

    asyncio.run(run())


def test_scalper_runtime_collector_corrects_existing_root_session_type():
    async def run():
        db = MemoryDB()
        await db.connect()
        collector = ScalperRuntimeCollector(db)

        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("scalper-1", "sub-1", "CHASE", "CHASE", "scalper-1", "ROOT", "BTCUSDT", "LONG", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )

        snapshot = {
            "scalperId": "scalper-1",
            "subAccountId": "sub-1",
            "symbol": "BTCUSDT",
            "startSide": "LONG",
            "childCount": 2,
            "neutralMode": False,
            "allowLoss": True,
            "reduceOnlyArmed": False,
            "startedAt": 1709000000000,
            "status": "ACTIVE",
            "totalFillCount": 1,
            "longSlots": [],
            "shortSlots": [],
        }
        await collector.handle([{
            "type": "SCALPER_RUNTIME_SNAPSHOT",
            "strategy_session_id": "scalper-1",
            "sub_account_id": "sub-1",
            "strategy_type": "SCALPER",
            "checkpoint_seq": "3",
            "checkpoint_reason": "HEARTBEAT",
            "status": "ACTIVE",
            "source_ts": "1709000005000",
            "snapshot_json": json.dumps(snapshot),
        }])

        strategy_session = await db.fetch_one(
            "SELECT * FROM strategy_sessions WHERE id = ?",
            ("scalper-1",),
        )

        assert strategy_session is not None
        assert strategy_session["origin"] == "SCALPER"
        assert strategy_session["strategy_type"] == "SCALPER"
        assert strategy_session["session_role"] == "ROOT"
        assert strategy_session["root_strategy_session_id"] == "scalper-1"

        await db.close()

    asyncio.run(run())


def test_strategy_lot_ledger_worker_builds_fifo_realizations_and_anomalies():
    async def run():
        db = MemoryDB()
        await db.connect()

        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("scalper-1", "sub-1", "SCALPER", "SCALPER", "scalper-1", "ROOT", "BTCUSDT", "LONG", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key, ownership_confidence,
                origin_path, strategy_type, strategy_session_id, parent_strategy_session_id, root_strategy_session_id,
                parent_id, client_order_id, exchange_order_id, symbol, side, order_type, order_role, reduce_only,
                requested_qty, intent_ts, final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("lifecycle-entry", "SUB_ACCOUNT", "sub-1", "BINANCE_FUTURES", "binance:futures:main", "HARD", "PYTHON_CMD",
             "CHASE", "chase-1", "scalper-1", "scalper-1", "chase-1", "coid-entry", "ex-entry", "BTCUSDT", "BUY", "LIMIT", "ADD", 0,
             2.0, "2026-03-05 10:00:00", "FILLED", 2.0, 100.0, 0, "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key, ownership_confidence,
                origin_path, strategy_type, strategy_session_id, parent_strategy_session_id, root_strategy_session_id,
                parent_id, client_order_id, exchange_order_id, symbol, side, order_type, order_role, reduce_only,
                requested_qty, intent_ts, final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("lifecycle-close", "SUB_ACCOUNT", "sub-1", "BINANCE_FUTURES", "binance:futures:main", "HARD", "PYTHON_CMD",
             "CHASE", "chase-1", "scalper-1", "scalper-1", "chase-1", "coid-close", "ex-close", "BTCUSDT", "SELL", "LIMIT", "UNWIND", 1,
             3.0, "2026-03-05 10:01:00", "FILLED", 3.0, 110.0, 0, "2026-03-05 10:01:00", "2026-03-05 10:01:00"),
        )
        await db.execute(
            """INSERT INTO fill_facts
               (id, lifecycle_id, sub_account_id, source_event_id, execution_scope, ownership_confidence,
                symbol, side, fill_ts, fill_qty, fill_price, fee, origin_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("fill-entry", "lifecycle-entry", "sub-1", "evt-entry", "SUB_ACCOUNT", "HARD", "BTCUSDT", "BUY",
             "2026-03-05 10:00:00", 2.0, 100.0, 1.0, "SCALPER", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO fill_facts
               (id, lifecycle_id, sub_account_id, source_event_id, execution_scope, ownership_confidence,
                symbol, side, fill_ts, fill_qty, fill_price, fee, origin_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("fill-close", "lifecycle-close", "sub-1", "evt-close", "SUB_ACCOUNT", "HARD", "BTCUSDT", "SELL",
             "2026-03-05 10:01:00", 3.0, 110.0, 0.6, "SCALPER", "2026-03-05 10:01:00"),
        )

        worker = StrategyLotLedgerWorker(db)
        summary = await worker.rebuild_once()

        lots = await db.fetch_all("SELECT * FROM strategy_position_lots")
        realizations = await db.fetch_all("SELECT * FROM strategy_lot_realizations")
        anomalies = await db.fetch_all("SELECT * FROM tca_anomalies WHERE anomaly_type = 'SESSION_PNL'")
        cursor = await db.fetch_one("SELECT * FROM tca_worker_cursors WHERE worker_key = ?", ("strategy_lot_ledger",))

        assert summary["lot_count"] == 1
        assert summary["realization_count"] == 1
        assert summary["anomaly_count"] == 1
        assert len(lots) == 1
        assert lots[0]["id"] == "lot:fill-entry"
        assert lots[0]["remaining_qty"] == 0.0
        assert lots[0]["status"] == "CLOSED"
        assert len(realizations) == 1
        assert realizations[0]["id"] == "realization:fill-close:lot:fill-entry"
        assert realizations[0]["allocated_qty"] == 2.0
        assert realizations[0]["net_realized_pnl"] > 0
        assert len(anomalies) == 1
        assert anomalies[0]["anomaly_key"] == "UNMATCHED_CLOSE_QTY:fill-close"
        assert anomalies[0]["status"] == "OPEN"
        assert cursor is not None

        await db.close()

    asyncio.run(run())


def test_strategy_lot_ledger_worker_resolves_session_anomalies_without_rewriting_history():
    async def run():
        db = MemoryDB()
        await db.connect()

        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("scalper-1", "sub-1", "SCALPER", "SCALPER", "scalper-1", "ROOT", "BTCUSDT", "LONG", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key, ownership_confidence,
                origin_path, strategy_type, strategy_session_id, parent_strategy_session_id, root_strategy_session_id,
                parent_id, client_order_id, exchange_order_id, symbol, side, order_type, order_role, reduce_only,
                requested_qty, intent_ts, final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("lifecycle-entry", "SUB_ACCOUNT", "sub-1", "BINANCE_FUTURES", "binance:futures:main", "HARD", "PYTHON_CMD",
             "CHASE", "chase-1", "scalper-1", "scalper-1", "chase-1", "coid-entry", "ex-entry", "BTCUSDT", "BUY", "LIMIT", "ADD", 0,
             2.0, "2026-03-05 10:00:00", "FILLED", 2.0, 100.0, 0, "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key, ownership_confidence,
                origin_path, strategy_type, strategy_session_id, parent_strategy_session_id, root_strategy_session_id,
                parent_id, client_order_id, exchange_order_id, symbol, side, order_type, order_role, reduce_only,
                requested_qty, intent_ts, final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("lifecycle-close", "SUB_ACCOUNT", "sub-1", "BINANCE_FUTURES", "binance:futures:main", "HARD", "PYTHON_CMD",
             "CHASE", "chase-1", "scalper-1", "scalper-1", "chase-1", "coid-close", "ex-close", "BTCUSDT", "SELL", "LIMIT", "UNWIND", 1,
             3.0, "2026-03-05 10:01:00", "FILLED", 3.0, 110.0, 0, "2026-03-05 10:01:00", "2026-03-05 10:01:00"),
        )
        await db.execute(
            """INSERT INTO fill_facts
               (id, lifecycle_id, sub_account_id, source_event_id, execution_scope, ownership_confidence,
                symbol, side, fill_ts, fill_qty, fill_price, fee, origin_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("fill-entry", "lifecycle-entry", "sub-1", "evt-entry", "SUB_ACCOUNT", "HARD", "BTCUSDT", "BUY",
             "2026-03-05 10:00:00", 2.0, 100.0, 1.0, "SCALPER", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO fill_facts
               (id, lifecycle_id, sub_account_id, source_event_id, execution_scope, ownership_confidence,
                symbol, side, fill_ts, fill_qty, fill_price, fee, origin_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("fill-close", "lifecycle-close", "sub-1", "evt-close", "SUB_ACCOUNT", "HARD", "BTCUSDT", "SELL",
             "2026-03-05 10:01:00", 3.0, 110.0, 0.6, "SCALPER", "2026-03-05 10:01:00"),
        )

        worker = StrategyLotLedgerWorker(db)
        first = await worker.rebuild_once()
        anomalies_first = await db.fetch_all(
            "SELECT * FROM tca_anomalies WHERE anomaly_type = ? ORDER BY anomaly_key",
            ("SESSION_PNL",),
        )
        first_seen_at = anomalies_first[0]["first_seen_at"]

        await db.execute(
            "UPDATE fill_facts SET fill_qty = ? WHERE id = ?",
            (2.0, "fill-close"),
        )
        await db.execute(
            "UPDATE order_lifecycles SET updated_at = ? WHERE id = ?",
            ("2026-03-05 10:02:00", "lifecycle-close"),
        )

        second = await worker.rebuild_once()
        anomalies_second = await db.fetch_all(
            "SELECT * FROM tca_anomalies WHERE anomaly_type = ? ORDER BY anomaly_key",
            ("SESSION_PNL",),
        )
        lots = await db.fetch_all("SELECT * FROM strategy_position_lots ORDER BY id")
        realizations = await db.fetch_all("SELECT * FROM strategy_lot_realizations ORDER BY id")

        assert first["anomaly_count"] == 1
        assert second["anomaly_count"] == 0
        assert len(anomalies_second) == 1
        assert anomalies_second[0]["anomaly_key"] == "UNMATCHED_CLOSE_QTY:fill-close"
        assert anomalies_second[0]["status"] == "RESOLVED"
        assert anomalies_second[0]["first_seen_at"] == first_seen_at
        assert anomalies_second[0]["resolved_at"] is not None
        assert [row["id"] for row in lots] == ["lot:fill-entry"]
        assert [row["id"] for row in realizations] == ["realization:fill-close:lot:fill-entry"]

        await db.close()

    asyncio.run(run())


def test_strategy_session_sampler_writes_pnl_and_param_samples():
    async def run():
        db = MemoryDB()
        await db.connect()
        market_data = FakeMarketData()
        market_data.set_l1("BTCUSDT", bid=101.0, ask=103.0, mid=102.0, ts=1709000040.0)

        await db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("scalper-1", "sub-1", "SCALPER", "SCALPER", "scalper-1", "ROOT", "BTCUSDT", "LONG", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO algo_runtime_sessions
               (strategy_session_id, sub_account_id, strategy_type, status, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("scalper-1", "sub-1", "SCALPER", "ACTIVE", "2026-03-05 10:00:00", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        snapshot = {
            "symbol": "BTCUSDT",
            "startSide": "LONG",
            "status": "ACTIVE",
            "neutralMode": False,
            "allowLoss": True,
            "reduceOnlyArmed": False,
            "leverage": 2,
            "childCount": 2,
            "skew": 0,
            "longOffsetPct": 0.2,
            "shortOffsetPct": 0.25,
            "longSizeUsd": 50.0,
            "shortSizeUsd": 55.0,
            "minFillSpreadPct": 0.1,
            "fillDecayHalfLifeMs": 30000,
            "minRefillDelayMs": 1000,
            "maxLossPerCloseBps": 50,
            "maxFillsPerMinute": 4,
            "pnlFeedbackMode": "off",
            "lastKnownPrice": 101.0,
            "totalFillCount": 3,
            "longSlots": [{"active": True, "paused": False}],
            "shortSlots": [{"active": False, "paused": True, "pauseReason": "price_filter", "retryAt": 1709000010000}],
        }
        await db.execute(
            """INSERT INTO algo_runtime_checkpoints
               (id, strategy_session_id, sub_account_id, strategy_type, checkpoint_seq, checkpoint_ts,
                checkpoint_reason, status, snapshot_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("scalper-1:1", "scalper-1", "sub-1", "SCALPER", 1, "2026-03-05 10:00:05", "HEARTBEAT", "ACTIVE", json.dumps(snapshot), "2026-03-05 10:00:05"),
        )
        await db.execute(
            """INSERT INTO strategy_position_lots
               (id, sub_account_id, root_strategy_session_id, source_strategy_session_id, symbol, position_side,
                opened_ts, open_qty, remaining_qty, open_price, open_fee, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("lot-1", "sub-1", "scalper-1", "chase-1", "BTCUSDT", "LONG", "2026-03-05 10:00:00", 2.0, 1.0, 100.0, 0.5, "OPEN", "2026-03-05 10:00:00", "2026-03-05 10:00:00"),
        )
        await db.execute(
            """INSERT INTO strategy_lot_realizations
               (id, lot_id, sub_account_id, root_strategy_session_id, source_strategy_session_id, close_fill_fact_id,
                realized_ts, allocated_qty, open_price, close_price, gross_realized_pnl, open_fee_allocated,
                close_fee_allocated, net_realized_pnl, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("real-1", "lot-1", "sub-1", "scalper-1", "chase-1", "fill-close", "2026-03-05 10:01:00", 1.0, 100.0, 110.0, 10.0, 0.25, 0.25, 9.5, "2026-03-05 10:01:00"),
        )
        await db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key, ownership_confidence,
                origin_path, strategy_type, strategy_session_id, parent_strategy_session_id, root_strategy_session_id,
                parent_id, client_order_id, exchange_order_id, symbol, side, order_type, order_role, reduce_only,
                requested_qty, intent_ts, final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("lifecycle-close", "SUB_ACCOUNT", "sub-1", "BINANCE_FUTURES", "binance:futures:main", "HARD", "PYTHON_CMD",
             "CHASE", "chase-1", "scalper-1", "scalper-1", "chase-1", "coid-close", "ex-close", "BTCUSDT", "SELL", "LIMIT", "UNWIND", 1,
             1.0, "2026-03-05 10:01:00", "FILLED", 1.0, 110.0, 0, "2026-03-05 10:01:00", "2026-03-05 10:01:00"),
        )
        await db.execute(
            """INSERT INTO fill_facts
               (id, lifecycle_id, sub_account_id, source_event_id, execution_scope, ownership_confidence,
                symbol, side, fill_ts, fill_qty, fill_price, fee, origin_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("fill-close", "lifecycle-close", "sub-1", "evt-close", "SUB_ACCOUNT", "HARD", "BTCUSDT", "SELL",
             "2026-03-05 10:01:00", 1.0, 110.0, 0.25, "SCALPER", "2026-03-05 10:01:00"),
        )

        sampler = StrategySessionSampler(db, market_data)
        summary = await sampler.sample_once()

        pnl_samples = await db.fetch_all("SELECT * FROM strategy_session_pnl_samples")
        param_samples = await db.fetch_all("SELECT * FROM strategy_session_param_samples")

        assert summary["pnl_samples"] == 1
        assert summary["param_samples"] == 1
        assert len(pnl_samples) == 1
        assert pnl_samples[0]["net_pnl"] > 0
        assert pnl_samples[0]["close_count"] == 1
        assert len(param_samples) == 1
        assert param_samples[0]["long_active_slots"] == 1
        assert param_samples[0]["short_paused_slots"] == 1
        assert '"price_filter": 1' in param_samples[0]["pause_reasons_json"]

        await db.close()

    asyncio.run(run())

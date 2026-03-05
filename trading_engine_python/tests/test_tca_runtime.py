import asyncio
import logging

from trading_engine_python.events.lifecycle_store import LifecycleStore
from trading_engine_python.tca.collector import TCACollector
from trading_engine_python.tca.market_sampler import TCAMarketSampler
from trading_engine_python.tca.quote_store import MarketQuoteStore
from trading_engine_python.tca.reconciler import TCAReconciler
from trading_engine_python.tca.rollups import TCARollupWorker
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
        assert summary["strategy_rollups"] == 1
        assert len(sub_rollups) == 1
        assert len(strategy_rollups) == 1

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

        strategy = strategy_rollups[0]
        assert strategy["strategy_session_id"] == parent_id
        assert strategy["strategy_type"] == "TWAP"
        assert strategy["sub_account_id"] == "sub-1"
        assert strategy["execution_scope"] == "SUB_ACCOUNT"
        assert strategy["ownership_confidence"] == "HARD"

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
    assert messages[0].endswith("2 sub-account rollup(s) and 238 strategy rollup(s)")
    assert messages[1].endswith("2 sub-account rollup(s) and 238 strategy rollup(s)")

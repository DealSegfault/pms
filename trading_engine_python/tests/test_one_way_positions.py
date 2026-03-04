import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from trading_engine_python.risk.engine import RiskEngine
from trading_engine_python.risk.position_book import PositionBook, VirtualPos
from trading_engine_python.risk.validator import TradeValidator


def _account_book() -> PositionBook:
    book = PositionBook()
    book.load({
        "s1": {
            "account": {
                "id": "s1",
                "name": "test",
                "currentBalance": 1000.0,
                "maintenanceRate": 0.005,
                "status": "ACTIVE",
            },
            "positions": [],
            "rules": None,
        }
    })
    return book


def _multi_account_book() -> PositionBook:
    book = PositionBook()
    book.load({
        "a1": {
            "account": {"id": "a1", "name": "A", "currentBalance": 1000.0, "maintenanceRate": 0.005, "status": "ACTIVE"},
            "positions": [],
            "rules": None,
        },
        "b1": {
            "account": {"id": "b1", "name": "B", "currentBalance": 1000.0, "maintenanceRate": 0.005, "status": "ACTIVE"},
            "positions": [],
            "rules": None,
        },
        "c1": {
            "account": {"id": "c1", "name": "C", "currentBalance": 1000.0, "maintenanceRate": 0.005, "status": "ACTIVE"},
            "positions": [],
            "rules": None,
        },
    })
    return book


class _RecordingDB:
    def __init__(self, balances=None):
        self.balances = dict(balances or {})
        self.executed = []

    async def execute(self, sql, params=()):
        self.executed.append((sql, params))
        if "UPDATE sub_accounts SET current_balance" in sql:
            self.balances[params[2]] = params[0]
        return 1

    async def fetch_one(self, sql, params=()):
        if "SELECT current_balance FROM sub_accounts" in sql:
            return {"current_balance": self.balances.get(params[0], 0.0)}
        return None


class _RecordingRedis:
    def __init__(self):
        self.set_calls = []

    async def set(self, key, value, ex=None):
        self.set_calls.append((key, value, ex))
        return True


def test_risk_engine_keeps_single_net_position_on_flip():
    async def run():
        book = _account_book()
        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=None,
        )

        short_open = SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="SELL",
            filled_qty=1.0,
            avg_fill_price=100.0,
            leverage=10,
            reduce_only=False,
        )
        await engine.on_order_fill(short_open)

        flip_buy = SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            filled_qty=1.5,
            avg_fill_price=90.0,
            leverage=10,
            reduce_only=False,
        )
        await engine.on_order_fill(flip_buy)

        positions = book.get_by_sub_account("s1")
        assert len(positions) == 1
        pos = positions[0]
        assert pos.side == "LONG"
        assert pos.quantity == pytest.approx(0.5)

    asyncio.run(run())


def test_position_book_rejects_two_open_positions_for_same_symbol():
    book = _account_book()
    first = VirtualPos(
        id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
        entry_price=100.0, quantity=1.0, notional=100.0, leverage=10, margin=10.0,
    )
    second = VirtualPos(
        id="p2", sub_account_id="s1", symbol="BTCUSDT", side="SHORT",
        entry_price=100.0, quantity=1.0, notional=100.0, leverage=10, margin=10.0,
    )

    book.add(first, {"currentBalance": 1000.0})
    with pytest.raises(RuntimeError):
        book.add(second, {"currentBalance": 1000.0})


def test_risk_snapshot_uses_rule_leverage_cap_for_available_margin():
    book = PositionBook()
    book.load({
        "s1": {
            "account": {
                "id": "s1",
                "name": "test",
                "currentBalance": 100.0,
                "maintenanceRate": 0.005,
                "status": "ACTIVE",
            },
            "positions": [],
            "rules": {
                "max_leverage": 100,
                "max_notional_per_trade": 10000,
                "max_total_exposure": 10000,
                "liquidation_threshold": 0.90,
            },
        }
    })
    book.add(
        VirtualPos(
            id="p1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="LONG",
            entry_price=100.0,
            quantity=5.0,
            notional=500.0,
            leverage=3,
            margin=166.6667,
            mark_price=104.0,
            unrealized_pnl=20.0,
        ),
        {"currentBalance": 100.0},
    )

    engine = RiskEngine(book, market_data=None, exchange_client=None, redis_client=None, db=None)
    snap = engine.get_account_snapshot("s1")

    assert snap["equity"] == pytest.approx(120.0)
    assert snap["marginUsed"] == pytest.approx(5.0)
    assert snap["availableMargin"] == pytest.approx(115.0)


def test_validator_uses_rule_leverage_cap_for_existing_exposure():
    async def run():
        book = PositionBook()
        book.load({
            "s1": {
                "account": {
                    "id": "s1",
                    "name": "test",
                    "currentBalance": 100.0,
                    "maintenanceRate": 0.005,
                    "status": "ACTIVE",
                },
                "positions": [],
                "rules": {
                    "max_leverage": 100,
                    "max_notional_per_trade": 10000,
                    "max_total_exposure": 10000,
                    "liquidation_threshold": 0.90,
                },
            }
        })
        book.add(
            VirtualPos(
                id="p1",
                sub_account_id="s1",
                symbol="BTCUSDT",
                side="LONG",
                entry_price=100.0,
                quantity=4.0,
                notional=400.0,
                leverage=2,
                margin=200.0,
            ),
            {"currentBalance": 100.0},
        )

        market_data = SimpleNamespace(get_l1=lambda symbol: {"mid": 100.0})
        validator = TradeValidator(book, market_data)
        result = await validator.validate("s1", "ETHUSDT", "LONG", 1.0, 100)

        assert result["valid"] is True
        assert result["computed_values"]["equity"] == pytest.approx(100.0)
        assert result["computed_values"]["available_margin"] == pytest.approx(95.0)
        assert result["computed_values"]["required_margin"] == pytest.approx(1.0)
        assert result["computed_values"]["margin_usage_ratio"] == pytest.approx(0.05)

    asyncio.run(run())


def test_account_update_ignores_manual_exchange_activity_without_pms_evidence():
    async def run():
        book = _account_book()
        pos = VirtualPos(
            id="p1", sub_account_id="s1", symbol="BTC/USDT:USDT", side="LONG",
            entry_price=100.0, quantity=1.0, notional=100.0, leverage=10, margin=10.0,
        )
        book.add(pos, {"currentBalance": 1000.0})

        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=None,
        )
        engine.set_managed_accounts({"s1"})
        engine.set_order_manager(SimpleNamespace(get_active_orders=lambda symbol=None, sub_account_id=None: []))

        await engine.on_account_update({
            "positions": [{
                "symbol": "BTCUSDT",
                "position_amount": 2.0,
                "entry_price": 120.0,
            }]
        })

        current = book.find_symbol_position("s1", "BTCUSDT")
        assert current is not None
        assert current.quantity == pytest.approx(1.0)
        assert current.entry_price == pytest.approx(100.0)

    asyncio.run(run())


def test_account_update_reconciles_with_active_pms_order_evidence():
    async def run():
        book = _account_book()
        pos = VirtualPos(
            id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
            entry_price=100.0, quantity=1.0, notional=100.0, leverage=10, margin=10.0,
        )
        book.add(pos, {"currentBalance": 1000.0})

        active_order = SimpleNamespace(sub_account_id="s1")
        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=None,
        )
        engine.set_managed_accounts({"s1"})
        engine.set_order_manager(
            SimpleNamespace(get_active_orders=lambda symbol=None, sub_account_id=None: [active_order])
        )

        await engine.on_account_update({
            "positions": [{
                "symbol": "BTCUSDT",
                "position_amount": 2.0,
                "entry_price": 120.0,
            }]
        })

        current = book.find_symbol_position("s1", "BTCUSDT")
        assert current is not None
        assert current.quantity == pytest.approx(2.0)
        assert current.entry_price == pytest.approx(120.0)

    asyncio.run(run())


def test_account_update_proportionally_adls_virtual_positions_when_exchange_backing_drops():
    async def run():
        book = _multi_account_book()
        positions = [
            VirtualPos(id="pa", sub_account_id="a1", symbol="BTCUSDT", side="LONG", entry_price=1.0, quantity=100.0, notional=100.0, leverage=10, margin=10.0),
            VirtualPos(id="pb", sub_account_id="b1", symbol="BTCUSDT", side="LONG", entry_price=1.0, quantity=50.0, notional=50.0, leverage=10, margin=5.0),
            VirtualPos(id="pc", sub_account_id="c1", symbol="BTCUSDT", side="LONG", entry_price=1.0, quantity=200.0, notional=200.0, leverage=10, margin=20.0),
        ]
        for pos in positions:
            book.add(pos, {"currentBalance": 1000.0})

        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=None,
        )
        engine.set_managed_accounts({"a1", "b1", "c1"})
        engine.set_order_manager(SimpleNamespace(get_active_orders=lambda symbol=None, sub_account_id=None: []))

        await engine.on_account_update({
            "positions": [{
                "symbol": "BTCUSDT",
                "position_amount": 250.0,
                "entry_price": 1.0,
            }]
        })

        assert book.find_symbol_position("a1", "BTCUSDT").quantity == pytest.approx(70.0)
        assert book.find_symbol_position("b1", "BTCUSDT").quantity == pytest.approx(35.0)
        assert book.find_symbol_position("c1", "BTCUSDT").quantity == pytest.approx(145.0)

    asyncio.run(run())


def test_handle_close_rehydrates_missing_position_from_snapshot():
    async def run():
        book = _account_book()

        class _Redis:
            async def get(self, key):
                return (
                    '{"balance": 1000.0, "positions": ['
                    '{"id": "p1", "symbol": "BTCUSDT", "side": "SHORT", '
                    '"entryPrice": 100.0, "quantity": 2.0, "notional": 200.0, '
                    '"margin": 20.0, "leverage": 10, "liquidationPrice": 150.0, '
                    '"markPrice": 101.0, "unrealizedPnl": -2.0}'
                    ']}'
                )

        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=_Redis(),
            db=None,
        )

        class _OM:
            def __init__(self):
                self.called_with = None

            async def close_virtual_position(self, position, **kwargs):
                self.called_with = position
                return {
                    "placed": True,
                    "order": SimpleNamespace(client_order_id="coid", state="placing"),
                }

        om = _OM()
        engine.set_order_manager(om)

        from trading_engine_python.commands.handler import CommandHandler

        handler = CommandHandler(redis_client=None, order_manager=om, risk_engine=engine)
        result = await handler.handle_close({
            "subAccountId": "s1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "quantity": 2.0,
            "positionId": "p1",
        })

        assert result["success"] is True
        assert om.called_with is not None
        assert om.called_with.id == "p1"
        assert om.called_with.side == "SHORT"
        assert book.get_position("s1", "p1") is not None

    asyncio.run(run())


def test_external_backing_adl_persists_trade_execution_as_adl():
    async def run():
        book = _account_book()
        pos = VirtualPos(
            id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
            entry_price=1.0, quantity=20.0, notional=20.0, leverage=10, margin=2.0,
        )
        book.add(pos, {"currentBalance": 1000.0})
        db = _RecordingDB({"s1": 1000.0})

        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=db,
        )
        engine.set_managed_accounts({"s1"})
        engine.set_order_manager(SimpleNamespace(get_active_orders=lambda symbol=None, sub_account_id=None: []))

        await engine.on_account_update({
            "positions": [{
                "symbol": "BTCUSDT",
                "position_amount": 10.0,
                "entry_price": 1.0,
            }]
        })

        trade_insert = next(sql_params for sql_params in db.executed if "INSERT INTO trade_executions" in sql_params[0])
        params = trade_insert[1]
        assert params[12] == "ADL"
        assert params[13] == "EXCHANGE_ADL"

    asyncio.run(run())


def test_external_backing_adl_marks_position_event_for_ws_notification():
    async def run():
        book = _account_book()
        pos = VirtualPos(
            id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
            entry_price=1.0, quantity=20.0, notional=20.0, leverage=10, margin=2.0,
        )
        book.add(pos, {"currentBalance": 1000.0})

        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=None,
        )
        engine.set_managed_accounts({"s1"})
        engine.set_order_manager(SimpleNamespace(get_active_orders=lambda symbol=None, sub_account_id=None: []))

        published = []

        async def _capture(event_type, payload):
            published.append((event_type, payload))

        engine._publish_event = _capture

        await engine.on_account_update({
            "positions": [{
                "symbol": "BTCUSDT",
                "position_amount": 10.0,
                "entry_price": 1.0,
            }]
        })

        reduced = next(payload for event_type, payload in published if event_type == "position_reduced")
        assert reduced["originType"] == "EXCHANGE_ADL"
        assert reduced["reason"] == "BACKING_SHORTAGE"

    asyncio.run(run())


def test_risk_engine_db_persistence_uses_datetime_timestamps():
    async def run():
        book = _account_book()
        db = _RecordingDB({"s1": 1000.0})
        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=None,
            db=db,
        )

        await engine.on_order_fill(SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            filled_qty=2.0,
            avg_fill_price=100.0,
            leverage=5,
            reduce_only=False,
            origin="MANUAL",
        ))
        await engine.on_order_fill(SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            filled_qty=1.0,
            avg_fill_price=110.0,
            leverage=5,
            reduce_only=False,
            origin="MANUAL",
        ))
        await engine.on_order_fill(SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="SELL",
            filled_qty=1.0,
            avg_fill_price=120.0,
            leverage=5,
            reduce_only=False,
            origin="MANUAL",
        ))
        await engine.on_order_fill(SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="SELL",
            filled_qty=2.0,
            avg_fill_price=130.0,
            leverage=5,
            reduce_only=False,
            origin="MANUAL",
        ))

        trade_inserts = 0
        balance_inserts = 0
        for sql, params in db.executed:
            if "INSERT INTO virtual_positions" in sql:
                assert isinstance(params[-1], datetime)
            elif "INSERT INTO trade_executions" in sql:
                trade_inserts += 1
                assert isinstance(params[-1], datetime)
            elif "UPDATE virtual_positions SET status = 'CLOSED'" in sql:
                assert isinstance(params[1], datetime)
            elif "UPDATE sub_accounts SET current_balance" in sql:
                assert isinstance(params[1], datetime)
            elif "INSERT INTO balance_logs" in sql:
                balance_inserts += 1
                assert isinstance(params[-1], datetime)

        assert trade_inserts == 4
        assert balance_inserts == 2

    asyncio.run(run())


def test_on_order_fill_refreshes_risk_snapshot_and_add_publish_updates():
    async def run():
        book = _account_book()
        redis = _RecordingRedis()
        engine = RiskEngine(
            position_book=book,
            market_data=None,
            exchange_client=None,
            redis_client=redis,
            db=None,
        )

        published = []

        async def _capture(event_type, payload):
            published.append((event_type, payload))

        engine._publish_event = _capture

        first_fill = SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            filled_qty=1.0,
            avg_fill_price=100.0,
            leverage=5,
            reduce_only=False,
            origin="MANUAL",
        )
        await engine.on_order_fill(first_fill)

        second_fill = SimpleNamespace(
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            filled_qty=0.5,
            avg_fill_price=110.0,
            leverage=5,
            reduce_only=False,
            origin="MANUAL",
        )
        await engine.on_order_fill(second_fill)

        assert len(redis.set_calls) >= 2
        assert redis.set_calls[0][0] == "pms:risk:s1"
        assert redis.set_calls[-1][0] == "pms:risk:s1"

        position_updates = [payload for event_type, payload in published if event_type == "position_updated"]
        assert len(position_updates) >= 2
        latest = position_updates[-1]
        assert latest["symbol"] == "BTCUSDT"
        assert latest["quantity"] == pytest.approx(1.5)
        assert latest["entryPrice"] == pytest.approx((100.0 + (110.0 * 0.5)) / 1.5)

        margin_updates = [payload for event_type, payload in published if event_type == "margin_update"]
        assert margin_updates
        assert margin_updates[-1]["positions"][0]["quantity"] == pytest.approx(1.5)

    asyncio.run(run())

import asyncio
from unittest.mock import AsyncMock, MagicMock

from trading_engine_python.feeds.symbol_info import SymbolInfoCache, SymbolSpec
from trading_engine_python.orders.manager import OrderManager
from trading_engine_python.risk.position_book import VirtualPos


def _symbol_info() -> SymbolInfoCache:
    cache = SymbolInfoCache()
    cache._specs["BTCUSDT"] = SymbolSpec(
        symbol="BTCUSDT",
        market_step_size=0.001,
        min_qty=0.001,
        max_qty=9999999.0,
        min_notional=5.0,
        market_qty_precision=3,
    )
    return cache


def test_close_virtual_position_clamps_to_exchange_qty_without_hedge_position_side():
    async def run():
        exchange = MagicMock()
        exchange.create_market_order = AsyncMock(return_value={"orderId": "123"})
        exchange.get_position_risk = AsyncMock(return_value=[{
            "symbol": "BTCUSDT",
            "positionAmt": "0.0034",
            "positionSide": "LONG",
            "markPrice": "65000",
        }])

        om = OrderManager(exchange_client=exchange, symbol_info=_symbol_info())
        pos = VirtualPos(
            id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
            entry_price=65000, quantity=0.01, notional=650, leverage=10, margin=65,
        )

        result = await om.close_virtual_position(pos, requested_qty=0.005, origin="MANUAL")
        assert result["placed"] is True
        assert result["reason"] == "PLACED"
        assert result["close_qty"] == 0.003

        args = exchange.create_market_order.await_args.args
        kwargs = exchange.create_market_order.await_args.kwargs
        assert args == ("BTCUSDT", "SELL", 0.003)
        assert kwargs["reduceOnly"] == "true"
        assert "positionSide" not in kwargs

    asyncio.run(run())


def test_close_virtual_position_cleans_up_full_dust_position():
    async def run():
        exchange = MagicMock()
        exchange.create_market_order = AsyncMock(return_value={"orderId": "123"})
        exchange.get_position_risk = AsyncMock(return_value=[{
            "symbol": "BTCUSDT",
            "positionAmt": "0.0004",
            "positionSide": "LONG",
            "markPrice": "65000",
        }])

        risk = MagicMock()
        risk.force_close_stale_position = AsyncMock()

        om = OrderManager(
            exchange_client=exchange,
            symbol_info=_symbol_info(),
            risk_engine=risk,
        )
        pos = VirtualPos(
            id="p2", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
            entry_price=65000, quantity=0.0004, notional=26, leverage=10, margin=2.6,
        )

        result = await om.close_virtual_position(
            pos,
            requested_qty=pos.quantity,
            origin="MANUAL",
            cleanup_if_unexecutable=True,
        )
        assert result["placed"] is False
        assert result["cleaned_up"] is True
        assert result["reason"] == "BELOW_MIN_QTY"
        exchange.create_market_order.assert_not_awaited()
        risk.force_close_stale_position.assert_awaited_once_with(pos)

    asyncio.run(run())


def test_close_virtual_position_does_not_cleanup_when_exchange_lookup_fails():
    async def run():
        exchange = MagicMock()
        exchange.create_market_order = AsyncMock(return_value={"orderId": "123"})
        exchange.get_position_risk = AsyncMock(side_effect=RuntimeError("boom"))

        risk = MagicMock()
        risk.force_close_stale_position = AsyncMock()

        om = OrderManager(
            exchange_client=exchange,
            symbol_info=_symbol_info(),
            risk_engine=risk,
        )
        pos = VirtualPos(
            id="p3", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
            entry_price=65000, quantity=0.01, notional=650, leverage=10, margin=65,
        )

        result = await om.close_virtual_position(
            pos,
            requested_qty=pos.quantity,
            origin="MANUAL",
            cleanup_if_unexecutable=True,
        )
        assert result["placed"] is False
        assert result["cleaned_up"] is False
        assert result["reason"] == "EXCHANGE_LOOKUP_FAILED"
        exchange.create_market_order.assert_not_awaited()
        risk.force_close_stale_position.assert_not_awaited()

    asyncio.run(run())

import asyncio
from types import SimpleNamespace

import pytest

from trading_engine_python.algos.twap import TWAPEngine, TWAPValidationError


class _SymbolInfo:
    def __init__(self, min_notional: float = 6.0, min_qty: float = 0.001):
        self._min_notional = min_notional
        self._min_qty = min_qty

    def get_min_notional(self, _symbol: str) -> float:
        return self._min_notional

    def get_min_qty(self, _symbol: str) -> float:
        return self._min_qty


class _OrderManager:
    def __init__(self, symbol_info: _SymbolInfo):
        self._symbol_info = symbol_info

    async def place_market_order(self, **_kwargs):
        return SimpleNamespace(state="placing")


class _MarketData:
    def __init__(self, price: float = 100.0):
        self._price = price

    def get_mid_price(self, _symbol: str) -> float:
        return self._price

    def get_l1(self, _symbol: str):
        return {"mid": self._price}


def test_twap_single_rejects_lots_over_constraint():
    async def run():
        engine = TWAPEngine(
            _OrderManager(_SymbolInfo(min_notional=6.0, min_qty=0.001)),
            _MarketData(price=100.0),
            redis_client=None,
        )
        with pytest.raises(TWAPValidationError) as exc:
            await engine.start_twap({
                "subAccountId": "sub1",
                "symbol": "BTCUSDT",
                "side": "LONG",
                "totalSize": 100.0,
                "lots": 50,
                "durationMinutes": 120,
            })

        err = exc.value
        assert err.error_code == "VALIDATION_TWAP_LOTS_INVALID"
        assert err.error_details["symbol"] == "BTCUSDT"
        assert err.error_details["requestedLots"] == 50
        assert err.error_details["maxLots"] == 16
        assert err.error_details["minNotional"] == 6.0

    asyncio.run(run())


def test_twap_single_accepts_valid_lots_without_rewrite():
    async def run():
        engine = TWAPEngine(
            _OrderManager(_SymbolInfo(min_notional=6.0, min_qty=0.001)),
            _MarketData(price=100.0),
            redis_client=None,
        )
        twap_id = await engine.start_twap({
            "subAccountId": "sub1",
            "symbol": "BTCUSDT",
            "side": "SHORT",
            "totalSize": 120.0,
            "lots": 10,
            "durationMinutes": 60,
        })
        state = engine._active.get(twap_id)
        assert state is not None
        assert state.num_lots == 10
        await engine.cancel_twap(twap_id)

    asyncio.run(run())


def test_twap_basket_rejects_when_any_leg_exceeds_max_lots():
    async def run():
        engine = TWAPEngine(
            _OrderManager(_SymbolInfo(min_notional=6.0, min_qty=0.001)),
            _MarketData(price=100.0),
            redis_client=None,
        )
        with pytest.raises(TWAPValidationError) as exc:
            await engine.start_basket_twap({
                "subAccountId": "sub1",
                "basketName": "Stress Basket",
                "lots": 10,
                "durationMinutes": 60,
                "legs": [
                    {"symbol": "BTCUSDT", "side": "LONG", "sizeUsdt": 20.0},
                    {"symbol": "ETHUSDT", "side": "SHORT", "sizeUsdt": 40.0},
                ],
            })

        err = exc.value
        assert err.error_code == "VALIDATION_TWAP_BASKET_LOTS_INVALID"
        assert err.error_details["basketName"] == "Stress Basket"
        assert err.error_details["requestedLots"] == 10
        assert len(err.error_details["legs"]) == 2
        assert err.error_details["legs"][0]["requestedLots"] == 10

    asyncio.run(run())

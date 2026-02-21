from __future__ import annotations

from .models import SignalSnapshot, TpEvaluation, VirtualPosition
from .utils import clamp, opposite_direction, side_direction, valid_price


def position_pnl_bps(position: VirtualPosition, mark_price: float) -> float:
    if not valid_price(mark_price) or position.entry_price <= 0:
        return 0.0

    side = side_direction(position.side)
    if side == "SHORT":
        return ((position.entry_price - mark_price) / position.entry_price) * 10_000.0
    return ((mark_price - position.entry_price) / position.entry_price) * 10_000.0


class BaseTpModel:
    name = "base"

    def target_bps(self, position: VirtualPosition, signal: SignalSnapshot) -> float:
        return 10.0

    def evaluate(
        self,
        position: VirtualPosition,
        mark_price: float,
        signal: SignalSnapshot,
    ) -> TpEvaluation:
        target = self.target_bps(position, signal)
        pnl_bps = position_pnl_bps(position, mark_price)
        should_close = pnl_bps >= target
        reason = f"{self.name}_tp_hit" if should_close else "hold"
        return TpEvaluation(
            model=self.name,
            target_bps=target,
            pnl_bps=pnl_bps,
            should_close=should_close,
            reason=reason,
        )


class FastTpModel(BaseTpModel):
    name = "fast"

    def target_bps(self, position: VirtualPosition, signal: SignalSnapshot) -> float:
        side = side_direction(position.side)
        bias = signal.bias
        target = 6.0
        if bias == opposite_direction(side):
            target = 4.0
        elif bias == side:
            target = 8.0

        # In elevated volatility, ask a bit more on fast exits to avoid noise churn.
        target += min(4.0, signal.vol_bps_60s * 0.05)
        return clamp(target, 3.0, 16.0)


class VolTpModel(BaseTpModel):
    name = "vol"

    def target_bps(self, position: VirtualPosition, signal: SignalSnapshot) -> float:
        # Scale TP target with realized short-horizon volatility.
        target = max(8.0, signal.vol_bps_60s * 0.70)
        return clamp(target, 8.0, 45.0)


class LongShortTpModel(BaseTpModel):
    name = "long_short"

    def target_bps(self, position: VirtualPosition, signal: SignalSnapshot) -> float:
        side = side_direction(position.side)
        bias = signal.bias

        if bias == side:
            target = 18.0
        elif bias == opposite_direction(side):
            target = 7.0
        else:
            target = 12.0

        momentum = abs(signal.momentum_bps_30s)
        if momentum >= 60:
            target += 3.0 if bias == side else -2.0

        return clamp(target, 5.0, 30.0)


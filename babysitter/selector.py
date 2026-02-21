from __future__ import annotations

from .models import SignalSnapshot, VirtualPosition


class VolatilityModeSelector:
    """
    Select TP model from signal + volatility regime.

    Modes:
      - fast: quick exits in calm conditions
      - vol: wider target when volatility is elevated
      - long_short: directional TP using long/short signal bias
    """

    def __init__(
        self,
        directional_momentum_bps: float = 45.0,
        vol_threshold_bps: float = 35.0,
    ):
        self._directional_momentum_bps = directional_momentum_bps
        self._vol_threshold_bps = vol_threshold_bps

    def select(self, configured_mode: str, position: VirtualPosition, signal: SignalSnapshot) -> str:
        mode = str(configured_mode or "auto").lower().strip()

        if mode in {"fast", "vol", "long_short"}:
            return mode

        # Auto regime selection.
        abs_momentum = abs(signal.momentum_bps_30s)

        # In high volatility, prefer volatility-scaled exits unless trend is very strong.
        if (
            signal.vol_bps_60s >= self._vol_threshold_bps
            and abs_momentum < (self._directional_momentum_bps * 1.30)
        ):
            return "vol"
        if abs_momentum >= self._directional_momentum_bps:
            return "long_short"
        return "fast"

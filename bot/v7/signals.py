#!/usr/bin/env python3
"""
V7 MICROSTRUCTURE SIGNALS — Per-symbol signal computation.

Computes from aggTrade + L1 book:
  TI  = Trade Imbalance (rolling windows)
  QI  = Quote Imbalance (L1)
  MD  = MicroPrice Displacement
  Pump  = regime score (short-skew detection)
  Exhaust = flow exhaustion (entry trigger)
  rv  = realized volatility (for sizing)

Pure math, no I/O.
"""

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

from bot.v7.flow_metrics import SecondBucketFlow

# ═══════════════════════════════════════════════════════════════
# EMA-BASED Z-SCORE TRACKER
# ═══════════════════════════════════════════════════════════════

class EMAZScore:
    """Fast z-score using exponential moving average of mean and variance."""
    __slots__ = ('_mean', '_var', '_alpha', '_warm', '_z_cap')

    def __init__(self, halflife: float = 2.0, dt: float = 0.1, z_cap: float = 5.0):
        """
        halflife: in seconds
        dt: expected update interval in seconds
        z_cap: clamp absolute z-score to prevent quiet-regime amplification
        """
        self._alpha = 1.0 - math.exp(-dt * math.log(2) / halflife)
        self._mean = 0.0
        self._var = 1.0  # Start with unit variance to avoid div-by-zero
        self._warm = 0
        self._z_cap = max(float(z_cap), 1.0)

    def update(self, x: float) -> float:
        """Update with new value, return clamped z-score."""
        self._warm += 1
        self._mean += self._alpha * (x - self._mean)
        diff = x - self._mean
        self._var += self._alpha * (diff * diff - self._var)
        std = math.sqrt(max(self._var, 1e-20))
        z = diff / std if self._warm > 5 else 0.0
        return max(-self._z_cap, min(z, self._z_cap))

    @property
    def z(self) -> float:
        return 0.0  # Last z is computed by update()


# ═══════════════════════════════════════════════════════════════
# ROLLING WINDOW ACCUMULATOR
# ═══════════════════════════════════════════════════════════════

class RollingQty:
    """Rolling sum of buy/sell qty over a time window."""
    __slots__ = ('_window_sec', '_buys', '_sells', 'buy_sum', 'sell_sum')

    def __init__(self, window_sec: float):
        self._window_sec = window_sec
        self._buys: deque = deque()   # (ts, qty)
        self._sells: deque = deque()  # (ts, qty)
        self.buy_sum = 0.0
        self.sell_sum = 0.0

    def add(self, ts: float, qty: float, is_sell: bool):
        if is_sell:
            self._sells.append((ts, qty))
            self.sell_sum += qty
        else:
            self._buys.append((ts, qty))
            self.buy_sum += qty
        self._evict(ts)

    def _evict(self, now: float):
        cutoff = now - self._window_sec
        while self._buys and self._buys[0][0] < cutoff:
            self.buy_sum -= self._buys.popleft()[1]
        while self._sells and self._sells[0][0] < cutoff:
            self.sell_sum -= self._sells.popleft()[1]
        # Clamp floating point drift
        if self.buy_sum < 0:
            self.buy_sum = 0.0
        if self.sell_sum < 0:
            self.sell_sum = 0.0

    @property
    def ti(self) -> float:
        """Trade Imbalance: (buy - sell) / (buy + sell), range [-1, 1]."""
        total = self.buy_sum + self.sell_sum
        if total < 1e-12:
            return 0.0
        return (self.buy_sum - self.sell_sum) / total

    @property
    def buy_ratio(self) -> float:
        """Fraction of volume that is buy-aggression, range [0, 1]."""
        total = self.buy_sum + self.sell_sum
        if total < 1e-12:
            return 0.5
        return self.buy_sum / total


# ═══════════════════════════════════════════════════════════════
# REALIZED VOLATILITY TRACKER
# ═══════════════════════════════════════════════════════════════

class RollingRV:
    """Realized volatility from log returns over a rolling window."""
    __slots__ = ('_window_sec', '_prices', '_last_price')

    def __init__(self, window_sec: float = 1.0):
        self._window_sec = window_sec
        self._prices: deque = deque()  # (ts, price)
        self._last_price = 0.0

    def add(self, ts: float, price: float):
        self._prices.append((ts, price))
        self._last_price = price
        cutoff = ts - self._window_sec
        while self._prices and self._prices[0][0] < cutoff:
            self._prices.popleft()

    @property
    def rv(self) -> float:
        """Annualized-ish realized vol (actually just stdev of log returns in window)."""
        if len(self._prices) < 3:
            return 0.0
        prices = [p for _, p in self._prices]
        log_rets = []
        for i in range(1, len(prices)):
            if prices[i - 1] > 0:
                log_rets.append(math.log(prices[i] / prices[i - 1]))
        if len(log_rets) < 2:
            return 0.0
        mean = sum(log_rets) / len(log_rets)
        var = sum((r - mean) ** 2 for r in log_rets) / len(log_rets)
        return math.sqrt(max(var, 0.0))


# ═══════════════════════════════════════════════════════════════
# MICRO SIGNALS — One per symbol
# ═══════════════════════════════════════════════════════════════

@dataclass
class EntrySignal:
    should_enter: bool = False
    pump: float = 0.0
    exhaust: float = 0.0
    signal_strength: float = 0.0

@dataclass
class ExitSignal:
    should_exit: bool = False
    reason: str = ""
    fast_tp: bool = False


class MicroSignals:
    """
    Per-symbol microstructure signal engine.

    Feed with on_trade() and on_book() — reads TI, QI, MD, Pump, Exhaust.
    Query with entry_signal(), exit_signal(), position_size().
    """

    def __init__(self):
        # ── Rolling TI windows ──
        self._ti_2s = RollingQty(2.0)
        self._ti_500ms = RollingQty(0.5)
        self._ti_300ms = RollingQty(0.3)

        # ── Previous TI values for delta computation ──
        self._prev_ti_300ms = 0.0
        self._prev_qi = 0.0
        self._prev_ti_update_ts = 0.0
        self._prev_qi_update_ts = 0.0

        # ── Realized volatility ──
        self._rv = RollingRV(1.0)

        # ── Multi-timeframe flow/TPS/ratio metrics (bounded 10m memory) ──
        self._flow = SecondBucketFlow(max_window_sec=600)

        # ── L1 state ──
        self.bid = 0.0
        self.ask = 0.0
        self.bid_qty = 0.0
        self.ask_qty = 0.0
        self.mid = 0.0
        self.spread = 0.0
        self.spread_bps = 0.0

        # ── Price tracking for returns ──
        self._price_2s = deque(maxlen=200)  # (ts, mid) for 2s return
        self._price_30s = deque(maxlen=600)  # (ts, mid) for 30s return
        self._last_book_ts = 0.0

        # ── Z-score trackers ──
        self._z_ret_2s = EMAZScore(halflife=5.0, dt=0.1)
        self._z_ti_2s = EMAZScore(halflife=5.0, dt=0.1)
        self._z_md_2s = EMAZScore(halflife=5.0, dt=0.1)
        self._z_neg_dti = EMAZScore(halflife=3.0, dt=0.1)
        self._z_neg_dqi = EMAZScore(halflife=3.0, dt=0.1)

        # ── Computed signals ──
        self.TI_2s: float = 0.0
        self.TI_500ms: float = 0.0
        self.TI_300ms: float = 0.0
        self.QI: float = 0.0
        self.micro_price: float = 0.0
        self.MD: float = 0.0

        # Z-scored values
        self.z_ret_2s: float = 0.0
        self.z_TI_2s: float = 0.0
        self.z_MD_2s: float = 0.0
        self.z_neg_dTI: float = 0.0
        self.z_neg_dQI: float = 0.0

        # Composite scores
        self.pump_score: float = 0.0
        self.exhaust_score: float = 0.0

        # Flow-stop tracking: MD > 0 sustained timer
        self._md_positive_since: float = 0.0

        # Warmup
        self._trade_count = 0
        self._book_count = 0

    # ── FEED METHODS ──

    def on_trade(self, price: float, qty: float, is_buyer_maker: bool, ts: float):
        """
        Process aggTrade event.
        is_buyer_maker=True  => sell aggressor (taker sold)
        is_buyer_maker=False => buy aggressor (taker bought)
        """
        is_sell = is_buyer_maker  # m=True => seller is taker => sell aggressor

        self._ti_2s.add(ts, qty, is_sell)
        self._ti_500ms.add(ts, qty, is_sell)
        self._ti_300ms.add(ts, qty, is_sell)
        self._flow.add(ts, qty, price, is_sell)

        self._rv.add(ts, price)
        self._trade_count += 1

        # Update TI values
        self.TI_2s = self._ti_2s.ti
        self.TI_500ms = self._ti_500ms.ti
        self.TI_300ms = self._ti_300ms.ti

        # Compute dTI (change in TI_300ms) for exhaust
        if ts - self._prev_ti_update_ts > 0.05:  # Throttle to 20Hz
            dti = self.TI_300ms - self._prev_ti_300ms
            self.z_neg_dTI = self._z_neg_dti.update(-dti)
            self._prev_ti_300ms = self.TI_300ms
            self._prev_ti_update_ts = ts

    def on_book(self, bid: float, ask: float, bid_qty: float, ask_qty: float, ts: float):
        """Process L1 book update. Recomputes QI, MD, composite scores."""
        self.bid = bid
        self.ask = ask
        self.bid_qty = bid_qty
        self.ask_qty = ask_qty

        if bid <= 0 or ask <= 0:
            return

        self.mid = (bid + ask) / 2.0
        self.spread = ask - bid
        self.spread_bps = self.spread / self.mid * 10000 if self.mid > 0 else 0.0

        # ── QI: Quote Imbalance ──
        total_qty = bid_qty + ask_qty
        if total_qty > 1e-12:
            self.QI = (bid_qty - ask_qty) / total_qty
        else:
            self.QI = 0.0

        # ── MicroPrice & MD ──
        if total_qty > 1e-12 and self.spread > 0:
            self.micro_price = (ask * bid_qty + bid * ask_qty) / total_qty
            self.MD = (self.micro_price - self.mid) / self.spread
        else:
            self.micro_price = self.mid
            self.MD = 0.0

        # ── Track mid for 2s / 30s return ──
        self._price_2s.append((ts, self.mid))
        self._price_30s.append((ts, self.mid))

        # ── 2s return ──
        ret_2s = 0.0
        cutoff_2s = ts - 2.0
        for pts, pmid in self._price_2s:
            if pts >= cutoff_2s:
                if pmid > 0:
                    ret_2s = (self.mid - pmid) / pmid * 10000  # in bps
                break

        # ── Z-scores ──
        self.z_ret_2s = self._z_ret_2s.update(ret_2s)
        self.z_TI_2s = self._z_ti_2s.update(self.TI_2s)
        self.z_MD_2s = self._z_md_2s.update(self.MD)

        # dQI for exhaust
        if ts - self._prev_qi_update_ts > 0.05:
            dqi = self.QI - self._prev_qi
            self.z_neg_dQI = self._z_neg_dqi.update(-dqi)
            self._prev_qi = self.QI
            self._prev_qi_update_ts = ts

        # ── Pump score ──
        # Pump = 0.4*z(ret_2s) + 0.8*z(TI_2s) + 0.6*z(MD_2s)
        # Weight on z(ret_2s) reduced from 1.0→0.4 to decouple from trend cap (UU#5)
        self.pump_score = 0.4 * self.z_ret_2s + 0.8 * self.z_TI_2s + 0.6 * self.z_MD_2s

        # ── Exhaust score ──
        # Exhaust = z(-dTI_300ms) + z(-dQI_300ms) + 1[MD < 0]
        md_indicator = 1.0 if self.MD < 0 else 0.0
        self.exhaust_score = self.z_neg_dTI + self.z_neg_dQI + md_indicator

        # ── MD positive tracking (for flow-stop exit) ──
        if self.MD > 0:
            if self._md_positive_since == 0:
                self._md_positive_since = ts
        else:
            self._md_positive_since = 0.0

        self._book_count += 1
        self._last_book_ts = ts

    # ── HELPERS ──

    def _get_ret_2s(self) -> float:
        """Current 2s return in bps from price history."""
        if not self._price_2s or self.mid <= 0:
            return 0.0
        ts_now = self._last_book_ts
        cutoff = ts_now - 2.0
        for pts, pmid in self._price_2s:
            if pts >= cutoff:
                if pmid > 0:
                    return (self.mid - pmid) / pmid * 10000
                break
        return 0.0

    def _get_ret_30s(self) -> float:
        """Current 30s return in bps from price history."""
        if not self._price_30s or self.mid <= 0:
            return 0.0
        ts_now = self._last_book_ts
        cutoff = ts_now - 30.0
        for pts, pmid in self._price_30s:
            if pts >= cutoff:
                if pmid > 0:
                    return (self.mid - pmid) / pmid * 10000
                break
        return 0.0

    @property
    def ret_30s_bps(self) -> float:
        """Current 30s return in bps."""
        return self._get_ret_30s()

    @property
    def rv_1s(self) -> float:
        """Current rolling 1s realized volatility (std of log returns)."""
        return self._rv.rv

    def flow_snapshot(self, now: Optional[float] = None, prefix: str = "pair_") -> Dict[str, float]:
        """
        Multi-timeframe flow snapshot for this symbol.

        Includes trade-weight, TPS, notional-speed, TI and long/short ratio
        for 1s/5s/10s/30s/60s/5m/10m windows.
        """
        ts = now if now is not None else (self._last_book_ts or time.time())
        return self._flow.snapshot(ts, prefix=prefix)

    @property
    def ret_2s_bps(self) -> float:
        """Current 2s return in bps."""
        return self._get_ret_2s()

    # ── QUERY METHODS ──

    @property
    def is_warm(self) -> bool:
        """Need enough data for meaningful signals."""
        warm = self._trade_count > 20 and self._book_count > 50
        if not warm and self._book_count > 0 and self._book_count % 50 == 0:
            logger.debug(
                f"WARMUP: trades={self._trade_count}/20, books={self._book_count}/50"
            )
        return warm

    def entry_signal(self, pump_thresh: float = 2.0, exhaust_thresh: float = 1.0,
                     min_spread: float = 8.0, max_spread: float = 40.0,
                     max_trend_bps: float = 5.0,
                     max_trend_30s_bps: float = 30.0,
                     max_buy_ratio: float = 1.0) -> EntrySignal:
        """
        Check if entry conditions are met.
        Short only if: Pump > thresh AND Exhaust > thresh AND spread in range
                       AND 2s return not still strongly positive (still pumping)
                       AND 30s return not strongly negative (waterfall in progress)
                       AND buy_ratio not too high (buyers not dominating).
        """
        if not self.is_warm:
            return EntrySignal()

        if self.spread_bps < min_spread or self.spread_bps > max_spread:
            return EntrySignal()

        if self.pump_score <= pump_thresh:
            return EntrySignal(pump=self.pump_score, exhaust=self.exhaust_score)

        if self.exhaust_score <= exhaust_thresh:
            return EntrySignal(pump=self.pump_score, exhaust=self.exhaust_score)

        # Trend guard: skip if 2s return is still strongly positive (still pumping)
        ret_2s = self._get_ret_2s()
        if ret_2s > max_trend_bps:
            return EntrySignal(pump=self.pump_score, exhaust=self.exhaust_score)

        # 30s trend guard: skip if the pair has a sustained move in either direction.
        # Uptrend: shorting into momentum → NAORISUSDT-style recycle loss.
        # Downtrend: pump signals on dead-cat bounces are unreliable.
        if max_trend_30s_bps > 0:
            ret_30s = self._get_ret_30s()
            if abs(ret_30s) > max_trend_30s_bps:
                return EntrySignal(pump=self.pump_score, exhaust=self.exhaust_score)

        # Trade-side delta: skip short if buyers dominating (bad time to fade)
        if max_buy_ratio < 1.0 and self._ti_2s.buy_ratio > max_buy_ratio:
            return EntrySignal(pump=self.pump_score, exhaust=self.exhaust_score)

        # Signal strength for sizing: pump * exhaust composite
        strength = self.pump_score * 0.5 + self.exhaust_score * 0.5

        return EntrySignal(
            should_enter=True,
            pump=self.pump_score,
            exhaust=self.exhaust_score,
            signal_strength=strength,
        )

    def exit_signal(self, entry_price: float, total_notional: float,
                    tp_spread_mult: float = 1.2,
                    fast_tp_ti: float = -0.25,
                    min_fast_tp_bps: float = -10.0,
                    min_tp_profit_bps: float = 10.0) -> ExitSignal:
        """
        Check exit conditions for a short position.

        TP: ret_from_entry <= -max(tp_spread_mult * spread_bps, min_tp_profit_bps)
        Fast TP: TI_500ms < fast_tp_ti (flow reversed, take quick profit)
        """
        if entry_price <= 0 or self.ask <= 0:
            return ExitSignal()

        # Return from entry in bps — use ASK (actual close price for shorts)
        ret_from_entry = (self.ask - entry_price) / entry_price * 10000

        # ── TP: price dropped enough relative to spread, with absolute floor ──
        tp_target_bps = -max(tp_spread_mult * self.spread_bps, min_tp_profit_bps)
        if ret_from_entry <= tp_target_bps:
            return ExitSignal(should_exit=True, reason="tp")

        # ── Fast TP: flow reversed + meaningful profit (covers fees) ──
        if self.TI_500ms < fast_tp_ti and ret_from_entry <= min_fast_tp_bps:
            return ExitSignal(should_exit=True, reason="fast_tp", fast_tp=True)

        return ExitSignal()

    def position_size(self, base_notional: float, k: float = 1.0,
                      min_notional: float = 6.0, max_notional: float = 30.0) -> float:
        """
        Vol-normalized position sizing.
        notional = clip(k * signal_strength / rv_1s, min, max)
        """
        rv = self._rv.rv
        if rv < 1e-8:
            return base_notional

        strength = max(self.pump_score * 0.5 + self.exhaust_score * 0.5, 0.5)
        raw = k * strength / (rv * 10000)  # Scale rv to reasonable range
        return max(min_notional, min(raw * base_notional, max_notional))

    def reset_entry_tracking(self):
        """Call when position is fully closed to reset flow-stop state."""
        self._md_positive_since = 0.0

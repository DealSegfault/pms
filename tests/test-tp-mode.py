"""
Unit tests for GridTrader TP mode logic.

Tests _effective_tp_mode() auto-switching and fast_tp suppression in vol mode.
"""
import sys
import os
import unittest
from unittest.mock import MagicMock, patch
from dataclasses import dataclass, field
from typing import List

# Add bot/v7 to path so we can import grid_trader
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bot', 'v7'))

from grid_trader import GridConfig, GridTrader
from signals import ExitSignal


class TestEffectiveTpMode(unittest.TestCase):
    """Tests for GridTrader._effective_tp_mode()"""

    def _make_trader(self, tp_mode='auto', total_notional=0.0):
        """Create a minimal GridTrader for testing."""
        config = GridConfig(symbol='BTCUSDT', tp_mode=tp_mode)
        trader = GridTrader.__new__(GridTrader)
        trader.config = config
        trader.total_notional = total_notional
        trader.layers = []
        return trader

    def test_auto_mode_small_position_returns_fast(self):
        """Auto mode with notional <= $50 should resolve to 'fast'."""
        trader = self._make_trader(tp_mode='auto', total_notional=30.0)
        self.assertEqual(trader._effective_tp_mode(), 'fast')

    def test_auto_mode_exactly_50_returns_fast(self):
        """Auto mode with notional == $50 should be 'fast' (threshold is >$50)."""
        trader = self._make_trader(tp_mode='auto', total_notional=50.0)
        self.assertEqual(trader._effective_tp_mode(), 'fast')

    def test_auto_mode_large_position_returns_vol(self):
        """Auto mode with notional > $50 should resolve to 'vol'."""
        trader = self._make_trader(tp_mode='auto', total_notional=75.0)
        self.assertEqual(trader._effective_tp_mode(), 'vol')

    def test_auto_mode_very_large_position_returns_vol(self):
        """Auto mode with very large notional should be 'vol'."""
        trader = self._make_trader(tp_mode='auto', total_notional=500.0)
        self.assertEqual(trader._effective_tp_mode(), 'vol')

    def test_forced_vol_small_position(self):
        """Explicit vol mode overrides size — small position still gets 'vol'."""
        trader = self._make_trader(tp_mode='vol', total_notional=10.0)
        self.assertEqual(trader._effective_tp_mode(), 'vol')

    def test_forced_fast_large_position(self):
        """Explicit fast mode overrides size — large position still gets 'fast'."""
        trader = self._make_trader(tp_mode='fast', total_notional=200.0)
        self.assertEqual(trader._effective_tp_mode(), 'fast')

    def test_missing_tp_mode_defaults_to_auto(self):
        """If tp_mode is missing from config, default to 'auto' behavior."""
        config = GridConfig(symbol='BTCUSDT')
        # Remove tp_mode attribute to simulate old config
        trader = GridTrader.__new__(GridTrader)
        trader.config = config
        trader.total_notional = 100.0
        trader.layers = []
        # Should default to auto → vol (notional > 50)
        self.assertEqual(trader._effective_tp_mode(), 'vol')

    def test_auto_mode_zero_notional_returns_fast(self):
        """Auto mode with zero notional (flat) should be 'fast'."""
        trader = self._make_trader(tp_mode='auto', total_notional=0.0)
        self.assertEqual(trader._effective_tp_mode(), 'fast')


class TestFastTpSuppression(unittest.TestCase):
    """Tests that fast_tp is suppressed in vol mode but allowed in fast mode."""

    def _make_trader_with_position(self, tp_mode='auto', total_notional=100.0):
        """Create a GridTrader with a mock position for exit testing."""
        config = GridConfig(
            symbol='BTCUSDT',
            tp_mode=tp_mode,
            tp_spread_mult=1.2,
            fast_tp_ti=-0.25,
            min_tp_profit_bps=10.0,
            stop_loss_bps=0.0,
            inverse_tp_enabled=False,
        )
        trader = GridTrader.__new__(GridTrader)
        trader.config = config
        trader.total_notional = total_notional
        trader.layers = [MagicMock(entry_ts=1000000)]
        trader.avg_entry_price = 100.0
        trader.ask = 99.98  # in profit for short
        trader.bid = 99.97
        trader.signals = MagicMock()
        trader._cooldown_until = 0
        trader._inverse_tp_active = False
        trader._inverse_tp_zones = []
        trader._pending_exit = False
        trader._pending_order = False
        trader.wins = 0
        trader.losses = 0
        trader._event_log = []
        trader._fee_floor_bps = MagicMock(return_value=2.0)
        trader._recovery_exit_hurdle_bps = MagicMock(return_value=0.0)
        trader._dynamic_min_fast_tp_bps = MagicMock(return_value=-10.0)
        trader._dynamic_min_tp_profit_bps = MagicMock(return_value=10.0)
        return trader

    def test_fast_tp_suppressed_in_vol_mode(self):
        """fast_tp signal should be suppressed when effective mode is vol."""
        trader = self._make_trader_with_position(tp_mode='vol', total_notional=100.0)

        # Simulate exit_signal returning a fast_tp signal
        fast_tp_signal = ExitSignal(should_exit=True, reason="fast_tp", fast_tp=True)
        trader.signals.exit_signal.return_value = fast_tp_signal
        trader.estimate_close_pnl = MagicMock(return_value=(0.01, 5.0))

        # _check_exit should NOT call _close_all because fast_tp is suppressed in vol mode
        trader._close_all = MagicMock()
        trader._check_exit(now=1000001, spread_bps=10.0)

        trader._close_all.assert_not_called()

    def test_fast_tp_allowed_in_fast_mode(self):
        """fast_tp signal should fire normally in fast mode."""
        trader = self._make_trader_with_position(tp_mode='fast', total_notional=100.0)

        fast_tp_signal = ExitSignal(should_exit=True, reason="fast_tp", fast_tp=True)
        trader.signals.exit_signal.return_value = fast_tp_signal
        trader.estimate_close_pnl = MagicMock(return_value=(0.01, 5.0))

        trader._close_all = MagicMock()
        trader._check_exit(now=1000001, spread_bps=10.0)

        trader._close_all.assert_called_once()

    def test_fast_tp_suppressed_auto_large(self):
        """In auto mode with notional > $50, fast_tp should be suppressed."""
        trader = self._make_trader_with_position(tp_mode='auto', total_notional=80.0)

        fast_tp_signal = ExitSignal(should_exit=True, reason="fast_tp", fast_tp=True)
        trader.signals.exit_signal.return_value = fast_tp_signal
        trader.estimate_close_pnl = MagicMock(return_value=(0.01, 5.0))

        trader._close_all = MagicMock()
        trader._check_exit(now=1000001, spread_bps=10.0)

        trader._close_all.assert_not_called()

    def test_fast_tp_allowed_auto_small(self):
        """In auto mode with notional <= $50, fast_tp should be allowed."""
        trader = self._make_trader_with_position(tp_mode='auto', total_notional=30.0)

        fast_tp_signal = ExitSignal(should_exit=True, reason="fast_tp", fast_tp=True)
        trader.signals.exit_signal.return_value = fast_tp_signal
        trader.estimate_close_pnl = MagicMock(return_value=(0.01, 5.0))

        trader._close_all = MagicMock()
        trader._check_exit(now=1000001, spread_bps=10.0)

        trader._close_all.assert_called_once()

    def test_regular_tp_always_allowed(self):
        """Regular TP (non-fast) should fire in all modes."""
        for mode in ('auto', 'fast', 'vol'):
            trader = self._make_trader_with_position(tp_mode=mode, total_notional=100.0)

            tp_signal = ExitSignal(should_exit=True, reason="tp")
            trader.signals.exit_signal.return_value = tp_signal
            trader.estimate_close_pnl = MagicMock(return_value=(0.05, 20.0))

            trader._close_all = MagicMock()
            trader._check_exit(now=1000001, spread_bps=10.0)

            trader._close_all.assert_called_once()


if __name__ == '__main__':
    unittest.main()

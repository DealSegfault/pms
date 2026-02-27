"""
test_properties — Property-based tests for PMS invariants and pure logic.

Instead of testing specific examples, these tests verify that PROPERTIES hold
across randomized inputs. This finds edge cases that example-based tests miss.

Uses Python's random module (no hypothesis dependency required).
Run: cd /path/to/project && PYTHONPATH=trading_engine_python python -m pytest trading_engine_python/tests/test_properties.py -v
"""

from __future__ import annotations

import random
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts.pure_logic import (
    chase_compute_price,
    chase_should_reprice,
    chase_is_max_distance_breached,
    trail_stop_compute_trigger,
    trail_stop_update_extreme,
    trail_stop_is_triggered,
    trail_stop_should_activate,
    trail_stop_close_side,
    pnl,
    pnl_sign,
    normalize_symbol_pure,
    to_ccxt_pure,
    scalper_is_price_allowed,
    scalper_compute_offsets,
)
from contracts.invariants import (
    InvariantViolation,
    assert_valid_l1,
    assert_chase_price_side,
    assert_trail_stop_extreme_monotone,
    assert_pnl_sign,
    assert_margin_sanity,
)
from contracts.state_machines import (
    CHASE_FSM, TRAIL_STOP_FSM, SCALPER_FSM, SCALPER_SLOT_FSM,
    TWAP_FSM, ORDER_FSM, ALL_FSMS,
)

# Seed for reproducibility in CI — randomizes in dev
SEED = int(os.environ.get("PMS_TEST_SEED", 42))
random.seed(SEED)

N_TRIALS = 200  # Number of random trials per property


def _rand_price() -> float:
    """Random price 0.001 to 100000."""
    return random.uniform(0.001, 100000)


def _rand_pct() -> float:
    """Random percentage 0 to 50."""
    return random.uniform(0, 50)


def _rand_qty() -> float:
    """Random quantity 0.001 to 10000."""
    return random.uniform(0.001, 10000)


def _rand_side() -> str:
    return random.choice(["BUY", "SELL"])


def _rand_position_side() -> str:
    return random.choice(["LONG", "SHORT"])


def _rand_mode() -> str:
    return random.choice(["none", "maintain", "trail"])


# ══════════════════════════════════════════════════════════════
# 1. Chase Properties
# ══════════════════════════════════════════════════════════════

class TestChaseProperties(unittest.TestCase):
    """Property: chase price is always on the correct side of BBO."""

    def test_chase_price_correct_side_of_bbo(self):
        """For any valid inputs, BUY price <= bid and SELL price >= ask (with offset > 0)."""
        for _ in range(N_TRIALS):
            bid = _rand_price()
            spread = random.uniform(0.001, bid * 0.1)
            ask = bid + spread
            offset_pct = random.uniform(0.01, 10)  # > 0

            # BUY
            buy_price = chase_compute_price("BUY", bid, ask, offset_pct)
            self.assertLessEqual(buy_price, bid,
                f"BUY price {buy_price} > bid {bid} with offset {offset_pct}%")

            # SELL
            sell_price = chase_compute_price("SELL", bid, ask, offset_pct)
            self.assertGreaterEqual(sell_price, ask,
                f"SELL price {sell_price} < ask {ask} with offset {offset_pct}%")

    def test_chase_price_zero_offset_joins_bbo(self):
        """With offset_pct == 0, price equals BBO exactly."""
        for _ in range(N_TRIALS):
            bid = _rand_price()
            ask = bid + random.uniform(0.001, bid * 0.1)

            buy_price = chase_compute_price("BUY", bid, ask, 0)
            self.assertAlmostEqual(buy_price, bid, places=10)

            sell_price = chase_compute_price("SELL", bid, ask, 0)
            self.assertAlmostEqual(sell_price, ask, places=10)

    def test_chase_price_monotone_in_offset(self):
        """Higher offset → more passive (further from BBO)."""
        for _ in range(N_TRIALS):
            bid = _rand_price()
            ask = bid + random.uniform(0.001, bid * 0.1)
            off1 = random.uniform(0, 5)
            off2 = off1 + random.uniform(0.01, 5)

            # BUY: higher offset → lower price
            p1 = chase_compute_price("BUY", bid, ask, off1)
            p2 = chase_compute_price("BUY", bid, ask, off2)
            self.assertLessEqual(p2, p1,
                f"BUY: offset {off2} didn't produce lower price than {off1}")

            # SELL: higher offset → higher price
            p1 = chase_compute_price("SELL", bid, ask, off1)
            p2 = chase_compute_price("SELL", bid, ask, off2)
            self.assertGreaterEqual(p2, p1,
                f"SELL: offset {off2} didn't produce higher price than {off1}")

    def test_trail_mode_only_favorable(self):
        """In trail mode, reprice only happens in favorable direction."""
        for _ in range(N_TRIALS):
            current = _rand_price()

            # BUY trail: only reprice downward
            lower = current * random.uniform(0.5, 0.999)
            higher = current * random.uniform(1.001, 1.5)
            self.assertTrue(chase_should_reprice("trail", "BUY", current, lower))
            self.assertFalse(chase_should_reprice("trail", "BUY", current, higher))

            # SELL trail: only reprice upward
            self.assertTrue(chase_should_reprice("trail", "SELL", current, higher))
            self.assertFalse(chase_should_reprice("trail", "SELL", current, lower))

    def test_none_mode_never_reprices(self):
        """In none mode, never reprice regardless of price."""
        for _ in range(N_TRIALS):
            current = _rand_price()
            new_price = _rand_price()
            side = _rand_side()
            self.assertFalse(chase_should_reprice("none", side, current, new_price))

    def test_maintain_mode_always_reprices(self):
        """In maintain mode, always reprice."""
        for _ in range(N_TRIALS):
            current = _rand_price()
            new_price = _rand_price()
            side = _rand_side()
            self.assertTrue(chase_should_reprice("maintain", side, current, new_price))

    def test_max_distance_zero_never_breaches(self):
        """max_distance_pct == 0 → never breached (disabled)."""
        for _ in range(N_TRIALS):
            mid = _rand_price()
            initial = _rand_price()
            self.assertFalse(chase_is_max_distance_breached(mid, initial, 0))

    def test_max_distance_symmetric(self):
        """Distance check is symmetric: up or down from initial."""
        for _ in range(N_TRIALS):
            initial = _rand_price()
            max_dist = random.uniform(0.1, 10)

            # Price up: distance = (mid - initial) / initial * 100 > max_dist
            mid_up = initial * (1 + max_dist / 100 + 0.01)
            self.assertTrue(chase_is_max_distance_breached(mid_up, initial, max_dist))

            # Price down: distance = (initial - mid) / initial * 100 > max_dist
            mid_down = initial * (1 - max_dist / 100 - 0.01)
            if mid_down > 0:  # Skip if price would go negative
                self.assertTrue(chase_is_max_distance_breached(mid_down, initial, max_dist))


# ══════════════════════════════════════════════════════════════
# 2. Trail Stop Properties
# ══════════════════════════════════════════════════════════════

class TestTrailStopProperties(unittest.TestCase):

    def test_extreme_monotone(self):
        """Extreme price is monotone: LONG only goes up, SHORT only goes down."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            initial = _rand_price()
            extreme = initial

            # Simulate 50 ticks
            for _ in range(50):
                mid = initial * random.uniform(0.8, 1.2)
                old_extreme = extreme
                extreme, changed = trail_stop_update_extreme(side, extreme, mid)

                # Assert monotonicity
                assert_trail_stop_extreme_monotone(side, old_extreme, extreme)

    def test_trigger_always_on_correct_side_of_extreme(self):
        """LONG trigger < extreme, SHORT trigger > extreme."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            extreme = _rand_price()
            trail_pct = random.uniform(0.01, 50)

            trigger = trail_stop_compute_trigger(side, extreme, trail_pct)

            if side == "LONG":
                self.assertLess(trigger, extreme,
                    f"LONG trigger {trigger} >= extreme {extreme}")
            else:
                self.assertGreater(trigger, extreme,
                    f"SHORT trigger {trigger} <= extreme {extreme}")

    def test_trigger_formula_exact(self):
        """Trigger price matches the exact formula."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            extreme = _rand_price()
            trail_pct = random.uniform(0.01, 50)

            trigger = trail_stop_compute_trigger(side, extreme, trail_pct)

            if side == "LONG":
                expected = extreme * (1 - trail_pct / 100)
            else:
                expected = extreme * (1 + trail_pct / 100)

            self.assertAlmostEqual(trigger, expected, places=8)

    def test_triggered_iff_price_crosses(self):
        """Trail triggers exactly when mid crosses trigger_price in the right direction."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            extreme = _rand_price()
            trail_pct = random.uniform(0.5, 10)
            trigger = trail_stop_compute_trigger(side, extreme, trail_pct)

            # Price at trigger → should trigger
            self.assertTrue(trail_stop_is_triggered(side, trigger, trigger))

            # Price beyond trigger → should trigger
            if side == "LONG":
                self.assertTrue(trail_stop_is_triggered(side, trigger * 0.99, trigger))
                self.assertFalse(trail_stop_is_triggered(side, trigger * 1.01, trigger))
            else:
                self.assertTrue(trail_stop_is_triggered(side, trigger * 1.01, trigger))
                self.assertFalse(trail_stop_is_triggered(side, trigger * 0.99, trigger))

    def test_close_side_opposite(self):
        """Close side is always opposite of position side."""
        self.assertEqual(trail_stop_close_side("LONG"), "SELL")
        self.assertEqual(trail_stop_close_side("SHORT"), "BUY")


# ══════════════════════════════════════════════════════════════
# 3. PnL Properties
# ══════════════════════════════════════════════════════════════

class TestPnlProperties(unittest.TestCase):

    def test_pnl_sign_matches_direction(self):
        """PnL sign always matches position side and price movement."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            entry = _rand_price()
            qty = _rand_qty()

            # Price goes up
            close_up = entry * random.uniform(1.001, 2.0)
            pnl_up = pnl(side, entry, close_up, qty)
            assert_pnl_sign(side, entry, close_up, pnl_up)

            # Price goes down
            close_down = entry * random.uniform(0.5, 0.999)
            pnl_down = pnl(side, entry, close_down, qty)
            assert_pnl_sign(side, entry, close_down, pnl_down)

    def test_pnl_zero_at_entry(self):
        """PnL is exactly zero when close_price == entry_price."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            entry = _rand_price()
            qty = _rand_qty()
            self.assertAlmostEqual(pnl(side, entry, entry, qty), 0, places=10)

    def test_pnl_proportional_to_quantity(self):
        """PnL scales linearly with quantity."""
        for _ in range(N_TRIALS):
            side = _rand_position_side()
            entry = _rand_price()
            close = _rand_price()
            qty1 = _rand_qty()
            qty2 = qty1 * 2

            pnl1 = pnl(side, entry, close, qty1)
            pnl2 = pnl(side, entry, close, qty2)
            self.assertAlmostEqual(pnl2, pnl1 * 2, places=6)

    def test_pnl_long_short_opposite(self):
        """LONG and SHORT PnL are exact negatives of each other."""
        for _ in range(N_TRIALS):
            entry = _rand_price()
            close = _rand_price()
            qty = _rand_qty()

            pnl_long = pnl("LONG", entry, close, qty)
            pnl_short = pnl("SHORT", entry, close, qty)
            self.assertAlmostEqual(pnl_long, -pnl_short, places=8)


# ══════════════════════════════════════════════════════════════
# 4. State Machine Properties
# ══════════════════════════════════════════════════════════════

class TestFSMProperties(unittest.TestCase):

    def test_no_transitions_from_terminal_states(self):
        """No FSM allows transitions from terminal states."""
        for name, fsm in ALL_FSMS.items():
            for state in fsm.terminal:
                events = fsm.valid_events_from(state)
                self.assertEqual(events, [],
                    f"{name}: terminal state {state} has transitions: {events}")

    def test_all_transitions_lead_to_valid_states(self):
        """Every transition destination is a valid state."""
        for name, fsm in ALL_FSMS.items():
            for (src, evt), dst in fsm.transitions.items():
                self.assertIn(dst, fsm.states,
                    f"{name}: transition ({src},{evt})→{dst} leads to invalid state")

    def test_initial_state_is_not_terminal(self):
        """Initial state is never terminal."""
        for name, fsm in ALL_FSMS.items():
            self.assertNotIn(fsm.initial, fsm.terminal,
                f"{name}: initial state {fsm.initial} is terminal")

    def test_all_terminal_states_reachable(self):
        """Every terminal state is reachable from initial via some path."""
        for name, fsm in ALL_FSMS.items():
            reachable = {fsm.initial}
            frontier = [fsm.initial]
            while frontier:
                state = frontier.pop()
                for (src, evt), dst in fsm.transitions.items():
                    if src == state and dst not in reachable:
                        reachable.add(dst)
                        frontier.append(dst)
            for term in fsm.terminal:
                self.assertIn(term, reachable,
                    f"{name}: terminal state {term} not reachable from {fsm.initial}")

    def test_transition_validation_raises_on_invalid(self):
        """validate_transition raises InvariantViolation for invalid transitions."""
        for name, fsm in ALL_FSMS.items():
            for term in fsm.terminal:
                with self.assertRaises(InvariantViolation):
                    fsm.validate_transition(term, "ANY_EVENT")

    def test_transition_validation_returns_correct_state(self):
        """validate_transition returns the correct destination state."""
        for name, fsm in ALL_FSMS.items():
            for (src, evt), expected_dst in fsm.transitions.items():
                result = fsm.validate_transition(src, evt)
                self.assertEqual(result, expected_dst,
                    f"{name}: ({src},{evt}) returned {result}, expected {expected_dst}")


# ══════════════════════════════════════════════════════════════
# 5. Symbol Normalization Properties
# ══════════════════════════════════════════════════════════════

class TestSymbolProperties(unittest.TestCase):

    def test_normalization_idempotent(self):
        """Normalizing twice gives the same result."""
        symbols = [
            "BTC/USDT:USDT", "BTC/USDT", "BTCUSDT", "btcusdt",
            "ETH/USDT:USDT", "DOGE/USDT", "SOLUSDT",
        ]
        for sym in symbols:
            once = normalize_symbol_pure(sym)
            twice = normalize_symbol_pure(once)
            self.assertEqual(once, twice,
                f"Not idempotent: {sym} → {once} → {twice}")

    def test_normalization_always_ends_with_usdt(self):
        """Every normalized symbol ends with USDT."""
        symbols = ["BTC", "BTC/USDT", "BTC/USDT:USDT", "BTCUSDT", "ETH"]
        for sym in symbols:
            result = normalize_symbol_pure(sym)
            self.assertTrue(result.endswith("USDT"),
                f"Normalized {sym!r} → {result!r} doesn't end with USDT")

    def test_normalization_no_special_chars(self):
        """Normalized symbol has no / or : characters."""
        symbols = ["BTC/USDT:USDT", "ETH/USDT", "DOGE/USDT:USDT"]
        for sym in symbols:
            result = normalize_symbol_pure(sym)
            self.assertNotIn("/", result)
            self.assertNotIn(":", result)

    def test_ccxt_roundtrip(self):
        """normalize(to_ccxt(normalize(x))) == normalize(x)."""
        symbols = ["BTC/USDT:USDT", "BTCUSDT", "ETH/USDT"]
        for sym in symbols:
            norm = normalize_symbol_pure(sym)
            ccxt = to_ccxt_pure(norm)
            back = normalize_symbol_pure(ccxt)
            self.assertEqual(back, norm,
                f"Roundtrip failed: {sym} → {norm} → {ccxt} → {back}")


# ══════════════════════════════════════════════════════════════
# 6. Scalper Properties
# ══════════════════════════════════════════════════════════════

class TestScalperProperties(unittest.TestCase):

    def test_offsets_monotonically_increasing(self):
        """Layer offsets are non-decreasing."""
        for _ in range(N_TRIALS):
            base = random.uniform(0.01, 5)
            count = random.randint(1, 10)
            offsets = scalper_compute_offsets(base, count)
            for i in range(1, len(offsets)):
                self.assertGreaterEqual(offsets[i], offsets[i - 1],
                    f"Offsets not monotone: {offsets}")

    def test_offsets_geometric_mean_is_base(self):
        """Geometric mean of offsets equals base offset (log-symmetric distribution)."""
        import math
        for _ in range(N_TRIALS):
            base = random.uniform(0.01, 5)
            count = random.randint(1, 10)
            offsets = scalper_compute_offsets(base, count)
            if count == 1:
                self.assertAlmostEqual(offsets[0], base, places=10)
            else:
                geo_mean = math.exp(sum(math.log(o) for o in offsets) / count)
                self.assertAlmostEqual(geo_mean, base, places=6,
                    msg=f"Geometric mean {geo_mean} != base {base} for count={count}")

    def test_offsets_count_matches(self):
        """Number of offsets equals count."""
        for _ in range(N_TRIALS):
            base = random.uniform(0.01, 5)
            count = random.randint(1, 10)
            offsets = scalper_compute_offsets(base, count)
            self.assertEqual(len(offsets), count)

    def test_price_filter_none_always_allowed(self):
        """With no bounds set, any price is allowed."""
        for _ in range(N_TRIALS):
            mid = _rand_price()
            side = _rand_side()
            self.assertTrue(scalper_is_price_allowed(side, mid, None, None))


# ══════════════════════════════════════════════════════════════
# 7. L1 Invariant Properties
# ══════════════════════════════════════════════════════════════

class TestL1Properties(unittest.TestCase):

    def test_valid_l1_passes(self):
        """Valid L1 data should not raise."""
        for _ in range(N_TRIALS):
            bid = _rand_price()
            spread = random.uniform(0.0001, bid * 0.05)
            ask = bid + spread
            mid = (bid + ask) / 2
            assert_valid_l1(bid, ask, mid)  # Should not raise

    def test_crossed_book_raises(self):
        """bid > ask should raise InvariantViolation."""
        for _ in range(N_TRIALS):
            bid = _rand_price()
            ask = bid * random.uniform(0.5, 0.999)  # ask < bid
            with self.assertRaises(InvariantViolation):
                assert_valid_l1(bid, ask, (bid + ask) / 2)


if __name__ == "__main__":
    unittest.main()

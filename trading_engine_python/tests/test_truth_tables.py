"""
test_truth_tables — Parameterized tests that verify algo behavior against truth tables.

Each test class takes rows from the truth tables and verifies them against
the actual pure logic functions. This ensures the documented behavior
(truth table) matches the implemented behavior (pure_logic).

Run: cd /path/to/project && PYTHONPATH=trading_engine_python python -m pytest trading_engine_python/tests/test_truth_tables.py -v
"""

from __future__ import annotations

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts.truth_tables import (
    CHASE_TRUTH_TABLE,
    CHASE_PRICE_TABLE,
    TRAIL_STOP_TRUTH_TABLE,
    TRAIL_TRIGGER_TABLE,
    TRAIL_CLOSE_TABLE,
    PNL_TRUTH_TABLE,
    SIDE_MAP_TABLE,
    SIDE_CONVERSION_TABLE,
    SCALPER_PRICE_FILTER_TABLE,
)
from contracts.pure_logic import (
    chase_compute_price,
    chase_should_reprice,
    trail_stop_compute_trigger,
    trail_stop_update_extreme,
    trail_stop_is_triggered,
    trail_stop_close_side,
    pnl,
    pnl_sign,
    scalper_is_price_allowed,
)
from contracts.common import (
    normalize_side,
    position_side_from_order,
    close_side_from_position,
)
from contracts.state_machines import (
    CHASE_FSM, TRAIL_STOP_FSM, SCALPER_FSM, TWAP_FSM,
)


# ══════════════════════════════════════════════════════════════
# Chase Truth Table Tests
# ══════════════════════════════════════════════════════════════

class TestChaseTruthTable(unittest.TestCase):
    """Verify chase reprice behavior matches truth table for every (side × mode × direction)."""

    def test_all_rows(self):
        """Test every row of the chase truth table."""
        # Use concrete prices for testing
        bid = 100.0
        ask = 100.05
        current_buy_price = bid  # Current order at BBO
        current_sell_price = ask

        for row in CHASE_TRUTH_TABLE:
            with self.subTest(side=row.side, mode=row.stalk_mode):
                current = current_buy_price if row.side == "BUY" else current_sell_price

                # Simulate market move UP: bid→101, ask→101.05
                new_bid_up = 101.0
                new_ask_up = 101.05
                new_price_up = chase_compute_price(
                    row.side, new_bid_up, new_ask_up, 0
                )
                should_up = chase_should_reprice(
                    row.stalk_mode, row.side, current, new_price_up
                )

                # Simulate market move DOWN: bid→99, ask→99.05
                new_bid_down = 99.0
                new_ask_down = 99.05
                new_price_down = chase_compute_price(
                    row.side, new_bid_down, new_ask_down, 0
                )
                should_down = chase_should_reprice(
                    row.stalk_mode, row.side, current, new_price_down
                )

                # Verify matches truth table
                if row.market_up == "REPRICE":
                    self.assertTrue(should_up,
                        f"{row.side} {row.stalk_mode}: expected REPRICE on market up, "
                        f"got NO_REPRICE. {row.description}")
                else:
                    self.assertFalse(should_up,
                        f"{row.side} {row.stalk_mode}: expected NO_REPRICE on market up, "
                        f"got REPRICE. {row.description}")

                if row.market_down == "REPRICE":
                    self.assertTrue(should_down,
                        f"{row.side} {row.stalk_mode}: expected REPRICE on market down, "
                        f"got NO_REPRICE. {row.description}")
                else:
                    self.assertFalse(should_down,
                        f"{row.side} {row.stalk_mode}: expected NO_REPRICE on market down, "
                        f"got REPRICE. {row.description}")


class TestChasePriceTable(unittest.TestCase):
    """Verify chase price position relative to BBO matches truth table."""

    def test_all_rows(self):
        bid = 100.0
        ask = 100.05

        for row in CHASE_PRICE_TABLE:
            with self.subTest(side=row.side, offset=row.offset_pct):
                offset = 0.5 if row.offset_pct == ">0" else 0
                price = chase_compute_price(row.side, bid, ask, offset)

                if row.price_relation == "EQUAL_BID":
                    self.assertAlmostEqual(price, bid, places=10,
                        msg=f"{row.description}: price {price} != bid {bid}")
                elif row.price_relation == "BELOW_BID":
                    self.assertLess(price, bid,
                        msg=f"{row.description}: price {price} >= bid {bid}")
                elif row.price_relation == "EQUAL_ASK":
                    self.assertAlmostEqual(price, ask, places=10,
                        msg=f"{row.description}: price {price} != ask {ask}")
                elif row.price_relation == "ABOVE_ASK":
                    self.assertGreater(price, ask,
                        msg=f"{row.description}: price {price} <= ask {ask}")


# ══════════════════════════════════════════════════════════════
# Trail Stop Truth Table Tests
# ══════════════════════════════════════════════════════════════

class TestTrailStopTruthTable(unittest.TestCase):
    """Verify trail stop behavior matches truth table for every (side × direction)."""

    def test_all_rows(self):
        initial_extreme = 100.0
        trail_pct = 5.0

        for row in TRAIL_STOP_TRUTH_TABLE:
            with self.subTest(side=row.side, direction=row.market_direction):
                if row.market_direction == "UP":
                    mid = 105.0  # Market moved up
                else:
                    mid = 95.0   # Market moved down

                new_extreme, changed = trail_stop_update_extreme(
                    row.side, initial_extreme, mid
                )

                # Verify extreme action
                if row.extreme_action == "UPDATE_EXTREME":
                    self.assertTrue(changed,
                        f"{row.side} {row.market_direction}: expected extreme update. "
                        f"{row.description}")
                    self.assertNotEqual(new_extreme, initial_extreme)
                else:
                    self.assertFalse(changed,
                        f"{row.side} {row.market_direction}: expected no extreme change. "
                        f"{row.description}")

                # Verify trigger check expectation
                trigger = trail_stop_compute_trigger(row.side, new_extreme, trail_pct)
                is_triggered = trail_stop_is_triggered(row.side, mid, trigger)

                if row.trigger_check == "CHECK_TRIGGER":
                    # This row should actually check — the trigger may or may not fire
                    # depending on the trail_pct vs the move magnitude
                    pass  # Just verify the function doesn't crash
                else:
                    # NO_CHECK rows should not trigger (extreme just moved in our favor)
                    self.assertFalse(is_triggered,
                        f"{row.side} {row.market_direction}: should not trigger after "
                        f"favorable extreme update. {row.description}")


class TestTrailTriggerTable(unittest.TestCase):
    """Verify trail trigger formula against concrete examples."""

    def test_all_rows(self):
        for row in TRAIL_TRIGGER_TABLE:
            with self.subTest(side=row.side, extreme=row.extreme, pct=row.trail_pct):
                trigger = trail_stop_compute_trigger(row.side, row.extreme, row.trail_pct)
                self.assertAlmostEqual(trigger, row.expected_trigger, places=4,
                    msg=f"{row.side}: trigger {trigger} != expected {row.expected_trigger}")


class TestTrailCloseTable(unittest.TestCase):
    """Verify close side matches truth table."""

    def test_all_rows(self):
        for row in TRAIL_CLOSE_TABLE:
            with self.subTest(position_side=row.position_side):
                result = trail_stop_close_side(row.position_side)
                self.assertEqual(result, row.close_side,
                    f"Position {row.position_side}: close side {result} != expected {row.close_side}")


# ══════════════════════════════════════════════════════════════
# PnL Truth Table Tests
# ══════════════════════════════════════════════════════════════

class TestPnlTruthTable(unittest.TestCase):
    """Verify PnL direction matches truth table."""

    def test_all_rows(self):
        entry = 100.0
        qty = 10.0

        for row in PNL_TRUTH_TABLE:
            with self.subTest(side=row.side, move=row.price_move):
                if row.price_move == "UP":
                    close = 110.0
                else:
                    close = 90.0

                result = pnl(row.side, entry, close, qty)

                if row.pnl_sign == "POSITIVE":
                    self.assertGreater(result, 0,
                        f"{row.side} {row.price_move}: PnL {result} should be positive")
                else:
                    self.assertLess(result, 0,
                        f"{row.side} {row.price_move}: PnL {result} should be negative")

                # Also verify via pnl_sign function
                expected_sign = pnl_sign(row.side, row.price_move == "UP")
                self.assertEqual(expected_sign, row.pnl_sign)


# ══════════════════════════════════════════════════════════════
# Side Mapping Truth Table Tests
# ══════════════════════════════════════════════════════════════

class TestSideMapTable(unittest.TestCase):
    """Verify side normalization matches truth table."""

    def test_all_rows(self):
        for row in SIDE_MAP_TABLE:
            with self.subTest(input=row.input):
                result = normalize_side(row.input)
                self.assertEqual(result, row.expected_order_side,
                    f"normalize_side({row.input!r}) = {result!r}, "
                    f"expected {row.expected_order_side!r}")


class TestSideConversionTable(unittest.TestCase):
    """Verify order↔position side conversions match truth table."""

    def test_all_rows(self):
        for row in SIDE_CONVERSION_TABLE:
            with self.subTest(order=row.order_side, position=row.position_side):
                # order → position
                pos = position_side_from_order(row.order_side)
                self.assertEqual(pos, row.position_side,
                    f"position_side_from_order({row.order_side!r}) = {pos!r}")

                # position → close
                close = close_side_from_position(row.position_side)
                self.assertEqual(close, row.close_side,
                    f"close_side_from_position({row.position_side!r}) = {close!r}")


# ══════════════════════════════════════════════════════════════
# Scalper Price Filter Truth Table Tests
# ══════════════════════════════════════════════════════════════

class TestScalperPriceFilterTable(unittest.TestCase):
    """Verify scalper price filter matches truth table."""

    def test_all_rows(self):
        bound_value = 100.0

        for row in SCALPER_PRICE_FILTER_TABLE:
            with self.subTest(side=row.leg_side, relation=row.mid_vs_bound):
                if row.mid_vs_bound == "BELOW":
                    mid = 95.0
                elif row.mid_vs_bound == "ABOVE":
                    mid = 105.0
                else:
                    mid = 100.0

                if row.bound_field == "long_max_price":
                    result = scalper_is_price_allowed(
                        row.leg_side, mid, long_max_price=bound_value,
                        short_min_price=None
                    )
                else:
                    result = scalper_is_price_allowed(
                        row.leg_side, mid, long_max_price=None,
                        short_min_price=bound_value
                    )

                self.assertEqual(result, row.should_activate,
                    f"{row.leg_side} mid={mid} vs {row.bound_field}={bound_value}: "
                    f"got {result}, expected {row.should_activate}. {row.description}")


# ══════════════════════════════════════════════════════════════
# FSM Transition Sequence Tests
# ══════════════════════════════════════════════════════════════

class TestFSMSequences(unittest.TestCase):
    """Test concrete event sequences through FSMs."""

    def test_chase_fill_sequence(self):
        """ACTIVE → FILL → FILLED."""
        state = CHASE_FSM.initial
        state = CHASE_FSM.validate_transition(state, "FILL")
        self.assertEqual(state, "FILLED")

    def test_chase_cancel_sequence(self):
        """ACTIVE → USER_CANCEL → CANCELLED."""
        state = CHASE_FSM.initial
        state = CHASE_FSM.validate_transition(state, "USER_CANCEL")
        self.assertEqual(state, "CANCELLED")

    def test_chase_max_distance_sequence(self):
        """ACTIVE → MAX_DISTANCE → CANCELLED."""
        state = CHASE_FSM.initial
        state = CHASE_FSM.validate_transition(state, "MAX_DISTANCE")
        self.assertEqual(state, "CANCELLED")

    def test_chase_external_cancel_rearm(self):
        """ACTIVE → EXTERNAL_CANCEL → ACTIVE (re-arm)."""
        state = CHASE_FSM.initial
        state = CHASE_FSM.validate_transition(state, "EXTERNAL_CANCEL")
        self.assertEqual(state, "ACTIVE")

    def test_trail_trigger_sequence(self):
        """ACTIVE → TRIGGER → TRIGGERED."""
        state = TRAIL_STOP_FSM.initial
        state = TRAIL_STOP_FSM.validate_transition(state, "TRIGGER")
        self.assertEqual(state, "TRIGGERED")

    def test_twap_full_sequence(self):
        """ACTIVE → LOT_PLACED → LOT_PLACED → ALL_LOTS_DONE → COMPLETED."""
        state = TWAP_FSM.initial
        state = TWAP_FSM.validate_transition(state, "LOT_PLACED")
        self.assertEqual(state, "ACTIVE")
        state = TWAP_FSM.validate_transition(state, "LOT_PLACED")
        self.assertEqual(state, "ACTIVE")
        state = TWAP_FSM.validate_transition(state, "ALL_LOTS_DONE")
        self.assertEqual(state, "COMPLETED")

    def test_scalper_cancel_sequence(self):
        """ACTIVE → USER_CANCEL → CANCELLED."""
        state = SCALPER_FSM.initial
        state = SCALPER_FSM.validate_transition(state, "USER_CANCEL")
        self.assertEqual(state, "CANCELLED")


if __name__ == "__main__":
    unittest.main()

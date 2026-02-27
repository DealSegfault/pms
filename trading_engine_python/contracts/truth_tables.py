"""
truth_tables — Declarative behavior tables for all algo engines.

Each table describes the complete expected behavior for every combination of
(side × mode × market condition). These serve two purposes:

    1. Documentation: humans and LLMs can read the exact expected behavior
    2. Test fixtures: parameterized tests verify the actual code against these tables

Format:
    Each row is a namedtuple for type-safe access in tests.
"""

from __future__ import annotations

from collections import namedtuple


# ══════════════════════════════════════════════════════════════
# Chase Truth Table
# ══════════════════════════════════════════════════════════════
#
# Dimensions: side × stalk_mode × market_direction
#
# Actions:
#   REPRICE     — cancel + replace at new BBO ± offset
#   NO_REPRICE  — order stays at current price
#   CANCEL      — auto-cancel (max distance breached)

ChaseRow = namedtuple("ChaseRow", [
    "side",           # BUY | SELL
    "stalk_mode",     # none | maintain | trail
    "market_up",      # action when market moves up
    "market_down",    # action when market moves down
    "description",    # human-readable explanation
])

CHASE_TRUTH_TABLE = [
    # ── BUY side ──
    ChaseRow("BUY", "none",     "NO_REPRICE", "NO_REPRICE",
             "Static limit order, never reprices"),
    ChaseRow("BUY", "maintain", "REPRICE",    "REPRICE",
             "Follow BBO both ways: bid up → price up, bid down → price down"),
    ChaseRow("BUY", "trail",    "NO_REPRICE", "REPRICE",
             "Only chase downward (favorable for buyer): lower price = closer to fill"),

    # ── SELL side ──
    ChaseRow("SELL", "none",     "NO_REPRICE", "NO_REPRICE",
             "Static limit order, never reprices"),
    ChaseRow("SELL", "maintain", "REPRICE",    "REPRICE",
             "Follow BBO both ways: ask up → price up, ask down → price down"),
    ChaseRow("SELL", "trail",    "REPRICE",    "NO_REPRICE",
             "Only chase upward (favorable for seller): higher price = better fill"),
]


# ══════════════════════════════════════════════════════════════
# Chase Price Position Table
# ══════════════════════════════════════════════════════════════
#
# Where should the chase price be relative to BBO?

ChasePriceRow = namedtuple("ChasePriceRow", [
    "side",           # BUY | SELL
    "offset_pct",     # 0 | >0
    "price_relation", # relation to BBO
    "description",
])

CHASE_PRICE_TABLE = [
    ChasePriceRow("BUY",  0,    "EQUAL_BID",  "Joins best bid exactly"),
    ChasePriceRow("BUY",  ">0", "BELOW_BID",  "Rests below bid (passive)"),
    ChasePriceRow("SELL", 0,    "EQUAL_ASK",  "Joins best ask exactly"),
    ChasePriceRow("SELL", ">0", "ABOVE_ASK",  "Rests above ask (passive)"),
]


# ══════════════════════════════════════════════════════════════
# Trail Stop Truth Table
# ══════════════════════════════════════════════════════════════
#
# Dimensions: side × market_direction
#
# Actions:
#   UPDATE_EXTREME  — move high/low water mark
#   CHECK_TRIGGER   — check if retracement exceeds trail_pct
#   TRIGGER         — fire market close order

TrailRow = namedtuple("TrailRow", [
    "side",              # LONG | SHORT
    "market_direction",  # UP | DOWN
    "extreme_action",    # UPDATE_EXTREME | NO_CHANGE
    "trigger_check",     # CHECK_TRIGGER | NO_CHECK
    "description",
])

TRAIL_STOP_TRUTH_TABLE = [
    TrailRow("LONG", "UP",   "UPDATE_EXTREME", "NO_CHECK",
             "New high → update HWM, recalc trigger, no trigger check"),
    TrailRow("LONG", "DOWN", "NO_CHANGE",      "CHECK_TRIGGER",
             "Price drops → check if mid <= extreme*(1-trail%)"),
    TrailRow("SHORT", "UP",   "NO_CHANGE",     "CHECK_TRIGGER",
             "Price rises → check if mid >= extreme*(1+trail%)"),
    TrailRow("SHORT", "DOWN", "UPDATE_EXTREME", "NO_CHECK",
             "New low → update LWM, recalc trigger, no trigger check"),
]


# ══════════════════════════════════════════════════════════════
# Trail Stop Trigger Formula Table
# ══════════════════════════════════════════════════════════════

TrailTriggerRow = namedtuple("TrailTriggerRow", [
    "side",            # LONG | SHORT
    "extreme",         # example extreme price
    "trail_pct",       # trail percentage
    "expected_trigger", # computed trigger price
    "trigger_when",    # trigger condition
])

TRAIL_TRIGGER_TABLE = [
    TrailTriggerRow("LONG",  100.0, 5.0, 95.0,
                    "mid <= 95.0"),
    TrailTriggerRow("LONG",  100.0, 1.0, 99.0,
                    "mid <= 99.0"),
    TrailTriggerRow("SHORT", 100.0, 5.0, 105.0,
                    "mid >= 105.0"),
    TrailTriggerRow("SHORT", 100.0, 1.0, 101.0,
                    "mid >= 101.0"),
    TrailTriggerRow("LONG",  50000.0, 2.0, 49000.0,
                    "mid <= 49000.0"),
    TrailTriggerRow("SHORT", 50000.0, 2.0, 51000.0,
                    "mid >= 51000.0"),
]


# ══════════════════════════════════════════════════════════════
# Trail Stop Close Side Table
# ══════════════════════════════════════════════════════════════

TrailCloseRow = namedtuple("TrailCloseRow", [
    "position_side",  # LONG | SHORT
    "close_side",     # the side of the market close order
])

TRAIL_CLOSE_TABLE = [
    TrailCloseRow("LONG",  "SELL"),
    TrailCloseRow("SHORT", "BUY"),
]


# ══════════════════════════════════════════════════════════════
# PnL Direction Table
# ══════════════════════════════════════════════════════════════

PnlRow = namedtuple("PnlRow", [
    "side",        # LONG | SHORT
    "price_move",  # UP | DOWN
    "pnl_sign",    # POSITIVE | NEGATIVE
])

PNL_TRUTH_TABLE = [
    PnlRow("LONG",  "UP",   "POSITIVE"),
    PnlRow("LONG",  "DOWN", "NEGATIVE"),
    PnlRow("SHORT", "UP",   "NEGATIVE"),
    PnlRow("SHORT", "DOWN", "POSITIVE"),
]


# ══════════════════════════════════════════════════════════════
# Side Mapping Table
# ══════════════════════════════════════════════════════════════

SideMapRow = namedtuple("SideMapRow", ["input", "expected_order_side"])

SIDE_MAP_TABLE = [
    SideMapRow("BUY",   "BUY"),
    SideMapRow("SELL",  "SELL"),
    SideMapRow("LONG",  "BUY"),
    SideMapRow("SHORT", "SELL"),
    SideMapRow("buy",   "BUY"),
    SideMapRow("sell",  "SELL"),
    SideMapRow("long",  "BUY"),
    SideMapRow("short", "SELL"),
]


# ══════════════════════════════════════════════════════════════
# Position ↔ Order Side Mapping
# ══════════════════════════════════════════════════════════════

SideConversionRow = namedtuple("SideConversionRow", [
    "order_side",      # BUY | SELL
    "position_side",   # LONG | SHORT
    "close_side",      # SELL | BUY
])

SIDE_CONVERSION_TABLE = [
    SideConversionRow("BUY",  "LONG",  "SELL"),
    SideConversionRow("SELL", "SHORT", "BUY"),
]


# ══════════════════════════════════════════════════════════════
# Scalper Leg Activation Table
# ══════════════════════════════════════════════════════════════

ScalperLegRow = namedtuple("ScalperLegRow", [
    "start_side",        # LONG | SHORT
    "opening_leg_side",  # BUY  | SELL
    "closing_leg_side",  # SELL | BUY
    "closing_reduce_only", # True
])

SCALPER_LEG_TABLE = [
    ScalperLegRow("LONG",  "BUY",  "SELL", True),
    ScalperLegRow("SHORT", "SELL", "BUY",  True),
]


# ══════════════════════════════════════════════════════════════
# Scalper Price Filter Table
# ══════════════════════════════════════════════════════════════

ScalperPriceRow = namedtuple("ScalperPriceRow", [
    "leg_side",         # BUY | SELL
    "bound_field",      # long_max_price | short_min_price
    "mid_vs_bound",     # ABOVE | BELOW | EQUAL
    "should_activate",  # True | False
    "description",
])

SCALPER_PRICE_FILTER_TABLE = [
    ScalperPriceRow("BUY",  "long_max_price",  "BELOW", True,
                    "Mid below max → LONG leg is allowed"),
    ScalperPriceRow("BUY",  "long_max_price",  "ABOVE", False,
                    "Mid above max → LONG leg is paused"),
    ScalperPriceRow("SELL", "short_min_price",  "ABOVE", True,
                    "Mid above min → SHORT leg is allowed"),
    ScalperPriceRow("SELL", "short_min_price",  "BELOW", False,
                    "Mid below min → SHORT leg is paused"),
]

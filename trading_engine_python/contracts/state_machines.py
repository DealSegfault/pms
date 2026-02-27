"""
state_machines — Formal finite state machine definitions for all algos.

Each algo has an explicit FSM definition:
    - Set of valid states
    - Initial state
    - Set of valid transitions (current_state, event) → new_state
    - Set of terminal (absorbing) states

Usage:
    validate_transition(fsm, current_state, event) → new_state or raises
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Optional, Set, Tuple

from .invariants import InvariantViolation


# ══════════════════════════════════════════════════════════════
# FSM Type & Validator
# ══════════════════════════════════════════════════════════════

class FSM:
    """Immutable finite state machine definition."""

    def __init__(
        self,
        name: str,
        states: Set[str],
        initial: str,
        terminal: Set[str],
        transitions: Dict[Tuple[str, str], str],
    ):
        self.name = name
        self.states = frozenset(states)
        self.initial = initial
        self.terminal = frozenset(terminal)
        self.transitions = dict(transitions)

        # Self-validate
        assert initial in states, f"{name}: initial state {initial!r} not in states"
        assert terminal <= states, f"{name}: terminal states not subset of states"
        for (src, evt), dst in transitions.items():
            assert src in states, f"{name}: transition source {src!r} not in states"
            assert dst in states, f"{name}: transition dest {dst!r} not in states"

    def validate_transition(self, current: str, event: str) -> str:
        """
        Validate and apply a state transition.

        Returns new state on success.
        Raises InvariantViolation if:
            - current state is not in FSM
            - transition is not defined
            - trying to transition from a terminal state
        """
        if current not in self.states:
            raise InvariantViolation(
                f"{self.name}: unknown state {current!r}, valid: {sorted(self.states)}"
            )
        if current in self.terminal:
            raise InvariantViolation(
                f"{self.name}: cannot transition from terminal state {current!r} "
                f"via {event!r}"
            )
        key = (current, event)
        if key not in self.transitions:
            valid_events = [e for (s, e) in self.transitions if s == current]
            raise InvariantViolation(
                f"{self.name}: no transition ({current!r}, {event!r}), "
                f"valid events from {current!r}: {valid_events}"
            )
        return self.transitions[key]

    def valid_events_from(self, state: str) -> list:
        """List all valid events from a given state."""
        return [e for (s, e) in self.transitions if s == state]

    def is_terminal(self, state: str) -> bool:
        return state in self.terminal


# ══════════════════════════════════════════════════════════════
# Chase FSM
# ══════════════════════════════════════════════════════════════
#
# State diagram:
#
#   ACTIVE ──FILL──────────────→ FILLED
#     │
#     ├──USER_CANCEL────────────→ CANCELLED
#     ├──MAX_DISTANCE───────────→ CANCELLED
#     ├──CHILD_CANCEL───────────→ CANCELLED  (owned by scalper)
#     └──EXTERNAL_CANCEL────────→ ACTIVE     (re-arm standalone)
#

CHASE_FSM = FSM(
    name="Chase",
    states={"ACTIVE", "FILLED", "CANCELLED"},
    initial="ACTIVE",
    terminal={"FILLED", "CANCELLED"},
    transitions={
        ("ACTIVE", "FILL"):             "FILLED",
        ("ACTIVE", "USER_CANCEL"):      "CANCELLED",
        ("ACTIVE", "MAX_DISTANCE"):     "CANCELLED",
        ("ACTIVE", "CHILD_CANCEL"):     "CANCELLED",
        ("ACTIVE", "EXTERNAL_CANCEL"):  "ACTIVE",   # re-arm
    },
)


# ══════════════════════════════════════════════════════════════
# Trail Stop FSM
# ══════════════════════════════════════════════════════════════
#
# State diagram:
#
#   ACTIVE ──TRIGGER────────────→ TRIGGERED
#     │
#     └──USER_CANCEL────────────→ CANCELLED
#
# Sub-states (activation):
#   WAITING_ACTIVATION ←→ ACTIVATED  (tracked by `activated` flag)
#

TRAIL_STOP_FSM = FSM(
    name="TrailStop",
    states={"ACTIVE", "TRIGGERED", "CANCELLED"},
    initial="ACTIVE",
    terminal={"TRIGGERED", "CANCELLED"},
    transitions={
        ("ACTIVE", "TRIGGER"):      "TRIGGERED",
        ("ACTIVE", "USER_CANCEL"):  "CANCELLED",
    },
)


# ══════════════════════════════════════════════════════════════
# Scalper FSM (top-level)
# ══════════════════════════════════════════════════════════════
#
# State diagram:
#
#   ACTIVE ──USER_CANCEL────────→ CANCELLED
#     │
#     └──ALL_SLOTS_DONE─────────→ COMPLETED  (future: auto-complete)
#

SCALPER_FSM = FSM(
    name="Scalper",
    states={"ACTIVE", "CANCELLED", "COMPLETED"},
    initial="ACTIVE",
    terminal={"CANCELLED", "COMPLETED"},
    transitions={
        ("ACTIVE", "USER_CANCEL"):     "CANCELLED",
        ("ACTIVE", "ALL_SLOTS_DONE"):  "COMPLETED",
    },
)


# ══════════════════════════════════════════════════════════════
# Scalper Slot FSM (per-slot lifecycle)
# ══════════════════════════════════════════════════════════════
#
# State diagram:
#
#   IDLE ──START─────────────────→ ACTIVE
#
#   ACTIVE ──FILL────────────────→ IDLE     (will be restarted)
#     │
#     ├──EXCHANGE_CANCEL─────────→ PAUSED   (backoff retry)
#     ├──EXCHANGE_ERROR──────────→ PAUSED
#     └──PARENT_CANCEL───────────→ STOPPED
#
#   PAUSED ──RETRY───────────────→ ACTIVE
#     │
#     └──PARENT_CANCEL───────────→ STOPPED
#

SCALPER_SLOT_FSM = FSM(
    name="ScalperSlot",
    states={"IDLE", "ACTIVE", "PAUSED", "STOPPED"},
    initial="IDLE",
    terminal={"STOPPED"},
    transitions={
        ("IDLE",   "START"):            "ACTIVE",
        ("ACTIVE", "FILL"):             "IDLE",
        ("ACTIVE", "EXCHANGE_CANCEL"):  "PAUSED",
        ("ACTIVE", "EXCHANGE_ERROR"):   "PAUSED",
        ("ACTIVE", "PARENT_CANCEL"):    "STOPPED",
        ("PAUSED", "RETRY"):            "ACTIVE",
        ("PAUSED", "PARENT_CANCEL"):    "STOPPED",
    },
)


# ══════════════════════════════════════════════════════════════
# TWAP FSM
# ══════════════════════════════════════════════════════════════
#
# State diagram:
#
#   ACTIVE ──LOT_PLACED──────────→ ACTIVE   (progress)
#     │
#     ├──ALL_LOTS_DONE───────────→ COMPLETED
#     └──USER_CANCEL─────────────→ CANCELLED
#

TWAP_FSM = FSM(
    name="TWAP",
    states={"ACTIVE", "COMPLETED", "CANCELLED"},
    initial="ACTIVE",
    terminal={"COMPLETED", "CANCELLED"},
    transitions={
        ("ACTIVE", "LOT_PLACED"):    "ACTIVE",
        ("ACTIVE", "ALL_LOTS_DONE"): "COMPLETED",
        ("ACTIVE", "USER_CANCEL"):   "CANCELLED",
    },
)


# ══════════════════════════════════════════════════════════════
# Order FSM
# ══════════════════════════════════════════════════════════════
#
# State diagram:
#
#   PENDING ──PLACED─────────────→ ACTIVE
#     │
#     └──FAILED──────────────────→ FAILED
#
#   ACTIVE ──FILLED──────────────→ FILLED
#     │
#     ├──PARTIAL_FILL────────────→ ACTIVE   (partial fill, remains active)
#     └──CANCELLED───────────────→ CANCELLED
#

ORDER_FSM = FSM(
    name="Order",
    states={"PENDING", "ACTIVE", "FILLED", "CANCELLED", "FAILED"},
    initial="PENDING",
    terminal={"FILLED", "CANCELLED", "FAILED"},
    transitions={
        ("PENDING", "PLACED"):       "ACTIVE",
        ("PENDING", "FAILED"):       "FAILED",
        ("ACTIVE",  "FILLED"):       "FILLED",
        ("ACTIVE",  "PARTIAL_FILL"): "ACTIVE",
        ("ACTIVE",  "CANCELLED"):    "CANCELLED",
    },
)


# ══════════════════════════════════════════════════════════════
# Registry — all FSMs indexed by name
# ══════════════════════════════════════════════════════════════

ALL_FSMS = {
    "Chase": CHASE_FSM,
    "TrailStop": TRAIL_STOP_FSM,
    "Scalper": SCALPER_FSM,
    "ScalperSlot": SCALPER_SLOT_FSM,
    "TWAP": TWAP_FSM,
    "Order": ORDER_FSM,
}

---
description: How to apply formal specification (invariants, FSMs, truth tables, pure logic) to the PMS trading system for reliable LLM-assisted development
---

# Formal Specification — Making LLMs Reliable on Complex Trading Logic

## Why This Skill Exists

LLMs don't reason deterministically — they complete sequences. When a system has:
- Multiple layers (FE → JS → Python → Exchange)
- Mutable state (Redis, DB, in-memory)
- Implicit invariants (bid < ask, trigger < extreme for LONG, etc.)
- Complex conditional logic (side × mode × direction)

The LLM fills "holes" instead of reasoning formally. This skill teaches how to
structure the codebase so the LLM has **formal specifications** to work with.

---

## The Five Formalization Steps

### 1. Invariants → Assert What Must Always Be True

**File**: `trading_engine_python/contracts/invariants.py`

Every system rule is an assertable function that raises `InvariantViolation`:

```python
from contracts.invariants import assert_chase_state, assert_trail_stop_state, assert_valid_l1

# Call at state creation to validate
assert_chase_state(state)    # Checks: side ∈ {BUY,SELL}, qty>0, mode valid, etc.
assert_trail_stop_state(state)  # Checks: trigger < extreme for LONG, trail_pct > 0, etc.
assert_valid_l1(bid, ask, mid)  # Checks: bid < ask, mid ≈ (bid+ask)/2
```

**When to add invariants**: Any time you discover a rule that "must always be true" — add it as a function, then call it in the relevant engine.

**Soft mode pattern** (production-safe):
```python
try:
    assert_chase_state(state)
except InvariantViolation as e:
    logger.error("Invariant violation: %s", e)
    # Don't crash — log and continue
```

### 2. State Machines → Validate Every Transition

**File**: `trading_engine_python/contracts/state_machines.py`

Every algo has a formal FSM definition:

```python
from contracts.state_machines import CHASE_FSM, TRAIL_STOP_FSM, SCALPER_FSM

# Before changing status:
try:
    CHASE_FSM.validate_transition(state.status, "FILL")  # ACTIVE → FILLED ✓
    state.status = "FILLED"
except InvariantViolation as e:
    logger.error("FSM violation: %s", e)
    # Tried: FILLED → FILL (illegal — terminal state)
```

**Available FSMs**: `CHASE_FSM`, `TRAIL_STOP_FSM`, `SCALPER_FSM`, `SCALPER_SLOT_FSM`, `TWAP_FSM`, `ORDER_FSM`

**When to add FSM events**: When you discover a new state transition in an algo, add it to the FSM definition.

### 3. Truth Tables → Document Every Combination

**File**: `trading_engine_python/contracts/truth_tables.py`

Declarative tables that serve as both documentation and test fixtures:

| side | mode | market_up | market_down | description |
|------|------|-----------|-------------|-------------|
| BUY | none | NO_REPRICE | NO_REPRICE | Static limit order |
| BUY | maintain | REPRICE | REPRICE | Follow BBO both ways |
| BUY | trail | NO_REPRICE | REPRICE | Only chase favorable |
| SELL | trail | REPRICE | NO_REPRICE | Only chase favorable |

**When to add rows**: Before implementing any new (side × mode × condition) behavior, add the truth table row first, then implement.

### 4. Pure Logic → Separate Decisions from I/O

**File**: `trading_engine_python/contracts/pure_logic.py`

Core decision functions with zero I/O — no Redis, no exchange, no asyncio:

```python
from contracts.pure_logic import (
    chase_should_reprice,     # (mode, side, current, new) → bool
    chase_compute_price,      # (side, bid, ask, offset) → float
    trail_stop_is_triggered,  # (side, mid, trigger) → bool
    trail_stop_close_side,    # (position_side) → order_side
)

# Use in engine:
if not chase_should_reprice(state.stalk_mode, state.side, current_price, new_price):
    return  # Pure function says no
```

**When to extract**: Any `if/else` block in an engine that can be expressed as `f(inputs) → output` without I/O should become a pure function.

### 5. Property-Based Tests → Find Edge Cases

**Files**: `trading_engine_python/tests/test_properties.py`, `test_truth_tables.py`

Tests that verify **properties** across randomized inputs (200 trials each):

```python
# Property: BUY chase price is always <= bid (with offset > 0)
# Property: Trail extreme is always monotone (HWM ↑ for LONG)
# Property: PnL sign matches (side × price direction)
# Property: No FSM transitions from terminal states
```

**When to add tests**: Write the property test BEFORE implementing the logic. The test defines the contract, the implementation satisfies it.

---

## Workflow: Adding New Logic

When implementing new trading logic (new algo, new mode, new edge case):

1. **Define the truth table row** in `truth_tables.py`
2. **Add the invariant** in `invariants.py` (what must always be true)
3. **Define/extend the FSM** in `state_machines.py` (new states/transitions)
4. **Write the pure function** in `pure_logic.py` (decision logic, no I/O)
5. **Write property tests** in `test_properties.py` (randomized verification)
6. **Write truth table test** in `test_truth_tables.py` (verify against table)
7. **Implement in the engine** using the pure functions + soft assertions

This order ensures the LLM (or human) has a formal spec to work from.

---

## File Reference

| File | Purpose | Location |
|------|---------|----------|
| `invariants.py` | Assertable invariant functions | `trading_engine_python/contracts/` |
| `state_machines.py` | FSM definitions + validator | `trading_engine_python/contracts/` |
| `truth_tables.py` | Declarative behavior tables | `trading_engine_python/contracts/` |
| `pure_logic.py` | Pure decision functions | `trading_engine_python/contracts/` |
| `test_properties.py` | Property-based tests | `trading_engine_python/tests/` |
| `test_truth_tables.py` | Truth table tests | `trading_engine_python/tests/` |

---

## Running Tests

```bash
# All formal spec tests
cd /Users/mac/cgki/minimalte && PYTHONPATH=trading_engine_python python -m pytest trading_engine_python/tests/test_properties.py trading_engine_python/tests/test_truth_tables.py -v

# Full suite (includes existing contract + cross-system tests)
cd /Users/mac/cgki/minimalte && PYTHONPATH=trading_engine_python python -m pytest trading_engine_python/tests/ -v
```

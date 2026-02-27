---
name: cross-system-dto-evaluation
description: How to evaluate and verify cross-system DTO consistency after code changes
---

# Cross-System DTO Evaluation Skill

## Purpose
Ensures that any change touching data shapes (events, Redis state, commands) stays 
consistent across Python → Redis → JS → Frontend. This skill prevents the root cause 
of every past data mismatch bug: ad-hoc dict construction that drifts between layers.

## When to Use
- Adding a new event type or extending an existing one
- Changing a Redis-persisted state shape
- Adding/renaming fields in commands from frontend
- Modifying `_publish_event`, `_save_state`, or REST mapping functions
- After any refactoring that touches data flow boundaries

## Architecture

```
Frontend (src/lib/contracts.js)     ← WS events consumed
    ↕ WebSocket
JS Backend (server/contracts/events.js) ← REST mapping + event forwarding
    ↕ Redis PUB/SUB + HSET/HGETALL
Python Engine (contracts/)          ← Single source of truth
    common.py   — normalize_side, normalize_symbol, ts_ms, EventType, RedisKey
    commands.py — from_raw() DTOs for incoming commands
    events.py   — to_dict() DTOs for published events
    state.py    — to_dict() DTOs for Redis-persisted state
```

## Evaluation Checklist

### 1. Verify contracts module is the single source of truth

```bash
# No inline normalization should exist outside contracts/
grep -rn '_normalize_side\|_normalize_symbol\|_SIDE_MAP' \
  trading_engine_python/ --include='*.py' | grep -v contracts/ | grep -v __pycache__

# Should return zero results (except imports/aliases like `_to_exchange_side = normalize_side`)
```

### 2. Verify no hardcoded Redis keys remain

```bash
# All Redis keys should use RedisKey.* constants
grep -rn '"pms:' trading_engine_python/ --include='*.py' | \
  grep -v contracts/ | grep -v __pycache__ | grep -v '.pyc' | grep -v 'test_'

# Legitimate exceptions: docstrings/comments only
```

### 3. Verify timestamps are milliseconds

```bash
# No raw time.time() should appear in event payloads
grep -rn 'time\.time()' trading_engine_python/ --include='*.py' | \
  grep -v contracts/ | grep -v __pycache__ | grep -v 'created_at\|_last_'

# Should only appear in internal timing (cooldowns, throttles), never in payloads
```

### 4. Verify Python-JS field alignment

For each algo type, compare the Python DTO `to_dict()` keys with the JS mapping function:

| Algo | Python DTO | JS Mapper |
|------|-----------|-----------|
| Chase | `ChaseRedisState.to_dict()` | `mapChaseState()` in `server/contracts/events.js` |
| Scalper | `ScalperRedisState.to_dict()` | `mapScalperState()` |
| TWAP | `TWAPRedisState.to_dict()` | `mapTWAPState()` |
| Trail Stop | `TrailStopRedisState.to_dict()` | `mapTrailStopState()` |

Both should produce the same set of JSON keys with the same naming convention (camelCase).

### 5. Run the contract unit tests

```bash
cd trading_engine_python && python -m pytest tests/test_contracts.py -v
```

All tests must pass. If adding a new event/state type, add corresponding tests.

### 6. Run the cross-system integrity test

```bash
cd trading_engine_python && python -m pytest tests/test_cross_system_integrity.py -v
```

This test verifies that Python DTO keys match JS mapping function expectations.

## How to Add a New Event Type

1. **Python `contracts/events.py`**: Add a new `@dataclass` with `to_dict()`
2. **Python `contracts/common.py`**: Add the event name to `EventType`
3. **Python engine**: Use `NewEvent(...).to_dict()` in `_publish_event`
4. **JS `server/contracts/events.js`**: Add to `EVENT_TYPES`, add JSDoc `@typedef`
5. **Frontend `src/lib/contracts.js`**: Add to `WS_EVENTS`, add JSDoc `@typedef`
6. **Tests**: Add a key check in `test_contracts.py`

## How to Add a New Field to an Existing DTO

1. Add field to the Python `@dataclass` (with a default value)
2. Add it to `to_dict()` output
3. Update the JS mapping function to read the new field
4. Update JSDoc types in both JS contract files
5. Run tests: `python -m pytest tests/test_contracts.py -v`

## Design Conventions

| Convention | Rule |
|-----------|------|
| Symbol | Binance-native `BTCUSDT` everywhere except display boundary |
| Side | `BUY`/`SELL` for orders, `LONG`/`SHORT` for positions |
| Timestamps | Milliseconds (`int(time.time() * 1000)` or `ts_ms()`) |
| Field naming | `camelCase` in all JSON (Redis, events, REST) |
| ID fields | Domain-specific: `chaseId`, `scalperId`, `twapId`, `trailStopId` — never bare `id` |
| Trail pct | Standardized as `callbackPct` — no `trailPct` alias in data layer |

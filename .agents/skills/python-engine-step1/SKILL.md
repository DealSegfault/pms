---
description: Step 1 — OrderState dataclass and OrderTracker index
---

# Step 1: OrderState + OrderTracker

## Goal
Create the universal order state dataclass and the in-memory index for fast O(1) lookups.

## Prerequisites
- Read `notes/08-python-executor-architecture-v2.md` → "Layer 2: Order Management" section

## Source Patterns to Reuse

### OrderState — from market_maker.py
**Read**: `logic-money/market_maker.py` lines 41–47 (`OrderState` dataclass)

The market maker's `OrderState` has:
```python
@dataclass
class OrderState:
    order_id: Optional[str] = None
    price: Optional[Decimal] = None
    size: float = 0.0
    state: str = "idle"  # idle, placing, active, cancelling, filled, cancelled
```

**Extend this** into a full PMS order state with sub-account, origin tracking, and callbacks.

## Files to Create

### `trading_engine_python/orders/__init__.py`
Empty `__init__.py`

### `trading_engine_python/orders/state.py`
Create the `OrderState` dataclass:

```python
@dataclass
class OrderState:
    # Identity
    client_order_id: str              # PMS_{subAccountId[:8]}_{type}_{uuid}
    sub_account_id: str = ""
    exchange_order_id: Optional[str] = None
    
    # Order details
    symbol: str = ""                  # Binance format: BTCUSDT (NOT ccxt format)
    side: str = ""                    # BUY / SELL
    order_type: str = "LIMIT"        # LIMIT / MARKET / STOP_MARKET / TAKE_PROFIT_MARKET
    quantity: float = 0.0
    price: Optional[float] = None
    reduce_only: bool = False
    
    # State machine: idle → placing → active → cancelling → filled → cancelled → expired → failed
    state: str = "idle"
    
    # Fill tracking
    filled_qty: float = 0.0
    avg_fill_price: float = 0.0
    last_fill_price: float = 0.0
    last_fill_qty: float = 0.0
    
    # Metadata
    origin: str = "MANUAL"           # MANUAL / CHASE / SCALPER / TWAP / TRAIL_STOP / SURF / BASKET
    parent_id: Optional[str] = None  # Parent algo ID
    leverage: int = 1
    created_at: float = 0.0
    updated_at: float = 0.0
    
    # Callbacks (set by algo engines, called by OrderManager)
    on_fill: Optional[Callable] = None
    on_cancel: Optional[Callable] = None
    on_partial: Optional[Callable] = None
```

**State machine transitions** (feed-driven — key insight from market_maker):
```
idle ──place()──▶ placing ──feed:NEW──▶ active
                                         │
                     ┌──feed:FILLED──────┘──cancel()──▶ cancelling
                     │                                      │
                     ▼                         feed:CANCELED ▼
                   filled                              cancelled
```

### `trading_engine_python/orders/tracker.py`
Create the `OrderTracker` — maintains multiple indexes for O(1) lookup:

```python
class OrderTracker:
    """In-memory index for fast order lookup by various keys"""
    
    def __init__(self):
        self._by_client_id: Dict[str, OrderState] = {}       # client_order_id → OrderState
        self._by_exchange_id: Dict[str, str] = {}             # exchange_order_id → client_order_id
        self._by_sub_account: Dict[str, Set[str]] = {}        # sub_account_id → set of client_order_ids
        self._by_symbol: Dict[str, Set[str]] = {}             # symbol → set of client_order_ids
        self._by_parent: Dict[str, Set[str]] = {}             # parent_id → set of client_order_ids
    
    def register(self, order: OrderState): ...
    def unregister(self, client_order_id: str): ...
    def lookup(self, exchange_order_id=None, client_order_id=None) -> Optional[OrderState]: ...
    def get_by_sub_account(self, sub_account_id: str) -> List[OrderState]: ...
    def get_active_by_symbol(self, symbol: str) -> List[OrderState]: ...
    def get_by_parent(self, parent_id: str) -> List[OrderState]: ...
    def cleanup_terminal(self, max_age_seconds: float = 300): ...
```

### Client Order ID Format
Generate with:
```python
import uuid, time

def generate_client_order_id(sub_account_id: str, order_type: str) -> str:
    prefix = sub_account_id[:8]
    uid = uuid.uuid4().hex[:12]
    return f"PMS{prefix}_{order_type}_{uid}"
```
- Must be ≤ 36 chars (Binance limit)
- Prefix `PMS` enables instant routing from exchange feed
- 8-char sub-account prefix enables sub-account resolution without DB lookup

## Validation
```bash
cd /Users/mac/cgki/minimalte
python -c "from trading_engine_python.orders.state import OrderState; print('OK')"
python -c "from trading_engine_python.orders.tracker import OrderTracker; t = OrderTracker(); print('OK')"
```

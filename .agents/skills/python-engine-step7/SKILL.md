---
description: Step 7 — RiskEngine, PositionBook, TradeValidator, and Liquidation
---

# Step 7: RiskEngine + PositionBook (L1-Based Virtual Sub-Account)

## Goal
Port the risk engine from JS to Python: virtual position tracking, margin calculations, trade validation, and L1-based sub-account liquidation.

> **Key difference from Binance**: This is NOT trying to match Binance's mark-based liquidation.
> This protects virtual sub-account balances using L1 orderbook prices.

## Prerequisites
- Steps 1–6 complete (OrderManager, feeds, command handler)
- Read `notes/02-risk-engine-behaviors.md` — full risk engine documentation

## Source Code to Read

### JS Files (behavior reference — DO NOT copy verbatim, rewrite in Python)

| JS File | Lines | What to Extract |
|---------|-------|-----------------|
| `server/risk/position-book.js` | 176 | In-memory data structure, symbol→accounts index |
| `server/risk/risk-math.js` | 102 | Pure PnL/margin calculation functions |
| `server/risk/trade-validator.js` | 142 | Pre-trade validation checks (7 checks) |
| `server/risk/liquidation.js` | 671 | ADL tiers, margin ratio, liq price calc |
| `server/risk/price-service.js` | 116 | Price cascade (WS → Redis → REST) |
| `server/risk/trade-executor.js` | 1155 | DB mutations, position open/close/flip |

### Exact validation checks (from trade-validator.js):
1. Account status is ACTIVE
2. Price available for symbol
3. Leverage within account limits
4. Notional within per-trade limits
5. Total exposure within account limits
6. Available margin sufficient
7. Margin usage ratio below threshold

### ADL Tiers (from liquidation.js):
```
Tier 1 (marginRatio ≥ 0.90): Close 30% of largest position
Tier 2 (marginRatio ≥ 0.925): Close 50% of largest position
Tier 3 (marginRatio ≥ 0.95): Close ALL positions
```

### Risk Math (from risk-math.js — pure functions, trivial to port):
```python
def compute_pnl(side, entry_price, mark_price, quantity):
    if side == "LONG":
        return (mark_price - entry_price) * quantity
    return (entry_price - mark_price) * quantity

def compute_margin(notional, leverage):
    return notional / leverage

def compute_margin_ratio(maintenance_margin, equity):
    if equity <= 0:
        return 1.0
    return maintenance_margin / equity

def compute_available_margin(balance, unrealized_pnl, margin_used):
    return balance + unrealized_pnl - margin_used

def trade_signature(sub_account_id, symbol, side, quantity, price, timestamp):
    """Deterministic SHA-256 hash for dedup detection"""
    raw = f"{sub_account_id}:{symbol}:{side}:{quantity}:{price}:{timestamp}"
    return hashlib.sha256(raw.encode()).hexdigest()
```

## Files to Create

### `trading_engine_python/risk/__init__.py`
### `trading_engine_python/risk/math.py` — Pure functions (see above)
### `trading_engine_python/risk/position_book.py`

```python
@dataclass
class VirtualPosition:
    id: str                  # UUID from DB
    sub_account_id: str
    symbol: str              # Binance format
    side: str                # LONG / SHORT
    entry_price: float
    quantity: float
    notional: float
    leverage: int
    margin: float
    opened_at: float         # timestamp
    
    # Computed live (updated by risk engine on price ticks)
    mark_price: float = 0.0
    unrealized_pnl: float = 0.0
    liquidation_price: float = 0.0

class PositionBook:
    """In-memory position index (same structure as JS position-book.js)"""
    
    def __init__(self):
        self._positions: Dict[str, VirtualPosition] = {}     # position_id → VirtualPosition
        self._by_sub_account: Dict[str, Set[str]] = {}       # sub_account_id → set of position_ids
        self._by_symbol: Dict[str, Set[str]] = {}            # symbol → set of position_ids
        self._accounts: Dict[str, dict] = {}                 # sub_account_id → account metadata
    
    def add(self, position: VirtualPosition): ...
    def remove(self, position_id: str): ...
    def get(self, position_id: str) -> Optional[VirtualPosition]: ...
    def get_by_sub_account(self, sub_account_id: str) -> List[VirtualPosition]: ...
    def get_by_symbol(self, symbol: str) -> List[VirtualPosition]: ...
    def get_accounts_for_symbol(self, symbol: str) -> Set[str]: ...
```

### `trading_engine_python/risk/validator.py`
### `trading_engine_python/risk/liquidation.py`
### `trading_engine_python/risk/engine.py`

```python
class RiskEngine:
    """
    Facade composing PositionBook + PriceService + Validator + Liquidation.
    Called by OrderManager on fills, and by MarketDataService on price ticks.
    """
    
    def __init__(self, position_book, market_data, exchange_client, redis_client, db):
        ...
    
    async def load_positions(self):
        """Load all OPEN positions from DB into position book on startup"""
    
    async def validate_trade(self, sub_account_id, symbol, side, quantity, leverage) -> dict:
        """Pre-trade validation (7 checks). Returns {valid, errors, computedValues}"""
    
    async def on_order_fill(self, order: OrderState):
        """
        Called by OrderManager when a market/limit order fills.
        1. Determine if opening new position or closing existing
        2. If opening: create VirtualPosition in DB + add to book
        3. If closing: compute PnL, update DB, remove from book
        4. If flip: close existing + open new in single transaction
        5. Update balance (delta-based, never direct set)
        6. Publish position_updated / position_closed event
        7. Write risk snapshot to Redis
        """
    
    async def on_price_tick(self, symbol: str, bid: float, ask: float, mid: float):
        """
        Called by MarketDataService on every L1 orderbook update.
        1. Update mark_price on all positions for this symbol (using L1 mid)
        2. Recompute unrealized PnL
        3. Evaluate margin ratio per affected sub-account
        4. If margin breach → trigger sub-account liquidation (ADL)
        5. Write risk snapshot to Redis (used for GET /margin cold start)
        """
    
    async def on_account_update(self, data: dict):
        """
        Called by UserStreamService on ACCOUNT_UPDATE.
        Handles external position closes (reconciliation).
        """
    
    def get_account_snapshot(self, sub_account_id: str) -> dict:
        """
        Returns current account state for event-carried state.
        Called by OrderManager._publish_event() to include in events.
        
        Returns:
            { balance, equity, marginUsed, availableMargin, positions: [...] }
        """
        positions = self._position_book.get_by_sub_account(sub_account_id)
        account = self._position_book._accounts.get(sub_account_id, {})
        balance = account.get("balance", 0)
        
        margin_used = sum(p.margin for p in positions)
        unrealized_pnl = sum(p.unrealized_pnl for p in positions)
        equity = balance + unrealized_pnl
        
        return {
            "balance": balance,
            "equity": equity,
            "marginUsed": margin_used,
            "availableMargin": equity - margin_used,
            "positions": [
                {
                    "id": p.id,
                    "symbol": p.symbol,
                    "side": p.side,
                    "entryPrice": p.entry_price,
                    "quantity": p.quantity,
                    "margin": p.margin,
                    "leverage": p.leverage,
                }
                for p in positions
            ],
        }
```

### DB Access: SQLAlchemy (async)

**Connection**: `postgresql://postgres:postgres@localhost:55432/postgres`

Create SQLAlchemy models in `trading_engine_python/db/models/` matching the Prisma schema:

```python
# trading_engine_python/db/models/__init__.py
from .base import Base, engine, async_session
from .user import User
from .sub_account import SubAccount
from .virtual_position import VirtualPosition
from .trade_execution import TradeExecution
from .balance_log import BalanceLog
from .pending_order import PendingOrder
from .risk_rule import RiskRule
```

```python
# trading_engine_python/db/models/base.py
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:55432/postgres"

engine = create_async_engine(DATABASE_URL, pool_size=10, max_overflow=5)
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase):
    pass
```

```python
# trading_engine_python/db/models/virtual_position.py
from sqlalchemy import Column, String, Float, DateTime, Boolean, Index
from .base import Base
import uuid
from datetime import datetime

class VirtualPosition(Base):
    __tablename__ = "virtual_positions"
    
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    sub_account_id = Column(String, nullable=False)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)       # LONG, SHORT
    entry_price = Column(Float, nullable=False)
    quantity = Column(Float, nullable=False)
    notional = Column(Float, nullable=False)
    leverage = Column(Float, nullable=False)
    margin = Column(Float, nullable=False)
    liquidation_price = Column(Float, nullable=False)
    status = Column(String, default="OPEN")      # OPEN, CLOSED, LIQUIDATED, TAKEN_OVER
    realized_pnl = Column(Float, nullable=True)
    taken_over = Column(Boolean, default=False)
    taken_over_by = Column(String, nullable=True)
    taken_over_at = Column(DateTime, nullable=True)
    opened_at = Column(DateTime, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)
    
    __table_args__ = (
        Index('idx_vp_sub_status', 'sub_account_id', 'status'),
        Index('idx_vp_symbol_status', 'symbol', 'status'),
        Index('idx_vp_sub_symbol_side_status', 'sub_account_id', 'symbol', 'side', 'status'),
    )
```

> **IMPORTANT**: Do NOT create tables — they already exist from Prisma migrations.
> Use `Base.metadata.reflect()` or just map to existing tables.
> Column names use Prisma's `@map()` values (snake_case).

> **RULE**: Never wipe the DB.

### Orphan Recovery on Startup

```python
async def recover_orphans(exchange_client, order_tracker, redis):
    """
    On startup: reconcile exchange orders with tracked state.
    1. Query exchange for all open orders
    2. Load algo states from Redis
    3. Match exchange orders → algo states
    4. Orphans (no matching algo) → cancel
    5. Dead algos (no exchange order) → clean up Redis
    """
    open_orders = await exchange_client.get_open_orders()
    # ... reconciliation logic
```

## Validation
```bash
python -c "from trading_engine_python.risk.engine import RiskEngine; print('OK')"
python -c "from trading_engine_python.risk.math import compute_pnl; print(compute_pnl('LONG', 65000, 66000, 0.001))"
# Should print: 1.0
```

"""
contracts — Single source of truth for all cross-system DTOs.

Defines the exact JSON shapes for:
  - Commands  (Frontend → JS → Redis → Python)
  - Events    (Python → Redis → JS → Frontend)
  - State     (Python → Redis SET → JS GET → Frontend)

Conventions:
  - Symbol: Binance-native (BTCUSDT) everywhere in Redis/Python
  - Side:   BUY/SELL for orders, LONG/SHORT for positions
  - Time:   milliseconds everywhere
  - Keys:   camelCase
  - IDs:    domain-specific (chaseId, scalperId, etc.), never bare 'id'
"""

from .common import normalize_side, normalize_symbol, ts_ms, ts_s_to_ms, EventType, RedisKey
from .commands import (
    TradeCommand, LimitCommand, ScaleCommand,
    CloseCommand, CancelCommand, CancelAllCommand,
    ChaseCommand, ScalperCommand,
    TWAPCommand, TWAPBasketCommand,
    TrailStopCommand,
)
from .events import (
    OrderPlacedEvent, OrderActiveEvent, OrderFilledEvent,
    OrderCancelledEvent, OrderFailedEvent,
    ChaseProgressEvent, ChaseFilledEvent, ChaseCancelledEvent,
    ScalperProgressEvent, ScalperFilledEvent, ScalperCancelledEvent,
    TWAPProgressEvent, TWAPCompletedEvent, TWAPCancelledEvent,
    TWAPBasketProgressEvent, TWAPBasketCompletedEvent, TWAPBasketCancelledEvent,
    TrailStopProgressEvent, TrailStopTriggeredEvent, TrailStopCancelledEvent,
    PositionUpdatedEvent, PositionClosedEvent, PositionReducedEvent,
    MarginUpdateEvent, PnlUpdateEvent,
)
from .state import (
    ChaseRedisState, ScalperRedisState, TWAPRedisState, TrailStopRedisState,
    RiskSnapshot, OpenOrderSnapshot, PositionSnapshot,
    ScalperSlotSnapshot,
)

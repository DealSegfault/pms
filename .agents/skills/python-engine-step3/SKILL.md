---
description: Step 3 — OrderManager central state machine for all order types
---

# Step 3: OrderManager Core

## Goal
Create the central OrderManager that ALL order types flow through. This is the most important component — it replaces the scattered order handling across 9 JS files.

## Prerequisites
- Step 1 complete (OrderState, OrderTracker)
- Step 2 complete (ExchangeClient)
- Read `notes/08-python-executor-architecture-v2.md` → "OrderManager" section
- Read `logic-money/market_maker.py` → `update_quotes()` and `process_trades()` functions

## Key Design Insight

From `market_maker.py`:
- **REST responses do NOT drive state** — they only move `idle → placing`
- **Feed events drive ALL transitions**: `placing → active`, `active → filled`, `active → cancelled`
- **Cancel-before-reprice**: To update an order, cancel first, wait for feed confirmation, THEN place new one

From JS code:
- Each order gets a `clientOrderId` with format `PMS{subAccountId[:8]}_{type}_{uuid}`
- The user stream feeds events keyed by `clientOrderId` — enables instant routing
- Algos set callbacks (`on_fill`, `on_cancel`) — OrderManager invokes them on state transitions

## Files to Create

### `trading_engine_python/orders/manager.py`

```python
class OrderManager:
    """
    Central order state machine.
    
    EVERY order (market, limit, chase reprice, scalper layer, TWAP lot, etc.)
    goes through this class. Algo engines NEVER call the exchange directly.
    
    State transitions:
    - place_*()        → idle → placing (sends REST request)
    - on_order_update() → placing → active (feed: NEW)
    - on_order_update() → active → filled (feed: FILLED)  → calls on_fill callback
    - cancel_order()   → active → cancelling (sends cancel REST)
    - on_order_update() → cancelling → cancelled (feed: CANCELED) → calls on_cancel callback
    """
    
    def __init__(self, exchange_client: ExchangeClient, redis_client, risk_engine=None):
        self._exchange = exchange_client
        self._redis = redis_client
        self._risk = risk_engine  # Set after RiskEngine is created (Step 7)
        self._tracker = OrderTracker()
    
    # ── Public API: Place Orders ──
    
    async def place_market_order(self, sub_account_id, symbol, side, quantity, 
                                   leverage=1, origin="MANUAL", parent_id=None,
                                   on_fill=None, on_cancel=None, reduce_only=False) -> OrderState:
        """
        Place a market order and track it.
        
        Args:
            symbol: Binance format (BTCUSDT)
            side: BUY or SELL
        
        Returns: OrderState (state will be "placing", filled_qty will update async via feed)
        """
    
    async def place_limit_order(self, sub_account_id, symbol, side, quantity, price,
                                  leverage=1, origin="MANUAL", parent_id=None,
                                  on_fill=None, on_cancel=None, on_partial=None,
                                  reduce_only=False) -> OrderState:
        """Place a limit order and track it."""
    
    async def cancel_order(self, client_order_id: str) -> bool:
        """
        Cancel an order. Sets state to 'cancelling'. 
        Actual confirmation comes from the feed.
        Returns True if cancel request was sent.
        """
    
    async def cancel_all_orders_for_symbol(self, symbol: str) -> int:
        """Cancel all tracked orders for a symbol. Returns count."""
    
    async def replace_order(self, client_order_id: str, new_price: float, 
                             new_quantity: float = None) -> Optional[OrderState]:
        """
        Cancel-and-replace pattern (from market_maker update_quotes).
        1. Cancel existing order
        2. Place new order with same params but new price
        3. Link new order to same parent/callbacks
        Returns the new OrderState, or None if cancel failed.
        """
    
    # ── Feed Event Handler (called by UserStreamService) ──
    
    async def on_order_update(self, data: dict):
        """
        Called by UserStreamService on ORDER_TRADE_UPDATE.
        
        Expected data format (from binance_wss.py map_order_data_ws):
        {
            'symbol': 'BTCUSDT',
            'client_order_id': 'PMS...',
            'order_id': '123456',      # exchange order ID
            'side': 'BUY',
            'order_type': 'LIMIT',
            'order_status': 'NEW',     # NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED
            'price': '65000.00',
            'orig_qty': '0.001',
            'last_filled_qty': '0.001',
            'last_filled_price': '65001.50',
            'commission': '0.01',
            'commission_asset': 'USDT',
            'order_trade_time': 1740547200000,
            'accumulated_filled_qty': '0.001',
            'avg_price': '65001.50',
        }
        """
    
    # ── Query API ──
    
    def get_order(self, client_order_id: str) -> Optional[OrderState]: ...
    def get_active_orders(self, sub_account_id: str = None, symbol: str = None) -> List[OrderState]: ...
    def get_orders_by_parent(self, parent_id: str) -> List[OrderState]: ...
    
    # ── Redis Event Publishing ──
    
    async def _publish_event(self, event_type: str, order: OrderState, **extra):
        """
        Publish to Redis PUB/SUB for JS to forward to frontend.
        
        Channel: pms:events:{event_type}
        Payload: see notes/07-frontend-websocket-events.md for exact shapes
        
        Event types:
        - order_active   → maps to 'order_placed' on frontend
        - order_filled   → maps to 'order_filled' on frontend  
        - order_cancelled → maps to 'order_cancelled' on frontend
        """
```

## Event Payload Shapes

**CRITICAL**: The frontend expects EXACT shapes. Read `notes/07-frontend-websocket-events.md`.

### order_filled event
```json
{
    "seq": 42,
    "subAccountId": "uuid",
    "symbol": "BTCUSDT",
    "side": "BUY",
    "price": 65000,
    "quantity": 0.001,
    "exchangeOrderId": "binance-id",
    "orderType": "MARKET",
    "origin": "MANUAL",
    "account": { "balance": 1000, "equity": 1001.5, "marginUsed": 6.5, "availableMargin": 995 },
    "suppressToast": false
}
```

Note: Frontend handles any format conversion at the JS WS proxy layer if needed.

## Risk Integration Hook

OrderManager has a `_risk` property (set in Step 7). When a market order fills:
1. Call `self._risk.on_order_fill(order)` → creates/updates virtual position
2. RiskEngine publishes `position_updated` event
3. RiskEngine recalculates margin → publishes `margin_update` event

For now (Step 3), leave the `_risk` calls as no-ops or optional:
```python
if self._risk:
    await self._risk.on_order_fill(order)
```

## Validation
```bash
python -c "from trading_engine_python.orders.manager import OrderManager; print('OK')"
```

Unit test (mock exchange client):
```python
# Test state transitions
order = await manager.place_limit_order("sub1", "BTCUSDT", "BUY", 0.001, 65000)
assert order.state == "placing"

# Simulate feed event
await manager.on_order_update({"client_order_id": order.client_order_id, "order_status": "NEW", ...})
assert order.state == "active"

await manager.on_order_update({"client_order_id": order.client_order_id, "order_status": "FILLED", ...})
assert order.state == "filled"
```

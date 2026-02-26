---
description: Steps 8-10 — Algo Engines (Chase, Scalper, TWAP, TrailStop)
---

# Steps 8–10: Algo Engines

## Goal
Port algo engines from JS to Python. Each algo delegates order operations to OrderManager (never calls exchange directly). All L1-based pricing from MarketDataService.

## Prerequisites
- Steps 1–7 complete (OrderManager, feeds, risk engine)
- Read `notes/01-order-types-and-trading-routes.md` — order types with behaviors

## Design Pattern (SAME for ALL algos)

```python
class SomeAlgoEngine:
    def __init__(self, order_manager: OrderManager, market_data: MarketDataService, risk_engine: RiskEngine, redis_client):
        self._om = order_manager
        self._md = market_data
        self._risk = risk_engine
        self._redis = redis_client
        self._active: Dict[str, AlgoState] = {}  # algo_id → state
    
    async def start(self, params: dict) -> dict:
        """Start a new algo instance"""
        state = AlgoState(id=gen_id(), ...)
        self._active[state.id] = state
        
        # Place initial order via OrderManager (with callbacks)
        order = await self._om.place_limit_order(
            ..., origin="ALGO_TYPE", parent_id=state.id,
            on_fill=lambda o: self._on_fill(state, o),
            on_cancel=lambda o, r: self._on_cancel(state, o, r),
        )
        state.current_order = order
        
        # Subscribe to L1 price ticks
        self._md.subscribe(params["symbol"], lambda p: self._on_tick(state, p))
        
        # Save state to Redis
        await self._save_state(state)
        
        return {"success": True, "algoId": state.id}
    
    async def stop(self, algo_id: str):
        """Stop an algo, cancel its orders"""
        state = self._active.get(algo_id)
        if not state: return
        if state.current_order:
            await self._om.cancel_order(state.current_order.client_order_id)
        self._md.unsubscribe(state.symbol, ...)
        del self._active[algo_id]
        await self._delete_state(algo_id)
    
    async def resume_all(self):
        """On startup: scan Redis for saved algo states, resume them"""
```

---

## Step 8: ChaseEngine

**Read**: `notes/01-order-types-and-trading-routes.md` → "Chase Limit Engine" section

### Key behaviors:
- Places limit order at L1 best bid/ask ± offset
- On L1 tick: if order price is stale, cancel + replace (via `OrderManager.replace_order()`)
- Stalk modes: `none` (static), `maintain` (follow), `trail` (follow with ratchet)
- Reprice throttle: 500ms minimum between reprices
- Max distance: auto-cancel if L1 mid drifts > N% from initial
- Redis persistence: `pms:chase:{chaseId}` TTL 24h

### State:
```python
@dataclass
class ChaseState:
    id: str
    sub_account_id: str
    symbol: str
    side: str
    quantity: float
    leverage: int
    stalk_mode: str          # none, maintain, trail
    stalk_offset_pct: float
    max_distance_pct: float
    current_order: Optional[OrderState] = None
    initial_price: float = 0.0
    reprice_count: int = 0
    last_reprice_time: float = 0.0
    created_at: float = 0.0
```

### Frontend events to publish:
- `chase_progress` → on every reprice (see `notes/07-frontend-websocket-events.md`)
- `chase_filled` → on fill
- `chase_cancelled` → on cancel or distance breach

---

## Step 9: ScalperEngine

**Read**: `notes/01-order-types-and-trading-routes.md` → "Scalper Engine" section

### Key behaviors:
- Dual-leg: places layers on BOTH sides (long + short)
- Layer geometry: exponential offsets from L1 mid-price
- Skew weighting: distributes quantity across layers
- On fill: backoff the filled slot (exponential delay), then re-arm
- Per-slot, per-side fill rate limiting
- Max fills per minute (sliding window)
- Loss protection: pause slot if unrealized loss > threshold bps
- Uses CHASE internally for each layer order

### State:
```python
@dataclass
class ScalperSlot:
    layer_idx: int
    side: str
    chase_id: Optional[str] = None
    active: bool = False
    paused: bool = False
    retry_at: float = 0.0
    retry_count: int = 0
    fill_count: int = 0
    realized_pnl: float = 0.0

@dataclass
class ScalperState:
    id: str
    sub_account_id: str
    symbol: str
    long_slots: List[ScalperSlot]
    short_slots: List[ScalperSlot]
    total_fill_count: int = 0
```

### Frontend events:
- `scalper_progress` (fill count, slot status)
- `scalper_filled` (individual fill)
- `scalper_cancelled` (stopped)

---

## Step 10: TWAP + TrailStop

### TWAP
**Read**: `notes/01-order-types-and-trading-routes.md` → "TWAP Engine"
- Timer-based: fire lots at regular intervals
- Jitter: randomize interval ±30%
- Irregular: randomize lot sizes (sum = total)
- Price limit: skip lot if L1 mid exceeds limit
- Basket: multi-symbol TWAP with per-leg config
- Each lot is a market order via `OrderManager.place_market_order()`
- Redis: `pms:twap:{twapId}` TTL 12h

### Trail Stop
**Read**: `notes/01-order-types-and-trading-routes.md` → "Trail Stop"
- Subscribe to L1 ticks for the symbol
- Track extreme price (HWM for LONG, LWM for SHORT) based on L1 mid
- When L1 mid retraces N% from extreme → trigger market close
- Optional activation price
- Redis: `pms:trailstop:{trailStopId}` TTL 24h

---

## Resume on Startup

All algo states are persisted to Redis. On Python process startup:
```python
async def resume_all_algos():
    """Scan Redis for saved algo states and resume them"""
    for key in await redis.keys("pms:chase:*"):
        state = json.loads(await redis.get(key))
        chase_engine.resume(state)
    # Scalper, TWAP, TrailStop — same pattern
```

## Validation
For each algo:
1. Start via command handler
2. Verify order placed on exchange
3. Verify Redis state saved
4. Cancel via command handler
5. Verify order cancelled
6. Verify Redis state deleted
7. Verify frontend events published

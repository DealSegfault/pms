"""
UserStreamService — Connects Binance user data stream to OrderManager.

Forked from oms/exchanges/binance/binance_wss.py (381 lines).
Key changes:
- Routes ORDER_TRADE_UPDATE → OrderManager.on_order_update() (instead of Redis)
- Routes ACCOUNT_UPDATE → RiskEngine.on_account_update() (instead of Redis)
- Routes TRADE_LITE → OrderManager.on_order_update() (instead of Redis)
- Adds supervisor pattern with exponential backoff
- Adds fill price cache (bounded at 500 entries)
- Python owns user stream exclusively — JS never touches listen keys

Listen key lifecycle:
- Create on start: POST /fapi/v1/listenKey
- Keepalive every 30 min: PUT /fapi/v1/listenKey
- Expires after 60 min without keepalive
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlencode

import requests

try:
    import websockets
except ImportError:
    websockets = None  # type: ignore

logger = logging.getLogger(__name__)

# Maximum entries in the fill price cache
MAX_FILL_CACHE = 500
# Fill cache entry TTL in seconds
FILL_CACHE_TTL = 60.0


class UserStreamService:
    """
    Wraps Binance user data WebSocket and routes events to OrderManager.

    Architecture:
        BinanceWS (user stream)
            ├── ORDER_TRADE_UPDATE → _on_order_update() → OrderManager.on_order_update()
            ├── ACCOUNT_UPDATE     → _on_account_update() → RiskEngine (Step 7)
            └── TRADE_LITE         → _on_trade_lite() → OrderManager.on_order_update()
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        order_manager: Any,
        risk_engine: Any = None,
        redis_client: Any = None,
        testnet: bool = False,
        proxy_http: Optional[str] = None,
        proxy_https: Optional[str] = None,
    ):
        self._api_key = api_key
        self._api_secret = api_secret
        self._order_manager = order_manager
        self._risk_engine = risk_engine
        self._redis = redis_client

        # Binance endpoints
        if testnet:
            self._base_url = "https://testnet.binancefuture.com"
            self._ws_base = "wss://stream.binancefuture.com"
        else:
            self._base_url = "https://fapi.binance.com"
            self._ws_base = "wss://fstream.binance.com"

        # Proxy config
        self._proxies = None
        if proxy_http or proxy_https:
            self._proxies = {"http": proxy_http, "https": proxy_https}

        # State
        self._listen_key: Optional[str] = None
        self._running = False
        self._ws = None
        self._keepalive_task: Optional[asyncio.Task] = None

        # Fill price cache — bounded at 500, used for reconciliation
        self._recent_fills: OrderedDict[str, Dict] = OrderedDict()

        # Binance server time drift (ms) — synced on first signed request
        self._time_drift: int = 0
        self._drift_synced: bool = False

        # WS health flag — read by fill checker for adaptive polling rate
        self._ws_connected: bool = False

    def set_risk_engine(self, risk_engine: Any) -> None:
        """Wire up risk engine after creation (Step 7)."""
        self._risk_engine = risk_engine

    # ── Public API ──

    async def start(self) -> None:
        """Start with supervisor (auto-reconnect with exponential backoff)."""
        self._running = True  # Initialize before loop (#12)
        attempt = 0
        max_delay = 60.0

        while self._running:  # Stop gate — stop() sets _running=False (#12)
            try:
                attempt = 0
                await self._run()
            except Exception as e:
                if not self._running:
                    break  # Clean shutdown, don't reconnect
                attempt += 1
                delay = min(5.0 * (2 ** min(attempt - 1, 4)), max_delay)
                logger.warning(
                    "User stream disconnected: %s — reconnecting in %.1fs (attempt %d)",
                    e, delay, attempt,
                )
                await asyncio.sleep(delay)

    async def stop(self) -> None:
        """Graceful shutdown."""
        self._running = False
        if self._keepalive_task:
            self._keepalive_task.cancel()
        if self._ws:
            await self._ws.close()
        if self._listen_key:
            try:
                self._delete_listen_key(self._listen_key)
            except Exception:
                pass
        logger.info("UserStreamService stopped")

    # ── Main Loop ──

    async def _run(self) -> None:
        """Create listen key, connect WS, handle messages."""
        self._listen_key = self._create_listen_key()
        logger.info("Listen key acquired: %s...", self._listen_key[:16])

        # Initialize state — sync open orders with exchange
        await self._init_state()

        ws_url = f"{self._ws_base}/ws/{self._listen_key}"
        self._running = True

        # Start keepalive in background
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

        try:
            async with websockets.connect(ws_url) as ws:
                self._ws = ws
                self._ws_connected = True
                logger.info("User stream WebSocket connected")
                await self._handle_messages(ws)
        finally:
            self._ws_connected = False
            self._running = False
            if self._keepalive_task:
                self._keepalive_task.cancel()

    async def _handle_messages(self, ws) -> None:
        """Process incoming WebSocket messages."""
        async for message in ws:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON from user stream: %s", message[:100])
                continue

            event_type = data.get("e")

            if event_type == "ORDER_TRADE_UPDATE":
                await self._on_order_update(data)
            elif event_type == "ACCOUNT_UPDATE":
                await self._on_account_update(data)
            elif event_type == "TRADE_LITE":
                await self._on_trade_lite(data)
            elif event_type == "listenKeyExpired":
                logger.warning("Listen key expired — reconnecting")
                return  # Exit to trigger reconnect in supervisor
            else:
                logger.debug("Unhandled user stream event: %s", event_type)

    # ── Event Handlers ──

    async def _on_order_update(self, message: dict) -> None:
        """
        ORDER_TRADE_UPDATE → normalize and route to OrderManager.

        Raw WS format (Binance short keys):
            o.i = orderId, o.c = clientOrderId, o.s = symbol
            o.S = side, o.o = orderType, o.X = status
            o.q = origQty, o.p = price, o.l = lastFilledQty
            o.L = lastFilledPrice, o.z = cumFilledQty, o.ap = avgPrice
        """
        # Re-broadcast raw event for bot consumers (before normalization)
        await self._publish_raw_event(message)

        raw = message.get("o", {})

        mapped = {
            "order_id": str(raw.get("i", "")),
            "client_order_id": raw.get("c", ""),
            "symbol": raw.get("s", ""),
            "side": raw.get("S", ""),
            "order_type": raw.get("o", ""),
            "order_status": raw.get("X", ""),
            "orig_qty": raw.get("q", "0"),
            "price": raw.get("p", "0"),
            "last_filled_qty": raw.get("l", "0"),
            "last_filled_price": raw.get("L", "0"),
            "accumulated_filled_qty": raw.get("z", "0"),
            "avg_price": raw.get("ap", "0"),
            "commission": raw.get("n", "0"),
            "commission_asset": raw.get("N", ""),
            "order_trade_time": raw.get("T", 0),
            "reduce_only": raw.get("R", False),
        }

        # Update fill cache on fills
        status = mapped["order_status"]
        if status in ("FILLED", "PARTIALLY_FILLED"):
            self._update_fill_cache(
                mapped["symbol"],
                float(mapped["last_filled_price"]),
                mapped["side"],
            )

        # Route to OrderManager
        await self._order_manager.on_order_update(mapped)

    async def _on_account_update(self, message: dict) -> None:
        """
        ACCOUNT_UPDATE → route to RiskEngine (Step 7).
        Contains balance changes and position updates from the exchange.
        """
        # Re-broadcast raw event for bot consumers (before normalization)
        await self._publish_raw_event(message)

        if self._risk_engine:
            try:
                data = message.get("a", {})
                # Extract balance changes
                balances = data.get("B", [])
                # Extract position updates
                positions = []
                for pos in data.get("P", []):
                    positions.append({
                        "symbol": pos.get("s", ""),
                        "position_amount": float(pos.get("pa", 0)),
                        "entry_price": float(pos.get("ep", 0)),
                        "unrealized_pnl": float(pos.get("up", 0)),
                        "margin_type": pos.get("mt", ""),
                        "isolated_wallet": float(pos.get("iw", 0)),
                        "position_side": pos.get("ps", "BOTH"),
                    })

                await self._risk_engine.on_account_update({
                    "balances": balances,
                    "positions": positions,
                    "event_time": message.get("E", 0),
                    "transaction_time": message.get("T", 0),
                })
            except Exception as e:
                logger.error("Error handling ACCOUNT_UPDATE: %s", e)

    async def _publish_raw_event(self, raw_message: dict) -> None:
        """Publish raw Binance user stream event to Redis for bot WS forwarding.

        Bots connecting to the PMS WebSocket receive these events in native
        Binance format — no normalization, no sub-account resolution.
        This is purely a relay so bots don't need their own WS connection
        (Binance allows only one per API key).
        """
        if not self._redis:
            return
        try:
            await self._redis.publish("pms:events:user_stream", json.dumps(raw_message))
        except Exception as e:
            logger.error("Failed to publish raw user stream event: %s", e)

    async def _on_trade_lite(self, data: dict) -> None:
        """
        TRADE_LITE → fast fill notification. Route to OrderManager.
        TRADE_LITE arrives faster than ORDER_TRADE_UPDATE but has less data.
        """
        # Re-broadcast raw event for bot consumers
        await self._publish_raw_event(data)
        mapped = {
            "order_id": str(data.get("i", "")),
            "client_order_id": data.get("c", ""),
            "symbol": data.get("s", ""),
            "side": data.get("S", ""),
            "order_status": "FILLED",  # TRADE_LITE only fires on fills
            "last_filled_qty": str(data.get("l", "0")),
            "last_filled_price": str(data.get("L", "0")),
            "orig_qty": str(data.get("q", "0")),
            "accumulated_filled_qty": str(data.get("z", "0")),
            "avg_price": str(data.get("ap", "0")),
            "order_trade_time": data.get("T", 0),
        }

        self._update_fill_cache(
            mapped["symbol"],
            float(mapped["last_filled_price"]),
            mapped["side"],
        )

        await self._order_manager.on_order_update(mapped)

    # ── Reconnect State Sync ──

    async def _init_state(self) -> None:
        """On (re)connect, run full state reconciliation.

        First connect: recover open orders from exchange into OrderTracker.
        Reconnect: full sweep — sync all tracked orders, detect orphans,
        reconcile positions against exchange.

        This is the safety net for fills missed during WS downtime.
        """
        is_reconnect = hasattr(self, "_has_connected_before") and self._has_connected_before
        self._has_connected_before = True

        if is_reconnect:
            logger.warning("UserStream reconnected — running full state reconciliation")
        else:
            logger.info("UserStream first connect — recovering open orders")

        try:
            # Both first connect and reconnect benefit from full reconciliation
            summary = await self._order_manager.reconcile_on_reconnect()
            logger.info("Reconnect reconciliation: %s", summary)
        except Exception as e:
            logger.error("Reconnect reconciliation failed: %s", e)

        # Also recover open orders from exchange (startup path)
        if not is_reconnect:
            try:
                count = await self._order_manager.load_open_orders_from_exchange()
                if count:
                    logger.info("Recovered %d open orders from exchange on startup", count)
            except Exception as e:
                logger.error("Failed to load open orders on startup: %s", e)

    # ── Fill Price Cache ──

    def _update_fill_cache(self, symbol: str, price: float, side: str) -> None:
        """Maintain bounded fill price cache for reconciliation."""
        self._recent_fills[symbol] = {
            "price": price,
            "side": side,
            "timestamp": time.time(),
        }
        # Move to end (most recent)
        self._recent_fills.move_to_end(symbol)

        # Evict oldest if over limit
        while len(self._recent_fills) > MAX_FILL_CACHE:
            self._recent_fills.popitem(last=False)

    def get_last_fill_price(self, symbol: str) -> Optional[float]:
        """Get the most recent fill price for a symbol (if fresh)."""
        entry = self._recent_fills.get(symbol)
        if entry and (time.time() - entry["timestamp"]) < FILL_CACHE_TTL:
            return entry["price"]
        return None

    # ── Listen Key Management ──

    async def _keepalive_loop(self) -> None:
        """Keep the listen key alive every 30 minutes."""
        while self._running:
            await asyncio.sleep(1800)  # 30 minutes
            try:
                self._keepalive_listen_key(self._listen_key)
                logger.debug("Listen key keepalive sent")
            except Exception as e:
                logger.error("Listen key keepalive failed: %s", e)

    def _create_listen_key(self) -> str:
        """POST /fapi/v1/listenKey"""
        resp = self._send_request("POST", "fapi/v1/listenKey")
        return resp["listenKey"]

    def _keepalive_listen_key(self, listen_key: str) -> None:
        """PUT /fapi/v1/listenKey"""
        self._send_request("PUT", "fapi/v1/listenKey", {"listenKey": listen_key})

    def _delete_listen_key(self, listen_key: str) -> None:
        """DELETE /fapi/v1/listenKey"""
        self._send_request("DELETE", "fapi/v1/listenKey", {"listenKey": listen_key})

    # ── HTTP Helpers (from binance_wss.py) ──

    def _send_request(
        self, method: str, endpoint: str, params: Optional[dict] = None, signed: bool = False
    ) -> Any:
        """Send HTTP request to Binance API."""
        endpoint = endpoint.lstrip("/")
        url = f"{self._base_url}/{endpoint}"
        headers = {"X-MBX-APIKEY": self._api_key}

        if params is None:
            params = {}

        if signed:
            if not self._drift_synced:
                self._sync_time_drift()
            params["timestamp"] = int(time.time() * 1000) + self._time_drift
            params["recvWindow"] = 10000
            query = urlencode(params)
            params["signature"] = hmac.new(
                self._api_secret.encode(),
                query.encode(),
                hashlib.sha256,
            ).hexdigest()

        response = requests.request(
            method=method,
            url=url,
            headers=headers,
            params=params,
            proxies=self._proxies,
            verify=True,
            timeout=10,
        )
        if response.status_code >= 400:
            try:
                err_body = response.json()
            except Exception:
                err_body = response.text
            logger.error(
                "Binance API error: %s %s → %d %s",
                method, endpoint, response.status_code, err_body,
            )
            response.raise_for_status()
        return response.json()

    def _generate_signature(self, params: dict) -> str:
        """HMAC-SHA256 signature for authenticated requests."""
        query = urlencode(params)
        return hmac.new(
            self._api_secret.encode(),
            query.encode(),
            hashlib.sha256,
        ).hexdigest()

    def _sync_time_drift(self) -> None:
        """Sync local clock with Binance server time to fix signature errors."""
        try:
            resp = requests.get(
                f"{self._base_url}/fapi/v1/time",
                timeout=5,
                proxies=self._proxies,
            )
            server_time = resp.json()["serverTime"]
            local_time = int(time.time() * 1000)
            self._time_drift = server_time - local_time
            self._drift_synced = True
            if abs(self._time_drift) > 500:
                logger.warning("Clock drift detected: %dms (server - local)", self._time_drift)
            else:
                logger.debug("Time drift: %dms", self._time_drift)
        except Exception as e:
            logger.error("Failed to sync Binance server time: %s", e)
            self._time_drift = 0
            self._drift_synced = True  # Don't retry endlessly

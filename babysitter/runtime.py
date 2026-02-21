from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import aiohttp
try:
    import redis.asyncio as aioredis
except Exception:  # pragma: no cover - optional runtime dependency
    aioredis = None  # type: ignore[assignment]

from .models import TpEvaluation, UserSession, VirtualPosition
from .selector import VolatilityModeSelector
from .signals import SignalModel
from .tp_models import FastTpModel, LongShortTpModel, VolTpModel
from .utils import clamp, safe_float, side_direction, to_raw_symbol, valid_price

logger = logging.getLogger("babysitter")

BINANCE_PREMIUM_INDEX_URL = "https://fapi.binance.com/fapi/v1/premiumIndex"
BINANCE_MARK_PRICE_WS = "wss://fstream.binance.com/ws/!markPrice@arr@1s"
COMMAND_STREAM = os.environ.get("BBS_COMMAND_STREAM", "pms:babysitter:commands")
ACTION_STREAM = os.environ.get("BBS_ACTION_STREAM", "pms:babysitter:actions")
STATUS_STREAM = os.environ.get("BBS_STATUS_STREAM", "pms:babysitter:status")
STATUS_KEY = os.environ.get("BBS_STATUS_KEY", "pms:babysitter:status:last")
HEARTBEAT_KEY = os.environ.get("BBS_HEARTBEAT_KEY", "pms:babysitter:heartbeat")
COMMAND_GROUP = os.environ.get("BBS_COMMAND_GROUP", "pms-babysitter-workers")
FEATURES_STREAM = os.environ.get("BBS_FEATURES_STREAM", "pms:babysitter:features")


def _allowed_tp_mode(tp_mode: str) -> str:
    mode = str(tp_mode or "auto").strip().lower()
    if mode in {"auto", "fast", "vol", "long_short"}:
        return mode
    return "auto"


def _parse_virtual_positions(sub_account_id: str, raw_positions: Iterable[dict]) -> Dict[str, VirtualPosition]:
    positions: Dict[str, VirtualPosition] = {}

    for vp in raw_positions or []:
        if not isinstance(vp, dict):
            continue

        position_id = str(vp.get("id", "")).strip()
        symbol = str(vp.get("symbol", "")).strip()
        side = side_direction(vp.get("side", "LONG"))
        entry_price = safe_float(vp.get("entryPrice"), 0.0)
        quantity = safe_float(vp.get("quantity"), 0.0)
        notional = safe_float(vp.get("notional"), 0.0)

        if not position_id or not symbol:
            continue
        if entry_price <= 0 or quantity <= 0:
            continue
        if notional <= 0:
            notional = entry_price * quantity

        positions[position_id] = VirtualPosition(
            id=position_id,
            sub_account_id=sub_account_id,
            symbol=symbol,
            side=side,
            entry_price=entry_price,
            quantity=quantity,
            notional=notional,
        )

    return positions


def _redis_fields_to_map(fields: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for i in range(0, len(fields), 2):
        key = str(fields[i])
        val = str(fields[i + 1]) if i + 1 < len(fields) else ""
        out[key] = val
    return out


class BabysitterRuntime:
    """
    Lightweight per-account babysitter runtime.

    - Tracks active virtual positions only
    - Generates long/short signal snapshots from mark-price history
    - Auto-selects TP model (fast / vol / long_short) per position
    - Closes virtual positions through PMS callback endpoint
    """

    def __init__(
        self,
        users_config_path: str,
        v7_config_path: str = "",
        close_cooldown_sec: float = 5.0,
    ):
        self.users_config_path = Path(users_config_path)
        self.v7_config_path = v7_config_path  # accepted for compatibility, currently unused
        self.start_time = time.time()

        self.sessions: Dict[str, UserSession] = {}
        self._sessions_lock = asyncio.Lock()

        self._signals = SignalModel(max_points=1_200)
        self._selector = VolatilityModeSelector()
        self._tp_models = {
            "fast": FastTpModel(),
            "vol": VolTpModel(),
            "long_short": LongShortTpModel(),
        }

        self._mark_prices: Dict[str, float] = {}
        self._last_close_attempt: Dict[Tuple[str, str], float] = {}
        self._pending_close_ids: Set[Tuple[str, str]] = set()
        self._close_cooldown_sec = max(0.5, float(close_cooldown_sec))
        self._pending_close_stale_sec = max(15.0, self._close_cooldown_sec * 4.0)

        self.pms_api_base = (
            str(
                os.environ.get("PMS_API_URL")
                or f"http://localhost:{os.environ.get('PMS_PORT', '3900')}/api/bot"
            ).rstrip("/")
        )
        self._close_url = f"{self.pms_api_base}/babysitter/close-position"

        self._http: Optional[aiohttp.ClientSession] = None
        self._redis: Any = None
        self._consumer_id = f"babysitter-{os.getpid()}"
        self._shutting_down = False


    async def _ensure_http(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            timeout = aiohttp.ClientTimeout(total=10.0, connect=3.0, sock_read=7.0)
            self._http = aiohttp.ClientSession(timeout=timeout)
        return self._http

    async def _ensure_redis(self):
        if self._redis is not None:
            return self._redis
        if aioredis is None:
            return None

        try:
            host = os.environ.get("REDIS_HOST", "127.0.0.1")
            port = int(os.environ.get("REDIS_PORT", "6379"))
            self._redis = aioredis.Redis(
                host=host,
                port=port,
                decode_responses=True,
                socket_connect_timeout=3.0,
                socket_timeout=15.0,
                health_check_interval=10,
            )
            await self._redis.ping()
            return self._redis
        except Exception as exc:
            logger.warning("Redis unavailable for babysitter runtime: %s", exc)
            self._redis = None
            return None

    def _load_users_config(self) -> List[Dict[str, Any]]:
        try:
            if not self.users_config_path.exists():
                logger.warning("Users config missing: %s", self.users_config_path)
                return []

            text = self.users_config_path.read_text(encoding="utf-8").strip()
            if not text:
                logger.warning("Users config is empty: %s", self.users_config_path)
                return []

            payload = json.loads(text)
            users = payload.get("users", [])
            if not isinstance(users, list):
                return []
            return users
        except Exception as exc:
            logger.error("Failed reading users config: %s", exc)
            return []

    def _clear_tracking_for_sub_account(self, sub_account_id: str) -> None:
        self._pending_close_ids = {
            (sid, pid) for sid, pid in self._pending_close_ids if sid != sub_account_id
        }
        self._last_close_attempt = {
            key: ts for key, ts in self._last_close_attempt.items() if key[0] != sub_account_id
        }

    def _prune_tracking_for_sub_account(self, sub_account_id: str, active_ids: Set[str]) -> None:
        now = time.time()
        self._pending_close_ids = {
            (sid, pid)
            for sid, pid in self._pending_close_ids
            if sid != sub_account_id
            or (
                pid in active_ids
                and (now - self._last_close_attempt.get((sid, pid), 0.0)) < self._pending_close_stale_sec
            )
        }
        self._last_close_attempt = {
            key: ts
            for key, ts in self._last_close_attempt.items()
            if key[0] != sub_account_id or key[1] in active_ids
        }

    async def reload_users(self) -> Dict[str, Any]:
        users_cfg = self._load_users_config()
        desired_ids: Set[str] = set()

        async with self._sessions_lock:
            for user_cfg in users_cfg:
                if not isinstance(user_cfg, dict):
                    continue
                sub_account_id = str(user_cfg.get("subAccountId", "")).strip()
                if not sub_account_id:
                    continue

                desired_ids.add(sub_account_id)

                session = self.sessions.get(sub_account_id)
                if session is None:
                    session = UserSession(
                        user_id=str(user_cfg.get("userId", "")),
                        sub_account_id=sub_account_id,
                    )
                    self.sessions[sub_account_id] = session

                session.user_id = str(user_cfg.get("userId", session.user_id))
                session.tp_mode = _allowed_tp_mode(str(user_cfg.get("tpMode", "auto")))
                session.excluded_positions = {
                    str(pos_id) for pos_id in (user_cfg.get("excludedPositions", []) or []) if str(pos_id)
                }
                session.virtual_positions = _parse_virtual_positions(
                    sub_account_id,
                    user_cfg.get("virtualPositions", []) or [],
                )
                session.last_model_by_position = {
                    pid: model
                    for pid, model in session.last_model_by_position.items()
                    if pid in session.virtual_positions
                }
                self._prune_tracking_for_sub_account(
                    sub_account_id,
                    set(session.virtual_positions.keys()),
                )
                session.active = True
                session.error = None

            # Drop removed accounts.
            for sub_account_id in list(self.sessions.keys()):
                if sub_account_id not in desired_ids:
                    self.sessions.pop(sub_account_id, None)
                    self._clear_tracking_for_sub_account(sub_account_id)

            active_positions = sum(len(s.virtual_positions) for s in self.sessions.values())
            logger.info(
                "Reloaded users: %d account(s), %d active virtual position(s)",
                len(self.sessions),
                active_positions,
            )
            return {"ok": True, "users": len(self.sessions), "positions": active_positions}

    def _process_mark_price_row(self, row: dict, symbols: Set[str], now: float) -> None:
        """Process a single mark price row (shared between WS and REST paths)."""
        if not isinstance(row, dict):
            return
        raw_symbol = str(row.get("s", "") or row.get("symbol", "")).upper().strip()
        if not raw_symbol or raw_symbol not in symbols:
            return
        mark_price = safe_float(row.get("p", None) or row.get("markPrice", None), 0.0)
        if mark_price <= 0:
            mark_price = safe_float(row.get("indexPrice", None), 0.0)
        if mark_price <= 0:
            return
        self._mark_prices[raw_symbol] = mark_price
        self._signals.update_price(raw_symbol, mark_price, ts=now)

    async def _mark_price_ws_loop(self, stop: asyncio.Event) -> None:
        """
        Subscribe to Binance Futures !markPrice@arr@1s WebSocket stream.
        Zero API weight — prices pushed every 1s for ALL symbols.
        Auto-reconnects on disconnect with exponential backoff.
        """
        reconnect_delay = 1.0
        max_reconnect_delay = 30.0

        while not stop.is_set() and not self._shutting_down:
            session = await self._ensure_http()
            try:
                logger.info("Mark price WS connecting to %s", BINANCE_MARK_PRICE_WS)
                async with session.ws_connect(
                    BINANCE_MARK_PRICE_WS,
                    heartbeat=20.0,
                    receive_timeout=30.0,
                ) as ws:
                    logger.info("Mark price WS connected (zero API weight)")
                    reconnect_delay = 1.0  # Reset backoff on successful connect

                    async for msg in ws:
                        if stop.is_set() or self._shutting_down:
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                data = json.loads(msg.data)
                                symbols = self._required_symbols()
                                if not symbols:
                                    continue
                                now = time.time()
                                rows = data if isinstance(data, list) else [data]
                                for row in rows:
                                    self._process_mark_price_row(row, symbols, now)
                            except Exception as exc:
                                logger.debug("Mark price WS parse error: %s", exc)
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            logger.warning("Mark price WS closed/error: %s", msg.data)
                            break

            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("Mark price WS error: %s — reconnecting in %.0fs", exc, reconnect_delay)

            if stop.is_set() or self._shutting_down:
                break

            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, max_reconnect_delay)

    async def _refresh_mark_prices_once(self) -> None:
        """One-shot REST fallback — used only if WS hasn't populated prices yet."""
        symbols = self._required_symbols()
        if not symbols:
            return

        session = await self._ensure_http()
        try:
            async with session.get(BINANCE_PREMIUM_INDEX_URL) as resp:
                if resp.status != 200:
                    return
                payload = await resp.json(content_type=None)
        except Exception:
            return

        rows = payload if isinstance(payload, list) else [payload]
        now = time.time()
        # REST uses "symbol" and "markPrice" field names
        for row in rows:
            if not isinstance(row, dict):
                continue
            raw_symbol = str(row.get("symbol", "")).upper().strip()
            if raw_symbol not in symbols:
                continue
            mark_price = safe_float(row.get("markPrice"), 0.0)
            if mark_price <= 0:
                mark_price = safe_float(row.get("indexPrice"), 0.0)
            if mark_price <= 0:
                continue
            self._mark_prices[raw_symbol] = mark_price
            self._signals.update_price(raw_symbol, mark_price, ts=now)

    def _required_symbols(self) -> Set[str]:
        symbols: Set[str] = set()
        for session in self.sessions.values():
            if not session.active:
                continue
            for pos_id, position in session.virtual_positions.items():
                if pos_id in session.excluded_positions:
                    continue
                raw = to_raw_symbol(position.symbol)
                if raw:
                    symbols.add(raw)
        return symbols

    async def _publish_status(self) -> None:
        redis = await self._ensure_redis()
        if not redis:
            return
        try:
            payload = json.dumps(self.get_all_status(), separators=(",", ":"), ensure_ascii=True)
            await redis.set(STATUS_KEY, payload, ex=30)
            await redis.xadd(
                STATUS_STREAM,
                {"payload": payload, "ts": str(int(time.time() * 1000))},
                maxlen=20000,
                approximate=True,
            )
        except Exception as exc:
            logger.debug("Status publish failed: %s", exc)

    async def _heartbeat_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set() and not self._shutting_down:
            redis = await self._ensure_redis()
            if redis:
                try:
                    payload = json.dumps(
                        {
                            "ts": int(time.time() * 1000),
                            "consumer": self._consumer_id,
                            "users": len(self.sessions),
                        },
                        separators=(",", ":"),
                        ensure_ascii=True,
                    )
                    await redis.set(HEARTBEAT_KEY, payload, ex=15)
                except Exception:
                    pass
            await asyncio.sleep(5.0)

    async def _status_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set() and not self._shutting_down:
            try:
                await self._publish_status()
            except Exception as exc:
                logger.debug("Status loop error: %s", exc)
            await asyncio.sleep(1.0)

    async def _apply_sync_account(self, payload: Dict[str, Any]) -> None:
        sub_account_id = str(payload.get("subAccountId", "")).strip()
        if not sub_account_id:
            return

        enabled = bool(payload.get("enabled", True))
        if not enabled:
            async with self._sessions_lock:
                self.sessions.pop(sub_account_id, None)
            self._clear_tracking_for_sub_account(sub_account_id)
            return

        async with self._sessions_lock:
            session = self.sessions.get(sub_account_id)
            if not session:
                session = UserSession(
                    user_id=str(payload.get("userId", "")),
                    sub_account_id=sub_account_id,
                )
                self.sessions[sub_account_id] = session

            session.user_id = str(payload.get("userId", session.user_id))
            session.tp_mode = _allowed_tp_mode(str(payload.get("tpMode", session.tp_mode)))
            session.active = True
            session.error = None
            session.virtual_positions = _parse_virtual_positions(
                sub_account_id,
                payload.get("positions", []) or [],
            )
            session.excluded_positions = {
                str(x)
                for x in (payload.get("excludedPositionIds", []) or [])
                if str(x)
            }
            session.last_model_by_position = {
                pid: mode
                for pid, mode in session.last_model_by_position.items()
                if pid in session.virtual_positions
            }
            active_ids = set(session.virtual_positions.keys())

        self._prune_tracking_for_sub_account(sub_account_id, active_ids)

    async def _handle_command(self, command: str, payload: Dict[str, Any]) -> None:
        cmd = str(command or "").strip().lower()
        sub_account_id = str(payload.get("subAccountId", "")).strip()

        if cmd in {"sync_account", "upsert_account"}:
            await self._apply_sync_account(payload)
            return

        if cmd == "remove_user":
            if sub_account_id:
                async with self._sessions_lock:
                    self.sessions.pop(sub_account_id, None)
                self._clear_tracking_for_sub_account(sub_account_id)
            return

        if cmd == "reload_from_file":
            await self.reload_users()
            return

        if not sub_account_id:
            return

        async with self._sessions_lock:
            session = self.sessions.get(sub_account_id)
            if not session:
                session = UserSession(
                    user_id=str(payload.get("userId", "")),
                    sub_account_id=sub_account_id,
                )
                self.sessions[sub_account_id] = session

            if cmd == "set_tp_mode":
                session.tp_mode = _allowed_tp_mode(str(payload.get("tpMode", session.tp_mode)))
                return

            if cmd == "exclude_position":
                pid = str(payload.get("positionId", "")).strip()
                if pid:
                    session.excluded_positions.add(pid)
                return

            if cmd == "include_position":
                pid = str(payload.get("positionId", "")).strip()
                if pid:
                    session.excluded_positions.discard(pid)
                return

            if cmd == "upsert_position":
                pos = payload.get("position") or payload
                parsed = _parse_virtual_positions(sub_account_id, [pos]).values()
                for p in parsed:
                    session.virtual_positions[p.id] = p
                excluded = bool(pos.get("babysitterExcluded", False)) if isinstance(pos, dict) else False
                pid = str(pos.get("id", "")) if isinstance(pos, dict) else ""
                if pid:
                    if excluded:
                        session.excluded_positions.add(pid)
                    else:
                        session.excluded_positions.discard(pid)
                return

            if cmd == "remove_position":
                pid = str(payload.get("positionId", "")).strip()
                if pid:
                    session.virtual_positions.pop(pid, None)
                    session.excluded_positions.discard(pid)
                    session.last_model_by_position.pop(pid, None)
                    self._pending_close_ids.discard((sub_account_id, pid))
                    self._last_close_attempt.pop((sub_account_id, pid), None)
                return

    async def _command_loop(self, stop: asyncio.Event) -> None:
        last_warning_ts = 0.0
        while not stop.is_set() and not self._shutting_down:
            redis = await self._ensure_redis()
            if not redis:
                # Avoid warning spam when Redis isn't available.
                now = time.time()
                if now - last_warning_ts > 30:
                    logger.warning("Redis command loop idle: Redis unavailable")
                    last_warning_ts = now
                await asyncio.sleep(2.0)
                continue

            try:
                try:
                    await redis.xgroup_create(COMMAND_STREAM, COMMAND_GROUP, id="$", mkstream=True)
                except Exception as exc:
                    if "BUSYGROUP" not in str(exc):
                        raise

                rows = await redis.xreadgroup(
                    COMMAND_GROUP,
                    self._consumer_id,
                    streams={COMMAND_STREAM: ">"},
                    count=50,
                    block=5000,
                )
                if not rows:
                    continue

                for _, entries in rows:
                    for entry_id, fields in entries:
                        if isinstance(fields, dict):
                            m = {str(k): str(v) for k, v in fields.items()}
                        else:
                            m = _redis_fields_to_map(fields if isinstance(fields, list) else [])
                        command = m.get("command", "")
                        payload_raw = m.get("payload", "{}")
                        try:
                            payload = json.loads(payload_raw) if payload_raw else {}
                        except Exception:
                            payload = {}
                        await self._handle_command(command, payload if isinstance(payload, dict) else {})
                        await redis.xack(COMMAND_STREAM, COMMAND_GROUP, entry_id)
            except Exception as exc:
                logger.warning("Command loop error: %s", exc)
                await asyncio.sleep(1.0)

    async def _price_bootstrap(self, stop: asyncio.Event) -> None:
        """One-shot REST bootstrap to seed mark prices before WS connects."""
        try:
            await self._refresh_mark_prices_once()
            logger.info("Mark prices bootstrapped via REST (one-time)")
        except Exception as exc:
            logger.debug("Price bootstrap error: %s", exc)

    async def _evaluation_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set() and not self._shutting_down:
            try:
                await self._evaluate_positions_once()
            except Exception as exc:
                logger.warning("Evaluation loop error: %s", exc)
            await asyncio.sleep(1.0)

    async def _evaluate_positions_once(self) -> None:
        async with self._sessions_lock:
            sessions = list(self.sessions.values())

        now = time.time()
        features_batch: list[dict] = []

        for session in sessions:
            if not session.active:
                continue

            for position in list(session.virtual_positions.values()):
                # Excluded positions — record gate and skip
                if position.id in session.excluded_positions:
                    features_batch.append({
                        "positionId": position.id,
                        "subAccountId": session.sub_account_id,
                        "symbol": position.symbol,
                        "side": position.side,
                        "tpModel": "none",
                        "pnlBps": 0, "targetBps": 0,
                        "shouldClose": False,
                        "gate": "excluded",
                        "bias": "NEUTRAL", "m30": 0, "m120": 0, "vol60": 0, "edge": 0,
                    })
                    continue

                raw_symbol = to_raw_symbol(position.symbol)
                mark_price = self._mark_prices.get(raw_symbol)
                if not valid_price(mark_price):
                    features_batch.append({
                        "positionId": position.id,
                        "subAccountId": session.sub_account_id,
                        "symbol": position.symbol,
                        "side": position.side,
                        "tpModel": "none",
                        "pnlBps": 0, "targetBps": 0,
                        "shouldClose": False,
                        "gate": "no_mark_price",
                        "bias": "NEUTRAL", "m30": 0, "m120": 0, "vol60": 0, "edge": 0,
                    })
                    continue

                signal = self._signals.snapshot(raw_symbol, now=now)
                mode = self._selector.select(session.tp_mode, position, signal)
                model = self._tp_models[mode]
                evaluation = model.evaluate(position, mark_price, signal)
                session.last_model_by_position[position.id] = mode

                # Determine gate status
                gate = "ready"
                blocked = False
                key = (session.sub_account_id, position.id)

                if not evaluation.should_close:
                    gate = "below_target"
                    blocked = True
                elif key in self._pending_close_ids:
                    pending_age = now - self._last_close_attempt.get(key, 0.0)
                    if pending_age < self._pending_close_stale_sec:
                        gate = "pending_close"
                        blocked = True
                    else:
                        self._pending_close_ids.discard(key)
                if not blocked:
                    last_attempt = self._last_close_attempt.get(key, 0.0)
                    if (now - last_attempt) < self._close_cooldown_sec:
                        gate = "cooldown"
                        blocked = True

                features_batch.append({
                    "positionId": position.id,
                    "subAccountId": session.sub_account_id,
                    "symbol": position.symbol,
                    "side": position.side,
                    "tpModel": evaluation.model,
                    "pnlBps": round(evaluation.pnl_bps, 1),
                    "targetBps": round(evaluation.target_bps, 1),
                    "shouldClose": evaluation.should_close and not blocked,
                    "gate": gate,
                    "bias": signal.bias,
                    "m30": round(signal.momentum_bps_30s, 1),
                    "m120": round(signal.momentum_bps_120s, 1),
                    "vol60": round(signal.vol_bps_60s, 1),
                    "edge": round(signal.edge_bps, 1),
                })

                # Execute close if not blocked
                if not blocked and evaluation.should_close:
                    self._last_close_attempt[key] = now
                    await self._close_virtual_position(session, position, mark_price, evaluation)

        # Publish batched features to Redis stream
        if features_batch:
            await self._publish_features(features_batch)

    async def _publish_features(self, features: list[dict]) -> None:
        redis = await self._ensure_redis()
        if not redis:
            return
        try:
            payload = json.dumps(features, separators=(",", ":"), ensure_ascii=True)
            await redis.xadd(
                FEATURES_STREAM,
                {"payload": payload, "ts": str(int(time.time() * 1000))},
                maxlen=500,
                approximate=True,
            )
        except Exception as exc:
            logger.debug("Features publish failed: %s", exc)

    async def _close_virtual_position(
        self,
        session: UserSession,
        position: VirtualPosition,
        mark_price: float,
        evaluation: TpEvaluation,
    ) -> None:
        reason = f"BABYSITTER_{evaluation.model.upper()}_TP"
        payload: Dict[str, Any] = {
            "positionId": position.id,
            "closePrice": mark_price,
            "reason": reason,
            "subAccountId": session.sub_account_id,
            "symbol": position.symbol,
            "strategyModel": evaluation.model,
            "targetBps": evaluation.target_bps,
            "pnlBps": evaluation.pnl_bps,
            "ts": int(time.time() * 1000),
        }

        redis = await self._ensure_redis()
        if redis:
            try:
                await redis.xadd(
                    ACTION_STREAM,
                    {
                        "action": "close_position",
                        "payload": json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
                        "ts": str(int(time.time() * 1000)),
                    },
                    maxlen=20000,
                    approximate=True,
                )
                key = (session.sub_account_id, position.id)
                self._pending_close_ids.add(key)
                logger.info(
                    "[%s] queued close %s %s at %.6f (%s target=%.1fbp pnl=%.1fbp)",
                    session.sub_account_id[:8],
                    position.side,
                    to_raw_symbol(position.symbol),
                    mark_price,
                    evaluation.model,
                    evaluation.target_bps,
                    evaluation.pnl_bps,
                )
                return
            except Exception as exc:
                logger.warning("Action stream publish failed, using HTTP fallback: %s", exc)

        # Fallback when Redis is unavailable: call PMS endpoint directly.
        http = await self._ensure_http()
        try:
            async with http.post(self._close_url, json=payload) as resp:
                if resp.status >= 400:
                    body = await resp.text()
                    logger.warning(
                        "[%s] close failed for %s (%s): HTTP %s %s",
                        session.sub_account_id[:8],
                        position.id[:8],
                        position.symbol,
                        resp.status,
                        body[:200],
                    )
                    return
                data = await resp.json(content_type=None)
        except Exception as exc:
            logger.warning(
                "[%s] close request error for %s (%s): %s",
                session.sub_account_id[:8],
                position.id[:8],
                position.symbol,
                exc,
            )
            return

        if not data.get("success"):
            logger.warning(
                "[%s] close rejected for %s (%s): %s",
                session.sub_account_id[:8],
                position.id[:8],
                position.symbol,
                data.get("error", "unknown"),
            )
            return

        realized_pnl = safe_float(data.get("realizedPnl"), 0.0)
        session.total_trades += 1
        session.total_pnl_usd += realized_pnl
        if realized_pnl >= 0:
            session.wins += 1
        else:
            session.losses += 1

        async with self._sessions_lock:
            current = self.sessions.get(session.sub_account_id)
            if current:
                current.virtual_positions.pop(position.id, None)
                current.last_model_by_position.pop(position.id, None)
                current.excluded_positions.discard(position.id)
        self._pending_close_ids.discard((session.sub_account_id, position.id))

        logger.info(
            "[%s] Closed %s %s at %.6f (%s, target=%.1fbp, pnl=%.1fbp)",
            session.sub_account_id[:8],
            position.side,
            to_raw_symbol(position.symbol),
            mark_price,
            evaluation.model,
            evaluation.target_bps,
            evaluation.pnl_bps,
        )

    def _position_status(
        self,
        session: UserSession,
        position: VirtualPosition,
    ) -> Dict[str, Any]:
        raw_symbol = to_raw_symbol(position.symbol)
        mark_price = self._mark_prices.get(raw_symbol, position.entry_price)
        signal = self._signals.snapshot(raw_symbol)

        mode = session.last_model_by_position.get(position.id)
        if not mode:
            mode = self._selector.select(session.tp_mode, position, signal)
            session.last_model_by_position[position.id] = mode
        model = self._tp_models.get(mode, self._tp_models["fast"])
        evaluation = model.evaluate(position, mark_price, signal)

        win_rate = (session.wins / max(1, session.total_trades)) * 100.0
        vol_mult = clamp(signal.vol_bps_60s / 25.0 if signal.vol_bps_60s > 0 else 1.0, 0.5, 3.0)

        return {
            "source": "babysitter",
            "symbol": raw_symbol,
            "layers": 1,
            "max_layers": 1,
            "total_notional": position.notional,
            "avg_entry": position.entry_price,
            "spread_bps": abs(signal.momentum_bps_30s),
            "median_spread_bps": abs(signal.momentum_bps_120s) / 2.0,
            "vol_drift_mult": vol_mult,
            "edge_bps": signal.edge_bps,
            "tp_target": evaluation.target_bps,
            "min_tp_bps": 0.0,
            "current_bps": evaluation.pnl_bps,
            "realized_bps": 0.0,
            "realized_usd": session.total_pnl_usd,
            "trades": session.total_trades,
            "win_rate": win_rate,
            "recovery_debt_usd": 0.0,
            "recovery_exit_hurdle_bps": 0.0,
            "circuit_breaker_until": None,
            "babysitter_excluded": position.id in session.excluded_positions,
            "resting_tp_price": 0.0,
            "resting_tp_qty": 0.0,
            "resting_tp_order_ids": [],
            "resting_tp_slices": 0,
            "tp_model": mode,
            "signal_bias": signal.bias,
        }

    def user_status(self, sub_account_id: str) -> Dict[str, Any]:
        session = self.sessions.get(sub_account_id)
        if not session:
            return {"active": False, "error": "User not found"}

        engines = [self._position_status(session, pos) for pos in session.virtual_positions.values()]
        portfolio_notional = sum(pos.notional for pos in session.virtual_positions.values())
        total_pnl_bps = (
            (session.total_pnl_usd / portfolio_notional) * 10_000.0
            if portfolio_notional > 0
            else 0.0
        )

        return {
            "active": bool(session.active),
            "sub_account_id": session.sub_account_id,
            "session_id": f"baby_{session.sub_account_id[:8]}",
            "live": True,
            "pairs": len(engines),
            "engines": engines,
            "total_trades": session.total_trades,
            "total_pnl_usd": session.total_pnl_usd,
            "total_pnl_bps": total_pnl_bps,
            "portfolio_notional": portfolio_notional,
        }

    def get_all_status(self) -> Dict[str, Any]:
        users: Dict[str, Any] = {}
        total_trades = 0
        total_pnl = 0.0

        for sub_account_id in sorted(self.sessions.keys()):
            status = self.user_status(sub_account_id)
            users[sub_account_id] = status
            total_trades += int(status.get("total_trades", 0) or 0)
            total_pnl += float(status.get("total_pnl_usd", 0.0) or 0.0)

        return {
            "uptime_sec": time.time() - self.start_time,
            "total_users": len(self.sessions),
            "active_users": sum(1 for s in self.sessions.values() if s.active),
            "total_trades": total_trades,
            "total_pnl_usd": total_pnl,
            "users": users,
        }

    async def handle_control(self, body: Dict[str, Any]) -> Dict[str, Any]:
        action = str(body.get("action", "")).strip()
        sub_id = str(body.get("subAccountId", "")).strip()
        position_id = str(body.get("positionId", "")).strip()

        async with self._sessions_lock:
            if action == "stop_all":
                for session in self.sessions.values():
                    session.active = False
                return {"ok": True}

            session = self.sessions.get(sub_id) if sub_id else None
            if action == "stop_user":
                if not session:
                    return {"ok": False, "error": "User not found"}
                session.active = False
                return {"ok": True}

            if action == "exclude_position":
                if not session:
                    return {"ok": False, "error": "User not found"}
                if position_id:
                    session.excluded_positions.add(position_id)
                return {"ok": True, "excluded": sorted(session.excluded_positions)}

            if action == "include_position":
                if not session:
                    return {"ok": False, "error": "User not found"}
                if position_id:
                    session.excluded_positions.discard(position_id)
                return {"ok": True, "excluded": sorted(session.excluded_positions)}

        return {"ok": False, "error": f"Unknown action: {action}"}

    async def run(self, stop: asyncio.Event, port: int) -> None:
        await self.reload_users()
        await self._ensure_http()
        await self._ensure_redis()

        tasks = [
            asyncio.create_task(self._price_bootstrap(stop)),
            asyncio.create_task(self._mark_price_ws_loop(stop)),
            asyncio.create_task(self._evaluation_loop(stop)),
            asyncio.create_task(self._command_loop(stop)),
            asyncio.create_task(self._status_loop(stop)),
            asyncio.create_task(self._heartbeat_loop(stop)),
            asyncio.create_task(start_bridge(self, stop, port)),
        ]

        await stop.wait()
        self._shutting_down = True

        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        if self._http and not self._http.closed:
            await self._http.close()
        if self._redis is not None:
            try:
                await self._redis.close()
            except Exception:
                pass


async def start_bridge(runtime: BabysitterRuntime, stop: asyncio.Event, port: int) -> None:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn

    app = FastAPI(title="Babysitter Bridge", version="2.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> Dict[str, Any]:
        status = runtime.get_all_status()
        return {
            "ok": True,
            "uptime_sec": status.get("uptime_sec", 0.0),
            "users": status.get("total_users", 0),
            "active": status.get("active_users", 0),
        }

    @app.get("/status")
    def status() -> Dict[str, Any]:
        return runtime.get_all_status()

    @app.get("/status/{sub_account_id}")
    def user_status(sub_account_id: str) -> Dict[str, Any]:
        return runtime.user_status(sub_account_id)

    @app.post("/reload")
    async def reload_cfg() -> Dict[str, Any]:
        return await runtime.reload_users()

    @app.post("/control")
    async def control(body: Dict[str, Any]) -> Dict[str, Any]:
        return await runtime.handle_control(body or {})

    @app.websocket("/ws/stream")
    async def ws_stream(ws: WebSocket) -> None:
        await ws.accept()
        logger.info("Bridge WS connected")
        try:
            while True:
                await ws.send_json({"type": "status", "data": runtime.get_all_status()})
                await asyncio.sleep(1.0)
        except WebSocketDisconnect:
            logger.info("Bridge WS disconnected")
        except Exception as exc:
            logger.warning("Bridge WS error: %s", exc)

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    logger.info("Bridge API listening on port %s", port)

    serve_task = asyncio.create_task(server.serve())
    stop_task = asyncio.create_task(stop.wait())
    done, pending = await asyncio.wait(
        {serve_task, stop_task},
        return_when=asyncio.FIRST_COMPLETED,
    )

    if stop_task in done and not serve_task.done():
        server.should_exit = True
        await serve_task

    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)

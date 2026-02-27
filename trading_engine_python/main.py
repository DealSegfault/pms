"""
Python Trading Engine — Main Entry Point

Bootstraps all components and wires them together:

    ┌─────────────────────────────────────────────────────────────┐
    │                     main.py (this file)                     │
    ├──────────────┬──────────────┬───────────────┬───────────────┤
    │ ExchangeClient│ OrderManager │  RiskEngine   │ CommandHandler│
    │  (REST API)  │  (state m/c) │  (validation) │ (Redis BLPOP) │
    ├──────────────┼──────────────┼───────────────┼───────────────┤
    │ UserStream   │ MarketData   │ ChaseEngine   │ ScalperEngine │
    │  (WS feed)   │  (L1 price)  │ TWAPEngine    │ TrailStop     │
    └──────────────┴──────────────┴───────────────┴───────────────┘

Startup order (respects dependency graph):
    1. Redis + DB connections
    2. ExchangeClient (REST wrapper)
    3. OrderTracker → OrderManager
    4. MarketDataService
    5. PositionBook → RiskEngine (loads positions from DB)
    6. Algo engines (Chase, Scalper, TWAP, TrailStop)
    7. CommandHandler (wired to all above)
    8. UserStreamService (connects WS, routes to OrderManager)
    9. Main event loop — all services run concurrently via TaskGroup
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import signal
import sys

logger = logging.getLogger("trading_engine")


async def main() -> None:
    """Bootstrap and run the trading engine."""

    # ── 0. Logging ──
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    logger.info("Starting Python Trading Engine...")

    # ── 0b. Thread pool — increase from default ~12 to 32 for high-latency REST calls ──
    loop = asyncio.get_running_loop()
    loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=32))
    logger.info("ThreadPoolExecutor set to 32 workers")

    # ── 1. Configuration ──
    api_key = os.getenv("api_key", "")
    api_secret = os.getenv("api_secret", "") or os.getenv("secret", "")
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")

    if not api_key or not api_secret:
        logger.warning("BINANCE_API_KEY/SECRET not set — running in dry-run mode")

    # ── 2. Redis Connection ──
    import redis.asyncio as aioredis
    redis_client = aioredis.from_url(redis_url, decode_responses=True)
    await redis_client.ping()
    logger.info("Redis connected: %s", redis_url)

    # ── 2b. Clean stale order/algo state from previous session ──
    stale_patterns = [
        "pms:open_orders:*", "pms:active_chase:*", "pms:active_scalper:*",
        "pms:active_twap:*", "pms:active_trail_stop:*",
        "pms:chase:*", "pms:scalper:*", "pms:twap:*", "pms:trail_stop:*",
    ]
    stale_count = 0
    for pattern in stale_patterns:
        async for key in redis_client.scan_iter(match=pattern, count=100):
            await redis_client.delete(key)
            stale_count += 1
    if stale_count:
        logger.info("Cleaned %d stale Redis keys from previous session", stale_count)

    # ── 3. Database ──
    from trading_engine_python.db.base import Database
    db = Database()
    await db.connect()
    logger.info("DB connected")

    # ── 4. ExchangeClient ──
    from trading_engine_python.orders.exchange_client import ExchangeClient
    exchange = ExchangeClient(
        api_key=api_key,
        api_secret=api_secret,
    )
    logger.info("ExchangeClient created")

    # ── 4b. Exchange Info (tick sizes, step sizes, min notional) ──
    from trading_engine_python.feeds.symbol_info import SymbolInfoCache
    symbol_info = SymbolInfoCache()
    await symbol_info.load(exchange)
    logger.info("Loaded %d symbol specs", len(symbol_info))

    # ── 5. OrderManager ──
    from trading_engine_python.orders.manager import OrderManager

    order_manager = OrderManager(
        exchange_client=exchange,
        redis_client=redis_client,
        symbol_info=symbol_info,
        db=db,
    )
    logger.info("OrderManager created")

    # ── 6. DepthSupervisor + MarketDataService ──
    from trading_engine_python.feeds.depth_supervisor import DepthSupervisor
    from trading_engine_python.feeds.market_data import MarketDataService
    depth_supervisor = DepthSupervisor()
    market_data = MarketDataService(redis_client=redis_client, depth_supervisor=depth_supervisor)
    logger.info("DepthSupervisor + MarketDataService created")

    # ── 7. RiskEngine ──
    from trading_engine_python.risk.position_book import PositionBook
    from trading_engine_python.risk.engine import RiskEngine

    position_book = PositionBook()
    risk_engine = RiskEngine(
        position_book=position_book,
        market_data=market_data,
        exchange_client=exchange,
        redis_client=redis_client,
        db=db,
    )
    risk_engine.set_order_manager(order_manager)
    order_manager.set_risk_engine(risk_engine)

    # Load positions from DB
    pos_count = await risk_engine.load_positions()
    logger.info("RiskEngine loaded %d positions", pos_count)

    # ── 7b. Reconcile with exchange — close ghost positions ──
    if pos_count > 0:
        try:
            exchange_positions = await exchange.get_position_risk()
            # Build set of (symbol, side) that actually exist on exchange
            exchange_set = set()
            for ep in (exchange_positions or []):
                amt = float(ep.get("positionAmt", 0))
                if amt != 0:
                    side = "LONG" if amt > 0 else "SHORT"
                    exchange_set.add((ep.get("symbol", ""), side))

            # Check each virtual position
            stale_closed = 0
            for sub_id, entry in list(position_book._entries.items()):
                for pos_id, pos in list(entry["positions"].items()):
                    if (pos.symbol, pos.side) not in exchange_set:
                        logger.warning(
                            "Ghost position %s %s %s — not on exchange, force-closing",
                            pos.id[:8], pos.symbol, pos.side,
                        )
                        await risk_engine.force_close_stale_position(pos)
                        stale_closed += 1

            if stale_closed:
                logger.info("Reconciliation: closed %d ghost positions", stale_closed)
            else:
                logger.info("Reconciliation: all %d positions verified on exchange", pos_count)
        except Exception as e:
            logger.error("Position reconciliation failed (non-fatal): %s", e)

    # ── 7c. Recover open orders from exchange ──
    try:
        recovered = await order_manager.load_open_orders_from_exchange()
        if recovered:
            logger.info("Recovered %d open orders from exchange", recovered)
        else:
            logger.info("No open orders to recover from exchange")
    except Exception as e:
        logger.error("Open order recovery failed (non-fatal): %s", e)

    # ── 8. Algo Engines ──
    from trading_engine_python.algos.chase import ChaseEngine
    from trading_engine_python.algos.scalper import ScalperEngine
    from trading_engine_python.algos.twap import TWAPEngine
    from trading_engine_python.algos.trail_stop import TrailStopEngine

    chase = ChaseEngine(order_manager, market_data, redis_client)
    chase.start_background_tasks()  # Fill checker polling (JS startFillChecker pattern)
    scalper = ScalperEngine(order_manager, market_data, chase, redis_client)
    twap = TWAPEngine(order_manager, market_data, redis_client)
    trail_stop = TrailStopEngine(order_manager, market_data, redis_client)
    logger.info("Algo engines created (Chase, Scalper, TWAP, TrailStop)")

    # ── 9. CommandHandler ──
    from trading_engine_python.commands.handler import CommandHandler

    cmd_handler = CommandHandler(
        redis_client=redis_client,
        order_manager=order_manager,
        risk_engine=risk_engine,
    )
    cmd_handler.set_chase_engine(chase)
    cmd_handler.set_scalper_engine(scalper)
    cmd_handler.set_twap_engine(twap)
    cmd_handler.set_trail_stop_engine(trail_stop)
    logger.info("CommandHandler wired to all engines")

    # ── 10. UserStreamService ──
    from trading_engine_python.feeds.user_stream import UserStreamService

    user_stream = UserStreamService(
        api_key=api_key,
        api_secret=api_secret,
        order_manager=order_manager,
        risk_engine=risk_engine,
    )
    logger.info("UserStreamService created")

    # ── 11. Subscribe RiskEngine to L1 for all active position symbols ──
    for symbol in position_book._symbol_accounts:
        market_data.subscribe(symbol, risk_engine.on_price_tick)
        logger.info("Subscribed RiskEngine to L1 for %s", symbol)

    # ── 12. Run All Services Concurrently ──
    logger.info("All components wired — starting services...")

    shutdown_event = asyncio.Event()

    def handle_signal():
        logger.info("Shutdown signal received")
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    try:
        async with asyncio.TaskGroup() as tg:
            # Core services
            tg.create_task(cmd_handler.run())
            if api_key:
                tg.create_task(user_stream.start())

            # Periodic cleanup — expires stale orders + reclaims terminal order memory
            tg.create_task(_periodic_cleanup(order_manager, shutdown_event))

            # Wait for shutdown
            tg.create_task(_shutdown_waiter(shutdown_event, cmd_handler, user_stream))

    except* KeyboardInterrupt:
        pass
    except* asyncio.CancelledError:
        pass
    finally:
        await depth_supervisor.shutdown()
        await _cleanup(redis_client, db, user_stream, cmd_handler)
        logger.info("Python Trading Engine stopped")


async def _shutdown_waiter(event, cmd_handler, user_stream):
    """Wait for shutdown signal then stop services."""
    await event.wait()
    await cmd_handler.stop()
    await user_stream.stop()
    raise asyncio.CancelledError()


async def _periodic_cleanup(order_manager, shutdown_event, interval: float = 5.0):
    """Periodic housekeeping: expire stale orders + reclaim terminal order memory + purge ghost Redis."""
    while not shutdown_event.is_set():
        try:
            await asyncio.sleep(interval)
            cleaned = await order_manager.cleanup()
            if cleaned:
                logger.info("Periodic cleanup: %d orders cleaned", cleaned)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Periodic cleanup error: %s", e)


async def _cleanup(redis, db, user_stream, cmd_handler):
    """Graceful cleanup."""
    try:
        await cmd_handler.stop()
    except Exception:
        pass
    try:
        await user_stream.stop()
    except Exception:
        pass
    try:
        await redis.close()
    except Exception:
        pass
    try:
        await db.close()
    except Exception:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

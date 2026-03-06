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
import socket

logger = logging.getLogger("trading_engine")

EXIT_OK = 0
EXIT_FATAL_STARTUP = 78


def _classify_startup_error(exc: Exception) -> tuple[str, int, bool]:
    """Return (message, exit_code, include_traceback)."""
    error_code = getattr(exc, "error_code", None)
    message = str(exc)

    if error_code == -2015 or "Invalid API-key, IP, or permissions" in message:
        request_ip = ""
        marker = "request ip:"
        lower = message.lower()
        if marker in lower:
            raw_ip = message[lower.index(marker) + len(marker):].split(",", 1)[0].strip(" '")
            if raw_ip:
                request_ip = f" Request IP: {raw_ip}."
        return (
            "Startup aborted: Binance rejected the API credentials or IP permissions "
            "during the position-mode check. Verify api_key/api_secret, Futures API "
            "permissions, and the Binance IP whitelist." + request_ip,
            EXIT_FATAL_STARTUP,
            False,
        )

    if "Binance position mode must be one-way" in message:
        return (
            "Startup aborted: Binance Futures account is not in one-way mode. "
            "Switch Binance to dualSidePosition=false and restart.",
            EXIT_FATAL_STARTUP,
            False,
        )

    return (f"Startup failed: {message}", 1, True)


async def main() -> int:
    """Bootstrap and run the trading engine."""

    # ── 0. Logging ──
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    logger.info("Starting Python Trading Engine...")

    redis_client = None
    db = None
    user_stream = None
    cmd_handler = None
    depth_supervisor = None
    chase = None
    scalper = None
    twap = None
    trail_stop = None
    exit_code = EXIT_OK
    services_started = False
    try:
        # ── 0b. Thread pool — increase from default ~12 to 32 for high-latency REST calls ──
        loop = asyncio.get_running_loop()
        loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=32))
        logger.debug("ThreadPoolExecutor set to 32 workers")

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

        # ── 2b. Clean stale active indexes from previous session ──
        # NOTE: only clean the active indexes (rebuilt by resume). Keep pms:chase:*,
        # pms:scalper:*, pms:twap:*, pms:trail_stop:* — those are needed for resume.
        stale_patterns = [
            "pms:open_orders:*", "pms:active_chase:*", "pms:active_scalper:*",
            "pms:active_twap:*", "pms:active_trail_stop:*",
            "pms:risk:*",
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
        logger.debug("DB connected")

        # ── 4. ExchangeClient ──
        paper_mode = os.getenv("PAPER_TRADING", "0") == "1"
        if paper_mode:
            from trading_engine_python.paper.exchange import PaperExchangeClient
            exchange = PaperExchangeClient(api_key=api_key, api_secret=api_secret)
            logger.warning("")
            logger.warning("  ╔══════════════════════════════════════════════╗")
            logger.warning("  ║  🧻 PAPER TRADING MODE                      ║")
            logger.warning("  ║  No real orders — simulated execution only   ║")
            logger.warning("  ║  Real market data • Virtual balance          ║")
            logger.warning("  ╚══════════════════════════════════════════════╝")
            logger.warning("")
        else:
            from trading_engine_python.orders.exchange_client import ExchangeClient
            exchange = ExchangeClient(
                api_key=api_key,
                api_secret=api_secret,
            )
        logger.debug("ExchangeClient created (%s)", "PAPER" if paper_mode else "LIVE")

        if not paper_mode and api_key and api_secret:
            mode = await exchange.get_position_mode()
            dual_side = mode.get("dualSidePosition", False)
            if isinstance(dual_side, str):
                dual_side = dual_side.lower() == "true"
            if dual_side:
                raise RuntimeError(
                    "Binance position mode must be one-way (dualSidePosition=false) "
                    "for the net-position virtual model."
                )
            logger.debug("Verified Binance position mode: one-way")

        # ── 4b. Exchange Info (tick sizes, step sizes, min notional) ──
        from trading_engine_python.feeds.symbol_info import SymbolInfoCache
        symbol_info = SymbolInfoCache()
        await symbol_info.load(exchange)
        logger.debug("Loaded %d symbol specs", len(symbol_info))

        # ── 5. OrderManager ──
        from trading_engine_python.orders.manager import OrderManager

        order_manager = OrderManager(
            exchange_client=exchange,
            redis_client=redis_client,
            symbol_info=symbol_info,
            db=db,
        )
        logger.debug("OrderManager created")

        # ── 6. DepthSupervisor + MarketDataService ──
        from trading_engine_python.feeds.depth_supervisor import DepthSupervisor
        from trading_engine_python.feeds.market_data import MarketDataService
        from trading_engine_python.tca.quote_store import MarketQuoteStore
        depth_supervisor = DepthSupervisor()
        quote_store = MarketQuoteStore(db) if db else None
        market_data = MarketDataService(
            redis_client=redis_client,
            depth_supervisor=depth_supervisor,
            quote_store=quote_store,
        )
        order_manager.set_market_data(market_data)
        logger.debug("DepthSupervisor + MarketDataService created")

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

        # ── 7a. Server-scoped sub-account registry ──
        # Multi-server: env SERVER_SUB_ACCOUNTS=id1,id2,id3
        # Single-server: loads all ACTIVE sub-accounts from DB
        env_sub_accounts = os.environ.get("SERVER_SUB_ACCOUNTS", "")
        if env_sub_accounts:
            managed_ids = {s.strip() for s in env_sub_accounts.split(",") if s.strip()}
            logger.info(
                "Server manages %d sub-accounts from env: %s",
                len(managed_ids),
                ", ".join(s[:8] for s in managed_ids),
            )
        else:
            # Single server: manage all active accounts
            all_accounts = await db.fetch_all(
                "SELECT id FROM sub_accounts WHERE status = ?", ("ACTIVE",)
            ) if db else []
            managed_ids = {row["id"] for row in all_accounts}
            logger.info("Server manages ALL %d active sub-accounts", len(managed_ids))

        risk_engine.set_managed_accounts(managed_ids)
        order_manager.set_managed_accounts(managed_ids)

        # ── 7b. Migrate pending_orders schema (add missing columns) ──
        if db:
            try:
                # Add columns if they don't exist (idempotent)
                for col_sql in [
                    "ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS client_order_id TEXT UNIQUE",
                    "ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'MANUAL'",
                    "ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS parent_id TEXT",
                ]:
                    await db.execute(col_sql)
                # Backfill: set client_order_id = id for existing rows (id IS the clientOrderId)
                await db.execute(
                    "UPDATE pending_orders SET client_order_id = id WHERE client_order_id IS NULL"
                )
                logger.debug("PendingOrder schema migration complete")
            except Exception as e:
                logger.debug("PendingOrder migration (may already be done): %s", e)

            dup_rows = await db.fetch_all(
                """SELECT sub_account_id, symbol, COUNT(*) AS open_count
                   FROM virtual_positions
                   WHERE status = 'OPEN'
                   GROUP BY sub_account_id, symbol
                   HAVING COUNT(*) > 1"""
            )
            if dup_rows:
                details = ", ".join(
                    f"{row['sub_account_id']}:{row['symbol']} x{row['open_count']}"
                    for row in dup_rows
                )
                raise RuntimeError(
                    "One-way invariant violated in DB (multiple OPEN positions per symbol): "
                    f"{details}"
                )
            await db.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS idx_vp_one_open_per_symbol
                   ON virtual_positions(sub_account_id, symbol)
                   WHERE status = 'OPEN'"""
            )
            logger.debug("Verified one-way DB invariant: one OPEN virtual position per symbol")

        # Load positions from DB
        pos_count = await risk_engine.load_positions()
        logger.info("RiskEngine loaded %d positions", pos_count)
        await risk_engine.write_all_risk_snapshots()
        logger.debug("Published fresh startup risk snapshots")

        # ── 7c. Reconcile with exchange — close ghosts + fix quantity drift ──
        if not paper_mode and pos_count > 0:
            try:
                exchange_positions = await exchange.get_position_risk()
                normalized_positions = [
                    {
                        "symbol": ep.get("symbol", ""),
                        "position_amount": float(ep.get("positionAmt", 0) or 0),
                        "entry_price": float(ep.get("entryPrice", 0) or 0),
                    }
                    for ep in (exchange_positions or [])
                ]
                summary = await risk_engine.reconcile_exchange_snapshot(normalized_positions)
                adjusted_symbols = summary.get("adjusted_symbols", 0)
                if adjusted_symbols:
                    logger.warning(
                        "Startup backing reconcile adjusted %d symbol(s) to match exchange backing",
                        adjusted_symbols,
                    )
                else:
                    logger.debug("Startup backing reconcile found no unsupported virtual exposure")
            except Exception as e:
                logger.error("Position reconciliation failed (non-fatal): %s", e)
        elif paper_mode:
            logger.info("Skipping exchange reconciliation (paper mode)")

        # NOTE: Open order recovery is handled by UserStreamService._init_state() on first connect.
        # No need to duplicate it here.

        # Startup trade-history backfill for placement/audit gaps.
        if not paper_mode and api_key and api_secret and managed_ids:
            try:
                from trading_engine_python.orders.backfill import backfill_from_exchange

                backfill_summary = await backfill_from_exchange(
                    exchange=exchange,
                    db=db,
                    managed_accounts=managed_ids,
                )
                logger.info("Startup backfill summary: %s", backfill_summary)
            except Exception as e:
                logger.error("Startup backfill failed (non-fatal): %s", e)

        # ── 8. Event Buses (Redis Streams) ──
        from trading_engine_python.events.event_bus import TradeEventBus
        from trading_engine_python.events.runtime_bus import AlgoRuntimeBus

        event_bus = TradeEventBus(redis_client)
        runtime_bus = AlgoRuntimeBus(redis_client)
        order_manager.set_event_bus(event_bus)
        logger.debug("TradeEventBus created (stream: pms:stream:trade_events)")

        # ── 8a. Algo Engines ──
        from trading_engine_python.algos.chase import ChaseEngine
        from trading_engine_python.algos.scalper import ScalperEngine
        from trading_engine_python.algos.twap import TWAPEngine
        from trading_engine_python.algos.trail_stop import TrailStopEngine

        chase = ChaseEngine(order_manager, market_data, redis_client)
        chase.start_background_tasks()
        scalper = ScalperEngine(order_manager, market_data, chase, redis_client, runtime_bus=runtime_bus, db=db)
        twap = TWAPEngine(order_manager, market_data, redis_client)
        trail_stop = TrailStopEngine(order_manager, market_data, redis_client)
        logger.debug("Algo engines created (Chase, Scalper, TWAP, TrailStop)")

        chase.set_scalper(scalper)

        # ── 8a.1 Stream Consumers ──
        from trading_engine_python.events.algo_consumer import AlgoConsumer
        from trading_engine_python.events.lifecycle_store import LifecycleStore
        from trading_engine_python.events.order_consumer import OrderConsumer
        from trading_engine_python.events.risk_consumer import RiskConsumer
        from trading_engine_python.tca.collector import TCACollector
        from trading_engine_python.tca.market_sampler import TCAMarketSampler
        from trading_engine_python.tca.reconciler import TCAReconciler
        from trading_engine_python.tca.runtime_collector import ScalperRuntimeCollector
        from trading_engine_python.tca.rollups import TCARollupWorker
        from trading_engine_python.tca.strategy_lot_ledger import StrategyLotLedgerWorker
        from trading_engine_python.tca.strategy_sampler import StrategySessionSampler

        order_consumer = OrderConsumer(order_manager._tracker, event_bus, order_manager)
        risk_consumer = RiskConsumer(order_manager, risk_engine, redis_client, db)
        algo_consumer = AlgoConsumer(chase, scalper, twap, trail_stop)
        tca_collector = TCACollector(LifecycleStore(db)) if db else None
        runtime_collector = ScalperRuntimeCollector(db) if db else None
        tca_reconciler = TCAReconciler(db) if db else None
        tca_market_sampler = TCAMarketSampler(db, market_data, quote_store=quote_store) if db else None
        strategy_lot_ledger = StrategyLotLedgerWorker(db) if db else None
        strategy_sampler = StrategySessionSampler(db, market_data) if db else None
        tca_rollups = TCARollupWorker(db) if db else None

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
        logger.debug("CommandHandler wired to all engines")

        # ── 10. UserStreamService ──
        if paper_mode:
            from trading_engine_python.paper.feed import PaperUserStream

            user_stream = PaperUserStream(
                order_manager=order_manager,
                risk_engine=risk_engine,
                matching_engine=exchange.matching_engine,
                market_data=market_data,
            )
            logger.info("PaperUserStream created (paper mode)")
        else:
            from trading_engine_python.feeds.user_stream import UserStreamService

            user_stream = UserStreamService(
                api_key=api_key,
                api_secret=api_secret,
                order_manager=order_manager,
                risk_engine=risk_engine,
                redis_client=redis_client,
            )
            user_stream.set_event_bus(event_bus)
            logger.info("UserStreamService created (stream-first mode)")

        if paper_mode:
            chase.set_ws_health_checker(lambda: True)
        else:
            chase.set_ws_health_checker(lambda: user_stream._ws_connected)

        # ── 11. Subscribe RiskEngine to L1 for all active position symbols ──
        for symbol in position_book._symbol_accounts:
            market_data.subscribe(symbol, risk_engine.on_price_tick)
            logger.debug("Subscribed RiskEngine to L1 for %s", symbol)

        # ── 12. Run All Services Concurrently ──
        symbols_list = ", ".join(sorted(position_book._symbol_accounts)[:8])
        logger.info(
            "Engine ready: %s | %d positions | %d sub-accounts | %d symbols%s",
            "PAPER" if paper_mode else "LIVE",
            pos_count,
            len(managed_ids),
            len(position_book._symbol_accounts),
            f" ({symbols_list})" if symbols_list else "",
        )

        shutdown_event = asyncio.Event()
        parent_pid = os.getppid()

        def handle_signal():
            logger.info("Shutdown signal received")
            shutdown_event.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, handle_signal)

        services_started = True
        try:
            async with asyncio.TaskGroup() as tg:
                tg.create_task(cmd_handler.run())
                if api_key or paper_mode:
                    tg.create_task(user_stream.start())
                    ready = await user_stream.wait_until_ready(timeout=45.0)
                    if not ready:
                        raise RuntimeError("User stream initial reconciliation did not complete before resume")

                # ── 12a. Resume active algos only after user-stream initial sync/open-order recovery ──
                try:
                    resumed_chases = await chase.resume_from_redis()
                    resumed_scalpers = await scalper.resume_from_redis()
                    resumed_trail_stops = await trail_stop.resume_from_redis(risk_engine=risk_engine)
                    resumed_twaps = await twap.resume_from_redis()
                    total_resumed = resumed_chases + resumed_scalpers + resumed_trail_stops + resumed_twaps
                    if total_resumed:
                        logger.warning(
                            "Resumed %d algo(s) from checkpoint: %d chases, %d scalpers, %d trail stops, %d TWAPs",
                            total_resumed, resumed_chases, resumed_scalpers, resumed_trail_stops, resumed_twaps,
                        )
                    else:
                        logger.info("No active algos to resume from checkpoint")
                except Exception as e:
                    logger.error("Algo resume from checkpoint failed (non-fatal): %s", e)

                consumer_suffix = f"{socket.gethostname()}:{os.getpid()}"
                tg.create_task(
                    event_bus.consume(
                        consumer_name=f"order_consumer:{consumer_suffix}",
                        group_name=TradeEventBus.group_name("order_consumer"),
                        handler=order_consumer.handle,
                    )
                )
                tg.create_task(
                    event_bus.consume(
                        consumer_name=f"risk_consumer:{consumer_suffix}",
                        group_name=TradeEventBus.group_name("risk_consumer"),
                        handler=risk_consumer.handle,
                    )
                )
                tg.create_task(
                    event_bus.consume(
                        consumer_name=f"algo_consumer:{consumer_suffix}",
                        group_name=TradeEventBus.group_name("algo_consumer"),
                        handler=algo_consumer.handle,
                    )
                )
                if tca_collector:
                    tg.create_task(
                        event_bus.consume(
                            consumer_name=f"tca_collector:{consumer_suffix}",
                            group_name=TradeEventBus.group_name("tca_collector"),
                            handler=tca_collector.handle,
                        )
                    )
                if runtime_collector:
                    tg.create_task(
                        runtime_bus.consume(
                            consumer_name=f"runtime_collector:{consumer_suffix}",
                            group_name=AlgoRuntimeBus.group_name("runtime_collector"),
                            handler=runtime_collector.handle,
                        )
                    )
                if tca_reconciler:
                    tg.create_task(tca_reconciler.run(shutdown_event))
                if tca_market_sampler:
                    tg.create_task(tca_market_sampler.run(shutdown_event))
                if strategy_lot_ledger:
                    tg.create_task(strategy_lot_ledger.run(shutdown_event))
                if strategy_sampler:
                    tg.create_task(strategy_sampler.run(shutdown_event))
                if tca_rollups:
                    tg.create_task(tca_rollups.run(shutdown_event))
                tg.create_task(_periodic_cleanup(order_manager, shutdown_event))
                tg.create_task(_shutdown_waiter(
                    shutdown_event, cmd_handler, user_stream, chase, scalper, twap, trail_stop
                ))
                tg.create_task(_parent_watchdog(shutdown_event, parent_pid))

        except* KeyboardInterrupt:
            pass
        except* asyncio.CancelledError:
            pass
    except Exception as exc:
        if services_started:
            exit_code = 1
            logger.exception("Python Trading Engine crashed unexpectedly")
        else:
            message, exit_code, include_traceback = _classify_startup_error(exc)
            if include_traceback:
                logger.exception(message)
            else:
                logger.error(message)
    finally:
        await _shutdown_algos(chase, scalper, twap, trail_stop)
        if depth_supervisor is not None:
            await depth_supervisor.shutdown()
        await _cleanup(redis_client, db, user_stream, cmd_handler)
        if exit_code == EXIT_OK:
            logger.info("Python Trading Engine stopped")
        else:
            logger.error("Python Trading Engine stopped with exit code %d", exit_code)

    return exit_code


async def _shutdown_waiter(event, cmd_handler, user_stream, chase, scalper, twap, trail_stop):
    """Wait for shutdown signal then stop services."""
    await event.wait()
    await cmd_handler.stop()
    await _shutdown_algos(chase, scalper, twap, trail_stop)
    await user_stream.stop()
    raise asyncio.CancelledError()


async def _shutdown_algos(chase, scalper, twap, trail_stop):
    """Best-effort algo shutdown for graceful stop and parent death."""
    for engine in (scalper, twap, trail_stop, chase):
        if engine is None or not hasattr(engine, "shutdown"):
            continue
        try:
            await engine.shutdown()
        except Exception as e:
            logger.error("Algo shutdown failed for %s: %s", engine.__class__.__name__, e)


async def _parent_watchdog(shutdown_event, parent_pid: int, interval: float = 1.0):
    """Exit if the parent Node process dies and leaves this engine orphaned."""
    if parent_pid <= 1:
        return
    while not shutdown_event.is_set():
        await asyncio.sleep(interval)
        current_ppid = os.getppid()
        if current_ppid == parent_pid:
            continue
        logger.error(
            "Parent process changed (expected pid=%d, current ppid=%d) — shutting down Python engine",
            parent_pid, current_ppid,
        )
        shutdown_event.set()
        return


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
        if cmd_handler is not None:
            await cmd_handler.stop()
    except Exception:
        pass
    try:
        if user_stream is not None:
            await user_stream.stop()
    except Exception:
        pass
    try:
        if redis is not None:
            await redis.close()
    except Exception:
        pass
    try:
        if db is not None:
            await db.close()
    except Exception:
        pass


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(EXIT_OK)

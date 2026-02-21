#!/usr/bin/env python3
"""CLI for v7 history sync service and query API."""

import argparse
import asyncio
import logging
import os
import signal
import sys
from typing import Optional

import uvicorn

from bot.v7.exchange import load_api_keys
from bot.v7.services.api import create_history_api
from bot.v7.services.history_sync import BinanceHistorySyncService, SyncConfig


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_api_keys(env_path: Optional[str], profile: Optional[str]) -> tuple[str, str]:
    path = env_path or os.path.join(_project_root(), ".env")
    profile_name = str(profile or "").strip()
    return load_api_keys(
        env_path=path,
        profile=profile_name,
        strict_profile=bool(profile_name),
    )


def _build_config(args) -> SyncConfig:
    return SyncConfig(
        db_path=os.path.abspath(args.db_path),
        request_rate_per_sec=args.request_rate,
        request_burst=args.request_burst,
        order_limit=args.order_limit,
        trade_limit=args.trade_limit,
        poll_interval_sec=args.poll,
        overlap_ms=args.overlap_ms,
        websocket_enabled=not args.no_ws,
        default_backfill_days=args.days,
        account_scope=(args.account_scope or args.profile or ""),
    )


async def _run_backfill(args) -> int:
    api_key, secret = _load_api_keys(args.env, args.profile)
    if not api_key or not secret:
        print("ERROR: API keys missing. Configure .env with api_key and secret", file=sys.stderr)
        return 1

    cfg = _build_config(args)
    svc = BinanceHistorySyncService(api_key, secret, config=cfg, testnet=args.testnet)
    try:
        await svc.initialize()
        symbols = await svc.discover_symbols()
        if not symbols:
            print("ERROR: no perp symbols discovered from exchange markets", file=sys.stderr)
            return 1

        out = await svc.backfill(
            symbols=symbols,
            start_ms=args.start_ms,
            end_ms=args.end_ms,
            days=args.days,
        )
        print("Backfill complete")
        for symbol, stats in out.items():
            print(f"  {symbol:<12s} orders={stats['orders']:>6d} trades={stats['trades']:>6d}")
        print("Status:", svc.sync_status())
        return 0
    finally:
        await svc.close()


async def _run_sync_once(args) -> int:
    api_key, secret = _load_api_keys(args.env, args.profile)
    if not api_key or not secret:
        print("ERROR: API keys missing. Configure .env with api_key and secret", file=sys.stderr)
        return 1

    cfg = _build_config(args)
    svc = BinanceHistorySyncService(api_key, secret, config=cfg, testnet=args.testnet)
    try:
        await svc.initialize()
        symbols = await svc.discover_symbols()
        if not symbols:
            print("ERROR: no perp symbols discovered from exchange markets", file=sys.stderr)
            return 1

        out = await svc.sync_once(symbols=symbols, lookback_ms=args.lookback_ms)
        print("Sync-once complete")
        for symbol, stats in out.items():
            print(f"  {symbol:<12s} orders={stats['orders']:>6d} trades={stats['trades']:>6d}")
        print("Status:", svc.sync_status())
        return 0
    finally:
        await svc.close()


async def _run_live(args) -> int:
    api_key, secret = _load_api_keys(args.env, args.profile)
    if not api_key or not secret:
        print("ERROR: API keys missing. Configure .env with api_key and secret", file=sys.stderr)
        return 1

    cfg = _build_config(args)
    svc = BinanceHistorySyncService(api_key, secret, config=cfg, testnet=args.testnet)
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    try:
        await svc.initialize()
        symbols = await svc.discover_symbols()
        if not symbols:
            print("ERROR: no perp symbols discovered from exchange markets", file=sys.stderr)
            return 1

        print(f"Starting live sync for {len(symbols)} symbols...")
        print("Symbols:", ", ".join(symbols))
        await svc.run_live_sync(symbols=symbols, stop_event=stop, poll_interval_sec=args.poll)
        print("Live sync stopped")
        print("Status:", svc.sync_status())
        return 0
    finally:
        await svc.close()


def _run_api(args) -> int:
    app = create_history_api(args.db_path)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level.lower())
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="V7 history sync service")
    p.add_argument("command", choices=["backfill", "sync-once", "live", "api"]) 

    # Shared options
    p.add_argument("--db-path", default=os.path.join(_project_root(), "v7_sessions", "history.db"))
    p.add_argument("--env", default=None, help="Optional path to .env")
    p.add_argument("--profile", default=None, help="Optional credential profile / subaccount alias")
    p.add_argument("--account-scope", default=None, help="Optional storage namespace override")
    p.add_argument("--testnet", action="store_true")

    p.add_argument("--request-rate", type=float, default=3.0)
    p.add_argument("--request-burst", type=float, default=6.0)
    p.add_argument("--order-limit", type=int, default=1000)
    p.add_argument("--trade-limit", type=int, default=1000)
    p.add_argument("--poll", type=float, default=2.0)
    p.add_argument("--overlap-ms", type=int, default=1500)
    p.add_argument("--no-ws", action="store_true", help="Disable user-stream websocket and use polling only")

    # Backfill/sync options
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--start-ms", type=int, default=None)
    p.add_argument("--end-ms", type=int, default=None)
    p.add_argument("--lookback-ms", type=int, default=300000)

    # API options
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--log-level", default="info")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.command == "api":
        return _run_api(args)
    if args.command == "backfill":
        return asyncio.run(_run_backfill(args))
    if args.command == "sync-once":
        return asyncio.run(_run_sync_once(args))
    if args.command == "live":
        return asyncio.run(_run_live(args))

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

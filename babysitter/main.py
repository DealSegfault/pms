from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import time

from .runtime import BabysitterRuntime


def main() -> None:
    parser = argparse.ArgumentParser(description="Lightweight Babysitter Runtime")
    parser.add_argument(
        "--config",
        type=str,
        default="babysitter_users.json",
        help="Path to users config JSON",
    )
    parser.add_argument(
        "--v7-config",
        type=str,
        default="",
        help="Compatibility arg (currently unused)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=7700,
        help="Bridge API port",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-18s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )

    print(
        f"""
╔══════════════════════════════════════════════════╗
║             LIGHTWEIGHT BABYSITTER              ║
║    Active virtual positions • TP-only runtime   ║
╚══════════════════════════════════════════════════╝

  Users config: {args.config}
  Compat cfg:   {args.v7_config or "(unused)"}
  Bridge port:  {args.port}
  Started at:   {time.strftime("%Y-%m-%d %H:%M:%S")}
"""
    )

    runtime = BabysitterRuntime(
        users_config_path=args.config,
        v7_config_path=args.v7_config,
    )
    stop_event = asyncio.Event()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    try:
        loop.run_until_complete(runtime.run(stop_event, port=args.port))
    except KeyboardInterrupt:
        stop_event.set()
    finally:
        loop.run_until_complete(asyncio.sleep(0))
        loop.close()


if __name__ == "__main__":
    main()


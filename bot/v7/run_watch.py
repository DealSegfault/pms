#!/usr/bin/env python3
"""
V7 Auto-Restart File Watcher

Wraps run.py with automatic restart on code/config changes.
State persists across restarts via runtime state files.

Usage:
    python -m v7.run_watch --live --duration 3600
    python -m v7.run_watch --live  # run forever with hot-reload
"""

import os
import sys
import signal
import subprocess
import time
import logging
from pathlib import Path

logger = logging.getLogger("v7.run_watch")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)-20s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)

# Watched directory
V7_DIR = Path(__file__).parent.resolve()
DEBOUNCE_SEC = 2.0
RESTART_DELAY_SEC = 3.0

# File extensions to watch
WATCH_EXTENSIONS = {".py", ".yaml", ".yml"}
# Files to ignore
IGNORE_PATTERNS = {"__pycache__", ".pyc", "run_watch.py", "v7_sessions"}


def should_watch(path: str) -> bool:
    """Filter: only restart on relevant file changes."""
    p = Path(path)
    # Ignore pycache, sessions, and the watcher itself
    for ignore in IGNORE_PATTERNS:
        if ignore in str(p):
            return False
    return p.suffix in WATCH_EXTENSIONS


def run_bot(args: list[str]) -> subprocess.Popen:
    """Start the bot as a subprocess."""
    cmd = [sys.executable, "-m", "v7.run"] + args
    logger.info(f"🚀 Starting bot: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(V7_DIR.parent),  # run from har/
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    return proc


def stop_bot(proc: subprocess.Popen, timeout: int = 30) -> int:
    """Gracefully stop the bot with SIGINT, wait for clean shutdown."""
    if proc.poll() is not None:
        return proc.returncode

    logger.info("🛑 Sending SIGINT for graceful shutdown...")
    proc.send_signal(signal.SIGINT)

    try:
        code = proc.wait(timeout=timeout)
        logger.info(f"✅ Bot stopped cleanly (exit code {code})")
        return code
    except subprocess.TimeoutExpired:
        logger.warning("⚠️ Bot didn't stop in time, sending SIGKILL")
        proc.kill()
        proc.wait()
        return -9


def main():
    from watchfiles import watch, Change

    # Pass through all args to run.py
    bot_args = sys.argv[1:]

    logger.info("=" * 60)
    logger.info("  V7 HOT-RELOAD WATCHER")
    logger.info(f"  Watching: {V7_DIR}")
    logger.info(f"  Extensions: {WATCH_EXTENSIONS}")
    logger.info(f"  Bot args: {bot_args}")
    logger.info("=" * 60)

    proc = run_bot(bot_args)

    try:
        for changes in watch(
            V7_DIR,
            debounce=int(DEBOUNCE_SEC * 1000),
            step=200,
            watch_filter=lambda change, path: should_watch(path),
            stop_event=None,
        ):
            # Filter relevant changes
            relevant = [
                (change_type, path)
                for change_type, path in changes
                if should_watch(path)
            ]
            if not relevant:
                continue

            # Log what changed
            for change_type, path in relevant:
                rel = Path(path).relative_to(V7_DIR)
                change_name = {
                    Change.added: "added",
                    Change.modified: "modified",
                    Change.deleted: "deleted",
                }.get(change_type, "changed")
                logger.info(f"📝 File {change_name}: {rel}")

            # Check if bot is still alive
            if proc.poll() is not None:
                logger.info("Bot already stopped, restarting...")
            else:
                stop_bot(proc)

            # Brief delay for file system to settle
            time.sleep(RESTART_DELAY_SEC)

            # Restart
            logger.info("🔄 Restarting bot with updated code...")
            proc = run_bot(bot_args)

    except KeyboardInterrupt:
        logger.info("\n🛑 Watcher stopped by user")
        stop_bot(proc)
        sys.exit(0)


if __name__ == "__main__":
    main()

"""
Order Backfill — Sync DB with exchange trade history on startup.

On each start, queries the exchange for recent trades and ensures all
PMS-tagged fills are recorded in the DB. This catches orders that were
placed but crashed before DB persistence.

This is a one-time sync per startup — not a continuous process.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional, Set

from .state import derive_legacy_routing_prefix, derive_routing_prefix

logger = logging.getLogger(__name__)


async def backfill_from_exchange(
    exchange: Any,
    db: Any,
    managed_accounts: Set[str],
    symbols: Optional[list] = None,
    limit: int = 200,
) -> dict:
    """Sync DB with exchange trade history for managed sub-accounts.

    For each active symbol, queries last `limit` trades from exchange,
    finds PMS-tagged ones that are missing from DB, and backfills them.

    Args:
        exchange: ExchangeClient instance
        db: Database instance
        managed_accounts: Set of sub-account IDs this server manages
        symbols: Optional list of symbols to check (None = use positions)
        limit: Max trades per symbol to fetch

    Returns:
        Summary dict with counts of backfilled orders
    """
    if not db or not exchange:
        return {"status": "skipped", "reason": "no db or exchange"}

    t0 = time.time()
    backfilled = 0
    checked = 0
    errors = 0

    # Build prefix set for quick ownership checks
    prefix_to_sub = {}
    for sub_id in managed_accounts:
        prefix_to_sub[derive_routing_prefix(sub_id)] = sub_id
        prefix_to_sub[derive_legacy_routing_prefix(sub_id)] = sub_id

    # Determine which symbols to check
    if not symbols:
        # Get symbols from open orders + positions
        try:
            open_orders = await exchange.get_open_orders()
            symbols = list(set(
                o.get("symbol", "") for o in (open_orders or [])
                if o.get("clientOrderId", "").startswith("PMS")
            ))
        except Exception as e:
            logger.error("Backfill: failed to get open orders: %s", e)
            symbols = []

    if not symbols:
        return {"status": "ok", "backfilled": 0, "reason": "no active symbols"}

    for symbol in symbols:
        try:
            trades = await exchange.get_account_trades(symbol=symbol, limit=limit)
        except Exception as e:
            logger.error("Backfill: failed to get trades for %s: %s", symbol, e)
            errors += 1
            continue

        for trade in (trades or []):
            coid = trade.get("clientOrderId", "") or ""
            if not coid.startswith("PMS"):
                continue

            checked += 1

            # Verify ownership
            stripped = coid[3:]
            parts = stripped.split("_", 2)
            sub_prefix = parts[0] if parts else ""
            if sub_prefix not in prefix_to_sub:
                continue  # Not our order

            # Check if already in DB
            existing = await db.fetch_one(
                "SELECT id FROM pending_orders WHERE client_order_id = ?",
                (coid,),
            )
            if existing:
                continue  # Already tracked

            # Backfill
            sub_id = prefix_to_sub[sub_prefix]
            eid = str(trade.get("orderId", ""))
            side_map = {"BUY": "LONG", "SELL": "SHORT"}
            db_side = side_map.get(trade.get("side", ""), "LONG")

            try:
                import uuid
                await db.execute(
                    """INSERT INTO pending_orders
                       (id, sub_account_id, client_order_id, symbol, side, type,
                        price, quantity, leverage, exchange_order_id, origin,
                        status, created_at)
                       VALUES (?, ?, ?, ?, ?, 'LIMIT', ?, ?, 1, ?, 'BOT', 'FILLED', datetime('now'))""",
                    (str(uuid.uuid4()), sub_id, coid, symbol, db_side,
                     float(trade.get("price", 0)), float(trade.get("qty", 0)),
                     eid),
                )
                backfilled += 1
                logger.info("Backfilled order: %s %s %s @ %.6f",
                            coid, symbol, db_side, float(trade.get("price", 0)))
            except Exception as e:
                if "duplicate" not in str(e).lower() and "unique" not in str(e).lower():
                    logger.error("Backfill insert error for %s: %s", coid, e)
                    errors += 1

    elapsed = time.time() - t0
    summary = {
        "status": "ok",
        "backfilled": backfilled,
        "checked": checked,
        "errors": errors,
        "elapsed_ms": int(elapsed * 1000),
    }
    if backfilled:
        logger.warning("Backfill complete: %d orders synced from exchange (checked %d, errors %d), %.1fs",
                        backfilled, checked, errors, elapsed)
    else:
        logger.info("Backfill: all %d PMS trades already in DB (%.1fs)", checked, elapsed)
    return summary

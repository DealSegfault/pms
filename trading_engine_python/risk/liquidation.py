"""
Liquidation engine — ADL-tier sub-account liquidation using L1 prices.

Ported from JS server/risk/liquidation.js ADL logic.

Key difference from Binance: This does NOT match Binance's mark-based liquidation.
This protects virtual sub-account balances using L1 orderbook prices.

ADL Tiers:
    Tier 1 (marginRatio >= 0.90): Close 30% of largest position
    Tier 2 (marginRatio >= 0.925): Close 50% of largest position
    Tier 3 (marginRatio >= 0.95): Close ALL positions
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional, Tuple

from .math import compute_pnl, compute_margin_ratio
from .position_book import PositionBook, VirtualPos

logger = logging.getLogger(__name__)

# ADL tiers: (threshold, close_fraction, description)
ADL_TIERS = [
    (0.95, 1.00, "TIER_3_CLOSE_ALL"),
    (0.925, 0.50, "TIER_2_CLOSE_50"),
    (0.90, 0.30, "TIER_1_CLOSE_30"),
]


class LiquidationEngine:
    """
    Evaluates margin ratios per sub-account and triggers ADL liquidation.
    Called by RiskEngine on every price tick.
    """

    def __init__(self, position_book: PositionBook, order_manager: Any = None):
        self._book = position_book
        self._order_manager = order_manager  # wired up later

    def set_order_manager(self, om: Any) -> None:
        self._order_manager = om

    def evaluate_account(
        self,
        sub_account_id: str,
        price_lookup: Any,
    ) -> Optional[Tuple[str, float, List[VirtualPos]]]:
        """
        Evaluate margin ratio for a sub-account against ADL tiers.

        Args:
            sub_account_id: account to evaluate
            price_lookup: function(symbol) → mid_price or None

        Returns:
            (tier_name, margin_ratio, affected_positions) if breach detected, else None
        """
        entry = self._book.get_entry(sub_account_id)
        if not entry:
            return None

        account = entry["account"]
        if account.get("status") != "ACTIVE":
            return None

        positions = list(entry["positions"].values())
        if not positions:
            return None

        balance = account.get("currentBalance", 0)
        maintenance_rate = account.get("maintenanceRate", 0.005)

        # Compute total unrealized PnL and notional
        total_upnl = 0.0
        total_notional = 0.0
        for pos in positions:
            mark = price_lookup(pos.symbol)
            if mark is None:
                mark = pos.entry_price  # Fallback: no price change
            pos.mark_price = mark
            pos.unrealized_pnl = compute_pnl(pos.side, pos.entry_price, mark, pos.quantity)
            total_upnl += pos.unrealized_pnl
            total_notional += pos.notional

        equity = balance + total_upnl
        maintenance_margin = total_notional * maintenance_rate
        margin_ratio = compute_margin_ratio(maintenance_margin, equity)

        # Check tiers (highest first)
        for threshold, close_fraction, tier_name in ADL_TIERS:
            liq_threshold = account.get("liquidationThreshold", 0.90)
            # Adjust threshold based on account liquidation threshold
            adj_threshold = min(threshold, liq_threshold + (threshold - 0.90))
            
            if margin_ratio >= adj_threshold:
                # Determine which positions to close
                if close_fraction >= 1.0:
                    affected = positions
                else:
                    # Close the largest position (by notional) partially
                    largest = max(positions, key=lambda p: p.notional)
                    affected = [largest]

                logger.warning(
                    "LIQUIDATION %s: account=%s ratio=%.3f threshold=%.3f positions=%d",
                    tier_name, sub_account_id, margin_ratio, adj_threshold, len(affected),
                )
                return (tier_name, margin_ratio, affected)

        return None

    async def execute_liquidation(
        self,
        sub_account_id: str,
        tier: str,
        margin_ratio: float,
        positions: List[VirtualPos],
    ) -> List[dict]:
        """
        Execute liquidation by closing positions via OrderManager.
        
        Returns list of {position_id, close_quantity, tier} for each close.
        """
        if not self._order_manager:
            logger.error("Cannot liquidate — no OrderManager wired")
            return []

        results = []
        close_fraction = 1.0
        for threshold, frac, name in ADL_TIERS:
            if tier == name:
                close_fraction = frac
                break

        for pos in positions:
            close_qty = pos.quantity * close_fraction
            close_side = "SELL" if pos.side == "LONG" else "BUY"

            try:
                order = await self._order_manager.place_market_order(
                    sub_account_id=sub_account_id,
                    symbol=pos.symbol,
                    side=close_side,
                    quantity=close_qty,
                    reduce_only=True,
                    origin="LIQUIDATION",
                    parent_id=pos.id,
                )
                results.append({
                    "position_id": pos.id,
                    "close_quantity": close_qty,
                    "tier": tier,
                    "order_id": order.client_order_id,
                })
                logger.warning(
                    "Liquidation order placed: pos=%s qty=%.6f tier=%s",
                    pos.id, close_qty, tier,
                )
            except Exception as e:
                logger.error("Liquidation order FAILED: pos=%s — %s", pos.id, e)
                results.append({
                    "position_id": pos.id,
                    "close_quantity": close_qty,
                    "tier": tier,
                    "error": str(e),
                })

        return results

    async def get_rules(self, sub_account_id: str) -> dict:
        """Get risk rules for an account (from PositionBook cache)."""
        entry = self._book.get_entry(sub_account_id)
        if entry and entry.get("rules"):
            return entry["rules"]
        # Default rules
        return {
            "max_leverage": 100,
            "max_notional_per_trade": 200,
            "max_total_exposure": 500,
            "liquidation_threshold": 0.90,
        }

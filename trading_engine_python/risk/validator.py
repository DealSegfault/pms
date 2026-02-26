"""
TradeValidator — Pre-trade validation logic (7 checks).

Ported from JS server/risk/trade-validator.js.
All deps injected via constructor for testability.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

from .math import compute_pnl, compute_available_margin, compute_margin_usage_ratio
from .position_book import PositionBook

logger = logging.getLogger(__name__)

# Default risk limits (used when no RiskRule found for account)
DEFAULT_RULES = {
    "max_leverage": 100,
    "max_notional_per_trade": 200,
    "max_total_exposure": 500,
    "liquidation_threshold": 0.90,
}


class TradeValidator:
    """
    Pre-trade validation — 7 checks from JS trade-validator.js.
    
    1. Account status is ACTIVE
    2. Price available for symbol
    3. Leverage within account limits
    4. Notional within per-trade limits
    5. Total exposure within account limits
    6. Available margin sufficient
    7. Margin usage ratio below threshold (98%)
    """

    def __init__(
        self,
        position_book: PositionBook,
        market_data: Any,
        db_session_factory: Any = None,
    ):
        self._book = position_book
        self._market_data = market_data
        self._db = db_session_factory

    async def validate(
        self,
        sub_account_id: str,
        symbol: str,
        side: str,
        quantity: float,
        leverage: int,
    ) -> dict:
        """
        Validate a trade before execution.
        
        Returns: {valid: bool, errors: [...], computed_values: {...}}
        """
        errors: List[str] = []

        # ── 1. Account status ──
        entry = self._book.get_entry(sub_account_id)
        if not entry:
            return {"valid": False, "errors": ["ACCOUNT_NOT_FOUND"]}

        account = entry["account"]
        if account.get("status") != "ACTIVE":
            return {"valid": False, "errors": [f"ACCOUNT_FROZEN:{account.get('status')}"]}

        rules = entry.get("rules") or DEFAULT_RULES

        # ── 2. Price available ──
        l1 = self._market_data.get_l1(symbol) if self._market_data else None
        price = l1["mid"] if l1 else None
        if not price:
            return {"valid": False, "errors": ["NO_PRICE"]}

        notional = quantity * price
        required_margin = notional / leverage if leverage > 0 else notional

        # ── 3. Leverage check ──
        max_lev = rules.get("max_leverage", DEFAULT_RULES["max_leverage"])
        if leverage > max_lev:
            errors.append(f"MAX_LEVERAGE:{leverage}>{max_lev}")

        # ── 4. Notional check ──
        max_notional = rules.get("max_notional_per_trade", DEFAULT_RULES["max_notional_per_trade"])
        if notional > max_notional:
            errors.append(f"MAX_NOTIONAL:{notional:.2f}>{max_notional}")

        # ── 5-7. Position-aware checks ──
        positions = list(entry["positions"].values())
        opposite_side = "SHORT" if side == "LONG" else "LONG"

        # Find opposite position for flip detection
        opposite_pos = None
        opposite_notional = 0.0
        opposite_pnl = 0.0
        for p in positions:
            if p.symbol == symbol and p.side == opposite_side:
                opposite_pos = p
                opposite_notional = p.notional
                opposite_pnl = compute_pnl(opposite_side, p.entry_price, price, p.quantity)
                break

        # Total exposure check
        current_exposure = sum(p.notional for p in positions) - opposite_notional
        max_exposure = rules.get("max_total_exposure", DEFAULT_RULES["max_total_exposure"])
        if current_exposure + notional > max_exposure:
            errors.append(f"MAX_EXPOSURE:{current_exposure + notional:.2f}>{max_exposure}")

        # Compute total unrealized PnL using current prices
        total_upnl = 0.0
        for p in positions:
            p_l1 = self._market_data.get_l1(p.symbol) if self._market_data else None
            mark = p_l1["mid"] if p_l1 else p.entry_price
            total_upnl += compute_pnl(p.side, p.entry_price, mark, p.quantity)

        total_notional = sum(p.notional for p in positions)
        balance = account.get("currentBalance", 0)
        maintenance_rate = account.get("maintenanceRate", 0.005)

        margin_info = compute_available_margin(
            balance=balance,
            maintenance_rate=maintenance_rate,
            total_upnl=total_upnl,
            total_notional=total_notional,
            opposite_notional=opposite_notional,
            opposite_pnl=opposite_pnl,
        )

        # ── 6. Margin check ──
        if required_margin > margin_info["available_margin"]:
            errors.append(
                f"INSUFFICIENT_MARGIN:{required_margin:.2f}>{margin_info['available_margin']:.2f}"
            )

        # ── 7. Margin usage ratio ──
        current_margin_used = sum(
            p.margin for p in positions
            if not (p.symbol == symbol and p.side == opposite_side)
        )
        usage_ratio = compute_margin_usage_ratio(
            equity=margin_info["equity"],
            current_margin_used=current_margin_used,
            new_margin=required_margin,
        )
        if usage_ratio >= 0.98:
            errors.append(f"MARGIN_RATIO_EXCEEDED:{usage_ratio:.3f}>=0.98")

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "computed_values": {
                "price": price,
                "notional": notional,
                "required_margin": required_margin,
                "available_margin": margin_info["available_margin"],
                "current_exposure": current_exposure,
                "equity": margin_info["equity"],
                "maintenance_margin": margin_info["maintenance_margin"],
                "margin_usage_ratio": usage_ratio,
            },
        }

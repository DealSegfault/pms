"""
PaperWallet — Virtual USDT balance tracker for paper trading.

Returns Binance-format dicts so all downstream consumers (RiskEngine,
PositionBook, frontend) see no difference from real exchange responses.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class PaperWallet:
    """
    Virtual USDT wallet for paper trading.

    Tracks:
    - Available balance (USDT)
    - Per-symbol leverage settings
    - Per-symbol margin type settings
    """

    def __init__(self, starting_balance: Optional[float] = None):
        self._balance = starting_balance or float(
            os.getenv("PAPER_STARTING_BALANCE", "10000")
        )
        self._initial_balance = self._balance
        self._leverage: Dict[str, int] = {}       # symbol → leverage
        self._margin_type: Dict[str, str] = {}    # symbol → ISOLATED/CROSSED

        logger.info(
            "PaperWallet initialized with %.2f USDT", self._balance
        )

    # ── Balance ──

    @property
    def balance(self) -> float:
        return self._balance

    def adjust_balance(self, delta: float) -> None:
        """Add/subtract from balance (PnL from fills)."""
        self._balance += delta
        logger.debug("Wallet balance adjusted by %.4f → %.4f", delta, self._balance)

    # ── Leverage / Margin ──

    def get_leverage(self, symbol: str) -> int:
        return self._leverage.get(symbol, 20)

    def set_leverage(self, symbol: str, leverage: int) -> dict:
        self._leverage[symbol] = leverage
        return {"leverage": leverage, "symbol": symbol, "maxNotionalValue": "1000000"}

    def set_margin_type(self, symbol: str, margin_type: str) -> dict:
        self._margin_type[symbol] = margin_type
        return {"code": 200, "msg": "success"}

    # ── Binance-Format Responses ──

    def get_balance_response(self) -> list:
        """Return Binance-format balance array."""
        return [
            {
                "accountAlias": "PaperTrading",
                "asset": "USDT",
                "balance": str(self._balance),
                "crossWalletBalance": str(self._balance),
                "crossUnPnl": "0",
                "availableBalance": str(self._balance),
                "maxWithdrawAmount": str(self._balance),
                "marginAvailable": True,
                "updateTime": int(time.time() * 1000),
            },
            {
                "accountAlias": "PaperTrading",
                "asset": "BUSD",
                "balance": "0",
                "crossWalletBalance": "0",
                "crossUnPnl": "0",
                "availableBalance": "0",
                "maxWithdrawAmount": "0",
                "marginAvailable": True,
                "updateTime": int(time.time() * 1000),
            },
        ]

    def get_account_info_response(self, positions: Optional[list] = None) -> dict:
        """Return Binance-format account info dict."""
        return {
            "feeTier": 0,
            "canTrade": True,
            "canDeposit": True,
            "canWithdraw": True,
            "updateTime": 0,
            "totalInitialMargin": "0",
            "totalMaintMargin": "0",
            "totalWalletBalance": str(self._balance),
            "totalUnrealizedProfit": "0",
            "totalMarginBalance": str(self._balance),
            "totalPositionInitialMargin": "0",
            "totalOpenOrderInitialMargin": "0",
            "totalCrossWalletBalance": str(self._balance),
            "totalCrossUnPnl": "0",
            "availableBalance": str(self._balance),
            "maxWithdrawAmount": str(self._balance),
            "assets": [
                {
                    "asset": "USDT",
                    "walletBalance": str(self._balance),
                    "unrealizedProfit": "0",
                    "marginBalance": str(self._balance),
                    "maintMargin": "0",
                    "initialMargin": "0",
                    "positionInitialMargin": "0",
                    "openOrderInitialMargin": "0",
                    "crossWalletBalance": str(self._balance),
                    "crossUnPnl": "0",
                    "availableBalance": str(self._balance),
                    "maxWithdrawAmount": str(self._balance),
                    "marginAvailable": True,
                    "updateTime": int(time.time() * 1000),
                }
            ],
            "positions": positions or [],
        }

    def get_position_risk_response(self, symbol: Optional[str] = None) -> list:
        """
        Return Binance-format position risk for paper mode.
        Returns empty positions (no real exchange positions in paper mode).
        The RiskEngine's PositionBook tracks virtual positions separately.
        """
        if symbol:
            return [
                {
                    "symbol": symbol,
                    "positionAmt": "0",
                    "entryPrice": "0.0",
                    "markPrice": "0.0",
                    "unRealizedProfit": "0.00000000",
                    "liquidationPrice": "0",
                    "leverage": str(self.get_leverage(symbol)),
                    "maxNotionalValue": "1000000",
                    "marginType": self._margin_type.get(symbol, "cross"),
                    "isolatedMargin": "0.00000000",
                    "isAutoAddMargin": "false",
                    "positionSide": "BOTH",
                    "notional": "0",
                    "isolatedWallet": "0",
                    "updateTime": int(time.time() * 1000),
                }
            ]
        return []

    def __repr__(self) -> str:
        return f"PaperWallet(balance={self._balance:.2f}, initial={self._initial_balance:.2f})"

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

import pandas as pd
import requests


class CandleServiceError(RuntimeError):
    """Raised when the candle microservice fails."""


@dataclass
class CandleJob:
    exchange: str
    pair: str
    timeframe: str
    start: Optional[int] = None
    end: Optional[int] = None
    length: Optional[str] = None

    def to_payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "exchange": self.exchange,
            "pair": self.pair,
            "timeframe": self.timeframe,
        }
        if self.length:
            payload["length"] = self.length
        if self.start is not None:
            payload["start"] = int(self.start)
        if self.end is not None:
            payload["end"] = int(self.end)
        return payload


class CandleServiceClient:
    def __init__(self, base_url: str, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()

    def fetch_candles(
        self,
        exchange: str,
        pair: str,
        timeframe: str,
        *,
        start: Optional[int] = None,
        end: Optional[int] = None,
        length: Optional[str] = None,
    ) -> pd.DataFrame:
        job = CandleJob(
            exchange=exchange,
            pair=pair,
            timeframe=timeframe,
            start=start,
            end=end,
            length=length,
        )
        url = f"{self.base_url}/"
        try:
            response = self._session.post(url, json=[job.to_payload()], timeout=self.timeout)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise CandleServiceError(f"Request to candle service failed: {exc}") from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise CandleServiceError("Invalid JSON returned by candle service") from exc

        if not payload:
            return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])

        job_response = payload[0]
        data = job_response.get("data", [])
        if not data:
            return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])

        frame = pd.DataFrame(
            data,
            columns=["ts", "open", "high", "low", "close", "volume"],
        )
        if not frame.empty:
            frame["ts"] = frame["ts"].astype("int64")
            numeric_cols = ["open", "high", "low", "close", "volume"]
            frame[numeric_cols] = frame[numeric_cols].apply(pd.to_numeric, errors="coerce")
            frame = frame.dropna()
        return frame

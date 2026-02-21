# V7 Services Micro Manual (For Agents)

## Purpose
`v7/services` keeps a durable local history of Binance futures **orders + user trades** and exposes a query API for iterative strategy upgrades.

## Components
- `history_sync.py`: historical backfill + incremental sync + optional user-stream live ingest.
- `storage.py`: SQLite schema and upsert logic.
- `api.py`: query interface (`HistoryQueryAPI`) + FastAPI app factory.
- `cli.py`: command-line entrypoints.

## Quick Start
1. Backfill last 14 days:
```bash
python3 -m v7.services.cli backfill --days 14
```

2. Run continuous live sync:
```bash
python3 -m v7.services.cli live --poll 2.0
```

3. Start query API:
```bash
python3 -m v7.services.cli api --host 127.0.0.1 --port 8787
```

## HTTP Query Endpoints
- `GET /health`
- `GET /sync/status`
- `GET /orders?symbol=SIRENUSDT&limit=200`
- `GET /trades?symbol=SIRENUSDT&start_ms=...&end_ms=...`
- `GET /orders/{order_id}/events`
- `GET /stats/summary?symbol=SIRENUSDT`
- `GET /stats/symbols`

## Rate-Limit Safety
- Token bucket limiter (`request_rate_per_sec`, `request_burst`).
- Built-in exchange rate limiter (`enableRateLimit=True`).
- Exponential backoff on transient/rate-limit errors.
- Incremental cursors per symbol with overlap to avoid misses.
- WebSocket user stream for low-latency updates, polling as fallback.

## Agent Loop Pattern (Capability Jumps)
1. `sync-once` or `live` to refresh DB.
2. Query `stats/symbols` and `trades` for the current regime.
3. Slice by symbol/time window and evaluate:
   - realized pnl
   - fee drag
   - execution quality by side/status
4. Propose parameter change.
5. Re-sync, re-query, compare deltas.

## Python Usage
```python
from v7.services.api import HistoryQueryAPI
api = HistoryQueryAPI("./v7_sessions/history.db")
print(api.summary(symbol="SIRENUSDT"))
rows = api.get_trades(symbol="SIRENUSDT", limit=100)
api.close()
```

## Notes
- Symbols are normalized to raw format (e.g. `LAUSDT`).
- Default sync universe is all active linear USDT/USDC perpetual markets reported by exchange metadata.
- DB default path resolves to project-root `v7_sessions/history.db` regardless of run directory.
- API keys are loaded from `.env` (`api_key=...`, `secret=...`) by the CLI.

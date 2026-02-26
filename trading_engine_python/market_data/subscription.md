# Market Data Subscription Service

Dynamic WebSocket subscription manager with Redis Pub/Sub for real-time market data distribution.

## Quick Start

```bash
# Start subscription API
python3 subscription_api.py

# Subscribe to a pair
curl -X POST http://localhost:8888/subscribe \
     -H "Content-Type: application/json" \
     -d '{"symbol": "BTCUSDT", "exchange": "Binance"}'
```

---

## Redis Pub/Sub Channels

The market data service publishes real-time updates to Redis channels. Subscribe from any client to receive live data.

### Channel Naming Convention

| Data Type | Channel Pattern | Example |
|-----------|-----------------|---------|
| Orderbook | `updates:orderbook:{exchange}:{symbol}` | `updates:orderbook:binance:BTCUSDT` |
| Index Price | `updates:index:{exchange}:{symbol}` | `updates:index:binance:BTCUSDT` |

### Orderbook Message Format

```json
{
  "bids": {"234.50": "1.5", "234.49": "2.3"},
  "asks": {"234.51": "0.8", "234.52": "1.2"},
  "timestamp": 1706574123.456
}
```

### Index Price Message Format

```json
{
  "price": "42150.50",
  "timestamp": 1706574123.456
}
```

---

## Subscribing from Python

```python
import redis
import json

r = redis.StrictRedis(host='localhost', port=6379, db=0)
pubsub = r.pubsub()

# Subscribe to BTCUSDT orderbook updates
pubsub.subscribe('updates:orderbook:binance:BTCUSDT')

for message in pubsub.listen():
    if message['type'] == 'message':
        data = json.loads(message['data'])
        best_bid = max(data['bids'].keys())
        best_ask = min(data['asks'].keys())
        print(f"BTC: {best_bid} / {best_ask}")
```

### Async Python (aioredis)

```python
import aioredis
import asyncio
import json

async def subscribe():
    redis = await aioredis.from_url('redis://localhost')
    pubsub = redis.pubsub()
    await pubsub.subscribe('updates:orderbook:binance:BTCUSDT')
    
    async for message in pubsub.listen():
        if message['type'] == 'message':
            data = json.loads(message['data'])
            print(f"Update: {data}")

asyncio.run(subscribe())
```

---

## Subscribing from Node.js

```javascript
const Redis = require('ioredis');
const redis = new Redis();

redis.subscribe('updates:orderbook:binance:BTCUSDT', (err) => {
  if (err) console.error('Subscribe error:', err);
});

redis.on('message', (channel, message) => {
  const data = JSON.parse(message);
  const bestBid = Math.max(...Object.keys(data.bids));
  const bestAsk = Math.min(...Object.keys(data.asks));
  console.log(`BTC: ${bestBid} / ${bestAsk}`);
});
```

---

## REST API Reference

### POST /subscribe
Start subscription to a trading pair.

```bash
curl -X POST http://localhost:8888/subscribe \
     -d '{"symbol": "ETHUSDT", "exchange": "Binance"}'
```

**Response:** `{"status": "subscribed", "key": "Binance:ETHUSDT"}`

### POST /unsubscribe
Stop subscription.

```bash
curl -X POST http://localhost:8888/unsubscribe \
     -d '{"symbol": "ETHUSDT", "exchange": "Binance"}'
```

### GET /subscriptions
List active subscriptions.

```bash
curl http://localhost:8888/subscriptions
```

**Response:** `{"subscriptions": ["Binance:BTCUSDT", "Binance:ETHUSDT"]}`

### GET /health
Health check.

```bash
curl http://localhost:8888/health
```

**Response:** `{"status": "healthy", "active_count": 2}`

---

## Redis Key Storage

In addition to Pub/Sub, the latest data is stored in Redis keys for on-demand access:

| Data Type | Key Pattern | Example |
|-----------|-------------|---------|
| Orderbook | `orderbook:{exchange}:{symbol}` | `orderbook:binance:BTCUSDT` |
| Index | `index:{exchange}:{symbol}` | `index:binance:BTCUSDT` |

```bash
# Get latest orderbook snapshot
redis-cli GET "orderbook:binance:BTCUSDT"
```

---

## Supported Exchanges

| Exchange | Symbol Format | Example |
|----------|---------------|---------|
| Binance | `{TICKER}USDT` | `BTCUSDT`, `ETHUSDT` |
| Coincall | `{TICKER}USD` | `BTCUSD`, `ETHUSD` |
| HyperLiquid | `{TICKER}USD` | `BTCUSD` |
| Orderly | `{TICKER}USD` | `BTCUSD` |

---

## Configuration

Environment variables (from `config.py`):

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `localhost` | Redis server host |
| `REDIS_PORT` | `6379` | Redis server port |
| `REDIS_DB` | `0` | Redis database number |

API settings (in `subscription_api.py`):

| Variable | Default | Description |
|----------|---------|-------------|
| `API_HOST` | `0.0.0.0` | API bind address |
| `API_PORT` | `8888` | API listen port |

---

## Architecture

```
┌─────────────────────┐
│  subscription_api   │ ◄── REST API (port 8888)
│  (Python/aiohttp)   │     POST /subscribe
└──────────┬──────────┘     POST /unsubscribe
           │
           ▼
┌─────────────────────┐
│  Exchange Handlers  │ ◄── WebSocket connections
│  (Binance, etc.)    │     to exchange feeds
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│       Redis         │
│  ┌───────────────┐  │
│  │   Pub/Sub     │  │ ◄── Real-time updates
│  │   Channels    │  │     updates:orderbook:*
│  └───────────────┘  │
│  ┌───────────────┐  │
│  │   Key Store   │  │ ◄── Latest snapshots
│  │               │  │     orderbook:*
│  └───────────────┘  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    Your Service     │ ◄── Subscribe to channels
│  (ML, Trading, UI)  │     or GET latest snapshot
└─────────────────────┘
```

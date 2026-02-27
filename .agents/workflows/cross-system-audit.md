---
description: how to exhaustively audit and fix cross-system data consistency issues
---

# Cross-System Audit & Fix

// turbo-all

## When to Use
When a bug appears in one layer (e.g., wrong data on frontend) but may originate
from a different layer (DB, Redis, Python, JS backend). This workflow forces you
to trace the field through ALL layers instead of just patching the symptom.

## Steps

1. Read the cross-system debugging skill for context:
   View file `.agents/skills/cross-system-debugging/SKILL.md`

2. **Identify the suspect field(s)**: What specific data is wrong?
   (e.g., `symbol`, `price`, `quantity`, `status`, `side`, `pnl`)

3. **Trace bottom-up — Database first**:
   - Check `prisma/schema.prisma` for the field definition
   - Query actual DB values:
     ```bash
     sqlite3 prisma/pms.db "SELECT DISTINCT symbol FROM VirtualPosition LIMIT 10;"
     ```
   - Document the format stored (e.g., `BTC/USDT:USDT` vs `BTCUSDT`)

4. **Trace — Redis layer**:
   - Find all Redis key patterns that involve this field:
     ```bash
     redis-cli KEYS '*price*' | head -10
     redis-cli KEYS '*position*' | head -10
     ```
   - Check the value format stored in Redis:
     ```bash
     redis-cli GET 'pms:price:BTC/USDT:USDT'
     ```
   - Search `server/redis.js` for how this field is read/written
   - Search `trading_engine_python/` for how Python reads/writes the same keys

5. **Trace — Python engine**:
   - `grep -rn '<field_name>' trading_engine_python/ --include='*.py'`
   - Check if Python normalizes the field before writing to Redis
   - Check if Python reads from Redis and assumes a specific format
   - Pay special attention to ccxt format vs Binance format conversions

6. **Trace — JS backend**:
   - `grep -rn '<field_name>' server/ --include='*.js'`
   - Check API route handlers that read/write this field
   - Check WebSocket broadcast handlers
   - Check Prisma queries for this field

7. **Trace — Frontend**:
   - `grep -rn '<field_name>' src/ --include='*.js'`
   - Check API response handling
   - Check WebSocket message handlers
   - Check how the value is rendered/compared in the UI

8. **Identify ALL mismatch boundaries**: Create a table like:
   ```
   | Layer A      | Layer B      | Format A        | Format B       | Mismatch? |
   |--------------|-------------|-----------------|----------------|-----------|
   | DB           | JS Backend  | BTC/USDT:USDT   | BTC/USDT:USDT  | ✅ OK     |
   | JS Backend   | Redis       | BTC/USDT:USDT   | BTC/USDT:USDT  | ✅ OK     |
   | Python       | Redis       | BTCUSDT          | BTC/USDT:USDT  | ❌ BUG    |
   ```

9. **Fix ALL mismatches** (not just the first one you find):
   - Centralize conversions in utility functions
   - Fix at the boundary, not deep in business logic
   - Fix in both read AND write directions

10. **Verify end-to-end**: Check every layer after the fix:
    ```bash
    # DB
    sqlite3 prisma/pms.db "SELECT symbol FROM VirtualPosition LIMIT 5;"
    # Redis
    redis-cli KEYS 'pms:price:*' | head -5
    # API
    curl -s http://localhost:3000/api/positions | jq '.[0].symbol'
    # Frontend — manually verify in browser
    ```

11. **Look for the underlying pattern**: Ask yourself:
    - Is this a one-off bug, or does the same mismatch exist for OTHER fields?
    - Grep for similar conversion patterns across the codebase
    - If the root cause is "no centralized converter", create one
    - If the root cause is "format wasn't decided early", document the canonical format

12. **Document the fix**: Add a brief note to the walkthrough explaining:
    - What the root cause was (which boundary, which format mismatch)
    - What the underlying pattern was (why it happened)
    - What you did to prevent recurrence

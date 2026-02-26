

## V2 Rebuild Rules

1. **C++ engine is the SINGLE SOURCE of truth** for positions, orders, and risk. JS never executes trades directly.
2. **UDS is the ONLY transport**. No Redis pub/sub bridge. No `CPP_BRIDGE_TRANSPORT` flag. Delete `simplx-bridge.js`.
3. **No feature flags**: Delete every `if (CPP_ENGINE_UDS)`, `if (CPP_ENGINE_WRITE)`, `if (CPP_BRIDGE_TRANSPORT)` branch.
4. **Event field names**: ALWAYS check `/Users/mac/.gemini/antigravity/brain/cc4d999a-0169-4dba-80af-e2fbf6a08c9f/v2_contracts.md` before accessing any event field. The contract is the source of truth.
5. **C++ symbol format**: C++ uses `BTCUSDT`, JS uses `BTC/USDT:USDT`. Always convert with `fromCppSymbol()` / `toCppSymbol()`.
6. **`account` field in C++ events means `sub_account_id`**. C++ calls it `account`, JS calls it `subAccountId`. Always map: `msg.account || msg.sub_account_id`.
7. **DB persistence is async, fire-and-forget**. Never `await` DB writes in the event processing pipeline. Never block WS broadcasts on DB.
8. **Risk engine book is read-only from C++ events**. The JS `position-book.js` is updated by C++ `position_update` events only. No JS-side position creation.
9. **After ANY C++ change**: run `make release` in `engine_simplx/` to recompile the binary. The process manager uses `build-release/`.
10. **Don't call `setLeverage()` REST call** — never update leverage on the exchange.
11. **Don't wipe the DB** — never run destructive migrations.
12. **Test before reporting**: Run `node ./DEBUG_MAKEITWORK` or equivalent verification before telling the user a fix works.

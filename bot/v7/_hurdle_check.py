#!/usr/bin/env python3
"""Quick: is the hurdle improvement gate useful or harmful?"""
import sqlite3, time, json
db = sqlite3.connect("v7_sessions/history.db")

cutoff = time.time() - 48*3600

# 1. Entry edge gate: how often is hurdle boosting the required threshold?
print("=== ENTRY EDGE GATE: HURDLE IMPACT ===")
rows = db.execute(
    "SELECT edge_lcb_bps, edge_required_bps, recovery_debt_usd, symbol "
    "FROM strategy_events WHERE action='entry' AND event_ts > ?", (cutoff,)
).fetchall()
total = len(rows)
hurdle_active = sum(1 for r in rows if r[1] > 2.0)
hurdle_raised = sum(1 for r in rows if r[1] > 2.0 and r[0] < r[1])
print(f"  Entries (48h): {total}")
print(f"  Hurdle lifted required > base 2bp: {hurdle_active} ({hurdle_active/max(total,1)*100:.0f}%)")
print(f"  Would have blocked entry: {hurdle_raised}")

# 2. Debt distribution
print("\n=== CURRENT DEBT LEVELS ===")
rows = db.execute("SELECT key, value FROM sync_state WHERE key LIKE 'runtime_state:%'").fetchall()
debts = []
for r in rows:
    try:
        d = json.loads(r[1])
        debt = d.get("recovery_debt_usd", 0)
        sym = r[0].replace("runtime_state:", "")
        debts.append((sym, debt))
    except: pass
debts.sort(key=lambda x: -x[1])
for sym, d in debts[:10]:
    if d > 0.001:
        print(f"  {sym:<18s} ${d:.4f}")
print(f"  Symbols with ANY debt: {sum(1 for _,d in debts if d > 0)}/{len(debts)}")
print(f"  Symbols with debt > $0.10: {sum(1 for _,d in debts if d > 0.10)}/{len(debts)}")
print(f"  Symbols with debt > $1.00: {sum(1 for _,d in debts if d > 1.00)}/{len(debts)}")

# 3. Performance of symbols with meaningful debt vs without  
print("\n=== CLOSE PERFORMANCE: DEBT vs NO-DEBT SYMBOLS ===")
rows = db.execute(
    "SELECT symbol, pnl_usd, recovery_debt_usd FROM strategy_events "
    "WHERE action='close' AND event_ts > ?", (cutoff,)
).fetchall()
debt_pnl, nodebt_pnl, debt_n, nodebt_n = 0, 0, 0, 0
for r in rows:
    if r[2] > 0.10:
        debt_pnl += r[1]; debt_n += 1
    else:
        nodebt_pnl += r[1]; nodebt_n += 1
print(f"  With debt>$0.10: {debt_n} closes, ${debt_pnl:+.4f}")
print(f"  Without debt:    {nodebt_n} closes, ${nodebt_pnl:+.4f}")

# 4. The real question: does hurdle ever produce a meaningful edge improvement?
print("\n=== HURDLE CHECK MATH FOR CURRENT DEBTS ===")
print("  (what the hurdle improve check evaluates)")
for sym, debt in debts[:10]:
    if debt < 0.001: continue
    target = debt * 0.25  # paydown_ratio
    # Typical notional range $50-$100
    for notional in [50, 100, 200, 500]:
        hurdle = target / notional * 10000
        next_notional = notional + 50
        next_hurdle = target / next_notional * 10000
        improve = hurdle - next_hurdle
        can_pass = "✅" if improve >= 0.75 else "❌"
        if notional == 50:
            print(f"  {sym:<16s} debt=${debt:.4f}: ${notional}→${next_notional} improve={improve:.4f}bp {can_pass}")

db.close()

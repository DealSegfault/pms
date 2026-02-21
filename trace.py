import json
import glob
from debug_microstructure_opus.paper_trader import PaperTrader
from debug_microstructure_opus.alpha_engine import AlphaEngine

files = glob.glob('debug_microstructure_opus/data/cluster_collection/cluster_ticks_*.jsonl')
all_ticks = []
for f in files:
    with open(f) as fh:
        for line in fh:
            if line.strip(): all_ticks.append(json.loads(line.strip()))
all_ticks.sort(key=lambda x: x['timestamp'])

btc_ev = next((t for t in all_ticks if t['symbol'].upper()=='BTCUSDT' and t.get('cluster_event') and t.get('fragility',0)<=0.01), None)
print(f"BTC EVENT: ts={btc_ev['timestamp']}, side={btc_ev['cluster_event']['direction']}")

engine = AlphaEngine()
trader = PaperTrader(taker_fee_pct=0.0)

for t in all_ticks:
    if t['timestamp'] > btc_ev['timestamp'] + 35: break
    for sig in engine.process_tick(t):
        if sig.symbol == 'JUPUSDT':
            print(f"SIGNAL FIRED: JUP dir={sig.direction} ts={sig.timestamp}")
            trader.on_signal(sig)
    trader.on_tick(t)

for ct in trader.closed_trades:
    if ct['symbol'] == 'JUPUSDT':
        print(f"TRADE COMPLETED: {ct}")

t_jup_analyzer = next((t for t in all_ticks if t['symbol'] == 'JUPUSDT' and abs(t['timestamp'] - btc_ev['timestamp']) < 3 and t['timestamp'] >= btc_ev['timestamp']), None)
if t_jup_analyzer:
    print(f"ANALYZER MATCH: ts={t_jup_analyzer['timestamp']}, price={t_jup_analyzer['price']}")
    dt = btc_ev['cluster_event']['direction']
    btc_dir = 1 if dt == 'ABOVE' else -1
    fwd = t_jup_analyzer.get('fwd_30s_bps')
    if fwd:
        print(f"ANALYZER CALC: raw fwd={fwd} * btc_dir({btc_dir}) = {fwd * btc_dir} bps")

#!/usr/bin/env python3
"""Pack v7 for production — code only, no junk."""
import shutil
import os

SRC = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SRC)
DST = os.path.join(ROOT, "packed_v7")

# Clean slate
if os.path.exists(DST):
    shutil.rmtree(DST)

# Files to include from v7/
V7_FILES = [
    "__init__.py",
    "__main__.py",
    "config.yaml",
    "run.py",
    "run_watch.py",
    "multi_grid.py",
    "grid_trader.py",
    "exchange.py",
    "signals.py",
    "adaptive.py",
    "volatility_regime.py",
    "flow_metrics.py",
    "pair_scorer.py",
    "candles_client.py",
]

SERVICE_FILES = [
    "__init__.py",
    "api.py",
    "cli.py",
    "history_sync.py",
    "rate_limit.py",
    "storage.py",
]

# Create dirs
os.makedirs(os.path.join(DST, "v7", "services"), exist_ok=True)
os.makedirs(os.path.join(DST, "v5"), exist_ok=True)

# Copy v7 core
for f in V7_FILES:
    src = os.path.join(SRC, f)
    dst = os.path.join(DST, "v7", f)
    shutil.copy2(src, dst)
    print(f"  v7/{f}  ({os.path.getsize(dst):,}B)")

# Copy services
for f in SERVICE_FILES:
    src = os.path.join(SRC, "services", f)
    dst = os.path.join(DST, "v7", "services", f)
    shutil.copy2(src, dst)
    print(f"  v7/services/{f}  ({os.path.getsize(dst):,}B)")

# Copy v5 dependency
v5_init = os.path.join(ROOT, "v5", "__init__.py")
v5_scanner = os.path.join(ROOT, "v5", "hot_scanner.py")
if os.path.exists(v5_init):
    shutil.copy2(v5_init, os.path.join(DST, "v5", "__init__.py"))
else:
    open(os.path.join(DST, "v5", "__init__.py"), "w").close()
shutil.copy2(v5_scanner, os.path.join(DST, "v5", "hot_scanner.py"))
print(f"  v5/__init__.py")
print(f"  v5/hot_scanner.py  ({os.path.getsize(os.path.join(DST, 'v5', 'hot_scanner.py')):,}B)")

# Summary
total_files = sum(len(files) for _, _, files in os.walk(DST))
total_bytes = sum(os.path.getsize(os.path.join(d, f)) for d, _, files in os.walk(DST) for f in files)
print(f"\n✅ Packed {total_files} files, {total_bytes:,}B ({total_bytes/1024:.0f}KB) → {DST}")

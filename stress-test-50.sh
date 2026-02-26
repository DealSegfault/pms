#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Stress Test: 42 scalpers on top USDT pairs
# Account: burnme | Neutral mode | 10 layers | No skew | $50 size | 3% offset
# Excluded: BTC, ETH, SOL, BCH, LINK (minNotional > $5)
#           XAUUSDT, XAGUSDT, PAXGUSDT (commodities)
# ─────────────────────────────────────────────────────────────

BASE="http://localhost:3900"
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Ijc2ZWJiYWQxLTdlYjEtNDc0NS04OWFhLTU4ZmVjZGM3OTgzMCIsInVzZXJuYW1lIjoiYnVybm1lIiwicm9sZSI6IlVTRVIiLCJpYXQiOjE3NzE3NzgwMDIsImV4cCI6MTc3MjM4MjgwMn0.YECNHV9qMdjE-E8aVc_O3Hk4C0ibKWBymq8i9sG9ZlA"
SUB_ACCOUNT_ID="079d9b4f-9fd6-47a5-b51a-aa8d9ebf3603"

# 42 valid USDT perp pairs
PAIRS=(
  OPNUSDT
  PIPPINUSDT ALPHAUSDT DOGEUSDT ENSOUSDT ZECUSDT
  BNBUSDT 1000PEPEUSDT WLFIUSDT PORT3USDT SIRENUSDT
  KITEUSDT AZTECUSDT ARCUSDT HYPEUSDT UXLINKUSDT
  VIDTUSDT SXPUSDT AGIXUSDT ADAUSDT RAVEUSDT
  RIVERUSDT AVAXUSDT LINAUSDT MEMEFIUSDT SPACEUSDT
  SUIUSDT LEVERUSDT NEIROETHUSDT FTMUSDT POWERUSDT
  ENAUSDT ESPUSDT YGGUSDT WAVESUSDT FILUSDT
  OMNIUSDT TRXUSDT
)

echo "🔥 Stress Test — Launching ${#PAIRS[@]} scalpers (burnme account)"
echo "   Mode: NEUTRAL | Layers: 10 | Skew: 0 | Size: \$50 | Offset: 3%"
echo ""

RESULTS_DIR=$(mktemp -d)

launch_one() {
  local SYMBOL="$1"
  local OUT_FILE="$RESULTS_DIR/$SYMBOL"
  
  RESULT=$(curl -s -w "\n%{http_code}" "$BASE/api/trade/scalper" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --max-time 120 \
    -d "{
      \"subAccountId\": \"$SUB_ACCOUNT_ID\",
      \"symbol\": \"$SYMBOL\",
      \"startSide\": \"LONG\",
      \"leverage\": 20,
      \"longOffsetPct\": 3,
      \"shortOffsetPct\": 3,
      \"childCount\": 3,
      \"skew\": 0,
      \"longSizeUsd\": 50,
      \"shortSizeUsd\": 50,
      \"neutralMode\": true
    }" 2>/dev/null)

  HTTP_CODE=$(echo "$RESULT" | tail -1)
  BODY=$(echo "$RESULT" | sed '$d')

  if [ "$HTTP_CODE" = "201" ]; then
    SCALPER_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('scalperId','?'))" 2>/dev/null || echo "?")
    echo "OK|$SCALPER_ID" > "$OUT_FILE"
  else
    ERROR=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "$BODY")
    echo "FAIL|$HTTP_CODE|$ERROR" > "$OUT_FILE"
  fi
}

# Launch in batches of 3 (conservative to avoid overload)
BATCH_SIZE=40
TOTAL=${#PAIRS[@]}

for ((i=0; i<TOTAL; i+=BATCH_SIZE)); do
  BATCH=("${PAIRS[@]:i:BATCH_SIZE}")
  BATCH_NUM=$((i/BATCH_SIZE + 1))
  echo "  📦 Batch $BATCH_NUM: ${BATCH[*]}"
  
  for SYMBOL in "${BATCH[@]}"; do
    launch_one "$SYMBOL" &
  done
  wait
  
  for SYMBOL in "${BATCH[@]}"; do
    if [ -f "$RESULTS_DIR/$SYMBOL" ]; then
      LINE=$(cat "$RESULTS_DIR/$SYMBOL")
      STATUS=$(echo "$LINE" | cut -d'|' -f1)
      if [ "$STATUS" = "OK" ]; then
        SID=$(echo "$LINE" | cut -d'|' -f2)
        echo "     ✅ $SYMBOL → $SID"
      else
        ERR=$(echo "$LINE" | cut -d'|' -f3-)
        echo "     ❌ $SYMBOL → $ERR"
      fi
    else
      echo "     ⏳ $SYMBOL → no response"
    fi
  done
  
  sleep 2
done

OK=$(grep -l "^OK" "$RESULTS_DIR"/* 2>/dev/null | wc -l | tr -d ' ')
FAIL=$((TOTAL - OK))

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Launched: $OK  |  ❌ Failed: $FAIL  |  Total: $TOTAL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

rm -rf "$RESULTS_DIR"

# TCA Web Notes

## Scope

This note captures two threads:

1. What a strong end-user TCA page should look like in this repo.
2. Why the Python engine keeps printing:

```text
TCARollupWorker rebuilt 2 sub-account rollup(s) and 238 strategy rollup(s)
```

## External TCA UX Findings

Primary product pages reviewed:

- Bloomberg BTCA: https://professional.bloomberg.com/products/trading/post-trade-services/btca/
- Tradeweb TCA: https://www.tradeweb.com/our-markets/data-analytics/transaction-cost-analysis/
- FlexTrade / IHS Markit TCA: https://flextrade.com/resources/ihsmarkittca/
- Berkindale Best Execution / TCA: https://berkindale.com/en/products/best-executions-trade-cost-analysis/
- LiquidMetrix: https://www.liquidmetrix.com/

Common patterns across current TCA products:

- Start with an aggregate execution-quality view, then drill into individual trades.
- Make exception and outlier review the main workflow, not just KPI display.
- Support multiple timestamps and benchmarks per order or fill.
- Preserve auditability with lineage from trade -> market context -> analytics.
- Show comparative scorecards by strategy, broker, venue, or cohort.
- Keep investigation inside the workflow instead of forcing users into separate tools.

## What A Good End-User TCA Page Should Show

Recommended page label:

- `Execution Quality`

Use `TCA` as the page subtitle, not the primary nav label.

Recommended information architecture:

### 1. Summary Band

- Execution quality score
- Average arrival slippage
- Average ack latency
- Average 1s / 5s / 30s markout
- Fill ratio
- Reject rate
- Reprice count
- Exception count

### 2. Main Analysis Workspace

- Sticky filters:
  - sub-account
  - date range
  - symbol
  - strategy type
  - execution scope
  - ownership confidence
- Benchmark switcher:
  - decision mid
  - fill mid
  - 1s / 5s / 30s markout
- Outlier table:
  - one row per lifecycle
- Chart block:
  - scatter: arrival slippage vs markout
  - histogram: slippage distribution
  - daily trend
  - strategy-session leaderboard

### 3. Trade Drilldown

Best interaction pattern:

- click trade row
- open a right-side drawer
- keep the table and filters visible underneath

Drilldown contents:

- lifecycle timeline: intent -> ack -> partial fill -> done
- price path around decision, ack, fill, and markout points
- metric cards:
  - decision bid/ask/mid/spread
  - fill bid/ask/mid/spread
  - arrival slippage
  - working time
  - 1s / 5s / 30s markouts
  - execution scope
  - ownership confidence
- strategy lineage:
  - strategy session
  - parent order id
  - reprices / child orders
- raw event log
- reconciliation notes
- data quality badges

## Premium UX Principles

Premium TCA UX is mainly about trust and diagnosis speed.

Important behaviors:

- Default to an exception inbox, not a passive dashboard.
- Keep metrics explainable with one click.
- Preserve context while drilling into a trade.
- Show confidence and freshness badges.
- Support compare mode:
  - trade vs similar trades
  - session vs 30-day median
  - symbol vs account baseline
- Let users annotate outliers later, once the core read path is trusted.

## Unknown Unknowns To Resolve Before Building UI

- What exactly counts as `arrival`:
  - decision time
  - intent publish time
  - exchange ack time
- Whether the user thinks in parent strategies or child venue orders.
- How partial fills should be summarized in the UI.
- Which benchmark is the default:
  - decision mid
  - fill mid
  - markout
  - close
  - VWAP
- Whether ambiguous or backfilled activity is hidden by default.
- How to present missing quote history or sparse markout data.
- How to prevent sign-convention confusion on BUY vs SELL slippage.
- How to avoid turning one synthetic score into a gamed metric.

## Local Repo Fit

Relevant frontend entry point:

- `src/main.js`

Current TCA backend routes already exist:

- `server/routes/trading/tca.js`

Current TCA read-model serialization already exists:

- `server/tca-read-models.js`

Clean V1 implementation path:

- add a new `/tca` route in `src/main.js`
- add a new page module such as `src/pages/tca.js`
- default filters to:
  - `executionScope=SUB_ACCOUNT`
  - `ownershipConfidence=HARD`
- add an opt-in toggle for ambiguous / backfill rows

## Rollup Log Investigation

Observed log:

```text
TCARollupWorker rebuilt 2 sub-account rollup(s) and 238 strategy rollup(s)
```

This is not random churn. It is the expected result of the current `TCARollupWorker` design.

### Root Cause

`trading_engine_python/tca/rollups.py` currently does all of the following:

- constructs `TCARollupWorker` with `interval_sec=15.0`
- loops forever in `run()`
- calls `recompute_once()` every interval
- logs on every loop whenever at least one rollup exists

Current behavior in plain terms:

- the worker is periodic, not event-driven
- the worker always does a full rebuild
- the worker always deletes and reinserts all rollup rows
- the worker always logs if the rebuilt counts are non-zero

So if the database already contains rollup-able data, the same line will print every ~15 seconds forever.

### Exact Code Behavior

In `trading_engine_python/tca/rollups.py`:

- `TCARollupWorker.__init__(..., interval_sec=15.0)` sets the default cadence
- `run()` calls `recompute_once()`
- `run()` logs whenever `summary["sub_account_rollups"]` or `summary["strategy_rollups"]` is non-zero
- `recompute_once()` reads all rows from:
  - `order_lifecycles`
  - `fill_facts`
  - `fill_markouts`
- `recompute_once()` then executes:
  - `DELETE FROM sub_account_tca_rollups`
  - `DELETE FROM strategy_tca_rollups`
- it finally inserts a fresh snapshot of all rollups

There is currently no:

- dirty flag
- change detection
- summary diff check
- incremental upsert path
- "log only on change" gate

### Why The Numbers Are Exactly 2 And 238

Live database checks against PostgreSQL on `localhost:55432` show:

- `COUNT(DISTINCT (sub_account_id, execution_scope, ownership_confidence))` from `order_lifecycles` = `2`
- `COUNT(DISTINCT (strategy_session_id, execution_scope, ownership_confidence))` from `order_lifecycles` = `238`
- `COUNT(*)` in `strategy_tca_rollups` = `238`
- `COUNT(*)` in `strategy_sessions` = `238`
- `order_lifecycles` rows with a strategy session = `4268`
- all current strategy-session lifecycles are `CHASE`

That means:

- the worker is not discovering new strategy rows each cycle
- it is recomputing the same stable `2` sub-account keys and `238` strategy-session keys every cycle
- the repeated log line is just the periodic rebuild announcing the same existing rollup set

### Why This Is Noisy

The worker rewrites both rollup tables even when nothing changed.

Effects:

- repeated info-level log spam
- unnecessary delete/insert churn
- `updated_at` on rollup rows advances every rebuild
- any downstream consumer that keys off rollup freshness may think new work happened

## Recommended Fix Order

### Minimal Fix

Keep the periodic worker, but reduce log noise.

Change behavior to log only when:

- the summary changed from the previous cycle, or
- a cycle actually touched different source rows, or
- the worker starts for the first time

Otherwise log at `DEBUG`, not `INFO`.

### Better Fix

Track a dirty flag from `TCACollector`, `TCAMarketSampler`, and `TCAReconciler`.

Only rebuild when one of these writes:

- `order_lifecycles`
- `fill_facts`
- `fill_markouts`

This preserves the read-model pattern while avoiding constant rebuilds.

### Best Fix

Move from full snapshot rebuild to incremental rollup maintenance.

That would require:

- per-lifecycle delta tracking
- markout-aware rollup adjustment
- idempotent upserts keyed by:
  - `(sub_account_id, execution_scope, ownership_confidence)`
  - `(strategy_session_id, execution_scope, ownership_confidence)`

This is more work, but it removes table-wide delete/insert churn completely.

## Bottom Line

The repeated log line appears because `TCARollupWorker` is intentionally running every 15 seconds and logging every successful non-empty rebuild. The `2 / 238` values are the stable current rollup cardinalities in your database, not evidence of a loop bug or duplicate session creation during each log cycle.

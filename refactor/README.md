# Refactor Workspace

This directory is the canonical place for refactor planning, design notes, and execution backlogs related to OEMS scaling, TCA, subaccount safety, and future agent integrations.

## Files

- `oems-refactor-roadmap.md`
  - prioritized refactor backlog
  - risks, stop-doing list, contracts/tests to add
  - phased execution plan
- `implementation-checklist.md`
  - strict execution checklist
  - file-by-file task list
  - acceptance gates and PR slices
- `tca-module-design.md`
  - independent TCA runtime and storage design
- `subaccount-invariants.md`
  - ownership and attribution rules that must not drift

## Working Rule

Any new design or refactor note that changes execution attribution, lifecycle truth, or contract boundaries should land here first before implementation spreads across Python, Redis, JS, DB, and frontend.

## Current Remaining

- No open items remain from the documented Phase 1-7 backlog.
- Next optional follow-on: add deeper quote/microstructure context (queue-aware or L2-derived metrics) on top of `market_quotes`.
- Next optional follow-on: add realized spread and toxicity metrics to the agent read models once the current markout path has enough production history.

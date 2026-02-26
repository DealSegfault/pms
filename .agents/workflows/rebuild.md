---
description: How to rebuild PMS V2 from the current codebase
---

## Overview

The V2 rebuild follows the trim analysis and architecture retrospective. The goal is to reduce the JS server from 28K lines to ~6K lines by deleting dead code and rewriting the middle layer as thin C++ proxies.

## Prerequisites

Before starting any phase:
1. Read `/Users/mac/.gemini/antigravity/brain/cc4d999a-0169-4dba-80af-e2fbf6a08c9f/v2_contracts.md` — the IPC contract
2. Read `/Users/mac/.gemini/antigravity/brain/cc4d999a-0169-4dba-80af-e2fbf6a08c9f/trim_analysis.md` — what to keep/delete/rewrite
3. Read `/Users/mac/cgki/minimalte/.agents/memories/v2-rebuild.md` — the 12 rules

## Phase 0: Fix Critical Bugs First
1. Fix `ws.js` brace nesting (broadcast function is inside connection handler)
2. Verify server starts cleanly

## Phase 1: Clean IPC Layer
1. Rewrite `simplx-uds-bridge.js` — minimal UDS client, no Redis, no transport flags
2. Delete `simplx-bridge.js` entirely
3. Simplify `engine-event-relay.js` — pure event router
4. Run `/verify` after each file change

## Phase 2: Replace EventPersister with Handlers
1. Create `server/handlers/fill-handler.js` using v2_contracts.md field names
2. Create `server/handlers/position-handler.js`
3. Create `server/handlers/rejection-handler.js`
4. Wire handlers into event relay
5. Delete `simplx-event-persister.js`
6. Run `/verify`

## Phase 3: Simplify REST Routes
1. Rewrite trading routes as thin C++ proxies
2. Simplify exchange.js to read-only
3. Simplify risk/index.js to read-only book
4. Run `/verify`

## Phase 4: Delete Dead Code
1. Delete files listed in trim_analysis.md DELETE section
2. Clean up unused imports
3. Run `/verify`

## Phase 5: Final Verification
1. Place real market order — verify <500ms frontend update
2. Verify DB persistence
3. Verify chase orders work (no tick size rejects)
4. Verify REST /positions returns correct data

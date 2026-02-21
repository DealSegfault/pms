// ── src/pages/trading.js  — backward‑compatible shim ─────────
// This file preserves the public API that `main.js` imports:
//   import { renderTradingPage, cleanup as cleanupTrading } from './pages/trading.js';
//
// All logic now lives in `./trading/index.js` (sub‑modules).
// ──────────────────────────────────────────────────────────────

export { renderTradingPage, cleanup } from './trading/index.js';

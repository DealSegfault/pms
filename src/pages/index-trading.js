// ── src/pages/index-trading.js  — backward-compatible shim ──
// Legacy import path kept for compatibility:
//   import { renderIndexPage, cleanup as cleanupIndex } from './pages/index-trading.js';
//
// All logic now lives in `./index-trading/index.js`.

export { renderIndexPage, cleanup } from './index-trading/index.js';

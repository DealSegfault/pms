/**
 * Backward-compatible entry point.
 *
 * server/index.js imports `./routes/trading.js` and mounts it at /api/trade.
 * This file simply re-exports the aggregated router from the new modular
 * directory so that NO changes are needed in server/index.js.
 */
export { default } from './trading/index.js';

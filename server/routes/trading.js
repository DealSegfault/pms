/**
 * Backward-compatible entry point.
 *
 * server/index.js imports `./routes/trading.js` and mounts it at /api/trade.
 * This file re-exports the proxy router that forwards all trade commands
 * to the Python engine via Redis.
 *
 * Rollback: change 'index-proxy.js' back to 'index.js' (archived in server/_archived/)
 */
export { default } from './trading/index.js';

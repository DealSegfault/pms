/**
 * Recently-closed symbol debounce.
 *
 * Shared between trade-executor (marks symbols as closed)
 * and proxy-stream (skips reconcile for recently-closed symbols).
 * Extracted to avoid circular imports.
 */

const recentlyClosed = new Map(); // symbol → timestamp

/**
 * Mark a symbol as recently closed by another path (closePosition, babysitter, etc.).
 * Prevents proxy-stream's ACCOUNT_UPDATE from triggering a duplicate reconcile.
 */
export function markSymbolClosed(symbol) {
    recentlyClosed.set(symbol, Date.now());
    setTimeout(() => recentlyClosed.delete(symbol), 5000);
}

/**
 * Check if a symbol was recently closed.
 */
export function isRecentlyClosed(symbol) {
    return recentlyClosed.has(symbol);
}

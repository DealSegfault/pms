/**
 * Periodic Position Sync — Backup reconciliation.
 * 
 * Every 30s, compares real exchange positions with virtual positions.
 * If a virtual position has no matching real exchange position, it's closed
 * using the current mark price.
 * 
 * This is a safety net — the primary sync happens in real-time via
 * the ACCOUNT_UPDATE handler in proxy-stream.js.
 */

import prisma from './db/prisma.js';
import exchange from './exchange.js';
import riskEngine from './risk/index.js';
import { acquireReconcileLock, releaseReconcileLock } from './redis.js';



let syncInterval = null;

// Debounce map: symbol → timestamp of last reconciliation (from any source)
// Prevents the periodic sync from racing with proxy-stream's real-time reconciliation
const _recentlyReconciled = new Map();
const RECONCILE_DEBOUNCE_MS = 30000; // 30s

/**
 * Mark a symbol as recently reconciled (called by proxy-stream after ACCOUNT_UPDATE).
 * Prevents the periodic sync from re-reconciling the same symbol within 30s.
 */
export function markReconciled(symbol) {
    _recentlyReconciled.set(symbol, Date.now());
}

function _wasRecentlyReconciled(symbol) {
    const ts = _recentlyReconciled.get(symbol);
    if (!ts) return false;
    if (Date.now() - ts > RECONCILE_DEBOUNCE_MS) {
        _recentlyReconciled.delete(symbol);
        return false;
    }
    return true;
}

export function startPositionSync(intervalMs = 60000) {
    // Primary sync is real-time via proxy-stream ACCOUNT_UPDATE; this is just the safety net
    console.log(`[PositionSync] Starting periodic reconciliation (every ${intervalMs / 1000}s)`);
    syncInterval = setInterval(reconcile, intervalMs);
    // Run once on startup after 5s delay (let exchange connect first)
    setTimeout(reconcile, 5000);
}

export function stopPositionSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

async function reconcile() {
    try {
        if (!exchange.ready) return;

        // Get all open virtual positions
        const virtualPositions = await prisma.virtualPosition.findMany({
            where: { status: 'OPEN' },
        });

        if (virtualPositions.length === 0) return;

        // Get real exchange positions
        let realPositions;
        try {
            realPositions = await exchange.fetchPositions();
        } catch (err) {
            console.error('[PositionSync] Failed to fetch exchange positions:', err.message);
            return;
        }

        // Build set of symbols with real positions
        const realSymbols = new Set(realPositions.map(p => p.symbol));

        // Find virtual positions whose symbol has NO real exchange position
        const orphanedSymbols = new Set();
        for (const vp of virtualPositions) {
            if (!realSymbols.has(vp.symbol)) {
                orphanedSymbols.add(vp.symbol);
            }
        }

        if (orphanedSymbols.size === 0) return;

        console.log(`[PositionSync] Found ${orphanedSymbols.size} orphaned symbol(s): ${[...orphanedSymbols].join(', ')}`);

        for (const symbol of orphanedSymbols) {
            // Skip if proxy-stream already reconciled this symbol recently
            if (_wasRecentlyReconciled(symbol)) {
                console.log(`[PositionSync] Skipping ${symbol} — recently reconciled by stream`);
                continue;
            }

            // Get close price from mark price
            let closePrice = exchange.getLatestPrice(symbol);
            if (!closePrice) {
                try {
                    const ticker = await exchange.fetchTicker(symbol);
                    closePrice = ticker.mark || ticker.last;
                } catch {
                    console.warn(`[PositionSync] Cannot get price for ${symbol}, skipping`);
                    continue;
                }
            }

            try {
                if (!await acquireReconcileLock(symbol)) {
                    console.log(`[PositionSync] Skipping ${symbol} — lock held by another path`);
                    continue;
                }
                try {
                    const result = await riskEngine.reconcilePosition(symbol, closePrice);
                    if (result.closed > 0) {
                        markReconciled(symbol); // Mark so we don't reconcile again in 30s
                        console.log(`[PositionSync] Reconciled ${result.closed} position(s) for ${symbol}`);
                    }
                } finally {
                    await releaseReconcileLock(symbol);
                }
            } catch (err) {
                console.error(`[PositionSync] Reconciliation error for ${symbol}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[PositionSync] Reconciliation cycle error:', err.message);
    }
}

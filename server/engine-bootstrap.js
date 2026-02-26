/**
 * Engine Bootstrap — handles ENGINE_READY event from C++ engine.
 *
 * When the C++ engine emits ENGINE_READY with a full state snapshot,
 * this module replaces the JS riskEngine.book state entirely.
 * This makes C++ the single source of truth (Phase 3).
 *
 * Flow:
 *   1. JS bootstraps accounts + rules + open virtual positions into C++
 *      (upsert_account + upsert_rule + upsert_position + upsert_exchange_position)
 *   2. JS sends `get_engine_state` command
 *   3. C++ responds with ENGINE_READY containing accounts[], positions[], open_orders[]
 *   4. This module processes the snapshot → replaces riskEngine.book
 */

import riskEngine from './risk/index.js';
import { broadcast } from './ws.js';

let _lastSnapshotTs = 0;
let _snapshotCount = 0;

/**
 * Process an ENGINE_READY event from the C++ engine.
 * Replaces the in-memory risk book with the engine's state.
 *
 * @param {object} msg - The ENGINE_READY JSON event
 * @param {object[]} msg.accounts - Array of account snapshots
 * @param {object[]} msg.positions - Array of open positions
 * @param {object[]} msg.open_orders - Array of pending orders
 */
export function handleEngineReady(msg) {
    if (!msg) return;

    const accounts = msg.accounts || [];
    const positions = msg.positions || [];
    const openOrders = msg.open_orders || [];

    console.log(`[EngineBootstrap] Processing ENGINE_READY: ${accounts.length} accounts, ${positions.length} positions, ${openOrders.length} open orders`);

    // Phase 3: Replace riskEngine.book from engine snapshot
    try {
        // Build byAccount map for book.load()
        const byAccount = {};

        // Step 1: Import accounts
        for (const acct of accounts) {
            const subAccountId = acct.sub_account_id;
            if (!subAccountId) continue;
            byAccount[subAccountId] = {
                account: {
                    id: subAccountId,
                    name: acct.name || subAccountId,
                    currentBalance: acct.balance ?? 0,
                    maintenanceRate: acct.maintenance_rate ?? 0.005,
                    liquidationMode: acct.liquidation_mode || 'ADL_30',
                    status: acct.status ?? 'ACTIVE',
                },
                positions: [],
                rules: null,
            };
        }

        // Step 2: Import positions
        for (const pos of positions) {
            const subAccountId = pos.sub_account_id;
            if (!subAccountId || !pos.symbol) continue;

            // Ensure account entry exists
            if (!byAccount[subAccountId]) {
                byAccount[subAccountId] = {
                    account: {
                        id: subAccountId, name: subAccountId,
                        currentBalance: 0, maintenanceRate: 0.005,
                        liquidationMode: 'ADL_30', status: 'ACTIVE',
                    },
                    positions: [],
                    rules: null,
                };
            }

            byAccount[subAccountId].positions.push({
                id: pos.position_id || `cpp_${subAccountId}_${pos.symbol}_${pos.side}`,
                subAccountId,
                symbol: pos.symbol,
                side: pos.side,
                entryPrice: pos.entry_price ?? 0,
                quantity: pos.quantity ?? 0,
                notional: pos.notional ?? 0,
                margin: pos.margin ?? 0,
                leverage: pos.leverage ?? 1,
                liquidationPrice: pos.liquidation_price ?? 0,
                status: 'OPEN',
            });
        }

        // Step 3: Bulk-load into book
        riskEngine.book.load(byAccount);

        _lastSnapshotTs = Date.now();
        _snapshotCount++;

        console.log(`[EngineBootstrap] ✓ State replaced from ENGINE_READY (snapshot #${_snapshotCount})`);

        // Broadcast to frontend so UI refreshes
        broadcast('positions_resync', {
            reason: 'engine_ready',
            ts: Date.now(),
        });
    } catch (err) {
        console.error('[EngineBootstrap] Failed to process ENGINE_READY:', err.message);
    }
}

/**
 * Request a full state snapshot from the C++ engine.
 * Should be called after bootstrapping accounts + rules.
 *
 * @param {object} bridge - The SimplxBridge instance (UDS or Redis)
 */
export async function requestEngineState(bridge) {
    if (!bridge || !bridge.isHealthy()) {
        console.warn('[EngineBootstrap] Cannot request state — engine not healthy');
        return;
    }

    console.log('[EngineBootstrap] Requesting ENGINE_READY snapshot from C++ engine...');
    await bridge.sendCommand('get_engine_state', {});
}

export function getBootstrapStatus() {
    return {
        lastSnapshotTs: _lastSnapshotTs,
        snapshotCount: _snapshotCount,
        msSinceLastSnapshot: _lastSnapshotTs ? Date.now() - _lastSnapshotTs : null,
    };
}

export default { handleEngineReady, requestEngineState, getBootstrapStatus };

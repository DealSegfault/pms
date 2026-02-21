/**
 * Babysitter Manager — Redis-stream command/status bridge.
 *
 * - No child-process spawning
 * - Publishes babysitter commands into Redis stream
 * - Consumes babysitter status stream and broadcasts to frontend
 */

import prisma from '../db/prisma.js';
import {
    BBS_STATUS_STREAM,
    BBS_FEATURES_STREAM,
    getBabysitterHeartbeat,
    getBabysitterStatus,
    publishBabysitterCommand,
    streamReadFrom,
} from '../redis.js';



class BabysitterManager {
    constructor() {
        this._wsEmitter = null;
        this._running = false;
        this._connected = false;
        this._lastStatus = null;
        this._lastStatusTs = 0;
        this._statusLoopTask = null;
        this._featuresLoopTask = null;
        this._resyncTimer = null;
        this._stopRequested = false;
    }

    // ── Lifecycle ──────────────────────────────────────────

    async initialize(wsEmitter) {
        this._wsEmitter = wsEmitter;
        this._running = true;
        this._stopRequested = false;

        // Prime local cache from latest Redis status, if available.
        try {
            const last = await getBabysitterStatus();
            if (last) {
                this._connected = true;
                this._lastStatus = last;
                this._lastStatusTs = Date.now();
                this._broadcastStatus(last);
            }
        } catch (err) {
            console.warn('[BabysitterManager] Status bootstrap failed:', err.message);
        }

        // Start background status stream reader.
        this._startStatusLoop();

        // Start background features stream reader.
        this._startFeaturesLoop();

        // Publish full snapshots for all accounts that currently have included positions.
        await this._resyncEnabledAccounts('initialize');

        // Periodic idempotent resync keeps worker state consistent across restarts.
        if (!this._resyncTimer) {
            this._resyncTimer = setInterval(() => {
                this._resyncEnabledAccounts('periodic').catch((err) => {
                    console.warn('[BabysitterManager] Periodic sync failed:', err.message);
                });
            }, 30000);
        }
    }

    async stop() {
        this._running = false;
        this._stopRequested = true;
        this._connected = false;
        if (this._resyncTimer) {
            clearInterval(this._resyncTimer);
            this._resyncTimer = null;
        }

        if (this._statusLoopTask) {
            try {
                await this._statusLoopTask;
            } catch (_) { }
            this._statusLoopTask = null;
        }

        if (this._featuresLoopTask) {
            try {
                await this._featuresLoopTask;
            } catch (_) { }
            this._featuresLoopTask = null;
        }
    }

    isRunning() {
        return this._running;
    }

    async isConnected() {
        // Fresh status frame = connected.
        if (this._lastStatusTs > 0 && (Date.now() - this._lastStatusTs) < 15_000) {
            return true;
        }

        // Fallback to heartbeat key.
        try {
            const heartbeat = await getBabysitterHeartbeat();
            return !!heartbeat;
        } catch {
            return false;
        }
    }

    getStatus() {
        return this._lastStatus;
    }

    // ── DB Snapshot → Redis Command Stream ─────────────────

    async _buildSubAccountSnapshot(subAccountId) {
        const sa = await prisma.subAccount.findUnique({
            where: { id: subAccountId },
            include: {
                botConfig: true,
                positions: {
                    where: { status: 'OPEN' },
                    select: {
                        id: true,
                        symbol: true,
                        side: true,
                        entryPrice: true,
                        quantity: true,
                        notional: true,
                        babysitterExcluded: true,
                    },
                },
                user: { select: { id: true } },
            },
        });
        if (!sa) return null;

        const positions = sa.positions.map((p) => ({
            id: p.id,
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            notional: p.notional,
        }));
        const excluded = sa.positions
            .filter((p) => p.babysitterExcluded)
            .map((p) => p.id);
        const enabled = sa.positions.some((p) => !p.babysitterExcluded);

        return {
            subAccountId: sa.id,
            userId: sa.userId || sa.user?.id || '',
            tpMode: sa.botConfig?.tpMode || 'auto',
            enabled,
            positions,
            excludedPositionIds: excluded,
            ts: Date.now(),
        };
    }

    async _resyncEnabledAccounts(reason = 'resync') {
        try {
            const activeAccounts = await prisma.virtualPosition.findMany({
                where: {
                    status: 'OPEN',
                    babysitterExcluded: false,
                },
                select: { subAccountId: true },
                distinct: ['subAccountId'],
            });
            const hintedAccounts = await prisma.botConfig.findMany({
                where: { babysitterEnabled: true },
                select: { subAccountId: true },
            });

            const subAccountIds = new Set([
                ...activeAccounts.map((row) => row.subAccountId),
                ...hintedAccounts.map((row) => row.subAccountId),
            ]);

            for (const subAccountId of subAccountIds) {
                await this._publishSyncForSubAccount(subAccountId, reason);
            }
        } catch (err) {
            console.warn('[BabysitterManager] Resync failed:', err.message);
        }
    }

    async _publishSyncForSubAccount(subAccountId, reason = 'sync') {
        const snap = await this._buildSubAccountSnapshot(subAccountId);
        if (!snap) {
            const msgId = await publishBabysitterCommand('remove_user', { subAccountId, reason, ts: Date.now() });
            if (!msgId) throw new Error('Redis unavailable for babysitter commands');
            return false;
        }

        if (!snap.enabled) {
            const msgId = await publishBabysitterCommand('remove_user', { subAccountId, reason, ts: Date.now() });
            if (!msgId) throw new Error('Redis unavailable for babysitter commands');
            return false;
        }

        const msgId = await publishBabysitterCommand('sync_account', {
            ...snap,
            reason,
        });
        if (!msgId) throw new Error('Redis unavailable for babysitter commands');
        return true;
    }

    // ── Status Stream Consumer ──────────────────────────────

    _startStatusLoop() {
        if (this._statusLoopTask) return;

        this._statusLoopTask = (async () => {
            let lastId = '$';
            while (!this._stopRequested) {
                try {
                    const entries = await streamReadFrom(BBS_STATUS_STREAM, lastId, {
                        count: 10,
                        blockMs: 5000,
                    });
                    if (!entries.length) {
                        await new Promise((r) => setTimeout(r, 300));
                        continue;
                    }

                    for (const entry of entries) {
                        lastId = entry.id;
                        const raw = entry.fields?.payload || '{}';
                        let status;
                        try {
                            status = JSON.parse(raw);
                        } catch {
                            continue;
                        }
                        this._connected = true;
                        this._lastStatus = status;
                        this._lastStatusTs = Date.now();
                        this._broadcastStatus(status);
                    }
                } catch (err) {
                    if (!this._stopRequested) {
                        console.warn('[BabysitterManager] Status stream read failed:', err.message);
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }
        })();
    }

    /**
     * Background loop: read babysitter features stream and broadcast to frontend.
     */
    _startFeaturesLoop() {
        if (this._featuresLoopTask) return;

        this._featuresLoopTask = (async () => {
            let lastId = '$';
            while (!this._stopRequested) {
                try {
                    const entries = await streamReadFrom(BBS_FEATURES_STREAM, lastId, {
                        count: 5,
                        blockMs: 2000,
                    });
                    if (!entries.length) {
                        await new Promise((r) => setTimeout(r, 200));
                        continue;
                    }

                    for (const entry of entries) {
                        lastId = entry.id;
                        const raw = entry.fields?.payload || '[]';
                        let features;
                        try {
                            features = JSON.parse(raw);
                        } catch {
                            continue;
                        }
                        if (Array.isArray(features)) {
                            this._broadcastFeatures(features);
                        }
                    }
                } catch (err) {
                    if (!this._stopRequested) {
                        console.warn('[BabysitterManager] Features stream read failed:', err.message);
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }
        })();
    }

    /**
     * Group features by subAccountId and broadcast as 'babysitter_features' WS events.
     */
    _broadcastFeatures(features) {
        if (!this._wsEmitter || !features.length) return;

        // Group by subAccountId for targeted WS delivery
        const grouped = {};
        for (const f of features) {
            const saId = f.subAccountId;
            if (!saId) continue;
            if (!grouped[saId]) grouped[saId] = [];
            grouped[saId].push(f);
        }

        for (const [subAccountId, positions] of Object.entries(grouped)) {
            this._wsEmitter('babysitter_features', {
                subAccountId,
                positions,
                ts: Date.now(),
            });
        }
    }

    /**
     * Broadcast babysitter status to frontend keyed by sub-account.
     */
    _broadcastStatus(status) {
        if (!this._wsEmitter || !status) return;
        const users = status.users || {};

        for (const [subAccountId, userStatus] of Object.entries(users)) {
            if (!userStatus?.active) continue;

            const engines = (userStatus.engines || []).map((e) => this._mapEngine(e));
            const activeGrids = engines.filter((e) => e.gridDepth > 0).length;

            this._wsEmitter('bot_status', {
                source: 'v7',
                subAccountId,
                v7: {
                    connected: true,
                    engineCount: engines.length,
                    activeGrids,
                    totalPnlUsd: userStatus.total_pnl_usd || 0,
                    totalPnlBps: userStatus.total_pnl_bps || 0,
                    portfolioNotional: userStatus.portfolio_notional || 0,
                    totalTrades: userStatus.total_trades || 0,
                },
                engines,
            });
        }
    }

    _mapEngine(e) {
        return {
            source: 'v7',
            symbol: e.symbol || '',
            state: (e.layers || e.gridDepth || 0) > 0 ? 'ACTIVE' : 'IDLE',
            gridDepth: e.layers || e.gridDepth || 0,
            maxLayers: e.max_layers || e.maxLayers || 1,
            totalExposure: e.total_notional || e.totalExposure || 0,
            avgEntry: e.avg_entry || e.avgEntry || 0,
            spreadBps: e.spread_bps || e.spreadBps || 0,
            medianSpreadBps: e.median_spread_bps || e.medianSpreadBps || 0,
            volDrift: e.vol_drift_mult || e.volDrift || 1.0,
            edgeBps: e.edge_bps || e.edgeBps || 0,
            tpTarget: e.tp_target || e.tpTarget || 0,
            minTpBps: e.min_tp_bps || e.minTpBps || 0,
            currentBps: e.current_bps || e.currentBps || 0,
            realizedBps: e.realized_bps || e.realizedBps || 0,
            realizedUsd: e.realized_usd || e.realizedUsd || 0,
            totalTrades: e.trades || e.totalTrades || 0,
            winRate: e.win_rate || e.winRate || 0,
            recoveryDebt: e.recovery_debt_usd || e.recoveryDebt || 0,
            recoveryHurdle: e.recovery_exit_hurdle_bps || e.recoveryHurdle || 0,
            circuitBreaker: e.circuit_breaker_until || null,
            babysitterExcluded: e.babysitter_excluded || false,
            restingTpPrice: e.resting_tp_price || 0,
            restingTpQty: e.resting_tp_qty || 0,
            restingTpOrderIds: e.resting_tp_order_ids || [],
            restingTpSlices: e.resting_tp_slices || 0,
        };
    }

    // ── Public Control API ──────────────────────────────────

    async enableUser(subAccountId) {
        await prisma.$transaction([
            prisma.virtualPosition.updateMany({
                where: {
                    subAccountId,
                    status: 'OPEN',
                },
                data: { babysitterExcluded: false },
            }),
            prisma.botConfig.upsert({
                where: { subAccountId },
                update: { babysitterEnabled: true },
                create: {
                    subAccountId,
                    babysitterEnabled: true,
                    enabled: false,
                },
            }),
        ]);

        await this._publishSyncForSubAccount(subAccountId, 'enable_user');
    }

    async disableUser(subAccountId) {
        await prisma.$transaction([
            prisma.virtualPosition.updateMany({
                where: {
                    subAccountId,
                    status: 'OPEN',
                },
                data: { babysitterExcluded: true },
            }),
            prisma.botConfig.upsert({
                where: { subAccountId },
                update: { babysitterEnabled: false },
                create: {
                    subAccountId,
                    babysitterEnabled: false,
                    enabled: false,
                },
            }),
        ]);
        const msgId = await publishBabysitterCommand('remove_user', {
            subAccountId,
            reason: 'disable_user',
            ts: Date.now(),
        });
        if (!msgId) {
            throw new Error('Redis unavailable for babysitter commands');
        }
    }

    async excludePosition(subAccountId, positionId) {
        await prisma.virtualPosition.update({
            where: { id: positionId },
            data: { babysitterExcluded: true },
        });
        const hasIncluded = await prisma.virtualPosition.count({
            where: {
                subAccountId,
                status: 'OPEN',
                babysitterExcluded: false,
            },
        });
        await prisma.botConfig.updateMany({
            where: { subAccountId },
            data: { babysitterEnabled: hasIncluded > 0 },
        });
        await this._publishSyncForSubAccount(subAccountId, 'exclude_position');
    }

    async includePosition(subAccountId, positionId) {
        await prisma.virtualPosition.update({
            where: { id: positionId },
            data: { babysitterExcluded: false },
        });
        const hasIncluded = await prisma.virtualPosition.count({
            where: {
                subAccountId,
                status: 'OPEN',
                babysitterExcluded: false,
            },
        });
        await prisma.botConfig.upsert({
            where: { subAccountId },
            update: { babysitterEnabled: hasIncluded > 0 },
            create: {
                subAccountId,
                babysitterEnabled: hasIncluded > 0,
                enabled: false,
            },
        });
        await this._publishSyncForSubAccount(subAccountId, 'include_position');
    }

    async refreshForSubAccount(subAccountId, reason = 'position_update') {
        try {
            if (!subAccountId) return false;
            const hasIncluded = await prisma.virtualPosition.count({
                where: {
                    subAccountId,
                    status: 'OPEN',
                    babysitterExcluded: false,
                },
            });
            await prisma.botConfig.upsert({
                where: { subAccountId },
                update: { babysitterEnabled: hasIncluded > 0 },
                create: {
                    subAccountId,
                    babysitterEnabled: hasIncluded > 0,
                    enabled: false,
                },
            });
            await this._publishSyncForSubAccount(subAccountId, reason);
            return hasIncluded > 0;
        } catch (err) {
            console.warn(`[BabysitterManager] Refresh failed for ${subAccountId}:`, err.message);
            return false;
        }
    }
}

const babysitterManager = new BabysitterManager();
export default babysitterManager;
export { BabysitterManager };

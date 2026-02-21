/**
 * LiquidationEngine — Risk evaluation and liquidation execution.
 *
 * Evaluates account risk using in-memory book data and cached prices.
 * Triggers liquidation actions through an injected trade executor.
 * Emits WS events through an injected emitter.
 *
 * Dependencies (injected):
 *   - book: PositionBook
 *   - priceService: PriceService
 *   - prisma: PrismaClient (for account status updates only)
 */
import prisma from '../db/prisma.js';
import { setRiskSnapshot } from '../redis.js';
const DEFAULT_LIQUIDATION_THRESHOLD = 0.90;
const INSOLVENCY_MARGIN_RATIO = 1.0;
const PNL_EMIT_MIN_INTERVAL_MS = 50;   // was 150ms — faster PnL delivery
const MARGIN_EMIT_MIN_INTERVAL_MS = 80; // was 200ms — faster margin delivery

export class LiquidationEngine {
    /**
     * @param {import('./position-book.js').PositionBook} book
     * @param {import('./price-service.js').PriceService} priceService
     */
    constructor(book, priceService) {
        this._book = book;
        this._priceService = priceService;
        this._wsEmitter = null;

        /** @type {Set<string>} subAccountIds currently being liquidated */
        this._liquidationLock = new Set();
        /** @type {Set<string>} subAccountIds currently being evaluated */
        this._evaluatingAccounts = new Set();
        this._lastPnlEmitTs = new Map();
        this._pendingPnlPayload = new Map();
        this._pnlEmitTimers = new Map();
        this._lastMarginEmitTs = new Map();
        this._pendingMarginPayload = new Map();
        this._marginEmitTimers = new Map();

        // In-memory rules cache with 60s TTL (Fix 4: eliminates DB reads during tick evaluation)
        this._rulesCache = new Map(); // subAccountId → { rules, expiresAt }

        // Snapshot write throttle (Fix 11: max 1 Redis write/sec per account)
        this._lastSnapshotTs = new Map(); // subAccountId → timestamp

        // Injected later to avoid circular dependency with TradeExecutor
        this._closePosition = null;
        this._partialClose = null;
        this._takeoverPosition = null;
    }

    setWsEmitter(emitter) {
        this._wsEmitter = emitter;
    }

    _emitThrottled({
        eventType,
        key,
        payload,
        minIntervalMs,
        lastMap,
        pendingMap,
        timerMap,
    }) {
        if (!this._wsEmitter) return;

        const now = Date.now();
        const lastTs = lastMap.get(key) || 0;
        const elapsed = now - lastTs;

        if (elapsed >= minIntervalMs) {
            this._wsEmitter(eventType, payload);
            lastMap.set(key, now);
            pendingMap.delete(key);
            if (timerMap.has(key)) {
                clearTimeout(timerMap.get(key));
                timerMap.delete(key);
            }
            return;
        }

        pendingMap.set(key, payload);
        if (timerMap.has(key)) return;

        const waitMs = Math.max(0, minIntervalMs - elapsed);
        const timer = setTimeout(() => {
            timerMap.delete(key);
            const latest = pendingMap.get(key);
            if (!latest || !this._wsEmitter) return;
            pendingMap.delete(key);
            this._wsEmitter(eventType, latest);
            lastMap.set(key, Date.now());
        }, waitMs);
        timerMap.set(key, timer);
    }

    _emitPnlUpdate(subAccountId, positionId, payload) {
        const key = `${subAccountId}:${positionId}`;
        this._emitThrottled({
            eventType: 'pnl_update',
            key,
            payload,
            minIntervalMs: PNL_EMIT_MIN_INTERVAL_MS,
            lastMap: this._lastPnlEmitTs,
            pendingMap: this._pendingPnlPayload,
            timerMap: this._pnlEmitTimers,
        });
    }

    _emitMarginUpdate(subAccountId, payload) {
        const key = String(subAccountId);
        this._emitThrottled({
            eventType: 'margin_update',
            key,
            payload,
            minIntervalMs: MARGIN_EMIT_MIN_INTERVAL_MS,
            lastMap: this._lastMarginEmitTs,
            pendingMap: this._pendingMarginPayload,
            timerMap: this._marginEmitTimers,
        });
    }

    /**
     * Inject trade actions (avoids circular dep with TradeExecutor).
     * Must be called during wiring before any evaluations.
     */
    setTradeActions({ closePosition, partialClose, liquidatePosition, takeoverPosition }) {
        this._closePosition = closePosition;
        this._partialClose = partialClose;
        this._liquidatePosition = liquidatePosition;
        this._takeoverPosition = takeoverPosition;
    }

    /** Check if an account is currently being evaluated. */
    isEvaluating(subAccountId) {
        return this._evaluatingAccounts.has(subAccountId);
    }

    /** Mark an account as being evaluated. */
    startEvaluation(subAccountId) {
        this._evaluatingAccounts.add(subAccountId);
    }

    /** Mark an account evaluation as finished. */
    endEvaluation(subAccountId) {
        this._evaluatingAccounts.delete(subAccountId);
    }

    // ── Risk Rules ───────────────────────────────────

    async getRules(subAccountId) {
        // Check in-memory cache first (60s TTL)
        const cached = this._rulesCache.get(subAccountId);
        if (cached && cached.expiresAt > Date.now()) return cached.rules;

        let rules = await prisma.riskRule.findUnique({ where: { subAccountId } });
        if (!rules) {
            rules = await prisma.riskRule.findFirst({ where: { isGlobal: true } });
        }
        const result = rules || {
            maxLeverage: 100,
            maxNotionalPerTrade: 200,
            maxTotalExposure: 500,
            liquidationThreshold: DEFAULT_LIQUIDATION_THRESHOLD,
        };

        this._rulesCache.set(subAccountId, { rules: result, expiresAt: Date.now() + 60_000 });
        return result;
    }

    // ── Pure Calculations ────────────────────────────

    calculateLiquidationPrice(side, entryPrice, leverage, balance, notional, maintenanceRate = 0.005, liquidationThreshold = 0.90) {
        const quantity = notional / entryPrice;
        const maintenanceMargin = notional * maintenanceRate;
        const threshold = (liquidationThreshold > 0 && liquidationThreshold <= 1) ? liquidationThreshold : 0.90;
        const equityFloor = maintenanceMargin / threshold;
        const availableForLoss = balance - equityFloor;

        if (side === 'LONG') {
            return Math.max(0, entryPrice - availableForLoss / quantity);
        } else {
            return entryPrice + availableForLoss / quantity;
        }
    }

    calculateDynamicLiquidationPrices(account, positions, markPrices = null, liquidationThreshold = DEFAULT_LIQUIDATION_THRESHOLD) {
        if (!positions || positions.length === 0) return {};

        const maintenanceRate = account.maintenanceRate || 0.005;
        const threshold = this._safeThreshold(liquidationThreshold);

        const getMark = (symbol, fallback) => {
            if (markPrices instanceof Map) {
                return markPrices.get(symbol) ?? fallback;
            }
            if (markPrices && typeof markPrices === 'object' && markPrices[symbol] != null) {
                return markPrices[symbol];
            }
            return fallback;
        };

        const totalMM = positions.reduce((sum, p) => sum + p.notional * maintenanceRate, 0);
        const equityFloor = totalMM / threshold;

        const upnlByPos = new Map();
        let totalUpnl = 0;
        for (const pos of positions) {
            const mark = getMark(pos.symbol, pos.entryPrice);
            const upnl = pos.side === 'LONG'
                ? (mark - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - mark) * pos.quantity;
            upnlByPos.set(pos.id, upnl);
            totalUpnl += upnl;
        }

        const liqByPosition = {};
        for (const pos of positions) {
            if (!pos.quantity || pos.quantity <= 0) {
                liqByPosition[pos.id] = pos.entryPrice;
                continue;
            }

            const otherUpnl = totalUpnl - (upnlByPos.get(pos.id) || 0);
            const baseWithoutPosition = account.currentBalance + otherUpnl;
            const requiredMove = (equityFloor - baseWithoutPosition) / pos.quantity;

            let liqPrice;
            if (pos.side === 'LONG') {
                liqPrice = pos.entryPrice + requiredMove;
            } else {
                liqPrice = pos.entryPrice - requiredMove;
            }

            liqByPosition[pos.id] = Number.isFinite(liqPrice)
                ? Math.max(0, liqPrice)
                : pos.entryPrice;
        }

        return liqByPosition;
    }

    calculateAccountLiqPrice(account, positions, exchange, liquidationThreshold = DEFAULT_LIQUIDATION_THRESHOLD, markPrices = null) {
        if (!positions || positions.length === 0) return null;

        const marks = markPrices instanceof Map || (markPrices && typeof markPrices === 'object')
            ? markPrices
            : new Map();
        if (marks instanceof Map && exchange?.getLatestPrice) {
            for (const pos of positions) {
                if (!marks.has(pos.symbol)) {
                    marks.set(pos.symbol, exchange.getLatestPrice(pos.symbol) || pos.entryPrice);
                }
            }
        }

        const liqByPosition = this.calculateDynamicLiquidationPrices(
            account,
            positions,
            marks,
            liquidationThreshold
        );

        const largest = this._maxNotionalPosition(positions);
        if (!largest) return null;
        return liqByPosition[largest.id] ?? null;
    }

    // ── Core Evaluation ──────────────────────────────

    /**
     * Evaluate a single account's risk using ONLY in-memory data.
     * Async because liquidation actions hit DB/exchange.
     */
    async evaluateAccount(subAccountId) {
        const entry = this._book.getEntry(subAccountId);
        if (!entry || entry.positions.size === 0) return;
        if (entry.account.status === 'LIQUIDATED' || entry.account.status === 'FROZEN') return;

        // Resolve threshold first so derived liquidation prices are consistent with live triggers
        if (!entry.rules) {
            entry.rules = await this.getRules(subAccountId);
        }
        const T = this._safeThreshold(entry.rules.liquidationThreshold);

        const { account, positions } = entry;
        const positionList = [...positions.values()];
        let totalUpnl = 0;
        let totalNotional = 0;
        let totalMarginUsed = 0;
        const markBySymbol = new Map();
        const markByPosition = new Map();
        const upnlByPosition = new Map();

        for (const pos of positionList) {
            const markPrice = this._priceService.getPrice(pos.symbol) || pos.entryPrice;
            markBySymbol.set(pos.symbol, markPrice);
            markByPosition.set(pos.id, markPrice);
            const unrealizedPnl = pos.side === 'LONG'
                ? (markPrice - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - markPrice) * pos.quantity;
            upnlByPosition.set(pos.id, unrealizedPnl);
            totalUpnl += unrealizedPnl;
            totalNotional += pos.notional;
            totalMarginUsed += pos.margin;
        }

        const maintenanceRate = account.maintenanceRate || 0.005;
        const equityRaw = account.currentBalance + totalUpnl;
        const maintenanceMargin = totalNotional * maintenanceRate;
        const marginRatio = equityRaw > 0 ? maintenanceMargin / equityRaw : 999;
        const liqByPosition = this.calculateDynamicLiquidationPrices(account, positionList, markBySymbol, T);
        const accountLiqPrice = this.calculateAccountLiqPrice(account, positionList, null, T, markBySymbol);
        const equity = Math.max(0, equityRaw);

        for (const pos of positionList) {
            const markPrice = markByPosition.get(pos.id) || pos.entryPrice;
            const unrealizedPnl = upnlByPosition.get(pos.id) || 0;
            const dynamicLiq = liqByPosition[pos.id] ?? pos.liquidationPrice;
            pos.liquidationPrice = dynamicLiq;

            // Emit per-position PnL update
            this._emitPnlUpdate(subAccountId, pos.id, {
                subAccountId, positionId: pos.id, symbol: pos.symbol,
                side: pos.side, entryPrice: pos.entryPrice, markPrice,
                quantity: pos.quantity,
                unrealizedPnl, liquidationPrice: dynamicLiq,
                margin: pos.margin,
                pnlPercent: pos.margin > 0 ? (unrealizedPnl / pos.margin) * 100 : 0,
            });
        }

        // Emit account-level margin info
        this._emitMarginUpdate(subAccountId, {
            subAccountId, equity, balance: account.currentBalance,
            unrealizedPnl: totalUpnl, marginUsed: totalMarginUsed,
            availableMargin: equity - totalMarginUsed,
            totalExposure: totalNotional, maintenanceMargin, marginRatio,
            accountLiqPrice,
            positionCount: positions.size,
        });

        this._publishRiskSnapshot(subAccountId, {
            subAccountId,
            timestamp: Date.now(),
            status: account.status,
            liquidationMode: account.liquidationMode,
            liquidationThreshold: T,
            equity,
            equityRaw,
            balance: account.currentBalance,
            unrealizedPnl: totalUpnl,
            marginUsed: totalMarginUsed,
            availableMargin: equity - totalMarginUsed,
            totalExposure: totalNotional,
            maintenanceMargin,
            marginRatio,
            accountLiqPrice,
            positions: positionList.map(pos => ({
                id: pos.id,
                symbol: pos.symbol,
                side: pos.side,
                entryPrice: pos.entryPrice,
                markPrice: markByPosition.get(pos.id) || pos.entryPrice,
                quantity: pos.quantity,
                notional: pos.notional,
                leverage: pos.leverage,
                margin: pos.margin,
                liquidationPrice: liqByPosition[pos.id] ?? pos.liquidationPrice,
                unrealizedPnl: upnlByPosition.get(pos.id) || 0,
                pnlPercent: pos.margin > 0 ? ((upnlByPosition.get(pos.id) || 0) / pos.margin) * 100 : 0,
                babysitterExcluded: pos.babysitterExcluded ?? false,
                openedAt: pos.openedAt || null,
            })),
        });

        // Skip if already being liquidated
        if (this._liquidationLock.has(subAccountId)) return;

        // Hard guard: once equity is depleted (or maintenance/equity >= 100%), exit all risk immediately.
        if (equityRaw <= 0 || marginRatio >= INSOLVENCY_MARGIN_RATIO) {
            await this._handleHardLiquidation(subAccountId, account, positions, marginRatio);
            return;
        }

        // --- Liquidation Checks ---
        if (account.liquidationMode === 'TAKEOVER') {
            await this._handleTakeover(subAccountId, account, positions, marginRatio, T);
        } else if (account.liquidationMode === 'INSTANT_CLOSE') {
            await this._handleInstantClose(subAccountId, account, positions, marginRatio, T);
        } else {
            await this._handleADL(subAccountId, account, positions, marginRatio, T);
        }
    }

    // ── Private: Liquidation Strategies ──────────────

    async _handleTakeover(subAccountId, account, positions, marginRatio, T) {
        if (marginRatio < T) return;

        await this._takeoverAllPositions(subAccountId, account, positions, marginRatio, 'VIRTUAL_LIQ');
    }

    async _handleInstantClose(subAccountId, account, positions, marginRatio, T) {
        if (marginRatio < T) return;

        await this._liquidateAllPositions(subAccountId, account, positions, marginRatio, 'INSTANT_CLOSE');
    }

    async _handleHardLiquidation(subAccountId, account, positions, marginRatio) {
        // Respect TAKEOVER mode even at insolvency — virtually close, don't touch exchange
        if (account.liquidationMode === 'TAKEOVER') {
            await this._takeoverAllPositions(subAccountId, account, positions, marginRatio, 'INSOLVENCY_TAKEOVER');
        } else {
            await this._liquidateAllPositions(subAccountId, account, positions, marginRatio, 'INSOLVENCY_GUARD');
        }
    }

    async _liquidateAllPositions(subAccountId, account, positions, marginRatio, mode) {
        this._liquidationLock.add(subAccountId);
        console.log(`[Risk] ⚡ FULL LIQUIDATION (tick): ${account.name} | mode=${mode} | MR: ${(marginRatio * 100).toFixed(1)}%`);

        if (this._wsEmitter) {
            this._wsEmitter('full_liquidation', { subAccountId, marginRatio, mode });
        }

        try {
            const posIds = positions instanceof Map
                ? [...positions.keys()]
                : [...positions].map(p => p.id);
            for (const posId of posIds) {
                try {
                    await this._liquidatePosition(posId);
                } catch (err) {
                    console.error(`[Risk] Failed to liquidate position ${posId}:`, err.message);
                    // Continue liquidating remaining positions
                }
            }
            await prisma.subAccount.update({ where: { id: subAccountId }, data: { status: 'LIQUIDATED' } });

            // Sync in-memory book status
            const bookEntry = this._book.getEntry(subAccountId);
            if (bookEntry) bookEntry.account.status = 'LIQUIDATED';

            const fresh = await prisma.subAccount.findUnique({
                where: { id: subAccountId },
                select: { currentBalance: true },
            });
            this._emitZeroedMargin(subAccountId, fresh?.currentBalance ?? 0, 'LIQUIDATED');
        } catch (err) {
            console.error(`[Risk] Liquidation execution error:`, err.message);
        } finally {
            this._liquidationLock.delete(subAccountId);
        }
    }

    /**
     * TAKEOVER mode: virtually close all positions (settle PnL on the user's book)
     * but do NOT send any market orders to the exchange. The position stays open
     * on the real exchange and is absorbed by the admin/house.
     */
    async _takeoverAllPositions(subAccountId, account, positions, marginRatio, mode) {
        this._liquidationLock.add(subAccountId);
        console.log(`[Risk] 🔄 TAKEOVER (virtual liq): ${account.name} | mode=${mode} | MR: ${(marginRatio * 100).toFixed(1)}%`);

        if (this._wsEmitter) {
            this._wsEmitter('full_liquidation', { subAccountId, marginRatio, mode });
        }

        try {
            const posIds = positions instanceof Map
                ? [...positions.keys()]
                : [...positions].map(p => p.id);
            for (const posId of posIds) {
                try {
                    await this._takeoverPosition(posId, 'SYSTEM_LIQ');
                } catch (err) {
                    console.error(`[Risk] Failed to takeover position ${posId}:`, err.message);
                }
            }
            await prisma.subAccount.update({ where: { id: subAccountId }, data: { status: 'LIQUIDATED' } });

            // Sync in-memory book status
            const bookEntry = this._book.getEntry(subAccountId);
            if (bookEntry) bookEntry.account.status = 'LIQUIDATED';

            const fresh = await prisma.subAccount.findUnique({
                where: { id: subAccountId },
                select: { currentBalance: true },
            });
            this._emitZeroedMargin(subAccountId, fresh?.currentBalance ?? 0, 'LIQUIDATED');
        } catch (err) {
            console.error(`[Risk] Takeover execution error:`, err.message);
        } finally {
            this._liquidationLock.delete(subAccountId);
        }
    }

    async _handleADL(subAccountId, account, positions, marginRatio, T) {
        const largest = this._maxNotionalPosition(positions.values());
        if (!largest) return;

        if (marginRatio >= T + 0.05) {
            // Tier 3: Critical
            await this._adlTier3(subAccountId, account, positions, largest, marginRatio, T);
        } else if (marginRatio >= T) {
            // Tier 2
            await this._adlTier2(subAccountId, account, largest, marginRatio);
        } else if (marginRatio >= T - 0.10) {
            // Tier 1: Warning
            if (this._wsEmitter) {
                this._wsEmitter('margin_warning', {
                    subAccountId, marginRatio,
                    message: `Margin ratio ${(marginRatio * 100).toFixed(1)}% — approaching liquidation`,
                });
            }
        }
    }

    async _adlTier2(subAccountId, account, largest, marginRatio) {
        this._liquidationLock.add(subAccountId);
        console.log(`[Risk] ⚡ TIER 2 ADL (tick): ${account.name} | MR: ${(marginRatio * 100).toFixed(1)}%`);

        if (this._wsEmitter) {
            this._wsEmitter('adl_triggered', {
                subAccountId, tier: 2, symbol: largest.symbol,
                fraction: 0.3, marginRatio,
            });
        }

        try {
            await this._partialClose(largest.id, 0.3, 'ADL_TIER2');
        } catch (err) {
            console.error(`[Risk] Tier 2 ADL error:`, err.message);
        } finally {
            this._liquidationLock.delete(subAccountId);
        }
    }

    async _adlTier3(subAccountId, account, positions, largest, marginRatio, T) {
        this._liquidationLock.add(subAccountId);
        console.log(`[Risk] ⚡ TIER 3 ADL (tick): ${account.name} | MR: ${(marginRatio * 100).toFixed(1)}%`);

        if (this._wsEmitter) {
            this._wsEmitter('adl_triggered', {
                subAccountId, tier: 3, symbol: largest.symbol,
                fraction: 0.3, marginRatio,
            });
        }

        try {
            await this._partialClose(largest.id, 0.3, 'ADL_TIER3');

            // Re-check after partial close
            const freshEntry = this._book.getEntry(subAccountId);
            if (freshEntry && freshEntry.positions.size > 0) {
                let freshUpnl = 0, freshNotional = 0;
                for (const p of freshEntry.positions.values()) {
                    const mp = this._priceService.getPrice(p.symbol) || p.entryPrice;
                    freshUpnl += p.side === 'LONG'
                        ? (mp - p.entryPrice) * p.quantity
                        : (p.entryPrice - mp) * p.quantity;
                    freshNotional += p.notional;
                }
                const freshEquity = freshEntry.account.currentBalance + freshUpnl;
                const freshMM = freshNotional * freshEntry.account.maintenanceRate;
                const freshMR = freshEquity > 0 ? freshMM / freshEquity : 999;

                if (freshMR >= T) {
                    console.log(`[Risk] ⚡ FULL LIQ (tick): ${account.name} | MR still ${(freshMR * 100).toFixed(1)}% after Tier 3`);
                    if (this._wsEmitter) {
                        this._wsEmitter('full_liquidation', { subAccountId, marginRatio: freshMR, mode: 'ADL_30_ESCALATED' });
                    }
                    const remainingIds = [...freshEntry.positions.keys()];
                    for (const pid of remainingIds) {
                        try {
                            await this._liquidatePosition(pid);
                        } catch (err) {
                            console.error(`[Risk] Failed to liquidate position ${pid} in Tier 3 escalation:`, err.message);
                        }
                    }
                    await prisma.subAccount.update({ where: { id: subAccountId }, data: { status: 'LIQUIDATED' } });

                    // Sync in-memory book status
                    const bookEntry = this._book.getEntry(subAccountId);
                    if (bookEntry) bookEntry.account.status = 'LIQUIDATED';

                    const fresh = await prisma.subAccount.findUnique({
                        where: { id: subAccountId },
                        select: { currentBalance: true },
                    });
                    this._emitZeroedMargin(subAccountId, fresh?.currentBalance ?? 0, 'LIQUIDATED');
                }
            }
        } catch (err) {
            console.error(`[Risk] Tier 3 ADL error:`, err.message);
        } finally {
            this._liquidationLock.delete(subAccountId);
        }
    }

    _safeThreshold(threshold) {
        return Number.isFinite(threshold) && threshold > 0
            ? threshold
            : DEFAULT_LIQUIDATION_THRESHOLD;
    }

    /**
     * Returns the effective threshold at which a full position close occurs.
     * For INSTANT_CLOSE: T (everything closes at threshold).
     * For ADL_30: T + 0.05 (Tier 2 at T is only 30% partial; full close is Tier 3).
     */
    effectiveFullLiqThreshold(T, liquidationMode = 'ADL_30') {
        if (liquidationMode === 'INSTANT_CLOSE' || liquidationMode === 'TAKEOVER') return T;
        return Math.min(T + 0.05, 1.0);
    }

    _maxNotionalPosition(positionsIterable) {
        let largest = null;
        for (const pos of positionsIterable || []) {
            if (!largest || (pos?.notional || 0) > (largest?.notional || 0)) {
                largest = pos;
            }
        }
        return largest;
    }

    _publishRiskSnapshot(subAccountId, snapshot) {
        // Throttle: max 1 Redis write/sec per account
        const now = Date.now();
        const last = this._lastSnapshotTs.get(subAccountId) || 0;
        if (now - last < 1000) return;
        this._lastSnapshotTs.set(subAccountId, now);

        setRiskSnapshot(subAccountId, snapshot).catch((err) => {
            console.debug('[Risk] Redis snapshot write failed:', err.message);
        });
    }

    _emitZeroedMargin(subAccountId, balanceOverride = null, status = 'ACTIVE') {
        const entry = this._book.getEntry(subAccountId);
        const bal = Math.max(0, balanceOverride ?? entry?.account?.currentBalance ?? 0);
        if (this._wsEmitter) {
            this._wsEmitter('margin_update', {
                subAccountId, equity: bal, balance: bal,
                unrealizedPnl: 0, marginUsed: 0, availableMargin: bal,
                totalExposure: 0, maintenanceMargin: 0, marginRatio: 0,
                accountLiqPrice: null, positionCount: 0,
            });
        }
        this._publishRiskSnapshot(subAccountId, {
            subAccountId,
            timestamp: Date.now(),
            status,
            liquidationMode: entry?.account?.liquidationMode || null,
            liquidationThreshold: null,
            equity: bal,
            equityRaw: bal,
            balance: bal,
            unrealizedPnl: 0,
            marginUsed: 0,
            availableMargin: bal,
            totalExposure: 0,
            maintenanceMargin: 0,
            marginRatio: 0,
            accountLiqPrice: null,
            positions: [],
        });
    }
}

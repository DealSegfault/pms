/**
 * RiskEngine — Thin facade that composes all risk sub-modules.
 *
 * Exposes the same public API as the old monolithic risk-engine.js.
 * All consumers import this file; internal structure is invisible.
 *
 * Sub-modules:
 *   - PositionBook:      In-memory position tracking (zero side effects)
 *   - PriceService:      Mark price resolution (WS → REST fallback)
 *   - LiquidationEngine: Risk evaluation + ADL tiers
 *   - TradeExecutor:     Trade validation, execution, position management
 */
import prisma from '../db/prisma.js';
import exchange from '../exchange.js';
import { PositionBook } from './position-book.js';
import { PriceService } from './price-service.js';
import { LiquidationEngine } from './liquidation.js';
import { TradeExecutor } from './trade-executor.js';
import { ERR, parseExchangeError } from './errors.js';
import { sanitize } from '../sanitize.js';
import { getRiskSnapshot } from '../redis.js';
import { BoundedMap } from '../bounded-map.js';



class RiskEngine {
    constructor() {
        // --- Compose sub-modules ---
        this.book = new PositionBook();
        this.priceService = new PriceService(exchange);
        this.liquidation = new LiquidationEngine(this.book, this.priceService);
        this.tradeExecutor = new TradeExecutor(exchange, this.book, this.priceService, this.liquidation);

        // Wire liquidation → trade actions (avoids circular dep)
        this.liquidation.setTradeActions({
            closePosition: (posId, action) => this.tradeExecutor.closePosition(posId, action),
            partialClose: (posId, fraction, action) => this.tradeExecutor.partialClose(posId, fraction, action),
            liquidatePosition: (posId) => this.tradeExecutor.liquidatePosition(posId),
            takeoverPosition: (posId, adminUserId) => this.tradeExecutor.takeoverPosition(posId, adminUserId),
        });

        this._monitorInterval = null;

        // Dirty flag: skip monitorPositions() DB read when nothing changed
        this._positionsDirty = true;

        // Bounded map for tick evaluation throttle (Fix 8: prevents unbounded growth)
        this._lastEvalTs = new BoundedMap(2000);
    }

    /** Mark the position book as stale — next monitorPositions() will reload from DB. */
    markPositionsDirty() {
        this._positionsDirty = true;
    }

    // ── WS Emitter ───────────────────────────────────

    setWsEmitter(emitter) {
        this.liquidation.setWsEmitter(emitter);
        this.tradeExecutor.setWsEmitter(emitter);
        this._wsEmitter = emitter;
    }

    // ── Delegated Public API (same interface as before) ──

    /** Validate a trade before execution. */
    async validateTrade(...args) {
        return this.tradeExecutor.validateTrade(...args);
    }

    /** Execute a trade (open or flip). */
    async executeTrade(...args) {
        const result = await this.tradeExecutor.executeTrade(...args);
        this._positionsDirty = true;
        return result;
    }

    /** Close a position entirely. */
    async closePosition(...args) {
        const result = await this.tradeExecutor.closePosition(...args);
        this._positionsDirty = true;
        return result;
    }

    /** Partially close a position (ADL). */
    async partialClose(...args) {
        const result = await this.tradeExecutor.partialClose(...args);
        this._positionsDirty = true;
        return result;
    }

    /** Admin takeover of a position. */
    async takeoverPosition(...args) {
        const result = await this.tradeExecutor.takeoverPosition(...args);
        this._positionsDirty = true;
        return result;
    }

    /** Reconcile exchange position closure. */
    async reconcilePosition(...args) {
        const result = await this.tradeExecutor.reconcilePosition(...args);
        this._positionsDirty = true;
        return result;
    }

    /** Close a babysitter position (exchange-first, optional virtual fallback). */
    async closeVirtualPositionByPrice(...args) {
        const result = await this.tradeExecutor.closeVirtualPositionByPrice(...args);
        this._positionsDirty = true;
        return result;
    }

    /** Get risk rules for an account. */
    async getRules(...args) {
        return this.liquidation.getRules(...args);
    }

    /** Calculate position-level liquidation price. */
    calculateLiquidationPrice(...args) {
        return this.liquidation.calculateLiquidationPrice(...args);
    }

    /** Calculate account-level liquidation price. */
    calculateAccountLiqPrice(account, positions) {
        return this.liquidation.calculateAccountLiqPrice(account, positions, exchange);
    }

    // ── Monitoring / Lifecycle ────────────────────────

    async startMonitoring(safetyIntervalMs = 10000) {
        if (this._monitorInterval) return;

        // 1. Load in-memory position book from DB
        try {
            await this._loadPositionBook();
        } catch (err) {
            console.error('[Risk] Failed to load position book:', err.message);
        }

        // 2. Subscribe to real-time price events
        exchange.on('price', (tick) => this._onPriceTick(tick));
        console.log('[Risk] ⚡ Event-driven risk engine active (tick-level liquidation checks)');

        // 3. Safety-net risk sweep: evaluate all accounts every 60s + WS health check
        // The hot path is handled by _onPriceTick (event-driven, sub-second)
        this._riskSweepInterval = setInterval(() => this._riskSweep(), 60_000);
        console.log('[Risk] Safety sweep every 60s (tick-driven evaluation handles hot path)');

        // 4. Safety-net: sync book with DB periodically
        console.log(`[Risk] Book sync every ${safetyIntervalMs / 1000}s`);
        this._monitorInterval = setInterval(() => this.monitorPositions(), safetyIntervalMs);
    }

    stopMonitoring() {
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
            this._monitorInterval = null;
        }
        if (this._riskSweepInterval) {
            clearInterval(this._riskSweepInterval);
            this._riskSweepInterval = null;
        }
        exchange.removeAllListeners('price');
        console.log('[Risk] Position monitor stopped');
    }

    // ── Fast Risk Sweep (2s heartbeat) ───────────────

    async _riskSweep() {
        try {
            // 1. Check WS health — reconnect stale symbols
            const stale = exchange.getStaleSymbols(5000);
            for (const symbol of stale) {
                console.warn(`[Risk] Stale WS detected: ${symbol} — force-reconnecting`);
                exchange.forceResubscribe(symbol);
            }

            // 2. Force-evaluate every account with open positions
            for (const [subAccountId] of this.book.entries()) {
                if (this.liquidation.isEvaluating(subAccountId)) continue;
                this.liquidation.startEvaluation(subAccountId);
                this.liquidation.evaluateAccount(subAccountId)
                    .catch(err => {
                        console.error(`[Risk] Sweep evaluation error for ${subAccountId}:`, err.message);
                    })
                    .finally(() => {
                        this.liquidation.endEvaluation(subAccountId);
                    });
            }
        } catch (err) {
            console.error(`[Risk] Risk sweep error:`, err.message);
        }
    }

    // ── Price Tick Handler (HOT PATH) ────────────────

    _onPriceTick({ symbol, mark }) {
        this.priceService.setPrice(symbol, mark);

        const accountIds = this.book.getAccountsForSymbol(symbol);
        if (!accountIds || accountIds.size === 0) return;

        const now = Date.now();
        for (const subAccountId of accountIds) {
            // Throttle: at most one evaluation per account per 100ms (was 500ms)
            const lastEval = this._lastEvalTs.get(subAccountId) || 0;
            if (now - lastEval < 100) continue;
            if (this.liquidation.isEvaluating(subAccountId)) continue;

            this._lastEvalTs.set(subAccountId, now);

            this.liquidation.startEvaluation(subAccountId);
            this.liquidation.evaluateAccount(subAccountId)
                .catch(err => {
                    console.error(`[Risk] Tick evaluation error for ${subAccountId}:`, err.message);
                })
                .finally(() => {
                    this.liquidation.endEvaluation(subAccountId);
                });
        }
    }

    // ── Book Loading (startup) ───────────────────────

    async _loadPositionBook() {
        const openPositions = await prisma.virtualPosition.findMany({
            where: { status: 'OPEN' },
            include: { subAccount: true },
        });

        const byAccount = {};
        for (const pos of openPositions) {
            if (!byAccount[pos.subAccountId]) {
                byAccount[pos.subAccountId] = { account: pos.subAccount, positions: [], rules: null };
            }
            byAccount[pos.subAccountId].positions.push(pos);
        }

        // Pre-load rules for each account in parallel
        await Promise.all(
            Object.entries(byAccount).map(async ([subAccountId, entry]) => {
                entry.rules = await this.liquidation.getRules(subAccountId);
            }),
        );

        this.book.load(byAccount);

        const posCount = openPositions.length;
        const acctCount = Object.keys(byAccount).length;
        const symbols = [...new Set(openPositions.map(p => p.symbol))];
        console.log(`[Risk] Position book loaded: ${posCount} positions across ${acctCount} accounts (${symbols.length} symbols)`);

        if (symbols.length > 0) {
            exchange.subscribeToPrices(symbols);
        }
    }

    // ── Book Sync (safety net — reconciles book with DB) ─

    async monitorPositions() {
        try {
            // Skip DB read if nothing has changed since last sync
            if (!this._positionsDirty) return;
            this._positionsDirty = false;

            const openPositions = await prisma.virtualPosition.findMany({
                where: { status: 'OPEN' },
                include: { subAccount: true },
            });

            const dbPositionIds = new Set(openPositions.map(p => p.id));

            const dbByAccount = {};
            for (const pos of openPositions) {
                if (!dbByAccount[pos.subAccountId]) {
                    dbByAccount[pos.subAccountId] = { account: pos.subAccount, positions: [] };
                }
                dbByAccount[pos.subAccountId].positions.push(pos);
            }

            // Remove orphaned positions from book
            for (const [subAccountId, entry] of this.book.entries()) {
                for (const [posId] of entry.positions) {
                    if (!dbPositionIds.has(posId)) {
                        console.log(`[Risk] Book sync: removing orphaned position ${posId} from ${subAccountId}`);
                        this.book.remove(posId, subAccountId);
                    }
                }
            }

            // Add missing positions to book
            for (const [subAccountId, { account, positions }] of Object.entries(dbByAccount)) {
                if (account.status === 'LIQUIDATED' || account.status === 'FROZEN') continue;

                for (const pos of positions) {
                    const bookEntry = this.book.getEntry(subAccountId);
                    if (!bookEntry || !bookEntry.positions.has(pos.id)) {
                        console.log(`[Risk] Book sync: adding missing position ${pos.id} (${pos.symbol}) to ${subAccountId}`);
                        this.book.add(pos, account);
                    }
                }

                this.book.updateBalance(subAccountId, account.currentBalance);

                const symbols = positions.map(p => p.symbol);
                exchange.subscribeToPrices(symbols);
            }

            // Remove empty accounts from book
            for (const [subAccountId] of this.book.entries()) {
                if (!dbByAccount[subAccountId]) {
                    console.log(`[Risk] Book sync: removing empty account ${subAccountId} from book`);
                    this.book.delete(subAccountId);
                }
            }

            // SAFETY NET: Refresh in-memory prices from WS cache (no REST calls)
            const allSymbols = [...new Set(openPositions.map(p => p.symbol))];
            for (const symbol of allSymbols) {
                const mark = exchange.getLatestPrice(symbol);
                if (mark) this.priceService.setPrice(symbol, mark);
            }

            // Fire-and-forget evaluations (don't block event loop with sequential awaits)
            for (const [subAccountId] of this.book.entries()) {
                if (this.liquidation.isEvaluating(subAccountId)) continue;
                this.liquidation.startEvaluation(subAccountId);
                this.liquidation.evaluateAccount(subAccountId)
                    .catch(err => {
                        console.error(`[Risk] Safety-net evaluation error for ${subAccountId}:`, err.message);
                    })
                    .finally(() => {
                        this.liquidation.endEvaluation(subAccountId);
                    });
            }
        } catch (err) {
            console.error('[Risk] Book sync error:', err.message);
        }
    }

    // ── Account Info (query) ─────────────────────────

    async getAccountSummary(subAccountId) {
        // Fast path: try Redis snapshot first (written every tick by evaluateAccount)
        try {
            const snapshot = await getRiskSnapshot(subAccountId);
            if (snapshot && snapshot.timestamp && (Date.now() - snapshot.timestamp) < 5000) {
                const account = await prisma.subAccount.findUnique({
                    where: { id: subAccountId },
                    select: { id: true, name: true, status: true, currentBalance: true, liquidationMode: true, maintenanceRate: true, userId: true, createdAt: true },
                });
                if (account) {
                    const rules = await this.getRules(subAccountId);
                    return {
                        account: sanitize(account),
                        positions: snapshot.positions || [],
                        summary: {
                            equity: snapshot.equity, balance: snapshot.balance,
                            unrealizedPnl: snapshot.unrealizedPnl, marginUsed: snapshot.marginUsed,
                            availableMargin: snapshot.availableMargin, totalExposure: snapshot.totalExposure,
                            maintenanceMargin: snapshot.maintenanceMargin, marginRatio: snapshot.marginRatio,
                            accountLiqPrice: snapshot.accountLiqPrice,
                            positionCount: (snapshot.positions || []).length,
                            liquidationMode: snapshot.liquidationMode,
                        },
                        rules,
                    };
                }
            }
        } catch { /* fall through to DB path */ }

        // Slow path: full DB read (fallback when snapshot is stale or missing)
        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return null;

        const rules = await this.getRules(subAccountId);
        const liquidationThreshold = Number.isFinite(rules?.liquidationThreshold) && rules.liquidationThreshold > 0
            ? rules.liquidationThreshold
            : 0.90;

        const positions = await prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });

        const symbols = positions.map((p) => p.symbol);
        const markBySymbol = new Map();
        for (const sym of symbols) {
            const mark = this.priceService.getPrice(sym) || exchange.getLatestPrice(sym);
            if (mark) markBySymbol.set(sym, mark);
        }
        let totalUnrealizedPnl = 0;
        let totalExposure = 0;
        let totalMarginUsed = 0;
        const positionsWithPnl = [];

        for (const pos of positions) {
            const markPrice = markBySymbol.get(pos.symbol) ?? pos.entryPrice;
            const unrealizedPnl = pos.side === 'LONG'
                ? (markPrice - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - markPrice) * pos.quantity;

            totalUnrealizedPnl += unrealizedPnl;
            totalExposure += pos.notional;
            totalMarginUsed += pos.margin;

            positionsWithPnl.push({
                ...pos, markPrice, unrealizedPnl,
                pnlPercent: pos.margin > 0 ? (unrealizedPnl / pos.margin) * 100 : 0,
            });
        }

        const equityRaw = account.currentBalance + totalUnrealizedPnl;
        const equity = Math.max(0, equityRaw);
        const maintenanceMargin = totalExposure * (account.maintenanceRate || 0.005);
        const marginRatio = equityRaw > 0 ? maintenanceMargin / equityRaw : 999;
        const liqByPosition = this.liquidation.calculateDynamicLiquidationPrices(
            account,
            positionsWithPnl,
            markBySymbol,
            liquidationThreshold
        );
        const positionsWithRisk = positionsWithPnl.map(pos => ({
            ...pos,
            liquidationPrice: liqByPosition[pos.id] ?? pos.liquidationPrice,
        }));
        const accountLiqPrice = this.liquidation.calculateAccountLiqPrice(
            account,
            positionsWithRisk,
            exchange,
            liquidationThreshold,
            markBySymbol
        );

        return {
            account: sanitize(account),
            positions: positionsWithRisk,
            summary: {
                equity, balance: account.currentBalance,
                unrealizedPnl: totalUnrealizedPnl,
                marginUsed: totalMarginUsed,
                availableMargin: equity - totalMarginUsed,
                totalExposure, maintenanceMargin, marginRatio,
                accountLiqPrice,
                positionCount: positions.length,
                liquidationMode: account.liquidationMode,
            },
            rules,
        };
    }

    async getMarginInfo(subAccountId) {
        const summary = await this.getAccountSummary(subAccountId);
        if (!summary) return null;

        const rules = summary.rules || await this.getRules(subAccountId);

        return {
            account: {
                id: summary.account.id,
                name: summary.account.name,
                status: summary.account.status,
                liquidationMode: summary.account.liquidationMode,
            },
            ...summary.summary,
            rules: {
                maxNotionalPerTrade: rules.maxNotionalPerTrade,
                maxLeverage: rules.maxLeverage,
                maxTotalExposure: rules.maxTotalExposure,
            },
        };
    }

    // ── Private helpers (kept on facade for backward compat) ──

    /** @deprecated Use priceService.getFreshPrice() directly. */
    async _getFreshPrice(symbol) {
        return this.priceService.getFreshPrice(symbol);
    }

    /** @deprecated Use priceService.calcPositionsUpnl() directly. */
    async _calcPositionsUpnl(positions) {
        return this.priceService.calcPositionsUpnl(positions);
    }
}

const riskEngine = new RiskEngine();
export default riskEngine;
export { prisma, parseExchangeError, ERR };

/** Convenience — lets external modules mark positions as dirty without importing riskEngine. */
export function markPositionsDirty() {
    riskEngine.markPositionsDirty();
}

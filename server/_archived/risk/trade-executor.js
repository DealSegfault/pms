/**
 * TradeExecutor — Trade execution and position management.
 *
 * Handles all DB mutations and exchange orders for trades.
 * Validation is delegated to TradeValidator.
 * Pure calculations are delegated to risk-math.
 *
 * Dependencies (injected):
 *   - exchange: exchange module
 *   - book: PositionBook
 *   - priceService: PriceService
 *   - liquidationEngine: LiquidationEngine (for liq price calc + post-trade eval)
 *   - prisma: shared PrismaClient instance
 */
import prisma from '../db/prisma.js';
import { ERR, parseExchangeError } from './errors.js';
import { computePnl, createTradeSignature, createOpenTradeSignature } from './risk-math.js';
import { TradeValidator } from './trade-validator.js';
import { setRiskSnapshot } from '../redis.js';
import { markSymbolClosed } from '../recent-close.js';



export class TradeExecutor {
    /**
     * @param {Object} exchange
     * @param {import('./position-book.js').PositionBook} book
     * @param {import('./price-service.js').PriceService} priceService
     * @param {import('./liquidation.js').LiquidationEngine} liquidationEngine
     */
    constructor(exchange, book, priceService, liquidationEngine) {
        this._exchange = exchange;
        this._book = book;
        this._priceService = priceService;
        this._liquidation = liquidationEngine;
        this._wsEmitter = null;
        this._liqRefreshInFlight = new Set();

        // Compose the validator with shared dependencies
        this._validator = new TradeValidator({
            prisma,
            exchange,
            priceService,
            liquidation: liquidationEngine,
        });
    }

    setWsEmitter(emitter) {
        this._wsEmitter = emitter;
    }

    _emitMarketFillEvent({ subAccountId, symbol, side, price, quantity, exchangeOrderId, type = 'MARKET', options = {} }) {
        if (!this._wsEmitter || options?.silentFillBroadcast) return;

        this._wsEmitter('order_filled', {
            subAccountId,
            symbol,
            side,
            price,
            quantity,
            exchangeOrderId,
            orderType: type,
            origin: options?.origin || 'MANUAL',
            suppressToast: options?.origin === 'MANUAL',
        });
    }



    /**
     * Write a fresh Redis risk snapshot using in-memory book data (fast, no REST/DB).
     * Awaited after trade mutations so the next /positions fetch gets fresh data.
     * Liquidation checks run separately via _riskSweep (2s) and _onPriceTick.
     */
    async _syncSnapshot(subAccountId) {
        const _t0 = Date.now();
        try {
            const entry = this._book.getEntry(subAccountId);
            if (!entry) return;

            const { account, positions } = entry;
            const positionList = [...positions.values()];
            let totalUpnl = 0, totalNotional = 0, totalMarginUsed = 0;
            const posSnap = [];

            for (const pos of positionList) {
                const mark = this._priceService.getPrice(pos.symbol) || pos.entryPrice;
                const upnl = pos.side === 'LONG'
                    ? (mark - pos.entryPrice) * pos.quantity
                    : (pos.entryPrice - mark) * pos.quantity;
                totalUpnl += upnl;
                totalNotional += pos.notional;
                totalMarginUsed += pos.margin;
                posSnap.push({
                    id: pos.id, symbol: pos.symbol, side: pos.side,
                    entryPrice: pos.entryPrice, markPrice: mark,
                    quantity: pos.quantity, notional: pos.notional,
                    leverage: pos.leverage, margin: pos.margin,
                    liquidationPrice: pos.liquidationPrice || 0,
                    unrealizedPnl: upnl,
                    pnlPercent: pos.margin > 0 ? (upnl / pos.margin) * 100 : 0,
                    openedAt: pos.openedAt || null,
                });
            }

            const equityRaw = account.currentBalance + totalUpnl;
            const maintenanceMargin = totalNotional * (account.maintenanceRate || 0.005);
            const snapshot = {
                subAccountId, timestamp: Date.now(),
                equity: Math.max(0, equityRaw), equityRaw,
                balance: account.currentBalance,
                unrealizedPnl: totalUpnl, marginUsed: totalMarginUsed,
                availableMargin: Math.max(0, equityRaw) - totalMarginUsed,
                totalExposure: totalNotional, maintenanceMargin,
                marginRatio: equityRaw > 0 ? maintenanceMargin / equityRaw : 999,
                positionCount: positionList.length,
                positions: posSnap,
            };

            await setRiskSnapshot(subAccountId, snapshot);
            console.log(`[Perf] _syncSnapshot ${Date.now() - _t0}ms`);
        } catch (err) {
            console.warn(`[Risk] Post-trade snapshot sync failed:`, err.message);
        }
    }

    _scheduleDynamicLiqRefresh(subAccountId, account, liqThreshold, source) {
        if (!subAccountId || !account) return;
        if (this._liqRefreshInFlight.has(subAccountId)) return;

        this._liqRefreshInFlight.add(subAccountId);
        Promise.resolve()
            .then(() => this._refreshDynamicLiqPrices(subAccountId, account, liqThreshold))
            .catch((err) => {
                console.warn(`[Risk] Post-trade liq recompute failed (${source}):`, err.message);
            })
            .finally(() => {
                this._liqRefreshInFlight.delete(subAccountId);
            });
    }

    async _applyBalanceDelta(tx, subAccountId, delta, reason, tradeId = null) {
        const freshAccount = await tx.subAccount.findUnique({ where: { id: subAccountId } });
        if (!freshAccount) {
            throw new Error(`Sub-account not found: ${subAccountId}`);
        }

        const balanceBefore = freshAccount.currentBalance;
        const balanceAfter = Math.max(0, balanceBefore + delta);

        await tx.subAccount.update({
            where: { id: subAccountId },
            data: { currentBalance: balanceAfter },
        });

        const balanceLogData = {
            subAccountId,
            balanceBefore,
            balanceAfter,
            changeAmount: delta,
            reason,
        };
        if (tradeId) {
            balanceLogData.tradeId = tradeId;
        }
        await tx.balanceLog.create({ data: balanceLogData });

        return { balanceBefore, balanceAfter };
    }

    async _refreshDynamicLiqPrices(subAccountId, account, liqThreshold) {
        if (!account) return;

        const allPositions = await prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });
        if (allPositions.length === 0) return;

        const markPrices = new Map();
        for (const position of allPositions) {
            markPrices.set(position.symbol, this._priceService.getPrice(position.symbol) || position.entryPrice);
        }

        const dynamicLiqs = this._liquidation.calculateDynamicLiquidationPrices(
            account,
            allPositions,
            markPrices,
            liqThreshold,
        );

        const updates = [];
        for (const position of allPositions) {
            const dynLiq = dynamicLiqs[position.id];
            if (dynLiq != null && Math.abs(dynLiq - position.liquidationPrice) > 0.01) {
                updates.push(prisma.virtualPosition.update({
                    where: { id: position.id },
                    data: { liquidationPrice: dynLiq },
                }));
            }
        }

        if (updates.length > 0) {
            await prisma.$transaction(updates);

            // Emit position_updated for each changed liq price
            if (this._wsEmitter) {
                for (const position of allPositions) {
                    const dynLiq = dynamicLiqs[position.id];
                    if (dynLiq != null && Math.abs(dynLiq - position.liquidationPrice) > 0.01) {
                        this._wsEmitter('position_updated', {
                            subAccountId,
                            positionId: position.id,
                            symbol: position.symbol,
                            side: position.side,
                            entryPrice: position.entryPrice,
                            quantity: position.quantity,
                            notional: position.notional,
                            leverage: position.leverage,
                            margin: position.margin,
                            liquidationPrice: dynLiq,
                        });
                    }
                }
            }
        }
    }

    // ── Validation (delegated to TradeValidator) ─────

    async validateTrade(subAccountId, symbol, side, quantity, leverage) {
        return this._validator.validate(subAccountId, symbol, side, quantity, leverage);
    }

    // ── Execute Trade ────────────────────────────────

    async executeTrade(subAccountId, symbol, side, quantity, leverage, type = 'MARKET', options = {}) {
        const _t0 = Date.now();
        let _tValidate = 0, _tAccount = 0;

        if (!options?.skipValidation) {
            const validation = await this.validateTrade(subAccountId, symbol, side, quantity, leverage);
            _tValidate = Date.now() - _t0;
            if (!validation.valid) {
                return { success: false, errors: validation.errors };
            }
        }

        const _tAccStart = Date.now();
        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        _tAccount = Date.now() - _tAccStart;
        if (!account) {
            return { success: false, errors: [ERR.ACCOUNT_NOT_FOUND()] };
        }

        try {
            await this._exchange.setLeverage(symbol, leverage);

            // --- Check for opposite-side position to auto-close (position flip) ---
            const oppositeSide = side === 'LONG' ? 'SHORT' : 'LONG';
            const oppositePos = await prisma.virtualPosition.findFirst({
                where: { subAccountId, symbol, side: oppositeSide, status: 'OPEN' },
            });

            if (oppositePos) {
                const result = await this._executeFlip(subAccountId, symbol, side, quantity, leverage, type, account, oppositePos, options);
                console.log(`[Perf] FLIP ${symbol} | validate:${_tValidate}ms account:${_tAccount}ms total:${Date.now() - _t0}ms`);
                return result;
            }

            // --- Normal flow (no opposite position) ---
            const result = await this._executeNormal(subAccountId, symbol, side, quantity, leverage, type, account, options);
            console.log(`[Perf] ${side} ${symbol} | validate:${_tValidate}ms account:${_tAccount}ms total:${Date.now() - _t0}ms`);
            return result;

        } catch (err) {
            console.error(`[Risk] Trade execution failed:`, err.message);
            return { success: false, errors: [parseExchangeError(err)] };
        }
    }

    // ── Close Position ───────────────────────────────

    /**
     * Check whether a real exchange position exists for the given virtual position.
     * Returns { exists, sideMatch, exchangePos }.
     * Fails safe: if fetchPositions() throws, treats it as "no exchange position"
     * so we never send a bad order when the exchange state is unknown.
     */
    async _checkExchangePosition(position) {
        try {
            const exchangePositions = await this._exchange.fetchPositions();
            const exchangePos = exchangePositions.find((p) => p.symbol === position.symbol);
            if (!exchangePos) return { exists: false, sideMatch: false, exchangePos: null };
            // CCXT side field is 'long' or 'short'
            const exSide = (exchangePos.side || '').toLowerCase();
            const virtualSide = position.side.toLowerCase(); // 'long' or 'short'
            return {
                exists: true,
                sideMatch: exSide === virtualSide,
                exchangePos,
            };
        } catch (err) {
            console.error(`[Risk] Exchange sync check failed for ${position.symbol}:`, err.message);
            // Fail-safe: assume no exchange position → skip real order
            return { exists: false, sideMatch: false, exchangePos: null };
        }
    }

    async closePosition(positionId, action = 'CLOSE') {
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
        });
        if (!position) return { success: false, errors: [ERR.POSITION_NOT_FOUND()] };
        if (position.status !== 'OPEN') return { success: false, errors: [ERR.POSITION_CLOSED()] };

        // ── Exchange sync guard ──────────────────────────────────────────────
        // Verify a real exchange position exists with the same side before sending
        // any market order. If desynced (e.g. exchange: $1 SHORT, virtual: $3 LONG)
        // a naive close would send a wrong-direction order to Binance.
        const syncCheck = await this._checkExchangePosition(position);
        if (!syncCheck.exists) {
            console.warn(
                `[Risk] closePosition: no exchange position found for ${position.symbol} ` +
                `— skipping real order, doing virtual-only close (action=${action})`
            );
            const fallbackPrice = this._exchange.getLatestPrice(position.symbol) || position.entryPrice;
            const result = await this._closeVirtualOnlyByPrice(positionId, fallbackPrice, 'DESYNC_CLOSE');
            return result?.success
                ? { ...result, source: 'virtual_only', reason: 'no_exchange_position' }
                : { success: false, errors: [{ code: 'DESYNC_CLOSE_FAILED', message: 'Virtual-only close failed after desync detection' }] };
        }
        if (!syncCheck.sideMatch) {
            console.warn(
                `[Risk] closePosition: side mismatch for ${position.symbol} ` +
                `(exchange: ${syncCheck.exchangePos?.side}, virtual: ${position.side}) ` +
                `— skipping real order, doing virtual-only close (action=${action})`
            );
            const fallbackPrice = this._exchange.getLatestPrice(position.symbol) || position.entryPrice;
            const result = await this._closeVirtualOnlyByPrice(positionId, fallbackPrice, 'DESYNC_CLOSE');
            return result?.success
                ? { ...result, source: 'virtual_only', reason: 'side_mismatch' }
                : { success: false, errors: [{ code: 'DESYNC_CLOSE_FAILED', message: 'Virtual-only close failed after side-mismatch detection' }] };
        }
        // ────────────────────────────────────────────────────────────────────

        try {
            // Pre-emptively block reconcile before exchange order triggers ACCOUNT_UPDATE
            markSymbolClosed(position.symbol);

            const closeSide = position.side === 'LONG' ? 'sell' : 'buy';
            const exchangeResult = await this._exchange.createMarketOrder(position.symbol, closeSide, position.quantity, { reduceOnly: true });

            const closePrice = exchangeResult.price;
            if (!closePrice) {
                console.error(`[Risk] Exchange returned no fill price for ${position.symbol} close — aborting`);
                return { success: false, errors: [{ code: 'NO_FILL_PRICE', message: 'Exchange did not return fill price' }] };
            }
            let realizedPnl = computePnl(position.side, position.entryPrice, closePrice, position.quantity);
            realizedPnl -= (exchangeResult.fee || 0);

            const signature = createTradeSignature(position.subAccountId, 'CLOSE', positionId);

            const result = await prisma.$transaction(async (tx) => {
                const updatedPosition = await tx.virtualPosition.update({
                    where: { id: positionId },
                    data: {
                        status: action === 'LIQUIDATE' ? 'LIQUIDATED' : 'CLOSED',
                        realizedPnl,
                        closedAt: new Date(),
                    },
                });

                const trade = await tx.tradeExecution.create({
                    data: {
                        subAccountId: position.subAccountId,
                        positionId,
                        exchangeOrderId: exchangeResult.orderId,
                        symbol: position.symbol,
                        side: closeSide.toUpperCase(),
                        type: 'MARKET',
                        price: closePrice,
                        quantity: position.quantity,
                        notional: closePrice * position.quantity,
                        fee: exchangeResult.fee || 0,
                        realizedPnl,
                        action,
                        status: 'FILLED',
                        signature,
                    },
                });

                const { balanceAfter } = await this._applyBalanceDelta(
                    tx,
                    position.subAccountId,
                    realizedPnl,
                    action === 'LIQUIDATE' ? 'LIQUIDATION' : 'TRADE_PNL',
                    trade.id,
                );

                return { position: updatedPosition, trade, newBalance: balanceAfter };
            });

            // Sync in-memory position book
            this._book.remove(positionId, position.subAccountId);
            this._book.updateBalance(position.subAccountId, result.newBalance);

            // Write fresh snapshot so next /positions fetch gets up-to-date data
            await this._syncSnapshot(position.subAccountId);

            if (this._wsEmitter) {
                this._wsEmitter('position_closed', {
                    subAccountId: position.subAccountId,
                    positionId, symbol: position.symbol,
                    side: position.side, realizedPnl,
                    newBalance: result.newBalance, reason: action,
                });
            }



            console.log(`[Risk] Position closed: ${position.side} ${position.symbol} | PnL: $${realizedPnl.toFixed(4)} | New Balance: $${result.newBalance.toFixed(2)}`);
            return { success: true, ...result };

        } catch (err) {
            const errorMsg = err.message || '';
            console.error(`[Risk] Close position failed for ${positionId}:`, errorMsg);

            // If the exchange rejects the close because the position is already gone (or too small/invalid),
            // we should clean up the ghost virtual position instead of leaving it stuck.
            const isGhostError = errorMsg.includes('Invalid quantity') ||
                errorMsg.includes('Position') ||
                errorMsg.includes('-2022') ||
                errorMsg.includes('Unknown') ||
                errorMsg.includes('insufficient') ||
                errorMsg.includes('reduceOnly');

            if (isGhostError) {
                console.warn(`[Risk] Exchange rejected close (ghost position) — falling back to virtual-only close for ${positionId}`);
                const fallbackPrice = this._exchange.getLatestPrice(position.symbol) || position.entryPrice;
                const fallbackResult = await this._closeVirtualOnlyByPrice(positionId, fallbackPrice, action);
                if (fallbackResult?.success) {
                    return { ...fallbackResult, source: 'virtual_fallback', exchangeError: errorMsg };
                }
            }

            return { success: false, errors: [parseExchangeError(err)] };
        }
    }

    // ── Liquidate Position (resilient — falls back to virtual close) ──

    /**
     * Close a position as part of liquidation. Uses cached mark price.
     * Tries exchange order but falls back to virtual-only close if exchange fails.
     * Always reads fresh balance from DB inside the transaction.
     */
    async liquidatePosition(positionId) {
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
        });
        if (!position) return { success: false, error: 'Position not found' };
        if (position.status !== 'OPEN') return { success: false, error: 'Position already closed' };

        // Use cached mark price (already updated from WS ticks)
        const markPrice = this._priceService.getPrice(position.symbol)
            || this._exchange.getLatestPrice(position.symbol)
            || position.entryPrice;

        // Try exchange order, but don't fail the liquidation if it errors
        let exchangeOrderId = null;
        let closePrice = markPrice;
        let fee = 0;
        try {
            const closeSide = position.side === 'LONG' ? 'sell' : 'buy';
            markSymbolClosed(position.symbol);
            const exchangeResult = await this._exchange.createMarketOrder(position.symbol, closeSide, position.quantity, { reduceOnly: true });
            exchangeOrderId = exchangeResult.orderId;
            if (exchangeResult.price) {
                closePrice = exchangeResult.price;
            } else {
                console.warn(`[Risk] Liquidation exchange order for ${position.symbol} returned no fill price, using mark ${markPrice.toFixed(6)}`);
            }
            fee = exchangeResult.fee || 0;
        } catch (exchangeErr) {
            console.warn(`[Risk] Exchange order failed during liquidation of ${position.symbol}, using virtual close @ ${markPrice.toFixed(6)}: ${exchangeErr.message}`);
            // Continue with virtual-only close at mark price
        }

        let realizedPnl = computePnl(position.side, position.entryPrice, closePrice, position.quantity);
        realizedPnl -= fee;

        const signature = createTradeSignature(position.subAccountId, 'LIQUIDATE', positionId);

        const result = await prisma.$transaction(async (tx) => {
            const updatedPosition = await tx.virtualPosition.update({
                where: { id: positionId },
                data: {
                    status: 'LIQUIDATED',
                    realizedPnl,
                    closedAt: new Date(),
                },
            });

            const trade = await tx.tradeExecution.create({
                data: {
                    subAccountId: position.subAccountId,
                    positionId,
                    exchangeOrderId,
                    symbol: position.symbol,
                    side: position.side === 'LONG' ? 'SELL' : 'BUY',
                    type: 'MARKET',
                    price: closePrice,
                    quantity: position.quantity,
                    notional: closePrice * position.quantity,
                    fee,
                    realizedPnl,
                    action: 'LIQUIDATE',
                    status: 'FILLED',
                    signature,
                },
            });

            const { balanceAfter } = await this._applyBalanceDelta(
                tx,
                position.subAccountId,
                realizedPnl,
                'LIQUIDATION',
                trade.id,
            );

            return { position: updatedPosition, trade, newBalance: balanceAfter };
        });

        // Sync in-memory book
        this._book.remove(positionId, position.subAccountId);
        this._book.updateBalance(position.subAccountId, result.newBalance);

        // Write fresh snapshot so next /positions fetch gets up-to-date data
        await this._syncSnapshot(position.subAccountId);

        if (this._wsEmitter) {
            this._wsEmitter('position_closed', {
                subAccountId: position.subAccountId,
                positionId, symbol: position.symbol,
                side: position.side, realizedPnl,
                newBalance: result.newBalance, reason: 'LIQUIDATE',
            });
        }



        console.log(`[Risk] Position LIQUIDATED: ${position.side} ${position.symbol} @ ${closePrice.toFixed(6)} | PnL: $${realizedPnl.toFixed(4)} | Balance: $${result.newBalance.toFixed(2)}`);
        return { success: true, ...result };
    }

    // ── Partial Close (ADL) ──────────────────────────

    async partialClose(positionId, fraction, action = 'PARTIAL_LIQUIDATION') {
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
        });
        if (!position || position.status !== 'OPEN') return { success: false };

        const closeQty = +(position.quantity * fraction).toFixed(8);
        if (closeQty <= 0) return { success: false };

        try {
            const closeSide = position.side === 'LONG' ? 'sell' : 'buy';
            markSymbolClosed(position.symbol);
            const exchangeResult = await this._exchange.createMarketOrder(position.symbol, closeSide, closeQty, { reduceOnly: true });

            const closePrice = exchangeResult.price;
            if (!closePrice) {
                console.error(`[Risk] Exchange returned no fill price for ${position.symbol} partial close — aborting`);
                return { success: false, errors: [{ code: 'NO_FILL_PRICE', message: 'Exchange did not return fill price' }] };
            }
            let realizedPnl = computePnl(position.side, position.entryPrice, closePrice, closeQty);
            realizedPnl -= (exchangeResult.fee || 0);

            const remainingQty = +(position.quantity - closeQty).toFixed(8);
            const remainingNotional = remainingQty * position.entryPrice;
            const remainingMargin = remainingNotional / position.leverage;

            const signature = createTradeSignature(position.subAccountId, 'ADL', positionId);

            const result = await prisma.$transaction(async (tx) => {
                const updatedPosition = await tx.virtualPosition.update({
                    where: { id: positionId },
                    data: {
                        quantity: remainingQty,
                        notional: remainingNotional,
                        margin: remainingMargin,
                        status: remainingQty <= 0 ? 'LIQUIDATED' : 'OPEN',
                    },
                });

                const trade = await tx.tradeExecution.create({
                    data: {
                        subAccountId: position.subAccountId,
                        positionId,
                        exchangeOrderId: exchangeResult.orderId,
                        symbol: position.symbol,
                        side: closeSide.toUpperCase(),
                        type: 'MARKET',
                        price: closePrice,
                        quantity: closeQty,
                        notional: closePrice * closeQty,
                        fee: exchangeResult.fee || 0,
                        realizedPnl,
                        action,
                        status: 'FILLED',
                        signature,
                    },
                });

                const { balanceAfter } = await this._applyBalanceDelta(
                    tx,
                    position.subAccountId,
                    realizedPnl,
                    action,
                    trade.id,
                );

                return { position: updatedPosition, trade, newBalance: balanceAfter };
            });

            // Sync in-memory position book
            if (remainingQty <= 0) {
                this._book.remove(positionId, position.subAccountId);
            } else {
                this._book.updatePosition(positionId, position.subAccountId, {
                    quantity: remainingQty,
                    notional: remainingNotional,
                    margin: remainingMargin,
                });
            }
            this._book.updateBalance(position.subAccountId, result.newBalance);

            // Write fresh snapshot so next /positions fetch gets up-to-date data
            await this._syncSnapshot(position.subAccountId);

            if (this._wsEmitter) {
                this._wsEmitter('position_reduced', {
                    subAccountId: position.subAccountId,
                    positionId, symbol: position.symbol,
                    side: position.side, remainingQty,
                    closedQty: closeQty, realizedPnl,
                    newBalance: result.newBalance, reason: action,
                });
            }



            console.log(`[Risk] ADL ${(fraction * 100).toFixed(0)}%: ${position.symbol} | Closed ${closeQty} | PnL: $${realizedPnl.toFixed(4)} | Remaining: ${remainingQty}`);
            return { success: true, ...result };

        } catch (err) {
            console.error(`[Risk] Partial close failed:`, err.message);
            return { success: false, errors: [parseExchangeError(err)] };
        }
    }

    // ── Admin Takeover ───────────────────────────────

    async takeoverPosition(positionId, adminUserId) {
        const position = await prisma.virtualPosition.findUnique({
            where: { id: positionId },
        });
        if (!position || position.status !== 'OPEN') {
            return { success: false, errors: [ERR.POSITION_NOT_FOUND()] };
        }

        const markPrice = this._exchange.getLatestPrice(position.symbol) || position.entryPrice;
        let unrealizedPnl = computePnl(position.side, position.entryPrice, markPrice, position.quantity);

        const result = await prisma.$transaction(async (tx) => {
            const updatedPosition = await tx.virtualPosition.update({
                where: { id: positionId },
                data: {
                    status: 'TAKEN_OVER',
                    takenOver: true,
                    takenOverBy: adminUserId,
                    takenOverAt: new Date(),
                    realizedPnl: unrealizedPnl,
                    closedAt: new Date(),
                },
            });

            const { balanceAfter } = await this._applyBalanceDelta(
                tx,
                position.subAccountId,
                unrealizedPnl,
                'ADMIN_TAKEOVER',
            );

            return { position: updatedPosition, newBalance: balanceAfter };
        });

        this._book.remove(positionId, position.subAccountId);
        this._book.updateBalance(position.subAccountId, result.newBalance);

        console.log(`[Risk] Admin takeover: ${position.symbol} (${position.side}) by ${adminUserId} | uPnL: $${unrealizedPnl.toFixed(4)}`);

        if (this._wsEmitter) {
            this._wsEmitter('position_takeover', {
                subAccountId: position.subAccountId,
                positionId, symbol: position.symbol,
                side: position.side, adminUserId,
            });
        }



        return { success: true, ...result };
    }

    // ── Exchange Position Sync ────────────────────────

    async reconcilePosition(symbol, closePrice) {
        const positions = await prisma.virtualPosition.findMany({
            where: { symbol, status: 'OPEN' },
            include: { subAccount: { select: { name: true } } },
        });

        if (positions.length === 0) {
            console.log(`[Sync] No open virtual positions for ${symbol}`);
            return { closed: 0 };
        }

        let closedCount = 0;
        const touchedSubAccounts = new Set();
        for (const position of positions) {
            touchedSubAccounts.add(position.subAccountId);
            let realizedPnl = computePnl(position.side, position.entryPrice, closePrice, position.quantity);

            const signature = createTradeSignature(position.subAccountId, 'RECONCILE', position.id);

            const result = await prisma.$transaction(async (tx) => {
                // Re-read inside transaction to guard against race with closePosition
                const fresh = await tx.virtualPosition.findUnique({ where: { id: position.id } });
                if (!fresh || fresh.status !== 'OPEN') return null;

                const updatedPosition = await tx.virtualPosition.update({
                    where: { id: position.id },
                    data: {
                        status: 'CLOSED',
                        realizedPnl,
                        closedAt: new Date(),
                    },
                });

                const trade = await tx.tradeExecution.create({
                    data: {
                        subAccountId: position.subAccountId,
                        positionId: position.id,
                        symbol,
                        side: position.side === 'LONG' ? 'SELL' : 'BUY',
                        type: 'MARKET',
                        price: closePrice,
                        quantity: position.quantity,
                        notional: closePrice * position.quantity,
                        fee: 0,
                        realizedPnl,
                        action: 'RECONCILE',
                        status: 'FILLED',
                        signature,
                    },
                });

                const { balanceAfter } = await this._applyBalanceDelta(
                    tx,
                    position.subAccountId,
                    realizedPnl,
                    'RECONCILE',
                    trade.id,
                );

                return { position: updatedPosition, trade, newBalance: balanceAfter };
            });

            // Skip if position was already closed by another path (race guard)
            if (!result) {
                console.log(`[Sync] Skipped ${position.side} ${symbol} — already closed by another path`);
                continue;
            }

            // Sync in-memory book
            this._book.remove(position.id, position.subAccountId);
            this._book.updateBalance(position.subAccountId, result.newBalance);

            // Write fresh snapshot so next /positions fetch gets up-to-date data
            await this._syncSnapshot(position.subAccountId);

            console.log(`[Sync] Closed ${position.side} ${symbol} (${position.subAccount.name}) | PnL: $${realizedPnl.toFixed(4)} | Balance: $${result.newBalance.toFixed(2)} → book synced`);

            if (this._wsEmitter) {
                this._wsEmitter('position_closed', {
                    subAccountId: position.subAccountId,
                    positionId: position.id, symbol,
                    side: position.side, realizedPnl,
                    newBalance: result.newBalance, reason: 'RECONCILE',
                });
            }

            closedCount++;
        }

        for (const subAccountId of touchedSubAccounts) {

        }

        return { closed: closedCount };
    }



    // ── Private: Trade Execution Flows ───────────────

    async _executeFlip(subAccountId, symbol, side, quantity, leverage, type, account, oppositePos, options = {}) {
        const oppositeSide = side === 'LONG' ? 'SHORT' : 'LONG';
        const totalExchangeQty = oppositePos.quantity + quantity;
        const orderSide = side === 'LONG' ? 'buy' : 'sell';
        const fastExecution = options?.fastExecution === true;
        const fallbackPriceRaw = Number(options?.fallbackPrice);
        const fallbackPrice = Number.isFinite(fallbackPriceRaw) && fallbackPriceRaw > 0 ? fallbackPriceRaw : null;
        const exchangeParams = fastExecution
            ? { __fastAck: true, ...(fallbackPrice ? { __fallbackPrice: fallbackPrice } : {}) }
            : {};
        markSymbolClosed(symbol);
        const exchangeResult = await this._exchange.createMarketOrder(symbol, orderSide, totalExchangeQty, exchangeParams);

        const fillPrice = exchangeResult.price;
        if (!fillPrice) {
            console.error(`[Risk] Exchange returned no fill price for ${symbol} flip — aborting`);
            return { success: false, errors: [{ code: 'NO_FILL_PRICE', message: 'Exchange did not return fill price' }] };
        }

        let closePnl = computePnl(oppositeSide, oppositePos.entryPrice, fillPrice, oppositePos.quantity);
        closePnl -= (exchangeResult.fee || 0);

        const fillNotional = fillPrice * quantity;
        const fillMargin = fillNotional / leverage;

        // Fetch admin threshold for accurate liq price
        const rules = await this._liquidation.getRules(subAccountId);
        const liqThreshold = (rules?.liquidationThreshold > 0 && rules?.liquidationThreshold <= 1)
            ? rules.liquidationThreshold : 0.90;

        const closeSig = createTradeSignature(subAccountId, 'FLIP_CLOSE', oppositePos.id);
        const openSig = createOpenTradeSignature(subAccountId, symbol, side, quantity);

        const result = await prisma.$transaction(async (tx) => {
            const closedPos = await tx.virtualPosition.update({
                where: { id: oppositePos.id },
                data: { status: 'CLOSED', realizedPnl: closePnl, closedAt: new Date() },
            });

            const closeTradeAction = oppositeSide === 'LONG' ? 'SELL' : 'BUY';
            const closeTrade = await tx.tradeExecution.create({
                data: {
                    subAccountId,
                    positionId: oppositePos.id,
                    exchangeOrderId: exchangeResult.orderId,
                    symbol, side: closeTradeAction, type: 'MARKET',
                    price: fillPrice,
                    quantity: oppositePos.quantity,
                    notional: fillPrice * oppositePos.quantity,
                    fee: exchangeResult.fee || 0,
                    realizedPnl: closePnl,
                    action: 'CLOSE',
                    status: 'FILLED',
                    signature: closeSig,
                },
            });

            const { balanceAfter } = await this._applyBalanceDelta(
                tx,
                subAccountId,
                closePnl,
                'TRADE_PNL',
                closeTrade.id,
            );

            const liqPrice = this._liquidation.calculateLiquidationPrice(
                side,
                fillPrice,
                leverage,
                balanceAfter,
                fillNotional,
                account.maintenanceRate || 0.005,
                liqThreshold,
            );

            const position = await tx.virtualPosition.create({
                data: {
                    subAccountId, symbol, side,
                    entryPrice: fillPrice,
                    quantity,
                    notional: fillNotional,
                    leverage,
                    margin: fillMargin,
                    liquidationPrice: liqPrice,
                    status: 'OPEN',
                },
            });

            const openTrade = await tx.tradeExecution.create({
                data: {
                    subAccountId,
                    positionId: position.id,
                    exchangeOrderId: exchangeResult.orderId,
                    symbol, side: orderSide.toUpperCase(), type,
                    price: fillPrice,
                    quantity,
                    notional: fillNotional,
                    fee: 0,
                    action: 'OPEN',
                    status: 'FILLED',
                    signature: openSig,
                },
            });

            return { position, trade: openTrade, closedPos, closeTrade, newBalance: balanceAfter, closePnl };
        });

        // Sync in-memory book
        this._book.remove(oppositePos.id, subAccountId);
        this._book.updateBalance(subAccountId, result.newBalance);

        // Write fresh snapshot so next /positions fetch gets up-to-date data
        await this._syncSnapshot(subAccountId);

        if (this._wsEmitter) {
            this._wsEmitter('position_closed', {
                subAccountId,
                positionId: oppositePos.id, symbol,
                side: oppositeSide, realizedPnl: result.closePnl,
                newBalance: result.newBalance, reason: 'FLIP',
            });
        }

        this._exchange.subscribeToPrices([symbol]);

        const accountForBook = { ...account, currentBalance: result.newBalance };
        this._book.add(result.position, accountForBook);

        if (!this._priceService.hasPrice(symbol)) {
            this._priceService.setPrice(symbol, fillPrice);
        }

        // Recompute dynamic liq prices for all open positions out-of-band.
        this._scheduleDynamicLiqRefresh(subAccountId, accountForBook, liqThreshold, 'flip');

        // Emit position_updated for the new flipped position
        if (this._wsEmitter) {
            this._wsEmitter('position_updated', {
                subAccountId,
                positionId: result.position.id,
                symbol: result.position.symbol,
                side: result.position.side,
                entryPrice: result.position.entryPrice,
                quantity: result.position.quantity,
                notional: result.position.notional,
                leverage: result.position.leverage,
                margin: result.position.margin,
                liquidationPrice: result.position.liquidationPrice,
            });
        }



        console.log(`[Risk] Position FLIPPED: closed ${oppositeSide} (PnL: $${result.closePnl.toFixed(4)}) → opened ${side} ${quantity} ${symbol} @ ${fillPrice} | Margin: $${fillMargin.toFixed(2)}`);

        this._emitMarketFillEvent({
            subAccountId,
            symbol,
            side,
            price: fillPrice,
            quantity,
            exchangeOrderId: exchangeResult.orderId,
            type,
            options,
        });

        return { success: true, position: result.position, trade: result.trade, flipped: { closedPosition: result.closedPos, closePnl: result.closePnl } };
    }

    async _executeNormal(subAccountId, symbol, side, quantity, leverage, type, account, options = {}) {
        const _t = { start: Date.now() };
        const orderSide = side === 'LONG' ? 'buy' : 'sell';

        let exchangeResult;

        if (options?.skipExchange && options?.fillPrice) {
            // Pre-filled order (e.g., TWAP limit fill already on exchange)
            exchangeResult = {
                orderId: options.exchangeOrderId || `prefill_${Date.now()}`,
                price: options.fillPrice,
                quantity: quantity,
                fee: options.fillFee || 0,
                status: 'closed',
            };
        } else {
            const fastExecution = options?.fastExecution === true;
            const fallbackPriceRaw = Number(options?.fallbackPrice);
            const fallbackPrice = Number.isFinite(fallbackPriceRaw) && fallbackPriceRaw > 0 ? fallbackPriceRaw : null;
            const exchangeParams = {
                ...(fastExecution ? { __fastAck: true } : {}),
                ...(fallbackPrice ? { __fallbackPrice: fallbackPrice } : {}),
                ...(options?.reduceOnly ? { reduceOnly: true } : {}),
            };
            exchangeResult = await this._exchange.createMarketOrder(symbol, orderSide, quantity, exchangeParams);
        }
        _t.exchange = Date.now();

        const fillPrice = exchangeResult.price;
        if (!fillPrice) {
            console.error(`[Risk] Exchange returned no fill price for ${symbol} — aborting trade`);
            return { success: false, errors: [{ code: 'NO_FILL_PRICE', message: 'Exchange did not return fill price' }] };
        }
        const fillQty = exchangeResult.quantity || quantity;
        if (exchangeResult.quantity && Math.abs(exchangeResult.quantity - quantity) > 1e-8) {
            console.warn(`[Risk] Partial fill: requested ${quantity}, filled ${exchangeResult.quantity} for ${symbol}`);
        }
        const fillNotional = fillPrice * fillQty;
        const fillMargin = fillNotional / leverage;

        // Fetch admin threshold for accurate liq price
        const rules = await this._liquidation.getRules(subAccountId);
        const liqThreshold = (rules?.liquidationThreshold > 0 && rules?.liquidationThreshold <= 1)
            ? rules.liquidationThreshold : 0.90;

        const liqPrice = this._liquidation.calculateLiquidationPrice(
            side, fillPrice, leverage, account.currentBalance,
            fillNotional, account.maintenanceRate || 0.005, liqThreshold
        );

        const signature = createOpenTradeSignature(subAccountId, symbol, side, quantity);

        const result = await prisma.$transaction(async (tx) => {
            const existing = await tx.virtualPosition.findFirst({
                where: { subAccountId, symbol, side, status: 'OPEN' },
            });

            let position;
            let tradeAction;

            if (existing) {
                const newQty = existing.quantity + fillQty;
                const newEntry = (existing.entryPrice * existing.quantity + fillPrice * fillQty) / newQty;
                const newNotional = newEntry * newQty;
                const newMargin = newNotional / leverage;
                const newLiqPrice = this._liquidation.calculateLiquidationPrice(
                    side, newEntry, leverage, account.currentBalance,
                    newNotional, account.maintenanceRate || 0.005, liqThreshold
                );

                position = await tx.virtualPosition.update({
                    where: { id: existing.id },
                    data: {
                        entryPrice: newEntry,
                        quantity: newQty,
                        notional: newNotional,
                        leverage,
                        margin: newMargin,
                        liquidationPrice: newLiqPrice,
                    },
                });
                tradeAction = 'ADD';
                position = await tx.virtualPosition.create({
                    data: {
                        subAccountId, symbol, side,
                        entryPrice: fillPrice,
                        quantity: fillQty,
                        notional: fillNotional,
                        leverage,
                        margin: fillMargin,
                        liquidationPrice: liqPrice,
                        status: 'OPEN',
                    },
                });
                tradeAction = 'OPEN';
            }

            const trade = await tx.tradeExecution.create({
                data: {
                    subAccountId,
                    positionId: position.id,
                    exchangeOrderId: exchangeResult.orderId,
                    symbol, side: orderSide.toUpperCase(), type,
                    price: fillPrice,
                    quantity: fillQty,
                    notional: fillNotional,
                    fee: exchangeResult.fee || 0,
                    action: tradeAction,
                    status: 'FILLED',
                    signature,
                },
            });

            return { position, trade };
        });
        _t.db = Date.now();

        this._exchange.subscribeToPrices([symbol]);

        this._book.add(result.position, account);
        // Write fresh snapshot so next /positions fetch gets up-to-date data
        await this._syncSnapshot(subAccountId);
        _t.snapshot = Date.now();

        if (!this._priceService.hasPrice(symbol)) {
            this._priceService.setPrice(symbol, fillPrice);
        }

        // Recompute dynamic liq prices for all open positions out-of-band.
        this._scheduleDynamicLiqRefresh(subAccountId, account, liqThreshold, 'normal');



        // Emit position_updated for real-time frontend push
        if (this._wsEmitter) {
            this._wsEmitter('position_updated', {
                subAccountId,
                positionId: result.position.id,
                symbol: result.position.symbol,
                side: result.position.side,
                entryPrice: result.position.entryPrice,
                quantity: result.position.quantity,
                notional: result.position.notional,
                leverage: result.position.leverage,
                margin: result.position.margin,
                liquidationPrice: result.position.liquidationPrice,
            });
        }

        console.log(`[Perf] _executeNormal ${symbol} | exchange:${_t.exchange - _t.start}ms db:${_t.db - _t.exchange}ms snapshot:${_t.snapshot - _t.db}ms total:${_t.snapshot - _t.start}ms`);

        console.log(`[Risk] Trade executed: ${side} ${quantity} ${symbol} @ ${fillPrice} | Liq: ${liqPrice.toFixed(4)} | Margin: $${fillMargin.toFixed(2)}`);

        this._emitMarketFillEvent({
            subAccountId,
            symbol,
            side,
            price: fillPrice,
            quantity: fillQty,
            exchangeOrderId: exchangeResult.orderId,
            type,
            options,
        });

        return { success: true, position: result.position, trade: result.trade };
    }
}

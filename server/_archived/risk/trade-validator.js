/**
 * TradeValidator — Pre-trade validation logic.
 *
 * Extracted from TradeExecutor.validateTrade() to reduce coupling and
 * improve testability. All dependencies are injected via constructor.
 *
 * This module queries the DB and exchange for current state, runs pure
 * margin/risk checks via risk-math, and returns a deterministic result.
 *
 * Part of Agent 05 risk engine restructure (SUB-0501).
 */
import { ERR } from './errors.js';
import { computePnl, computeAvailableMargin, computeMarginUsageRatio } from './risk-math.js';

export class TradeValidator {
    /**
     * @param {Object} deps
     * @param {import('@prisma/client').PrismaClient} deps.prisma
     * @param {Object} deps.exchange
     * @param {import('./price-service.js').PriceService} deps.priceService
     * @param {import('./liquidation.js').LiquidationEngine} deps.liquidation
     */
    constructor({ prisma, exchange, priceService, liquidation }) {
        this._prisma = prisma;
        this._exchange = exchange;
        this._priceService = priceService;
        this._liquidation = liquidation;
    }

    /**
     * Validate a trade before execution.
     *
     * @param {string} subAccountId
     * @param {string} symbol
     * @param {'LONG'|'SHORT'} side
     * @param {number} quantity
     * @param {number} leverage
     * @returns {Promise<{valid: boolean, errors: Array, computedValues?: Object}>}
     */
    async validate(subAccountId, symbol, side, quantity, leverage) {
        const errors = [];

        const account = await this._prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) return { valid: false, errors: [ERR.ACCOUNT_NOT_FOUND()] };
        if (account.status !== 'ACTIVE') return { valid: false, errors: [ERR.ACCOUNT_FROZEN(account.status)] };

        const rules = await this._liquidation.getRules(subAccountId);

        // Prefer in-memory WS price; fall back to REST only for the traded symbol
        let price = this._exchange.getLatestPrice(symbol) || this._priceService.getPrice(symbol);
        if (!price) {
            try {
                const ticker = await this._exchange.fetchTicker(symbol);
                price = ticker.mark || ticker.last;
            } catch { }
        }
        if (!price) return { valid: false, errors: [ERR.NO_PRICE()] };

        const notional = quantity * price;
        const requiredMargin = notional / leverage;

        // ── Rule checks ──
        if (leverage > rules.maxLeverage) {
            errors.push(ERR.MAX_LEVERAGE(leverage, rules.maxLeverage));
        }

        if (notional > rules.maxNotionalPerTrade) {
            errors.push(ERR.MAX_NOTIONAL(notional, rules.maxNotionalPerTrade));
        }

        // ── Position-aware checks ──
        const openPositions = await this._prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });

        const oppositeSide = side === 'LONG' ? 'SHORT' : 'LONG';
        const oppositePos = openPositions.find(p => p.symbol === symbol && p.side === oppositeSide);
        let oppositeNotional = 0;
        let oppositePnl = 0;
        if (oppositePos) {
            oppositeNotional = oppositePos.notional;
            oppositePnl = computePnl(oppositeSide, oppositePos.entryPrice, price, oppositePos.quantity);
        }

        // Exposure check
        const currentExposure = openPositions.reduce((sum, p) => sum + p.notional, 0) - oppositeNotional;
        if (currentExposure + notional > rules.maxTotalExposure) {
            errors.push(ERR.MAX_EXPOSURE(currentExposure + notional, rules.maxTotalExposure));
        }

        // Margin check
        // Use sync prices (always warm from WS) — no REST fallback during validation
        let totalUpnl = 0;
        for (const pos of openPositions) {
            const mark = this._exchange.getLatestPrice(pos.symbol) || this._priceService.getPrice(pos.symbol) || pos.entryPrice;
            totalUpnl += pos.side === 'LONG'
                ? (mark - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - mark) * pos.quantity;
        }
        const totalNotional = openPositions.reduce((sum, p) => sum + p.notional, 0);

        const { equity, maintenanceMargin, availableMargin } = computeAvailableMargin({
            balance: account.currentBalance,
            maintenanceRate: account.maintenanceRate || 0.005,
            totalUpnl,
            totalNotional,
            oppositeNotional,
            oppositePnl,
        });

        if (requiredMargin > availableMargin) {
            errors.push(ERR.INSUFFICIENT_MARGIN(requiredMargin, availableMargin));
        }

        // Margin usage ratio check (reject if >= 98%)
        const currentMarginUsed = openPositions
            .filter(p => !(p.symbol === symbol && p.side === oppositeSide))
            .reduce((sum, p) => sum + (p.margin || p.notional / p.leverage), 0);

        const marginUsageRatio = computeMarginUsageRatio({
            equity,
            currentMarginUsed,
            newMargin: requiredMargin,
        });

        if (marginUsageRatio >= 0.98) {
            errors.push(ERR.MARGIN_RATIO_EXCEEDED(marginUsageRatio, 0.98));
        }

        return {
            valid: errors.length === 0,
            errors,
            computedValues: {
                price, notional, requiredMargin,
                availableBalance: availableMargin,
                currentExposure, equity,
                maintenanceMargin,
            },
        };
    }
}

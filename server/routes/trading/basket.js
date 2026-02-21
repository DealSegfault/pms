/**
 * Basket Trades Routes — multi-leg basket execution.
 */
import { Router } from 'express';
import riskEngine, { prisma } from '../../risk/index.js';
import exchange from '../../exchange.js';
import { requireOwnership } from '../../ownership.js';

const router = Router();

const basketExecutionLocks = new Set();

// POST /api/trade/basket - Execute a basket (multi-leg) trade
router.post('/basket', requireOwnership('body'), async (req, res) => {
    let basketLockAcquired = false;
    let basketLockAccountId = null;
    try {
        const { subAccountId, legs, basketName } = req.body;

        if (!subAccountId || !Array.isArray(legs) || legs.length === 0) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, legs[]' });
        }

        // Validate and normalize each leg once.
        const normalizedLegs = [];
        for (const leg of legs) {
            if (!leg?.symbol || !leg?.side || !leg?.quantity || !leg?.leverage) {
                return res.status(400).json({
                    error: `Invalid leg: each leg needs symbol, side, quantity, leverage. Got: ${JSON.stringify(leg)}`
                });
            }

            const symbol = String(leg.symbol);
            const side = String(leg.side).toUpperCase();
            const quantity = Number.parseFloat(leg.quantity);
            const leverage = Number.parseFloat(leg.leverage);
            const priceHintRaw = Number.parseFloat(leg.price);
            const priceHint = Number.isFinite(priceHintRaw) && priceHintRaw > 0 ? priceHintRaw : null;
            if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
                return res.status(400).json({
                    error: `Invalid numeric leg values for ${symbol}: quantity=${leg.quantity}, leverage=${leg.leverage}`,
                });
            }
            if (side !== 'LONG' && side !== 'SHORT') {
                return res.status(400).json({
                    error: `Invalid side for ${symbol}: ${leg.side}. Use LONG or SHORT.`,
                });
            }
            normalizedLegs.push({ symbol, side, quantity, leverage, priceHint });
        }

        // Single-account lock keeps one-shot margin checks consistent.
        if (basketExecutionLocks.has(subAccountId)) {
            return res.status(409).json({
                error: `Basket execution already in progress for ${subAccountId}. Retry in a moment.`,
            });
        }
        basketExecutionLocks.add(subAccountId);
        basketLockAcquired = true;
        basketLockAccountId = subAccountId;

        const account = await prisma.subAccount.findUnique({ where: { id: subAccountId } });
        if (!account) {
            return res.status(404).json({ error: `Sub-account not found: ${subAccountId}` });
        }
        if (account.status !== 'ACTIVE') {
            return res.status(400).json({ error: `Account status is ${account.status}; trading disabled.` });
        }

        const uniqueSymbols = [...new Set(normalizedLegs.map((leg) => leg.symbol))];
        exchange.subscribeToPrices(uniqueSymbols);

        // Resolve mark prices once, then reuse for basket margin pre-check.
        // Prefer leg price hints from client (already fetched there), then cache, then REST.
        const markBySymbol = new Map();
        for (const leg of normalizedLegs) {
            if (!markBySymbol.has(leg.symbol) && Number.isFinite(leg.priceHint) && leg.priceHint > 0) {
                markBySymbol.set(leg.symbol, leg.priceHint);
            }
        }

        const unresolvedSymbols = [];
        for (const symbol of uniqueSymbols) {
            if (markBySymbol.has(symbol)) continue;
            const cached = exchange.getLatestPrice(symbol);
            if (Number.isFinite(cached) && cached > 0) {
                markBySymbol.set(symbol, cached);
                continue;
            }
            unresolvedSymbols.push(symbol);
        }

        if (unresolvedSymbols.length > 0) {
            const markEntries = await Promise.all(unresolvedSymbols.map(async (symbol) => {
                const ticker = await exchange.fetchTicker(symbol);
                const mark = Number(ticker?.mark || ticker?.last || ticker?.price);
                if (!Number.isFinite(mark) || mark <= 0) {
                    throw new Error(`No valid mark price for ${symbol}`);
                }
                return [symbol, mark];
            }));
            for (const [symbol, mark] of markEntries) {
                markBySymbol.set(symbol, mark);
            }
        }

        const pricedLegs = normalizedLegs.map((leg) => {
            const markPrice = markBySymbol.get(leg.symbol);
            const notional = leg.quantity * markPrice;
            const requiredMargin = notional / leg.leverage;
            return { ...leg, markPrice, notional, requiredMargin };
        });

        const rules = await riskEngine.getRules(subAccountId);
        const perLegRuleErrors = [];
        for (const leg of pricedLegs) {
            if (Number.isFinite(rules?.maxLeverage) && leg.leverage > rules.maxLeverage) {
                perLegRuleErrors.push({
                    code: 'MAX_LEVERAGE',
                    message: `${leg.symbol} leverage ${leg.leverage} exceeds max ${rules.maxLeverage}`,
                });
            }
            if (Number.isFinite(rules?.maxNotionalPerTrade) && leg.notional > rules.maxNotionalPerTrade) {
                perLegRuleErrors.push({
                    code: 'MAX_NOTIONAL',
                    message: `${leg.symbol} notional $${leg.notional.toFixed(2)} exceeds per-trade max $${rules.maxNotionalPerTrade.toFixed(2)}`,
                });
            }
        }
        if (perLegRuleErrors.length > 0) {
            return res.status(400).json({
                error: 'Basket pre-check failed: one or more legs violate risk limits.',
                errors: perLegRuleErrors,
            });
        }

        const openPositions = await prisma.virtualPosition.findMany({
            where: { subAccountId, status: 'OPEN' },
        });
        const basketNotional = pricedLegs.reduce((sum, leg) => sum + leg.notional, 0);
        const basketRequiredMargin = pricedLegs.reduce((sum, leg) => sum + leg.requiredMargin, 0);
        const currentExposure = openPositions.reduce((sum, p) => sum + p.notional, 0);
        const postExposure = currentExposure + basketNotional;
        if (Number.isFinite(rules?.maxTotalExposure) && postExposure > rules.maxTotalExposure) {
            return res.status(400).json({
                error: `Basket pre-check failed: post-trade exposure $${postExposure.toFixed(2)} exceeds max $${rules.maxTotalExposure.toFixed(2)}`,
            });
        }

        const totalUpnl = await riskEngine.priceService.calcPositionsUpnl(openPositions);
        const maintenanceRate = Number.isFinite(account.maintenanceRate) ? account.maintenanceRate : 0.005;
        const totalMaintenanceMargin = openPositions.reduce((sum, p) => sum + p.notional * maintenanceRate, 0);
        const equity = account.currentBalance + totalUpnl;
        const availableMargin = equity - totalMaintenanceMargin;
        if (basketRequiredMargin > availableMargin) {
            return res.status(400).json({
                error: `Basket pre-check failed: required margin $${basketRequiredMargin.toFixed(2)} exceeds available $${availableMargin.toFixed(2)}`,
            });
        }

        const currentMarginUsed = openPositions.reduce((sum, p) => sum + (p.margin || p.notional / p.leverage), 0);
        const postTradeMarginUsed = currentMarginUsed + basketRequiredMargin;
        const marginUsageRatio = equity > 0 ? (postTradeMarginUsed / equity) : Number.POSITIVE_INFINITY;
        if (marginUsageRatio >= 0.98) {
            return res.status(400).json({
                error: `Basket pre-check failed: post-trade margin usage ${(marginUsageRatio * 100).toFixed(2)}% exceeds 98%`,
            });
        }

        // Execute legs in parallel after one-shot margin pre-check.
        const results = await Promise.all(pricedLegs.map(async (leg) => {
            try {
                const result = await riskEngine.executeTrade(
                    subAccountId,
                    leg.symbol,
                    leg.side,
                    leg.quantity,
                    leg.leverage,
                    'MARKET',
                    {
                        skipValidation: true,
                        fastExecution: true,
                        fallbackPrice: leg.markPrice,
                    },
                );
                return {
                    symbol: leg.symbol,
                    side: leg.side,
                    success: result.success,
                    trade: result.trade || null,
                    errors: result.errors || null,
                };
            } catch (err) {
                return {
                    symbol: leg.symbol,
                    side: leg.side,
                    success: false,
                    errors: [{ code: 'EXECUTION_ERROR', message: err.message }],
                };
            }
        }));

        const successCount = results.filter(r => r.success).length;
        res.status(successCount > 0 ? 201 : 400).json({
            basketName: basketName || 'Unnamed Basket',
            total: normalizedLegs.length,
            succeeded: successCount,
            failed: normalizedLegs.length - successCount,
            results,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (basketLockAcquired) {
            basketExecutionLocks.delete(basketLockAccountId);
        }
    }
});

export default router;

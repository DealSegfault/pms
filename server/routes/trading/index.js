/**
 * Hub — aggregates all trading sub-routers onto one Express Router.
 *
 * Import order matters: routes registered first win when paths overlap,
 * so more-specific path prefixes are imported before wildcard ones.
 */
import { Router } from 'express';
import marketDataRouter, { setMarketDataExchangeConnector } from './market-data.js';
import marketOrdersRouter, { setMarketOrdersExchangeConnector } from './market-orders.js';
import limitOrdersRouter, { setLimitOrdersExchangeConnector } from './limit-orders.js';
import basketRouter, { setBasketExchangeConnector } from './basket.js';
import twapRouter from './twap.js';
import trailStopRouter from './trail-stop.js';
import chaseLimitRouter, { setChaseLimitExchangeConnector } from './chase-limit.js';

import scalperRouter, { setScalperExchangeConnector } from './scalper.js';
import analyticsRouter, { setAnalyticsExchangeConnector } from './analytics.js';
import agentRouter from './agent-routes.js';
import smartOrderRouter from './smart-order.js'; // NEW
import { setOrderSizingExchangeConnector } from './order-sizing.js';

export function configureTradingRouteDeps({ exchangeConnector } = {}) {
    if (!exchangeConnector) return;
    setMarketDataExchangeConnector(exchangeConnector);
    setMarketOrdersExchangeConnector(exchangeConnector);
    setLimitOrdersExchangeConnector(exchangeConnector);
    setBasketExchangeConnector(exchangeConnector);
    setChaseLimitExchangeConnector(exchangeConnector);
    setScalperExchangeConnector(exchangeConnector);
    setAnalyticsExchangeConnector(exchangeConnector);
    setOrderSizingExchangeConnector(exchangeConnector);
}

export function createTradingRouter({ exchangeConnector } = {}) {
    configureTradingRouteDeps({ exchangeConnector });

    const router = Router();

    // Mount sub-routers — all paths are relative to the mount point in server/index.js (/api/trade)
    router.use(marketDataRouter);
    router.use(marketOrdersRouter);
    router.use(limitOrdersRouter);
    router.use(basketRouter);
    router.use(twapRouter);
    router.use(trailStopRouter);
    router.use(chaseLimitRouter);

    router.use(scalperRouter);
    router.use(analyticsRouter);
    router.use(agentRouter);
    router.use(smartOrderRouter); // NEW

    return router;
}

const router = createTradingRouter();
export default router;

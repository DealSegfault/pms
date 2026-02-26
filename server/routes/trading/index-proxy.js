/**
 * Trading Hub — PROXY VERSION
 *
 * Simplified hub using thin Redis proxy routes.
 * Algo engines, risk engine, exchange connector — all in Python.
 * JS only handles auth, routing, and read-only DB queries.
 */
import { Router } from 'express';
import marketDataRouter from './market-data.js';
import marketOrdersRouter from './market-orders-proxy.js';
import limitOrdersRouter from './limit-orders-proxy.js';
import basketRouter from './basket-proxy.js';
import algosRouter from './algos-proxy.js';

const router = Router();

// Mount sub-routers — all paths relative to /api/trade
router.use(marketDataRouter);
router.use(marketOrdersRouter);
router.use(limitOrdersRouter);
router.use(basketRouter);
router.use(algosRouter);

export default router;

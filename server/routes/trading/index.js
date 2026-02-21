/**
 * Hub — aggregates all trading sub-routers onto one Express Router.
 *
 * Import order matters: routes registered first win when paths overlap,
 * so more-specific path prefixes are imported before wildcard ones.
 */
import { Router } from 'express';
import marketDataRouter from './market-data.js';
import marketOrdersRouter from './market-orders.js';
import limitOrdersRouter from './limit-orders.js';
import basketRouter from './basket.js';
import twapRouter from './twap.js';
import trailStopRouter from './trail-stop.js';
import chaseLimitRouter from './chase-limit.js';
import pumpChaserRouter from './pump-chaser.js';
import scalperRouter from './scalper.js';
import analyticsRouter from './analytics.js';

const router = Router();

// Mount sub-routers — all paths are relative to the mount point in server/index.js (/api/trade)
router.use(marketDataRouter);
router.use(marketOrdersRouter);
router.use(limitOrdersRouter);
router.use(basketRouter);
router.use(twapRouter);
router.use(trailStopRouter);
router.use(chaseLimitRouter);
router.use(pumpChaserRouter);
router.use(scalperRouter);
router.use(analyticsRouter);

export default router;

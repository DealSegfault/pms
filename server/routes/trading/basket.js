/**
 * Basket Routes — THIN PROXY VERSION
 */
import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { proxyToRedis } from '../../redis-proxy.js';

const router = Router();

// POST /api/trade/basket — Basket trade via Python
router.post('/basket', requireOwnership('body'), proxyToRedis('pms:cmd:basket'));

export default router;

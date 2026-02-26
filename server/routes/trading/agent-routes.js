/**
 * Agent Routes — REST API for managing trading agents.
 *
 * All endpoints are under /api/trade/agents (mounted via trading/index.js).
 */
import { Router } from 'express';
import { requireOwnership } from '../../ownership.js';
import { startAgent, stopAgent, listAgents, getAgent } from '../../agents/manager.js';

const router = Router();

// POST /api/trade/agents — Start a new agent
router.post('/agents', requireOwnership('body'), async (req, res) => {
    try {
        const { type, ...config } = req.body;
        if (!type) {
            return res.status(400).json({ error: 'Missing required field: type (trend | grid | deleverage)' });
        }
        if (!config.subAccountId || !config.symbol) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol' });
        }

        const result = await startAgent(type, config);
        res.status(201).json({ success: true, ...result });
    } catch (err) {
        console.error('[AgentRoutes] Start failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/agents/:subAccountId — List active agents
router.get('/agents/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const results = listAgents(req.params.subAccountId);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/agents/detail/:agentId — Get agent detail
router.get('/agents/detail/:agentId', async (req, res) => {
    try {
        const agent = getAgent(req.params.agentId);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        res.json(agent);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/agents/:agentId — Stop an agent
router.delete('/agents/:agentId', async (req, res) => {
    try {
        const result = await stopAgent(req.params.agentId, req.query.reason || 'manual');
        res.json({ success: true, ...result });
    } catch (err) {
        if (err.message.includes('not found')) {
            return res.status(404).json({ error: err.message });
        }
        res.status(500).json({ error: err.message });
    }
});

export default router;

import { Router } from 'express';
import { prisma } from '../risk/index.js';
import { adminMiddleware } from '../auth.js';
import { sanitize } from '../sanitize.js';
import { validate } from '../middleware/validate.js';
import { RiskRuleBody, SubAccountIdParam } from '../contracts/risk-rules.contracts.js';

const router = Router();

// GET /api/risk-rules - All rules (global + per-account)
router.get('/', adminMiddleware, async (req, res) => {
    try {
        const rules = await prisma.riskRule.findMany({
            include: { subAccount: true },
        });
        res.json(sanitize(rules));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/risk-rules/global - Set or update global rules
router.put('/global', adminMiddleware, validate(RiskRuleBody), async (req, res) => {
    try {
        const { maxLeverage, maxNotionalPerTrade, maxTotalExposure, liquidationThreshold } = req.body;
        const data = {
            isGlobal: true,
            maxLeverage,
            maxNotionalPerTrade,
            maxTotalExposure,
            liquidationThreshold,
        };

        // Upsert global rule
        const existing = await prisma.riskRule.findFirst({ where: { isGlobal: true } });
        let rule;
        if (existing) {
            rule = await prisma.riskRule.update({ where: { id: existing.id }, data });
        } else {
            rule = await prisma.riskRule.create({ data });
        }
        res.json(rule);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/risk-rules/:subAccountId - Set per-account override
router.put('/:subAccountId', adminMiddleware, validate(SubAccountIdParam, 'params'), validate(RiskRuleBody), async (req, res) => {
    try {
        const { maxLeverage, maxNotionalPerTrade, maxTotalExposure, liquidationThreshold } = req.body;
        const data = {
            subAccountId: req.params.subAccountId,
            isGlobal: false,
            maxLeverage,
            maxNotionalPerTrade,
            maxTotalExposure,
            liquidationThreshold,
        };

        const existing = await prisma.riskRule.findUnique({ where: { subAccountId: req.params.subAccountId } });
        let rule;
        if (existing) {
            rule = await prisma.riskRule.update({ where: { id: existing.id }, data });
        } else {
            rule = await prisma.riskRule.create({ data });
        }
        res.json(rule);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/risk-rules/:subAccountId - Remove per-account override (fall back to global)
router.delete('/:subAccountId', adminMiddleware, validate(SubAccountIdParam, 'params'), async (req, res) => {
    try {
        await prisma.riskRule.deleteMany({ where: { subAccountId: req.params.subAccountId } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

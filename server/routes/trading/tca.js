import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { buildApiErrorBody } from '../../http/api-taxonomy.js';
import { requireOwnership } from '../../ownership.js';
import {
    buildLifecycleQuery,
    buildMarkoutQuery,
    buildRollupQuery,
    buildStrategyRollupQuery,
    buildStrategySessionQuery,
    serializeFillMarkout,
    serializeLifecycleDetail,
    serializeLifecycleSummary,
    serializeStrategyRollup,
    serializeStrategySession,
    serializeSubAccountRollup,
} from '../../tca-read-models.js';

const router = Router();

router.get('/tca/lifecycles/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildLifecycleQuery(req.params.subAccountId, req.query);
        const rows = await prisma.orderLifecycle.findMany({
            where: query.where,
            take: query.take,
            orderBy: { createdAt: 'desc' },
            include: {
                _count: {
                    select: {
                        events: true,
                        fillFacts: true,
                    },
                },
            },
        });
        res.json(rows.map(serializeLifecycleSummary));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_LIFECYCLE_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read lifecycle summaries',
            retryable: true,
        }));
    }
});

router.get('/tca/lifecycle/:subAccountId/:lifecycleId', requireOwnership(), async (req, res) => {
    try {
        const row = await prisma.orderLifecycle.findFirst({
            where: {
                id: req.params.lifecycleId,
                subAccountId: req.params.subAccountId,
            },
            include: {
                strategySession: {
                    include: {
                        _count: {
                            select: {
                                lifecycles: true,
                                rollups: true,
                            },
                        },
                    },
                },
                events: {
                    orderBy: [
                        { sourceTs: 'asc' },
                        { createdAt: 'asc' },
                    ],
                },
                fillFacts: {
                    orderBy: { fillTs: 'asc' },
                    include: {
                        markouts: {
                            orderBy: { horizonMs: 'asc' },
                        },
                    },
                },
            },
        });

        if (!row) {
            return res.status(404).json(buildApiErrorBody({
                code: 'TCA_LIFECYCLE_NOT_FOUND',
                category: 'VALIDATION',
                message: 'Lifecycle not found for this sub-account',
            }));
        }

        res.json(serializeLifecycleDetail(row));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_LIFECYCLE_DETAIL_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read lifecycle detail',
            retryable: true,
        }));
    }
});

router.get('/tca/markouts/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildMarkoutQuery(req.params.subAccountId, req.query);
        const rows = await prisma.fillMarkout.findMany({
            where: query.where,
            take: query.take,
            orderBy: { measuredTs: 'desc' },
            include: {
                fillFact: {
                    include: {
                        lifecycle: true,
                    },
                },
            },
        });
        res.json(rows.map(serializeFillMarkout));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_MARKOUT_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read fill markouts',
            retryable: true,
        }));
    }
});

router.get('/tca/strategy-sessions/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildStrategySessionQuery(req.params.subAccountId, req.query);
        const rows = await prisma.strategySession.findMany({
            where: query.where,
            take: query.take,
            orderBy: { startedAt: 'desc' },
            include: {
                _count: {
                    select: {
                        lifecycles: true,
                        rollups: true,
                    },
                },
            },
        });
        res.json(rows.map(serializeStrategySession));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_SESSION_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy sessions',
            retryable: true,
        }));
    }
});

router.get('/tca/rollups/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildRollupQuery(req.params.subAccountId, req.query);
        const rows = await prisma.subAccountTcaRollup.findMany({
            where: query.where,
            orderBy: { updatedAt: 'desc' },
        });
        res.json(rows.map(serializeSubAccountRollup));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_ROLLUP_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read sub-account rollups',
            retryable: true,
        }));
    }
});

router.get('/tca/strategy-rollups/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildStrategyRollupQuery(req.params.subAccountId, req.query);
        const rows = await prisma.strategyTcaRollup.findMany({
            where: query.where,
            orderBy: { updatedAt: 'desc' },
        });
        res.json(rows.map(serializeStrategyRollup));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_ROLLUP_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy rollups',
            retryable: true,
        }));
    }
});

export default router;

import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { buildApiErrorBody } from '../../http/api-taxonomy.js';
import { requireOwnership } from '../../ownership.js';
import { classifyTcaReadWeight, runTcaReadTask } from '../../tca-request-gate.js';
import { buildTcaCacheKey, modalCache, embedCache } from '../../tca-modal-cache.js';
import {
    buildLifecyclePageQuery,
    buildLifecycleQuery,
    buildMarkoutQuery,
    buildRollupQuery,
    buildStrategyRollupQuery,
    buildStrategySessionQuery,
    buildStrategySessionPageQuery,
    buildStrategyTimeseriesQuery,
    parseQualityByRole,
    serializeFillMarkout,
    serializeLifecycleDetail,
    serializeStrategySessionPageItem,
    serializeLifecycleSummary,
    serializeStrategyRollup,
    serializeStrategySession,
    serializeSubAccountRollup,
} from '../../tca-read-models.js';
import { fetchStrategySessionPage } from '../../tca/repositories/strategy-session-page-repository.js';
import { loadRootAnomalyCounts } from '../../tca/services/anomaly-service.js';
import { loadLineageGraph } from '../../tca/services/lineage-graph-service.js';
import { loadStrategySessionDetailSnapshot } from '../../tca/services/strategy-session-detail-service.js';
import { loadStrategySessionLedger } from '../../tca/services/strategy-session-ledger-service.js';
import {
    TcaMemoryGuardError,
    loadStrategySessionTimeseriesWindow,
} from '../../tca/services/strategy-session-timeseries-service.js';

const router = Router();
const ALLOWED_MODAL_SECTIONS = ['detail', 'timeseries', 'ledger'];
const DEFAULT_MODAL_SECTIONS = ['detail'];
const DEFAULT_MODAL_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MODAL_MAX_POINTS = 120;
const DEFAULT_MODAL_EVENTS_PAGE_SIZE = 8;

function normalizeSymbolFilter(symbol) {
    if (!symbol) return null;
    const raw = String(symbol).toUpperCase().replace(/\//g, '').replace(/:USDT/g, '');
    return raw.endsWith('USDT') ? raw : `${raw}USDT`;
}

async function loadStrategySessionAnomalyCounts(subAccountId, strategySessionIds) {
    return loadRootAnomalyCounts(subAccountId, strategySessionIds);
}

function normalizeExecutionScope(value) {
    return String(value || 'SUB_ACCOUNT').toUpperCase();
}

function normalizeOwnershipConfidence(value) {
    return String(value || 'HARD').toUpperCase();
}

function parseModalSections(rawValue) {
    const parsed = String(rawValue || DEFAULT_MODAL_SECTIONS.join(','))
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
        .filter((value, index, items) => items.indexOf(value) === index)
        .filter((value) => ALLOWED_MODAL_SECTIONS.includes(value));
    return parsed.length ? parsed : DEFAULT_MODAL_SECTIONS.slice();
}

function buildModalTimeseriesQuery(rawQuery = {}) {
    return buildStrategyTimeseriesQuery({
        ...rawQuery,
        defaultWindowMs: rawQuery.defaultWindowMs ?? String(DEFAULT_MODAL_WINDOW_MS),
        maxPoints: rawQuery.maxPoints ?? String(DEFAULT_MODAL_MAX_POINTS),
        eventsPageSize: rawQuery.eventsPageSize ?? String(DEFAULT_MODAL_EVENTS_PAGE_SIZE),
    });
}

function createStrategySessionNotFoundError() {
    const error = new Error('Strategy session not found');
    error.status = 404;
    error.code = 'TCA_STRATEGY_SESSION_NOT_FOUND';
    error.category = 'NOT_FOUND';
    error.retryable = false;
    return error;
}

function sendTcaInfraError(res, err, fallbackCode, fallbackMessage) {
    if (err instanceof TcaMemoryGuardError) {
        return res.status(err.status || 503).json(buildApiErrorBody({
            code: err.code,
            category: err.category,
            message: err.message,
            retryable: err.retryable,
            details: err.details,
        }));
    }

    if (err?.status && err?.code && err?.category) {
        return res.status(err.status).json(buildApiErrorBody({
            code: err.code,
            category: err.category,
            message: err.message || fallbackMessage,
            retryable: err.retryable ?? true,
            details: err.details,
        }));
    }

    const status = Number(err?.status || 0);
    if (status === 404) {
        return res.status(404).json(buildApiErrorBody({
            code: err?.code || 'TCA_STRATEGY_SESSION_NOT_FOUND',
            category: err?.category || 'NOT_FOUND',
            message: err?.message || 'Strategy session not found',
            retryable: err?.retryable ?? false,
        }));
    }

    return res.status(500).json(buildApiErrorBody({
        code: fallbackCode,
        category: 'INFRA',
        message: err?.message || fallbackMessage,
        retryable: true,
    }));
}

async function runAdmittedTcaRead(res, descriptor, task) {
    const weight = Math.max(1, classifyTcaReadWeight(descriptor));
    return runTcaReadTask({ ...descriptor, weight }, async (admission) => {
        if (res && !res.headersSent) {
            res.setHeader('X-TCA-Read-Weight', String(weight));
            res.setHeader('X-TCA-Queue-Wait-Ms', String(Math.max(0, Number(admission?.queueWaitMs || 0))));
            res.setHeader('X-TCA-Gate-Capacity', String(Math.max(1, Number(admission?.gateCapacity || 1))));
        }
        return task(admission);
    });
}

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

router.get('/tca/lifecycles-page/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildLifecyclePageQuery(req.params.subAccountId, req.query);
        const [total, rows] = await Promise.all([
            prisma.orderLifecycle.count({ where: query.where }),
            prisma.orderLifecycle.findMany({
                where: query.where,
                skip: query.skip,
                take: query.take,
                orderBy: query.orderBy,
                include: {
                    _count: {
                        select: {
                            events: true,
                            fillFacts: true,
                        },
                    },
                    fillFacts: {
                        select: {
                            id: true,
                            markouts: {
                                select: {
                                    horizonMs: true,
                                    markoutBps: true,
                                },
                            },
                        },
                    },
                },
            }),
        ]);

        const totalPages = total > 0 ? Math.ceil(total / query.pageSize) : 0;
        res.json({
            items: rows.map(serializeLifecycleSummary),
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages,
            hasPrev: query.page > 1,
            hasNext: query.page < totalPages,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_LIFECYCLE_PAGE_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read lifecycle page',
            retryable: true,
        }));
    }
});

router.get('/tca/lifecycle/:subAccountId/:lifecycleId', requireOwnership(), async (req, res) => {
    try {
        const includeLineage = String(req.query.includeLineage ?? '1') !== '0';
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

        const lineageGraph = includeLineage
            ? await loadLineageGraph(req.params.subAccountId, 'ORDER_LIFECYCLE', row.id)
            : null;
        res.json(serializeLifecycleDetail(row, { lineageGraph }));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_LIFECYCLE_DETAIL_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read lifecycle detail',
            retryable: true,
        }));
    }
});

router.get('/tca/lineage/:subAccountId/:nodeType/:nodeId', requireOwnership(), async (req, res) => {
    try {
        const nodeType = String(req.params.nodeType || '').toUpperCase();
        const allowed = new Set(['STRATEGY_SESSION', 'ORDER_LIFECYCLE', 'FILL_FACT']);
        if (!allowed.has(nodeType)) {
            return res.status(400).json(buildApiErrorBody({
                code: 'TCA_LINEAGE_NODE_TYPE_INVALID',
                category: 'VALIDATION',
                message: `Unsupported nodeType: ${req.params.nodeType}`,
            }));
        }
        const graph = await loadLineageGraph(req.params.subAccountId, nodeType, req.params.nodeId);
        res.json(graph);
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_LINEAGE_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read lineage graph',
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

router.get('/tca/strategy-sessions-page/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const query = buildStrategySessionPageQuery(req.params.subAccountId, req.query);
        const executionScope = String(req.query.executionScope || 'SUB_ACCOUNT').toUpperCase();
        const ownershipConfidence = String(req.query.ownershipConfidence || 'HARD').toUpperCase();
        const pageData = await runAdmittedTcaRead(res, {
            route: 'strategy-page',
        }, async () => fetchStrategySessionPage({
            subAccountId: req.params.subAccountId,
            query,
            executionScope,
            ownershipConfidence,
        }));
        const sessionIds = pageData.items.map((row) => String(row.strategySessionId || '')).filter(Boolean);
        const anomalyCounts = await runAdmittedTcaRead(res, {
            route: 'strategy-page',
        }, async () => loadStrategySessionAnomalyCounts(req.params.subAccountId, sessionIds));
        const items = pageData.items.map((row) => {
            const anomaly = anomalyCounts.get(String(row.strategySessionId || '')) || {};
            return serializeStrategySessionPageItem({
                ...row,
                anomalyCount: Number(anomaly.unknownLineageCount || 0) + Number(anomaly.sessionPnlAnomalyCount || 0),
                hasAnomaly: Number(anomaly.unknownLineageCount || 0) > 0 || Number(anomaly.sessionPnlAnomalyCount || 0) > 0,
            });
        });

        const total = pageData.total;
        const totalPages = total > 0 ? Math.ceil(total / query.pageSize) : 0;

        res.json({
            items,
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages,
            hasPrev: query.page > 1,
            hasNext: query.page < totalPages,
            sortBy: query.sortBy,
            sortDir: query.sortDir,
        });
    } catch (err) {
        sendTcaInfraError(
            res,
            err,
            'TCA_STRATEGY_SESSION_PAGE_READ_FAILED',
            'Failed to read strategy session page',
        );
    }
});

router.get('/tca/strategy-session/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const includeLineage = String(req.query.includeLineage ?? '1') !== '0';
        const detail = await runAdmittedTcaRead(res, {
            route: 'strategy-detail',
            includeLineage,
        }, async () => loadStrategySessionDetailSnapshot({
            subAccountId: req.params.subAccountId,
            strategySessionId: req.params.strategySessionId,
            executionScope: normalizeExecutionScope(req.query.executionScope),
            ownershipConfidence: normalizeOwnershipConfidence(req.query.ownershipConfidence),
            includeLineage,
        }));
        if (!detail) {
            return res.status(404).json(buildApiErrorBody({
                code: 'TCA_STRATEGY_SESSION_NOT_FOUND',
                category: 'NOT_FOUND',
                message: 'Strategy session not found',
            }));
        }
        res.json(detail);
    } catch (err) {
        sendTcaInfraError(
            res,
            err,
            'TCA_STRATEGY_SESSION_DETAIL_READ_FAILED',
            'Failed to read strategy session detail',
        );
    }
});

router.get('/tca/strategy-session-timeseries/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const query = buildStrategyTimeseriesQuery(req.query);
        const payload = await runAdmittedTcaRead(res, {
            route: 'strategy-timeseries',
            series: Array.from(query.series || []),
            includeEvents: query.includeEvents,
            rangeMs: query.rangeMs,
            maxPoints: query.maxPoints,
        }, async () => loadStrategySessionTimeseriesWindow({
            subAccountId: req.params.subAccountId,
            strategySessionId: req.params.strategySessionId,
            query,
        }));
        res.json(payload);
    } catch (err) {
        sendTcaInfraError(
            res,
            err,
            'TCA_STRATEGY_SESSION_TIMESERIES_READ_FAILED',
            'Failed to read strategy session timeseries',
        );
    }
});

router.get('/tca/strategy-session-lot-ledger/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const payload = await runAdmittedTcaRead(res, {
            route: 'strategy-ledger',
        }, async () => loadStrategySessionLedger({
            subAccountId: req.params.subAccountId,
            strategySessionId: req.params.strategySessionId,
            limits: req.query,
        }));
        res.json(payload);
    } catch (err) {
        sendTcaInfraError(
            res,
            err,
            'TCA_STRATEGY_SESSION_LOT_LEDGER_READ_FAILED',
            'Failed to read strategy lot ledger',
        );
    }
});

router.get('/tca/embed-summary/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const executionScope = normalizeExecutionScope(req.query.executionScope);
        const ownershipConfidence = normalizeOwnershipConfidence(req.query.ownershipConfidence);
        const symbol = normalizeSymbolFilter(req.query.symbol);
        const requestedStrategySessionId = req.query.strategySessionId ? String(req.query.strategySessionId) : null;
        const embedCacheKey = buildTcaCacheKey({
            scope: 'embed',
            subAccountId: req.params.subAccountId,
            strategySessionId: requestedStrategySessionId || '',
            symbol: symbol || '',
            executionScope,
            ownershipConfidence,
            sections: ['summary'],
        });

        const embedPayload = await runAdmittedTcaRead(res, {
            route: 'embed-summary',
        }, async () => embedCache.getOrCreate(embedCacheKey, async () => {
            const scoreCardRollup = await prisma.subAccountTcaRollup.findFirst({
                where: {
                    subAccountId: req.params.subAccountId,
                    executionScope,
                    ownershipConfidence,
                },
                orderBy: { updatedAt: 'desc' },
            });

            let strategySessionId = requestedStrategySessionId;
            let runtime = null;
            if (strategySessionId) {
                runtime = await prisma.algoRuntimeSession.findUnique({
                    where: { strategySessionId },
                });
            } else {
                const runtimeWhere = {
                    subAccountId: req.params.subAccountId,
                    ...(symbol ? { strategySession: { symbol } } : {}),
                };
                const activeRuntime = await prisma.algoRuntimeSession.findFirst({
                    where: {
                        ...runtimeWhere,
                        status: 'ACTIVE',
                    },
                    orderBy: { updatedAt: 'desc' },
                });
                runtime = activeRuntime || await prisma.algoRuntimeSession.findFirst({
                    where: runtimeWhere,
                    orderBy: { updatedAt: 'desc' },
                });
                strategySessionId = runtime?.strategySessionId || null;
            }

            let strategySession = null;
            let strategyRollup = null;
            let sparkline = [];
            if (strategySessionId) {
                [strategySession, strategyRollup] = await Promise.all([
                    prisma.strategySession.findFirst({
                        where: {
                            id: strategySessionId,
                            subAccountId: req.params.subAccountId,
                            ...(symbol ? { symbol } : {}),
                        },
                    }),
                    prisma.strategyTcaRollup.findFirst({
                        where: {
                            strategySessionId,
                            executionScope,
                            ownershipConfidence,
                            rollupLevel: 'ROOT',
                        },
                    }),
                ]);

                const samples = await prisma.strategySessionPnlSample.findMany({
                    where: { strategySessionId },
                    orderBy: [
                        { sampledAt: 'desc' },
                        { createdAt: 'desc' },
                    ],
                    take: 30,
                });
                sparkline = samples
                    .slice()
                    .reverse()
                    .map((row) => ({
                        ts: row.sampledAt,
                        value: Number(row.netPnl || 0),
                    }));
            }

            return {
                subAccountId: req.params.subAccountId,
                scoreCard: scoreCardRollup ? {
                    executionScope: scoreCardRollup.executionScope,
                    ownershipConfidence: scoreCardRollup.ownershipConfidence,
                    fillCount: scoreCardRollup.fillCount ?? 0,
                    realizedPnl: scoreCardRollup.realizedPnl ?? 0,
                    unrealizedPnl: scoreCardRollup.unrealizedPnl ?? 0,
                    netPnl: scoreCardRollup.netPnl ?? 0,
                    feesTotal: scoreCardRollup.feesTotal ?? 0,
                    avgArrivalSlippageBps: scoreCardRollup.avgArrivalSlippageBps ?? null,
                    avgMarkout1sBps: scoreCardRollup.avgMarkout1sBps ?? null,
                    avgMarkout5sBps: scoreCardRollup.avgMarkout5sBps ?? null,
                    toxicityScore: serializeSubAccountRollup(scoreCardRollup).toxicityScore,
                    qualityByRole: parseQualityByRole(scoreCardRollup),
                    updatedAt: scoreCardRollup.updatedAt,
                } : null,
                activeStrategy: strategySession ? {
                    strategySessionId: strategySession.id,
                    strategyType: strategyRollup?.strategyType || strategySession.strategyType,
                    symbol: strategySession.symbol,
                    side: strategySession.side,
                    runtimeStatus: runtime?.status || null,
                    resumePolicy: runtime?.resumePolicy || null,
                    netPnl: strategyRollup?.netPnl ?? 0,
                    updatedAt: runtime?.updatedAt || strategyRollup?.updatedAt || strategySession.updatedAt,
                } : null,
                sparkline,
            };
        }));
        res.json(embedPayload);
    } catch (err) {
        sendTcaInfraError(
            res,
            err,
            'TCA_EMBED_SUMMARY_READ_FAILED',
            'Failed to read TCA embed summary',
        );
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

// ── Combined modal endpoint — section-aware wrapper over the shared loaders ──
router.get('/tca/strategy-modal-payload/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId, strategySessionId } = req.params;
        const sections = parseModalSections(req.query.sections);
        const executionScope = normalizeExecutionScope(req.query.executionScope);
        const ownershipConfidence = normalizeOwnershipConfidence(req.query.ownershipConfidence);
        const timeseriesQuery = buildModalTimeseriesQuery(req.query);
        const includeTimeseries = sections.includes('timeseries');
        const cacheKey = buildTcaCacheKey({
            scope: 'modal',
            subAccountId,
            strategySessionId,
            symbol: req.query.symbol || '',
            executionScope,
            ownershipConfidence,
            sections,
            from: includeTimeseries ? timeseriesQuery.from : '',
            to: includeTimeseries ? timeseriesQuery.to : '',
            bucketMs: includeTimeseries ? timeseriesQuery.bucketMs : '',
            maxPoints: includeTimeseries ? timeseriesQuery.maxPoints : '',
            series: includeTimeseries ? Array.from(timeseriesQuery.series || []).sort().join(',') : '',
            includeEvents: includeTimeseries ? timeseriesQuery.includeEvents : '',
            eventsPage: includeTimeseries ? timeseriesQuery.eventsPage : '',
            eventsPageSize: includeTimeseries ? timeseriesQuery.eventsPageSize : '',
        });

        const payload = await runAdmittedTcaRead(res, {
            route: 'strategy-modal',
            sections,
            series: Array.from(timeseriesQuery.series || []),
            includeEvents: timeseriesQuery.includeEvents,
            rangeMs: timeseriesQuery.rangeMs,
            maxPoints: timeseriesQuery.maxPoints,
        }, async () => modalCache.getOrCreate(cacheKey, async () => {
            const result = {};

            if (sections.includes('detail')) {
                result.detail = await loadStrategySessionDetailSnapshot({
                    subAccountId,
                    strategySessionId,
                    executionScope,
                    ownershipConfidence,
                    includeLineage: false,
                });
                if (!result.detail) {
                    throw createStrategySessionNotFoundError();
                }
            }

            if (sections.includes('timeseries')) {
                result.timeseries = await loadStrategySessionTimeseriesWindow({
                    subAccountId,
                    strategySessionId,
                    query: timeseriesQuery,
                });
            }

            if (sections.includes('ledger')) {
                result.ledger = await loadStrategySessionLedger({
                    subAccountId,
                    strategySessionId,
                    limits: req.query,
                });
            }

            return result;
        }));

        res.json(payload);
    } catch (err) {
        sendTcaInfraError(
            res,
            err,
            'TCA_STRATEGY_MODAL_PAYLOAD_READ_FAILED',
            'Failed to read strategy modal payload',
        );
    }
});

export default router;

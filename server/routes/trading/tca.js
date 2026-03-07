import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { buildApiErrorBody } from '../../http/api-taxonomy.js';
import { requireOwnership } from '../../ownership.js';
import { modalCache, embedCache } from '../../tca-modal-cache.js';
import {
    bucketTimeSeries,
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
    serializeStrategyLotLedger,
    serializeStrategySessionDetail,
    serializeStrategySessionPageItem,
    serializeLifecycleSummary,
    serializeStrategyRollup,
    serializeStrategySession,
    serializeSubAccountRollup,
} from '../../tca-read-models.js';
import { loadRecursiveLineageGraph } from '../../tca/repositories/lineage-repository.js';
import { fetchStrategySessionPage } from '../../tca/repositories/strategy-session-page-repository.js';
import { loadRootAnomalyCounts } from '../../tca/services/anomaly-service.js';

const router = Router();
let graphTruncatedCount = 0;

function normalizeSymbolFilter(symbol) {
    if (!symbol) return null;
    const raw = String(symbol).toUpperCase().replace(/\//g, '').replace(/:USDT/g, '');
    return raw.endsWith('USDT') ? raw : `${raw}USDT`;
}

async function loadStrategySessionAnomalyCounts(subAccountId, strategySessionIds) {
    return loadRootAnomalyCounts(subAccountId, strategySessionIds);
}

async function loadLineageGraph(subAccountId, rootNodeType, rootNodeId) {
    const graph = await loadRecursiveLineageGraph({
        subAccountId,
        rootNodeType,
        rootNodeId,
        maxNodes: 5000,
        maxEdges: 10000,
    });
    if (graph.truncated) {
        graphTruncatedCount += 1;
        console.info(`[TCA] lineage graph truncated count=${graphTruncatedCount}`);
    }
    return graph;
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
        const pageData = await fetchStrategySessionPage({
            subAccountId: req.params.subAccountId,
            query,
            executionScope,
            ownershipConfidence,
        });
        const sessionIds = pageData.items.map((row) => String(row.strategySessionId || '')).filter(Boolean);
        const anomalyCounts = await loadStrategySessionAnomalyCounts(req.params.subAccountId, sessionIds);
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
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_SESSION_PAGE_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy session page',
            retryable: true,
        }));
    }
});

router.get('/tca/strategy-session/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const includeLineage = String(req.query.includeLineage ?? '1') !== '0';
        const strategySession = await prisma.strategySession.findFirst({
            where: {
                id: req.params.strategySessionId,
                subAccountId: req.params.subAccountId,
            },
            include: {
                _count: {
                    select: {
                        lifecycles: true,
                        rollups: true,
                    },
                },
            },
        });
        if (!strategySession) {
            return res.status(404).json(buildApiErrorBody({
                code: 'TCA_STRATEGY_SESSION_NOT_FOUND',
                category: 'NOT_FOUND',
                message: 'Strategy session not found',
            }));
        }

        const executionScope = String(req.query.executionScope || 'SUB_ACCOUNT').toUpperCase();
        const ownershipConfidence = String(req.query.ownershipConfidence || 'HARD').toUpperCase();
        const [rollup, runtime, latestPnlSample, latestParamSample, anomalyCounts, lineageGraph] = await Promise.all([
            prisma.strategyTcaRollup.findFirst({
                where: {
                    strategySessionId: req.params.strategySessionId,
                    executionScope,
                    ownershipConfidence,
                    rollupLevel: 'ROOT',
                },
            }),
            prisma.algoRuntimeSession.findUnique({
                where: { strategySessionId: req.params.strategySessionId },
            }),
            prisma.strategySessionPnlSample.findFirst({
                where: { strategySessionId: req.params.strategySessionId },
                orderBy: { sampledAt: 'desc' },
            }),
            prisma.strategySessionParamSample.findFirst({
                where: { strategySessionId: req.params.strategySessionId },
                orderBy: { sampledAt: 'desc' },
            }),
            loadRootAnomalyCounts(req.params.subAccountId, [req.params.strategySessionId]),
            includeLineage
                ? loadLineageGraph(req.params.subAccountId, 'STRATEGY_SESSION', req.params.strategySessionId)
                : Promise.resolve(null),
        ]);
        const qualityByRole = parseQualityByRole(rollup);
        const counts = anomalyCounts.get(req.params.strategySessionId) || {
            unknownRoleCount: 0,
            unknownLineageCount: 0,
            sessionPnlAnomalyCount: 0,
        };

        const displayStrategySession = {
            ...strategySession,
            origin: strategySession.origin,
            strategyType: strategySession.strategyType,
        };

        res.json(serializeStrategySessionDetail({
            strategySession: displayStrategySession,
            rollup,
            qualityByRole,
            runtime,
            latestPnlSample,
            latestParamSample,
            anomalyCounts: counts,
            lineageGraph,
        }));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_SESSION_DETAIL_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy session detail',
            retryable: true,
        }));
    }
});

router.get('/tca/strategy-session-timeseries/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const query = buildStrategyTimeseriesQuery(req.query);
        const sampledAt = {};
        if (query.from) sampledAt.gte = query.from;
        if (query.to) sampledAt.lte = query.to;
        const checkpointTs = {};
        if (query.from) checkpointTs.gte = query.from;
        if (query.to) checkpointTs.lte = query.to;
        const fillTs = {};
        if (query.from) fillTs.gte = query.from;
        if (query.to) fillTs.lte = query.to;

        const [pnlRows, paramRows, checkpointTotal, checkpointRows, qualityLifecycles] = await Promise.all([
            query.series.has('pnl') || query.series.has('exposure')
                ? prisma.strategySessionPnlSample.findMany({
                    where: {
                        strategySessionId: req.params.strategySessionId,
                        ...(Object.keys(sampledAt).length ? { sampledAt } : {}),
                    },
                    orderBy: { sampledAt: 'asc' },
                    take: 500,
                })
                : [],
            query.series.has('params')
                ? prisma.strategySessionParamSample.findMany({
                    where: {
                        strategySessionId: req.params.strategySessionId,
                        ...(Object.keys(sampledAt).length ? { sampledAt } : {}),
                    },
                    orderBy: { sampledAt: 'asc' },
                    take: 500,
                })
                : [],
            prisma.algoRuntimeCheckpoint.count({
                where: {
                    strategySessionId: req.params.strategySessionId,
                    ...(Object.keys(checkpointTs).length ? { checkpointTs } : {}),
                },
            }),
            prisma.algoRuntimeCheckpoint.findMany({
                where: {
                    strategySessionId: req.params.strategySessionId,
                    ...(Object.keys(checkpointTs).length ? { checkpointTs } : {}),
                },
                orderBy: [
                    { checkpointTs: 'desc' },
                    { checkpointSeq: 'desc' },
                ],
                skip: query.eventsSkip,
                take: query.eventsPageSize,
            }),
            query.series.has('quality')
                ? prisma.orderLifecycle.findMany({
                    where: {
                        subAccountId: req.params.subAccountId,
                        rootStrategySessionId: req.params.strategySessionId,
                    },
                    select: {
                        orderRole: true,
                        side: true,
                        decisionMid: true,
                        avgFillPrice: true,
                        fillFacts: {
                            where: Object.keys(fillTs).length ? { fillTs } : undefined,
                            select: {
                                fillTs: true,
                                markouts: {
                                    select: {
                                        horizonMs: true,
                                        markoutBps: true,
                                    },
                                },
                            },
                        },
                    },
                    take: 50,
                })
                : [],
        ]);

        const pnlPoints = (pnlRows || []).map((row) => ({
            ts: row.sampledAt,
            realizedPnl: row.realizedPnl,
            unrealizedPnl: row.unrealizedPnl,
            netPnl: row.netPnl,
            openQty: row.openQty,
            openNotional: row.openNotional,
            feesTotal: row.feesTotal,
            fillCount: row.fillCount,
            closeCount: row.closeCount,
        }));
        const paramPoints = (paramRows || []).map((row) => ({
            ts: row.sampledAt,
            longOffsetPct: row.longOffsetPct,
            shortOffsetPct: row.shortOffsetPct,
            skew: row.skew,
            longActiveSlots: row.longActiveSlots,
            shortActiveSlots: row.shortActiveSlots,
            longPausedSlots: row.longPausedSlots,
            shortPausedSlots: row.shortPausedSlots,
            longRetryingSlots: row.longRetryingSlots,
            shortRetryingSlots: row.shortRetryingSlots,
            minFillSpreadPct: row.minFillSpreadPct,
            minRefillDelayMs: row.minRefillDelayMs,
            maxLossPerCloseBps: row.maxLossPerCloseBps,
        }));
        const qualityPoints = [];
        for (const lifecycle of qualityLifecycles || []) {
            for (const fill of lifecycle.fillFacts || []) {
                const mk1 = (fill.markouts || []).find((row) => row.horizonMs === 1000)?.markoutBps ?? null;
                const mk5 = (fill.markouts || []).find((row) => row.horizonMs === 5000)?.markoutBps ?? null;
                const mk30 = (fill.markouts || []).find((row) => row.horizonMs === 30000)?.markoutBps ?? null;
                const benchmark = Number(lifecycle.decisionMid);
                const avgFillPrice = Number(lifecycle.avgFillPrice);
                const arrival = benchmark > 0 && avgFillPrice > 0
                    ? (
                        String(lifecycle.side || '').toUpperCase() === 'SELL'
                            ? ((benchmark - avgFillPrice) / benchmark) * 10000
                            : ((avgFillPrice - benchmark) / benchmark) * 10000
                    )
                    : null;
                qualityPoints.push({
                    ts: fill.fillTs,
                    orderRole: lifecycle.orderRole || 'UNKNOWN',
                    avgArrivalSlippageBps: arrival,
                    avgMarkout1sBps: mk1,
                    avgMarkout5sBps: mk5,
                    avgMarkout30sBps: mk30,
                });
            }
        }
        const eventItems = (checkpointRows || []).map((row) => ({
            ts: row.checkpointTs,
            type: row.checkpointReason,
            status: row.status,
            checkpointSeq: row.checkpointSeq,
        }));
        const eventTotalPages = checkpointTotal > 0 ? Math.ceil(checkpointTotal / query.eventsPageSize) : 0;

        const qualityReducer = (bucket, items) => {
            const avg = (field) => {
                const values = items.map((item) => item[field]).filter(Number.isFinite);
                if (!values.length) return null;
                return values.reduce((sum, value) => sum + value, 0) / values.length;
            };
            return {
                ts: new Date(bucket),
                avgArrivalSlippageBps: avg('avgArrivalSlippageBps'),
                avgMarkout1sBps: avg('avgMarkout1sBps'),
                avgMarkout5sBps: avg('avgMarkout5sBps'),
                avgMarkout30sBps: avg('avgMarkout30sBps'),
            };
        };

        const seriesPayload = {
            pnl: bucketTimeSeries(pnlPoints, query.bucketMs),
            exposure: bucketTimeSeries(
                pnlPoints.map((row) => ({ ts: row.ts, openQty: row.openQty, openNotional: row.openNotional })),
                query.bucketMs,
            ),
            params: bucketTimeSeries(paramPoints, query.bucketMs),
            quality: bucketTimeSeries(qualityPoints, query.bucketMs, qualityReducer),
        };
        const pointCount = Math.max(
            seriesPayload.pnl.length,
            seriesPayload.exposure.length,
            seriesPayload.params.length,
            seriesPayload.quality.length,
        );
        const truncated = Boolean(query.from && query.to && query.bucketMs !== query.requestedBucketMs);

        res.json({
            strategySessionId: req.params.strategySessionId,
            bucketMs: query.bucketMs,
            effectiveBucketMs: query.bucketMs,
            pointCount,
            truncated,
            range: {
                from: query.from,
                to: query.to,
            },
            series: seriesPayload,
            events: {
                items: eventItems,
                page: query.eventsPage,
                pageSize: query.eventsPageSize,
                total: checkpointTotal,
                totalPages: eventTotalPages,
                hasPrev: query.eventsPage > 1,
                hasNext: query.eventsPage < eventTotalPages,
            },
        });
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_SESSION_TIMESERIES_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy session timeseries',
            retryable: true,
        }));
    }
});

router.get('/tca/strategy-session-lot-ledger/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const [openLots, realizations, anomalyRows] = await Promise.all([
            prisma.strategyPositionLot.findMany({
                where: {
                    subAccountId: req.params.subAccountId,
                    rootStrategySessionId: req.params.strategySessionId,
                },
                orderBy: { openedTs: 'desc' },
            }),
            prisma.strategyLotRealization.findMany({
                where: {
                    subAccountId: req.params.subAccountId,
                    rootStrategySessionId: req.params.strategySessionId,
                },
                orderBy: { realizedTs: 'desc' },
                take: 200,
            }),
            prisma.tcaAnomaly.findMany({
                where: {
                    subAccountId: req.params.subAccountId,
                    rootStrategySessionId: req.params.strategySessionId,
                    anomalyType: 'SESSION_PNL',
                },
                orderBy: [
                    { lastSeenAt: 'desc' },
                    { createdAt: 'desc' },
                ],
                take: 100,
            }),
        ]);

        res.json(serializeStrategyLotLedger({
            strategySessionId: req.params.strategySessionId,
            openLots,
            realizations,
            anomalies: anomalyRows.map((row) => {
                let payload = null;
                try {
                    payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
                } catch {
                    payload = null;
                }
                return {
                    anomalyId: row.id,
                    anomalyKey: row.anomalyKey,
                    lifecycleId: row.lifecycleId,
                    sourceTs: row.sourceTs,
                    status: row.status,
                    severity: row.severity,
                    payload,
                };
            }),
        }));
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_SESSION_LOT_LEDGER_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy lot ledger',
            retryable: true,
        }));
    }
});

router.get('/tca/embed-summary/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const executionScope = String(req.query.executionScope || 'SUB_ACCOUNT').toUpperCase();
        const ownershipConfidence = String(req.query.ownershipConfidence || 'HARD').toUpperCase();
        const symbol = normalizeSymbolFilter(req.query.symbol);
        const requestedStrategySessionId = req.query.strategySessionId ? String(req.query.strategySessionId) : null;

        // ── Check embed cache ──
        const embedCacheKey = `${req.params.subAccountId}:${symbol || ''}:${requestedStrategySessionId || ''}`;
        const cachedEmbed = embedCache.get(embedCacheKey);
        if (cachedEmbed) return res.json(cachedEmbed);

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
                orderBy: { sampledAt: 'desc' },
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

        const embedPayload = {
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
        embedCache.set(embedCacheKey, embedPayload);
        res.json(embedPayload);
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_EMBED_SUMMARY_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read TCA embed summary',
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

// ── Combined modal endpoint — merges strategy-session detail + timeseries + lot-ledger ──
// Reduces 3 parallel HTTP calls to 1, with phased query execution to limit peak memory.
router.get('/tca/strategy-modal-payload/:subAccountId/:strategySessionId', requireOwnership(), async (req, res) => {
    try {
        const { subAccountId, strategySessionId } = req.params;

        // ── Check cache ──
        const cacheKey = `${subAccountId}:${strategySessionId}`;
        const cached = modalCache.get(cacheKey);
        if (cached) return res.json(cached);

        const executionScope = String(req.query.executionScope || 'SUB_ACCOUNT').toUpperCase();
        const ownershipConfidence = String(req.query.ownershipConfidence || 'HARD').toUpperCase();
        const maxPoints = Math.min(parseInt(req.query.maxPoints) || 180, 500);
        const eventsPageSize = Math.min(parseInt(req.query.eventsPageSize) || 8, 50);

        // ── Phase 1: Fast detail (6 queries) ──
        const [strategySession, rollup, runtime, latestPnlSample, latestParamSample, anomalyCounts] = await Promise.all([
            prisma.strategySession.findFirst({
                where: { id: strategySessionId, subAccountId },
                include: {
                    _count: { select: { lifecycles: true, rollups: true } },
                },
            }),
            prisma.strategyTcaRollup.findFirst({
                where: { strategySessionId, executionScope, ownershipConfidence, rollupLevel: 'ROOT' },
            }),
            prisma.algoRuntimeSession.findUnique({
                where: { strategySessionId },
            }),
            prisma.strategySessionPnlSample.findFirst({
                where: { strategySessionId },
                orderBy: { sampledAt: 'desc' },
            }),
            prisma.strategySessionParamSample.findFirst({
                where: { strategySessionId },
                orderBy: { sampledAt: 'desc' },
            }),
            loadRootAnomalyCounts(subAccountId, [strategySessionId]),
        ]);

        if (!strategySession) {
            return res.status(404).json(buildApiErrorBody({
                code: 'TCA_STRATEGY_SESSION_NOT_FOUND',
                category: 'NOT_FOUND',
                message: 'Strategy session not found',
            }));
        }

        const qualityByRole = parseQualityByRole(rollup);
        const counts = anomalyCounts.get(strategySessionId) || {
            unknownRoleCount: 0,
            unknownLineageCount: 0,
            sessionPnlAnomalyCount: 0,
        };

        const detail = serializeStrategySessionDetail({
            strategySession: { ...strategySession, origin: strategySession.origin, strategyType: strategySession.strategyType },
            rollup,
            qualityByRole,
            runtime,
            latestPnlSample,
            latestParamSample,
            anomalyCounts: counts,
            lineageGraph: null, // skip lineage for modal speed
        });

        // ── Phase 2: Charts + ledger (7 queries, starts after Phase 1) ──
        const [pnlRows, paramRows, checkpointTotal, checkpointRows, qualityLifecycles, openLots, realizations, anomalyRows] = await Promise.all([
            prisma.strategySessionPnlSample.findMany({
                where: { strategySessionId },
                orderBy: { sampledAt: 'asc' },
                take: maxPoints,
            }),
            prisma.strategySessionParamSample.findMany({
                where: { strategySessionId },
                orderBy: { sampledAt: 'asc' },
                take: maxPoints,
            }),
            prisma.algoRuntimeCheckpoint.count({
                where: { strategySessionId },
            }),
            prisma.algoRuntimeCheckpoint.findMany({
                where: { strategySessionId },
                orderBy: [{ checkpointTs: 'desc' }, { checkpointSeq: 'desc' }],
                take: eventsPageSize,
            }),
            prisma.orderLifecycle.findMany({
                where: { subAccountId, rootStrategySessionId: strategySessionId },
                select: {
                    orderRole: true,
                    side: true,
                    decisionMid: true,
                    avgFillPrice: true,
                    fillFacts: {
                        select: {
                            fillTs: true,
                            markouts: { select: { horizonMs: true, markoutBps: true } },
                        },
                    },
                },
                take: 50,
            }),
            prisma.strategyPositionLot.findMany({
                where: { subAccountId, rootStrategySessionId: strategySessionId },
                orderBy: { openedTs: 'desc' },
            }),
            prisma.strategyLotRealization.findMany({
                where: { subAccountId, rootStrategySessionId: strategySessionId },
                orderBy: { realizedTs: 'desc' },
                take: 200,
            }),
            prisma.tcaAnomaly.findMany({
                where: { subAccountId, rootStrategySessionId: strategySessionId, anomalyType: 'SESSION_PNL' },
                orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
                take: 100,
            }),
        ]);

        // ── Build timeseries payload ──
        const pnlPoints = (pnlRows || []).map((row) => ({
            ts: row.sampledAt, realizedPnl: row.realizedPnl, unrealizedPnl: row.unrealizedPnl,
            netPnl: row.netPnl, openQty: row.openQty, openNotional: row.openNotional,
            feesTotal: row.feesTotal, fillCount: row.fillCount, closeCount: row.closeCount,
        }));
        const paramPoints = (paramRows || []).map((row) => ({
            ts: row.sampledAt, longOffsetPct: row.longOffsetPct, shortOffsetPct: row.shortOffsetPct,
            skew: row.skew, longActiveSlots: row.longActiveSlots, shortActiveSlots: row.shortActiveSlots,
            longPausedSlots: row.longPausedSlots, shortPausedSlots: row.shortPausedSlots,
            longRetryingSlots: row.longRetryingSlots, shortRetryingSlots: row.shortRetryingSlots,
            minFillSpreadPct: row.minFillSpreadPct, minRefillDelayMs: row.minRefillDelayMs,
            maxLossPerCloseBps: row.maxLossPerCloseBps,
        }));
        const qualityPoints = [];
        for (const lifecycle of qualityLifecycles || []) {
            for (const fill of lifecycle.fillFacts || []) {
                const mk1 = (fill.markouts || []).find((r) => r.horizonMs === 1000)?.markoutBps ?? null;
                const mk5 = (fill.markouts || []).find((r) => r.horizonMs === 5000)?.markoutBps ?? null;
                const mk30 = (fill.markouts || []).find((r) => r.horizonMs === 30000)?.markoutBps ?? null;
                const benchmark = Number(lifecycle.decisionMid);
                const avgFillPrice = Number(lifecycle.avgFillPrice);
                const arrival = benchmark > 0 && avgFillPrice > 0
                    ? (String(lifecycle.side || '').toUpperCase() === 'SELL'
                        ? ((benchmark - avgFillPrice) / benchmark) * 10000
                        : ((avgFillPrice - benchmark) / benchmark) * 10000)
                    : null;
                qualityPoints.push({
                    ts: fill.fillTs, orderRole: lifecycle.orderRole || 'UNKNOWN',
                    avgArrivalSlippageBps: arrival, avgMarkout1sBps: mk1, avgMarkout5sBps: mk5, avgMarkout30sBps: mk30,
                });
            }
        }
        const eventItems = (checkpointRows || []).map((row) => ({
            ts: row.checkpointTs, type: row.checkpointReason, status: row.status, checkpointSeq: row.checkpointSeq,
        }));
        const eventTotalPages = checkpointTotal > 0 ? Math.ceil(checkpointTotal / eventsPageSize) : 0;

        const qualityReducer = (bucket, items) => {
            const avg = (field) => {
                const values = items.map((item) => item[field]).filter(Number.isFinite);
                if (!values.length) return null;
                return values.reduce((sum, value) => sum + value, 0) / values.length;
            };
            return {
                ts: new Date(bucket),
                avgArrivalSlippageBps: avg('avgArrivalSlippageBps'),
                avgMarkout1sBps: avg('avgMarkout1sBps'),
                avgMarkout5sBps: avg('avgMarkout5sBps'),
                avgMarkout30sBps: avg('avgMarkout30sBps'),
            };
        };

        const defaultBucketMs = 5000;
        const seriesPayload = {
            pnl: bucketTimeSeries(pnlPoints, defaultBucketMs),
            exposure: bucketTimeSeries(
                pnlPoints.map((row) => ({ ts: row.ts, openQty: row.openQty, openNotional: row.openNotional })),
                defaultBucketMs,
            ),
            params: bucketTimeSeries(paramPoints, defaultBucketMs),
            quality: bucketTimeSeries(qualityPoints, defaultBucketMs, qualityReducer),
        };

        const timeseries = {
            strategySessionId,
            bucketMs: defaultBucketMs,
            effectiveBucketMs: defaultBucketMs,
            pointCount: Math.max(seriesPayload.pnl.length, seriesPayload.exposure.length, seriesPayload.params.length, seriesPayload.quality.length),
            truncated: false,
            range: { from: null, to: null },
            series: seriesPayload,
            events: {
                items: eventItems, page: 1, pageSize: eventsPageSize,
                total: checkpointTotal, totalPages: eventTotalPages,
                hasPrev: false, hasNext: 1 < eventTotalPages,
            },
        };

        // ── Build ledger payload ──
        const ledger = serializeStrategyLotLedger({
            strategySessionId,
            openLots,
            realizations,
            anomalies: (anomalyRows || []).map((row) => {
                let payload = null;
                try { payload = row.payloadJson ? JSON.parse(row.payloadJson) : null; } catch { payload = null; }
                return {
                    anomalyId: row.id, anomalyKey: row.anomalyKey, lifecycleId: row.lifecycleId,
                    sourceTs: row.sourceTs, status: row.status, severity: row.severity, payload,
                };
            }),
        });

        const result = { detail, timeseries, ledger };
        modalCache.set(cacheKey, result);
        res.json(result);
    } catch (err) {
        res.status(500).json(buildApiErrorBody({
            code: 'TCA_STRATEGY_MODAL_PAYLOAD_READ_FAILED',
            category: 'INFRA',
            message: err.message || 'Failed to read strategy modal payload',
            retryable: true,
        }));
    }
});

export default router;

import prisma from '../../db/prisma.js';
import { parseQualityByRole, serializeStrategySessionDetail } from '../../tca-read-models.js';
import { loadRootAnomalyCounts } from './anomaly-service.js';
import { loadLineageGraph } from './lineage-graph-service.js';

export async function loadStrategySessionDetailSnapshot({
    subAccountId,
    strategySessionId,
    executionScope = 'SUB_ACCOUNT',
    ownershipConfidence = 'HARD',
    includeLineage = false,
} = {}) {
    const strategySession = await prisma.strategySession.findFirst({
        where: {
            id: strategySessionId,
            subAccountId,
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
        return null;
    }

    const [rollup, runtime, latestPnlSample, latestParamSample, anomalyCounts, lineageGraph] = await Promise.all([
        prisma.strategyTcaRollup.findFirst({
            where: {
                strategySessionId,
                executionScope,
                ownershipConfidence,
                rollupLevel: 'ROOT',
            },
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
        includeLineage
            ? loadLineageGraph(subAccountId, 'STRATEGY_SESSION', strategySessionId)
            : Promise.resolve(null),
    ]);

    const qualityByRole = parseQualityByRole(rollup);
    const counts = anomalyCounts.get(strategySessionId) || {
        unknownRoleCount: 0,
        unknownLineageCount: 0,
        sessionPnlAnomalyCount: 0,
    };

    return serializeStrategySessionDetail({
        strategySession: {
            ...strategySession,
            origin: strategySession.origin,
            strategyType: strategySession.strategyType,
        },
        rollup,
        qualityByRole,
        runtime,
        latestPnlSample,
        latestParamSample,
        anomalyCounts: counts,
        lineageGraph,
    });
}

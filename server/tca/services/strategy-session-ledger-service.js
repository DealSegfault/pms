import prisma from '../../db/prisma.js';
import { serializeStrategyLotLedger } from '../../tca-read-models.js';

export async function loadStrategySessionLedger({
    subAccountId,
    strategySessionId,
    limits = {},
} = {}) {
    const realizationLimit = Math.max(1, Math.min(Number.parseInt(limits.realizationLimit, 10) || 200, 500));
    const anomalyLimit = Math.max(1, Math.min(Number.parseInt(limits.anomalyLimit, 10) || 100, 200));
    const openLotLimit = Math.max(1, Math.min(Number.parseInt(limits.openLotLimit, 10) || 250, 500));

    const [openLots, realizations, anomalyRows] = await Promise.all([
        prisma.strategyPositionLot.findMany({
            where: {
                subAccountId,
                rootStrategySessionId: strategySessionId,
            },
            orderBy: { openedTs: 'desc' },
            take: openLotLimit,
        }),
        prisma.strategyLotRealization.findMany({
            where: {
                subAccountId,
                rootStrategySessionId: strategySessionId,
            },
            orderBy: { realizedTs: 'desc' },
            take: realizationLimit,
        }),
        prisma.tcaAnomaly.findMany({
            where: {
                subAccountId,
                rootStrategySessionId: strategySessionId,
                anomalyType: 'SESSION_PNL',
            },
            orderBy: [
                { lastSeenAt: 'desc' },
                { createdAt: 'desc' },
            ],
            take: anomalyLimit,
        }),
    ]);

    return serializeStrategyLotLedger({
        strategySessionId,
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
    });
}

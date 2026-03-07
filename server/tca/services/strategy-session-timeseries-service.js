import { Prisma } from '@prisma/client';

import prisma from '../../db/prisma.js';
import { bucketTimeSeries } from '../../tca-read-models.js';
import { getRuntimeMemorySnapshot } from '../../runtime-metrics.js';

const DEFAULT_BUCKET_ORIGIN = `TIMESTAMPTZ '2001-01-01 00:00:00+00'`;
const EXPENSIVE_WINDOW_MS = 60 * 60 * 1000;

function isPostgresConfigured() {
    const databaseUrl = process.env.DATABASE_URL || '';
    return databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://');
}

function buildQualityReducer() {
    return (bucket, items) => {
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
}

function normalizeSeriesValue(rows = []) {
    return rows.map((row) => ({
        ...row,
        ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
    }));
}

function createRangeFilter(field, query) {
    return {
        [field]: {
            gte: query.from,
            lte: query.to,
        },
    };
}

async function queryBucketedPnlRows(strategySessionId, query) {
    const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT
            ranked.bucket AS "ts",
            ranked.realized_pnl AS "realizedPnl",
            ranked.unrealized_pnl AS "unrealizedPnl",
            ranked.net_pnl AS "netPnl",
            ranked.open_qty AS "openQty",
            ranked.open_notional AS "openNotional",
            ranked.fees_total AS "feesTotal",
            ranked.fill_count AS "fillCount",
            ranked.close_count AS "closeCount"
        FROM (
            SELECT
                date_bin(${query.bucketMs} * interval '1 millisecond', p.sampled_at, ${Prisma.raw(DEFAULT_BUCKET_ORIGIN)}) AS bucket,
                p.sampled_at,
                p.created_at,
                p.realized_pnl,
                p.unrealized_pnl,
                p.net_pnl,
                p.open_qty,
                p.open_notional,
                p.fees_total,
                p.fill_count,
                p.close_count,
                ROW_NUMBER() OVER (
                    PARTITION BY date_bin(${query.bucketMs} * interval '1 millisecond', p.sampled_at, ${Prisma.raw(DEFAULT_BUCKET_ORIGIN)})
                    ORDER BY p.sampled_at DESC, p.created_at DESC
                ) AS rn
            FROM strategy_session_pnl_samples p
            WHERE p.strategy_session_id = ${strategySessionId}
              AND p.sampled_at >= ${query.from}
              AND p.sampled_at <= ${query.to}
        ) ranked
        WHERE ranked.rn = 1
        ORDER BY ranked.bucket ASC
        LIMIT ${query.maxPoints}
    `);
    return normalizeSeriesValue(rows);
}

async function queryBucketedParamRows(strategySessionId, query) {
    const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT
            ranked.bucket AS "ts",
            ranked.long_offset_pct AS "longOffsetPct",
            ranked.short_offset_pct AS "shortOffsetPct",
            ranked.skew AS "skew",
            ranked.long_active_slots AS "longActiveSlots",
            ranked.short_active_slots AS "shortActiveSlots",
            ranked.long_paused_slots AS "longPausedSlots",
            ranked.short_paused_slots AS "shortPausedSlots",
            ranked.long_retrying_slots AS "longRetryingSlots",
            ranked.short_retrying_slots AS "shortRetryingSlots",
            ranked.min_fill_spread_pct AS "minFillSpreadPct",
            ranked.min_refill_delay_ms AS "minRefillDelayMs",
            ranked.max_loss_per_close_bps AS "maxLossPerCloseBps"
        FROM (
            SELECT
                date_bin(${query.bucketMs} * interval '1 millisecond', p.sampled_at, ${Prisma.raw(DEFAULT_BUCKET_ORIGIN)}) AS bucket,
                p.sampled_at,
                p.created_at,
                p.long_offset_pct,
                p.short_offset_pct,
                p.skew,
                p.long_active_slots,
                p.short_active_slots,
                p.long_paused_slots,
                p.short_paused_slots,
                p.long_retrying_slots,
                p.short_retrying_slots,
                p.min_fill_spread_pct,
                p.min_refill_delay_ms,
                p.max_loss_per_close_bps,
                ROW_NUMBER() OVER (
                    PARTITION BY date_bin(${query.bucketMs} * interval '1 millisecond', p.sampled_at, ${Prisma.raw(DEFAULT_BUCKET_ORIGIN)})
                    ORDER BY p.sampled_at DESC, p.created_at DESC
                ) AS rn
            FROM strategy_session_param_samples p
            WHERE p.strategy_session_id = ${strategySessionId}
              AND p.sampled_at >= ${query.from}
              AND p.sampled_at <= ${query.to}
        ) ranked
        WHERE ranked.rn = 1
        ORDER BY ranked.bucket ASC
        LIMIT ${query.maxPoints}
    `);
    return normalizeSeriesValue(rows);
}

async function queryBucketedQualityRows(subAccountId, strategySessionId, query) {
    const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT
            date_bin(${query.bucketMs} * interval '1 millisecond', f.fill_ts, ${Prisma.raw(DEFAULT_BUCKET_ORIGIN)}) AS "ts",
            AVG(
                CASE
                    WHEN l.decision_mid > 0 AND l.avg_fill_price > 0 THEN
                        CASE
                            WHEN UPPER(COALESCE(l.side, '')) = 'SELL'
                                THEN ((l.decision_mid - l.avg_fill_price) / l.decision_mid) * 10000
                            ELSE ((l.avg_fill_price - l.decision_mid) / l.decision_mid) * 10000
                        END
                    ELSE NULL
                END
            ) AS "avgArrivalSlippageBps",
            AVG(CASE WHEN m.horizon_ms = 1000 THEN m.markout_bps END) AS "avgMarkout1sBps",
            AVG(CASE WHEN m.horizon_ms = 5000 THEN m.markout_bps END) AS "avgMarkout5sBps",
            AVG(CASE WHEN m.horizon_ms = 30000 THEN m.markout_bps END) AS "avgMarkout30sBps"
        FROM fill_facts f
        JOIN order_lifecycles l
          ON l.id = f.lifecycle_id
        LEFT JOIN fill_markouts m
          ON m.fill_fact_id = f.id
         AND m.horizon_ms IN (1000, 5000, 30000)
        WHERE f.sub_account_id = ${subAccountId}
          AND l.root_strategy_session_id = ${strategySessionId}
          AND f.fill_ts >= ${query.from}
          AND f.fill_ts <= ${query.to}
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT ${query.maxPoints}
    `);
    return normalizeSeriesValue(rows);
}

async function queryFallbackPnlRows(strategySessionId, query) {
    const take = Math.min(Math.max(query.maxPoints * 8, 240), 2000);
    const rows = await prisma.strategySessionPnlSample.findMany({
        where: {
            strategySessionId,
            ...createRangeFilter('sampledAt', query),
        },
        orderBy: [
            { sampledAt: 'desc' },
            { createdAt: 'desc' },
        ],
        take,
    });
    return rows.slice().reverse().map((row) => ({
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
}

async function queryFallbackParamRows(strategySessionId, query) {
    const take = Math.min(Math.max(query.maxPoints * 8, 240), 2000);
    const rows = await prisma.strategySessionParamSample.findMany({
        where: {
            strategySessionId,
            ...createRangeFilter('sampledAt', query),
        },
        orderBy: [
            { sampledAt: 'desc' },
            { createdAt: 'desc' },
        ],
        take,
    });
    return rows.slice().reverse().map((row) => ({
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
}

async function queryFallbackQualityRows(subAccountId, strategySessionId, query) {
    const take = Math.min(Math.max(query.maxPoints * 8, 240), 2000);
    const rows = await prisma.fillFact.findMany({
        where: {
            subAccountId,
            ...createRangeFilter('fillTs', query),
            lifecycle: {
                rootStrategySessionId: strategySessionId,
            },
        },
        select: {
            fillTs: true,
            markouts: {
                select: {
                    horizonMs: true,
                    markoutBps: true,
                },
            },
            lifecycle: {
                select: {
                    orderRole: true,
                    side: true,
                    decisionMid: true,
                    avgFillPrice: true,
                },
            },
        },
        orderBy: { fillTs: 'desc' },
        take,
    });

    const points = rows
        .slice()
        .reverse()
        .map((row) => {
            const lifecycle = row.lifecycle || {};
            const mk1 = (row.markouts || []).find((markout) => markout.horizonMs === 1000)?.markoutBps ?? null;
            const mk5 = (row.markouts || []).find((markout) => markout.horizonMs === 5000)?.markoutBps ?? null;
            const mk30 = (row.markouts || []).find((markout) => markout.horizonMs === 30000)?.markoutBps ?? null;
            const benchmark = Number(lifecycle.decisionMid);
            const avgFillPrice = Number(lifecycle.avgFillPrice);
            const arrival = benchmark > 0 && avgFillPrice > 0
                ? (
                    String(lifecycle.side || '').toUpperCase() === 'SELL'
                        ? ((benchmark - avgFillPrice) / benchmark) * 10000
                        : ((avgFillPrice - benchmark) / benchmark) * 10000
                )
                : null;
            return {
                ts: row.fillTs,
                orderRole: lifecycle.orderRole || 'UNKNOWN',
                avgArrivalSlippageBps: arrival,
                avgMarkout1sBps: mk1,
                avgMarkout5sBps: mk5,
                avgMarkout30sBps: mk30,
            };
        });

    return bucketTimeSeries(points, query.bucketMs, buildQualityReducer());
}

async function loadBucketedSeries(subAccountId, strategySessionId, query) {
    if (!isPostgresConfigured()) {
        const pnlPoints = query.series.has('pnl') || query.series.has('exposure')
            ? await queryFallbackPnlRows(strategySessionId, query)
            : [];
        const paramPoints = query.series.has('params')
            ? await queryFallbackParamRows(strategySessionId, query)
            : [];
        const qualityPoints = query.series.has('quality')
            ? await queryFallbackQualityRows(subAccountId, strategySessionId, query)
            : [];
        return {
            pnlPoints: bucketTimeSeries(pnlPoints, query.bucketMs),
            paramPoints: bucketTimeSeries(paramPoints, query.bucketMs),
            qualityPoints,
        };
    }

    const pnlPoints = query.series.has('pnl') || query.series.has('exposure')
        ? await queryBucketedPnlRows(strategySessionId, query)
        : [];
    const paramPoints = query.series.has('params')
        ? await queryBucketedParamRows(strategySessionId, query)
        : [];
    const qualityPoints = query.series.has('quality')
        ? await queryBucketedQualityRows(subAccountId, strategySessionId, query)
        : [];

    return {
        pnlPoints,
        paramPoints,
        qualityPoints,
    };
}

async function loadCheckpointWindow(strategySessionId, query) {
    if (!query.includeEvents) {
        return {
            checkpointTotal: 0,
            checkpointRows: [],
        };
    }

    const checkpointWhere = {
        strategySessionId,
        checkpointTs: {
            gte: query.from,
            lte: query.to,
        },
    };
    const [checkpointTotal, checkpointRows] = await Promise.all([
        prisma.algoRuntimeCheckpoint.count({
            where: checkpointWhere,
        }),
        prisma.algoRuntimeCheckpoint.findMany({
            where: checkpointWhere,
            orderBy: [
                { checkpointTs: 'desc' },
                { checkpointSeq: 'desc' },
            ],
            skip: query.eventsSkip,
            take: query.eventsPageSize,
        }),
    ]);

    return {
        checkpointTotal,
        checkpointRows: (checkpointRows || []).map((row) => ({
            ts: row.checkpointTs,
            type: row.checkpointReason,
            status: row.status,
            checkpointSeq: row.checkpointSeq,
        })),
    };
}

export class TcaMemoryGuardError extends Error {
    constructor(message = 'TCA timeseries temporarily limited under memory pressure', details = {}) {
        super(message);
        this.name = 'TcaMemoryGuardError';
        this.status = 503;
        this.code = 'TCA_MEMORY_GUARD_ACTIVE';
        this.category = 'INFRA';
        this.retryable = true;
        this.details = details;
    }
}

export async function assertTcaWindowAllowed(query) {
    const rangeMs = Number(query.rangeMs || 0);
    const defaultWindowMs = Number(query.defaultWindowMs || 0);
    const availableMbFloor = 64;
    const isDefaultWindow = query.defaultedWindow || (defaultWindowMs > 0 && rangeMs <= defaultWindowMs);
    const snapshot = await getRuntimeMemorySnapshot();
    const availableMb = Number(snapshot?.system?.availableMb || 0);
    const combinedLocalRssMb = Number(snapshot?.combinedLocalRssMb || 0);
    const criticalMb = Number(snapshot?.budgetMb?.critical || 0);

    if (isDefaultWindow && availableMb < availableMbFloor) {
        throw new TcaMemoryGuardError(undefined, {
            suggestedWindow: '15m',
            availableMb,
            combinedLocalRssMb,
            rangeMs,
        });
    }

    const isExpensiveWindow = !query.defaultedWindow && rangeMs > EXPENSIVE_WINDOW_MS;
    if (!isExpensiveWindow) return;
    const memoryPressure = (
        availableMb < Number(snapshot?.budgetMb?.minAvailable || 0)
        || (criticalMb > 0 && combinedLocalRssMb >= criticalMb)
    );
    if (!memoryPressure) return;

    throw new TcaMemoryGuardError(undefined, {
        suggestedWindow: '15m',
        availableMb,
        combinedLocalRssMb,
        rangeMs,
    });
}

export async function loadStrategySessionTimeseriesWindow({
    subAccountId,
    strategySessionId,
    query,
} = {}) {
    await assertTcaWindowAllowed(query);

    const { pnlPoints, paramPoints, qualityPoints } = await loadBucketedSeries(
        subAccountId,
        strategySessionId,
        query,
    );
    const { checkpointTotal, checkpointRows } = await loadCheckpointWindow(strategySessionId, query);

    const seriesPayload = {
        pnl: pnlPoints || [],
        exposure: bucketTimeSeries(
            (pnlPoints || []).map((row) => ({ ts: row.ts, openQty: row.openQty, openNotional: row.openNotional })),
            query.bucketMs,
        ),
        params: paramPoints || [],
        quality: qualityPoints || [],
    };
    const pointCount = Math.max(
        seriesPayload.pnl.length,
        seriesPayload.exposure.length,
        seriesPayload.params.length,
        seriesPayload.quality.length,
    );
    const eventTotalPages = checkpointTotal > 0 ? Math.ceil(checkpointTotal / query.eventsPageSize) : 0;
    const truncated = Boolean(query.from && query.to && query.bucketMs !== query.requestedBucketMs);

    return {
        strategySessionId,
        bucketMs: query.bucketMs,
        effectiveBucketMs: query.bucketMs,
        pointCount,
        truncated,
        range: {
            from: query.from,
            to: query.to,
            defaultedWindow: query.defaultedWindow,
        },
        series: seriesPayload,
        events: {
            items: checkpointRows,
            page: query.eventsPage,
            pageSize: query.eventsPageSize,
            total: checkpointTotal,
            totalPages: eventTotalPages,
            hasPrev: query.eventsPage > 1,
            hasNext: query.eventsPage < eventTotalPages,
        },
    };
}

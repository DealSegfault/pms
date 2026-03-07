import { Prisma } from '@prisma/client';

import prisma from '../../db/prisma.js';

function joinClauses(clauses = []) {
    if (!clauses.length) return Prisma.empty;
    return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
}

function inList(values = []) {
    return Prisma.join(values.map((value) => Prisma.sql`${String(value)}`));
}

function buildStrategySessionWhere({ subAccountId, query }) {
    const clauses = [Prisma.sql`s.sub_account_id = ${subAccountId}`];
    if (query.where?.sessionRole) {
        clauses.push(Prisma.sql`UPPER(COALESCE(s.session_role, 'STANDALONE')) = ${String(query.where.sessionRole).toUpperCase()}`);
    }
    if (query.where?.strategyType) {
        clauses.push(Prisma.sql`UPPER(COALESCE(s.strategy_type, '')) = ${String(query.where.strategyType).toUpperCase()}`);
    } else if (Array.isArray(query.where?.OR) && query.where.OR[0]?.strategyType === 'SCALPER') {
        clauses.push(Prisma.sql`(
            UPPER(COALESCE(s.strategy_type, '')) = 'SCALPER'
            OR s.id LIKE 'scalper_%'
            OR s.id LIKE 'scalper-%'
        )`);
    }
    if (query.where?.symbol) {
        clauses.push(Prisma.sql`s.symbol = ${query.where.symbol}`);
    }
    if (query.where?.startedAt?.gte) {
        clauses.push(Prisma.sql`s.started_at >= ${query.where.startedAt.gte}`);
    }
    if (query.where?.startedAt?.lte) {
        clauses.push(Prisma.sql`s.started_at <= ${query.where.startedAt.lte}`);
    }
    if (query.status) {
        clauses.push(Prisma.sql`UPPER(COALESCE(ars.status, '')) = ${String(query.status).toUpperCase()}`);
    }
    return clauses;
}

function sortColumnFor(sortBy = 'updatedAt') {
    const normalized = String(sortBy || 'updatedAt');
    if (normalized === 'startedAt') return Prisma.sql`"sortStartedAt"`;
    if (normalized === 'netPnl') return Prisma.sql`"sortNetPnl"`;
    if (normalized === 'realizedPnl') return Prisma.sql`"sortRealizedPnl"`;
    if (normalized === 'toxicityScore') return Prisma.sql`"sortToxicityScore"`;
    if (normalized === 'fillCount') return Prisma.sql`"sortFillCount"`;
    return Prisma.sql`"sortUpdatedAt"`;
}

function sortDirectionFor(sortDir = 'desc') {
    return String(sortDir || 'desc').toLowerCase() === 'asc'
        ? Prisma.sql`ASC`
        : Prisma.sql`DESC`;
}

function shouldRetryWithoutQualityByRole(err) {
    const message = String(err?.message || '').toLowerCase();
    return message.includes('quality_by_role_json')
        && (
            message.includes('does not exist')
            || message.includes('no such column')
            || message.includes('unknown column')
        );
}

function buildStrategySessionPageRowsQuery({
    whereSql,
    sortColumn,
    sortDirection,
    query,
    executionScope,
    ownershipConfidence,
    includeQualityByRoleJson = true,
}) {
    const qualityByRoleSelect = includeQualityByRoleJson
        ? Prisma.sql`r.quality_by_role_json AS "qualityByRoleJson",`
        : Prisma.sql`NULL AS "qualityByRoleJson",`;

    return Prisma.sql`
        SELECT
            s.id AS "strategySessionId",
            s.sub_account_id AS "subAccountId",
            s.strategy_type AS "strategyType",
            s.session_role AS "sessionRole",
            s.symbol AS "symbol",
            s.side AS "side",
            s.started_at AS "startedAt",
            s.updated_at AS "sessionUpdatedAt",
            r.strategy_session_id AS "rollupStrategySessionId",
            r.sub_account_id AS "rollupSubAccountId",
            r.strategy_type AS "rollupStrategyType",
            r.rollup_level AS "rollupLevel",
            r.execution_scope AS "rollupExecutionScope",
            r.ownership_confidence AS "rollupOwnershipConfidence",
            ${qualityByRoleSelect}
            r.fill_count AS "rollupFillCount",
            r.close_count AS "rollupCloseCount",
            r.realized_pnl AS "rollupRealizedPnl",
            r.unrealized_pnl AS "rollupUnrealizedPnl",
            r.net_pnl AS "rollupNetPnl",
            r.fees_total AS "rollupFeesTotal",
            r.open_qty AS "rollupOpenQty",
            r.open_notional AS "rollupOpenNotional",
            r.win_count AS "rollupWinCount",
            r.loss_count AS "rollupLossCount",
            r.win_rate AS "rollupWinRate",
            r.avg_arrival_slippage_bps AS "rollupAvgArrivalSlippageBps",
            r.avg_markout_1s_bps AS "rollupAvgMarkout1sBps",
            r.avg_markout_5s_bps AS "rollupAvgMarkout5sBps",
            r.avg_markout_30s_bps AS "rollupAvgMarkout30sBps",
            r.total_reprice_count AS "rollupTotalRepriceCount",
            r.updated_at AS "rollupUpdatedAt",
            ars.strategy_session_id AS "runtimeStrategySessionId",
            ars.sub_account_id AS "runtimeSubAccountId",
            ars.strategy_type AS "runtimeStrategyType",
            ars.status AS "runtimeStatus",
            ars.resume_policy AS "runtimeResumePolicy",
            ars.updated_at AS "runtimeUpdatedAt",
            lp.sampled_at AS "latestPnlSampledAt",
            lp.realized_pnl AS "latestPnlRealizedPnl",
            lp.unrealized_pnl AS "latestPnlUnrealizedPnl",
            lp.net_pnl AS "latestPnlNetPnl",
            lp.fees_total AS "latestPnlFeesTotal",
            lp.open_qty AS "latestPnlOpenQty",
            lp.open_notional AS "latestPnlOpenNotional",
            lp.fill_count AS "latestPnlFillCount",
            lp.close_count AS "latestPnlCloseCount",
            lp.win_count AS "latestPnlWinCount",
            lp.loss_count AS "latestPnlLossCount",
            lpar.sampled_at AS "latestParamSampledAt",
            lpar.pause_reasons_json AS "latestParamPauseReasonsJson",
            COALESCE(r.updated_at, ars.updated_at, s.updated_at, s.started_at) AS "sortUpdatedAt",
            COALESCE(s.started_at, s.updated_at) AS "sortStartedAt",
            COALESCE(r.net_pnl, lp.net_pnl, 0) AS "sortNetPnl",
            COALESCE(r.realized_pnl, lp.realized_pnl, 0) AS "sortRealizedPnl",
            COALESCE(r.fill_count, lp.fill_count, 0) AS "sortFillCount",
            (
                0.5 * CASE
                    WHEN COALESCE(r.avg_markout_1s_bps, 0) >= 0 THEN 0
                    WHEN COALESCE(r.avg_markout_1s_bps, 0) <= -50 THEN 50
                    ELSE -COALESCE(r.avg_markout_1s_bps, 0)
                END
                + 0.3 * CASE
                    WHEN COALESCE(r.avg_markout_5s_bps, 0) >= 0 THEN 0
                    WHEN COALESCE(r.avg_markout_5s_bps, 0) <= -50 THEN 50
                    ELSE -COALESCE(r.avg_markout_5s_bps, 0)
                END
                + 0.2 * CASE
                    WHEN ABS(COALESCE(r.avg_arrival_slippage_bps, 0)) >= 50 THEN 50
                    ELSE ABS(COALESCE(r.avg_arrival_slippage_bps, 0))
                END
            ) AS "sortToxicityScore"
        FROM strategy_sessions s
        LEFT JOIN strategy_tca_rollups r
            ON r.strategy_session_id = s.id
           AND r.rollup_level = 'ROOT'
           AND r.execution_scope = ${executionScope}
           AND r.ownership_confidence = ${ownershipConfidence}
        LEFT JOIN algo_runtime_sessions ars ON ars.strategy_session_id = s.id
        LEFT JOIN LATERAL (
            SELECT
                p.sampled_at,
                p.realized_pnl,
                p.unrealized_pnl,
                p.net_pnl,
                p.fees_total,
                p.open_qty,
                p.open_notional,
                p.fill_count,
                p.close_count,
                p.win_count,
                p.loss_count
            FROM strategy_session_pnl_samples p
            WHERE p.strategy_session_id = s.id
            ORDER BY p.sampled_at DESC, p.created_at DESC
            LIMIT 1
        ) lp ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                p.sampled_at,
                p.pause_reasons_json
            FROM strategy_session_param_samples p
            WHERE p.strategy_session_id = s.id
            ORDER BY p.sampled_at DESC, p.created_at DESC
            LIMIT 1
        ) lpar ON TRUE
        ${whereSql}
        ORDER BY ${sortColumn} ${sortDirection}, s.id ${sortDirection}
        LIMIT ${query.take}
        OFFSET ${query.skip}
    `;
}

function mapPageRow(row) {
    const rollup = row.rollupStrategySessionId ? {
        strategySessionId: row.rollupStrategySessionId,
        subAccountId: row.rollupSubAccountId,
        strategyType: row.rollupStrategyType,
        rollupLevel: row.rollupLevel,
        executionScope: row.rollupExecutionScope,
        ownershipConfidence: row.rollupOwnershipConfidence,
        qualityByRoleJson: row.qualityByRoleJson,
        fillCount: row.rollupFillCount,
        closeCount: row.rollupCloseCount,
        realizedPnl: row.rollupRealizedPnl,
        unrealizedPnl: row.rollupUnrealizedPnl,
        netPnl: row.rollupNetPnl,
        feesTotal: row.rollupFeesTotal,
        openQty: row.rollupOpenQty,
        openNotional: row.rollupOpenNotional,
        winCount: row.rollupWinCount,
        lossCount: row.rollupLossCount,
        winRate: row.rollupWinRate,
        avgArrivalSlippageBps: row.rollupAvgArrivalSlippageBps,
        avgMarkout1sBps: row.rollupAvgMarkout1sBps,
        avgMarkout5sBps: row.rollupAvgMarkout5sBps,
        avgMarkout30sBps: row.rollupAvgMarkout30sBps,
        totalRepriceCount: row.rollupTotalRepriceCount,
        updatedAt: row.rollupUpdatedAt,
    } : null;

    const runtime = row.runtimeStrategySessionId ? {
        strategySessionId: row.runtimeStrategySessionId,
        subAccountId: row.runtimeSubAccountId,
        strategyType: row.runtimeStrategyType,
        status: row.runtimeStatus,
        resumePolicy: row.runtimeResumePolicy,
        updatedAt: row.runtimeUpdatedAt,
    } : null;

    const latestPnlSample = row.latestPnlSampledAt ? {
        strategySessionId: row.strategySessionId,
        sampledAt: row.latestPnlSampledAt,
        realizedPnl: row.latestPnlRealizedPnl,
        unrealizedPnl: row.latestPnlUnrealizedPnl,
        netPnl: row.latestPnlNetPnl,
        feesTotal: row.latestPnlFeesTotal,
        openQty: row.latestPnlOpenQty,
        openNotional: row.latestPnlOpenNotional,
        fillCount: row.latestPnlFillCount,
        closeCount: row.latestPnlCloseCount,
        winCount: row.latestPnlWinCount,
        lossCount: row.latestPnlLossCount,
    } : null;

    const latestParamSample = row.latestParamSampledAt ? {
        strategySessionId: row.strategySessionId,
        sampledAt: row.latestParamSampledAt,
        pauseReasonsJson: row.latestParamPauseReasonsJson,
    } : null;

    return {
        strategySessionId: row.strategySessionId,
        subAccountId: row.subAccountId,
        strategyType: row.strategyType,
        sessionRole: row.sessionRole,
        symbol: row.symbol,
        side: row.side,
        startedAt: row.startedAt,
        updatedAt: row.sessionUpdatedAt,
        rollup,
        runtime,
        latestPnlSample,
        latestParamSample,
    };
}

export async function fetchStrategySessionPage({
    subAccountId,
    query,
    executionScope = 'SUB_ACCOUNT',
    ownershipConfidence = 'HARD',
}) {
    const whereClauses = buildStrategySessionWhere({ subAccountId, query });
    const whereSql = joinClauses(whereClauses);
    const sortDirection = sortDirectionFor(query.sortDir);
    const sortColumn = sortColumnFor(query.sortBy);

    const countRows = await prisma.$queryRaw(Prisma.sql`
        SELECT COUNT(*) AS "total"
        FROM strategy_sessions s
        LEFT JOIN algo_runtime_sessions ars ON ars.strategy_session_id = s.id
        ${whereSql}
    `);
    const total = Number(countRows[0]?.total || 0);

    let rows;
    try {
        rows = await prisma.$queryRaw(buildStrategySessionPageRowsQuery({
            whereSql,
            sortColumn,
            sortDirection,
            query,
            executionScope,
            ownershipConfidence,
            includeQualityByRoleJson: true,
        }));
    } catch (err) {
        if (!shouldRetryWithoutQualityByRole(err)) throw err;
        rows = await prisma.$queryRaw(buildStrategySessionPageRowsQuery({
            whereSql,
            sortColumn,
            sortDirection,
            query,
            executionScope,
            ownershipConfidence,
            includeQualityByRoleJson: false,
        }));
    }

    const items = rows.map(mapPageRow);
    const strategySessionIds = items.map((row) => row.strategySessionId).filter(Boolean);
    const sparklineBySession = new Map();

    if (strategySessionIds.length) {
        const sparkRows = await prisma.$queryRaw(Prisma.sql`
            SELECT
                ranked.strategy_session_id AS "strategySessionId",
                ranked.sampled_at AS "sampledAt",
                ranked.net_pnl AS "netPnl"
            FROM (
                SELECT
                    p.strategy_session_id,
                    p.sampled_at,
                    p.net_pnl,
                    ROW_NUMBER() OVER (PARTITION BY p.strategy_session_id ORDER BY p.sampled_at DESC) AS rn
                FROM strategy_session_pnl_samples p
                WHERE p.strategy_session_id IN (${inList(strategySessionIds)})
            ) ranked
            WHERE ranked.rn <= 20
            ORDER BY ranked.strategy_session_id ASC, ranked.sampled_at ASC
        `);
        for (const row of sparkRows) {
            const strategySessionId = String(row.strategySessionId || '');
            if (!strategySessionId) continue;
            if (!sparklineBySession.has(strategySessionId)) sparklineBySession.set(strategySessionId, []);
            sparklineBySession.get(strategySessionId).push({
                ts: row.sampledAt,
                value: Number(row.netPnl || 0),
            });
        }
    }

    return {
        total,
        items: items.map((row) => ({
            ...row,
            sparkline: sparklineBySession.get(row.strategySessionId) || [],
        })),
    };
}

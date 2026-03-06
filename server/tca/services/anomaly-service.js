import { Prisma } from '@prisma/client';

import prisma from '../../db/prisma.js';

function toInList(values = []) {
    return Prisma.join(values.map((value) => Prisma.sql`${String(value)}`));
}

function mapCounts(rows = []) {
    const out = new Map();
    for (const row of rows) {
        const strategySessionId = String(row.strategySessionId || '');
        if (!strategySessionId) continue;
        out.set(strategySessionId, {
            unknownRoleCount: Number(row.unknownRoleCount || 0),
            unknownLineageCount: Number(row.unknownLineageCount || 0),
            sessionPnlAnomalyCount: Number(row.sessionPnlAnomalyCount || 0),
        });
    }
    return out;
}

export async function loadRootAnomalyCounts(subAccountId, strategySessionIds = []) {
    if (!strategySessionIds.length) return new Map();
    const inList = toInList(strategySessionIds);
    const rows = await prisma.$queryRaw(Prisma.sql`
        WITH unknown_roles AS (
            SELECT
                root_strategy_session_id AS strategy_session_id,
                SUM(CASE WHEN UPPER(COALESCE(order_role, 'UNKNOWN')) = 'UNKNOWN' THEN 1 ELSE 0 END) AS unknown_role_count
            FROM order_lifecycles
            WHERE sub_account_id = ${subAccountId}
              AND root_strategy_session_id IN (${inList})
            GROUP BY root_strategy_session_id
        ),
        anomaly_counts AS (
            SELECT
                root_strategy_session_id AS strategy_session_id,
                SUM(CASE WHEN anomaly_type = 'LINEAGE' AND COALESCE(status, 'OPEN') <> 'RESOLVED' THEN 1 ELSE 0 END) AS unknown_lineage_count,
                SUM(CASE WHEN anomaly_type = 'SESSION_PNL' AND COALESCE(status, 'OPEN') <> 'RESOLVED' THEN 1 ELSE 0 END) AS session_pnl_anomaly_count
            FROM tca_anomalies
            WHERE sub_account_id = ${subAccountId}
              AND root_strategy_session_id IN (${inList})
            GROUP BY root_strategy_session_id
        )
        SELECT
            roots.strategy_session_id AS "strategySessionId",
            COALESCE(unknown_roles.unknown_role_count, 0) AS "unknownRoleCount",
            COALESCE(anomaly_counts.unknown_lineage_count, 0) AS "unknownLineageCount",
            COALESCE(anomaly_counts.session_pnl_anomaly_count, 0) AS "sessionPnlAnomalyCount"
        FROM (
            SELECT DISTINCT root_strategy_session_id AS strategy_session_id
            FROM order_lifecycles
            WHERE sub_account_id = ${subAccountId}
              AND root_strategy_session_id IN (${inList})
            UNION
            SELECT DISTINCT root_strategy_session_id AS strategy_session_id
            FROM tca_anomalies
            WHERE sub_account_id = ${subAccountId}
              AND root_strategy_session_id IN (${inList})
        ) roots
        LEFT JOIN unknown_roles ON unknown_roles.strategy_session_id = roots.strategy_session_id
        LEFT JOIN anomaly_counts ON anomaly_counts.strategy_session_id = roots.strategy_session_id
    `);
    return mapCounts(rows);
}

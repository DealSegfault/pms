import { Prisma } from '@prisma/client';

import prisma from '../../db/prisma.js';

function nodeKey(nodeType, nodeId) {
    return `${String(nodeType || '').toUpperCase()}:${String(nodeId || '')}`;
}

export async function loadRecursiveLineageGraph({
    subAccountId,
    rootNodeType,
    rootNodeId,
    maxNodes = 5000,
    maxEdges = 10000,
}) {
    const normalizedType = String(rootNodeType || '').toUpperCase();
    const normalizedId = String(rootNodeId || '');
    const rows = await prisma.$queryRaw(Prisma.sql`
        WITH RECURSIVE frontier(node_type, node_id) AS (
            SELECT ${normalizedType} AS node_type, ${normalizedId} AS node_id
            UNION
            SELECT
                CASE
                    WHEN UPPER(e.parent_node_type) = frontier.node_type AND e.parent_node_id = frontier.node_id
                        THEN UPPER(e.child_node_type)
                    ELSE UPPER(e.parent_node_type)
                END AS node_type,
                CASE
                    WHEN UPPER(e.parent_node_type) = frontier.node_type AND e.parent_node_id = frontier.node_id
                        THEN e.child_node_id
                    ELSE e.parent_node_id
                END AS node_id
            FROM algo_lineage_edges e
            JOIN frontier
                ON (
                    (UPPER(e.parent_node_type) = frontier.node_type AND e.parent_node_id = frontier.node_id)
                    OR
                    (UPPER(e.child_node_type) = frontier.node_type AND e.child_node_id = frontier.node_id)
                )
            WHERE e.sub_account_id = ${subAccountId}
        )
        SELECT DISTINCT
            UPPER(e.parent_node_type) AS "parentNodeType",
            e.parent_node_id AS "parentNodeId",
            UPPER(e.child_node_type) AS "childNodeType",
            e.child_node_id AS "childNodeId",
            UPPER(e.relation_type) AS "relationType",
            e.source_event_id AS "sourceEventId",
            e.source_ts AS "sourceTs",
            e.ingested_ts AS "ingestedTs",
            e.created_at AS "createdAt"
        FROM algo_lineage_edges e
        WHERE e.sub_account_id = ${subAccountId}
          AND EXISTS (
              SELECT 1
              FROM frontier f
              WHERE (
                  UPPER(e.parent_node_type) = f.node_type
                  AND e.parent_node_id = f.node_id
              ) OR (
                  UPPER(e.child_node_type) = f.node_type
                  AND e.child_node_id = f.node_id
              )
          )
        ORDER BY e.created_at ASC
        LIMIT ${maxEdges + 1}
    `);

    const nodes = new Map();
    const rootKey = nodeKey(normalizedType, normalizedId);
    nodes.set(rootKey, {
        nodeType: normalizedType,
        nodeId: normalizedId,
    });

    const edges = [];
    let truncated = rows.length > maxEdges;
    for (const row of rows.slice(0, maxEdges)) {
        const parentNodeType = String(row.parentNodeType || '').toUpperCase();
        const parentNodeId = String(row.parentNodeId || '');
        const childNodeType = String(row.childNodeType || '').toUpperCase();
        const childNodeId = String(row.childNodeId || '');
        if (!parentNodeType || !parentNodeId || !childNodeType || !childNodeId) {
            continue;
        }

        const parentKey = nodeKey(parentNodeType, parentNodeId);
        const childKey = nodeKey(childNodeType, childNodeId);
        if (!nodes.has(parentKey) && nodes.size >= maxNodes) {
            truncated = true;
            break;
        }
        if (!nodes.has(childKey) && nodes.size >= maxNodes) {
            truncated = true;
            break;
        }
        if (!nodes.has(parentKey)) {
            nodes.set(parentKey, { nodeType: parentNodeType, nodeId: parentNodeId });
        }
        if (!nodes.has(childKey)) {
            nodes.set(childKey, { nodeType: childNodeType, nodeId: childNodeId });
        }

        edges.push({
            parentNodeType,
            parentNodeId,
            childNodeType,
            childNodeId,
            relationType: String(row.relationType || '').toUpperCase(),
            sourceEventId: row.sourceEventId || null,
            sourceTs: row.sourceTs || null,
            ingestedTs: row.ingestedTs || null,
            createdAt: row.createdAt || null,
        });
    }

    return {
        nodes: Array.from(nodes.values()),
        edges,
        stats: {
            rootNodeType: normalizedType,
            rootNodeId: normalizedId,
            nodeCount: nodes.size,
            edgeCount: edges.length,
            maxNodes,
            maxEdges,
        },
        truncated,
    };
}

function normalizeSymbol(symbol) {
    if (!symbol) return null;
    const raw = String(symbol).toUpperCase().replace(/\//g, '').replace(/:USDT/g, '');
    return raw.endsWith('USDT') ? raw : `${raw}USDT`;
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function buildDateRange(query = {}) {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (!from && !to) return null;

    const range = {};
    if (from) range.gte = from;
    if (to) range.lte = to;
    return range;
}

function clampLimit(value, fallback = 100, max = 500) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function clampPage(value, fallback = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function arrivalSlippageBps(side, decisionMid, avgFillPrice) {
    const benchmark = Number(decisionMid);
    const fill = Number(avgFillPrice);
    if (!(benchmark > 0) || !(fill > 0)) return null;
    return String(side || '').toUpperCase() === 'SELL'
        ? ((benchmark - fill) / benchmark) * 10000
        : ((fill - benchmark) / benchmark) * 10000;
}

function applyScopeFilters(target, query = {}, scopeField = 'executionScope', confidenceField = 'ownershipConfidence') {
    if (query.executionScope) target[scopeField] = String(query.executionScope).toUpperCase();
    if (query.ownershipConfidence) target[confidenceField] = String(query.ownershipConfidence).toUpperCase();
    return target;
}

function average(values = []) {
    const nums = values.filter((value) => Number.isFinite(value));
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function averageMarkoutFromFills(fillFacts = [], horizonMs) {
    const values = [];
    for (const fill of fillFacts || []) {
        for (const markout of fill.markouts || []) {
            if (markout.horizonMs === horizonMs && Number.isFinite(markout.markoutBps)) {
                values.push(markout.markoutBps);
            }
        }
    }
    return average(values);
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export function parseQualityByRole(row) {
    if (row?.qualityByRole && typeof row.qualityByRole === 'object') {
        return row.qualityByRole;
    }
    return safeJsonParse(row?.qualityByRoleJson, {}) || {};
}

const ORDER_ROLES = new Set(['ENTRY', 'ADD', 'UNWIND', 'FLATTEN', 'REPRICE', 'HEDGE', 'UNKNOWN']);

function normalizeOrderRole(role) {
    const value = String(role || '').toUpperCase();
    return ORDER_ROLES.has(value) ? value : 'UNKNOWN';
}

function inferStrategyType(strategySessionId, ...candidates) {
    const sessionId = String(strategySessionId || '').toLowerCase();
    if (sessionId.startsWith('scalper_') || sessionId.startsWith('scalper-')) return 'SCALPER';
    if (sessionId.startsWith('chase_') || sessionId.startsWith('chase-')) return 'CHASE';
    if (sessionId.startsWith('twap_') || sessionId.startsWith('twap-')) return 'TWAP';
    if (sessionId.startsWith('trail_stop_') || sessionId.startsWith('trail-stop_') || sessionId.startsWith('trailstop_')) return 'TRAIL_STOP';
    for (const candidate of candidates) {
        const value = String(candidate || '').trim().toUpperCase();
        if (value) return value;
    }
    return null;
}

function clip(value, min, max) {
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, value));
}

function toxicityScore(avgArrivalSlippageBps, avgMarkout1sBps, avgMarkout5sBps) {
    const mark1 = clip(-Number(avgMarkout1sBps), 0, 50) ?? 0;
    const mark5 = clip(-Number(avgMarkout5sBps), 0, 50) ?? 0;
    const arrival = clip(Math.abs(Number(avgArrivalSlippageBps)), 0, 50) ?? 0;
    return (0.5 * mark1) + (0.3 * mark5) + (0.2 * arrival);
}

function averageFromTotals(total, count) {
    if (!Number.isFinite(total) || !Number.isFinite(count) || count <= 0) return null;
    return total / count;
}

function metricByRole(qualityByRole, field) {
    const out = {};
    for (const [role, metrics] of Object.entries(qualityByRole || {})) {
        out[role] = metrics?.[field] ?? null;
    }
    return out;
}

function nodeKey(nodeType, nodeId) {
    return `${String(nodeType || '').toUpperCase()}:${String(nodeId || '')}`;
}

export async function buildRecursiveLineageGraph({
    rootNodeType,
    rootNodeId,
    maxNodes = 5000,
    maxEdges = 10000,
    fetchEdgesForNodes,
}) {
    const normalizedType = String(rootNodeType || '').toUpperCase();
    const normalizedId = String(rootNodeId || '');
    const rootKey = nodeKey(normalizedType, normalizedId);

    const seenNodes = new Map();
    seenNodes.set(rootKey, { nodeType: normalizedType, nodeId: normalizedId });
    const seenEdges = new Set();
    const edges = [];
    let frontier = [{ nodeType: normalizedType, nodeId: normalizedId }];
    let truncated = false;

    while (frontier.length && !truncated) {
        const batch = await fetchEdgesForNodes(frontier);
        if (!Array.isArray(batch) || !batch.length) break;

        const next = [];
        for (const edge of batch) {
            const parentType = String(edge.parentNodeType || '').toUpperCase();
            const parentId = String(edge.parentNodeId || '');
            const childType = String(edge.childNodeType || '').toUpperCase();
            const childId = String(edge.childNodeId || '');
            const relationType = String(edge.relationType || '').toUpperCase();
            if (!parentType || !parentId || !childType || !childId || !relationType) continue;

            const parentKey = nodeKey(parentType, parentId);
            const childKey = nodeKey(childType, childId);
            const edgeKey = `${parentKey}|${relationType}|${childKey}`;
            if (!seenEdges.has(edgeKey)) {
                if (edges.length >= maxEdges) {
                    truncated = true;
                    break;
                }
                seenEdges.add(edgeKey);
                edges.push({
                    parentNodeType: parentType,
                    parentNodeId: parentId,
                    childNodeType: childType,
                    childNodeId: childId,
                    relationType,
                    sourceEventId: edge.sourceEventId || null,
                    sourceTs: edge.sourceTs || null,
                    ingestedTs: edge.ingestedTs || null,
                    createdAt: edge.createdAt || null,
                });
            }

            if (!seenNodes.has(parentKey)) {
                if (seenNodes.size >= maxNodes) {
                    truncated = true;
                    break;
                }
                seenNodes.set(parentKey, { nodeType: parentType, nodeId: parentId });
                next.push({ nodeType: parentType, nodeId: parentId });
            }
            if (!seenNodes.has(childKey)) {
                if (seenNodes.size >= maxNodes) {
                    truncated = true;
                    break;
                }
                seenNodes.set(childKey, { nodeType: childType, nodeId: childId });
                next.push({ nodeType: childType, nodeId: childId });
            }
        }

        frontier = next;
    }

    return {
        nodes: Array.from(seenNodes.values()),
        edges,
        stats: {
            rootNodeType: normalizedType,
            rootNodeId: normalizedId,
            nodeCount: seenNodes.size,
            edgeCount: edges.length,
            maxNodes,
            maxEdges,
        },
        truncated,
    };
}

export function computeRoleQualityFromLifecycles(lifecycles = []) {
    const buckets = new Map();
    for (const row of lifecycles) {
        const role = normalizeOrderRole(row.orderRole);
        const bucket = buckets.get(role) || {
            lifecycleCount: 0,
            fillCount: 0,
            arrivalTotal: 0,
            arrivalCount: 0,
            mark1Total: 0,
            mark1Count: 0,
            mark5Total: 0,
            mark5Count: 0,
            mark30Total: 0,
            mark30Count: 0,
        };
        bucket.lifecycleCount += 1;
        bucket.fillCount += Array.isArray(row.fillFacts) ? row.fillFacts.length : 0;

        const arrival = arrivalSlippageBps(row.side, row.decisionMid, row.avgFillPrice);
        if (Number.isFinite(arrival)) {
            bucket.arrivalTotal += arrival;
            bucket.arrivalCount += 1;
        }

        for (const fill of row.fillFacts || []) {
            for (const markout of fill.markouts || []) {
                if (!Number.isFinite(markout.markoutBps)) continue;
                if (markout.horizonMs === 1000) {
                    bucket.mark1Total += markout.markoutBps;
                    bucket.mark1Count += 1;
                } else if (markout.horizonMs === 5000) {
                    bucket.mark5Total += markout.markoutBps;
                    bucket.mark5Count += 1;
                } else if (markout.horizonMs === 30000) {
                    bucket.mark30Total += markout.markoutBps;
                    bucket.mark30Count += 1;
                }
            }
        }
        buckets.set(role, bucket);
    }

    const byRole = {};
    for (const [role, bucket] of buckets.entries()) {
        const avgArrivalSlippageBps = averageFromTotals(bucket.arrivalTotal, bucket.arrivalCount);
        const avgMarkout1sBps = averageFromTotals(bucket.mark1Total, bucket.mark1Count);
        const avgMarkout5sBps = averageFromTotals(bucket.mark5Total, bucket.mark5Count);
        const avgMarkout30sBps = averageFromTotals(bucket.mark30Total, bucket.mark30Count);
        byRole[role] = {
            lifecycleCount: bucket.lifecycleCount,
            fillCount: bucket.fillCount,
            avgArrivalSlippageBps,
            avgMarkout1sBps,
            avgMarkout5sBps,
            avgMarkout30sBps,
            toxicityScore: toxicityScore(avgArrivalSlippageBps, avgMarkout1sBps, avgMarkout5sBps),
        };
    }
    return byRole;
}

export function buildLifecycleQuery(subAccountId, query = {}) {
    const where = applyScopeFilters({ subAccountId }, query);
    if (query.finalStatus) where.finalStatus = String(query.finalStatus).toUpperCase();
    if (query.symbol) where.symbol = normalizeSymbol(query.symbol);
    if (query.strategyType) where.strategyType = String(query.strategyType).toUpperCase();
    if (query.clientOrderId) where.clientOrderId = String(query.clientOrderId);
    const createdAt = buildDateRange(query);
    if (createdAt) where.createdAt = createdAt;
    return {
        where,
        take: clampLimit(query.limit, 100),
    };
}

const LIFECYCLE_SORT_FIELDS = new Set([
    'createdAt',
    'updatedAt',
    'intentTs',
    'ackTs',
    'doneTs',
    'firstFillTs',
    'finalStatus',
    'filledQty',
    'avgFillPrice',
    'repriceCount',
]);

export function buildLifecyclePageQuery(subAccountId, query = {}) {
    const base = buildLifecycleQuery(subAccountId, query);
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const pageSize = clampLimit(query.pageSize, 25, 100);
    const sortByRaw = String(query.sortBy || 'updatedAt');
    const sortBy = LIFECYCLE_SORT_FIELDS.has(sortByRaw) ? sortByRaw : 'updatedAt';
    const sortDir = String(query.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    return {
        where: base.where,
        page,
        pageSize,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { [sortBy]: sortDir },
        sortBy,
        sortDir,
    };
}

export function buildMarkoutQuery(subAccountId, query = {}) {
    const fillFact = applyScopeFilters({ subAccountId }, query);
    if (query.symbol) fillFact.symbol = normalizeSymbol(query.symbol);
    if (query.originType) fillFact.originType = String(query.originType).toUpperCase();
    const fillTs = buildDateRange(query);
    if (fillTs) fillFact.fillTs = fillTs;
    const where = { fillFact };
    if (query.horizonMs) where.horizonMs = Number.parseInt(query.horizonMs, 10);
    return {
        where,
        take: clampLimit(query.limit, 100),
    };
}

export function buildStrategySessionQuery(subAccountId, query = {}) {
    const where = { subAccountId };
    if (query.strategyType) {
        const strategyType = String(query.strategyType).toUpperCase();
        if (strategyType === 'SCALPER') {
            where.OR = [
                { strategyType: 'SCALPER' },
                { id: { startsWith: 'scalper_' } },
                { id: { startsWith: 'scalper-' } },
            ];
        } else {
            where.strategyType = strategyType;
        }
    }
    if (query.sessionRole) where.sessionRole = String(query.sessionRole).toUpperCase();
    if (query.symbol) where.symbol = normalizeSymbol(query.symbol);
    const startedAt = buildDateRange(query);
    if (startedAt) where.startedAt = startedAt;
    return {
        where,
        take: clampLimit(query.limit, 100),
    };
}

const STRATEGY_SESSION_SORT_FIELDS = new Set([
    'updatedAt',
    'startedAt',
    'netPnl',
    'realizedPnl',
    'toxicityScore',
    'fillCount',
]);

export function buildStrategySessionPageQuery(subAccountId, query = {}) {
    const where = buildStrategySessionQuery(subAccountId, {
        ...query,
        strategyType: query.strategyType || 'SCALPER',
        sessionRole: query.sessionRole || 'ROOT',
    }).where;
    const page = clampPage(query.page, 1);
    const pageSize = clampLimit(query.pageSize, 25, 100);
    const sortByRaw = String(query.sortBy || 'updatedAt');
    const sortBy = STRATEGY_SESSION_SORT_FIELDS.has(sortByRaw) ? sortByRaw : 'updatedAt';
    const sortDir = String(query.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const status = query.status ? String(query.status).toUpperCase() : null;
    return {
        where,
        page,
        pageSize,
        skip: (page - 1) * pageSize,
        take: pageSize,
        sortBy,
        sortDir,
        status,
    };
}

export function buildRollupQuery(subAccountId, query = {}) {
    const where = applyScopeFilters({ subAccountId }, query);
    const updatedAt = buildDateRange(query);
    if (updatedAt) where.updatedAt = updatedAt;
    return { where };
}

export function buildStrategyRollupQuery(subAccountId, query = {}) {
    const where = applyScopeFilters({ subAccountId }, query);
    if (query.strategyType) where.strategyType = String(query.strategyType).toUpperCase();
    if (query.rollupLevel) where.rollupLevel = String(query.rollupLevel).toUpperCase();
    const updatedAt = buildDateRange(query);
    if (updatedAt) where.updatedAt = updatedAt;
    return { where };
}

export function buildStrategyTimeseriesQuery(query = {}) {
    const from = parseDate(query.from);
    const to = parseDate(query.to) || new Date();
    const series = new Set(
        String(query.series || 'pnl,params,quality,exposure')
            .split(',')
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean),
    );
    const rangeMs = from && to ? Math.max(0, to.getTime() - from.getTime()) : 0;
    let bucketMs = Number.parseInt(query.bucketMs, 10);
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
        if (!rangeMs || rangeMs <= 6 * 60 * 60 * 1000) bucketMs = 5000;
        else if (rangeMs <= 7 * 24 * 60 * 60 * 1000) bucketMs = 30000;
        else bucketMs = 5 * 60 * 1000;
    }
    const maxPoints = Math.min(500, Math.max(10, Number.parseInt(query.maxPoints, 10) || 300));
    const effectiveBucketMs = rangeMs > 0
        ? Math.max(bucketMs, Math.ceil(rangeMs / maxPoints))
        : bucketMs;
    const eventsPage = Math.max(1, Number.parseInt(query.eventsPage, 10) || 1);
    const eventsPageSize = Math.min(50, Math.max(5, Number.parseInt(query.eventsPageSize, 10) || 12));
    return {
        from,
        to,
        series,
        requestedBucketMs: bucketMs,
        bucketMs: effectiveBucketMs,
        maxPoints,
        eventsPage,
        eventsPageSize,
        eventsSkip: (eventsPage - 1) * eventsPageSize,
    };
}

export function bucketTimeSeries(points = [], bucketMs = 5000, reducer = null) {
    if (!Array.isArray(points) || !points.length) return [];
    const buckets = new Map();
    for (const point of points) {
        const rawTs = point?.ts ? new Date(point.ts) : null;
        if (!rawTs || Number.isNaN(rawTs.getTime())) continue;
        const bucket = rawTs.getTime() - (rawTs.getTime() % bucketMs);
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket).push(point);
    }
    const sorted = Array.from(buckets.entries()).sort((left, right) => left[0] - right[0]);
    if (typeof reducer === 'function') {
        return sorted.map(([bucket, items]) => reducer(bucket, items)).filter(Boolean);
    }
    return sorted.map(([bucket, items]) => items[items.length - 1]);
}

export function serializeLifecycleSummary(row) {
    const orderRole = normalizeOrderRole(row.orderRole);
    const arrival = arrivalSlippageBps(row.side, row.decisionMid, row.avgFillPrice);
    const avgMarkout1sBps = averageMarkoutFromFills(row.fillFacts, 1000);
    const avgMarkout5sBps = averageMarkoutFromFills(row.fillFacts, 5000);
    const avgMarkout30sBps = averageMarkoutFromFills(row.fillFacts, 30000);
    const lineageStatus = orderRole === 'UNKNOWN'
        ? 'UNKNOWN'
        : (row.strategySessionId ? 'COMPLETE' : 'PARTIAL');
    return {
        lifecycleId: row.id,
        subAccountId: row.subAccountId,
        executionScope: row.executionScope,
        ownershipConfidence: row.ownershipConfidence,
        originPath: row.originPath,
        strategyType: row.strategyType,
        strategySessionId: row.strategySessionId,
        parentId: row.parentId,
        clientOrderId: row.clientOrderId,
        exchangeOrderId: row.exchangeOrderId,
        symbol: row.symbol,
        side: row.side,
        orderType: row.orderType,
        orderRole,
        reduceOnly: row.reduceOnly,
        requestedQty: row.requestedQty,
        limitPrice: row.limitPrice,
        decisionBid: row.decisionBid,
        decisionAsk: row.decisionAsk,
        decisionMid: row.decisionMid,
        decisionSpreadBps: row.decisionSpreadBps,
        intentTs: row.intentTs,
        ackTs: row.ackTs,
        firstFillTs: row.firstFillTs,
        doneTs: row.doneTs,
        finalStatus: row.finalStatus,
        filledQty: row.filledQty,
        avgFillPrice: row.avgFillPrice,
        repriceCount: row.repriceCount,
        reconciliationStatus: row.reconciliationStatus,
        reconciliationReason: row.reconciliationReason,
        eventCount: row._count?.events ?? 0,
        fillCount: row._count?.fillFacts ?? 0,
        arrivalSlippageBps: arrival,
        avgMarkout1sBps,
        avgMarkout5sBps,
        avgMarkout30sBps,
        lineageStatus,
        ackLatencyMs: row.intentTs && row.ackTs ? (row.ackTs.getTime() - row.intentTs.getTime()) : null,
        workingTimeMs: row.ackTs && row.doneTs ? (row.doneTs.getTime() - row.ackTs.getTime()) : null,
        toxicityScore: Number.isFinite(row.toxicityScore)
            ? row.toxicityScore
            : toxicityScore(arrival, avgMarkout1sBps, avgMarkout5sBps),
        updatedAt: row.updatedAt,
    };
}

export function serializeFillMarkout(row) {
    return {
        fillFactId: row.fillFactId,
        horizonMs: row.horizonMs,
        measuredTs: row.measuredTs,
        midPrice: row.midPrice,
        markPrice: row.markPrice,
        markoutBps: row.markoutBps,
        subAccountId: row.fillFact?.subAccountId || null,
        executionScope: row.fillFact?.executionScope || null,
        ownershipConfidence: row.fillFact?.ownershipConfidence || null,
        symbol: row.fillFact?.symbol || null,
        side: row.fillFact?.side || null,
        fillTs: row.fillFact?.fillTs || null,
        fillQty: row.fillFact?.fillQty || null,
        fillPrice: row.fillFact?.fillPrice || null,
        fillMid: row.fillFact?.fillMid || null,
        lifecycleId: row.fillFact?.lifecycleId || null,
        strategySessionId: row.fillFact?.lifecycle?.strategySessionId || null,
        originPath: row.fillFact?.lifecycle?.originPath || null,
    };
}

export function serializeStrategySession(row) {
    const strategyType = inferStrategyType(row.id, row.strategyType, row.origin);
    return {
        strategySessionId: row.id,
        subAccountId: row.subAccountId,
        origin: row.origin,
        strategyType,
        parentStrategySessionId: row.parentStrategySessionId || null,
        rootStrategySessionId: row.rootStrategySessionId || null,
        sessionRole: row.sessionRole || 'STANDALONE',
        symbol: row.symbol,
        side: row.side,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        lifecycleCount: row._count?.lifecycles ?? 0,
        rollupCount: row._count?.rollups ?? 0,
        updatedAt: row.updatedAt,
    };
}

export function serializeStrategySessionPageItem(row) {
    const rollup = row.rollup || null;
    const runtime = row.runtime || null;
    const latestPnlSample = row.latestPnlSample || null;
    const latestParamSample = row.latestParamSample || null;
    const strategyType = inferStrategyType(row.strategySessionId, rollup?.strategyType, runtime?.strategyType, row.strategyType);
    return {
        strategySessionId: row.strategySessionId,
        subAccountId: row.subAccountId,
        strategyType,
        sessionRole: row.sessionRole || 'ROOT',
        symbol: row.symbol,
        side: row.side,
        startedAt: row.startedAt || null,
        updatedAt: row.updatedAt || rollup?.updatedAt || runtime?.updatedAt || null,
        runtimeStatus: runtime?.status || null,
        resumePolicy: runtime?.resumePolicy || null,
        realizedPnl: rollup?.realizedPnl ?? latestPnlSample?.realizedPnl ?? 0,
        unrealizedPnl: rollup?.unrealizedPnl ?? latestPnlSample?.unrealizedPnl ?? 0,
        netPnl: rollup?.netPnl ?? latestPnlSample?.netPnl ?? 0,
        feesTotal: rollup?.feesTotal ?? latestPnlSample?.feesTotal ?? 0,
        openQty: rollup?.openQty ?? latestPnlSample?.openQty ?? 0,
        openNotional: rollup?.openNotional ?? latestPnlSample?.openNotional ?? 0,
        fillCount: rollup?.fillCount ?? latestPnlSample?.fillCount ?? 0,
        closeCount: rollup?.closeCount ?? latestPnlSample?.closeCount ?? 0,
        winCount: rollup?.winCount ?? latestPnlSample?.winCount ?? 0,
        lossCount: rollup?.lossCount ?? latestPnlSample?.lossCount ?? 0,
        winRate: rollup?.winRate ?? null,
        toxicityScore: rollup?.toxicityScore ?? toxicityScore(
            rollup?.avgArrivalSlippageBps,
            rollup?.avgMarkout1sBps,
            rollup?.avgMarkout5sBps,
        ),
        pauseReasons: safeJsonParse(latestParamSample?.pauseReasonsJson) || {},
        hasAnomaly: !!row.hasAnomaly,
        anomalyCount: Number(row.anomalyCount || 0),
        sparkline: row.sparkline || [],
    };
}

export function serializeSubAccountRollup(row) {
    const qualityByRole = parseQualityByRole(row);
    return {
        subAccountId: row.subAccountId,
        executionScope: row.executionScope,
        ownershipConfidence: row.ownershipConfidence,
        orderCount: row.orderCount,
        terminalOrderCount: row.terminalOrderCount,
        fillCount: row.fillCount,
        cancelCount: row.cancelCount,
        rejectCount: row.rejectCount,
        totalRequestedQty: row.totalRequestedQty,
        totalFilledQty: row.totalFilledQty,
        totalFillNotional: row.totalFillNotional,
        fillRatio: row.fillRatio,
        cancelToFillRatio: row.cancelToFillRatio,
        avgArrivalSlippageBps: row.avgArrivalSlippageBps,
        avgAckLatencyMs: row.avgAckLatencyMs,
        avgWorkingTimeMs: row.avgWorkingTimeMs,
        avgMarkout1sBps: row.avgMarkout1sBps,
        avgMarkout5sBps: row.avgMarkout5sBps,
        avgMarkout30sBps: row.avgMarkout30sBps,
        qualityByRole,
        avgArrivalSlippageBpsByRole: metricByRole(qualityByRole, 'avgArrivalSlippageBps'),
        avgMarkout1sBpsByRole: metricByRole(qualityByRole, 'avgMarkout1sBps'),
        avgMarkout5sBpsByRole: metricByRole(qualityByRole, 'avgMarkout5sBps'),
        avgMarkout30sBpsByRole: metricByRole(qualityByRole, 'avgMarkout30sBps'),
        realizedPnl: row.realizedPnl ?? 0,
        unrealizedPnl: row.unrealizedPnl ?? 0,
        netPnl: row.netPnl ?? 0,
        feesTotal: row.feesTotal ?? 0,
        lastSampledAt: row.lastSampledAt ?? null,
        toxicityScore: toxicityScore(row.avgArrivalSlippageBps, row.avgMarkout1sBps, row.avgMarkout5sBps),
        totalRepriceCount: row.totalRepriceCount,
        updatedAt: row.updatedAt,
    };
}

export function serializeStrategyRollup(row) {
    const qualityByRole = parseQualityByRole(row);
    return {
        strategySessionId: row.strategySessionId,
        subAccountId: row.subAccountId,
        strategyType: inferStrategyType(row.strategySessionId, row.strategyType),
        rollupLevel: row.rollupLevel || 'SESSION',
        executionScope: row.executionScope,
        ownershipConfidence: row.ownershipConfidence,
        orderCount: row.orderCount,
        terminalOrderCount: row.terminalOrderCount,
        fillCount: row.fillCount,
        cancelCount: row.cancelCount,
        rejectCount: row.rejectCount,
        totalRequestedQty: row.totalRequestedQty,
        totalFilledQty: row.totalFilledQty,
        totalFillNotional: row.totalFillNotional,
        fillRatio: row.fillRatio,
        cancelToFillRatio: row.cancelToFillRatio,
        avgArrivalSlippageBps: row.avgArrivalSlippageBps,
        avgAckLatencyMs: row.avgAckLatencyMs,
        avgWorkingTimeMs: row.avgWorkingTimeMs,
        avgMarkout1sBps: row.avgMarkout1sBps,
        avgMarkout5sBps: row.avgMarkout5sBps,
        avgMarkout30sBps: row.avgMarkout30sBps,
        qualityByRole,
        avgArrivalSlippageBpsByRole: metricByRole(qualityByRole, 'avgArrivalSlippageBps'),
        avgMarkout1sBpsByRole: metricByRole(qualityByRole, 'avgMarkout1sBps'),
        avgMarkout5sBpsByRole: metricByRole(qualityByRole, 'avgMarkout5sBps'),
        avgMarkout30sBpsByRole: metricByRole(qualityByRole, 'avgMarkout30sBps'),
        realizedPnl: row.realizedPnl ?? 0,
        unrealizedPnl: row.unrealizedPnl ?? 0,
        netPnl: row.netPnl ?? 0,
        feesTotal: row.feesTotal ?? 0,
        openQty: row.openQty ?? 0,
        openNotional: row.openNotional ?? 0,
        closeCount: row.closeCount ?? 0,
        winCount: row.winCount ?? 0,
        lossCount: row.lossCount ?? 0,
        winRate: row.winRate ?? null,
        maxDrawdownPnl: row.maxDrawdownPnl ?? null,
        maxRunupPnl: row.maxRunupPnl ?? null,
        lastSampledAt: row.lastSampledAt ?? null,
        toxicityScore: toxicityScore(row.avgArrivalSlippageBps, row.avgMarkout1sBps, row.avgMarkout5sBps),
        totalRepriceCount: row.totalRepriceCount,
        updatedAt: row.updatedAt,
    };
}

export function serializeStrategySessionDetail(payload = {}) {
    const strategySession = payload.strategySession || null;
    const rollup = payload.rollup || null;
    const runtime = payload.runtime || null;
    const latestPnlSample = payload.latestPnlSample || null;
    const latestParamSample = payload.latestParamSample || null;
    const qualityByRole = payload.qualityByRole || parseQualityByRole(rollup) || {};
    return {
        strategySession: strategySession ? serializeStrategySession(strategySession) : null,
        rollup: rollup ? serializeStrategyRollup(rollup) : null,
        qualityByRole,
        runtime: runtime ? {
            strategySessionId: runtime.strategySessionId,
            subAccountId: runtime.subAccountId,
            strategyType: runtime.strategyType,
            status: runtime.status,
            resumePolicy: runtime.resumePolicy,
            startedAt: runtime.startedAt,
            stoppedAt: runtime.stoppedAt,
            lastHeartbeatAt: runtime.lastHeartbeatAt,
            latestCheckpointId: runtime.latestCheckpointId,
            initialConfig: safeJsonParse(runtime.initialConfigJson),
            currentConfig: safeJsonParse(runtime.currentConfigJson),
            updatedAt: runtime.updatedAt,
        } : null,
        latestPnlSample: latestPnlSample ? {
            sampledAt: latestPnlSample.sampledAt,
            markPrice: latestPnlSample.markPrice,
            realizedPnl: latestPnlSample.realizedPnl,
            unrealizedPnl: latestPnlSample.unrealizedPnl,
            netPnl: latestPnlSample.netPnl,
            feesTotal: latestPnlSample.feesTotal,
            openQty: latestPnlSample.openQty,
            openNotional: latestPnlSample.openNotional,
            fillCount: latestPnlSample.fillCount,
            closeCount: latestPnlSample.closeCount,
            winCount: latestPnlSample.winCount,
            lossCount: latestPnlSample.lossCount,
        } : null,
        latestParamSample: latestParamSample ? {
            sampledAt: latestParamSample.sampledAt,
            sampleReason: latestParamSample.sampleReason,
            status: latestParamSample.status,
            startSide: latestParamSample.startSide,
            neutralMode: latestParamSample.neutralMode,
            allowLoss: latestParamSample.allowLoss,
            reduceOnlyArmed: latestParamSample.reduceOnlyArmed,
            leverage: latestParamSample.leverage,
            childCount: latestParamSample.childCount,
            skew: latestParamSample.skew,
            longOffsetPct: latestParamSample.longOffsetPct,
            shortOffsetPct: latestParamSample.shortOffsetPct,
            longSizeUsd: latestParamSample.longSizeUsd,
            shortSizeUsd: latestParamSample.shortSizeUsd,
            longMaxPrice: latestParamSample.longMaxPrice,
            shortMinPrice: latestParamSample.shortMinPrice,
            minFillSpreadPct: latestParamSample.minFillSpreadPct,
            minRefillDelayMs: latestParamSample.minRefillDelayMs,
            maxLossPerCloseBps: latestParamSample.maxLossPerCloseBps,
            maxFillsPerMinute: latestParamSample.maxFillsPerMinute,
            pnlFeedbackMode: latestParamSample.pnlFeedbackMode,
            lastKnownPrice: latestParamSample.lastKnownPrice,
            totalFillCount: latestParamSample.totalFillCount,
            pauseReasons: safeJsonParse(latestParamSample.pauseReasonsJson) || {},
            longActiveSlots: latestParamSample.longActiveSlots,
            shortActiveSlots: latestParamSample.shortActiveSlots,
            longPausedSlots: latestParamSample.longPausedSlots,
            shortPausedSlots: latestParamSample.shortPausedSlots,
            longRetryingSlots: latestParamSample.longRetryingSlots,
            shortRetryingSlots: latestParamSample.shortRetryingSlots,
        } : null,
        anomalyCounts: payload.anomalyCounts || {
            unknownRoleCount: 0,
            unknownLineageCount: 0,
            sessionPnlAnomalyCount: 0,
        },
        lineageGraph: payload.lineageGraph || null,
    };
}

export function serializeStrategyLotLedger(payload = {}) {
    return {
        strategySessionId: payload.strategySessionId || null,
        openLots: (payload.openLots || []).map((row) => ({
            lotId: row.id,
            subAccountId: row.subAccountId,
            rootStrategySessionId: row.rootStrategySessionId,
            sourceStrategySessionId: row.sourceStrategySessionId,
            symbol: row.symbol,
            positionSide: row.positionSide,
            sourceLifecycleId: row.sourceLifecycleId,
            sourceFillFactId: row.sourceFillFactId,
            openedTs: row.openedTs,
            openQty: row.openQty,
            remainingQty: row.remainingQty,
            openPrice: row.openPrice,
            openFee: row.openFee,
            status: row.status,
            closedTs: row.closedTs,
        })),
        realizations: (payload.realizations || []).map((row) => ({
            realizationId: row.id,
            lotId: row.lotId,
            subAccountId: row.subAccountId,
            rootStrategySessionId: row.rootStrategySessionId,
            sourceStrategySessionId: row.sourceStrategySessionId,
            closeLifecycleId: row.closeLifecycleId,
            closeFillFactId: row.closeFillFactId,
            realizedTs: row.realizedTs,
            allocatedQty: row.allocatedQty,
            openPrice: row.openPrice,
            closePrice: row.closePrice,
            grossRealizedPnl: row.grossRealizedPnl,
            openFeeAllocated: row.openFeeAllocated,
            closeFeeAllocated: row.closeFeeAllocated,
            netRealizedPnl: row.netRealizedPnl,
        })),
        anomalies: payload.anomalies || [],
    };
}

export function serializeLifecycleDetail(row, options = {}) {
    const fills = (row.fillFacts || []).map((fill) => ({
        fillFactId: fill.id,
        lifecycleId: fill.lifecycleId,
        subAccountId: fill.subAccountId,
        sourceEventId: fill.sourceEventId,
        executionScope: fill.executionScope,
        ownershipConfidence: fill.ownershipConfidence,
        symbol: fill.symbol,
        side: fill.side,
        fillTs: fill.fillTs,
        fillQty: fill.fillQty,
        fillPrice: fill.fillPrice,
        fillBid: fill.fillBid,
        fillAsk: fill.fillAsk,
        fillMid: fill.fillMid,
        fillSpreadBps: fill.fillSpreadBps,
        sampledAt: fill.sampledAt,
        fee: fill.fee,
        makerTaker: fill.makerTaker,
        originType: fill.originType,
        createdAt: fill.createdAt,
        markouts: (fill.markouts || [])
            .slice()
            .sort((left, right) => left.horizonMs - right.horizonMs)
            .map((markout) => ({
                fillFactId: markout.fillFactId,
                horizonMs: markout.horizonMs,
                measuredTs: markout.measuredTs,
                midPrice: markout.midPrice,
                markPrice: markout.markPrice,
                markoutBps: markout.markoutBps,
                createdAt: markout.createdAt,
            })),
    }));

    const avgMarkout1sBps = average(
        fills.map((fill) => fill.markouts.find((markout) => markout.horizonMs === 1000)?.markoutBps),
    );
    const avgMarkout5sBps = average(
        fills.map((fill) => fill.markouts.find((markout) => markout.horizonMs === 5000)?.markoutBps),
    );
    const avgMarkout30sBps = average(
        fills.map((fill) => fill.markouts.find((markout) => markout.horizonMs === 30000)?.markoutBps),
    );

    const orderRole = normalizeOrderRole(row.orderRole);
    const qualityByRole = {
        [orderRole]: {
            lifecycleCount: 1,
            fillCount: fills.length,
            avgArrivalSlippageBps: arrivalSlippageBps(row.side, row.decisionMid, row.avgFillPrice),
            avgMarkout1sBps,
            avgMarkout5sBps,
            avgMarkout30sBps,
            toxicityScore: toxicityScore(
                arrivalSlippageBps(row.side, row.decisionMid, row.avgFillPrice),
                avgMarkout1sBps,
                avgMarkout5sBps,
            ),
        },
    };
    const anomalyEvents = (row.events || [])
        .filter((event) => event.eventType === 'TCA_LINEAGE_ANOMALY')
        .map((event) => ({
            streamEventId: event.streamEventId,
            sourceTs: event.sourceTs,
            payload: safeJsonParse(event.payloadJson),
        }));

    return {
        ...serializeLifecycleSummary({
            ...row,
            _count: {
                events: row.events?.length || 0,
                fillFacts: row.fillFacts?.length || 0,
            },
        }),
        strategySession: row.strategySession ? {
            strategySessionId: row.strategySession.id,
            subAccountId: row.strategySession.subAccountId,
            origin: row.strategySession.origin,
            strategyType: row.strategySession.strategyType,
            symbol: row.strategySession.symbol,
            side: row.strategySession.side,
            startedAt: row.strategySession.startedAt,
            endedAt: row.strategySession.endedAt,
            lifecycleCount: row.strategySession._count?.lifecycles ?? 0,
            rollupCount: row.strategySession._count?.rollups ?? 0,
            updatedAt: row.strategySession.updatedAt,
        } : null,
        fills,
        events: (row.events || []).map((event) => ({
            lifecycleEventId: event.id,
            streamEventId: event.streamEventId,
            eventType: event.eventType,
            sourceTs: event.sourceTs,
            ingestedTs: event.ingestedTs,
            createdAt: event.createdAt,
            payload: safeJsonParse(event.payloadJson),
        })),
        markoutSummary: {
            avgMarkout1sBps,
            avgMarkout5sBps,
            avgMarkout30sBps,
        },
        qualityByRole,
        toxicityScore: qualityByRole[orderRole].toxicityScore,
        lineageGraph: options.lineageGraph || null,
        lineageAnomalies: anomalyEvents,
    };
}

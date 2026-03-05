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

function safeJsonParse(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function buildLifecycleQuery(subAccountId, query = {}) {
    const where = applyScopeFilters({ subAccountId }, query);
    if (query.finalStatus) where.finalStatus = String(query.finalStatus).toUpperCase();
    if (query.symbol) where.symbol = normalizeSymbol(query.symbol);
    if (query.strategyType) where.strategyType = String(query.strategyType).toUpperCase();
    const createdAt = buildDateRange(query);
    if (createdAt) where.createdAt = createdAt;
    return {
        where,
        take: clampLimit(query.limit, 100),
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
    if (query.strategyType) where.strategyType = String(query.strategyType).toUpperCase();
    if (query.symbol) where.symbol = normalizeSymbol(query.symbol);
    const startedAt = buildDateRange(query);
    if (startedAt) where.startedAt = startedAt;
    return {
        where,
        take: clampLimit(query.limit, 100),
    };
}

export function buildRollupQuery(subAccountId, query = {}) {
    return {
        where: applyScopeFilters({ subAccountId }, query),
    };
}

export function buildStrategyRollupQuery(subAccountId, query = {}) {
    const where = applyScopeFilters({ subAccountId }, query);
    if (query.strategyType) where.strategyType = String(query.strategyType).toUpperCase();
    return { where };
}

export function serializeLifecycleSummary(row) {
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
        arrivalSlippageBps: arrivalSlippageBps(row.side, row.decisionMid, row.avgFillPrice),
        ackLatencyMs: row.intentTs && row.ackTs ? (row.ackTs.getTime() - row.intentTs.getTime()) : null,
        workingTimeMs: row.ackTs && row.doneTs ? (row.doneTs.getTime() - row.ackTs.getTime()) : null,
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
    return {
        strategySessionId: row.id,
        subAccountId: row.subAccountId,
        origin: row.origin,
        strategyType: row.strategyType,
        symbol: row.symbol,
        side: row.side,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        lifecycleCount: row._count?.lifecycles ?? 0,
        rollupCount: row._count?.rollups ?? 0,
        updatedAt: row.updatedAt,
    };
}

export function serializeSubAccountRollup(row) {
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
        totalRepriceCount: row.totalRepriceCount,
        updatedAt: row.updatedAt,
    };
}

export function serializeStrategyRollup(row) {
    return {
        strategySessionId: row.strategySessionId,
        subAccountId: row.subAccountId,
        strategyType: row.strategyType,
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
        totalRepriceCount: row.totalRepriceCount,
        updatedAt: row.updatedAt,
    };
}

export function serializeLifecycleDetail(row) {
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
    };
}

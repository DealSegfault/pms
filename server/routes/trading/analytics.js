/**
 * Analytics Routes — vine pair signals, smart index recommendations.
 * Heavy analytical functions live here (loadLatestDeepPairs, buildSmartIndexRecommendations, etc.)
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
// exchange.js removed — fetchTopPerpUniverse uses Binance REST directly
import {
    DEEP_OUTPUT_DIR,
    DECISION_OUTPUT_DIR,
    SMART_INDEX_CACHE_FILE,
    SMART_INDEX_CACHE_TTL_MS,
    SMART_INDEX_TARGET_ROWS,
    SMART_UNIVERSE_SIZE,
    parseCsvLine,
    normalizePairToken,
    toMarketUsdtSymbol,
    parseList,
    parseCmpiSymbolsFromPath,
    medalForRank,
    stddev,
    asNumberOrNull,
    clamp,
    normalize01,
    safeAverage,
    isActionableSignal,
    uniqueFirst,
    mapFromObjectEntries,
    summarizeCmpiFile,
    pickDirectionFromZ,
    confidenceScore,
    ensureSectionHasEntries,
    buildDefaultRecommendations,
    buildRecommendationSections,
    decodeBasketTypeLabel,
    recommendedDirectionText,
} from './helpers.js';

const router = Router();

const SMART_BASKET_POLICIES = [
    {
        basketType: 'market_neutral',
        targetFocus: 'balanced',
        preferredTails: ['no_tail', 'both_or_flexible_tail'],
        preferredFamilies: ['gaussian', 'frank', 'student'],
        partnerCount: 3,
    },
    {
        basketType: 'trend',
        targetFocus: 'momentum',
        preferredTails: ['upper_tail', 'both_or_flexible_tail'],
        preferredFamilies: ['gumbel', 'student', 'bb1', 'bb7'],
        partnerCount: 3,
    },
    {
        basketType: 'tail_hedge',
        targetFocus: 'defensive',
        preferredTails: ['lower_tail', 'both_or_flexible_tail'],
        preferredFamilies: ['clayton', 'tawn', 'student', 'bb7'],
        partnerCount: 3,
    },
    {
        basketType: 'high_beta',
        targetFocus: 'high_beta',
        preferredTails: ['both_or_flexible_tail', 'upper_tail'],
        preferredFamilies: ['student', 'tawn', 'bb7', 'bb8'],
        partnerCount: 2,
    },
    {
        basketType: 'sector',
        targetFocus: 'balanced',
        preferredTails: ['both_or_flexible_tail', 'no_tail', 'upper_tail'],
        preferredFamilies: ['student', 'frank', 'gaussian', 'gumbel'],
        partnerCount: 3,
    },
    {
        basketType: 'breakout',
        targetFocus: 'momentum',
        preferredTails: ['upper_tail', 'both_or_flexible_tail'],
        preferredFamilies: ['gumbel', 'tawn', 'bb8', 'student'],
        partnerCount: 2,
    },
    {
        basketType: 'mean_revert',
        targetFocus: 'defensive',
        preferredTails: ['no_tail', 'lower_tail', 'both_or_flexible_tail'],
        preferredFamilies: ['frank', 'gaussian', 'clayton', 'student'],
        partnerCount: 3,
    },
];

let smartUniverseCache = { rows: null, ts: 0 };

// ── Inner analytic functions ──────────────────────

async function loadTopDecisionIndexes(limit = 5) {
    const decisionFile = path.join(DECISION_OUTPUT_DIR, 'decision_table_latest.csv');
    let stat;
    let text;
    try {
        stat = await fs.stat(decisionFile);
        text = await fs.readFile(decisionFile, 'utf8');
    } catch {
        return { rows: [], sourceFile: null, generatedAt: null };
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
        return { rows: [], sourceFile: path.basename(decisionFile), generatedAt: stat.mtime.toISOString() };
    }

    const header = parseCsvLine(lines[0]);
    const idx = Object.fromEntries(header.map((key, i) => [key, i]));
    const required = ['basket_type', 'aic', 'bic', 'loglik', 'cmpi_z_last', 'mispricing_last', 'cmpi_half_life', 'cmpi_ar1_phi', 'selected_triple', 'selected_order', 'edge_families', 'cmpi_file'];
    if (!required.every((x) => Number.isInteger(idx[x]))) {
        return { rows: [], sourceFile: path.basename(decisionFile), generatedAt: stat.mtime.toISOString() };
    }

    const rawRows = [];
    for (let i = 1; i < lines.length; i += 1) {
        const vals = parseCsvLine(lines[i]);
        const basketType = String(vals[idx.basket_type] || '').trim();
        if (!basketType) continue;

        const aic = Number(vals[idx.aic]);
        const bic = Number(vals[idx.bic]);
        const loglik = Number(vals[idx.loglik]);
        const cmpiZLast = Number(vals[idx.cmpi_z_last]);
        const mispricingLast = Number(vals[idx.mispricing_last]);
        const cmpiHalfLife = Number(vals[idx.cmpi_half_life]);
        const cmpiAr1Phi = Number(vals[idx.cmpi_ar1_phi]);

        const tripleTokens = parseList(vals[idx.selected_triple], '|');
        const orderTokens = parseList(vals[idx.selected_order], '->');
        const edgeFamilies = parseList(vals[idx.edge_families], ',');
        const cmpiFile = String(vals[idx.cmpi_file] || '').trim();
        const cmpiSymbols = parseCmpiSymbolsFromPath(cmpiFile);

        let target = cmpiSymbols[0] || null;
        let partners = tripleTokens.length ? tripleTokens : cmpiSymbols.slice(1);
        if (!target && orderTokens.length) target = orderTokens[orderTokens.length - 1];
        if ((!partners || partners.length === 0) && orderTokens.length > 1) {
            partners = orderTokens.slice(0, orderTokens.length - 1);
        }

        const targetSymbol = toMarketUsdtSymbol(target);
        const partnerSymbols = (partners || []).map(toMarketUsdtSymbol).filter(Boolean);
        if (!targetSymbol || partnerSymbols.length === 0) continue;

        const partnerWeight = 1 / partnerSymbols.length;
        const formula = [
            { symbol: targetSymbol, factor: 1 },
            ...partnerSymbols.map((symbol) => ({ symbol, factor: -partnerWeight })),
        ];

        const volatility = await summarizeCmpiFile(cmpiFile);
        const recommendedSide = pickDirectionFromZ(cmpiZLast);

        const qualityScore = (
            (Number.isFinite(aic) ? -aic : 0) * 0.5 +
            (Number.isFinite(loglik) ? loglik : 0) * 0.2 +
            (Number.isFinite(cmpiZLast) ? Math.abs(cmpiZLast) : 0) * 100 +
            (Number.isFinite(mispricingLast) ? Math.abs(mispricingLast) : 0) * 180 +
            (Number.isFinite(volatility.cmpiVolatility) ? volatility.cmpiVolatility : 0) * 450
        );

        const row = {
            basketType,
            formula,
            recommendedSide,
            target: normalizePairToken(target),
            partners: partnerSymbols.map((s) => normalizePairToken(s)),
            selectedTriple: tripleTokens.map((x) => normalizePairToken(x)),
            selectedOrder: orderTokens.map((x) => normalizePairToken(x)),
            edgeFamilies,
            metrics: {
                aic: Number.isFinite(aic) ? aic : null,
                bic: Number.isFinite(bic) ? bic : null,
                loglik: Number.isFinite(loglik) ? loglik : null,
                cmpiZLast: Number.isFinite(cmpiZLast) ? cmpiZLast : null,
                mispricingLast: Number.isFinite(mispricingLast) ? mispricingLast : null,
                cmpiHalfLife: Number.isFinite(cmpiHalfLife) ? cmpiHalfLife : null,
                cmpiAr1Phi: Number.isFinite(cmpiAr1Phi) ? cmpiAr1Phi : null,
            },
            volatility,
            qualityScore,
        };
        row.confidence = confidenceScore(row);
        rawRows.push(row);
    }

    rawRows.sort((a, b) => b.qualityScore - a.qualityScore);

    const rankedRows = rawRows.map((row, i) => {
        const rank = i + 1;
        const direction = row.recommendedSide === 'SHORT'
            ? `Short spread (${row.target} vs basket)`
            : row.recommendedSide === 'LONG'
                ? `Long spread (${row.target} vs basket)`
                : `Neutral/Hold (${row.target} spread)`;
        return {
            id: `${row.basketType}-${rank}`,
            rank,
            medal: medalForRank(rank),
            basketType: row.basketType,
            title: `${row.basketType.replace(/_/g, ' ').toUpperCase()} Elite`,
            direction,
            target: row.target,
            partners: row.partners,
            selectedTriple: row.selectedTriple,
            selectedOrder: row.selectedOrder,
            edgeFamilies: row.edgeFamilies,
            recommendedSide: row.recommendedSide,
            confidence: row.confidence,
            qualityScore: row.qualityScore,
            volatility: row.volatility,
            formula: row.formula,
            metrics: row.metrics,
        };
    });
    const rows = rankedRows.slice(0, limit);

    const shortNow = ensureSectionHasEntries(
        rankedRows,
        rankedRows
            .filter((x) => x.recommendedSide === 'SHORT')
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 3),
        'SHORT',
    );

    const longNow = ensureSectionHasEntries(
        rankedRows,
        rankedRows
            .filter((x) => x.recommendedSide === 'LONG')
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 3),
        'LONG',
    );

    const mostVolatile = [...rankedRows]
        .sort((a, b) => (Number(b?.volatility?.cmpiVolatility) || 0) - (Number(a?.volatility?.cmpiVolatility) || 0))
        .slice(0, 3);

    const diversified = [];
    const seenBasketTypes = new Set();
    for (const row of rankedRows) {
        if (seenBasketTypes.has(row.basketType)) continue;
        diversified.push(row);
        seenBasketTypes.add(row.basketType);
        if (diversified.length >= 4) break;
    }

    return {
        rows,
        recommendations: {
            longNow,
            shortNow,
            mostVolatile,
            diversified,
        },
        sourceFile: path.basename(decisionFile),
        generatedAt: stat.mtime.toISOString(),
    };
}

async function loadLatestDeepPairs(limit = 1200) {
    let files = [];
    try {
        files = await fs.readdir(DEEP_OUTPUT_DIR);
    } catch {
        return { rows: [], sourceFile: null, generatedAt: null };
    }

    const deepFiles = files
        .filter((x) => /^deep_pairs_.*\.csv$/i.test(x))
        .map((name) => path.join(DEEP_OUTPUT_DIR, name));
    if (deepFiles.length === 0) return { rows: [], sourceFile: null, generatedAt: null };

    const fileStats = await Promise.all(deepFiles.map(async (full) => ({
        full,
        stat: await fs.stat(full),
    })));
    fileStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const latest = fileStats[0];
    const text = await fs.readFile(latest.full, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return { rows: [], sourceFile: path.basename(latest.full), generatedAt: latest.stat.mtime.toISOString() };

    const header = parseCsvLine(lines[0]);
    const idx = Object.fromEntries(header.map((key, i) => [key, i]));
    const need = ['winner', 'loser', 'copula_family', 'copula_tail', 'copula_tau', 'score', 'z_last', 'action'];
    if (!need.every((x) => Number.isInteger(idx[x]))) {
        return { rows: [], sourceFile: path.basename(latest.full), generatedAt: latest.stat.mtime.toISOString() };
    }

    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
        const vals = parseCsvLine(lines[i]);
        const winner = vals[idx.winner];
        const loser = vals[idx.loser];
        const left = normalizePairToken(winner);
        const right = normalizePairToken(loser);
        if (!left || !right || left === right) continue;

        const family = String(vals[idx.copula_family] || '').trim().toLowerCase();
        const tail = String(vals[idx.copula_tail] || '').trim().toLowerCase();
        const tau = Number(vals[idx.copula_tau]);
        const score = Number(vals[idx.score]);
        const z = Number(vals[idx.z_last]);
        const action = String(vals[idx.action] || '').trim();

        rows.push({
            pair: `${left}/${right}`,
            winner: String(winner || '').trim().toUpperCase(),
            loser: String(loser || '').trim().toUpperCase(),
            copulaFamily: family || null,
            copulaTail: tail || null,
            copulaTau: Number.isFinite(tau) ? tau : null,
            vineScore: Number.isFinite(score) ? score : null,
            zLast: Number.isFinite(z) ? z : null,
            action: action || null,
        });

        if (rows.length >= limit) break;
    }

    return {
        rows,
        sourceFile: path.basename(latest.full),
        generatedAt: latest.stat.mtime.toISOString(),
    };
}

async function loadLatestDeepPairsDetailed(limit = 9000) {
    let files = [];
    try {
        files = await fs.readdir(DEEP_OUTPUT_DIR);
    } catch {
        return { rows: [], sourceFile: null, generatedAt: null };
    }

    const deepFiles = files
        .filter((x) => /^deep_pairs_.*\.csv$/i.test(x))
        .map((name) => path.join(DEEP_OUTPUT_DIR, name));
    if (deepFiles.length === 0) return { rows: [], sourceFile: null, generatedAt: null };

    const fileStats = await Promise.all(deepFiles.map(async (full) => ({
        full,
        stat: await fs.stat(full),
    })));
    fileStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const latest = fileStats[0];

    let text = '';
    try {
        text = await fs.readFile(latest.full, 'utf8');
    } catch {
        return { rows: [], sourceFile: path.basename(latest.full), generatedAt: latest.stat.mtime.toISOString() };
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
        return { rows: [], sourceFile: path.basename(latest.full), generatedAt: latest.stat.mtime.toISOString() };
    }

    const header = parseCsvLine(lines[0]);
    const idx = Object.fromEntries(header.map((key, i) => [String(key || '').trim(), i]));
    const need = ['winner', 'loser', 'action', 'score', 'copula_family', 'copula_tail', 'copula_tau', 'z_last'];
    if (!need.every((x) => Number.isInteger(idx[x]))) {
        return { rows: [], sourceFile: path.basename(latest.full), generatedAt: latest.stat.mtime.toISOString() };
    }

    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
        const vals = parseCsvLine(lines[i]);
        const winner = String(vals[idx.winner] || '').trim().toUpperCase();
        const loser = String(vals[idx.loser] || '').trim().toUpperCase();
        const winnerBase = normalizePairToken(winner);
        const loserBase = normalizePairToken(loser);
        if (!winnerBase || !loserBase || winnerBase === loserBase) continue;

        rows.push({
            winner,
            loser,
            winnerBase,
            loserBase,
            winnerReturn: asNumberOrNull(vals[idx.winner_return]),
            loserReturn: asNumberOrNull(vals[idx.loser_return]),
            returnSpread: asNumberOrNull(vals[idx.ret_spread]),
            corrPearson: asNumberOrNull(vals[idx.corr_pearson]),
            corrSpearman: asNumberOrNull(vals[idx.corr_spearman]),
            betaWinnerOnLoser: asNumberOrNull(vals[idx.beta_w_on_l]),
            halfLifeBars: asNumberOrNull(vals[idx.half_life_bars]),
            zLast: asNumberOrNull(vals[idx.z_last]),
            action: String(vals[idx.action] || '').trim(),
            vineScore: asNumberOrNull(vals[idx.score]),
            copulaFamily: String(vals[idx.copula_family] || '').trim().toLowerCase() || null,
            copulaTail: String(vals[idx.copula_tail] || '').trim().toLowerCase() || null,
            copulaTau: asNumberOrNull(vals[idx.copula_tau]),
            copulaMispricingLast: asNumberOrNull(vals[idx.copula_mispricing_last]),
            trades: asNumberOrNull(vals[idx.trades]),
            winRate: asNumberOrNull(vals[idx.win_rate]),
            avgTradePnl: asNumberOrNull(vals[idx.avg_trade_pnl]),
            totalPnl: asNumberOrNull(vals[idx.total_pnl]),
            sharpeTrade: asNumberOrNull(vals[idx.sharpe_trade]),
        });

        if (rows.length >= limit) break;
    }

    return {
        rows,
        sourceFile: path.basename(latest.full),
        generatedAt: latest.stat.mtime.toISOString(),
    };
}

async function fetchTopPerpUniverse(limit = SMART_UNIVERSE_SIZE) {
    const now = Date.now();
    if (Array.isArray(smartUniverseCache.rows) && smartUniverseCache.rows.length > 0 && (now - smartUniverseCache.ts) < 60_000) {
        return smartUniverseCache.rows.slice(0, limit);
    }

    // Fetch markets from Binance exchangeInfo (no exchange.js dependency)
    let perps = [];
    try {
        const infoResp = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const infoData = await infoResp.json();
        perps = (infoData.symbols || [])
            .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map((s) => ({
                symbol: `${s.baseAsset}/USDT:USDT`,
                id: s.symbol,
                base: s.baseAsset.toUpperCase(),
            }))
            .filter((x) => x.base);
    } catch (err) {
        console.error('[Analytics] exchangeInfo fetch failed:', err.message);
        return [];
    }

    if (perps.length === 0) return [];

    let tickerResp = [];
    try {
        const resp = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        const data = await resp.json();
        if (Array.isArray(data)) tickerResp = data;
    } catch {
        tickerResp = [];
    }

    const tickerMap = mapFromObjectEntries(tickerResp.map((x) => [String(x?.symbol || ''), x]));
    const rows = perps.map((m) => {
        const ticker = tickerMap[m.id] || {};
        const quoteVolume = Number(ticker.quoteVolume);
        const change24h = Number(ticker.priceChangePercent);
        return {
            symbol: m.symbol,
            id: m.id,
            base: m.base,
            quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
            change24h: Number.isFinite(change24h) ? change24h : 0,
        };
    });

    rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
    const top = rows.slice(0, limit);
    smartUniverseCache = { rows: top, ts: now };
    return top;
}

function pairEdgeScore(row) {
    const score = Number(row.vineScore) || 0;
    const zAbs = Math.abs(Number(row.zLast) || 0);
    const tauAbs = Math.abs(Number(row.copulaTau) || 0);
    const sharpe = Math.max(0, Number(row.sharpeTrade) || 0);
    const winRate = clamp(Number(row.winRate) || 0, 0, 1);
    const pnl = Math.max(0, Number(row.totalPnl) || 0);
    const actionable = isActionableSignal(row.action) ? 1 : 0;
    return (
        score * 0.55 +
        zAbs * 0.6 +
        tauAbs * 0.5 +
        Math.min(2, sharpe) * 0.25 +
        winRate * 0.35 +
        Math.min(1.5, pnl * 2.5) * 0.2 +
        actionable * 0.65
    );
}

function selectTargetScore(asset, policy) {
    const liq = Number(asset.liqNorm) || 0;
    const signal = Number(asset.signalNorm) || 0;
    const act = Number(asset.actionNorm) || 0;
    const absChange = Number(asset.changeAbsNorm) || 0;
    const downMove = Number(asset.downMoveNorm) || 0;
    const upMove = Number(asset.upMoveNorm) || 0;
    const beta = Number(asset.betaAbsNorm) || 0;

    if (policy.targetFocus === 'momentum') {
        return liq * 0.28 + signal * 0.27 + upMove * 0.27 + act * 0.12 + absChange * 0.06;
    }
    if (policy.targetFocus === 'defensive') {
        return liq * 0.24 + signal * 0.29 + downMove * 0.22 + act * 0.2 + absChange * 0.05;
    }
    if (policy.targetFocus === 'high_beta') {
        return liq * 0.2 + signal * 0.28 + beta * 0.34 + absChange * 0.12 + act * 0.06;
    }
    return liq * 0.3 + signal * 0.31 + act * 0.18 + absChange * 0.11 + beta * 0.1;
}

function policyPartnerScore(candidate, policy, targetAsset) {
    const edge = candidate.edge;
    let score = Number(edge.edgeScore) || 0;
    if (policy.preferredTails.includes(edge.copulaTail)) score += 0.7;
    if (policy.preferredFamilies.includes(edge.copulaFamily)) score += 0.55;
    if (edge.actionable) score += 0.4;

    const corrPenalty = Math.abs(Number(edge.corrSpearman) || 0);
    if (policy.basketType === 'market_neutral' || policy.basketType === 'mean_revert') {
        score += (1 - corrPenalty) * 0.5;
    } else {
        score += corrPenalty * 0.35;
    }

    if (policy.targetFocus === 'high_beta') {
        score += Math.abs(Number(edge.betaWinnerOnLoser) || 0) * 0.45;
    }

    if (targetAsset) {
        const targetVolume = Number(targetAsset.quoteVolume) || 0;
        const partnerVolume = Number(candidate.partnerAsset?.quoteVolume) || 0;
        const ratio = targetVolume > 0 ? Math.min(1, partnerVolume / targetVolume) : 0;
        score += ratio * 0.18;
    }

    return score;
}

function createFallbackPartners(assetsByBase, baseList, excludeSet, count) {
    const picked = [];
    for (const base of baseList) {
        if (excludeSet.has(base)) continue;
        const asset = assetsByBase.get(base);
        if (!asset) continue;
        picked.push(asset);
        excludeSet.add(base);
        if (picked.length >= count) break;
    }
    return picked;
}

function materializeRankedRows(rawRows) {
    const sorted = [...rawRows].sort((a, b) => b.qualityScore - a.qualityScore);
    return sorted.map((row, i) => {
        const rank = i + 1;
        const qualityScore = Number(row.qualityScore) || 0;
        const finalized = {
            ...row,
            id: row.id || `smart-${row.basketType}-${row.target}-${rank}`,
            rank,
            medal: medalForRank(rank),
            title: `${decodeBasketTypeLabel(row.basketType)} ${row.target} Smart`,
            direction: recommendedDirectionText(row),
            qualityScore,
        };
        finalized.confidence = confidenceScore(finalized);
        return finalized;
    });
}

function normalizeSmartPayload(payload, limit) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const recommendations = payload?.recommendations || buildDefaultRecommendations();
    return {
        rows: rows.slice(0, limit),
        recommendations: {
            longNow: Array.isArray(recommendations.longNow) ? recommendations.longNow : [],
            shortNow: Array.isArray(recommendations.shortNow) ? recommendations.shortNow : [],
            mostVolatile: Array.isArray(recommendations.mostVolatile) ? recommendations.mostVolatile : [],
            diversified: Array.isArray(recommendations.diversified) ? recommendations.diversified : [],
        },
        sourceFile: payload?.sourceFile || path.basename(SMART_INDEX_CACHE_FILE),
        generatedAt: payload?.generatedAt || null,
        universeUsed: Number(payload?.universeUsed) || 0,
        deepPairsUsed: Number(payload?.deepPairsUsed) || 0,
    };
}

async function readSmartIndexCache(limit) {
    try {
        const raw = await fs.readFile(SMART_INDEX_CACHE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.rows) || parsed.rows.length === 0) return null;
        return normalizeSmartPayload(parsed, limit);
    } catch {
        return null;
    }
}

async function writeSmartIndexCache(payload) {
    try {
        await fs.mkdir(DECISION_OUTPUT_DIR, { recursive: true });
        await fs.writeFile(SMART_INDEX_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
        // Best-effort cache write.
    }
}

async function buildSmartIndexRecommendations(limit = 5) {
    const targetRows = Math.max(SMART_INDEX_TARGET_ROWS, limit);
    const [universe, deep] = await Promise.all([
        fetchTopPerpUniverse(SMART_UNIVERSE_SIZE),
        loadLatestDeepPairsDetailed(9000),
    ]);

    if (!Array.isArray(universe) || universe.length < 12) {
        return {
            rows: [],
            recommendations: buildDefaultRecommendations(),
            sourceFile: path.basename(SMART_INDEX_CACHE_FILE),
            generatedAt: new Date().toISOString(),
            universeUsed: 0,
            deepPairsUsed: 0,
        };
    }

    const universeByBase = new Map(universe.map((row) => [row.base, row]));
    const universeBases = new Set(universe.map((row) => row.base));

    const deepRows = (deep.rows || [])
        .filter((row) => universeBases.has(row.winnerBase) && universeBases.has(row.loserBase))
        .map((row) => ({
            ...row,
            actionable: isActionableSignal(row.action),
            edgeScore: pairEdgeScore(row),
        }));

    const edgesByBase = new Map();
    const baseStats = new Map();
    const touchStat = (base) => {
        if (!baseStats.has(base)) {
            baseStats.set(base, {
                edgeCount: 0,
                actionableCount: 0,
                edgeScoreSum: 0,
                zAbsSum: 0,
                betaAbsSum: 0,
            });
        }
        return baseStats.get(base);
    };
    const addEdgeForBase = (base, entry) => {
        if (!edgesByBase.has(base)) edgesByBase.set(base, []);
        edgesByBase.get(base).push(entry);
    };

    for (const edge of deepRows) {
        const winnerAsset = universeByBase.get(edge.winnerBase);
        const loserAsset = universeByBase.get(edge.loserBase);
        if (!winnerAsset || !loserAsset) continue;

        addEdgeForBase(edge.winnerBase, {
            edge,
            role: 'winner',
            otherBase: edge.loserBase,
            partnerAsset: loserAsset,
        });
        addEdgeForBase(edge.loserBase, {
            edge,
            role: 'loser',
            otherBase: edge.winnerBase,
            partnerAsset: winnerAsset,
        });

        const w = touchStat(edge.winnerBase);
        w.edgeCount += 1;
        w.actionableCount += edge.actionable ? 1 : 0;
        w.edgeScoreSum += edge.edgeScore;
        w.zAbsSum += Math.abs(Number(edge.zLast) || 0);
        w.betaAbsSum += Math.abs(Number(edge.betaWinnerOnLoser) || 0);

        const l = touchStat(edge.loserBase);
        l.edgeCount += 1;
        l.actionableCount += edge.actionable ? 1 : 0;
        l.edgeScoreSum += edge.edgeScore;
        l.zAbsSum += Math.abs(Number(edge.zLast) || 0);
        l.betaAbsSum += Math.abs(Number(edge.betaWinnerOnLoser) || 0);
    }

    const volumes = universe.map((row) => Math.log1p(Math.max(0, Number(row.quoteVolume) || 0)));
    const changesAbs = universe.map((row) => Math.abs(Number(row.change24h) || 0));
    const edgeScores = [...baseStats.values()].map((s) => (s.edgeCount > 0 ? s.edgeScoreSum / s.edgeCount : 0));
    const actionRates = [...baseStats.values()].map((s) => (s.edgeCount > 0 ? s.actionableCount / s.edgeCount : 0));
    const betaAbsVals = [...baseStats.values()].map((s) => (s.edgeCount > 0 ? s.betaAbsSum / s.edgeCount : 0));

    const volMin = Math.min(...volumes);
    const volMax = Math.max(...volumes);
    const changeMin = Math.min(...changesAbs);
    const changeMax = Math.max(...changesAbs);
    const sigMin = edgeScores.length ? Math.min(...edgeScores) : 0;
    const sigMax = edgeScores.length ? Math.max(...edgeScores) : 1;
    const actMin = actionRates.length ? Math.min(...actionRates) : 0;
    const actMax = actionRates.length ? Math.max(...actionRates) : 1;
    const betaMin = betaAbsVals.length ? Math.min(...betaAbsVals) : 0;
    const betaMax = betaAbsVals.length ? Math.max(...betaAbsVals) : 1;

    const assets = universe.map((asset) => {
        const stat = baseStats.get(asset.base) || { edgeCount: 0, actionableCount: 0, edgeScoreSum: 0, betaAbsSum: 0 };
        const signalRaw = stat.edgeCount > 0 ? stat.edgeScoreSum / stat.edgeCount : 0;
        const actionRaw = stat.edgeCount > 0 ? stat.actionableCount / stat.edgeCount : 0;
        const betaRaw = stat.edgeCount > 0 ? stat.betaAbsSum / stat.edgeCount : 0;
        const liqNorm = normalize01(Math.log1p(Math.max(0, Number(asset.quoteVolume) || 0)), volMin, volMax);
        const changeAbsNorm = normalize01(Math.abs(Number(asset.change24h) || 0), changeMin, changeMax);
        const signalNorm = normalize01(signalRaw, sigMin, sigMax);
        const actionNorm = normalize01(actionRaw, actMin, actMax);
        const betaAbsNorm = normalize01(betaRaw, betaMin, betaMax);
        const upMoveNorm = normalize01(Math.max(0, Number(asset.change24h) || 0), 0, Math.max(0.000001, changeMax));
        const downMoveNorm = normalize01(Math.max(0, -(Number(asset.change24h) || 0)), 0, Math.max(0.000001, changeMax));
        return {
            ...asset,
            signalRaw,
            actionRaw,
            betaRaw,
            liqNorm,
            changeAbsNorm,
            signalNorm,
            actionNorm,
            betaAbsNorm,
            upMoveNorm,
            downMoveNorm,
        };
    });

    const assetsByBase = new Map(assets.map((asset) => [asset.base, asset]));
    const orderedByLiquidity = [...assets].sort((a, b) => b.quoteVolume - a.quoteVolume).map((x) => x.base);
    const rawRows = [];
    const usedTargets = new Set();
    let uniqueIdCounter = 0;

    const pickPartners = (targetBase, policy) => {
        const targetAsset = assetsByBase.get(targetBase);
        const pool = edgesByBase.get(targetBase) || [];
        const usedPartnerBases = new Set([targetBase]);
        const sorted = [...pool]
            .filter((entry) => entry?.otherBase && assetsByBase.has(entry.otherBase))
            .sort((a, b) => policyPartnerScore(b, policy, targetAsset) - policyPartnerScore(a, policy, targetAsset));

        const selectedEntries = [];
        for (const entry of sorted) {
            if (usedPartnerBases.has(entry.otherBase)) continue;
            usedPartnerBases.add(entry.otherBase);
            selectedEntries.push(entry);
            if (selectedEntries.length >= policy.partnerCount) break;
        }

        if (selectedEntries.length < policy.partnerCount) {
            const fallbackAssets = createFallbackPartners(
                assetsByBase,
                orderedByLiquidity,
                usedPartnerBases,
                policy.partnerCount - selectedEntries.length,
            );
            for (const asset of fallbackAssets) {
                selectedEntries.push({
                    edge: {
                        edgeScore: (targetAsset?.signalRaw || 0) * 0.3,
                        copulaFamily: 'gaussian',
                        copulaTail: 'no_tail',
                        actionable: false,
                        zLast: asNumberOrNull((targetAsset?.change24h || 0) / 6),
                        copulaMispricingLast: asNumberOrNull((targetAsset?.change24h || 0) / 100),
                        halfLifeBars: 72,
                        corrSpearman: 0.15,
                        betaWinnerOnLoser: 1,
                        returnSpread: null,
                        winnerBase: targetBase,
                        loserBase: asset.base,
                    },
                    role: 'winner',
                    otherBase: asset.base,
                    partnerAsset: asset,
                });
            }
        }

        return selectedEntries.slice(0, policy.partnerCount);
    };

    const tryCreateRow = (policy, targetAsset) => {
        if (!targetAsset?.base || usedTargets.has(targetAsset.base)) return null;
        const selectedPartners = pickPartners(targetAsset.base, policy);
        if (selectedPartners.length < Math.min(2, policy.partnerCount)) return null;

        const targetSymbol = targetAsset.symbol;
        const partnerSymbols = uniqueFirst(selectedPartners.map((x) => x.partnerAsset?.symbol).filter(Boolean));
        if (partnerSymbols.length < 2) return null;

        const partnerBases = uniqueFirst(selectedPartners.map((x) => x.otherBase).filter(Boolean));
        const selectedEdges = selectedPartners.map((x) => x.edge).filter(Boolean);
        const edgeFamilies = uniqueFirst(selectedEdges.map((e) => e.copulaFamily).filter(Boolean));

        const signedZ = selectedEdges.map((edge) => {
            const raw = Number(edge.zLast);
            if (!Number.isFinite(raw)) return null;
            if (edge.winnerBase === targetAsset.base) return Math.abs(raw);
            if (edge.loserBase === targetAsset.base) return -Math.abs(raw);
            return raw;
        }).filter(Number.isFinite);
        const signedMis = selectedEdges.map((edge) => {
            const raw = Number(edge.copulaMispricingLast);
            if (!Number.isFinite(raw)) return null;
            if (edge.winnerBase === targetAsset.base) return raw;
            if (edge.loserBase === targetAsset.base) return -raw;
            return raw;
        }).filter(Number.isFinite);
        const halfLives = selectedEdges.map((edge) => Number(edge.halfLifeBars)).filter(Number.isFinite);
        const betaAbs = selectedEdges.map((edge) => Math.abs(Number(edge.betaWinnerOnLoser) || 0)).filter(Number.isFinite);
        const retSpread = selectedEdges.map((edge) => Math.abs(Number(edge.returnSpread) || 0)).filter(Number.isFinite);
        const edgeScoresLocal = selectedEdges.map((edge) => Number(edge.edgeScore) || 0).filter(Number.isFinite);
        const zAvg = safeAverage(signedZ);
        const misAvg = safeAverage(signedMis);
        const halfAvg = safeAverage(halfLives);
        const retStd = stddev(retSpread);
        const zStd = stddev(signedZ);
        const cmpiVolatility = Math.max(0.0001, retStd * 0.6 + zStd * 0.22 + Math.abs(Number(targetAsset.change24h) || 0) / 90);
        const cmpiRange = Math.max(0.001, Math.abs(Number(targetAsset.change24h) || 0) / 35 + retSpread.reduce((a, b) => a + b, 0) / Math.max(1, retSpread.length));
        const cmpiZLast = Number.isFinite(zAvg) ? clamp(zAvg, -3.5, 3.5) : clamp(-(Number(targetAsset.change24h) || 0) / 8, -2.8, 2.8);
        const recommendedSide = pickDirectionFromZ(cmpiZLast);

        const partnerWeight = 1 / partnerSymbols.length;
        const formula = [
            { symbol: targetSymbol, factor: 1 },
            ...partnerSymbols.map((symbol) => ({ symbol, factor: -partnerWeight })),
        ];

        const qualityScore = (
            (targetAsset.liqNorm || 0) * 420 +
            (targetAsset.signalNorm || 0) * 620 +
            (targetAsset.actionNorm || 0) * 180 +
            (safeAverage(edgeScoresLocal) || 0) * 120 +
            (safeAverage(betaAbs) || 0) * 130 +
            Math.abs(cmpiZLast) * 100 +
            cmpiVolatility * 300
        );

        usedTargets.add(targetAsset.base);
        uniqueIdCounter += 1;
        return {
            id: `smart-${policy.basketType}-${targetAsset.base}-${uniqueIdCounter}`,
            basketType: policy.basketType,
            target: targetAsset.base,
            partners: partnerBases,
            selectedTriple: partnerBases.slice(0, 3),
            selectedOrder: [targetAsset.base, ...partnerBases.slice(0, 3)],
            edgeFamilies: edgeFamilies.length ? edgeFamilies : ['gaussian'],
            recommendedSide,
            formula,
            metrics: {
                aic: null,
                bic: null,
                loglik: null,
                cmpiZLast,
                mispricingLast: Number.isFinite(misAvg) ? misAvg : null,
                cmpiHalfLife: Number.isFinite(halfAvg) ? halfAvg : null,
                cmpiAr1Phi: Number.isFinite(halfAvg) && halfAvg > 0 ? clamp(Math.exp(-Math.log(2) / halfAvg), 0, 0.999) : null,
            },
            volatility: {
                cmpiVolatility,
                mispricingVolatility: stddev(signedMis),
                cmpiRange,
                observations: selectedEdges.length,
            },
            qualityScore,
        };
    };

    for (const policy of SMART_BASKET_POLICIES) {
        const rankedTargets = [...assets]
            .sort((a, b) => selectTargetScore(b, policy) - selectTargetScore(a, policy));
        const candidate = rankedTargets.find((asset) => !usedTargets.has(asset.base));
        const row = candidate ? tryCreateRow(policy, candidate) : null;
        if (row) rawRows.push(row);
    }

    if (rawRows.length < targetRows) {
        const fallbackPolicies = ['market_neutral', 'mean_revert', 'trend', 'high_beta'];
        for (const basketType of fallbackPolicies) {
            if (rawRows.length >= targetRows) break;
            const policy = SMART_BASKET_POLICIES.find((x) => x.basketType === basketType);
            if (!policy) continue;
            const rankedTargets = [...assets]
                .filter((asset) => !usedTargets.has(asset.base))
                .sort((a, b) => selectTargetScore(b, policy) - selectTargetScore(a, policy));

            for (const candidate of rankedTargets) {
                const row = tryCreateRow(policy, candidate);
                if (!row) continue;
                rawRows.push(row);
                if (rawRows.length >= targetRows) break;
            }
        }
    }

    const rankedRows = materializeRankedRows(rawRows);
    const recommendations = buildRecommendationSections(rankedRows);
    const generatedAt = new Date().toISOString();
    return {
        rows: rankedRows,
        recommendations,
        sourceFile: path.basename(SMART_INDEX_CACHE_FILE),
        generatedAt,
        universeUsed: universe.length,
        deepPairsUsed: deepRows.length,
        deepSourceFile: deep.sourceFile || null,
        deepGeneratedAt: deep.generatedAt || null,
    };
}

async function loadSmartTopIndexes(limit = 5, forceRefresh = false) {
    const now = Date.now();
    const cached = forceRefresh ? null : await readSmartIndexCache(Math.max(limit, SMART_INDEX_TARGET_ROWS));
    if (cached) {
        const ageMs = Math.max(0, now - new Date(cached.generatedAt || 0).getTime());
        if (ageMs <= SMART_INDEX_CACHE_TTL_MS) {
            return normalizeSmartPayload(cached, limit);
        }
        // Try refresh when stale; if refresh fails we still serve stale cache.
        try {
            const freshPayload = await buildSmartIndexRecommendations(Math.max(limit, SMART_INDEX_TARGET_ROWS));
            if (Array.isArray(freshPayload.rows) && freshPayload.rows.length > 0) {
                await writeSmartIndexCache(freshPayload);
                return normalizeSmartPayload(freshPayload, limit);
            }
        } catch {
            // fall back to stale cache
        }
        return normalizeSmartPayload(cached, limit);
    }

    const freshPayload = await buildSmartIndexRecommendations(Math.max(limit, SMART_INDEX_TARGET_ROWS));
    if (Array.isArray(freshPayload.rows) && freshPayload.rows.length > 0) {
        await writeSmartIndexCache(freshPayload);
    }
    return normalizeSmartPayload(freshPayload, limit);
}

// ── Routes ────────────────────────────────────────

// GET /api/trade/vine/pairs - Latest pair-level vine-copula signals from debug research
router.get('/vine/pairs', async (req, res) => {
    try {
        const limit = Math.min(5000, Math.max(50, parseInt(req.query.limit, 10) || 1200));
        const payload = await loadLatestDeepPairs(limit);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/trade/vine/top-indexes - Smart cached index templates (500-pair universe) with decision fallback
router.get('/vine/top-indexes', async (req, res) => {
    try {
        const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
        const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
        let payload = await loadSmartTopIndexes(limit, forceRefresh);

        if (!Array.isArray(payload?.rows) || payload.rows.length === 0) {
            payload = await loadTopDecisionIndexes(limit);
        }

        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

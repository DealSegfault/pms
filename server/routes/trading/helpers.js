/**
 * Shared helpers for trading route modules.
 * Extracted from the monolith server/routes/trading.js
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEEP_OUTPUT_DIR = path.resolve(__dirname, '../../../debug/generated/deep');
export const DECISION_OUTPUT_DIR = path.resolve(__dirname, '../../../debug/generated/decision');
export const SMART_INDEX_CACHE_FILE = path.join(DECISION_OUTPUT_DIR, 'smart_index_recommendations_latest.json');
export const SMART_INDEX_CACHE_TTL_MS = 20 * 60 * 1000;
export const SMART_INDEX_TARGET_ROWS = 16;
export const SMART_UNIVERSE_SIZE = 500;

export function parseCsvLine(line) {
    const values = [];
    let curr = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                curr += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            values.push(curr);
            curr = '';
            continue;
        }
        curr += ch;
    }
    values.push(curr);
    return values;
}

export function normalizePairToken(token) {
    const raw = String(token || '').trim().toUpperCase();
    if (!raw) return '';
    if (raw.includes('/')) return raw.split('/')[0];
    return raw.replace(':USDT', '').replace('USDT', '') || raw;
}

export function toMarketUsdtSymbol(token) {
    const base = normalizePairToken(token);
    if (!base) return null;
    return `${base}/USDT:USDT`;
}

export function parseList(raw, separator) {
    return String(raw || '')
        .split(separator)
        .map((x) => x.trim())
        .filter(Boolean);
}

export function parseCmpiSymbolsFromPath(cmpiPath) {
    const base = path.basename(String(cmpiPath || ''));
    const match = base.match(/^basket_cmpi_(.+)_\d{8}_\d{6}\.csv$/i);
    if (!match) return [];
    const tokens = match[1].split('_').filter(Boolean);
    return tokens;
}

export function medalForRank(rank) {
    if (rank === 1) return 'CROWN';
    if (rank === 2) return 'GOLD';
    if (rank === 3) return 'SILVER';
    return 'BRONZE';
}

export function mean(arr = []) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stddev(arr = []) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const varSum = arr.reduce((acc, x) => {
        const d = x - m;
        return acc + (d * d);
    }, 0) / (arr.length - 1);
    return Math.sqrt(Math.max(0, varSum));
}

export function asNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function normalize01(value, low, high) {
    if (!Number.isFinite(value)) return 0;
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return 0;
    return clamp((value - low) / (high - low), 0, 1);
}

export function safeAverage(values = []) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return null;
    return mean(finite);
}

export function isActionableSignal(action) {
    const raw = String(action || '').toLowerCase();
    return raw.includes('short') || raw.includes('long');
}

export function uniqueFirst(items = []) {
    const out = [];
    const seen = new Set();
    for (const item of items) {
        const key = String(item || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

export function mapFromObjectEntries(list = []) {
    const out = {};
    for (const [key, value] of list) out[key] = value;
    return out;
}

export async function summarizeCmpiFile(cmpiFilePath) {
    const out = {
        cmpiVolatility: 0,
        mispricingVolatility: 0,
        cmpiRange: 0,
        observations: 0,
    };
    if (!cmpiFilePath) return out;

    let text;
    try {
        text = await fs.readFile(cmpiFilePath, 'utf8');
    } catch {
        return out;
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 3) return out;

    const header = parseCsvLine(lines[0]);
    const idx = Object.fromEntries(header.map((key, i) => [key, i]));
    if (!Number.isInteger(idx.cmpi) || !Number.isInteger(idx.mispricing)) return out;

    const cmpi = [];
    const mispricing = [];
    for (let i = 1; i < lines.length; i += 1) {
        const vals = parseCsvLine(lines[i]);
        const c = Number(vals[idx.cmpi]);
        const m = Number(vals[idx.mispricing]);
        if (Number.isFinite(c)) cmpi.push(c);
        if (Number.isFinite(m)) mispricing.push(m);
    }
    if (cmpi.length < 3) return out;

    const diffs = [];
    for (let i = 1; i < cmpi.length; i += 1) {
        diffs.push(cmpi[i] - cmpi[i - 1]);
    }

    const cMin = Math.min(...cmpi);
    const cMax = Math.max(...cmpi);
    out.cmpiVolatility = stddev(diffs);
    out.mispricingVolatility = stddev(mispricing);
    out.cmpiRange = Number.isFinite(cMin) && Number.isFinite(cMax) ? (cMax - cMin) : 0;
    out.observations = cmpi.length;
    return out;
}

export function pickDirectionFromZ(z) {
    if (!Number.isFinite(z)) return 'HOLD';
    if (z >= 0.35) return 'SHORT';
    if (z <= -0.35) return 'LONG';
    return 'HOLD';
}

export function confidenceScore(row) {
    const zAbs = Math.abs(Number(row?.metrics?.cmpiZLast) || 0);
    const mis = Math.abs(Number(row?.metrics?.mispricingLast) || 0);
    const vol = Number(row?.volatility?.cmpiVolatility) || 0;
    const quality = Number(row?.qualityScore) || 0;

    // Score in [0,1] using bounded nonlinear terms.
    const zTerm = Math.min(1, zAbs / 1.8);
    const misTerm = Math.min(1, mis / 0.45);
    const volTerm = Math.min(1, vol / 0.12);
    const qualityTerm = Math.min(1, quality / 5000);
    return Math.max(0.05, Math.min(0.99, 0.2 + 0.35 * zTerm + 0.2 * misTerm + 0.15 * volTerm + 0.1 * qualityTerm));
}

export function ensureSectionHasEntries(baseRows, sectionRows, targetSide) {
    if (sectionRows.length > 0) return sectionRows;
    const fallback = [...baseRows]
        .sort((a, b) => Math.abs(Number(b?.metrics?.cmpiZLast) || 0) - Math.abs(Number(a?.metrics?.cmpiZLast) || 0))
        .slice(0, 2)
        .map((x) => ({
            ...x,
            recommendedSide: targetSide,
            fallback: true,
        }));
    return fallback;
}

export function buildDefaultRecommendations() {
    return {
        longNow: [],
        shortNow: [],
        mostVolatile: [],
        diversified: [],
    };
}

export function buildRecommendationSections(rankedRows = []) {
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

    return { longNow, shortNow, mostVolatile, diversified };
}

export function decodeBasketTypeLabel(basketType) {
    const map = {
        market_neutral: 'Market Neutral',
        trend: 'Trend',
        tail_hedge: 'Tail Hedge',
        high_beta: 'High Beta',
        sector: 'Sector',
        breakout: 'Breakout',
        mean_revert: 'Mean Revert',
    };
    return map[basketType] || String(basketType || '').replace(/_/g, ' ').toUpperCase();
}

export function recommendedDirectionText(row) {
    const side = row.recommendedSide;
    if (side === 'SHORT') return `Short spread (${row.target} vs basket)`;
    if (side === 'LONG') return `Long spread (${row.target} vs basket)`;
    return `Neutral/Hold (${row.target} spread)`;
}

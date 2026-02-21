// ── Beta pair builder (matrix, picks, symbols) ──
import { api, showToast, formatPrice } from '../../core/index.js';
import { computePairStatsFromSeries, computePairBasketWeights, weightsToFormula as pairWeightsToFormula, scorePairStats } from '../../lib/pair-beta-builder.js';
import { st, savePairSelections, loadCustomPairs, saveCustomPairs, addCustomPair, removeCustomPair, genId, saveIndexes } from './state.js';
import { renderIndexList, selectIndex } from './index-list.js';

// ── Utility helpers ──────────────────────────────

export function clampInt(value, min, max, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

export function baseFromSymbol(symbol) { return String(symbol || '').split('/')[0].toUpperCase(); }

export function normalizeBaseInput(value) {
    const t = String(value || '').trim().toUpperCase();
    if (!t) return '';
    if (t.includes('/')) return t.split('/')[0];
    return t.replace(':USDT', '').replace('USDT', '') || t;
}

export function resolveSymbolByBase(base) {
    const n = normalizeBaseInput(base);
    return n ? (st.baseToSymbol.get(n) || null) : null;
}

function normalizePairName(pair) {
    const [l, r] = String(pair || '').split('/');
    const left = normalizeBaseInput(l), right = normalizeBaseInput(r);
    return (left && right) ? `${left}/${right}` : '';
}

function reversePairName(pair) {
    const [l, r] = String(pair || '').split('/');
    return (l && r) ? `${r}/${l}` : '';
}

function getVineSignalForPair(pair) {
    const n = normalizePairName(pair);
    return n ? (st.vinePairSignalMap.get(n) || st.vinePairSignalMap.get(reversePairName(n)) || null) : null;
}

function enrichPairRowWithVine(row) {
    const signal = getVineSignalForPair(row?.pair);
    if (!signal) return row;
    return {
        ...row,
        copulaFamily: row?.copulaFamily || signal.copulaFamily || null,
        copulaTail: row?.copulaTail || signal.copulaTail || null,
        copulaTau: Number.isFinite(Number(row?.copulaTau)) ? Number(row.copulaTau) : signal.copulaTau,
        vineScore: Number.isFinite(Number(row?.vineScore)) ? Number(row.vineScore) : signal.vineScore,
        vineAction: row?.vineAction || signal.action || null,
    };
}

async function loadVinePairSignals(force = false) {
    if (!force && st.vinePairSignalMap.size > 0) return;
    try {
        const payload = await api('/trade/vine/pairs?limit=3000');
        const map = new Map();
        for (const row of (Array.isArray(payload?.rows) ? payload.rows : [])) {
            const pair = normalizePairName(row?.pair);
            if (!pair) continue;
            map.set(pair, {
                pair, copulaFamily: row?.copulaFamily || null, copulaTail: row?.copulaTail || null,
                copulaTau: Number.isFinite(Number(row?.copulaTau)) ? Number(row.copulaTau) : null,
                vineScore: Number.isFinite(Number(row?.vineScore)) ? Number(row.vineScore) : null,
                action: row?.action || null
            });
        }
        st.vinePairSignalMap = map;
        st.vineSignalSource = payload?.sourceFile || null;
        st.vineSignalGeneratedAt = payload?.generatedAt || null;
    } catch (err) { console.warn('[PairBuilder] vine signals:', err?.message || err); }
}

function sanitizePairRow(row, isCustom = false) {
    const pair = normalizePairName(row?.pair);
    if (!pair) return null;
    const corr = Number(row?.corr), beta = Number(row?.beta), ret = Number(row?.ret);
    if (![corr, beta, ret].every(Number.isFinite)) return null;
    const stats = { pair, corr, beta, ret };
    return enrichPairRowWithVine({
        ...stats,
        score: Number.isFinite(Number(row?.score)) ? Number(row.score) : scorePairStats(stats),
        copulaFamily: row?.copulaFamily || null, copulaTail: row?.copulaTail || null,
        copulaTau: Number.isFinite(Number(row?.copulaTau)) ? Number(row.copulaTau) : null,
        vineScore: Number.isFinite(Number(row?.vineScore)) ? Number(row.vineScore) : null,
        vineAction: row?.vineAction || row?.action || null, isCustom
    });
}

export function mergePairRowsWithCustom(systemRows = []) {
    const customRows = loadCustomPairs().map(r => sanitizePairRow(r, true)).filter(Boolean);
    const customNames = new Set(customRows.map(x => x.pair));
    const dedupedSystem = [], seen = new Set(customNames);
    for (const row of systemRows) {
        const clean = sanitizePairRow(row, false);
        if (!clean || seen.has(clean.pair)) continue;
        dedupedSystem.push(clean); seen.add(clean.pair);
    }
    return [...customRows, ...dedupedSystem];
}

// ── Symbol loading ───────────────────────────────

export async function loadAllSymbols() {
    if (st.symbolsLoaded) return;
    try {
        const data = await api('/trade/symbols/all');
        if (Array.isArray(data)) {
            st.allSymbols = data.map(s => ({ symbol: s.symbol, base: s.base })).sort((a, b) => a.base.localeCompare(b.base));
            st.baseToSymbol = new Map(st.allSymbols.map(x => [String(x.base || '').toUpperCase(), x.symbol]));
            st.symbolsLoaded = true;
        }
    } catch (err) { console.warn('[Index] Failed to load symbols:', err); }
}

// ── Status helpers ───────────────────────────────

function setPairStatus(text, tone = 'info') {
    const el = document.getElementById('idx-pair-status');
    if (!el) return;
    el.style.color = ({ info: 'var(--text-muted)', success: 'var(--green)', error: 'var(--red)' })[tone] || 'var(--text-muted)';
    el.textContent = text || '';
}

function setTopPicksStatus(text, tone = 'info') {
    const el = document.getElementById('idx-picks-status');
    if (!el) return;
    el.style.color = ({ info: 'var(--text-muted)', success: 'var(--green)', error: 'var(--red)' })[tone] || 'var(--text-muted)';
    el.textContent = text || '';
}

export function setSymbolTabStatus(text, tone = 'info') {
    const el = document.getElementById('idx-sym-status');
    if (!el) return;
    el.style.color = ({ info: 'var(--text-muted)', success: 'var(--green)', error: 'var(--red)' })[tone] || 'var(--text-muted)';
    el.textContent = text || '';
}

// ── Top picks helpers ────────────────────────────

function basketTypeLabel(raw) { return String(raw || '').split('_').filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '); }
function medalIcon(medal, rank) { if (medal === 'CROWN' || rank === 1) return '👑'; if (medal === 'GOLD' || rank === 2) return '🥇'; if (medal === 'SILVER' || rank === 3) return '🥈'; if (medal === 'BRONZE' || rank === 4) return '🥉'; return '🏅'; }
function topPickCardClass(rank) { if (rank === 1) return 'idx-top-pick-card rank-1'; if (rank === 2) return 'idx-top-pick-card rank-2'; if (rank === 3) return 'idx-top-pick-card rank-3'; return 'idx-top-pick-card'; }
function defaultTopRecommendations() { return { longNow: [], shortNow: [], mostVolatile: [], diversified: [] }; }
function recommendationSideBadge(side) { if (side === 'LONG') return '<span style="color:var(--green); font-weight:700;">LONG</span>'; if (side === 'SHORT') return '<span style="color:var(--red); font-weight:700;">SHORT</span>'; return '<span style="color:var(--text-muted); font-weight:700;">HOLD</span>'; }
function findTopPickById(pickId) { return st.topIndexPicks.find(x => x.id === pickId) || [...(st.topIndexRecommendations?.longNow || []), ...(st.topIndexRecommendations?.shortNow || []), ...(st.topIndexRecommendations?.mostVolatile || []), ...(st.topIndexRecommendations?.diversified || [])].find(x => x.id === pickId) || null; }

function upsertTopPickIndex(pick) {
    const name = `${medalIcon(pick.medal, Number(pick.rank) || 0)} ${basketTypeLabel(pick.basketType)} Smart`;
    const existingIdx = st.indexes.findIndex(x => x.sourcePickId === pick.id);
    if (existingIdx >= 0) { st.indexes[existingIdx].name = name; st.indexes[existingIdx].formula = pick.formula; st.indexes[existingIdx].basketType = pick.basketType; return st.indexes[existingIdx].id; }
    const newId = genId();
    st.indexes.push({ id: newId, name, formula: pick.formula, sourcePickId: pick.id, basketType: pick.basketType });
    return newId;
}

// ── Pair builder summary ─────────────────────────

function computePairBuilderWeightsFromSelection() {
    return computePairBasketWeights({ basketLong: st.pairBuilderLong, basketShort: st.pairBuilderShort, tradeSize: st.tradeSize, resolvePairBaseSymbol: resolveSymbolByBase });
}

export function renderPairBuilderSummary() {
    const el = document.getElementById('idx-pair-summary');
    if (!el) return;
    const vineInfo = st.vineSignalSource ? ` · vine: ${st.vineSignalSource}${st.vineSignalGeneratedAt ? ` @ ${new Date(st.vineSignalGeneratedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : '';
    const weights = computePairBuilderWeightsFromSelection();
    if (!weights) { el.textContent = `${st.pairBuilderLong.length} long pairs · ${st.pairBuilderShort.length} short pairs · no allocation yet${vineInfo}`; return; }
    const preview = Object.entries(weights).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map(([symbol, usd]) => `${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(1)} ${symbol.split('/')[0]}`).join(' | ');
    el.textContent = `${st.pairBuilderLong.length} long pairs · ${st.pairBuilderShort.length} short pairs · ${Object.keys(weights).length} legs · ${preview}${vineInfo}`;
}

// ── Pair matrix render (abbreviated) ─────────────

function getPairRowsForRender() {
    const search = st.pairBuilderSearch.trim();
    let rows = st.pairMatrix;
    if (search) rows = rows.filter(row => row.pair.includes(search));
    const dir = st.pairBuilderSortDirection === 'asc' ? 1 : -1;
    const textCols = new Set(['pair', 'copulaFamily', 'copulaTail']);
    return [...rows].sort((a, b) => {
        if (textCols.has(st.pairBuilderSortColumn)) {
            const av = String(a?.[st.pairBuilderSortColumn] || '').trim().toLowerCase();
            const bv = String(b?.[st.pairBuilderSortColumn] || '').trim().toLowerCase();
            if (!av.length && !bv.length) return 0; if (!av.length) return 1; if (!bv.length) return -1;
            return av.localeCompare(bv) * dir;
        }
        const miss = dir === 1 ? Infinity : -Infinity;
        const av = Number.isFinite(Number(a[st.pairBuilderSortColumn])) ? Number(a[st.pairBuilderSortColumn]) : miss;
        const bv = Number.isFinite(Number(b[st.pairBuilderSortColumn])) ? Number(b[st.pairBuilderSortColumn]) : miss;
        return (av - bv) * dir;
    });
}

export function renderPairMatrix() {
    const container = document.getElementById('idx-pair-matrix');
    if (!container) return;
    if (st.pairBuilderLoading) {
        container.innerHTML = `<div class="idx-matrix-infographic">
            <div class="idx-infographic-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <rect x="4" y="4" width="40" height="40" rx="8" stroke="var(--accent)" stroke-width="1.5" opacity="0.3"/>
                    <rect class="idx-inf-cell" x="8" y="8" width="10" height="10" rx="3" fill="var(--green)" opacity="0.6"><animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.8s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="20" y="8" width="10" height="10" rx="3" fill="var(--accent)" opacity="0.4"><animate attributeName="opacity" values="0.2;0.7;0.2" dur="1.8s" begin="0.3s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="32" y="8" width="10" height="10" rx="3" fill="var(--red)" opacity="0.5"><animate attributeName="opacity" values="0.3;0.6;0.3" dur="1.8s" begin="0.6s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="8" y="20" width="10" height="10" rx="3" fill="var(--accent)" opacity="0.4"><animate attributeName="opacity" values="0.2;0.7;0.2" dur="1.8s" begin="0.2s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="20" y="20" width="10" height="10" rx="3" fill="var(--green)" opacity="0.6"><animate attributeName="opacity" values="0.3;0.9;0.3" dur="1.8s" begin="0.5s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="32" y="20" width="10" height="10" rx="3" fill="var(--accent)" opacity="0.3"><animate attributeName="opacity" values="0.2;0.6;0.2" dur="1.8s" begin="0.8s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="8" y="32" width="10" height="10" rx="3" fill="var(--red)" opacity="0.5"><animate attributeName="opacity" values="0.3;0.7;0.3" dur="1.8s" begin="0.4s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="20" y="32" width="10" height="10" rx="3" fill="var(--accent)" opacity="0.4"><animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.8s" begin="0.7s" repeatCount="indefinite"/></rect>
                    <rect class="idx-inf-cell" x="32" y="32" width="10" height="10" rx="3" fill="var(--green)" opacity="0.6"><animate attributeName="opacity" values="0.4;0.9;0.4" dur="1.8s" begin="1.0s" repeatCount="indefinite"/></rect>
                </svg>
            </div>
            <div class="idx-infographic-title">Building Correlation Matrix</div>
            <div class="idx-infographic-steps">
                <div class="idx-inf-step">
                    <div class="idx-inf-step-dot active"></div>
                    <span>Fetching top ${st.pairBuilderTopCount} winners & bottom ${st.pairBuilderBottomCount} losers</span>
                </div>
                <div class="idx-inf-step">
                    <div class="idx-inf-step-dot pending"></div>
                    <span>Computing pairwise β correlation & returns</span>
                </div>
                <div class="idx-inf-step">
                    <div class="idx-inf-step-dot pending"></div>
                    <span>Scoring & ranking ${st.pairBuilderLimit} best pairs</span>
                </div>
            </div>
            <div class="idx-infographic-bar-wrap">
                <div class="idx-infographic-bar">
                    <div class="idx-infographic-bar-fill"></div>
                </div>
            </div>
            <div class="idx-infographic-hint">Timeframe: <strong>${st.pairBuilderTimeframe}</strong> · analyzing ${st.pairBuilderTopCount * st.pairBuilderBottomCount} pair combinations</div>
        </div>`;
        return;
    }
    const rows = getPairRowsForRender();
    if (rows.length === 0) { container.innerHTML = '<div style="padding:14px; text-align:center; color:var(--text-muted); font-size:12px;">No pairs loaded. Click "Refresh Matrix".</div>'; return; }
    const sa = (col) => (st.pairBuilderSortColumn === col ? (st.pairBuilderSortDirection === 'asc' ? '↑' : '↓') : '');
    container.innerHTML = `<div style="max-height:460px; overflow:auto;"><table style="width:100%; border-collapse:collapse; font-size:11px;">
        <thead style="position:sticky; top:0; background:var(--bg-secondary); z-index:1;"><tr>
            <th data-pair-sort="pair" style="text-align:left; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Pair ${sa('pair')}</th>
            <th data-pair-sort="corr" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Corr ${sa('corr')}</th>
            <th data-pair-sort="beta" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Beta ${sa('beta')}</th>
            <th data-pair-sort="ret" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Ret ${sa('ret')}</th>
            <th data-pair-sort="score" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Score ${sa('score')}</th>
            <th data-pair-sort="copulaFamily" style="text-align:left; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Copula ${sa('copulaFamily')}</th>
            <th data-pair-sort="copulaTail" style="text-align:left; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Tail ${sa('copulaTail')}</th>
            <th data-pair-sort="vineScore" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Vine ${sa('vineScore')}</th>
            <th style="text-align:center; padding:8px; border-bottom:1px solid var(--border);">Long</th>
            <th style="text-align:center; padding:8px; border-bottom:1px solid var(--border);">Short</th>
            <th style="text-align:center; padding:8px; border-bottom:1px solid var(--border);">Del</th>
        </tr></thead><tbody>${rows.map(row => {
        const isL = st.pairBuilderLong.includes(row.pair), isS = st.pairBuilderShort.includes(row.pair);
        const pt = encodeURIComponent(row.pair);
        const cc = Math.abs(row.corr) >= 0.6 ? 'var(--green)' : 'var(--text-secondary)';
        const bc = Math.abs(row.beta - 1) <= 0.25 ? 'var(--green)' : 'var(--text-secondary)';
        const rc = row.ret >= 0 ? 'var(--green)' : 'var(--red)';
        const tc = row.copulaTail && row.copulaTail !== 'no_tail' ? 'var(--accent)' : 'var(--text-muted)';
        const vs = Number.isFinite(Number(row.vineScore)) ? Number(row.vineScore).toFixed(3) : '—';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
              <td style="padding:7px 8px; font-family:var(--font-mono); color:${row.isCustom ? 'var(--accent)' : 'var(--text-primary)'};">${row.pair}${row.isCustom ? ' *' : ''}</td>
              <td style="padding:7px 8px; text-align:right; color:${cc};">${row.corr.toFixed(3)}</td>
              <td style="padding:7px 8px; text-align:right; color:${bc};">${row.beta.toFixed(3)}</td>
              <td style="padding:7px 8px; text-align:right; color:${rc};">${(row.ret * 100).toFixed(2)}%</td>
              <td style="padding:7px 8px; text-align:right;">${row.score.toFixed(3)}</td>
              <td style="padding:7px 8px; text-align:left; font-family:var(--font-mono); color:${row.copulaFamily ? 'var(--text-primary)' : 'var(--text-muted)'};">${row.copulaFamily || '—'}</td>
              <td style="padding:7px 8px; text-align:left; font-family:var(--font-mono); color:${tc};">${row.copulaTail || '—'}</td>
              <td style="padding:7px 8px; text-align:right; color:${Number.isFinite(Number(row.vineScore)) ? 'var(--accent)' : 'var(--text-muted)'};">${vs}</td>
              <td style="padding:7px 8px; text-align:center;"><button data-pair-action="long" data-pair="${pt}" style="min-width:44px; padding:3px 7px; border-radius:4px; border:1px solid ${isL ? 'var(--green)' : 'var(--border)'}; background:${isL ? 'var(--green-bg)' : 'var(--bg-input)'}; color:${isL ? 'var(--green)' : 'var(--text-secondary)'}; cursor:pointer;">L</button></td>
              <td style="padding:7px 8px; text-align:center;"><button data-pair-action="short" data-pair="${pt}" style="min-width:44px; padding:3px 7px; border-radius:4px; border:1px solid ${isS ? 'var(--red)' : 'var(--border)'}; background:${isS ? 'var(--red-bg)' : 'var(--bg-input)'}; color:${isS ? 'var(--red)' : 'var(--text-secondary)'}; cursor:pointer;">S</button></td>
              <td style="padding:7px 8px; text-align:center;">${row.isCustom ? `<button data-pair-action="delete" data-pair="${pt}" style="min-width:38px; padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-input); color:var(--text-muted); cursor:pointer;">×</button>` : '—'}</td>
            </tr>`;
    }).join('')}</tbody></table></div>`;
}

// ── Pair matrix actions ──────────────────────────

export function onPairMatrixAction(event) {
    const sortTarget = event.target.closest('[data-pair-sort]');
    if (sortTarget) {
        const col = sortTarget.dataset.pairSort;
        if (st.pairBuilderSortColumn === col) st.pairBuilderSortDirection = st.pairBuilderSortDirection === 'asc' ? 'desc' : 'asc';
        else { st.pairBuilderSortColumn = col; st.pairBuilderSortDirection = ['pair', 'copulaFamily', 'copulaTail'].includes(col) ? 'asc' : 'desc'; }
        renderPairMatrix(); return;
    }
    const actionTarget = event.target.closest('[data-pair-action]');
    if (!actionTarget) return;
    const action = actionTarget.dataset.pairAction;
    const pair = decodeURIComponent(actionTarget.dataset.pair || '');
    if (!pair) return;
    if (action === 'long') {
        if (st.pairBuilderLong.includes(pair)) st.pairBuilderLong = st.pairBuilderLong.filter(x => x !== pair);
        else { st.pairBuilderLong = [...st.pairBuilderLong, pair]; st.pairBuilderShort = st.pairBuilderShort.filter(x => x !== pair); }
        savePairSelections(); renderPairBuilderSummary(); renderPairMatrix(); return;
    }
    if (action === 'short') {
        if (st.pairBuilderShort.includes(pair)) st.pairBuilderShort = st.pairBuilderShort.filter(x => x !== pair);
        else { st.pairBuilderShort = [...st.pairBuilderShort, pair]; st.pairBuilderLong = st.pairBuilderLong.filter(x => x !== pair); }
        savePairSelections(); renderPairBuilderSummary(); renderPairMatrix(); return;
    }
    if (action === 'delete') {
        st.pairMatrix = st.pairMatrix.filter(row => row.pair !== pair);
        st.pairBuilderLong = st.pairBuilderLong.filter(x => x !== pair);
        st.pairBuilderShort = st.pairBuilderShort.filter(x => x !== pair);
        removeCustomPair(pair); savePairSelections(); renderPairBuilderSummary(); renderPairMatrix();
    }
}

export function clearPairSelections() { st.pairBuilderLong = []; st.pairBuilderShort = []; savePairSelections(); renderPairBuilderSummary(); renderPairMatrix(); setPairStatus('Pair selections cleared.', 'info'); }
export function selectAllPairsLong() { const v = getPairRowsForRender().map(r => r.pair); st.pairBuilderLong = [...new Set([...st.pairBuilderLong, ...v])]; st.pairBuilderShort = st.pairBuilderShort.filter(x => !v.includes(x)); savePairSelections(); renderPairBuilderSummary(); renderPairMatrix(); setPairStatus(`Selected ${v.length} pairs as Long.`, 'success'); }
export function selectAllPairsShort() { const v = getPairRowsForRender().map(r => r.pair); st.pairBuilderShort = [...new Set([...st.pairBuilderShort, ...v])]; st.pairBuilderLong = st.pairBuilderLong.filter(x => !v.includes(x)); savePairSelections(); renderPairBuilderSummary(); renderPairMatrix(); setPairStatus(`Selected ${v.length} pairs as Short.`, 'success'); }

// ── Kline helpers ────────────────────────────────

async function fetchCloseSeries(symbol, interval, limit = 300) {
    const key = `${symbol}:${interval}:${limit}`;
    const cached = st.pairKlineCache.get(key);
    if (cached) return cached;
    const data = await api(`/trade/klines?${new URLSearchParams({ symbol, interval, limit: String(limit) })}`);
    const out = Array.isArray(data) ? data.map(k => ({ time: Number(k?.[0]), close: Number(k?.[4]) })).filter(x => Number.isFinite(x.time) && Number.isFinite(x.close)) : [];
    st.pairKlineCache.set(key, out);
    return out;
}

async function computePairStatsForBases(leftBase, rightBase) {
    const l = resolveSymbolByBase(leftBase), r = resolveSymbolByBase(rightBase);
    if (!l || !r) return null;
    const pair = `${normalizeBaseInput(leftBase)}/${normalizeBaseInput(rightBase)}`;
    const [ls, rs] = await Promise.all([fetchCloseSeries(l, st.pairBuilderTimeframe, 300), fetchCloseSeries(r, st.pairBuilderTimeframe, 300)]);
    return computePairStatsFromSeries(pair, ls, rs);
}

async function buildPairMatrixFromTopBottom() {
    const tickers = await api('/trade/symbols/tickers');
    const rows = Array.isArray(tickers) ? tickers.filter(x => typeof x?.symbol === 'string' && Number.isFinite(Number(x?.change24h))) : [];
    if (rows.length < 10) return [];
    const sorted = [...rows].sort((a, b) => Number(b.change24h) - Number(a.change24h));
    const top = sorted.slice(0, st.pairBuilderTopCount);
    const bottom = [...sorted].reverse().slice(0, st.pairBuilderBottomCount);
    const universe = [...new Set([...top, ...bottom].map(x => x.symbol))];
    const seriesBySymbol = new Map();
    await Promise.all(universe.map(async symbol => {
        try { const s = await fetchCloseSeries(symbol, st.pairBuilderTimeframe, 300); if (s.length >= 60) seriesBySymbol.set(symbol, s); } catch (err) { console.warn('[PairBuilder] kline fetch failed:', symbol, err?.message || err); }
    }));
    const pairRows = [];
    for (const winner of top) for (const loser of bottom) {
        if (!winner?.symbol || !loser?.symbol || winner.symbol === loser.symbol) continue;
        const ls = seriesBySymbol.get(winner.symbol), rs = seriesBySymbol.get(loser.symbol);
        if (!ls || !rs) continue;
        const pair = `${baseFromSymbol(winner.symbol)}/${baseFromSymbol(loser.symbol)}`;
        const stats = computePairStatsFromSeries(pair, ls, rs);
        if (!stats) continue;
        pairRows.push({ ...stats, score: scorePairStats(stats), winnerChange24h: Number(winner.change24h) || 0, loserChange24h: Number(loser.change24h) || 0, isCustom: false });
    }
    const byPair = new Map();
    for (const row of pairRows) { const existing = byPair.get(row.pair); if (!existing || row.score > existing.score) byPair.set(row.pair, row); }
    return [...byPair.values()].sort((a, b) => b.score - a.score).slice(0, st.pairBuilderLimit);
}

export async function refreshPairMatrixFromControls() {
    if (st.pairBuilderLoading) return;
    st.pairBuilderTimeframe = document.getElementById('idx-pair-timeframe')?.value || st.pairBuilderTimeframe;
    st.pairBuilderTopCount = clampInt(document.getElementById('idx-pair-top')?.value, 5, 50, 20);
    st.pairBuilderBottomCount = clampInt(document.getElementById('idx-pair-bottom')?.value, 5, 50, 20);
    st.pairBuilderLimit = clampInt(document.getElementById('idx-pair-limit')?.value, 20, 500, 200);
    const ti = document.getElementById('idx-pair-top'), bi = document.getElementById('idx-pair-bottom'), li = document.getElementById('idx-pair-limit');
    if (ti) ti.value = st.pairBuilderTopCount; if (bi) bi.value = st.pairBuilderBottomCount; if (li) li.value = st.pairBuilderLimit;
    st.pairBuilderLoading = true; renderPairMatrix();
    setPairStatus('Building beta/correlation matrix from top winners vs lowest losers…', 'info');
    try {
        if (!st.symbolsLoaded) await loadAllSymbols();
        await loadVinePairSignals();
        const generated = await buildPairMatrixFromTopBottom();
        st.pairMatrix = mergePairRowsWithCustom(generated);
        const pairNames = new Set(st.pairMatrix.map(x => x.pair));
        st.pairBuilderLong = st.pairBuilderLong.filter(x => pairNames.has(x));
        st.pairBuilderShort = st.pairBuilderShort.filter(x => pairNames.has(x));
        savePairSelections();
        const vt = st.vinePairSignalMap.size > 0 ? ` Vine signals: ${st.vinePairSignalMap.size}.` : '';
        setPairStatus(`Matrix ready: ${st.pairMatrix.length} pairs (${st.pairBuilderLong.length} long, ${st.pairBuilderShort.length} short).${vt}`, 'success');
    } catch (err) {
        const msg = err?.message || 'Failed to build pair matrix';
        showToast(msg, 'error'); setPairStatus(msg, 'error');
    } finally { st.pairBuilderLoading = false; renderPairBuilderSummary(); renderPairMatrix(); }
}

export async function addCustomPairFromInputs() {
    const left = normalizeBaseInput(document.getElementById('idx-pair-base')?.value || '');
    const right = normalizeBaseInput(document.getElementById('idx-pair-quote')?.value || '');
    if (!left || !right) { showToast('Enter both base and quote symbols', 'error'); return; }
    if (left === right) { showToast('Base and quote must be different', 'error'); return; }
    try {
        if (!st.symbolsLoaded) await loadAllSymbols();
        await loadVinePairSignals();
        const stats = await computePairStatsForBases(left, right);
        if (!stats) { showToast(`Not enough data for ${left}/${right}`, 'error'); return; }
        const custom = enrichPairRowWithVine({ ...stats, score: scorePairStats(stats), isCustom: true });
        addCustomPair(custom); st.pairMatrix = mergePairRowsWithCustom(st.pairMatrix);
        setPairStatus(`Saved custom pair ${custom.pair}.`, 'success'); renderPairMatrix();
    } catch (err) { showToast(err?.message || 'Failed to add custom pair', 'error'); }
}

export function openPairBuilder() {
    const overlay = document.getElementById('idx-pair-overlay');
    if (!overlay) return;
    overlay.style.display = ''; st.pairBuilderVisible = true;
    if (st.pairMatrix.length === 0) st.pairMatrix = mergePairRowsWithCustom([]);
    const searchInput = document.getElementById('idx-pair-search');
    if (searchInput) searchInput.value = st.pairBuilderSearch;
    if (!st.symbolsLoaded) loadAllSymbols();
    loadVinePairSignals().then(() => { st.pairMatrix = mergePairRowsWithCustom(st.pairMatrix); renderPairBuilderSummary(); renderPairMatrix(); });
    renderTopIndexPicks(); renderPairBuilderSummary(); renderPairMatrix();
    switchPairBuilderTab(st.pairBuilderTab);
    if (st.pairBuilderTab === 'matrix') {
        if (!st.pairMatrix.some(x => !x.isCustom)) refreshPairMatrixFromControls();
        else setPairStatus(`Loaded ${st.pairMatrix.length} pairs (${st.pairBuilderLong.length} long, ${st.pairBuilderShort.length} short).`, 'info');
    }
}

export function closePairBuilder() { st.pairBuilderVisible = false; const o = document.getElementById('idx-pair-overlay'); if (o) o.style.display = 'none'; }

export async function savePairBuilderIndex() {
    if (!st.symbolsLoaded) await loadAllSymbols();
    const rawName = document.getElementById('idx-pair-name')?.value || '';
    const name = rawName.trim() || `Beta ${st.pairBuilderTopCount}x${st.pairBuilderBottomCount} (${st.pairBuilderTimeframe})`;
    const weights = computePairBuilderWeightsFromSelection();
    if (!weights) { showToast('Select at least one long or short pair first', 'error'); return; }
    const formula = pairWeightsToFormula(weights, 'kingfisher');
    if (formula.length < 2) { showToast('Need at least 2 symbols after weighting', 'error'); return; }
    st.indexes.push({ id: genId(), name, formula }); saveIndexes(); renderIndexList();
    selectIndex(st.indexes[st.indexes.length - 1].id); closePairBuilder();
    showToast(`Index created from beta pairs: ${name}`, 'success');
}

// ── Top picks tab ────────────────────────────────

export function renderTopIndexPicks() {
    const container = document.getElementById('idx-top-picks');
    if (!container) return;
    if (st.topIndexPicksLoading) { container.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:12px;">Computing top index picks…</div>'; return; }
    if (!st.topIndexPicks.length) { container.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:12px;">No top picks available yet.</div>'; return; }
    const renderSection = (title, subtitle, picks, emptyText = 'No entries') => {
        if (!Array.isArray(picks) || picks.length === 0) return `<div class="idx-pick-section"><div class="idx-pick-section-head"><div class="idx-pick-section-title">${title}</div><div class="idx-pick-section-sub">${subtitle}</div></div><div style="padding:10px; color:var(--text-muted); font-size:11px;">${emptyText}</div></div>`;
        return `<div class="idx-pick-section"><div class="idx-pick-section-head"><div class="idx-pick-section-title">${title}</div><div class="idx-pick-section-sub">${subtitle}</div></div><div class="idx-top-picks-grid">${picks.map(pick => {
            const rank = Number(pick.rank) || 0, medal = medalIcon(pick.medal, rank);
            const partners = Array.isArray(pick.partners) ? pick.partners.join(', ') : '';
            const z = Number(pick?.metrics?.cmpiZLast), mis = Number(pick?.metrics?.mispricingLast), half = Number(pick?.metrics?.cmpiHalfLife), vol = Number(pick?.volatility?.cmpiVolatility), conf = Number(pick?.confidence);
            const fam = Array.isArray(pick.edgeFamilies) ? pick.edgeFamilies.slice(0, 3).join(', ') : '';
            const pickId = encodeURIComponent(pick.id), recSide = pick?.recommendedSide === 'SHORT' ? 'SHORT' : 'LONG';
            return `<div class="${topPickCardClass(rank)}"><div class="idx-top-pick-head"><div class="idx-top-pick-medal">${medal} #${rank}</div><div class="idx-top-pick-type">${basketTypeLabel(pick.basketType)}</div></div><div class="idx-top-pick-title">${pick.title || basketTypeLabel(pick.basketType)}</div><div class="idx-top-pick-direction">Recommended: ${recommendationSideBadge(pick.recommendedSide)}</div><div class="idx-top-pick-metrics"><span>z ${Number.isFinite(z) ? z.toFixed(2) : '—'}</span><span>mis ${Number.isFinite(mis) ? mis.toFixed(3) : '—'}</span><span>hl ${Number.isFinite(half) ? half.toFixed(1) : '—'}</span><span>vol ${Number.isFinite(vol) ? vol.toFixed(4) : '—'}</span><span>conf ${Number.isFinite(conf) ? (conf * 100).toFixed(0) : '—'}%</span></div><div class="idx-top-pick-partners">Basket: ${partners || '—'}</div><div class="idx-top-pick-family">Copula: ${fam || '—'}</div><div class="idx-top-pick-actions"><button class="btn btn-outline btn-sm" data-pick-action="import" data-pick-id="${pickId}">Import</button><button class="btn btn-outline btn-sm" data-pick-action="trade" data-pick-id="${pickId}" data-pick-side="LONG">Long 1-Click</button><button class="btn btn-outline btn-sm" data-pick-action="trade" data-pick-id="${pickId}" data-pick-side="SHORT">Short 1-Click</button><button class="btn btn-primary btn-sm" data-pick-action="trade" data-pick-id="${pickId}" data-pick-side="${recSide}">Trade ${recSide}</button></div></div>`;
        }).join('')}</div></div>`;
    };
    const rec = st.topIndexRecommendations || defaultTopRecommendations();
    container.innerHTML = `${renderSection('Long Now', 'Mean-reversion entries for immediate long exposure', rec.longNow, 'No long recommendation right now')}${renderSection('Short Now', 'Spread conditions favor short exposure', rec.shortNow, 'No short recommendation right now')}${renderSection('Most Volatile', 'Highest CMPi volatility setups', rec.mostVolatile, 'No volatility ranking available')}${renderSection('Diversified Set', 'Different basket styles to choose from', rec.diversified, 'No diversified picks available')}`;
}

export async function loadTopIndexPicks(force = false) {
    if (st.topIndexPicksLoading) return;
    if (!force && st.topIndexPicks.length > 0) { renderTopIndexPicks(); return; }
    st.topIndexPicksLoading = true; renderTopIndexPicks();
    setTopPicksStatus(force ? 'Rebuilding smart index picks (force refresh)…' : 'Loading top 5 precomputed index picks…', 'info');
    try {
        const qs = force ? '?limit=5&refresh=true' : '?limit=5';
        const payload = await api(`/trade/vine/top-indexes${qs}`);
        st.topIndexPicks = Array.isArray(payload?.rows) ? payload.rows : [];
        st.topIndexRecommendations = payload?.recommendations || defaultTopRecommendations();
        st.topIndexPicksSource = payload?.sourceFile || null;
        st.topIndexPicksGeneratedAt = payload?.generatedAt || null;
        if (st.topIndexPicks.length === 0) setTopPicksStatus('No ranked picks found. Run decision generation in debug.', 'error');
        else { const src = st.topIndexPicksSource ? ` from ${st.topIndexPicksSource}` : ''; const ts = st.topIndexPicksGeneratedAt ? ` @ ${new Date(st.topIndexPicksGeneratedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''; setTopPicksStatus(`Loaded smart picks${src}${ts} · long:${st.topIndexRecommendations?.longNow?.length || 0} short:${st.topIndexRecommendations?.shortNow?.length || 0}.`, 'success'); }
    } catch (err) { st.topIndexPicks = []; st.topIndexRecommendations = defaultTopRecommendations(); setTopPicksStatus(err?.message || 'Failed to load top picks', 'error'); }
    finally { st.topIndexPicksLoading = false; renderTopIndexPicks(); }
}

export function onTopPickAction(event) {
    const btn = event.target.closest('[data-pick-action]');
    if (!btn) return;
    const id = decodeURIComponent(btn.dataset.pickId || '');
    if (!id) return;
    if (btn.dataset.pickAction === 'import') { importTopPick(id); return; }
    if (btn.dataset.pickAction === 'trade') tradeTopPick(id, btn.dataset.pickSide === 'SHORT' ? 'SHORT' : 'LONG');
}

function importTopPick(pickId) {
    const pick = findTopPickById(pickId);
    if (!pick || !Array.isArray(pick.formula) || pick.formula.length < 2) { showToast('Pick formula is not available', 'error'); return; }
    const id = upsertTopPickIndex(pick); saveIndexes(); renderIndexList(); selectIndex(id); closePairBuilder();
    showToast(`Imported top pick: ${basketTypeLabel(pick.basketType)}`, 'success');
}

async function tradeTopPick(pickId, side) {
    const pick = findTopPickById(pickId);
    if (!pick || !Array.isArray(pick.formula) || pick.formula.length < 2) { showToast('Pick formula is not available', 'error'); return; }
    const id = upsertTopPickIndex(pick); saveIndexes(); renderIndexList(); selectIndex(id); closePairBuilder();
    const { executeBasket } = await import('./basket-execution.js');
    await executeBasket(side);
}

// ── All Symbols tab ──────────────────────────────

export async function loadAllTickers(force = false) {
    if (st.allTickerLoading) return;
    if (!force && st.allTickerRows.length > 0) { renderSymbolTable(); return; }
    st.allTickerLoading = true; renderSymbolTable();
    setSymbolTabStatus('Fetching all tickers…', 'info');
    try {
        if (!st.symbolsLoaded) await loadAllSymbols();
        const tickers = await api('/trade/symbols/tickers');
        if (!Array.isArray(tickers) || tickers.length === 0) { st.allTickerRows = []; setSymbolTabStatus('No tickers returned.', 'error'); }
        else {
            st.allTickerRows = tickers.filter(x => typeof x?.symbol === 'string').map(x => {
                const base = baseFromSymbol(x.symbol);
                return { symbol: x.symbol, base, price: Number(x.lastPrice) || Number(x.last) || 0, change24h: Number(x.change24h) || 0, volume: Number(x.quoteVolume) || Number(x.volume) || 0 };
            }).sort((a, b) => b.change24h - a.change24h);
            setSymbolTabStatus(`Loaded ${st.allTickerRows.length} symbols.`, 'success');
        }
    } catch (err) { st.allTickerRows = []; setSymbolTabStatus(err?.message || 'Failed to load tickers', 'error'); }
    finally { st.allTickerLoading = false; renderSymbolTabSummary(); renderSymbolTable(); }
}

function getSymbolRowsForRender() {
    let rows = st.allTickerRows;
    if (st.allTickerSearch) rows = rows.filter(r => r.base.includes(st.allTickerSearch) || r.symbol.includes(st.allTickerSearch));
    const dir = st.allTickerSortDir === 'asc' ? 1 : -1;
    if (st.allTickerSortCol === 'base') return [...rows].sort((a, b) => a.base.localeCompare(b.base) * dir);
    return [...rows].sort((a, b) => ((Number(a[st.allTickerSortCol]) || 0) - (Number(b[st.allTickerSortCol]) || 0)) * dir);
}

export function renderSymbolTabSummary() {
    const el = document.getElementById('idx-sym-summary');
    if (el) el.textContent = `${st.symbolSelLong.length} long · ${st.symbolSelShort.length} short · ${st.allTickerRows.length} total symbols`;
}

export function renderSymbolTable() {
    const container = document.getElementById('idx-sym-table');
    if (!container) return;
    if (st.allTickerLoading) { container.innerHTML = '<div style="padding:14px; text-align:center; color:var(--text-muted); font-size:12px;">Loading all symbols…</div>'; return; }
    const rows = getSymbolRowsForRender();
    if (rows.length === 0) { container.innerHTML = '<div style="padding:14px; text-align:center; color:var(--text-muted); font-size:12px;">No symbols found. Click Refresh.</div>'; return; }
    const sa = col => (st.allTickerSortCol === col ? (st.allTickerSortDir === 'asc' ? '↑' : '↓') : '');
    container.innerHTML = `<div style="max-height:460px; overflow:auto;"><table style="width:100%; border-collapse:collapse; font-size:11px;">
        <thead style="position:sticky; top:0; background:var(--bg-secondary); z-index:1;"><tr>
            <th data-sym-sort="base" style="text-align:left; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Symbol ${sa('base')}</th>
            <th data-sym-sort="price" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Price ${sa('price')}</th>
            <th data-sym-sort="change24h" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">24h% ${sa('change24h')}</th>
            <th data-sym-sort="volume" style="text-align:right; padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">Volume ${sa('volume')}</th>
            <th style="text-align:center; padding:8px; border-bottom:1px solid var(--border);">Long</th>
            <th style="text-align:center; padding:8px; border-bottom:1px solid var(--border);">Short</th>
        </tr></thead><tbody>${rows.map(row => {
        const isL = st.symbolSelLong.includes(row.base), isS = st.symbolSelShort.includes(row.base);
        const bt = encodeURIComponent(row.base), cc = row.change24h >= 0 ? 'var(--green)' : 'var(--red)';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
              <td style="padding:7px 8px; font-family:var(--font-mono); color:var(--text-primary);">${row.base}</td>
              <td style="padding:7px 8px; text-align:right; color:var(--text-secondary);">${row.price ? formatPrice(row.price) : '—'}</td>
              <td style="padding:7px 8px; text-align:right; color:${cc};">${(row.change24h * 100).toFixed(2)}%</td>
              <td style="padding:7px 8px; text-align:right; color:var(--text-muted);">${row.volume >= 1e6 ? (row.volume / 1e6).toFixed(1) + 'M' : row.volume >= 1e3 ? (row.volume / 1e3).toFixed(1) + 'K' : row.volume.toFixed(0)}</td>
              <td style="padding:7px 8px; text-align:center;"><button data-sym-action="long" data-sym-base="${bt}" style="min-width:44px; padding:3px 7px; border-radius:4px; border:1px solid ${isL ? 'var(--green)' : 'var(--border)'}; background:${isL ? 'var(--green-bg)' : 'var(--bg-input)'}; color:${isL ? 'var(--green)' : 'var(--text-secondary)'}; cursor:pointer;">L</button></td>
              <td style="padding:7px 8px; text-align:center;"><button data-sym-action="short" data-sym-base="${bt}" style="min-width:44px; padding:3px 7px; border-radius:4px; border:1px solid ${isS ? 'var(--red)' : 'var(--border)'}; background:${isS ? 'var(--red-bg)' : 'var(--bg-input)'}; color:${isS ? 'var(--red)' : 'var(--text-secondary)'}; cursor:pointer;">S</button></td>
            </tr>`;
    }).join('')}</tbody></table></div>`;
}

export function onSymbolTableAction(event) {
    const sortTarget = event.target.closest('[data-sym-sort]');
    if (sortTarget) {
        const col = sortTarget.dataset.symSort;
        if (st.allTickerSortCol === col) st.allTickerSortDir = st.allTickerSortDir === 'asc' ? 'desc' : 'asc';
        else { st.allTickerSortCol = col; st.allTickerSortDir = col === 'base' ? 'asc' : 'desc'; }
        renderSymbolTable(); return;
    }
    const actionTarget = event.target.closest('[data-sym-action]');
    if (!actionTarget) return;
    const action = actionTarget.dataset.symAction, base = decodeURIComponent(actionTarget.dataset.symBase || '');
    if (!base) return;
    if (action === 'long') { if (st.symbolSelLong.includes(base)) st.symbolSelLong = st.symbolSelLong.filter(x => x !== base); else { st.symbolSelLong = [...st.symbolSelLong, base]; st.symbolSelShort = st.symbolSelShort.filter(x => x !== base); } }
    else if (action === 'short') { if (st.symbolSelShort.includes(base)) st.symbolSelShort = st.symbolSelShort.filter(x => x !== base); else { st.symbolSelShort = [...st.symbolSelShort, base]; st.symbolSelLong = st.symbolSelLong.filter(x => x !== base); } }
    renderSymbolTabSummary(); renderSymbolTable();
}

export function selectAllSymbolsLong() { const v = getSymbolRowsForRender().map(r => r.base); st.symbolSelLong = [...new Set([...st.symbolSelLong, ...v])]; st.symbolSelShort = st.symbolSelShort.filter(x => !v.includes(x)); renderSymbolTabSummary(); renderSymbolTable(); setSymbolTabStatus(`Selected ${v.length} symbols as Long.`, 'success'); }
export function selectAllSymbolsShort() { const v = getSymbolRowsForRender().map(r => r.base); st.symbolSelShort = [...new Set([...st.symbolSelShort, ...v])]; st.symbolSelLong = st.symbolSelLong.filter(x => !v.includes(x)); renderSymbolTabSummary(); renderSymbolTable(); setSymbolTabStatus(`Selected ${v.length} symbols as Short.`, 'success'); }
export function clearSymbolSelections() { st.symbolSelLong = []; st.symbolSelShort = []; renderSymbolTabSummary(); renderSymbolTable(); setSymbolTabStatus('Symbol selections cleared.', 'info'); }

export function saveSymbolTabIndex() {
    if (st.symbolSelLong.length === 0 && st.symbolSelShort.length === 0) { showToast('Select at least one symbol first', 'error'); return; }
    const rawName = document.getElementById('idx-sym-name')?.value || '';
    const name = rawName.trim() || `All Symbols (${st.symbolSelLong.length}L ${st.symbolSelShort.length}S)`;
    const formula = [];
    const equalWeight = 1 / (st.symbolSelLong.length + st.symbolSelShort.length);
    for (const base of st.symbolSelLong) { const symbol = resolveSymbolByBase(base); if (symbol) formula.push({ symbol, factor: equalWeight }); }
    for (const base of st.symbolSelShort) { const symbol = resolveSymbolByBase(base); if (symbol) formula.push({ symbol, factor: -equalWeight }); }
    if (formula.length < 2) { showToast('Need at least 2 resolvable symbols', 'error'); return; }
    st.indexes.push({ id: genId(), name, formula }); saveIndexes(); renderIndexList();
    selectIndex(st.indexes[st.indexes.length - 1].id); closePairBuilder();
    showToast(`Index created: ${name} (${formula.length} legs)`, 'success');
}

// ── Tab switching ────────────────────────────────

export function switchPairBuilderTab(tab) {
    st.pairBuilderTab = ['picks', 'symbols'].includes(tab) ? tab : 'matrix';
    document.querySelectorAll('[data-builder-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.builderTab === st.pairBuilderTab));
    const mp = document.getElementById('idx-pair-panel-matrix'), pp = document.getElementById('idx-pair-panel-picks'), sp = document.getElementById('idx-pair-panel-symbols');
    if (mp) mp.style.display = st.pairBuilderTab === 'matrix' ? '' : 'none';
    if (pp) pp.style.display = st.pairBuilderTab === 'picks' ? '' : 'none';
    if (sp) sp.style.display = st.pairBuilderTab === 'symbols' ? '' : 'none';
    if (st.pairBuilderTab === 'matrix') { renderPairBuilderSummary(); renderPairMatrix(); }
    else if (st.pairBuilderTab === 'picks') { renderTopIndexPicks(); if (st.topIndexPicks.length === 0) loadTopIndexPicks(); }
    else if (st.pairBuilderTab === 'symbols') { renderSymbolTabSummary(); renderSymbolTable(); if (st.allTickerRows.length === 0) loadAllTickers(); }
}

// ── Active basket tracking & UPNL streaming ─────
import { state } from '../../core/index.js';
import { streams } from '../../lib/binance-streams.js';
import { st, genId } from './state.js';

const LS_BASKETS_KEY = 'pms_active_baskets';

function toFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function normalizeTrackedLeg(leg, fallbackLeverage = st.leverage) {
    if (!leg?.symbol || !leg?.side) return null;
    const quantity = Math.max(0, toFiniteNumber(leg.quantity, 0));
    const entryPrice = Math.max(0, toFiniteNumber(leg.entryPrice, 0));
    const notionalRaw = Math.max(0, toFiniteNumber(leg.notional, 0));
    const notional = notionalRaw > 0 ? notionalRaw : quantity * entryPrice;
    const leverageUsed = Math.max(1, toFiniteNumber(fallbackLeverage, 1));
    const marginRaw = Math.max(0, toFiniteNumber(leg.margin, 0));
    const margin = marginRaw > 0 ? marginRaw : (notional > 0 ? notional / leverageUsed : 0);

    return {
        symbol: String(leg.symbol),
        side: String(leg.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
        positionId: leg.positionId || null,
        entryPrice, quantity, notional, margin,
    };
}

export function mergeTrackedLegs(existingLegs = [], incomingLegs = []) {
    const merged = new Map();

    const ingest = (rawLeg) => {
        const leg = normalizeTrackedLeg(rawLeg);
        if (!leg) return;
        const key = `${leg.symbol}::${leg.side}`;
        const current = merged.get(key);
        if (!current) { merged.set(key, { ...leg }); return; }

        const newQty = current.quantity + leg.quantity;
        const weightedEntry = newQty > 0
            ? ((current.entryPrice * current.quantity) + (leg.entryPrice * leg.quantity)) / newQty
            : 0;

        current.quantity = newQty;
        current.entryPrice = weightedEntry;
        current.notional = Math.max(0, current.notional + leg.notional);
        current.margin = Math.max(0, current.margin + leg.margin);
        if (leg.positionId) current.positionId = leg.positionId;
    };

    existingLegs.forEach(ingest);
    incomingLegs.forEach(ingest);

    return [...merged.values()].sort((a, b) => {
        if (a.symbol === b.symbol) return a.side.localeCompare(b.side);
        return a.symbol.localeCompare(b.symbol);
    });
}

function getBasketStackKey(basket) {
    const accountKey = basket.subAccountId || '';
    const indexKey = basket.indexId || basket.indexName || '';
    return `${accountKey}::${indexKey}::${basket.direction || 'LONG'}`;
}

export function compactActiveBaskets(raw) {
    const input = Array.isArray(raw) ? raw : [];
    const merged = new Map();
    let changed = !Array.isArray(raw);

    for (const basket of input) {
        if (!basket || typeof basket !== 'object') { changed = true; continue; }

        const openedAt = Math.max(1, toFiniteNumber(basket.timestamp, Date.now()));
        const lastExecutionAt = Math.max(openedAt, toFiniteNumber(basket.lastExecutionAt, openedAt));
        const sourceLegs = Array.isArray(basket.legs)
            ? basket.legs
            : (Array.isArray(basket.results) ? basket.results : []);
        const normalizedLegs = sourceLegs
            .map((leg) => normalizeTrackedLeg(leg, basket.leverage))
            .filter(Boolean);

        const normalized = {
            id: basket.id || genId(),
            indexId: basket.indexId || null,
            indexName: basket.indexName || 'Unnamed Index',
            direction: String(basket.direction).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
            subAccountId: basket.subAccountId || null,
            timestamp: openedAt,
            lastExecutionAt,
            executionCount: Math.max(1, Math.round(toFiniteNumber(basket.executionCount, 1))),
            tradeSize: Math.max(0, toFiniteNumber(basket.tradeSize, 0)),
            leverage: Math.max(1, toFiniteNumber(basket.leverage, st.leverage)),
            legs: normalizedLegs,
        };

        if (!basket.id || !basket.indexName || !Array.isArray(basket.legs)) changed = true;

        const key = getBasketStackKey(normalized);
        const existing = merged.get(key);
        if (!existing) { merged.set(key, normalized); continue; }

        changed = true;
        existing.timestamp = Math.min(existing.timestamp, normalized.timestamp);
        existing.lastExecutionAt = Math.max(existing.lastExecutionAt, normalized.lastExecutionAt);
        existing.executionCount += normalized.executionCount;
        existing.tradeSize += normalized.tradeSize;
        existing.leverage = normalized.leverage || existing.leverage;
        if (!existing.indexId && normalized.indexId) existing.indexId = normalized.indexId;
        if (!existing.subAccountId && normalized.subAccountId) existing.subAccountId = normalized.subAccountId;
        existing.legs = mergeTrackedLegs(existing.legs, normalized.legs);
    }

    return { baskets: [...merged.values()], changed };
}

export function setActiveBaskets(baskets) {
    try { localStorage.setItem(LS_BASKETS_KEY, JSON.stringify(baskets)); } catch { }
}

export function getActiveBaskets() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LS_BASKETS_KEY) || '[]');
        const { baskets, changed } = compactActiveBaskets(parsed);
        if (changed) setActiveBaskets(baskets);
        return baskets;
    } catch {
        return [];
    }
}

export function storeActiveBasket(index, direction, result) {
    const now = Date.now();
    const normalizedDirection = String(direction).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const thisAccountId = state.currentAccount || null;
    const leverageUsed = Math.max(1, toFiniteNumber(st.leverage, 1));
    const executionTradeSize = Math.max(0, toFiniteNumber(st.tradeSize, 0));
    const executionLegs = (result.results || [])
        .filter((r) => r?.success)
        .map((r) => normalizeTrackedLeg({
            symbol: r.symbol,
            side: r.side,
            positionId: r.trade?.position?.id || null,
            entryPrice: toFiniteNumber(r.trade?.price, toFiniteNumber(r.trade?.position?.entryPrice, 0)),
            quantity: toFiniteNumber(r.trade?.quantity, toFiniteNumber(r.trade?.position?.quantity, 0)),
            notional: toFiniteNumber(r.trade?.notional, toFiniteNumber(r.trade?.position?.notional, 0)),
            margin: toFiniteNumber(r.trade?.position?.margin, 0),
        }, leverageUsed))
        .filter(Boolean);

    if (executionLegs.length === 0) return;

    const baskets = getActiveBaskets();
    const idx = baskets.findIndex((b) => {
        const sameDirection = b.direction === normalizedDirection;
        const sameAccount = (b.subAccountId || thisAccountId) === thisAccountId;
        const sameIndexId = b.indexId && index.id ? b.indexId === index.id : false;
        const sameIndexName = !sameIndexId && String(b.indexName || '') === String(index.name || '');
        return sameDirection && sameAccount && (sameIndexId || sameIndexName);
    });

    if (idx >= 0) {
        const existing = baskets[idx];
        existing.indexId = existing.indexId || index.id || null;
        existing.indexName = existing.indexName || index.name;
        existing.timestamp = Math.min(toFiniteNumber(existing.timestamp, now), now);
        existing.lastExecutionAt = now;
        existing.executionCount = Math.max(1, Math.round(toFiniteNumber(existing.executionCount, 1))) + 1;
        existing.tradeSize = Math.max(0, toFiniteNumber(existing.tradeSize, 0)) + executionTradeSize;
        existing.leverage = leverageUsed;
        existing.subAccountId = existing.subAccountId || thisAccountId;
        existing.legs = mergeTrackedLegs(existing.legs || [], executionLegs);
    } else {
        baskets.push({
            id: genId(),
            indexId: index.id || null,
            indexName: index.name,
            direction: normalizedDirection,
            subAccountId: thisAccountId,
            timestamp: now,
            lastExecutionAt: now,
            executionCount: 1,
            tradeSize: executionTradeSize,
            leverage: leverageUsed,
            legs: executionLegs,
        });
    }

    setActiveBaskets(baskets);
}

function getBasketTimeHeld(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '0m';
    const ms = Date.now() - ts;
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

// ── Live price streams ───────────────────────────

export function connectBasketPriceStreams(baskets) {
    const neededSymbols = new Set();
    for (const b of baskets) {
        const legs = b.legs || b.results || [];
        for (const leg of legs) {
            if (leg.symbol && leg.entryPrice) neededSymbols.add(leg.symbol);
        }
    }

    for (const sym of Object.keys(st.basketPriceUnsubs)) {
        if (!neededSymbols.has(sym)) {
            try { st.basketPriceUnsubs[sym](); } catch { }
            delete st.basketPriceUnsubs[sym];
        }
    }

    for (const sym of neededSymbols) {
        if (st.basketPriceUnsubs[sym]) continue;
        const raw = sym.replace('/', '').replace(':USDT', '').toLowerCase();
        const wsSymbol = raw.endsWith('usdt') ? raw : raw + 'usdt';

        st.basketPriceUnsubs[sym] = streams.subscribe(`${wsSymbol}@markPrice@1s`, (data) => {
            try {
                const markPrice = parseFloat(data.p);
                if (!markPrice || isNaN(markPrice)) return;
                st.basketLatestPrices[sym] = markPrice;
            } catch { }
        });
    }
}

export function updateBasketUpnl() {
    const baskets = getActiveBaskets();
    for (const b of baskets) {
        const legs = b.legs || b.results || [];
        let totalUpnl = 0;
        let hasLive = false;

        const card = document.querySelector(`[data-basket-id="${b.id}"]`);
        if (!card) continue;

        const legDivs = card.querySelectorAll('[style*="padding:2px 0"]');
        legs.forEach((leg, i) => {
            const lp = st.basketLatestPrices[leg.symbol];
            if (!lp || !leg.entryPrice || !leg.quantity) return;
            hasLive = true;
            const upnl = leg.side === 'LONG'
                ? (lp - leg.entryPrice) * leg.quantity
                : (leg.entryPrice - lp) * leg.quantity;
            totalUpnl += upnl;

            if (legDivs[i]) {
                const valSpan = legDivs[i].querySelector('span:last-child');
                if (valSpan) {
                    const pnlColor = upnl >= 0 ? 'var(--green)' : 'var(--red)';
                    valSpan.style.color = pnlColor;
                    valSpan.textContent = (upnl >= 0 ? '+' : '') + '$' + Math.abs(upnl).toFixed(2);
                }
            }
        });

        const totalEl = card.querySelector(`[data-basket-upnl="${b.id}"]`);
        if (totalEl && hasLive) {
            const color = totalUpnl >= 0 ? 'var(--green)' : 'var(--red)';
            totalEl.style.color = color;
            totalEl.textContent = (totalUpnl >= 0 ? '+' : '') + '$' + Math.abs(totalUpnl).toFixed(2);
        }
    }
}

export function cleanupBasketWs() {
    for (const sym of Object.keys(st.basketPriceUnsubs)) {
        try { st.basketPriceUnsubs[sym](); } catch { }
    }
    st.basketPriceUnsubs = {};
    st.basketLatestPrices = {};
    if (st.basketUpnlInterval) { clearInterval(st.basketUpnlInterval); st.basketUpnlInterval = null; }
}

export function removeActiveBasket(id) {
    const baskets = getActiveBaskets().filter(b => b.id !== id);
    setActiveBaskets(baskets);
    renderActiveBaskets();
}

export function renderActiveBaskets() {
    const container = document.getElementById('idx-active-baskets');
    if (!container) return;

    const baskets = getActiveBaskets();
    if (baskets.length === 0) {
        container.innerHTML = '';
        cleanupBasketWs();
        return;
    }

    connectBasketPriceStreams(baskets);

    const visibleBaskets = [...baskets]
        .sort((a, b) => toFiniteNumber(b.lastExecutionAt, 0) - toFiniteNumber(a.lastExecutionAt, 0))
        .slice(0, 10);

    container.innerHTML = `
    <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; margin-top:8px;">Active Baskets</div>
    ${visibleBaskets.map(b => {
        const dirColor = b.direction === 'LONG' ? 'var(--green)' : 'var(--red)';
        const legs = b.legs || b.results || [];
        const stackCount = Math.max(1, Math.round(toFiniteNumber(b.executionCount, 1)));

        // Compute open size from legs
        let totalNotional = 0;
        let totalMargin = 0;
        for (const leg of legs) {
            totalNotional += toFiniteNumber(leg.notional, 0);
            totalMargin += toFiniteNumber(leg.margin, 0);
        }

        let totalUpnl = 0;
        let hasLivePrice = false;
        const legRows = legs.map(leg => {
            const lp = st.basketLatestPrices[leg.symbol];
            let upnl = 0;
            if (lp && leg.entryPrice && leg.quantity) {
                hasLivePrice = true;
                upnl = leg.side === 'LONG'
                    ? (lp - leg.entryPrice) * leg.quantity
                    : (leg.entryPrice - lp) * leg.quantity;
                totalUpnl += upnl;
            }
            const sym = leg.symbol.split('/')[0];
            const pnlColor = upnl >= 0 ? 'var(--green)' : 'var(--red)';
            const sideColor = leg.side === 'LONG' ? 'var(--green)' : 'var(--red)';
            return `<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 0; font-size:10px;">
              <span><span style="color:${sideColor}; font-weight:600;">${leg.side === 'LONG' ? '▲' : '▼'}</span> ${sym}</span>
              <span style="font-family:var(--font-mono); color:${pnlColor};">${lp ? (upnl >= 0 ? '+' : '') + '$' + upnl.toFixed(2) : '...'}</span>
            </div>`;
        }).join('');

        const totalColor = totalUpnl >= 0 ? 'var(--green)' : 'var(--red)';
        const totalSign = totalUpnl >= 0 ? '+' : '';
        const elapsed = getBasketTimeHeld(b.timestamp);

        return `
        <div class="idx-basket-card" data-basket-id="${b.id}" style="background:var(--bg-input); border-radius:8px; padding:8px 10px; margin-bottom:6px; font-size:11px; border:1px solid rgba(255,255,255,0.04);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-weight:600;">${b.indexName}</span>
              <span style="color:${dirColor}; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; background:${b.direction === 'LONG' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'};">${b.direction}</span>
              ${stackCount > 1
                ? `<span style="font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; color:var(--text-primary); background:rgba(255,255,255,0.10);">x${stackCount}</span>`
                : ''}
            </div>
            <div data-basket-upnl="${b.id}" style="font-family:var(--font-mono); font-weight:700; font-size:13px; color:${totalColor};">
              ${hasLivePrice ? totalSign + '$' + Math.abs(totalUpnl).toFixed(2) : '...'}
            </div>
          </div>
          <div style="display:flex; gap:8px; font-size:9px; color:var(--text-muted); font-family:var(--font-mono); margin-bottom:4px; padding:3px 6px; background:rgba(255,255,255,0.03); border-radius:4px;">
            <span>Size: <span style="color:var(--text-secondary); font-weight:600;">$${totalNotional.toFixed(0)}</span></span>
            <span>Margin: <span style="color:var(--text-secondary); font-weight:600;">$${totalMargin.toFixed(0)}</span></span>
            <span>Legs: <span style="color:var(--text-secondary); font-weight:600;">${legs.length}</span></span>
          </div>
          <div style="border-top:1px solid rgba(255,255,255,0.04); padding-top:4px; margin-top:2px;">
            ${legRows}
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.04);">
            <span style="color:var(--text-muted); font-size:9px; font-family:var(--font-mono);">$${Math.round(toFiniteNumber(b.tradeSize, 0))} · ${b.leverage || st.leverage}x · ${elapsed}</span>
            <button data-remove-basket="${b.id}" style="background:none; border:none; color:var(--text-muted); font-size:10px; cursor:pointer; padding:2px 4px; opacity:0.6;" title="Remove tracking">✕</button>
          </div>
        </div>`;
    }).join('')}`;

    container.querySelectorAll('[data-remove-basket]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeActiveBasket(btn.dataset.removeBasket);
        });
    });

    if (!st.basketUpnlInterval) {
        st.basketUpnlInterval = setInterval(updateBasketUpnl, 3000);
        st.cleanupFns.push(() => { clearInterval(st.basketUpnlInterval); st.basketUpnlInterval = null; });
    }
}

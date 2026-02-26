/**
 * Chase Limit — C++ proxy with bridge glue.
 *
 * All chase orchestration (reprice loop, token bucket, exchange order
 * placement/cancel) runs in the C++ ChaseActor.  JS validates, delegates
 * via UDS bridge, and maintains an in-memory state cache for GET/active
 * queries by consuming C++ events (chase_progress, chase_filled, chase_done,
 * chase_status).
 *
 * Price relay: when C++ doesn't yet have its own WS market feed, JS relays
 * exchange price ticks to C++ via the `price_tick` command.
 *
 * Removed JS orchestration fallback (2,163→~650 lines).
 */
import { Router } from 'express';
import { prisma } from '../../risk/index.js';
import defaultExchange from '../../exchange.js';
import { broadcast } from '../../ws.js';
import { requireOwnership } from '../../ownership.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { toCppSymbol } from './cpp-symbol.js';
import { makeCppClientOrderId } from './cpp-order-utils.js';
import { extractNotionalUsd, normalizeOrderSizing, parsePositiveNumber } from './order-sizing.js';
import { log } from '../../structured-logger.js';
import { ensureSubmitPreflight } from './submit-preflight.js';
import {
    beginIdempotentRequest,
    completeIdempotentRequest,
    releaseIdempotentRequest,
} from './submit-idempotency.js';

const router = Router();
let exchange = defaultExchange;

export function setChaseLimitExchangeConnector(exchangeConnector) {
    exchange = exchangeConnector || defaultExchange;
}

// ═══════════════════════════════════════════════════════════════════
//  C++ Bridge Glue — state cache, event listeners, price relay
// ═══════════════════════════════════════════════════════════════════

let _cppBridgeListenersAttached = false;
let _cppBridgeListenerRef = null;
const _cppActiveChases = new Map();      // chaseId(string) -> state
const _cppPendingStartMeta = new Map();  // requestId(number) -> metadata
const _cppRequestToChaseId = new Map();  // requestId(number) -> chaseId(string)
const CPP_PENDING_TTL_MS = 10 * 60 * 1000;
// C++ now owns its own market data WS — no JS relay needed
const _cppRelaySymbols = new Set();

// ── Helpers ──────────────────────────────────────────────────────

function toFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toFiniteInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeCppSide(side) {
    const raw = String(side || '').toUpperCase();
    if (raw === 'BUY') return 'LONG';
    if (raw === 'SELL') return 'SHORT';
    if (raw === 'LONG' || raw === 'SHORT') return raw;
    return raw || 'LONG';
}

function normalizeCppStalkMode(mode) {
    const raw = String(mode || '').toLowerCase();
    if (raw === 'maintain' || raw === 'trail' || raw === 'none') return raw;
    return 'none';
}

function normalizeCppStatus(status) {
    const raw = String(status || '').toUpperCase();
    if (raw === 'ACTIVE') return 'active';
    if (raw === 'FILLED') return 'filled';
    if (raw === 'CANCELLED') return 'cancelled';
    return raw ? raw.toLowerCase() : 'active';
}

function normalizeCppChaseId(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(Math.trunc(n));
}

function normalizeCppSymbol(symbol) {
    const raw = String(symbol || '').trim();
    if (!raw) return raw;
    try {
        const normalized = exchange.normalizeSymbol(raw);
        if (normalized && normalized.includes('/')) return normalized;
    } catch { /* ignore */ }
    const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (upper.endsWith('USDT') && upper.length > 4) {
        const base = upper.slice(0, -4);
        return `${base}/USDT:USDT`;
    }
    return raw;
}

function toIsoTs(ms) {
    const ts = Number(ms);
    return Number.isFinite(ts) && ts > 0
        ? new Date(ts).toISOString()
        : new Date().toISOString();
}

// Price relay removed — C++ owns its market data WS connection
function ensureCppPriceRelay(bridge) {
    // No-op: C++ connects to fstream.binance.com directly
}

function refreshCppRelaySymbols() {
    // No-op: C++ manages its own bookTicker subscriptions
}

// ── Pending Start Metadata ───────────────────────────────────────

function pruneCppPendingStartMeta() {
    const now = Date.now();
    for (const [reqId, meta] of _cppPendingStartMeta) {
        if (!meta || (now - (meta.createdAt || 0)) > CPP_PENDING_TTL_MS) {
            _cppPendingStartMeta.delete(reqId);
        }
    }
    refreshCppRelaySymbols();
}

function rememberCppPendingStart(requestId, meta) {
    if (!Number.isFinite(Number(requestId))) return;
    pruneCppPendingStartMeta();
    _cppPendingStartMeta.set(Number(requestId), { ...(meta || {}), createdAt: Date.now() });
    refreshCppRelaySymbols();
}

function getCppPendingStart(requestId) {
    const rid = Number(requestId);
    if (!Number.isFinite(rid)) return null;
    const meta = _cppPendingStartMeta.get(rid);
    if (!meta) return null;
    if ((Date.now() - (meta.createdAt || 0)) > CPP_PENDING_TTL_MS) {
        _cppPendingStartMeta.delete(rid);
        refreshCppRelaySymbols();
        return null;
    }
    return meta;
}

function findCppPendingStartMatch({ subAccountId, symbol, side }) {
    const targetAccount = String(subAccountId || '');
    const targetSymbol = normalizeCppSymbol(symbol || '');
    const targetSide = normalizeCppSide(side || '');
    if (!targetAccount || !targetSymbol || !targetSide) return null;
    let winner = null;
    for (const [requestId, meta] of _cppPendingStartMeta) {
        if (!meta) continue;
        if ((Date.now() - (meta.createdAt || 0)) > CPP_PENDING_TTL_MS) continue;
        if (String(meta.subAccountId || '') !== targetAccount) continue;
        if (normalizeCppSymbol(meta.symbol || '') !== targetSymbol) continue;
        if (normalizeCppSide(meta.side || '') !== targetSide) continue;
        if (!winner || (meta.createdAt || 0) > (winner.meta.createdAt || 0)) {
            winner = { requestId, meta };
        }
    }
    return winner;
}

// ── State Cache (public view) ────────────────────────────────────

function toPublicCppChase(state, extras = {}) {
    return {
        chaseId: state.chaseId,
        subAccountId: state.subAccountId,
        symbol: state.symbol,
        side: state.side,
        quantity: state.quantity,
        stalkOffsetPct: state.stalkOffsetPct,
        stalkMode: state.stalkMode,
        maxDistancePct: state.maxDistancePct || 0,
        currentOrderPrice: state.currentOrderPrice,
        initialPrice: state.initialPrice || state.currentOrderPrice,
        repriceCount: state.repriceCount || 0,
        startedAt: toIsoTs(state.startedAt),
        status: state.status || 'active',
        parentScalperId: state.parentScalperId || null,
        reduceOnly: !!state.reduceOnly,
        ...extras,
    };
}

function upsertCppChaseState(input) {
    const chaseId = normalizeCppChaseId(input?.chaseId ?? input?.chase_id);
    if (!chaseId) return null;
    const prev = _cppActiveChases.get(chaseId) || {};
    let requestId = Number(input?.requestId ?? input?.request_id);
    let pending = Number.isFinite(requestId) ? getCppPendingStart(requestId) : null;
    if (!pending && !Number.isFinite(requestId)) {
        const matched = findCppPendingStartMatch({
            subAccountId: input?.subAccountId ?? input?.sub_account_id ?? prev.subAccountId,
            symbol: input?.symbol ?? prev.symbol,
            side: input?.side ?? prev.side,
        });
        if (matched) { requestId = Number(matched.requestId); pending = matched.meta; }
    }
    const inputCurrentPrice = Number(input?.currentOrderPrice ?? input?.current_price);
    const inputInitialPrice = Number(input?.initialPrice ?? input?.initial_price);
    const resolvedCurrentPrice = (Number.isFinite(inputCurrentPrice) && inputCurrentPrice > 0)
        ? inputCurrentPrice : toFiniteNumber(prev.currentOrderPrice ?? pending?.currentOrderPrice ?? 0, 0);
    const resolvedInitialPrice = (Number.isFinite(inputInitialPrice) && inputInitialPrice > 0)
        ? inputInitialPrice : toFiniteNumber(prev.initialPrice ?? pending?.initialPrice ?? resolvedCurrentPrice ?? 0, 0);

    const merged = {
        chaseId, requestId: Number.isFinite(requestId) ? requestId : (prev.requestId ?? pending?.requestId ?? null),
        subAccountId: String(input?.subAccountId ?? input?.sub_account_id ?? prev.subAccountId ?? pending?.subAccountId ?? ''),
        symbol: normalizeCppSymbol(input?.symbol ?? prev.symbol ?? pending?.symbol ?? ''),
        side: normalizeCppSide(input?.side ?? prev.side ?? pending?.side ?? 'LONG'),
        quantity: toFiniteNumber(input?.quantity ?? input?.qty ?? prev.quantity ?? pending?.quantity ?? 0, 0),
        stalkOffsetPct: toFiniteNumber(input?.stalkOffsetPct ?? input?.stalk_offset_pct ?? prev.stalkOffsetPct ?? pending?.stalkOffsetPct ?? 0, 0),
        stalkMode: normalizeCppStalkMode(input?.stalkMode ?? input?.stalk_mode ?? prev.stalkMode ?? pending?.stalkMode ?? 'none'),
        maxDistancePct: toFiniteNumber(input?.maxDistancePct ?? input?.max_distance_pct ?? prev.maxDistancePct ?? pending?.maxDistancePct ?? 0, 0),
        currentOrderPrice: resolvedCurrentPrice, initialPrice: resolvedInitialPrice,
        repriceCount: toFiniteInt(input?.repriceCount ?? input?.reprice_count ?? prev.repriceCount ?? 0, 0),
        status: normalizeCppStatus(input?.status ?? prev.status ?? 'ACTIVE'),
        reduceOnly: Boolean(input?.reduceOnly ?? input?.reduce_only ?? prev.reduceOnly ?? pending?.reduceOnly ?? false),
        parentScalperId: input?.parentScalperId ?? prev.parentScalperId ?? pending?.parentScalperId ?? null,
        startedAt: toFiniteNumber(prev.startedAt ?? pending?.startedAt ?? Date.now(), Date.now()),
        updatedAt: Date.now(),
    };

    _cppActiveChases.set(chaseId, merged);
    if (Number.isFinite(merged.requestId)) _cppRequestToChaseId.set(merged.requestId, chaseId);
    refreshCppRelaySymbols();
    return merged;
}

// ── C++ Event Handler ────────────────────────────────────────────

function onCppChaseBridgeEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    const stream = String(msg.stream || '');

    if (stream === 'binance_ws_status') { return; } // C++ WS status — ignored now
    if (!stream.startsWith('chase_')) return;

    if (stream === 'chase_progress') {
        const state = upsertCppChaseState(msg);
        if (!state) return;
        broadcast('chase_progress', toPublicCppChase(state, {
            bid: toFiniteNumber(msg.bid, 0) || undefined,
            ask: toFiniteNumber(msg.ask, 0) || undefined,
        }));
        return;
    }

    if (stream === 'chase_filled') {
        const state = upsertCppChaseState({ ...msg, status: 'FILLED' });
        if (!state) return;
        broadcast('chase_filled', {
            ...toPublicCppChase(state),
            fillPrice: toFiniteNumber(msg.fill_price, 0) || state.currentOrderPrice,
            quantity: toFiniteNumber(msg.fill_qty, 0) || state.quantity,
            repriceCount: toFiniteInt(msg.reprice_count, state.repriceCount || 0),
        });
        _cppActiveChases.delete(state.chaseId);
        if (Number.isFinite(state.requestId)) {
            _cppPendingStartMeta.delete(state.requestId);
            _cppRequestToChaseId.delete(state.requestId);
        }
        refreshCppRelaySymbols();
        return;
    }

    if (stream === 'chase_done') {
        const chaseId = normalizeCppChaseId(msg.chase_id);
        const requestId = Number(msg.request_id);
        const mappedChaseId = Number.isFinite(requestId) ? _cppRequestToChaseId.get(requestId) : null;
        const finalId = chaseId || mappedChaseId;
        const prev = finalId ? _cppActiveChases.get(finalId) : null;
        const pending = Number.isFinite(requestId) ? getCppPendingStart(requestId) : null;
        const merged = {
            chaseId: finalId || (prev?.chaseId ?? null),
            subAccountId: String(msg.sub_account_id || prev?.subAccountId || pending?.subAccountId || ''),
            symbol: normalizeCppSymbol(msg.symbol || prev?.symbol || pending?.symbol || ''),
            side: normalizeCppSide(msg.side || prev?.side || pending?.side || ''),
            reason: String(msg.reason || 'cancelled'),
            repriceCount: toFiniteInt(msg.reprice_count, prev?.repriceCount || 0),
            startedAt: prev?.startedAt || pending?.startedAt || Date.now(),
        };
        if (merged.chaseId) {
            broadcast('chase_cancelled', {
                chaseId: merged.chaseId, subAccountId: merged.subAccountId || undefined,
                symbol: merged.symbol || undefined, side: merged.side || undefined,
                reason: merged.reason, repriceCount: merged.repriceCount, startedAt: toIsoTs(merged.startedAt),
            });
            _cppActiveChases.delete(merged.chaseId);
        }
        if (Number.isFinite(requestId)) {
            _cppPendingStartMeta.delete(requestId);
            _cppRequestToChaseId.delete(requestId);
        }
        refreshCppRelaySymbols();
        return;
    }

    if (stream === 'chase_status') {
        const subAccountId = String(msg.sub_account_id || '');
        const chases = Array.isArray(msg.chases) ? msg.chases : [];
        const seen = new Set();
        for (const row of chases) {
            const state = upsertCppChaseState({ ...row, sub_account_id: subAccountId });
            if (state) seen.add(state.chaseId);
        }
        if (subAccountId) {
            for (const [id, state] of _cppActiveChases) {
                if (state.subAccountId === subAccountId && !seen.has(id)) _cppActiveChases.delete(id);
            }
        }
        refreshCppRelaySymbols();
    }
}

function ensureCppChaseBridgeListeners(bridge) {
    if (!bridge) return;
    ensureCppPriceRelay(bridge);
    if (_cppBridgeListenersAttached && _cppBridgeListenerRef === bridge) return;
    if (_cppBridgeListenersAttached && _cppBridgeListenerRef && _cppBridgeListenerRef !== bridge) {
        _cppBridgeListenerRef.off('event', onCppChaseBridgeEvent);
    }
    bridge.on('event', onCppChaseBridgeEvent);
    _cppBridgeListenersAttached = true;
    _cppBridgeListenerRef = bridge;
    refreshCppRelaySymbols();
    console.log('[Chase] C++ bridge listener attached');
}

// ── Status Queries ───────────────────────────────────────────────

async function requestCppChaseStatus(bridge, subAccountId, timeoutMs = 1500) {
    if (!bridge?.isHealthy()) throw new Error('C++ bridge unavailable');
    return new Promise(async (resolve, reject) => {
        const requestId = Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
        let timer = null;
        const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } bridge.off('event', onEvent); };
        const onEvent = (msg) => {
            if (!msg || msg.stream !== 'chase_status') return;
            if (Number(msg.request_id) !== Number(requestId)) return;
            if (subAccountId && msg.sub_account_id && msg.sub_account_id !== subAccountId) return;
            cleanup(); resolve(msg);
        };
        bridge.on('event', onEvent);
        timer = setTimeout(() => { cleanup(); reject(new Error('C++ chase_status timeout')); }, timeoutMs);
        try {
            await bridge.sendCommand('chase_status', { sub_account_id: subAccountId }, { request_id: requestId });
        } catch (err) { cleanup(); reject(err); }
    });
}

async function fetchCppActiveChaseRows(bridge, subAccountId) {
    ensureCppChaseBridgeListeners(bridge);
    const status = await requestCppChaseStatus(bridge, subAccountId, 1800);
    const rows = [];
    const seen = new Set();
    const list = Array.isArray(status?.chases) ? status.chases : [];
    for (const row of list) {
        const state = upsertCppChaseState({ ...row, sub_account_id: subAccountId });
        if (!state) continue;
        seen.add(state.chaseId);
        rows.push(toPublicCppChase(state));
    }
    for (const [id, state] of _cppActiveChases) {
        if (state.subAccountId === subAccountId && !seen.has(id)) _cppActiveChases.delete(id);
    }
    return rows;
}

// ── Market Params (tick size, clamp %) for C++ ───────────────────

function getCppChaseMarketParams(symbol) {
    const out = { tickSize: 0.00001, clampDownPct: 0.85, clampUpPct: 1.15, minNotional: 0 };
    try {
        const market = exchange.markets?.[symbol];
        if (!market) return out;
        const precisionPrice = Number(market?.precision?.price);
        if (Number.isFinite(precisionPrice) && precisionPrice > 0) {
            out.tickSize = precisionPrice >= 1 ? Math.pow(10, -precisionPrice) : precisionPrice;
        }
        const filters = Array.isArray(market?.info?.filters) ? market.info.filters : [];
        const pctFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'PERCENT_PRICE');
        const minNotionalFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'MIN_NOTIONAL');
        const notionalFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'NOTIONAL');
        if (pctFilter) {
            const down = Number.parseFloat(pctFilter.multiplierDown);
            const up = Number.parseFloat(pctFilter.multiplierUp);
            if (Number.isFinite(down) && down > 0) out.clampDownPct = down;
            if (Number.isFinite(up) && up > 0) out.clampUpPct = up;
        }
        const minNotional = Number.parseFloat(
            minNotionalFilter?.notional
            || minNotionalFilter?.minNotional
            || notionalFilter?.minNotional
            || market?.minNotional,
        );
        if (Number.isFinite(minNotional) && minNotional > 0) {
            out.minNotional = minNotional;
        }
    } catch { /* keep defaults */ }
    return out;
}

// ═══════════════════════════════════════════════════════════════════
//  Routes
// ═══════════════════════════════════════════════════════════════════

// POST /api/trade/chase-limit — Start a chase via C++ ChaseActor
router.post('/chase-limit', requireOwnership('body'), async (req, res) => {
    let idem = null;
    try {
        const { subAccountId, symbol, side, quantity, leverage, stalkOffsetPct, stalkMode, maxDistancePct } = req.body;
        const requestedNotionalUsd = extractNotionalUsd(req.body);

        if (!subAccountId || !symbol || !side || !leverage || (!quantity && !requestedNotionalUsd)) {
            return res.status(400).json({ error: 'Missing required fields: subAccountId, symbol, side, leverage, and quantity or notionalUsd' });
        }

        const normalizedSymbol = exchange.normalizeSymbol(symbol);
        const parsedLeverage = parseInt(leverage);
        if (!Number.isFinite(parsedLeverage) || parsedLeverage < 1 || parsedLeverage > 125) {
            return res.status(400).json({ error: 'leverage must be between 1 and 125' });
        }

        const parsedOffset = parseFloat(stalkOffsetPct) || 0;
        if (parsedOffset < 0 || parsedOffset > 10) {
            return res.status(400).json({ error: 'stalkOffsetPct must be between 0 and 10' });
        }

        const validModes = ['none', 'maintain', 'trail'];
        const mode = validModes.includes(stalkMode) ? stalkMode : 'none';
        const parsedDistance = parseFloat(maxDistancePct) || 0;
        if (parsedDistance < 0 || parsedDistance > 50) {
            return res.status(400).json({ error: 'maxDistancePct must be between 0 and 50' });
        }

        // Bid/ask for sizing
        const clientBid = parseFloat(req.body.clientBid);
        const clientAsk = parseFloat(req.body.clientAsk);
        let bidAsk = null;
        const serverBidAsk = exchange.getLatestBidAsk(normalizedSymbol);

        if (Number.isFinite(clientBid) && clientBid > 0 && Number.isFinite(clientAsk) && clientAsk > 0) {
            bidAsk = { bid: clientBid, ask: clientAsk };
        } else if (serverBidAsk?.bid && serverBidAsk?.ask) {
            bidAsk = serverBidAsk;
        } else {
            try {
                const ticker = await exchange.fetchTicker(normalizedSymbol);
                bidAsk = { bid: Number(ticker?.bid || ticker?.last), ask: Number(ticker?.ask || ticker?.last) };
            } catch { /* ignore */ }
        }
        if (!bidAsk?.bid || !bidAsk?.ask) {
            return res.status(500).json({ error: 'Cannot get current bid/ask for this symbol' });
        }

        const sideUpper = side.toUpperCase();
        const refQuote = sideUpper === 'LONG'
            ? (parsePositiveNumber(bidAsk.ask) || parsePositiveNumber(bidAsk.bid))
            : (parsePositiveNumber(bidAsk.bid) || parsePositiveNumber(bidAsk.ask));

        const shouldDeriveQtyFromNotional = Number.isFinite(requestedNotionalUsd) && requestedNotionalUsd > 0;
        const sizing = await normalizeOrderSizing({
            symbol: normalizedSymbol, side: sideUpper, price: refQuote,
            notionalUsd: requestedNotionalUsd, payload: req.body,
            quantityPrecisionMode: 'nearest', pricePrecisionMode: 'nearest',
            allowPriceLookup: true, exchangeConnector: exchange,
            quantity: shouldDeriveQtyFromNotional ? null : quantity,
        });
        const parsedQty = sizing.quantity;

        // Compute initial target price for the pending-start metadata
        const computeTarget = (side, bid, ask, offset) => {
            if (side === 'LONG') return offset > 0 ? bid * (1 - offset / 100) : bid;
            return offset > 0 ? ask * (1 + offset / 100) : ask;
        };
        const target = computeTarget(sideUpper, bidAsk.bid, bidAsk.ask, parsedOffset);
        const currentQuote = sideUpper === 'LONG' ? bidAsk.bid : bidAsk.ask;

        // Delegate to C++ ChaseActor
        idem = await beginIdempotentRequest(req, 'trade:chase-start');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }

        const bridge = await ensureSubmitPreflight({
            getBridge: getSimplxBridge,
            subAccountId,
            sync: true,
        });

        ensureCppChaseBridgeListeners(bridge);
        const cppMarketParams = getCppChaseMarketParams(normalizedSymbol);
        const initialNotional = parsedQty * target;
        if (cppMarketParams.minNotional > 0 && initialNotional < cppMarketParams.minNotional) {
            return res.status(400).json({
                error: `Order notional too small for ${normalizedSymbol}: ${initialNotional.toFixed(4)} < min ${cppMarketParams.minNotional}`,
            });
        }

        const requestId = await bridge.sendCommand('chase_start', {
            sub_account_id: subAccountId,
            client_order_id: makeCppClientOrderId('chase', subAccountId, { reserveSuffix: 8 }),
            symbol: toCppSymbol(normalizedSymbol),
            side: sideUpper === 'LONG' ? 'BUY' : 'SELL',
            qty: parsedQty, leverage: parsedLeverage,
            stalk_offset_pct: parsedOffset, stalk_mode: mode,
            max_distance_pct: parsedDistance,
            tick_size: cppMarketParams.tickSize,
            clamp_down_pct: cppMarketParams.clampDownPct,
            clamp_up_pct: cppMarketParams.clampUpPct,
            min_notional: cppMarketParams.minNotional > 0 ? cppMarketParams.minNotional : undefined,
        });

        rememberCppPendingStart(requestId, {
            requestId, subAccountId, symbol: normalizedSymbol, side: sideUpper,
            quantity: parsedQty, stalkOffsetPct: parsedOffset, stalkMode: mode,
            maxDistancePct: parsedDistance, currentOrderPrice: target,
            initialPrice: currentQuote, startedAt: Date.now(),
        });

        res.set('X-Source', 'cpp-engine');
        const responseBody = {
            success: true, accepted: true, source: 'cpp-engine', status: 'QUEUED',
            persistencePending: false,
            requestId, chaseId: null, symbol: normalizedSymbol, side: sideUpper,
            quantity: parsedQty, stalkOffsetPct: parsedOffset, stalkMode: mode,
            maxDistancePct: parsedDistance, currentOrderPrice: target,
            initialPrice: currentQuote, bid: bidAsk.bid, ask: bidAsk.ask,
        };
        await completeIdempotentRequest(idem, { statusCode: 202, body: responseBody });
        return res.status(202).json(responseBody);
    } catch (err) {
        await releaseIdempotentRequest(idem);
        log.error('chase', 'START_FAILED', `Chase start failed: ${err.message}`, {
            symbol: req.body?.symbol, side: req.body?.side, subAccountId: req.body?.subAccountId,
            error: err.message,
        });
        const msg = String(err?.message || '');
        const lower = msg.toLowerCase();
        const isUserInputError = lower.includes('missing') || lower.includes('quantity')
            || lower.includes('notional') || lower.includes('invalid') || lower.includes('cannot derive quantity');
        res.status(isUserInputError ? 400 : 500).json({ error: msg });
    }
});

// GET /api/trade/chase-limit/active/:subAccountId — Query C++ chase state
router.get('/chase-limit/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        if (bridge?.isHealthy()) {
            const cppRows = await fetchCppActiveChaseRows(bridge, req.params.subAccountId);
            return res.json(cppRows);
        }
        res.json([]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/chase-limit/:chaseId — Cancel via C++ ChaseActor
router.delete('/chase-limit/:chaseId', async (req, res) => {
    try {
        const rawChaseId = String(req.params.chaseId || '').trim();
        const bridge = await ensureSubmitPreflight({
            getBridge: getSimplxBridge,
            subAccountId: req.query?.subAccountId || '',
            sync: false,
        });

        ensureCppChaseBridgeListeners(bridge);

        const numericChaseId = Number(rawChaseId);
        if (!Number.isFinite(numericChaseId) || numericChaseId <= 0) {
            return res.status(400).json({ error: 'Invalid C++ chase id' });
        }
        const chaseId = String(Math.trunc(numericChaseId));
        const cached = _cppActiveChases.get(chaseId) || null;
        let subAccountId = String(req.query?.subAccountId || '').trim();
        if (!subAccountId && cached?.subAccountId) subAccountId = cached.subAccountId;
        if (!subAccountId) return res.status(400).json({ error: 'subAccountId is required' });

        // Ownership check
        if (req.user?.role !== 'ADMIN') {
            const account = await prisma.subAccount.findUnique({ where: { id: subAccountId }, select: { userId: true } });
            if (account?.userId !== req.user?.id) return res.status(403).json({ error: 'You do not own this chase order' });
        }

        const requestId = await bridge.sendCommand('chase_cancel', {
            chase_id: Number(chaseId), sub_account_id: subAccountId || undefined,
        });

        return res.status(202).json({
            success: true, accepted: true, source: 'cpp-engine', status: 'QUEUED',
            requestId, chaseId, subAccountId: subAccountId || undefined,
            symbol: cached?.symbol, side: cached?.side,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// No-op stubs for backward compat (previously exported for server startup)
export async function resumeActiveChaseOrders() { /* C++ handles persistence */ }
export function initChaseCleanup() { /* C++ handles cleanup */ }
// Stubs for scalper.js backward compat (now also a thin proxy)
export function startChaseInternal() { throw new Error('JS chase orchestration removed — use C++ engine'); }
export function cancelChaseInternal() { return Promise.resolve(); }
export function startChaseBatch() { return Promise.resolve([]); }

export default router;

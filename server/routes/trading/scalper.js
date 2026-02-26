/**
 * Scalper Engine — thin C++ proxy.
 *
 * All scalper logic (dual-leg chase spawning, layer geometry, fill-spread
 * guards, burst rate limiting, backoff, slot restart) runs in C++ ScalperActor.
 * JS only validates and delegates via UDS bridge.
 *
 * Removed JS fallback (1,694→100 lines).
 */
import { Router } from 'express';
import defaultExchange from '../../exchange.js';
import { requireOwnership } from '../../ownership.js';
import { getSimplxBridge } from '../../simplx-uds-bridge.js';
import { toCppSymbol } from './cpp-symbol.js';
import { ensureSubmitPreflight } from './submit-preflight.js';
import {
    beginIdempotentRequest,
    completeIdempotentRequest,
    releaseIdempotentRequest,
} from './submit-idempotency.js';

const router = Router();
let exchange = defaultExchange;

export function setScalperExchangeConnector(exchangeConnector) {
    exchange = exchangeConnector || defaultExchange;
}
const MIN_NOTIONAL_FALLBACK_USD = 5;

function parsePositiveNumber(value) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function parseNumber(value, fallback = 0) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

function parseInteger(value, fallback = 0) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return fallback;
}

function normalizeStartSide(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (raw === 'BUY') return 'LONG';
    if (raw === 'SELL') return 'SHORT';
    if (raw === 'LONG' || raw === 'SHORT') return raw;
    return '';
}

function normalizeFeedbackMode(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'soft' || raw === 'full' || raw === 'off') return raw;
    return 'off';
}

function symbolKey(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function skewWeights(count, skew) {
    if (count <= 1) return [1];
    const s = skew / 100;
    const weights = Array.from({ length: count }, (_, i) => {
        const t = i / (count - 1);
        return Math.pow(8, s * (2 * t - 1));
    });
    const total = weights.reduce((sum, w) => sum + w, 0);
    return weights.map((w) => w / total);
}

function getSymbolMinNotional(symbol) {
    try {
        const market = exchange.markets?.[symbol];
        const filters = Array.isArray(market?.info?.filters) ? market.info.filters : [];
        const minNotionalFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'MIN_NOTIONAL');
        const notionalFilter = filters.find((f) => String(f?.filterType || '').toUpperCase() === 'NOTIONAL');
        const minNotional = Number.parseFloat(
            minNotionalFilter?.notional
            || minNotionalFilter?.minNotional
            || notionalFilter?.minNotional
            || market?.minNotional,
        );
        if (Number.isFinite(minNotional) && minNotional > 0) return minNotional;
    } catch { /* ignore */ }
    return MIN_NOTIONAL_FALLBACK_USD;
}

async function resolveStartPrice(symbol, explicitPrice) {
    const direct = parsePositiveNumber(explicitPrice);
    if (direct) return direct;

    const bidAsk = exchange.getLatestBidAsk?.(symbol);
    const bid = parsePositiveNumber(bidAsk?.bid);
    const ask = parsePositiveNumber(bidAsk?.ask);
    if (bid && ask) return (bid + ask) / 2;

    const mark = parsePositiveNumber(exchange.getLatestPrice?.(symbol));
    if (mark) return mark;

    try {
        const ticker = await exchange.fetchTicker?.(symbol);
        const tickBid = parsePositiveNumber(ticker?.bid);
        const tickAsk = parsePositiveNumber(ticker?.ask);
        if (tickBid && tickAsk) return (tickBid + tickAsk) / 2;
        return parsePositiveNumber(ticker?.mark) || parsePositiveNumber(ticker?.last) || null;
    } catch {
        return null;
    }
}

async function buildScalperStartCommand(input = {}, defaults = {}) {
    const subAccountId = String(
        input.subAccountId
        || input.sub_account_id
        || defaults.subAccountId
        || '',
    ).trim();
    if (!subAccountId) {
        throw new Error('Missing required field: subAccountId');
    }

    const symbolInput = String(input.symbol || defaults.symbol || '').trim();
    if (!symbolInput) {
        throw new Error('Missing required field: symbol');
    }
    const symbol = exchange.normalizeSymbol(symbolInput);

    const startSide = normalizeStartSide(
        input.startSide
        || input.start_side
        || input.side
        || defaults.startSide,
    );
    if (!startSide) {
        throw new Error('Invalid startSide (expected LONG or SHORT)');
    }

    const leverageRaw = parseNumber(input.leverage ?? defaults.leverage, 1);
    const leverage = clamp(leverageRaw, 1, 125);

    const childCountRaw = parseInteger(input.childCount ?? input.child_count ?? defaults.childCount, 1);
    const childCount = clamp(childCountRaw, 1, 10);

    const skewRaw = parseInteger(input.skew ?? defaults.skew, 0);
    const skew = clamp(skewRaw, -100, 100);

    const legacyOffset = parseNumber(input.stalkOffsetPct ?? input.stalk_offset_pct ?? defaults.stalkOffsetPct, 0);
    const longOffsetPct = clamp(parseNumber(input.longOffsetPct ?? input.long_offset_pct ?? defaults.longOffsetPct, legacyOffset), 0, 3);
    const shortOffsetPct = clamp(parseNumber(input.shortOffsetPct ?? input.short_offset_pct ?? defaults.shortOffsetPct, legacyOffset), 0, 3);

    const legacyPerSideUsd = parsePositiveNumber(
        input.totalNotionalUsdt
        ?? input.total_notional
        ?? input.totalNotionalUsd
        ?? defaults.totalNotionalUsdt,
    );

    const longSizeUsd = parsePositiveNumber(input.longSizeUsd ?? input.long_size_usd ?? defaults.longSizeUsd) || legacyPerSideUsd;
    const shortSizeUsd = parsePositiveNumber(input.shortSizeUsd ?? input.short_size_usd ?? defaults.shortSizeUsd) || legacyPerSideUsd;
    if (!longSizeUsd || !shortSizeUsd) {
        throw new Error('Missing required fields: longSizeUsd and shortSizeUsd (or totalNotionalUsdt)');
    }

    const minNotional = parsePositiveNumber(input.minNotional ?? input.min_notional ?? defaults.minNotional) || getSymbolMinNotional(symbol);
    const minWeight = Math.min(...skewWeights(childCount, skew));
    const minLayerLong = longSizeUsd * minWeight;
    const minLayerShort = shortSizeUsd * minWeight;
    if (minLayerLong + 0.001 < minNotional || minLayerShort + 0.001 < minNotional) {
        const minPerSide = Math.ceil(minNotional / Math.max(minWeight, 1e-9));
        throw new Error(`Scalper size too small: min ${minNotional} notional per layer requires at least $${minPerSide}/side for childCount=${childCount}, skew=${skew}`);
    }

    const resolvedPrice = await resolveStartPrice(symbol, input.price ?? input.mark ?? defaults.price);
    const command = {
        sub_account_id: subAccountId,
        symbol: toCppSymbol(symbol),
        start_side: startSide,
        leverage,
        child_count: childCount,
        skew,
        long_offset_pct: longOffsetPct,
        short_offset_pct: shortOffsetPct,
        long_size_usd: longSizeUsd,
        short_size_usd: shortSizeUsd,
        neutral_mode: parseBoolean(input.neutralMode ?? input.neutral_mode ?? defaults.neutralMode, false),
        allow_loss: parseBoolean(input.allowLoss ?? input.allow_loss ?? defaults.allowLoss, false),
        min_fill_spread_pct: parseNumber(input.minFillSpreadPct ?? input.min_fill_spread_pct ?? defaults.minFillSpreadPct, 0),
        fill_decay_half_life_ms: Math.max(1, parseInteger(input.fillDecayHalfLifeMs ?? input.fill_decay_half_life_ms ?? defaults.fillDecayHalfLifeMs, 30000)),
        min_refill_delay_ms: Math.max(0, parseInteger(input.minRefillDelayMs ?? input.min_refill_delay_ms ?? defaults.minRefillDelayMs, 0)),
        max_loss_per_close_bps: Math.max(0, parseNumber(input.maxLossPerCloseBps ?? input.max_loss_per_close_bps ?? defaults.maxLossPerCloseBps, 0)),
        max_fills_per_minute: Math.max(0, parseInteger(input.maxFillsPerMinute ?? input.max_fills_per_minute ?? defaults.maxFillsPerMinute, 0)),
        pnl_feedback_mode: normalizeFeedbackMode(input.pnlFeedbackMode ?? input.pnl_feedback_mode ?? defaults.pnlFeedbackMode),
        pin_long_to_entry: parseBoolean(input.pinLongToEntry ?? input.pin_long_to_entry ?? defaults.pinLongToEntry, false),
        pin_short_to_entry: parseBoolean(input.pinShortToEntry ?? input.pin_short_to_entry ?? defaults.pinShortToEntry, false),
        long_max_price: parsePositiveNumber(input.longMaxPrice ?? input.long_max_price ?? defaults.longMaxPrice) || undefined,
        short_min_price: parsePositiveNumber(input.shortMinPrice ?? input.short_min_price ?? defaults.shortMinPrice) || undefined,
        min_notional: minNotional,
        agent_owned: parseBoolean(input.agentOwned ?? input._agentOwned ?? input.agent_owned ?? defaults.agentOwned, false),
    };
    if (resolvedPrice && Number.isFinite(resolvedPrice) && resolvedPrice > 0) {
        command.price = resolvedPrice;
    }

    return {
        subAccountId,
        symbol,
        startSide,
        childCount,
        longSizeUsd,
        shortSizeUsd,
        command,
    };
}

async function waitForScalperStarted(bridge, requestId, timeoutMs = 1800) {
    if (!bridge?.isHealthy()) return null;
    const targetRequestId = Number(requestId);
    if (!Number.isFinite(targetRequestId)) return null;

    return new Promise((resolve) => {
        let timer = null;
        const cleanup = (scalperId = null) => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            bridge.off?.('event', onEvent);
            resolve(scalperId);
        };
        const onEvent = (msg) => {
            if (!msg || msg.stream !== 'scalper_started') return;
            if (Number(msg.request_id) !== targetRequestId) return;
            const sid = Number(msg.scalper_id);
            if (Number.isFinite(sid) && sid > 0) {
                cleanup(String(Math.trunc(sid)));
                return;
            }
            cleanup(null);
        };
        bridge.on?.('event', onEvent);
        timer = setTimeout(() => cleanup(null), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
    });
}

async function requestScalperStatus(bridge, subAccountId, timeoutMs = 1200) {
    if (!bridge?.isHealthy()) return null;
    const requestId = Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
    return new Promise(async (resolve) => {
        let timer = null;
        const cleanup = (payload = null) => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            bridge.off?.('event', onEvent);
            resolve(payload);
        };
        const onEvent = (msg) => {
            if (!msg || msg.stream !== 'scalper_status') return;
            if (Number(msg.request_id) !== requestId) return;
            if (subAccountId && msg.sub_account_id && msg.sub_account_id !== subAccountId) return;
            cleanup(msg);
        };
        bridge.on?.('event', onEvent);
        timer = setTimeout(() => cleanup(null), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        try {
            await bridge.sendCommand('scalper_status', { sub_account_id: subAccountId }, { request_id: requestId });
        } catch {
            cleanup(null);
        }
    });
}

async function fallbackScalperIdLookup(bridge, { subAccountId, symbol, startSide }) {
    const status = await requestScalperStatus(bridge, subAccountId, 1200);
    const scalpers = Array.isArray(status?.scalpers) ? status.scalpers : [];
    const targetSymbol = symbolKey(symbol);
    const targetSide = normalizeStartSide(startSide);
    const matches = scalpers
        .map((row) => ({
            scalperId: Number(row?.scalper_id ?? row?.scalperId),
            symbol: symbolKey(row?.symbol),
            startSide: normalizeStartSide(row?.start_side ?? row?.startSide),
        }))
        .filter((row) => Number.isFinite(row.scalperId) && row.scalperId > 0)
        .filter((row) => (!targetSymbol || row.symbol === targetSymbol))
        .filter((row) => (!targetSide || row.startSide === targetSide))
        .sort((a, b) => b.scalperId - a.scalperId);
    if (matches.length === 0) return null;
    return String(Math.trunc(matches[0].scalperId));
}

// POST /api/trade/scalper — Start a scalper via C++ ScalperActor
router.post('/scalper', requireOwnership('body'), async (req, res) => {
    let idem = null;
    try {
        const prepared = await buildScalperStartCommand(req.body);

        idem = await beginIdempotentRequest(req, 'trade:scalper-start');
        if (idem?.replay) {
            res.set('X-Idempotency-Replayed', '1');
            return res.status(idem.replay.statusCode || 200).json(idem.replay.body || {});
        }
        if (idem?.conflict) {
            return res.status(409).json({ error: 'Duplicate request in progress (idempotency key)' });
        }

        const bridge = await ensureSubmitPreflight({
            getBridge: getSimplxBridge,
            subAccountId: prepared.subAccountId,
            sync: true,
        });
        const requestId = await bridge.sendCommand('scalper_start', prepared.command);
        let scalperId = await waitForScalperStarted(bridge, requestId, 1800);
        if (!scalperId) {
            scalperId = await fallbackScalperIdLookup(bridge, prepared);
        }
        if (!scalperId) {
            scalperId = String(requestId);
        }

        res.set('X-Source', 'cpp-engine');
        const responseBody = {
            success: true,
            accepted: true,
            source: 'cpp-engine',
            status: 'QUEUED',
            persistencePending: false,
            requestId,
            scalperId,
            symbol: prepared.symbol,
            startSide: prepared.startSide,
            longLayers: prepared.childCount,
            shortLayers: prepared.childCount,
            longSizeUsd: prepared.longSizeUsd,
            shortSizeUsd: prepared.shortSizeUsd,
        };
        await completeIdempotentRequest(idem, { statusCode: 202, body: responseBody });
        return res.status(202).json(responseBody);
    } catch (err) {
        await releaseIdempotentRequest(idem);
        const msg = String(err?.message || 'Scalper start failed');
        const lower = msg.toLowerCase();
        const isUserError =
            lower.includes('missing')
            || lower.includes('invalid')
            || lower.includes('min')
            || lower.includes('size too small');
        console.error('[Scalper] Start failed:', msg);
        res.status(isUserError ? 400 : 500).json({ error: msg });
    }
});

// GET /api/trade/scalper/active/:subAccountId
router.get('/scalper/active/:subAccountId', requireOwnership(), async (req, res) => {
    try {
        const bridge = getSimplxBridge();
        if (bridge?.isHealthy()) {
            bridge.sendCommand('scalper_status', { sub_account_id: req.params.subAccountId }).catch(() => { });
        }
        res.json([]); // Real-time status via WS
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/trade/scalper/:scalperId
router.delete('/scalper/:scalperId', async (req, res) => {
    try {
        const bridge = await ensureSubmitPreflight({
            getBridge: getSimplxBridge,
            subAccountId: '',
            sync: false,
        });

        await bridge.sendCommand('scalper_cancel', { scalper_id: req.params.scalperId });
        res.json({ success: true, scalperId: req.params.scalperId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Internal API for agent-base.js ─────────────────────────────────────

/**
 * Start a scalper programmatically (used by AgentBase.spawnScalper).
 * Delegates to C++ ScalperActor via UDS bridge.
 */
export async function startScalperInternal(opts = {}) {
    const prepared = await buildScalperStartCommand(opts, {
        subAccountId: opts.subAccountId,
        symbol: opts.symbol,
        startSide: opts.startSide || opts.side,
        agentOwned: !!opts._agentOwned,
    });
    const bridge = await ensureSubmitPreflight({
        getBridge: getSimplxBridge,
        subAccountId: prepared.subAccountId,
        sync: true,
    });
    const requestId = await bridge.sendCommand('scalper_start', prepared.command);
    let scalperId = await waitForScalperStarted(bridge, requestId, 1800);
    if (!scalperId) {
        scalperId = await fallbackScalperIdLookup(bridge, prepared);
    }
    if (!scalperId) {
        scalperId = String(requestId);
    }
    return { success: true, source: 'cpp-engine', requestId, scalperId };
}

/**
 * Cancel a scalper programmatically (used by AgentBase.killScalper).
 * Delegates to C++ ScalperActor via UDS bridge.
 */
export async function cancelScalperInternal(scalperId) {
    const bridge = await ensureSubmitPreflight({
        getBridge: getSimplxBridge,
        subAccountId: '',
        sync: false,
    });
    await bridge.sendCommand('scalper_cancel', { scalper_id: scalperId });
}

// No-op stubs for backward compat (chase functions no longer needed from scalper.js)
export function startChaseInternal() { throw new Error('JS chase orchestration removed — use C++ engine'); }
export function cancelChaseInternal() { return Promise.resolve(); }
export function startChaseBatch() { return Promise.resolve([]); }

export default router;

import { api, formatPnlClass, formatUsd } from '../../../core/index.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderPlaceholder(label) {
    return `<div style="padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface-1); color:var(--text-muted); font-size:11px;">${escapeHtml(label)}</div>`;
}

function buildSparkline(points = []) {
    if (!Array.isArray(points) || !points.length) {
        return '<div style="padding:10px 12px; color:var(--text-muted); font-size:11px;">No PnL samples yet.</div>';
    }
    const values = points.map((point) => Number(point.value || 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = 240;
    const height = 48;
    const step = values.length > 1 ? width / (values.length - 1) : width;
    const span = Math.max(1e-9, max - min);
    const path = values
        .map((value, index) => {
            const x = index * step;
            const y = height - (((value - min) / span) * height);
            return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(' ');
    const current = values[values.length - 1] || 0;
    return `
        <div style="display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface-1);">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Mini PnL</div>
                <div class="${formatPnlClass(current)}" style="font-size:12px; font-weight:600;">${formatUsd(current, 2)}</div>
            </div>
            <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:48px; overflow:visible;">
                <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        </div>
    `;
}

export function createEmbedSummarySource({
    getSubAccountId,
    getSymbol = null,
    getStrategySessionId = null,
    intervalMs = 45000,
}) {
    let timer = null;
    let destroyed = false;
    const listeners = new Set();

    const notify = (payload) => {
        for (const listener of listeners) listener(payload);
    };

    const fetchPayload = async () => {
        const subAccountId = typeof getSubAccountId === 'function' ? getSubAccountId() : null;
        if (!subAccountId) {
            notify({ scoreCard: null, activeStrategy: null, sparkline: [], _idle: true });
            return;
        }
        const params = new URLSearchParams();
        const symbol = typeof getSymbol === 'function' ? getSymbol() : null;
        const strategySessionId = typeof getStrategySessionId === 'function' ? getStrategySessionId() : null;
        if (symbol) params.set('symbol', symbol);
        if (strategySessionId) params.set('strategySessionId', strategySessionId);
        const query = params.toString();
        const payload = await api(`/trade/tca/embed-summary/${subAccountId}${query ? `?${query}` : ''}`);
        notify(payload);
    };

    const tick = async () => {
        if (destroyed) return;
        try {
            await fetchPayload();
        } catch (err) {
            notify({ scoreCard: null, activeStrategy: null, sparkline: [], _error: err?.message || 'Failed to load TCA embed' });
        } finally {
            if (!destroyed && listeners.size) {
                timer = window.setTimeout(tick, intervalMs);
            }
        }
    };

    const start = () => {
        if (timer || destroyed || !listeners.size) return;
        void tick();
    };

    return {
        subscribe(listener) {
            listeners.add(listener);
            start();
            return () => {
                listeners.delete(listener);
                if (!listeners.size && timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
        },
        destroy() {
            destroyed = true;
            listeners.clear();
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

function mountWidget(container, source, render) {
    if (!container || !source) return () => { };
    container.innerHTML = renderPlaceholder('Loading TCA…');
    const unsubscribe = source.subscribe((payload) => {
        container.innerHTML = render(payload);
    });
    return () => {
        unsubscribe();
        if (container.isConnected) container.innerHTML = '';
    };
}

export function mountExecutionScoreCard(container, options = {}) {
    const source = options.source || createEmbedSummarySource(options);
    return mountWidget(container, source, (payload) => {
        if (payload?._error) return renderPlaceholder(payload._error);
        if (payload?._idle) return renderPlaceholder('Select an account to load TCA.');
        const score = payload?.scoreCard;
        if (!score) return renderPlaceholder('No execution score yet.');
        return `
            <div style="display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface-1);">
                <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Execution Scorecard</div>
                <div class="${formatPnlClass(score.netPnl || 0)}" style="font-size:18px; font-weight:700;">${formatUsd(score.netPnl || 0, 2)}</div>
                <div style="display:flex; justify-content:space-between; gap:12px; font-size:11px; color:var(--text-muted);">
                    <span>${Number(score.fillCount || 0)} fills</span>
                    <span>${score.avgArrivalSlippageBps == null ? '—' : `${Number(score.avgArrivalSlippageBps).toFixed(1)} bps`}</span>
                    <span>Tox ${Number(score.toxicityScore || 0).toFixed(2)}</span>
                </div>
            </div>
        `;
    });
}

export function mountMiniPnlSparkline(container, options = {}) {
    const source = options.source || createEmbedSummarySource(options);
    return mountWidget(container, source, (payload) => {
        if (payload?._error) return renderPlaceholder(payload._error);
        if (payload?._idle) return renderPlaceholder('Mini PnL waits for an account.');
        return buildSparkline(payload?.sparkline || []);
    });
}

export function mountActiveStrategyBadge(container, options = {}) {
    const source = options.source || createEmbedSummarySource(options);
    return mountWidget(container, source, (payload) => {
        if (payload?._error) return renderPlaceholder(payload._error);
        if (payload?._idle) return renderPlaceholder('No active strategy.');
        const strategy = payload?.activeStrategy;
        if (!strategy) return renderPlaceholder('No active strategy.');
        return `
            <div style="display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface-1);">
                <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
                    <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Active Strategy</div>
                    <div style="font-size:10px; color:var(--text-muted);">${escapeHtml(strategy.runtimeStatus || 'UNKNOWN')}</div>
                </div>
                <div style="font-size:13px; font-weight:600; color:var(--text);">${escapeHtml(strategy.strategyType || 'Strategy')} · ${escapeHtml(strategy.symbol || '—')}</div>
                <div style="display:flex; justify-content:space-between; gap:8px; font-size:11px; color:var(--text-muted);">
                    <span>${escapeHtml(strategy.side || '—')}</span>
                    <span class="${formatPnlClass(strategy.netPnl || 0)}">${formatUsd(strategy.netPnl || 0, 2)}</span>
                </div>
            </div>
        `;
    });
}

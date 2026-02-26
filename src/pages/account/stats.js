// ── Account Page – Stats & Equity Chart ──
import { state, api, formatUsd, formatPnlClass } from '../../core/index.js';
import { cuteSeedling } from '../../lib/cute-empty.js';

export async function loadAccountStats() {
    if (!state.currentAccount) return;

    try {
        const stats = await api(`/trade/stats/${state.currentAccount}`);
        window._acctStats = stats;

        const balEl = document.getElementById('acct-balance');
        if (balEl) balEl.textContent = `$${stats.account.balance.toFixed(2)}`;

        updatePnlPeriod(stats.periods, 'today');

        const act = stats.activity;
        setEl('acct-total-trades', act.totalTrades);
        setEl('acct-avg-pnl', formatUsd(act.avgPnl, 4), formatPnlClass(act.avgPnl));
        setEl('acct-best', formatUsd(act.bestTrade, 4));
        setEl('acct-worst', formatUsd(act.worstTrade, 4));
        setEl('acct-pf', act.profitFactor === Infinity ? '∞' : act.profitFactor.toFixed(2));
        setEl('acct-total-fees', `$${act.totalFees.toFixed(4)}`);

        renderEquityChart(stats.equityCurve);
    } catch (err) {
        console.error('Failed to load account stats:', err);
    }
}

export function updatePnlPeriod(periods, period) {
    const p = periods[period];
    if (!p) return;

    const rpnlEl = document.getElementById('acct-rpnl');
    if (rpnlEl) {
        rpnlEl.textContent = formatUsd(p.rpnl, 4);
        rpnlEl.className = `price-big ${formatPnlClass(p.rpnl)}`;
        rpnlEl.style.fontSize = '22px';
    }

    const wr = p.count > 0 ? (p.wins / p.count * 100).toFixed(1) : '—';
    setEl('acct-winrate', wr !== '—' ? `${wr}%` : '—');
    setEl('acct-trade-count', p.count);
    setEl('acct-wins', p.wins);
    setEl('acct-losses', p.losses);
    setEl('acct-fees', `$${p.totalFees.toFixed(4)}`);
}

export function setEl(id, text, className) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (className) el.className = `stat-value ${className}`;
}

function renderEquityChart(data) {
    const container = document.getElementById('equity-chart');
    if (!container || typeof LightweightCharts === 'undefined' || data.length === 0) {
        if (container) container.innerHTML = cuteSeedling({ title: 'No Equity Data Yet ✨', subtitle: 'Start trading to see your growth~ 🌱' });
        return;
    }

    const chart = LightweightCharts.createChart(container, {
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b95a8', fontSize: 10 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true },
        handleScroll: { vertTouchDrag: false },
        width: container.clientWidth,
        height: 200,
    });

    const series = chart.addAreaSeries({
        lineColor: '#6366f1',
        topColor: 'rgba(99,102,241,0.3)',
        bottomColor: 'rgba(99,102,241,0.02)',
        lineWidth: 2,
    });

    const chartData = data.map(d => ({
        time: Math.floor(new Date(d.time).getTime() / 1000),
        value: d.value,
    }));

    const seen = new Set();
    const deduped = chartData.filter(d => {
        if (seen.has(d.time)) return false;
        seen.add(d.time);
        return true;
    }).sort((a, b) => a.time - b.time);

    if (deduped.length > 0) series.setData(deduped);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
        if (container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);
}

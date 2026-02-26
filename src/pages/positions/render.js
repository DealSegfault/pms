// ── Positions Page – Rendering ──
// Pure DOM rendering: summary stats, position cards, babysitter feature overlays.

import { formatUsd, formatPrice, formatPnlClass } from '../../core/index.js';
import { cuteSleepyCat } from '../../lib/cute-empty.js';

// ── Babysitter gate labels ──
export const gateLabels = {
    ready: '✅ Ready',
    below_target: '📊 Below Target',
    cooldown: '⏳ Cooldown',
    pending_close: '🔄 Pending Close',
    excluded: '🚫 Excluded',
    no_mark_price: '❓ No Price',
};

// ── Babysitter live feature stream handler ──
export function handleBabysitterFeatures(e) {
    const data = e.detail;
    if (!data || !data.positions) return;

    const positions = data.positions;
    let hasAnyFeatures = false;

    for (const f of positions) {
        const row = document.getElementById(`bbs-feat-${f.positionId}`);
        if (!row) continue;

        hasAnyFeatures = true;

        const progress = f.targetBps > 0 ? Math.min(100, Math.max(0, (f.pnlBps / f.targetBps) * 100)) : 0;
        const progressColor = f.shouldClose ? 'var(--green)' : (progress > 60 ? '#eab308' : 'var(--accent)');

        row.classList.add('active');
        row.innerHTML = `
      <span class="bbs-feat-chip" title="TP Model">${f.tpModel || '—'}</span>
      <span class="bbs-feat-chip" title="PnL bps / Target bps">
        ${f.pnlBps}/${f.targetBps}bp
        <span class="bbs-progress-bar">
          <span class="bbs-progress-fill" style="width:${progress}%;background:${progressColor}"></span>
        </span>
      </span>
      <span class="bbs-feat-chip gate-${f.gate}" title="Gate status">${gateLabels[f.gate] || f.gate}</span>
      <span class="bbs-feat-chip" title="Signal bias">${f.bias === 'LONG' ? '🟢' : f.bias === 'SHORT' ? '🔴' : '⚪'} ${f.bias}</span>
    `;
    }

    const console_ = document.getElementById('bbs-log-console');
    if (console_ && hasAnyFeatures) console_.style.display = '';

    const logBody = document.getElementById('bbs-log-body');
    if (logBody) {
        const now = new Date().toLocaleTimeString();
        for (const f of positions) {
            if (f.gate === 'ready' || f.gate === 'excluded') continue;
            const sym = f.symbol?.split('/')[0] || f.symbol;
            const line = document.createElement('div');
            line.className = 'bbs-log-line';
            line.innerHTML = `<span style="color:var(--text-muted)">${now}</span> <b>${sym}</b> <span class="gate-tag" style="color:${f.gate === 'below_target' ? '#eab308' : f.gate === 'cooldown' ? '#3b82f6' : '#a855f7'}">[${f.gate}]</span> pnl=${f.pnlBps}bp target=${f.targetBps}bp model=${f.tpModel}`;
            logBody.appendChild(line);
        }
        while (logBody.children.length > 50) logBody.removeChild(logBody.firstChild);
        if (logBody.classList.contains('open')) {
            logBody.scrollTop = logBody.scrollHeight;
        }
    }
}

// ── Summary stats ──
export function renderSummary(summary, { cachedBalance, cachedMarginUsed, latestMarkPrices, setCachedBalance, setCachedMarginUsed }) {
    if (!summary) return;

    setCachedBalance(summary.balance || 0);
    setCachedMarginUsed(summary.marginUsed || 0);

    const equityEl = document.getElementById('total-equity');
    const upnlEl = document.getElementById('total-upnl');

    if (equityEl) equityEl.textContent = `$${summary.equity.toFixed(2)}`;
    const hasLivePrices = Object.keys(latestMarkPrices).length > 0;
    if (upnlEl && !hasLivePrices) {
        upnlEl.textContent = formatUsd(summary.unrealizedPnl);
        upnlEl.className = `price-big ${formatPnlClass(summary.unrealizedPnl)}`;
        upnlEl.style.fontSize = '20px';
    }

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = `$${val.toFixed(2)}`;
    };
    setVal('stat-balance', summary.balance);
    setVal('stat-margin', summary.marginUsed);
    setVal('stat-available', summary.availableMargin);
    setVal('stat-exposure', summary.totalExposure);

    const mrEl = document.getElementById('stat-margin-ratio');
    if (mrEl) {
        const pct = ((summary.marginRatio || 0) * 100).toFixed(1);
        mrEl.textContent = `${pct}%`;
        mrEl.style.color = summary.marginRatio >= 0.8 ? 'var(--red)' : summary.marginRatio >= 0.5 ? 'orange' : 'var(--text)';
    }

    const lpEl = document.getElementById('stat-liq-price');
    if (lpEl) lpEl.textContent = summary.accountLiqPrice ? `$${formatPrice(summary.accountLiqPrice)}` : '—';

    const countEl = document.getElementById('position-count');
    if (countEl) countEl.textContent = summary.positionCount;
}

// ── Position list rendering ──
export function renderPositionsList(positions, latestMarkPrices) {
    const list = document.getElementById('positions-list');
    if (!list) return;

    if (!positions || positions.length === 0) {
        list.innerHTML = cuteSleepyCat({ title: 'No More Positions ✨', subtitle: 'All cozy with no open trades~ 💤' });
        return;
    }

    list.innerHTML = positions.map(pos => {
        const liveMarkPrice = latestMarkPrices[pos.symbol];
        let pnl, pnlPct;
        if (liveMarkPrice) {
            pnl = pos.side === 'LONG'
                ? (liveMarkPrice - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - liveMarkPrice) * pos.quantity;
            pnlPct = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
        } else {
            pnl = pos.unrealizedPnl || 0;
            pnlPct = pos.pnlPercent || 0;
        }
        const pnlClass = formatPnlClass(pnl);
        const elapsed = pos.openedAt ? getTimeHeld(pos.openedAt) : '—';
        const displayMarkPrice = liveMarkPrice || pos.markPrice || pos.entryPrice;
        const babysitterOn = !pos.babysitterExcluded;
        const babysitterLabel = babysitterOn ? 'Babysitter On' : 'Babysitter Off';
        const babysitterClass = babysitterOn ? 'on' : 'off';

        return `
      <div class="position-card" data-id="${pos.id}"
           data-symbol="${pos.symbol}" data-side="${pos.side}"
           data-entry="${pos.entryPrice}" data-qty="${pos.quantity}"
            data-margin="${pos.margin}">
        <div class="position-header">
          <div class="position-symbol">
            <span class="pos-sym-link" data-nav-symbol="${pos.symbol}" style="cursor:pointer;">${pos.symbol.split('/')[0]}</span>
            <span class="badge badge-${pos.side.toLowerCase()}">${pos.side}</span>
            <span style="font-size: 11px; color: var(--text-muted);">${pos.leverage}x</span>
            <button
              class="bbs-symbol-toggle ${babysitterClass}"
              data-bbs-toggle-pos="${pos.id}"
              data-bbs-excluded="${pos.babysitterExcluded ? '1' : '0'}"
              title="Toggle babysitter for this position"
            >
              ${babysitterLabel}
            </button>
            <span data-opened-at="${pos.openedAt || ''}" style="font-size: 10px; color: var(--text-muted); margin-left: 4px;">⏱ ${elapsed}</span>
          </div>
          <div class="position-pnl ${pnlClass}">
            <span class="pos-pnl-value" data-pnl-id="${pos.id}" data-prev-pnl="${pnl}">${formatUsd(pnl, 3)}</span>
            <span style="font-size: 11px; margin-left: 4px;">(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>
          </div>
        </div>
        <div class="position-details">
          <div>
            <div class="position-detail-label">Entry</div>
            <div class="position-detail-value">$${formatPrice(pos.entryPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Mark</div>
            <div class="position-detail-value pos-mark-price" data-mark-id="${pos.id}" style="color: ${pnl >= 0 ? 'var(--green)' : 'var(--red)'}">$${formatPrice(displayMarkPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Liquidation</div>
            <div class="position-detail-value" data-liq-id="${pos.id}" style="color: var(--red);">$${formatPrice(pos.liquidationPrice)}</div>
          </div>
          <div>
            <div class="position-detail-label">Margin</div>
            <div class="position-detail-value">$${pos.margin.toFixed(2)}</div>
          </div>
          <div>
            <div class="position-detail-label">Notional</div>
            <div class="position-detail-value">$${pos.notional.toFixed(2)}</div>
          </div>
          <div>
            <div class="position-detail-label">Quantity</div>
            <div class="position-detail-value">${pos.quantity.toFixed(6)}</div>
          </div>
        </div>
        <div class="pos-action-row">
          <button class="btn btn-danger btn-sm" data-market-close="${pos.id}" data-symbol="${pos.symbol}">⬇ Market Close</button>
          <button class="btn btn-outline btn-sm" data-toggle-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">📊 Limit Close</button>
        </div>
        <div class="limit-close-form" id="limit-form-${pos.id}">
          <input type="number" id="limit-price-${pos.id}" placeholder="Limit price" step="0.01" value="${formatPrice(pos.markPrice || pos.entryPrice)}" />
          <button class="btn btn-outline btn-sm" data-submit-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">Set</button>
        </div>
        <div class="bbs-features-row" id="bbs-feat-${pos.id}"></div>
      </div>
    `;
    }).join('');
}

// ── Build a new position card for optimistic creation ──
export function buildPositionCardHtml(pos) {
    const pnl = 0;
    const pnlPct = 0;
    const pnlClass = formatPnlClass(pnl);
    const elapsed = pos.openedAt ? getTimeHeld(pos.openedAt) : '—';
    const displayMarkPrice = pos.markPrice || pos.entryPrice;
    const babysitterOn = !pos.babysitterExcluded;
    const babysitterLabel = babysitterOn ? 'Babysitter On' : 'Babysitter Off';
    const babysitterClass = babysitterOn ? 'on' : 'off';

    return `
    <div class="position-card" data-id="${pos.id}"
         data-symbol="${pos.symbol}" data-side="${pos.side}"
         data-entry="${pos.entryPrice}" data-qty="${pos.quantity}"
          data-margin="${pos.margin}">
      <div class="position-header">
        <div class="position-symbol">
          <span class="pos-sym-link" data-nav-symbol="${pos.symbol}" style="cursor:pointer;">${pos.symbol.split('/')[0]}</span>
          <span class="badge badge-${pos.side.toLowerCase()}">${pos.side}</span>
          <span style="font-size: 11px; color: var(--text-muted);">${pos.leverage}x</span>
          <button
            class="bbs-symbol-toggle ${babysitterClass}"
            data-bbs-toggle-pos="${pos.id}"
            data-bbs-excluded="${pos.babysitterExcluded ? '1' : '0'}"
            title="Toggle babysitter for this position"
          >
            ${babysitterLabel}
          </button>
          <span data-opened-at="${pos.openedAt || ''}" style="font-size: 10px; color: var(--text-muted); margin-left: 4px;">⏱ ${elapsed}</span>
        </div>
        <div class="position-pnl ${pnlClass}">
          <span class="pos-pnl-value" data-pnl-id="${pos.id}" data-prev-pnl="${pnl}">${formatUsd(pnl, 3)}</span>
          <span style="font-size: 11px; margin-left: 4px;">(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>
        </div>
      </div>
      <div class="position-details">
        <div>
          <div class="position-detail-label">Entry</div>
          <div class="position-detail-value">$${formatPrice(pos.entryPrice)}</div>
        </div>
        <div>
          <div class="position-detail-label">Mark</div>
          <div class="position-detail-value pos-mark-price" data-mark-id="${pos.id}" style="color: var(--text-muted)">$${formatPrice(displayMarkPrice)}</div>
        </div>
        <div>
          <div class="position-detail-label">Liquidation</div>
          <div class="position-detail-value" data-liq-id="${pos.id}" style="color: var(--red);">$${formatPrice(pos.liquidationPrice)}</div>
        </div>
        <div>
          <div class="position-detail-label">Margin</div>
          <div class="position-detail-value">$${pos.margin.toFixed(2)}</div>
        </div>
        <div>
          <div class="position-detail-label">Notional</div>
          <div class="position-detail-value">$${pos.notional.toFixed(2)}</div>
        </div>
        <div>
          <div class="position-detail-label">Quantity</div>
          <div class="position-detail-value">${pos.quantity.toFixed(6)}</div>
        </div>
      </div>
      <div class="pos-action-row">
        <button class="btn btn-danger btn-sm" data-market-close="${pos.id}" data-symbol="${pos.symbol}">⬇ Market Close</button>
        <button class="btn btn-outline btn-sm" data-toggle-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">📊 Limit Close</button>
      </div>
      <div class="limit-close-form" id="limit-form-${pos.id}">
        <input type="number" id="limit-price-${pos.id}" placeholder="Limit price" step="0.01" value="${formatPrice(pos.entryPrice)}" />
        <button class="btn btn-outline btn-sm" data-submit-limit="${pos.id}" style="border-color: var(--accent); color: var(--accent);">Set</button>
      </div>
      <div class="bbs-features-row" id="bbs-feat-${pos.id}"></div>
    </div>
  `;
}

// ── Time held helper ──
export function getTimeHeld(openedAt) {
    const ms = Date.now() - new Date(openedAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

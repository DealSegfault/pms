// ── Admin – Rules, Overview & Liquidation Tabs ──
// Risk rule management, dashboard overview, and liquidation controls.

import { state, api, showToast, formatUsd, formatPrice, formatPnlClass } from '../../core/index.js';
import { cuteSpinner, cuteChart, cuteSadFace } from '../../lib/cute-empty.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';

// ── Risk Rules Tab ──

export async function renderRulesTab(container, renderTabContent) {
    container.innerHTML = cuteSpinner();

    try {
        const [rules, allAccounts] = await Promise.all([
            api('/risk-rules'),
            api('/sub-accounts'),
        ]);
        const globalRule = rules.find(r => r.isGlobal);

        let html = `
      <div class="glass-card">
        <div class="card-header">
          <span class="card-title">Global Risk Rules</span>
        </div>
        <div class="input-group">
          <label>Max Leverage</label>
          <input type="number" id="rule-leverage" value="${globalRule?.maxLeverage || 100}" step="1" inputmode="numeric" />
        </div>
        <div class="input-group">
          <label>Max Notional Per Trade (USDT)</label>
          <input type="number" id="rule-notional" value="${globalRule?.maxNotionalPerTrade || 200}" step="1" inputmode="decimal" />
        </div>
        <div class="input-group">
          <label>Max Total Exposure (USDT)</label>
          <input type="number" id="rule-exposure" value="${globalRule?.maxTotalExposure || 500}" step="1" inputmode="decimal" />
        </div>
        <div class="input-group">
          <label>Liquidation Threshold (0-1)</label>
          <input type="number" id="rule-liq" value="${globalRule?.liquidationThreshold || 0.90}" step="0.01" min="0.1" max="1" inputmode="decimal" />
        </div>
        <button class="btn btn-primary btn-block" onclick="window._saveGlobalRules()">Save Global Rules</button>
      </div>
    `;

        if (allAccounts.length > 0) {
            html += `<div class="section-header" style="margin-top:16px;"><h2 class="section-title">User Accounts</h2></div>`;

            for (const acct of allAccounts) {
                const acctRule = rules.find(r => r.subAccountId === acct.id);
                const posCount = acct.positions?.length || 0;
                const uPnL = (acct.positions || []).reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

                html += `
          <div class="card" style="margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <div>
                <span style="font-weight:700;">${acct.name}</span>
                <span class="badge badge-${acct.status.toLowerCase()}" style="margin-left:6px;">${acct.status}</span>
                <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">${acct.type}</span>
              </div>
              <span style="font-family:var(--font-mono); font-weight:600;">$${acct.currentBalance.toFixed(2)}</span>
            </div>
            <div class="stat-grid" style="margin-bottom:8px;">
              <div class="stat-item">
                <div class="stat-label">Balance</div>
                <div class="stat-value" style="font-size:13px;">$${acct.currentBalance.toFixed(2)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">Positions</div>
                <div class="stat-value" style="font-size:13px;">${posCount}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">uPnL</div>
                <div class="stat-value ${formatPnlClass(uPnL)}" style="font-size:13px;">${formatUsd(uPnL)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">Liq Mode</div>
                <div class="stat-value" style="font-size:11px;">${acct.liquidationMode || 'ADL_30'}</div>
              </div>
            </div>

            <details style="margin-top:6px;">
              <summary style="cursor:pointer; font-size:12px; color:var(--text-muted);">Risk Rules & Balance</summary>
              <div style="margin-top:8px;">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
                  <div class="input-group" style="margin:0;">
                    <label style="font-size:10px;">Max Leverage</label>
                    <input type="number" id="acct-lev-${acct.id}" value="${acctRule?.maxLeverage || globalRule?.maxLeverage || 100}" step="1" style="font-size:12px;" />
                  </div>
                  <div class="input-group" style="margin:0;">
                    <label style="font-size:10px;">Max Notional</label>
                    <input type="number" id="acct-not-${acct.id}" value="${acctRule?.maxNotionalPerTrade || globalRule?.maxNotionalPerTrade || 200}" step="1" style="font-size:12px;" />
                  </div>
                  <div class="input-group" style="margin:0;">
                    <label style="font-size:10px;">Max Exposure</label>
                    <input type="number" id="acct-exp-${acct.id}" value="${acctRule?.maxTotalExposure || globalRule?.maxTotalExposure || 500}" step="1" style="font-size:12px;" />
                  </div>
                  <div class="input-group" style="margin:0;">
                    <label style="font-size:10px;">Liq Threshold</label>
                    <input type="number" id="acct-liq-${acct.id}" value="${acctRule?.liquidationThreshold || globalRule?.liquidationThreshold || 0.9}" step="0.01" style="font-size:12px;" />
                  </div>
                </div>

                <div class="input-group" style="margin:0 0 8px 0;">
                  <label style="font-size:10px;">Liquidation Rule</label>
                  <select id="acct-liqmode-${acct.id}" 
                    style="width:100%; padding:8px; font-size:12px; background:var(--surface-2); color:var(--text); border:1px solid var(--border); border-radius:6px;">
                    <option value="ADL_30" ${(acct.liquidationMode || 'ADL_30') === 'ADL_30' ? 'selected' : ''}>ADL 30% — Gradual deleveraging</option>
                    <option value="INSTANT_CLOSE" ${acct.liquidationMode === 'INSTANT_CLOSE' ? 'selected' : ''}>Force Close — Market close on exchange</option>
                    <option value="TAKEOVER" ${acct.liquidationMode === 'TAKEOVER' ? 'selected' : ''}>Takeover — Virtual liq (no exchange close)</option>
                  </select>
                </div>
                <button class="btn btn-outline btn-sm btn-block" onclick="window._saveAcctRulesAndMode('${acct.id}')">Save Rules & Mode</button>

                <div style="display:flex; gap:6px; margin-top:8px; align-items:flex-end;">
                  <div class="input-group" style="margin:0; flex:1;">
                    <label style="font-size:10px;">Adjust Balance (± USDT)</label>
                    <input type="number" id="acct-bal-${acct.id}" value="0" step="10" style="font-size:12px;" />
                  </div>
                  <button class="btn btn-primary btn-sm" onclick="window._adjustBalance('${acct.id}')" style="height:34px;">Apply</button>
                </div>
              </div>
            </details>
          </div>
        `;
            }
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = cuteSadFace({ subtitle: err.message });
    }
}

export function bindRulesActions(renderTabContent) {
    window._saveGlobalRules = async () => {
        try {
            const data = {
                maxLeverage: parseFloat(document.getElementById('rule-leverage').value),
                maxNotionalPerTrade: parseFloat(document.getElementById('rule-notional').value),
                maxTotalExposure: parseFloat(document.getElementById('rule-exposure').value),
                liquidationThreshold: parseFloat(document.getElementById('rule-liq').value),
            };
            await api('/risk-rules/global', { method: 'PUT', body: data });
            showToast('Global rules updated', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    };

    window._saveAcctRules = async (acctId) => {
        try {
            const data = {
                maxLeverage: parseFloat(document.getElementById(`acct-lev-${acctId}`).value),
                maxNotionalPerTrade: parseFloat(document.getElementById(`acct-not-${acctId}`).value),
                maxTotalExposure: parseFloat(document.getElementById(`acct-exp-${acctId}`).value),
                liquidationThreshold: parseFloat(document.getElementById(`acct-liq-${acctId}`).value),
            };
            await api(`/risk-rules/${acctId}`, { method: 'PUT', body: data });
            showToast('Account rules saved', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    };

    window._saveAcctRulesAndMode = async (acctId) => {
        try {
            const data = {
                maxLeverage: parseFloat(document.getElementById(`acct-lev-${acctId}`).value),
                maxNotionalPerTrade: parseFloat(document.getElementById(`acct-not-${acctId}`).value),
                maxTotalExposure: parseFloat(document.getElementById(`acct-exp-${acctId}`).value),
                liquidationThreshold: parseFloat(document.getElementById(`acct-liq-${acctId}`).value),
            };
            await api(`/risk-rules/${acctId}`, { method: 'PUT', body: data });
            const modeSelect = document.getElementById(`acct-liqmode-${acctId}`);
            if (modeSelect) await api(`/admin/liquidation-mode/${acctId}`, { method: 'POST', body: { mode: modeSelect.value } });
            showToast('Rules & liquidation mode saved', 'success');
            renderTabContent();
        } catch (err) { showToast(err.message, 'error'); }
    };

    window._adjustBalance = async (acctId) => {
        try {
            const amount = parseFloat(document.getElementById(`acct-bal-${acctId}`).value);
            if (!amount || amount === 0) return showToast('Enter an amount', 'warning');
            await api(`/sub-accounts/${acctId}`, { method: 'PATCH', body: { addBalance: amount } });
            showToast(`Balance ${amount > 0 ? '+' : ''}${amount} applied`, 'success');
            renderTabContent();
        } catch (err) { showToast(err.message, 'error'); }
    };
}

// ── Overview Tab ──

export async function renderOverviewTab(container) {
    container.innerHTML = cuteSpinner();

    try {
        const data = await api('/admin/dashboard');
        let html = '';

        if (data.mainAccountBalance) {
            html += `
        <div class="glass-card">
          <div class="card-title" style="margin-bottom: 8px;">Main Account (Binance)</div>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">Total</div>
              <div class="stat-value">$${data.mainAccountBalance.total.toFixed(2)}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Free</div>
              <div class="stat-value">$${data.mainAccountBalance.free.toFixed(2)}</div>
            </div>
          </div>
        </div>
      `;
        }

        if (data.accounts && data.accounts.length > 0) {
            const totalEquity = data.accounts.reduce((s, a) => s + (a?.summary?.equity || 0), 0);
            const totalUpnl = data.accounts.reduce((s, a) => s + (a?.summary?.unrealizedPnl || 0), 0);
            const totalPositions = data.accounts.reduce((s, a) => s + (a?.summary?.positionCount || 0), 0);

            html += `
        <div class="glass-card">
          <div class="card-title" style="margin-bottom: 8px;">All Sub-Accounts</div>
          <div class="stat-grid">
            <div class="stat-item">
              <div class="stat-label">Total Equity</div>
              <div class="stat-value">$${totalEquity.toFixed(2)}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Unrealized PnL</div>
              <div class="stat-value ${formatPnlClass(totalUpnl)}">${formatUsd(totalUpnl)}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Active Accounts</div>
              <div class="stat-value">${data.accounts.filter(a => a?.account?.status === 'ACTIVE').length}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">Open Positions</div>
              <div class="stat-value">${totalPositions}</div>
            </div>
          </div>
        </div>
      `;

            for (const acctData of data.accounts) {
                if (!acctData?.account) continue;
                const a = acctData.account;
                const s = acctData.summary || {};
                html += `
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <div>
                <span style="font-weight: 700;">${a.name}</span>
                <span class="badge badge-${a.status.toLowerCase()}" style="margin-left: 6px;">${a.status}</span>
              </div>
              <span style="font-family: var(--font-mono); font-weight: 600;">$${(s.equity || 0).toFixed(2)}</span>
            </div>
            <div class="stat-grid">
              <div class="stat-item">
                <div class="stat-label">Margin Used</div>
                <div class="stat-value" style="font-size:13px;">$${(s.marginUsed || 0).toFixed(2)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">uPnL</div>
                <div class="stat-value ${formatPnlClass(s.unrealizedPnl || 0)}" style="font-size:13px;">${formatUsd(s.unrealizedPnl || 0)}</div>
              </div>
            </div>
          </div>
        `;
            }
        }

        container.innerHTML = html || cuteChart({ title: 'No Data Yet ✨', subtitle: 'Data will appear here~' });
    } catch (err) {
        container.innerHTML = cuteSadFace({ subtitle: err.message });
    }
}

// ── Liquidation Tab ──

export async function renderLiquidationTab(container, renderTabContent) {
    container.innerHTML = cuteSpinner();

    try {
        const [atRisk, allPositions] = await Promise.all([
            api('/admin/at-risk').catch(() => []),
            api('/admin/all-positions').catch(() => []),
        ]);

        let html = '';

        if (atRisk.length > 0) {
            html += `
        <div class="glass-card">
          <div class="card-title" style="margin-bottom: 8px; color: var(--red);">⚠️ At-Risk Accounts</div>
          ${atRisk.map(acctData => {
                const a = acctData.account;
                const s = acctData.summary || {};
                const mr = ((s.marginRatio || 0) * 100).toFixed(1);
                const mrColor = s.marginRatio >= 0.8 ? 'var(--red)' : s.marginRatio >= 0.5 ? 'orange' : 'var(--green)';
                return `
              <div class="card" style="margin-bottom: 8px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                  <div>
                    <span style="font-weight:700;">${a.name}</span>
                    <span class="badge badge-${a.status.toLowerCase()}" style="margin-left:6px;">${a.status}</span>
                    <span class="badge" style="margin-left:4px; font-size:9px; background:${a.liquidationMode === 'ADL_30' ? 'rgba(0,200,255,0.15)' : 'rgba(255,100,100,0.15)'};">${a.liquidationMode}</span>
                  </div>
                  <span style="font-family:var(--font-mono); font-weight:700; color:${mrColor};">${mr}%</span>
                </div>
                <div class="stat-grid">
                  <div class="stat-item">
                    <div class="stat-label">Equity</div>
                    <div class="stat-value" style="font-size:13px;">$${(s.equity || 0).toFixed(2)}</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-label">uPnL</div>
                    <div class="stat-value ${formatPnlClass(s.unrealizedPnl || 0)}" style="font-size:13px;">${formatUsd(s.unrealizedPnl || 0)}</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-label">Liq Price</div>
                    <div class="stat-value" style="font-size:13px; color:var(--red);">${s.accountLiqPrice ? '$' + formatPrice(s.accountLiqPrice) : '—'}</div>
                  </div>
                </div>
                <div style="display:flex; gap:6px; margin-top:8px; align-items:center;">
                  <label style="font-size:11px; color:var(--text-muted); white-space:nowrap;">Liq Rule:</label>
                  <select id="liq-mode-${a.id}" onchange="window._setLiqMode('${a.id}', this.value)" 
                    style="flex:1; padding:6px 8px; font-size:11px; background:var(--surface-2); color:var(--text); border:1px solid var(--border); border-radius:6px;">
                    <option value="ADL_30" ${(a.liquidationMode || 'ADL_30') === 'ADL_30' ? 'selected' : ''}>ADL 30% (Gradual)</option>
                    <option value="INSTANT_CLOSE" ${a.liquidationMode === 'INSTANT_CLOSE' ? 'selected' : ''}>Force Close (Market)</option>
                    <option value="TAKEOVER" ${a.liquidationMode === 'TAKEOVER' ? 'selected' : ''}>Takeover (Virtual Liq)</option>
                  </select>
                </div>
              </div>
            `;
            }).join('')}
        </div>
      `;
        } else {
            html += `<div class="glass-card"><div class="card-title" style="margin-bottom:8px;">✅ No At-Risk Accounts</div><p style="color:var(--text-muted); font-size:13px;">All accounts are healthy.</p></div>`;
        }

        if (allPositions.length > 0) {
            html += `
        <div class="glass-card" style="margin-top:12px;">
          <div class="card-title" style="margin-bottom:8px;">Open Positions (${allPositions.length})</div>
          <div style="margin-bottom:10px; padding:8px; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid var(--border);">
            <div style="display:flex; gap:12px; font-size:11px; color:var(--text-muted);">
              <span style="display:flex; align-items:center; gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:var(--red);display:inline-block;"></span> Virtual Close = Close on user's book, leave open on exchange</span>
              <span style="display:flex; align-items:center; gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:orange;display:inline-block;"></span> Market Close = Physically close on exchange</span>
            </div>
          </div>
          ${allPositions.map(pos => {
                const acctName = pos.subAccount?.name || 'Unknown';
                const acctLiqMode = pos.subAccount?.liquidationMode || 'ADL_30';
                const liqModeLabel = acctLiqMode === 'TAKEOVER' ? 'Virtual Liq' : acctLiqMode === 'INSTANT_CLOSE' ? 'Force Close' : 'ADL 30%';
                const liqModeColor = acctLiqMode === 'TAKEOVER' ? 'rgba(255,165,0,0.15)' : acctLiqMode === 'INSTANT_CLOSE' ? 'rgba(255,100,100,0.15)' : 'rgba(0,200,255,0.15)';
                return `
              <div class="card" style="margin-bottom:6px; padding:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <span style="font-weight:600; font-size:13px;">${pos.symbol.split('/')[0]}</span>
                    <span class="badge badge-${pos.side.toLowerCase()}" style="margin-left:4px;">${pos.side}</span>
                    <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">${acctName}</span>
                    <span class="badge" style="margin-left:4px; font-size:9px; background:${liqModeColor};">${liqModeLabel}</span>
                  </div>
                  <div style="display:flex; gap:6px;">
                    <button class="btn btn-sm" style="font-size:11px; background:rgba(255,100,100,0.15); color:var(--red); border:1px solid rgba(255,100,100,0.3);" onclick="window._takeoverPosition('${pos.id}')" title="Close on user's book only — position stays on exchange">🔄 Virtual Close</button>
                    <button class="btn btn-sm" style="font-size:11px; background:rgba(255,165,0,0.1); color:orange; border:1px solid rgba(255,165,0,0.3);" onclick="window._forceClosePosition('${pos.id}')" title="Physically close on the exchange with market order">⚡ Market Close</button>
                  </div>
                </div>
                <div style="display:flex; gap:12px; font-size:11px; margin-top:6px; color:var(--text-muted);">
                  <span>Entry: $${formatPrice(pos.entryPrice)}</span>
                  <span>Qty: ${pos.quantity}</span>
                  <span>Margin: $${pos.margin.toFixed(2)}</span>
                  <span>${pos.leverage}x</span>
                </div>
              </div>
            `;
            }).join('')}
        </div>
      `;
        }

        container.innerHTML = html || cuteChart({ title: 'No Data Yet ✨', subtitle: 'Data will appear here~' });
    } catch (err) {
        container.innerHTML = cuteSadFace({ subtitle: err.message });
    }
}

export function bindLiquidationActions(renderTabContent) {
    window._setLiqMode = async (subAccountId, mode) => {
        try { await api(`/admin/liquidation-mode/${subAccountId}`, { method: 'POST', body: { mode } }); showToast(`Mode set to ${mode}`, 'success'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };

    window._takeoverPosition = async (positionId) => {
        if (!(await cuteConfirm({ title: '🔄 Virtual Close (Takeover)?', message: "Position will be closed on the user's book and PnL settled — but it stays OPEN on the exchange. You absorb the position.", confirmText: 'Take Over', danger: true }))) return;
        try { await api(`/admin/takeover/${positionId}`, { method: 'POST' }); showToast('Position taken over (virtual close)', 'warning'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };

    window._forceClosePosition = async (positionId) => {
        if (!(await cuteConfirm({ title: '⚡ Market Close (Physical)?', message: 'This will send a real market order to the exchange to close this position.', confirmText: 'Market Close', danger: true }))) return;
        try { await api(`/admin/force-close/${positionId}`, { method: 'POST' }); showToast('Position force closed on exchange', 'success'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };
}

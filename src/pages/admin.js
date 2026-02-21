import { state, api, showToast, formatUsd, formatPrice, formatPnlClass } from '../core/index.js';
import { cuteSpinner, cuteFolder, cutePeople, cuteChart, cuteSadFace } from '../lib/cute-empty.js';
import { cuteConfirm } from '../lib/cute-confirm.js';

let currentTab = 'accounts';

export function renderAdminPage(container) {
  // Only show full admin for ADMIN role
  const isAdmin = state.user?.role === 'ADMIN';

  container.innerHTML = `
    <div id="admin-page">
      <div class="section-header">
        <h2 class="section-title">Admin Panel</h2>
      </div>

      <div class="tab-bar">
        <button class="active" onclick="window._adminTab('accounts')">Accounts</button>
        <button onclick="window._adminTab('rules')">Risk Rules</button>
        ${isAdmin ? `<button onclick="window._adminTab('users')">Users</button>` : ''}
        <button onclick="window._adminTab('liquidation')">Liquidation</button>
        <button onclick="window._adminTab('overview')">Overview</button>
      </div>

      <div id="admin-content"></div>
    </div>
  `;

  window._adminTab = (tab) => {
    currentTab = tab;
    const tabs = ['accounts', 'rules'];
    if (isAdmin) tabs.push('users');
    tabs.push('liquidation');
    tabs.push('overview');

    document.querySelectorAll('.tab-bar button').forEach((btn, i) => {
      btn.classList.toggle('active', tabs[i] === tab);
    });
    renderTabContent();
  };

  renderTabContent();
}

function renderTabContent() {
  const content = document.getElementById('admin-content');
  if (!content) return;

  switch (currentTab) {
    case 'accounts': renderAccountsTab(content); break;
    case 'rules': renderRulesTab(content); break;
    case 'users': renderUsersTab(content); break;
    case 'liquidation': renderLiquidationTab(content); break;
    case 'overview': renderOverviewTab(content); break;
  }
}

// === Accounts Tab ===
async function renderAccountsTab(container) {
  container.innerHTML = `
    <button class="btn btn-primary btn-block" onclick="window._showCreateAccount()" style="margin-bottom: 16px;">
      + Create Sub-Account
    </button>

    <!-- API Key Section -->
    <div class="card" style="margin-bottom: 16px; padding: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="font-weight: 600; font-size: 13px;">Bot API Key</span>
          <p style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Use this key for bot integrations</p>
        </div>
        <button class="btn btn-outline btn-sm" onclick="window._generateApiKey()">Generate</button>
      </div>
      <div id="api-key-display" style="margin-top: 8px;"></div>
    </div>

    <div id="accounts-list">${cuteSpinner()}</div>
  `;

  // Load current API key
  try {
    const me = await api('/auth/me');
    const keyDisplay = document.getElementById('api-key-display');
    if (me.apiKey && keyDisplay) {
      keyDisplay.innerHTML = `
        <div style="font-family: var(--font-mono); font-size: 11px; color: var(--accent); word-break: break-all; padding: 8px; background: rgba(0,200,255,0.05); border-radius: 6px; cursor: pointer;" 
             onclick="navigator.clipboard.writeText('${me.apiKey}'); document.querySelector('#api-key-display .copy-msg').style.display='inline';">
          ${me.apiKey}
          <span class="copy-msg" style="display:none; color: var(--green); margin-left: 8px;">✓ copied</span>
        </div>
      `;
    }
  } catch { }

  try {
    const accounts = await api('/sub-accounts');
    state.accounts = accounts;
    const list = document.getElementById('accounts-list');
    if (!list) return;

    if (accounts.length === 0) {
      list.innerHTML = cuteFolder({ title: 'No Sub-Accounts ✨', subtitle: 'Create one to get started~' });
      return;
    }

    list.innerHTML = accounts.map(a => `
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <div>
            <span style="font-weight: 700; font-size: 16px;">${a.name}</span>
            <span class="badge badge-${a.status.toLowerCase()}" style="margin-left: 8px;">${a.status}</span>
            <span class="badge" style="margin-left: 4px; font-size: 9px; background: rgba(255,255,255,0.05);">${a.type || 'USER'}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 10px;">
          <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Balance $</label>
          <input type="number" id="inline-bal-${a.id}" value="${a.currentBalance.toFixed(2)}" step="0.01" 
                 style="flex:1; background:var(--surface-2); color:var(--text); border:1px solid var(--border); border-radius:4px; font-size:14px; font-weight:600; padding:6px 8px; font-family:var(--font-mono); width:100%;" />
          <button class="btn btn-primary btn-sm" style="padding: 6px 10px; white-space: nowrap;" 
                  onclick="window._inlineSetBalance('${a.id}')">✓ Save</button>
        </div>
        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-label">Initial</div>
            <div class="stat-value" style="font-size: 13px;">$${a.initialBalance.toFixed(2)}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Growth</div>
            <div class="stat-value ${formatPnlClass(a.currentBalance - a.initialBalance)}" style="font-size: 13px;">
              ${formatUsd(a.currentBalance - a.initialBalance)}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="window._addBalance('${a.id}')">Add Funds</button>
          ${a.status === 'ACTIVE'
        ? `<button class="btn btn-danger btn-sm" style="flex: 1;" onclick="window._freezeAccount('${a.id}')">Freeze</button>`
        : `<button class="btn btn-primary btn-sm" style="flex: 1;" onclick="window._unfreezeAccount('${a.id}')">Unfreeze</button>`
      }
          <button class="btn btn-sm" style="background:rgba(255,60,60,0.1); color:var(--red); border:1px solid rgba(255,60,60,0.25);" onclick="window._deleteAccount('${a.id}')">🗑</button>
        </div>
      </div>
    `).join('');

  } catch (err) {
    container.innerHTML = cuteSadFace({ subtitle: err.message });
  }
}

window._generateApiKey = async () => {
  try {
    const result = await api('/auth/api-key', { method: 'POST' });
    showToast('API key generated!', 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._showCreateAccount = () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <span class="modal-title">Create Sub-Account</span>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      <div class="input-group">
        <label>Account Name</label>
        <input type="text" id="new-acct-name" placeholder="e.g. Trader 1 / v7-bot" />
      </div>
      <div class="input-group">
        <label>Type</label>
        <select id="new-acct-type" style="width:100%;padding:10px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:8px;">
          <option value="USER">User (Manual)</option>
          <option value="BOT">Bot (API)</option>
        </select>
      </div>
      <div class="input-group">
        <label>Initial Balance (USDT)</label>
        <input type="number" id="new-acct-balance" placeholder="0.00" value="0" step="0.01" inputmode="decimal" />
      </div>
      <button class="btn btn-primary btn-block" onclick="window._createAccount()">Create Account</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
};

window._createAccount = async () => {
  const name = document.getElementById('new-acct-name').value.trim();
  const type = document.getElementById('new-acct-type').value;
  const balance = parseFloat(document.getElementById('new-acct-balance').value) || 0;

  if (!name) return showToast('Enter a name', 'error');
  if (balance < 0) return showToast('Balance cannot be negative', 'error');

  try {
    await api('/sub-accounts', { method: 'POST', body: { name, type, initialBalance: balance } });
    showToast(`Account "${name}" created with $${balance}`, 'success');
    document.querySelector('.modal-overlay')?.remove();
    renderTabContent();
    state.accounts = await api('/sub-accounts');
    if (!state.currentAccount && state.accounts.length > 0) {
      const ownAccount = state.accounts.find(a => a.userId === state.user?.id);
      state.currentAccount = ownAccount?.id || state.accounts[0].id;
      localStorage.setItem('pms_currentAccount', state.currentAccount);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._addBalance = (id) => {
  const name = state.accounts?.find(a => a.id === id)?.name || 'Account';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <span class="modal-title">Add Funds — ${name}</span>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      <div class="input-group">
        <label>Amount (USDT)</label>
        <input type="number" id="add-balance-amount" placeholder="1.00" step="0.01" inputmode="decimal" />
      </div>
      <button class="btn btn-primary btn-block" onclick="window._doAddBalance('${id}')">Add Funds</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
};

window._doAddBalance = async (id) => {
  const amount = parseFloat(document.getElementById('add-balance-amount').value);
  if (!amount || amount <= 0) return showToast('Enter a valid amount', 'error');

  try {
    await api(`/sub-accounts/${id}`, { method: 'PATCH', body: { addBalance: amount } });
    showToast(`Added $${amount}`, 'success');
    document.querySelector('.modal-overlay')?.remove();
    renderTabContent();
    state.accounts = await api('/sub-accounts');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._inlineSetBalance = async (id) => {
  const input = document.getElementById(`inline-bal-${id}`);
  const balance = parseFloat(input?.value);
  if (isNaN(balance) || balance < 0) return showToast('Enter a valid balance', 'error');

  try {
    const result = await api(`/admin/set-balance/${id}`, { method: 'POST', body: { balance } });
    showToast(`Balance set: $${result.previousBalance.toFixed(2)} → $${result.newBalance.toFixed(2)}`, 'success');
    renderTabContent();
    state.accounts = await api('/sub-accounts');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._setBalance = (id, name, currentBal) => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <span class="modal-title">Set Balance — ${name}</span>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">Current: $${currentBal.toFixed(2)}</p>
      <div class="input-group">
        <label>New Balance (USDT)</label>
        <input type="number" id="set-balance-amount" placeholder="${currentBal.toFixed(2)}" value="${currentBal.toFixed(2)}" step="0.01" inputmode="decimal" />
      </div>
      <button class="btn btn-primary btn-block" onclick="window._doSetBalance('${id}')">Set Balance</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
};

window._doSetBalance = async (id) => {
  const balance = parseFloat(document.getElementById('set-balance-amount').value);
  if (isNaN(balance) || balance < 0) return showToast('Enter a valid balance', 'error');

  try {
    const result = await api(`/admin/set-balance/${id}`, { method: 'POST', body: { balance } });
    showToast(`Balance set: $${result.previousBalance.toFixed(2)} → $${result.newBalance.toFixed(2)}`, 'success');
    document.querySelector('.modal-overlay')?.remove();
    renderTabContent();
    state.accounts = await api('/sub-accounts');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._freezeAccount = async (id) => {
  try {
    await api(`/admin/freeze/${id}`, { method: 'POST' });
    showToast('Account frozen', 'warning');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._unfreezeAccount = async (id) => {
  try {
    await api(`/admin/unfreeze/${id}`, { method: 'POST' });
    showToast('Account unfrozen', 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._deleteAccount = async (id) => {
  const name = state.accounts?.find(a => a.id === id)?.name || 'this account';
  if (!(await cuteConfirm({
    title: '🗑 Delete Account?',
    message: `Permanently delete "${name}" and ALL its data:\n• Positions, trades, balance logs\n• Pending orders, risk rules, bot config\n\nThis cannot be undone.`,
    confirmText: 'Delete Forever',
    danger: true,
  }))) return;

  try {
    await api(`/admin/delete-account/${id}`, { method: 'DELETE' });
    showToast(`Account "${name}" deleted`, 'success');
    renderTabContent();
    state.accounts = await api('/sub-accounts');
    if (state.currentAccount === id) {
      state.currentAccount = state.accounts[0]?.id || null;
      localStorage.setItem('pms_currentAccount', state.currentAccount || '');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// === Users Tab (Admin Only) ===
async function renderUsersTab(container) {
  container.innerHTML = cuteSpinner();

  try {
    const users = await api('/auth/users');

    container.innerHTML = users.map(u => `
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div>
            <span style="font-weight: 700;">${u.username}</span>
            <span class="badge badge-${u.status.toLowerCase()}" style="margin-left: 6px;">${u.status}</span>
            <span class="badge" style="margin-left: 4px; font-size: 9px; background: ${u.role === 'ADMIN' ? 'rgba(255,165,0,0.2)' : 'rgba(255,255,255,0.05)'};">${u.role}</span>
          </div>
          <span style="font-size: 11px; color: var(--text-muted);">${new Date(u.createdAt).toLocaleDateString()}</span>
        </div>
        ${u.subAccounts && u.subAccounts.length > 0 ? `
          <div style="margin-bottom: 8px;">
            ${u.subAccounts.map(sa => `
              <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--border);">
                <span>${sa.name} <span style="color: var(--text-muted); font-size: 10px;">(${sa.type})</span></span>
                <span style="font-family: var(--font-mono);">$${sa.currentBalance.toFixed(2)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${u.apiKey ? `
          <div style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); margin-bottom: 8px; word-break: break-all; opacity: 0.6;">
            Key: ${u.apiKey.substring(0, 20)}…
          </div>
        ` : ''}
        <div style="display: flex; gap: 8px;">
          ${u.status === 'PENDING' ? `
            <button class="btn btn-primary btn-sm" style="flex:1;" onclick="window._approveUser('${u.id}')">Approve</button>
            <button class="btn btn-danger btn-sm" style="flex:1;" onclick="window._banUser('${u.id}')">Reject</button>
          ` : u.status === 'APPROVED' && u.role !== 'ADMIN' ? `
            <button class="btn btn-danger btn-sm" style="flex:1;" onclick="window._banUser('${u.id}')">Ban</button>
          ` : u.status === 'BANNED' ? `
            <button class="btn btn-primary btn-sm" style="flex:1;" onclick="window._approveUser('${u.id}')">Unban</button>
          ` : ''}
          ${u.subAccounts && u.subAccounts.length > 0 && u.role !== 'ADMIN' ? `
            <button class="btn btn-sm" style="flex:1; background:rgba(255,100,100,0.1); color:var(--red); border:1px solid rgba(255,100,100,0.25);" onclick="window._resetUser('${u.id}', '${u.username}')">🔄 Reset</button>
          ` : ''}
        </div>
      </div>
    `).join('');

    if (users.length === 0) {
      container.innerHTML = cutePeople({ title: 'No Users Yet ✨', subtitle: 'Users will appear here~' });
    }
  } catch (err) {
    container.innerHTML = cuteSadFace({ subtitle: err.message });
  }
}

window._approveUser = async (id) => {
  try {
    await api(`/auth/approve/${id}`, { method: 'POST' });
    showToast('User approved', 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._banUser = async (id) => {
  try {
    await api(`/auth/ban/${id}`, { method: 'POST' });
    showToast('User banned', 'warning');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._resetUser = async (userId, username) => {
  if (!(await cuteConfirm({
    title: '🔄 Reset User?',
    message: `This will fully reset "${username}":\n• Balance → $0\n• Close & delete all positions\n• Delete all trade history\n• Delete all balance logs\n• Delete all pending orders`,
    confirmText: 'Reset Everything',
    danger: true,
  }))) return;

  try {
    // Get user's sub-accounts
    const users = await api('/auth/users');
    const user = users.find(u => u.id === userId);
    if (!user || !user.subAccounts || user.subAccounts.length === 0) {
      return showToast('No sub-accounts found', 'warning');
    }

    for (const sa of user.subAccounts) {
      await api(`/admin/reset/${sa.id}`, { method: 'POST' });
    }

    showToast(`User "${username}" fully reset (${user.subAccounts.length} account(s))`, 'success');
    renderTabContent();
    state.accounts = await api('/sub-accounts');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// === Risk Rules Tab ===
async function renderRulesTab(container) {
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

    // Per-user account management
    if (allAccounts.length > 0) {
      html += `<div class="section-header" style="margin-top:16px;"><h2 class="section-title">User Accounts</h2></div>`;

      for (const acct of allAccounts) {
        const acctRule = rules.find(r => r.subAccountId === acct.id);
        const posCount = acct.positions?.length || 0;
        // Compute simple uPnL from positions if available
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
  } catch (err) {
    showToast(err.message, 'error');
  }
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
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._saveAcctRulesAndMode = async (acctId) => {
  try {
    // Save risk rules
    const data = {
      maxLeverage: parseFloat(document.getElementById(`acct-lev-${acctId}`).value),
      maxNotionalPerTrade: parseFloat(document.getElementById(`acct-not-${acctId}`).value),
      maxTotalExposure: parseFloat(document.getElementById(`acct-exp-${acctId}`).value),
      liquidationThreshold: parseFloat(document.getElementById(`acct-liq-${acctId}`).value),
    };
    await api(`/risk-rules/${acctId}`, { method: 'PUT', body: data });

    // Save liquidation mode
    const modeSelect = document.getElementById(`acct-liqmode-${acctId}`);
    if (modeSelect) {
      await api(`/admin/liquidation-mode/${acctId}`, { method: 'POST', body: { mode: modeSelect.value } });
    }

    showToast('Rules & liquidation mode saved', 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._adjustBalance = async (acctId) => {
  try {
    const amount = parseFloat(document.getElementById(`acct-bal-${acctId}`).value);
    if (!amount || amount === 0) return showToast('Enter an amount', 'warning');
    await api(`/sub-accounts/${acctId}`, { method: 'PATCH', body: { addBalance: amount } });
    showToast(`Balance ${amount > 0 ? '+' : ''}${amount} applied`, 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// === Overview Tab ===
async function renderOverviewTab(container) {
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

// === Liquidation Tab ===
async function renderLiquidationTab(container) {
  container.innerHTML = cuteSpinner();

  try {
    const [atRisk, allPositions] = await Promise.all([
      api('/admin/at-risk').catch(() => []),
      api('/admin/all-positions').catch(() => []),
    ]);

    let html = '';

    // At-risk accounts section
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

    // All open positions with takeover option
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

window._setLiqMode = async (subAccountId, mode) => {
  try {
    await api(`/admin/liquidation-mode/${subAccountId}`, { method: 'POST', body: { mode } });
    showToast(`Mode set to ${mode}`, 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._takeoverPosition = async (positionId) => {
  if (!(await cuteConfirm({ title: '🔄 Virtual Close (Takeover)?', message: "Position will be closed on the user's book and PnL settled — but it stays OPEN on the exchange. You absorb the position.", confirmText: 'Take Over', danger: true }))) return;
  try {
    await api(`/admin/takeover/${positionId}`, { method: 'POST' });
    showToast('Position taken over (virtual close)', 'warning');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window._forceClosePosition = async (positionId) => {
  if (!(await cuteConfirm({ title: '⚡ Market Close (Physical)?', message: 'This will send a real market order to the exchange to close this position.', confirmText: 'Market Close', danger: true }))) return;
  try {
    await api(`/admin/force-close/${positionId}`, { method: 'POST' });
    showToast('Position force closed on exchange', 'success');
    renderTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

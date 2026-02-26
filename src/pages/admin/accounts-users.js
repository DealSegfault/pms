// ── Admin – Accounts & Users Tab ──
// Sub-account CRUD, API key gen, user management + reset.

import { state, api, showToast, formatUsd, formatPnlClass } from '../../core/index.js';
import { cuteSpinner, cuteFolder, cutePeople, cuteSadFace } from '../../lib/cute-empty.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';

export async function renderAccountsTab(container, renderTabContent) {
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

export function bindAccountActions(renderTabContent) {
    window._generateApiKey = async () => {
        try {
            await api('/auth/api-key', { method: 'POST' });
            showToast('API key generated!', 'success');
            renderTabContent();
        } catch (err) { showToast(err.message, 'error'); }
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
        } catch (err) { showToast(err.message, 'error'); }
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
        } catch (err) { showToast(err.message, 'error'); }
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
        } catch (err) { showToast(err.message, 'error'); }
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
        } catch (err) { showToast(err.message, 'error'); }
    };

    window._freezeAccount = async (id) => {
        try { await api(`/admin/freeze/${id}`, { method: 'POST' }); showToast('Account frozen', 'warning'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };

    window._unfreezeAccount = async (id) => {
        try { await api(`/admin/unfreeze/${id}`, { method: 'POST' }); showToast('Account unfrozen', 'success'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };

    window._deleteAccount = async (id) => {
        const name = state.accounts?.find(a => a.id === id)?.name || 'this account';
        if (!(await cuteConfirm({ title: '🗑 Delete Account?', message: `Permanently delete "${name}" and ALL its data:\n• Positions, trades, balance logs\n• Pending orders, risk rules, bot config\n\nThis cannot be undone.`, confirmText: 'Delete Forever', danger: true }))) return;
        try {
            await api(`/admin/delete-account/${id}`, { method: 'DELETE' });
            showToast(`Account "${name}" deleted`, 'success');
            renderTabContent();
            state.accounts = await api('/sub-accounts');
            if (state.currentAccount === id) { state.currentAccount = state.accounts[0]?.id || null; localStorage.setItem('pms_currentAccount', state.currentAccount || ''); }
        } catch (err) { showToast(err.message, 'error'); }
    };
}

// ── Users Tab ──

export async function renderUsersTab(container, renderTabContent) {
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

export function bindUserActions(renderTabContent) {
    window._approveUser = async (id) => {
        try { await api(`/auth/approve/${id}`, { method: 'POST' }); showToast('User approved', 'success'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };

    window._banUser = async (id) => {
        try { await api(`/auth/ban/${id}`, { method: 'POST' }); showToast('User banned', 'warning'); renderTabContent(); }
        catch (err) { showToast(err.message, 'error'); }
    };

    window._resetUser = async (userId, username) => {
        if (!(await cuteConfirm({ title: '🔄 Reset User?', message: `This will fully reset "${username}":\n• Balance → $0\n• Close & delete all positions\n• Delete all trade history\n• Delete all balance logs\n• Delete all pending orders`, confirmText: 'Reset Everything', danger: true }))) return;
        try {
            const users = await api('/auth/users');
            const user = users.find(u => u.id === userId);
            if (!user || !user.subAccounts || user.subAccounts.length === 0) return showToast('No sub-accounts found', 'warning');
            for (const sa of user.subAccounts) { await api(`/admin/reset/${sa.id}`, { method: 'POST' }); }
            showToast(`User "${username}" fully reset (${user.subAccounts.length} account(s))`, 'success');
            renderTabContent();
            state.accounts = await api('/sub-accounts');
        } catch (err) { showToast(err.message, 'error'); }
    };
}

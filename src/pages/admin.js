// ── Admin Page (Shell) ──
// Tab skeleton + routing. All tab content delegated to sub-modules:
//   admin/accounts-users.js   — Accounts & Users tabs
//   admin/rules-liquidation.js — Rules, Overview & Liquidation tabs

import { state } from '../core/index.js';
import { renderAccountsTab, bindAccountActions, renderUsersTab, bindUserActions } from './admin/accounts-users.js';
import { renderRulesTab, bindRulesActions, renderOverviewTab, renderLiquidationTab, bindLiquidationActions } from './admin/rules-liquidation.js';

let currentTab = 'accounts';

export function renderAdminPage(container) {
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

  // Bind all window._ action handlers (only once per render)
  bindAccountActions(renderTabContent);
  bindUserActions(renderTabContent);
  bindRulesActions(renderTabContent);
  bindLiquidationActions(renderTabContent);

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
    case 'accounts': renderAccountsTab(content, renderTabContent); break;
    case 'rules': renderRulesTab(content, renderTabContent); break;
    case 'users': renderUsersTab(content, renderTabContent); break;
    case 'liquidation': renderLiquidationTab(content, renderTabContent); break;
    case 'overview': renderOverviewTab(content); break;
  }
}

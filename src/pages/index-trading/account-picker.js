// ── Account picker (shared modal for index page) ─
import { state, showToast } from '../../core/index.js';

export function showAccountPicker() {
    const existing = document.getElementById('idx-account-picker-overlay');
    if (existing) existing.remove();

    if (!state.accounts || state.accounts.length === 0) {
        showToast('No sub-accounts configured', 'error');
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'idx-account-picker-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.display = '';
    overlay.innerHTML = `
    <div class="modal-content" style="max-width:340px;">
      <div class="modal-header">
        <span class="modal-title">Select Account</span>
        <button class="modal-close" id="idx-acct-close">×</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${state.accounts.map(a => `
          <button class="idx-acct-option" data-acct-id="${a.id}" style="
            display:flex; justify-content:space-between; align-items:center; padding:10px 14px;
            background:${a.id === state.currentAccount ? 'rgba(99,102,241,0.1)' : 'var(--bg-input)'};
            border:1px solid ${a.id === state.currentAccount ? 'var(--accent)' : 'var(--border)'};
            border-radius:8px; color:var(--text-primary); cursor:pointer; font-size:13px;">
            <span>${a.name}</span>
            ${a.id === state.currentAccount ? '<span style="color:var(--accent); font-size:11px;">✓ Active</span>' : ''}
          </button>`).join('')}
      </div>
    </div>`;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('idx-acct-close')?.addEventListener('click', close);

    overlay.querySelectorAll('.idx-acct-option').forEach(btn => {
        btn.addEventListener('click', () => {
            state.currentAccount = btn.dataset.acctId;
            const display = document.getElementById('idx-account');
            if (display) display.textContent = state.accounts.find(a => a.id === state.currentAccount)?.name || 'Select';
            close();
            showToast(`Switched to ${btn.querySelector('span')?.textContent}`, 'success');
        });
    });
}

// ── Account Page – WebAuthn Biometric Login ──
import { api } from '../../core/index.js';

export async function initWebAuthnSection() {
    const listEl = document.getElementById('webauthn-credentials-list');
    const registerBtn = document.getElementById('webauthn-register-btn');
    const statusEl = document.getElementById('webauthn-status');
    if (!listEl || !registerBtn) return;

    const isSecureContext = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const hasWebAuthn = isSecureContext && typeof PublicKeyCredential !== 'undefined';

    if (!hasWebAuthn) {
        registerBtn.disabled = true;
        registerBtn.style.opacity = '0.4';
        if (!isSecureContext) {
            listEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:8px 0;">🔒 Biometric login requires HTTPS. Access via <code>https://</code> or <code>localhost</code> to register credentials.</div>';
        } else {
            listEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:8px 0;">Your browser does not support WebAuthn.</div>';
        }
        return;
    }

    await loadWebAuthnCredentials(listEl, statusEl);

    registerBtn.addEventListener('click', async () => {
        registerBtn.disabled = true;
        statusEl.textContent = '';

        try {
            const options = await api('/auth/webauthn/register/options', { method: 'POST' });

            if (typeof SimpleWebAuthnBrowser === 'undefined') {
                throw new Error('WebAuthn library not loaded. Please refresh the page.');
            }
            const attResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

            const result = await api('/auth/webauthn/register/verify', {
                method: 'POST',
                body: attResp,
            });

            statusEl.textContent = '✅ ' + result.message;
            statusEl.style.color = 'var(--green)';

            await loadWebAuthnCredentials(listEl, statusEl);
        } catch (err) {
            const msg = err.name === 'NotAllowedError' ? 'Registration cancelled' : err.message;
            statusEl.textContent = '❌ ' + msg;
            statusEl.style.color = 'var(--red)';
        }

        registerBtn.disabled = false;
    });
}

async function loadWebAuthnCredentials(listEl, statusEl) {
    try {
        const credentials = await api('/auth/webauthn/credentials');

        if (!credentials || credentials.length === 0) {
            listEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:8px 0;">No biometric credentials registered yet.</div>';
            return;
        }

        listEl.innerHTML = credentials.map(cred => {
            const deviceIcon = cred.deviceType === 'singleDevice' ? '📱' :
                cred.deviceType === 'multiDevice' ? '☁️' : '🔑';
            const date = new Date(cred.createdAt).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
            });
            const backedUp = cred.backedUp ? ' · Synced' : '';

            return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:var(--card-bg); border:1px solid var(--border); border-radius:8px; margin-bottom:6px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:18px;">${deviceIcon}</span>
            <div>
              <div style="font-size:12px; font-weight:600; color:var(--text-primary);">Passkey</div>
              <div style="font-size:10px; color:var(--text-muted);">${date}${backedUp}</div>
            </div>
          </div>
          <button class="btn webauthn-remove-btn" data-cred-id="${cred.id}" style="padding:4px 10px; font-size:10px; color:var(--red); border-color:var(--red);">Remove</button>
        </div>
      `;
        }).join('');

        listEl.querySelectorAll('.webauthn-remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const credId = btn.dataset.credId;
                const ok = confirm('Remove this biometric credential? You won\'t be able to use it for login anymore.');
                if (!ok) return;

                btn.disabled = true;
                try {
                    await api(`/auth/webauthn/credentials/${credId}`, { method: 'DELETE' });
                    statusEl.textContent = '✅ Credential removed';
                    statusEl.style.color = 'var(--green)';
                    await loadWebAuthnCredentials(listEl, statusEl);
                } catch (err) {
                    statusEl.textContent = '❌ ' + err.message;
                    statusEl.style.color = 'var(--red)';
                }
            });
        });
    } catch (err) {
        listEl.innerHTML = `<div style="font-size:11px; color:var(--red);">Failed to load credentials: ${err.message}</div>`;
    }
}

// ── Account Page – API Key Management ──
import { api } from '../../core/index.js';

let _currentApiKey = null;

export function maskApiKey(key) {
    if (!key) return '';
    if (key.length <= 12) return key;
    return key.slice(0, 8) + '••••••••' + key.slice(-4);
}

export async function initApiKeySection() {
    const input = document.getElementById('api-key-value');
    const copyBtn = document.getElementById('api-key-copy-btn');
    const genBtn = document.getElementById('api-key-generate-btn');
    const regenBtn = document.getElementById('api-key-regenerate-btn');
    const statusEl = document.getElementById('api-key-status');
    if (!input) return;

    try {
        const me = await api('/auth/me');
        if (me.apiKey) {
            _currentApiKey = me.apiKey;
            input.value = maskApiKey(me.apiKey);
            copyBtn.disabled = false;
            genBtn.style.display = 'none';
            regenBtn.style.display = '';
        } else {
            input.value = 'No API key yet';
            copyBtn.disabled = true;
            genBtn.style.display = '';
            regenBtn.style.display = 'none';
        }
    } catch {
        input.value = 'Failed to load';
    }

    copyBtn.addEventListener('click', async () => {
        if (!_currentApiKey) return;
        try {
            await navigator.clipboard.writeText(_currentApiKey);
            statusEl.textContent = '✅ Copied to clipboard';
            statusEl.style.color = 'var(--green)';
            setTimeout(() => { statusEl.textContent = ''; }, 2500);
        } catch {
            input.value = _currentApiKey;
            input.select();
            document.execCommand('copy');
            input.value = maskApiKey(_currentApiKey);
            statusEl.textContent = '✅ Copied';
            statusEl.style.color = 'var(--green)';
            setTimeout(() => { statusEl.textContent = ''; }, 2500);
        }
    });

    genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        try {
            const res = await api('/auth/api-key', { method: 'POST' });
            _currentApiKey = res.apiKey;
            input.value = res.apiKey;
            copyBtn.disabled = false;
            genBtn.style.display = 'none';
            regenBtn.style.display = '';
            statusEl.textContent = '🔑 Key generated — copy it now! It will be masked on reload.';
            statusEl.style.color = 'var(--green)';
            setTimeout(() => { input.value = maskApiKey(_currentApiKey); }, 15000);
        } catch (err) {
            statusEl.textContent = `❌ ${err.message}`;
            statusEl.style.color = 'var(--red)';
        }
        genBtn.disabled = false;
    });

    regenBtn.addEventListener('click', async () => {
        const ok = confirm('Regenerate API key? The old key will stop working immediately.');
        if (!ok) return;
        regenBtn.disabled = true;
        try {
            const res = await api('/auth/api-key', { method: 'POST' });
            _currentApiKey = res.apiKey;
            input.value = res.apiKey;
            statusEl.textContent = '🔄 New key generated — copy it now!';
            statusEl.style.color = 'var(--green)';
            setTimeout(() => { input.value = maskApiKey(_currentApiKey); }, 15000);
        } catch (err) {
            statusEl.textContent = `❌ ${err.message}`;
            statusEl.style.color = 'var(--red)';
        }
        regenBtn.disabled = false;
    });
}

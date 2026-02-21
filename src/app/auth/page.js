import { getToken, setToken, clearToken, showToast } from '../../core/index.js';
import { setUser } from '../../store/app-store.js';
import { buildAuthPageHTML } from '../../components/auth/template.js';

let reconnectInterval = null;

function clearReconnectInterval() {
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
    }
}

function renderLoginForm(onAuthenticated) {
    document.getElementById('auth-form').innerHTML = `
        <div class="input-group">
            <label>Username</label>
            <input type="text" id="login-user" placeholder="Username" autocomplete="username" />
        </div>
        <div class="input-group">
            <label>Password</label>
            <input type="password" id="login-pass" placeholder="Password" autocomplete="current-password" />
        </div>
        <button class="btn btn-primary btn-block" onclick="window._doLogin()">Login</button>
        <div id="auth-error" style="color: var(--red); font-size: 12px; text-align: center; margin-top: 10px;"></div>
        <div id="biometric-divider" style="position:relative; text-align:center; margin:16px 0 12px; display:none;">
            <div style="position:absolute; top:50%; left:0; right:0; height:1px; background:var(--border);"></div>
            <span style="position:relative; background:var(--card-bg); padding:0 12px; font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">or</span>
        </div>
        <button class="btn btn-block biometric-login-btn" id="biometric-login-btn" style="display:none; align-items:center; justify-content:center; gap:8px; padding:10px; font-size:13px; background:rgba(99,102,241,0.1); border:1px solid rgba(99,102,241,0.3); color:#a78bfa;">
            <span style="font-size:20px;">🔐</span> Login with Biometric
        </button>
        <div id="biometric-unavailable" style="display:none; font-size:10px; color:var(--text-muted); text-align:center; margin-top:12px;"></div>
    `;

    window._doLogin = async () => {
        const username = document.getElementById('login-user').value.trim();
        const password = document.getElementById('login-pass').value;
        const errEl = document.getElementById('auth-error');

        if (!username || !password) {
            errEl.textContent = 'Enter username and password';
            return;
        }

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();

            if (!res.ok) {
                if (data.status === 'PENDING') errEl.innerHTML = '⏳ Your account is pending admin approval.';
                else errEl.textContent = data.error || 'Login failed';
                return;
            }

            setToken(data.token);
            setUser(data.user);
            await onAuthenticated();
        } catch (err) {
            errEl.textContent = err.message;
        }
    };

    document.getElementById('login-pass')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') window._doLogin();
    });

    // Biometric login — check support and show/hide button
    const bioBtn = document.getElementById('biometric-login-btn');
    const bioDivider = document.getElementById('biometric-divider');
    const bioUnavailable = document.getElementById('biometric-unavailable');

    const isSecureContext = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const hasWebAuthn = isSecureContext && typeof PublicKeyCredential !== 'undefined';

    if (hasWebAuthn && bioBtn) {
        // WebAuthn is available — show the button
        bioBtn.style.display = 'flex';
        bioDivider.style.display = '';

        bioBtn.addEventListener('click', async () => {
            const errEl = document.getElementById('auth-error');
            const usernameInput = document.getElementById('login-user');
            const username = usernameInput?.value?.trim();

            if (!username) {
                errEl.textContent = 'Enter your username first, then click biometric login';
                usernameInput?.focus();
                return;
            }

            bioBtn.disabled = true;
            errEl.textContent = '';

            try {
                // Step 1: Get authentication options
                const optRes = await fetch('/api/auth/webauthn/login/options', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username }),
                });
                const optData = await optRes.json();
                if (!optRes.ok) {
                    errEl.textContent = optData.error || 'No biometric credentials found';
                    bioBtn.disabled = false;
                    return;
                }

                // Step 2: Trigger browser biometric prompt
                if (typeof SimpleWebAuthnBrowser === 'undefined') {
                    errEl.textContent = 'WebAuthn library not loaded. Please refresh.';
                    bioBtn.disabled = false;
                    return;
                }
                const assertionResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: optData });

                // Step 3: Verify with server
                const verifyRes = await fetch('/api/auth/webauthn/login/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, ...assertionResp }),
                });
                const verifyData = await verifyRes.json();

                if (!verifyRes.ok) {
                    errEl.textContent = verifyData.error || 'Biometric login failed';
                    bioBtn.disabled = false;
                    return;
                }

                setToken(verifyData.token);
                setUser(verifyData.user);
                await onAuthenticated();
            } catch (err) {
                const msg = err.name === 'NotAllowedError' ? 'Authentication cancelled' : err.message;
                errEl.textContent = msg;
                bioBtn.disabled = false;
            }
        });
    } else if (bioUnavailable) {
        // WebAuthn not available — show helpful message
        if (!isSecureContext) {
            bioUnavailable.style.display = '';
            bioUnavailable.innerHTML = '🔒 Biometric login requires HTTPS. <span style="color:var(--text-secondary);">Access via <code>https://</code> or <code>localhost</code> to enable.</span>';
        }
        // If secure but no PublicKeyCredential, browser genuinely doesn't support it — stay hidden
    }
}

function renderRegisterForm(onAuthenticated) {
    document.getElementById('auth-form').innerHTML = `
        <div class="input-group">
            <label>Username</label>
            <input type="text" id="reg-user" placeholder="Choose a username" autocomplete="username" />
        </div>
        <div class="input-group">
            <label>Password</label>
            <input type="password" id="reg-pass" placeholder="Choose a password" autocomplete="new-password" />
        </div>
        <button class="btn btn-primary btn-block" onclick="window._doRegister()">Register</button>
        <div id="auth-error" style="color: var(--red); font-size: 12px; text-align: center; margin-top: 10px;"></div>
    `;

    window._doRegister = async () => {
        const username = document.getElementById('reg-user').value.trim();
        const password = document.getElementById('reg-pass').value;
        const errEl = document.getElementById('auth-error');

        if (!username || !password) {
            errEl.textContent = 'Enter username and password';
            return;
        }

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();

            if (!res.ok) {
                errEl.textContent = data.error || 'Registration failed';
                return;
            }

            if (data.status === 'APPROVED') {
                errEl.innerHTML = '';
                showToast('Account created! Logging in...', 'success');
                window._authTab('login');
                return;
            }

            errEl.innerHTML = `<span style="color: var(--green);">✓ Registered! Awaiting admin approval.</span>`;
        } catch (err) {
            errEl.textContent = err.message;
        }
    };
}

function hideAppShell() {
    const nav = document.querySelector('.bottom-nav');
    const header = document.querySelector('.header');
    if (nav) nav.style.display = 'none';
    if (header) header.style.display = 'none';
}

function startReconnectPolling(onAuthenticated) {
    reconnectInterval = setInterval(async () => {
        const token = getToken();
        if (!token) {
            clearReconnectInterval();
            return;
        }

        try {
            const res = await fetch('/api/auth/me', {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (res.ok) {
                clearReconnectInterval();
                setUser(await res.json());
                await onAuthenticated();
                return;
            }

            if (res.status === 401) {
                clearReconnectInterval();
                clearToken();
                renderAuthPage({ reconnecting: false, onAuthenticated });
            }
        } catch {
            // Still unreachable — keep polling.
        }
    }, 3000);
}

export function clearAuthReconnectInterval() {
    clearReconnectInterval();
}

export function renderAuthPage({ reconnecting = false, onAuthenticated = async () => { } } = {}) {
    clearReconnectInterval();
    hideAppShell();

    const page = document.getElementById('page-content');
    page.innerHTML = buildAuthPageHTML(reconnecting);

    window._authTab = (tab) => {
        document.querySelectorAll('.tab-bar button').forEach((btn, index) => {
            btn.classList.toggle('active', index === (tab === 'login' ? 0 : 1));
        });
        if (tab === 'login') renderLoginForm(onAuthenticated);
        else renderRegisterForm(onAuthenticated);
    };

    renderLoginForm(onAuthenticated);

    if (reconnecting) startReconnectPolling(onAuthenticated);
}

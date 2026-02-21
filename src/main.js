import { renderTradingPage, cleanup as cleanupTrading } from './pages/trading.js';
import { renderPositionsPage, cleanup as cleanupPositions } from './pages/positions.js';
import { renderHistoryPage } from './pages/history.js';
import { renderAdminPage } from './pages/admin.js';
import { renderAccountPage } from './pages/account.js';
import { renderIndexPage, cleanup as cleanupIndex } from './pages/index-trading.js';
import {
    state,
    api,
    setUnauthorizedHandler,
    showToast,
    formatPrice,
    getToken,
    clearToken,
} from './core/index.js';
import { setUser, setAccounts, setCurrentAccount, resetSessionState } from './store/app-store.js';
import { initTheme } from './css/theme-manager.js';
import { cuteConfirm } from './lib/cute-confirm.js';
import { setupGirlyAnimationWatcher } from './lib/girly-animations.js';
import { renderAuthPage, clearAuthReconnectInterval } from './app/auth/page.js';
import { createWsClient } from './app/realtime/ws-client.js';

let routerBound = false;

function closeEventKey(subAccountId, symbol) {
    return `${subAccountId || ''}:${String(symbol || '').toUpperCase()}`;
}

function trackCloseEvent(subAccountId, symbol) {
    if (!symbol) return;
    state.recentPositionCloseTs[closeEventKey(subAccountId, symbol)] = Date.now();
}

function wasRecentCloseEvent(subAccountId, symbol, withinMs = 5000) {
    if (!symbol) return false;
    const ts = state.recentPositionCloseTs[closeEventKey(subAccountId, symbol)];
    return !!(ts && (Date.now() - ts) < withinMs);
}

function handleBotStatusCloseTransitions(botStatus) {
    if (!botStatus || !Array.isArray(botStatus.engines)) return;
    const subAccountId = botStatus.subAccountId || state.currentAccount || '';
    if (!subAccountId) return;

    const prevBySymbol = state.botSymbolState[subAccountId] || {};
    const nextBySymbol = {};

    for (const engine of botStatus.engines) {
        const symbol = String(engine?.symbol || '').toUpperCase();
        if (!symbol) continue;

        const depth = Number(engine?.gridDepth || 0);
        const realizedUsd = Number(engine?.realizedUsd || 0);
        nextBySymbol[symbol] = { depth, realizedUsd };

        const prev = prevBySymbol[symbol];
        if (!prev) continue;
        if (prev.depth <= 0 || depth > 0) continue;
        if (wasRecentCloseEvent(subAccountId, symbol)) continue;

        const pnlDelta = Number.isFinite(realizedUsd) && Number.isFinite(prev.realizedUsd)
            ? realizedUsd - prev.realizedUsd
            : null;
        const base = symbol.split('/')[0] || symbol;
        const pnlText = pnlDelta == null ? '' : ` PnL: $${pnlDelta.toFixed(2)}`;

        showToast(
            `📊 Babysitter closed: ${base}${pnlText}`,
            pnlDelta == null ? 'warning' : (pnlDelta >= 0 ? 'success' : 'warning'),
        );

        const detail = {
            subAccountId,
            symbol,
            realizedPnl: pnlDelta,
            reason: 'BABYSITTER',
        };

        trackCloseEvent(subAccountId, symbol);
        window.dispatchEvent(new CustomEvent('position_closed', { detail }));
    }

    state.botSymbolState[subAccountId] = nextBySymbol;
}

const wsClient = createWsClient({
    state,
    getToken,
    showToast,
    formatPrice,
    onBotStatus: handleBotStatusCloseTransitions,
    onPositionClosed: (detail) => trackCloseEvent(detail.subAccountId || state.currentAccount, detail.symbol),
});

function cleanupActivePages() {
    cleanupTrading();
    cleanupPositions();
    cleanupIndex();
}

function showAuthPage(reconnecting = false) {
    renderAuthPage({ reconnecting, onAuthenticated: initApp });
}

function teardownApp() {
    clearAuthReconnectInterval();
    cleanupActivePages();

    if (routerBound) {
        window.removeEventListener('hashchange', navigate);
        routerBound = false;
    }

    wsClient.setReconnectEnabled(false);
    wsClient.disconnect();
}

function logout() {
    teardownApp();
    clearToken();
    resetSessionState();
    localStorage.removeItem('pms_currentAccount');
    showAuthPage(false);
}

setUnauthorizedHandler(logout);
window.__pmsState = state;

const routes = {
    '/trade': renderTradingPage,
    '/positions': renderPositionsPage,
    '/index': renderIndexPage,
    '/history': renderHistoryPage,
    '/admin': renderAdminPage,
    '/account': renderAccountPage,
};

function navigate() {
    const hash = location.hash.slice(1) || '/trade';
    const page = document.getElementById('page-content');

    if (hash === '/admin' && state.user?.role !== 'ADMIN') {
        location.hash = '#/account';
        return;
    }

    const renderFn = routes[hash] || routes['/trade'];

    document.querySelectorAll('.nav-item').forEach((item) => {
        item.classList.toggle('active', item.getAttribute('href') === `#${hash}`);
    });

    cleanupActivePages();
    page.innerHTML = '';
    renderFn(page);
}

function applyAdminNavRole() {
    const adminNav = document.querySelector('.nav-item[href="#/admin"]');
    if (!adminNav) return;

    if (state.user?.role !== 'ADMIN') {
        adminNav.href = '#/account';
        adminNav.dataset.page = 'account';
        adminNav.querySelector('span').textContent = 'Account';
        return;
    }

    adminNav.href = '#/admin';
    adminNav.dataset.page = 'admin';
    adminNav.querySelector('span').textContent = 'Admin';
}

function bindHeaderUser() {
    const userInfo = document.getElementById('user-info');
    if (!userInfo || !state.user) return;

    userInfo.textContent = state.user.username;
    userInfo.style.cursor = 'pointer';
    userInfo.onclick = () => {
        cuteConfirm({
            title: 'Log Out?',
            message: 'See you next time~ 💕',
            confirmText: 'Log Out',
        }).then((ok) => {
            if (ok) logout();
        });
    };
}

async function loadAccounts() {
    try {
        let accounts = await api('/sub-accounts');
        accounts = Array.isArray(accounts) ? accounts : [];

        if (accounts.length === 0 && state.user?.role !== 'ADMIN') {
            const created = await api('/sub-accounts', {
                method: 'POST',
                body: { name: `${state.user.username}'s Account`, initialBalance: 500 },
            });
            accounts = created ? [created] : [];
            showToast('Account created with $500 balance', 'success');
        }

        setAccounts(accounts);

        if (accounts.length === 0) {
            setCurrentAccount(null);
            localStorage.removeItem('pms_currentAccount');
            return;
        }

        const saved = localStorage.getItem('pms_currentAccount');
        const savedExists = saved && accounts.some((account) => account.id === saved);
        const ownAccount = accounts.find((account) => account.userId === state.user?.id);
        const nextAccount = savedExists ? saved : (ownAccount?.id || accounts[0].id);

        setCurrentAccount(nextAccount);
        localStorage.setItem('pms_currentAccount', nextAccount);
    } catch (err) {
        console.warn('Could not load accounts:', err.message);
        setAccounts([]);
        setCurrentAccount(null);
    }
}

async function initApp() {
    teardownApp();

    const nav = document.querySelector('.bottom-nav');
    const header = document.querySelector('.header');
    if (nav) nav.style.display = '';
    if (header) header.style.display = '';

    applyAdminNavRole();
    bindHeaderUser();
    await loadAccounts();

    wsClient.setReconnectEnabled(true);
    wsClient.connect();

    if (!routerBound) {
        window.addEventListener('hashchange', navigate);
        routerBound = true;
    }

    navigate();
}

async function init() {
    initTheme();
    setupGirlyAnimationWatcher();

    const token = getToken();
    if (token) {
        try {
            const response = await fetch('/api/auth/me', {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (response.ok) {
                setUser(await response.json());
                await initApp();
                return;
            }

            clearToken();
            resetSessionState();
        } catch {
            teardownApp();
            showAuthPage(true);
            return;
        }
    }

    teardownApp();
    showAuthPage(false);
}

init();

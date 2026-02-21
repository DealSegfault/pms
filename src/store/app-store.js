import { state } from '../core/state.js';

const listeners = new Set();

function emit(type, payload) {
    listeners.forEach((listener) => {
        try {
            listener({ type, payload, state });
        } catch {
            // Listener errors must not break app flow.
        }
    });
}

export function subscribeAppStore(listener) {
    if (typeof listener !== 'function') return () => { };
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setUser(user) {
    state.user = user;
    emit('user', user);
}

export function setAccounts(accounts) {
    state.accounts = Array.isArray(accounts) ? accounts : [];
    emit('accounts', state.accounts);
}

export function setCurrentAccount(accountId) {
    state.currentAccount = accountId || null;
    emit('currentAccount', state.currentAccount);
}

export function resetSessionState() {
    state.currentAccount = null;
    state.accounts = [];
    state.botSymbolState = {};
    state.recentPositionCloseTs = {};
    emit('session-reset', null);
}

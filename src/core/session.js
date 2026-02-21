import { state } from './state.js';

const TOKEN_STORAGE_KEY = 'pms_token';

export function getToken() {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken() {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    state.user = null;
}

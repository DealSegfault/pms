import { getToken } from './session.js';
import { showMaintenanceOverlay, isMaintenanceVisible } from '../lib/server-health.js';

let unauthorizedHandler = () => { };

export function setUnauthorizedHandler(handler) {
    unauthorizedHandler = typeof handler === 'function' ? handler : () => { };
}

async function readResponsePayload(response) {
    if (response.status === 204) return null;

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        try {
            return await response.json();
        } catch {
            return null;
        }
    }

    try {
        const text = await response.text();
        return text ? { error: text } : null;
    } catch {
        return null;
    }
}

/**
 * Wait for the maintenance overlay to recover, then resolve.
 */
function waitForRecovery() {
    return new Promise((resolve) => {
        if (!isMaintenanceVisible()) {
            showMaintenanceOverlay({ onRecovered: resolve });
        }
        // If already visible, the existing overlay will handle recovery
        // but we still need to resolve when it does — piggyback on next health poll
        else {
            const check = setInterval(() => {
                if (!isMaintenanceVisible()) {
                    clearInterval(check);
                    resolve();
                }
            }, 500);
        }
    });
}

export async function api(path, options = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const body = options.body === undefined
        ? undefined
        : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));

    let response;
    try {
        response = await fetch(`/api${path}`, {
            ...options,
            headers,
            body,
            cache: 'no-store',
        });
    } catch (err) {
        // Network error — server is unreachable
        if (err instanceof TypeError || err.name === 'TypeError') {
            await waitForRecovery();
            // Retry the original request after recovery
            return api(path, options);
        }
        throw err;
    }

    if (response.status === 401) {
        unauthorizedHandler();
        throw new Error('Session expired');
    }

    const payload = await readResponsePayload(response);

    if (!response.ok) {
        const message = payload?.message
            || payload?.error?.message
            || payload?.error
            || payload?.reasons?.join(', ')
            || 'Request failed';
        const error = new Error(message);
        if (payload?.errors) error.errors = payload.errors;
        if (payload && typeof payload === 'object') {
            error.payload = payload;
            error.errorCode = payload.errorCode || payload.error?.code;
            error.errorCategory = payload.errorCategory || payload.error?.category;
            error.details = payload.details || payload.error?.details;
        }
        throw error;
    }

    return payload;
}

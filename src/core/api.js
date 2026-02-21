import { getToken } from './session.js';

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

    const response = await fetch(`/api${path}`, {
        ...options,
        headers,
        body,
        cache: 'no-store',
    });

    if (response.status === 401) {
        unauthorizedHandler();
        throw new Error('Session expired');
    }

    const payload = await readResponsePayload(response);

    if (!response.ok) {
        const message = payload?.error || payload?.reasons?.join(', ') || 'Request failed';
        const error = new Error(message);
        if (payload?.errors) error.errors = payload.errors;
        throw error;
    }

    return payload;
}

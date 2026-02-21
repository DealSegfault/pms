/**
 * Sanitise SubAccount objects before sending to the frontend.
 *
 * Works on a single object, an array, or nested objects that
 * contain a `subAccount` property.
 */

/**
 * Sanitise one item, an array of items, or an object whose nested
 * `subAccount` key should also be cleaned.
 */
export function sanitize(data) {
    if (data === null || data === undefined) return data;

    // Array of SubAccounts (or objects that *may* embed one)
    if (Array.isArray(data)) {
        return data.map(item => sanitize(item));
    }

    if (typeof data !== 'object') return data;

    // If it has a nested `subAccount` property (e.g. position objects)
    if (data.subAccount && typeof data.subAccount === 'object') {
        return { ...data, subAccount: sanitize(data.subAccount) };
    }

    // If it has a nested `accounts` array (admin dashboard)
    if (Array.isArray(data.accounts)) {
        return { ...data, accounts: data.accounts.map(a => sanitize(a)) };
    }

    return data;
}

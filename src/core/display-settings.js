/**
 * Display Settings — persisted in localStorage.
 *
 * Keys:
 *   pms:showChart        – '1' (default) or '0'
 *   pms:showOrderbook    – '1' (default) or '0'
 *   pms:notifications    – '1' (default) or '0'
 */

const KEY_CHART = 'pms:showChart';
const KEY_OB = 'pms:showOrderbook';
const KEY_NOTIF = 'pms:notifications';

function _get(key) {
    const v = localStorage.getItem(key);
    return v === '0' ? false : true;   // default: enabled
}

function _set(key, bool) {
    localStorage.setItem(key, bool ? '1' : '0');
}

export function getShowChart() { return _get(KEY_CHART); }
export function setShowChart(v) { _set(KEY_CHART, v); }

export function getShowOrderbook() { return _get(KEY_OB); }
export function setShowOrderbook(v) { _set(KEY_OB, v); }

export function getNotifications() { return _get(KEY_NOTIF); }
export function setNotifications(v) { _set(KEY_NOTIF, v); }

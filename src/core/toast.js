const MAX_VISIBLE_TOASTS = 4;
const MAX_QUEUED_TOASTS = 50;
const DEDUPE_WINDOW_MS = 1200;
const QUEUE_PUMP_INTERVAL_MS = 120;

const queue = [];
const activeToasts = [];
const recentToastTs = new Map();

let pumpTimer = null;

function _durationFor(type) {
    if (type === 'error') return 4000;
    if (type === 'warning') return 2800;
    return 2000;
}

function _reflow() {
    activeToasts.forEach((toast, index) => {
        toast.style.top = `calc(var(--header-height) + var(--safe-top) + 8px + ${index * 36}px)`;
    });
}

function _removeToast(toast) {
    const idx = activeToasts.indexOf(toast);
    if (idx >= 0) activeToasts.splice(idx, 1);
    try { toast.remove(); } catch { }
    _reflow();
    _pump();
}

function _spawnToast(item) {
    const toast = document.createElement('div');
    toast.className = `toast ${item.type}`;
    toast.textContent = item.message;

    activeToasts.push(toast);
    document.body.appendChild(toast);
    _reflow();

    setTimeout(() => _removeToast(toast), _durationFor(item.type));
}

function _pruneRecent(now) {
    for (const [key, ts] of recentToastTs.entries()) {
        if ((now - ts) > (DEDUPE_WINDOW_MS * 5)) {
            recentToastTs.delete(key);
        }
    }
}

function _pump() {
    if (queue.length === 0 || activeToasts.length >= MAX_VISIBLE_TOASTS) {
        if (pumpTimer != null) {
            clearTimeout(pumpTimer);
            pumpTimer = null;
        }
        return;
    }

    const next = queue.shift();
    _spawnToast(next);

    if (queue.length > 0) {
        if (pumpTimer != null) clearTimeout(pumpTimer);
        pumpTimer = setTimeout(_pump, QUEUE_PUMP_INTERVAL_MS);
    }
}

export function showToast(message, type = 'success') {
    if (!message) return;

    const now = Date.now();
    const key = `${type}:${message}`;
    const lastTs = recentToastTs.get(key) || 0;
    if ((now - lastTs) < DEDUPE_WINDOW_MS) return;

    recentToastTs.set(key, now);
    _pruneRecent(now);

    if (queue.length >= MAX_QUEUED_TOASTS) {
        queue.shift();
    }

    queue.push({ message, type });
    _pump();
}

export function formatUsd(n, decimals = 2) {
    if (n == null || Number.isNaN(n)) return '$0.00';
    const sign = n < 0 ? '-' : n > 0 ? '+' : '';
    return `${sign}$${Math.abs(n).toFixed(decimals)}`;
}

export function formatPrice(n) {
    if (n == null || Number.isNaN(n)) return '—';
    if (n >= 1000) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
}

export function formatPnlClass(n) {
    if (n > 0) return 'pnl-positive';
    if (n < 0) return 'pnl-negative';
    return 'pnl-neutral';
}

/**
 * Theme Manager — apply, save, and load themes.
 */

const STORAGE_KEY = 'pms_theme';

export const THEMES = [
    { id: 'default', label: 'Default', emoji: '🌙', color: '#6366f1', bg: ['#0a0e17', '#1a2035'], green: '#22c55e', red: '#ef4444' },
    { id: 'girly', label: 'Girly', emoji: '🩷', color: '#ec4899', bg: ['#1a0f1e', '#2d1a33'], green: '#34d399', red: '#fb7185' },
    { id: 'citadel', label: 'Citadel', emoji: '⚡', color: '#00d4ff', bg: ['#06090f', '#0e1420'], green: '#00e676', red: '#ff1744' },
];

export function getTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'default';
}

export function applyTheme(name) {
    const theme = THEMES.find(t => t.id === name) || THEMES[0];
    document.documentElement.setAttribute('data-theme', theme.id);
    localStorage.setItem(STORAGE_KEY, theme.id);

    // Update meta theme-color for mobile browsers
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
        if (themeColor) meta.setAttribute('content', themeColor);
    }
}

export function initTheme() {
    applyTheme(getTheme());
}

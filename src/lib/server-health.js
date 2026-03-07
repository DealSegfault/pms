/**
 * Server Health Monitor
 * Shows a premium animated maintenance overlay when the server is unreachable,
 * polls /api/health, and auto-recovers when the server comes back.
 */

let overlayEl = null;
let pollTimer = null;
let attemptCount = 0;
let onRecoveredCb = null;

const POLL_INTERVAL = 3000;

const TIPS = [
    '🔧 Deploying latest updates…',
    '🦆 The duck is fixing things…',
    '⚡ Optimizing trading engines…',
    '🚀 Restarting services…',
    '📊 Syncing market data…',
    '🛡️ Running health checks…',
    '✨ Almost there…',
    '🔄 Applying new features…',
];

function buildParticles(count = 20) {
    return Array.from({ length: count }, (_, i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 12;
        const duration = 6 + Math.random() * 10;
        const driftX = -40 + Math.random() * 80;
        const size = 2 + Math.random() * 3;
        const hue = Math.random() > 0.7 ? '168, 85, 247' : '251, 191, 36';
        return `<div class="maint-particle" style="
            left:${left}%;
            bottom:-10px;
            width:${size}px;
            height:${size}px;
            background:rgb(${hue});
            animation-delay:${delay}s;
            animation-duration:${duration}s;
            --drift-x:${driftX}px;
        "></div>`;
    }).join('');
}

function buildTips() {
    const duration = TIPS.length * 4; // 4s per tip
    return TIPS.map((tip, i) => {
        const delay = i * 4;
        return `<div class="maint-tip" style="--tip-duration:${duration}s;--tip-delay:${delay}s;">${tip}</div>`;
    }).join('');
}

function buildDuckSVG() {
    return `
    <svg viewBox="0 0 120 120" width="100" height="100" class="maint-duck">
        <circle cx="60" cy="60" r="55" fill="none" stroke="rgba(251,191,36,0.1)" stroke-width="1" stroke-dasharray="4 4"/>
        <ellipse cx="60" cy="78" rx="28" ry="20" fill="#fbbf24"/>
        <ellipse cx="60" cy="78" rx="24" ry="16" fill="#fcd34d"/>
        <path d="M85 72 Q95 65 92 75 Q90 80 85 78Z" fill="#f59e0b"/>
        <circle cx="60" cy="45" r="20" fill="#fbbf24"/>
        <circle cx="60" cy="45" r="17" fill="#fcd34d"/>
        <circle cx="52" cy="42" r="3.5" fill="#1e293b"/>
        <circle cx="68" cy="42" r="3.5" fill="#1e293b"/>
        <circle cx="53.2" cy="40.8" r="1.2" fill="white"/>
        <circle cx="69.2" cy="40.8" r="1.2" fill="white"/>
        <ellipse cx="60" cy="52" rx="8" ry="4.5" fill="#f97316"/>
        <line x1="52" y1="52" x2="68" y2="52" stroke="#ea580c" stroke-width="0.8"/>
        <circle cx="45" cy="48" r="4" fill="#f9731644"/>
        <circle cx="75" cy="48" r="4" fill="#f9731644"/>
        <polygon points="30,30 60,18 90,30 60,42" fill="#1e293b"/>
        <rect x="56" y="17" width="8" height="5" rx="1" fill="#1e293b"/>
        <line x1="84" y1="30" x2="88" y2="42" stroke="#fbbf24" stroke-width="1.5"/>
        <circle cx="88" cy="44" r="3" fill="#fbbf24"/>
        <ellipse cx="38" cy="75" rx="10" ry="14" fill="#f59e0b" transform="rotate(-15 38 75)"/>
        <!-- Wrench in wing -->
        <rect x="30" y="68" width="12" height="5" rx="2.5" fill="#fef3c7" transform="rotate(-25 36 70)"/>
        <rect x="29" y="67" width="3" height="7" rx="1.5" fill="#fde68a" transform="rotate(-25 30 70)"/>
        <rect x="40" y="70" width="3" height="7" rx="1.5" fill="#fde68a" transform="rotate(-25 41 73)"/>
    </svg>`;
}

function buildOverlayHTML() {
    return `
        <div class="maintenance-bg"></div>
        ${buildParticles(22)}

        <div class="maint-content">
            <div class="maint-mascot-wrap">
                <div class="maint-pulse-ring"></div>
                <div class="maint-pulse-ring"></div>
                <div class="maint-pulse-ring"></div>
                <div class="maint-orbit"><div class="maint-orbit-dot"></div></div>
                <div class="maint-orbit"><div class="maint-orbit-dot"></div></div>
                ${buildDuckSVG()}
            </div>

            <div class="maint-title">Server is Updating</div>
            <div class="maint-subtitle">
                We're deploying improvements and new features.<br>
                This will only take a moment~
            </div>

            <div class="maint-dots">
                <div class="maint-dot"></div>
                <div class="maint-dot"></div>
                <div class="maint-dot"></div>
            </div>

            <div class="maint-tips">
                ${buildTips()}
            </div>
        </div>

        <div class="maint-status-bar">
            <div class="maint-status-dot"></div>
            <span class="maint-status-text">Polling server… <span class="maint-attempt-count" id="maint-attempt-count">0</span> attempts</span>
        </div>
    `;
}

function startPolling() {
    stopPolling();
    attemptCount = 0;

    pollTimer = setInterval(async () => {
        attemptCount++;
        const countEl = overlayEl?.querySelector('#maint-attempt-count');
        if (countEl) countEl.textContent = attemptCount;

        try {
            const res = await fetch('/api/health', {
                cache: 'no-store',
                signal: AbortSignal.timeout(4000),
            });
            if (res.ok) {
                onServerRecovered();
                return;
            }
        } catch {
            // Still unreachable — keep polling
        }
    }, POLL_INTERVAL);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function onServerRecovered() {
    stopPolling();
    if (!overlayEl) return;

    // Play success animation
    overlayEl.classList.add('maint-overlay-success');
    const title = overlayEl.querySelector('.maint-title');
    if (title) title.textContent = 'Server is Back! 🦆';

    const subtitle = overlayEl.querySelector('.maint-subtitle');
    if (subtitle) subtitle.textContent = 'Welcome back — resuming your session…';

    const statusText = overlayEl.querySelector('.maint-status-text');
    if (statusText) statusText.textContent = 'Connected';

    // Fade out after showing success
    setTimeout(() => {
        if (overlayEl) {
            overlayEl.classList.add('fade-out');
            setTimeout(() => {
                hideMaintenanceOverlay();
                if (typeof onRecoveredCb === 'function') {
                    onRecoveredCb();
                }
            }, 600);
        }
    }, 1200);
}

/**
 * Show the maintenance overlay.
 * @param {{ onRecovered?: () => void }} options
 */
export function showMaintenanceOverlay({ onRecovered } = {}) {
    if (overlayEl) return; // Already showing

    onRecoveredCb = onRecovered || null;

    overlayEl = document.createElement('div');
    overlayEl.className = 'maintenance-overlay';
    overlayEl.id = 'maintenance-overlay';
    overlayEl.innerHTML = buildOverlayHTML();
    document.body.appendChild(overlayEl);

    startPolling();
}

/**
 * Hide and remove the maintenance overlay.
 */
export function hideMaintenanceOverlay() {
    stopPolling();
    if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
    }
    onRecoveredCb = null;
}

/**
 * Whether the maintenance overlay is currently visible.
 */
export function isMaintenanceVisible() {
    return !!overlayEl;
}

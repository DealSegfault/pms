function buildFloatingDucks() {
    return Array.from({ length: 12 }, () => {
        const left = Math.random() * 100;
        const delay = Math.random() * 8;
        const duration = 6 + Math.random() * 8;
        const size = 20 + Math.random() * 40;
        const opacity = 0.03 + Math.random() * 0.07;
        return `<div class="duck-float" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;font-size:${size}px;opacity:${opacity};">🦆</div>`;
    }).join('');
}

function buildFloatingFeathers() {
    return Array.from({ length: 8 }, () => {
        const left = Math.random() * 100;
        const delay = Math.random() * 10;
        const duration = 8 + Math.random() * 6;
        return `<div class="feather-float" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;">🪶</div>`;
    }).join('');
}

export function buildAuthPageHTML(reconnecting = false) {
    return `
        <div class="duck-login-bg">
            ${buildFloatingDucks()}
            ${buildFloatingFeathers()}
        </div>

        <div class="duck-login-wrapper">
            <div style="width: 100%; max-width: 380px;">
                <div style="text-align:center; margin-bottom: 16px;" class="duck-mascot-bob">
                    <svg viewBox="0 0 120 120" width="100" height="100" class="seal-glow">
                        <circle cx="60" cy="60" r="55" fill="none" stroke="rgba(251,191,36,0.15)" stroke-width="1" stroke-dasharray="4 4"/>
                        <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(251,191,36,0.08)" stroke-width="0.5"/>
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
                        <rect x="30" y="68" width="12" height="5" rx="2.5" fill="#fef3c7" transform="rotate(-25 36 70)"/>
                        <rect x="29" y="67" width="3" height="7" rx="1.5" fill="#fde68a" transform="rotate(-25 30 70)"/>
                        <rect x="40" y="70" width="3" height="7" rx="1.5" fill="#fde68a" transform="rotate(-25 41 73)"/>
                    </svg>
                </div>

                <div style="text-align:center; margin-bottom: 24px;">
                    <h1 class="cape-flicker" style="font-size:32px;font-weight:800;color:#fbbf24;letter-spacing:2px;font-family:var(--font);">PMS PRO</h1>
                    <div class="subtitle-flicker" style="color:#d4a017;font-size:11px;margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:3px;font-family:var(--font-mono);">🎓 Diplôme : CAPES Canard 🦆</div>
                    <p style="color: var(--text-muted); font-size: 12px; margin-top: 8px; font-style: italic;">
                        « Le canard qui trade ne se fait jamais plumer »
                    </p>
                </div>

                ${reconnecting ? `
                <div id="reconnect-banner" class="reconnect-banner">
                    <span style="font-size: 28px;" class="duck-mascot-bob">🦆</span>
                    <div>
                        <div style="font-weight: 600; color: #fbbf24;">Le canard reconnecte…</div>
                        <div style="font-size: 11px; margin-top: 2px; color: var(--text-muted);">Auto-login quand le lac sera calme~ 🌊</div>
                    </div>
                </div>
                ` : ''}

                <div class="glass-card duck-auth-card" id="auth-card">
                    <div class="tab-bar" style="margin-bottom: 16px;">
                        <button class="active" onclick="window._authTab('login')">Login</button>
                        <button onclick="window._authTab('register')">Register</button>
                    </div>
                    <div id="auth-form"></div>
                </div>

                <div style="text-align:center; margin-top:16px;">
                    <span style="font-size:10px; color: rgba(251,191,36,0.3); font-family: var(--font-mono); letter-spacing: 1px;">
                        ACADÉMIE NATIONALE DU CANARD FINANCIER — EST. 2024
                    </span>
                </div>
            </div>
        </div>
    `;
}

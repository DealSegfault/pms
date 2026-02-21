/**
 * 🎀✨ Girly Theme Animations ✨🎀
 * Kawaii micro-interactions that only activate when data-theme="girly"
 */

let _active = false;
let _catEl = null;
let _catTimer = null;
let _sakuraContainer = null;
let _twinkleContainer = null;
let _cursorTrailEls = [];
let _cursorRAF = null;
let _mouseX = 0;
let _mouseY = 0;
let _eventListeners = [];

function isGirly() {
    return document.documentElement.getAttribute('data-theme') === 'girly';
}

// ─────────────────────────────────────────────────────
// 1. 🐱 Roaming Cat Pet
// ─────────────────────────────────────────────────────

const CAT_SVG_RIGHT = `<svg viewBox="0 0 40 28" width="40" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Body -->
  <ellipse cx="20" cy="20" rx="12" ry="7" fill="#fce7f3"/>
  <!-- Head -->
  <circle cx="30" cy="14" r="7" fill="#fce7f3"/>
  <!-- Ears -->
  <polygon points="26,8 24,2 28,6" fill="#fce7f3"/>
  <polygon points="34,8 36,2 32,6" fill="#fce7f3"/>
  <polygon points="26.5,7.5 25,3 28,6" fill="#f9a8d4"/>
  <polygon points="33.5,7.5 35,3 32,6" fill="#f9a8d4"/>
  <!-- Eyes -->
  <circle cx="28" cy="13" r="1.2" fill="#831843"/>
  <circle cx="33" cy="13" r="1.2" fill="#831843"/>
  <circle cx="28.3" cy="12.7" r="0.4" fill="white"/>
  <circle cx="33.3" cy="12.7" r="0.4" fill="white"/>
  <!-- Nose -->
  <ellipse cx="30.5" cy="15.5" rx="0.8" ry="0.5" fill="#ec4899"/>
  <!-- Whiskers -->
  <line x1="25" y1="14.5" x2="20" y2="13" stroke="#d4a0c8" stroke-width="0.4"/>
  <line x1="25" y1="15.5" x2="20" y2="16" stroke="#d4a0c8" stroke-width="0.4"/>
  <line x1="36" y1="14.5" x2="40" y2="13" stroke="#d4a0c8" stroke-width="0.4"/>
  <line x1="36" y1="15.5" x2="40" y2="16" stroke="#d4a0c8" stroke-width="0.4"/>
  <!-- Tail -->
  <path d="M8 18 Q2 10 6 6" stroke="#fce7f3" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <!-- Legs (walking) -->
  <line x1="14" y1="25" x2="12" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg1"/>
  <line x1="18" y1="25" x2="20" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg2"/>
  <line x1="24" y1="25" x2="22" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg3"/>
  <line x1="28" y1="24" x2="30" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg4"/>
  <!-- Cheeks -->
  <ellipse cx="27" cy="16.5" rx="2" ry="1" fill="#f472b6" opacity="0.25"/>
  <ellipse cx="34" cy="16.5" rx="2" ry="1" fill="#f472b6" opacity="0.25"/>
</svg>`;

const CAT_SVG_LEFT = `<svg viewBox="0 0 40 28" width="40" height="28" fill="none" xmlns="http://www.w3.org/2000/svg" style="transform:scaleX(-1)">
  <!-- Body -->
  <ellipse cx="20" cy="20" rx="12" ry="7" fill="#fce7f3"/>
  <!-- Head -->
  <circle cx="30" cy="14" r="7" fill="#fce7f3"/>
  <!-- Ears -->
  <polygon points="26,8 24,2 28,6" fill="#fce7f3"/>
  <polygon points="34,8 36,2 32,6" fill="#fce7f3"/>
  <polygon points="26.5,7.5 25,3 28,6" fill="#f9a8d4"/>
  <polygon points="33.5,7.5 35,3 32,6" fill="#f9a8d4"/>
  <!-- Eyes -->
  <circle cx="28" cy="13" r="1.2" fill="#831843"/>
  <circle cx="33" cy="13" r="1.2" fill="#831843"/>
  <circle cx="28.3" cy="12.7" r="0.4" fill="white"/>
  <circle cx="33.3" cy="12.7" r="0.4" fill="white"/>
  <!-- Nose -->
  <ellipse cx="30.5" cy="15.5" rx="0.8" ry="0.5" fill="#ec4899"/>
  <!-- Whiskers -->
  <line x1="25" y1="14.5" x2="20" y2="13" stroke="#d4a0c8" stroke-width="0.4"/>
  <line x1="25" y1="15.5" x2="20" y2="16" stroke="#d4a0c8" stroke-width="0.4"/>
  <line x1="36" y1="14.5" x2="40" y2="13" stroke="#d4a0c8" stroke-width="0.4"/>
  <line x1="36" y1="15.5" x2="40" y2="16" stroke="#d4a0c8" stroke-width="0.4"/>
  <!-- Tail -->
  <path d="M8 18 Q2 10 6 6" stroke="#fce7f3" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <!-- Legs -->
  <line x1="14" y1="25" x2="12" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg1"/>
  <line x1="18" y1="25" x2="20" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg3"/>
  <line x1="24" y1="25" x2="22" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg2"/>
  <line x1="28" y1="24" x2="30" y2="28" stroke="#f9a8d4" stroke-width="1.8" stroke-linecap="round" class="girly-cat-leg4"/>
  <!-- Cheeks -->
  <ellipse cx="27" cy="16.5" rx="2" ry="1" fill="#f472b6" opacity="0.25"/>
  <ellipse cx="34" cy="16.5" rx="2" ry="1" fill="#f472b6" opacity="0.25"/>
</svg>`;

const CAT_SVG_SIT = `<svg viewBox="0 0 30 30" width="30" height="30" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Sitting body -->
  <ellipse cx="15" cy="22" rx="9" ry="7" fill="#fce7f3"/>
  <!-- Head -->
  <circle cx="15" cy="12" r="7" fill="#fce7f3"/>
  <!-- Ears -->
  <polygon points="10,6 8,0 13,4" fill="#fce7f3"/>
  <polygon points="20,6 22,0 17,4" fill="#fce7f3"/>
  <polygon points="10.5,5.5 9,1 13,4" fill="#f9a8d4"/>
  <polygon points="19.5,5.5 21,1 17,4" fill="#f9a8d4"/>
  <!-- Eyes (happy closed) -->
  <path d="M11 11 Q13 9 14 11" stroke="#831843" stroke-width="1" fill="none" stroke-linecap="round"/>
  <path d="M16 11 Q18 9 19 11" stroke="#831843" stroke-width="1" fill="none" stroke-linecap="round"/>
  <!-- Nose -->
  <ellipse cx="15" cy="14" rx="0.8" ry="0.5" fill="#ec4899"/>
  <!-- Smile -->
  <path d="M13 15 Q15 17 17 15" stroke="#831843" stroke-width="0.6" fill="none"/>
  <!-- Tail wrapping around -->
  <path d="M24 22 Q28 18 26 14 Q24 12 22 14" stroke="#fce7f3" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <!-- Cheeks -->
  <ellipse cx="10" cy="14" rx="2" ry="1" fill="#f472b6" opacity="0.25"/>
  <ellipse cx="20" cy="14" rx="2" ry="1" fill="#f472b6" opacity="0.25"/>
  <!-- Front paws -->
  <ellipse cx="11" cy="27" rx="2.5" ry="1.5" fill="#f9a8d4"/>
  <ellipse cx="19" cy="27" rx="2.5" ry="1.5" fill="#f9a8d4"/>
</svg>`;

function _spawnCat() {
    if (_catEl) _catEl.remove();
    _catEl = document.createElement('div');
    _catEl.className = 'girly-cat-pet';
    _catEl.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;transition:none;';
    document.body.appendChild(_catEl);
    _catWalk();
}

function _catWalk() {
    if (!_active || !_catEl) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const edge = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left

    let startX, startY, endX, endY, svg;

    switch (edge) {
        case 0: // Top edge, walk left to right
            startX = -50; startY = 4;
            endX = vw + 50; endY = 4;
            svg = CAT_SVG_RIGHT;
            break;
        case 1: // Bottom edge, walk right to left
            startX = vw + 50; startY = vh - 36;
            endX = -50; endY = vh - 36;
            svg = CAT_SVG_LEFT;
            break;
        case 2: // Bottom edge, walk left to right
            startX = -50; startY = vh - 36;
            endX = vw + 50; endY = vh - 36;
            svg = CAT_SVG_RIGHT;
            break;
        case 3: // Top edge, walk right to left
            startX = vw + 50; startY = 4;
            endX = -50; endY = 4;
            svg = CAT_SVG_LEFT;
            break;
    }

    _catEl.innerHTML = svg;
    _catEl.classList.remove('girly-cat-sitting');
    _catEl.classList.add('girly-cat-walking');
    _catEl.style.left = startX + 'px';
    _catEl.style.top = startY + 'px';

    const dist = Math.abs(endX - startX) + Math.abs(endY - startY);
    const speed = 50; // px/s
    const duration = dist / speed;

    _catEl.style.transition = `left ${duration}s linear, top ${duration}s linear`;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!_catEl) return;
            _catEl.style.left = endX + 'px';
            _catEl.style.top = endY + 'px';
        });
    });

    // After walk, sit for a bit, then walk again
    _catTimer = setTimeout(() => {
        if (!_active || !_catEl) return;
        // Sit phase
        _catEl.innerHTML = CAT_SVG_SIT;
        _catEl.classList.remove('girly-cat-walking');
        _catEl.classList.add('girly-cat-sitting');
        // Position cat at a random spot on an edge
        const sitEdge = Math.floor(Math.random() * 2);
        if (sitEdge === 0) {
            _catEl.style.transition = 'none';
            _catEl.style.left = (Math.random() * (vw - 60) + 20) + 'px';
            _catEl.style.top = (vh - 36) + 'px';
        } else {
            _catEl.style.transition = 'none';
            _catEl.style.left = (Math.random() * (vw - 60) + 20) + 'px';
            _catEl.style.top = '4px';
        }

        // After sitting, walk again
        const sitDuration = 4000 + Math.random() * 6000;
        _catTimer = setTimeout(() => {
            _catWalk();
        }, sitDuration);
    }, duration * 1000 + 500);
}

function _destroyCat() {
    if (_catTimer) clearTimeout(_catTimer);
    _catTimer = null;
    if (_catEl) _catEl.remove();
    _catEl = null;
}

// ─────────────────────────────────────────────────────
// 2. ✨ Sparkle Burst (order filled)
// ─────────────────────────────────────────────────────

const SPARKLE_CHARS = ['✨', '⭐', '💖', '🌟', '💕', '🎀', '⚡'];
const SPARKLE_COLORS = ['#f472b6', '#c084fc', '#fbbf24', '#f9a8d4', '#818cf8', '#34d399'];

function _sparkleBurst(x, y, count = 20) {
    if (!_active) return;

    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(container);

    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        const isEmoji = Math.random() > 0.5;
        if (isEmoji) {
            particle.textContent = SPARKLE_CHARS[Math.floor(Math.random() * SPARKLE_CHARS.length)];
            particle.style.fontSize = (8 + Math.random() * 14) + 'px';
        } else {
            const color = SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)];
            const size = 3 + Math.random() * 5;
            particle.style.width = size + 'px';
            particle.style.height = size + 'px';
            particle.style.borderRadius = '50%';
            particle.style.background = color;
            particle.style.boxShadow = `0 0 ${size}px ${color}`;
        }

        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const velocity = 80 + Math.random() * 160;
        const dx = Math.cos(angle) * velocity;
        const dy = Math.sin(angle) * velocity - 30; // slight upward bias

        particle.style.cssText += `position:absolute;left:${x}px;top:${y}px;pointer-events:none;z-index:99999;`;
        particle.style.setProperty('--dx', dx + 'px');
        particle.style.setProperty('--dy', dy + 'px');
        particle.classList.add('girly-sparkle-particle');

        container.appendChild(particle);
    }

    setTimeout(() => container.remove(), 1500);
}

// ─────────────────────────────────────────────────────
// 3. 💸 Money Rain / Heartbreak
// ─────────────────────────────────────────────────────

const MONEY_CHARS = ['💰', '🌸', '✨', '💖', '🎉', '💵', '🌟'];
const LOSS_CHARS = ['💔', '😿', '🥀'];

function _moneyRain(isProfit) {
    if (!_active) return;

    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99998;overflow:hidden;';
    document.body.appendChild(container);

    if (isProfit) {
        const count = 25 + Math.floor(Math.random() * 15);
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            const chars = MONEY_CHARS;
            el.textContent = chars[Math.floor(Math.random() * chars.length)];
            el.style.cssText = `
                position:absolute;
                left:${Math.random() * 100}%;
                top:-30px;
                font-size:${14 + Math.random() * 18}px;
                opacity:${0.6 + Math.random() * 0.4};
                animation: girlyMoneyFall ${2 + Math.random() * 2}s linear ${Math.random() * 1}s forwards;
            `;
            container.appendChild(el);
        }
    } else {
        // Loss: single big heartbreak at center
        const el = document.createElement('div');
        el.textContent = '💔';
        el.style.cssText = `
            position:absolute;
            left:50%;top:50%;
            transform:translate(-50%,-50%);
            font-size:60px;
            animation: girlyHeartbreak 1.2s ease-out forwards;
        `;
        container.appendChild(el);
    }

    setTimeout(() => container.remove(), 4500);
}

// ─────────────────────────────────────────────────────
// 4. 🌸 Floating Sakura Petals (ambient)
// ─────────────────────────────────────────────────────

function _spawnSakura() {
    if (_sakuraContainer) _sakuraContainer.remove();
    _sakuraContainer = document.createElement('div');
    _sakuraContainer.className = 'girly-sakura-container';
    _sakuraContainer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;overflow:hidden;';
    document.body.appendChild(_sakuraContainer);

    for (let i = 0; i < 8; i++) {
        const petal = document.createElement('div');
        petal.className = 'girly-sakura-petal';
        petal.style.setProperty('--delay', (Math.random() * 12) + 's');
        petal.style.setProperty('--duration', (10 + Math.random() * 8) + 's');
        petal.style.setProperty('--start-x', (Math.random() * 110 - 5) + '%');
        petal.style.setProperty('--size', (6 + Math.random() * 8) + 'px');
        petal.style.setProperty('--opacity', (0.06 + Math.random() * 0.08) + '');
        _sakuraContainer.appendChild(petal);
    }
}

function _destroySakura() {
    if (_sakuraContainer) _sakuraContainer.remove();
    _sakuraContainer = null;
}

// ─────────────────────────────────────────────────────
// 5. ⭐ Twinkle Stars (ambient)
// ─────────────────────────────────────────────────────

function _spawnTwinkles() {
    if (_twinkleContainer) _twinkleContainer.remove();
    _twinkleContainer = document.createElement('div');
    _twinkleContainer.className = 'girly-twinkle-container';
    _twinkleContainer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;';
    document.body.appendChild(_twinkleContainer);

    const colors = ['#f472b6', '#c084fc', '#fbbf24', '#818cf8', '#f9a8d4'];
    for (let i = 0; i < 10; i++) {
        const star = document.createElement('div');
        star.className = 'girly-twinkle-star';
        const size = 2 + Math.random() * 3;
        star.style.cssText = `
            position:absolute;
            left:${Math.random() * 100}%;
            top:${Math.random() * 100}%;
            width:${size}px;height:${size}px;
            background:${colors[i % colors.length]};
            border-radius:50%;
            box-shadow: 0 0 ${size * 2}px ${colors[i % colors.length]};
            animation: girlyTwinkle ${2 + Math.random() * 3}s ease-in-out ${Math.random() * 3}s infinite alternate;
        `;
        _twinkleContainer.appendChild(star);
    }
}

function _destroyTwinkles() {
    if (_twinkleContainer) _twinkleContainer.remove();
    _twinkleContainer = null;
}

// ─────────────────────────────────────────────────────
// 6. 🎀 Cursor Trail
// ─────────────────────────────────────────────────────

function _initCursorTrail() {
    // Don't enable on touch devices
    if ('ontouchstart' in window) return;

    _cursorTrailEls = [];
    for (let i = 0; i < 5; i++) {
        const el = document.createElement('div');
        el.className = 'girly-cursor-trail';
        const colors = ['#f472b6', '#c084fc', '#fbbf24', '#f9a8d4', '#818cf8'];
        el.style.cssText = `
            position:fixed;pointer-events:none;z-index:99999;
            width:${6 - i}px;height:${6 - i}px;
            border-radius:50%;
            background:${colors[i]};
            box-shadow:0 0 ${4 + i * 2}px ${colors[i]};
            opacity:0;
            transition: opacity 0.15s;
        `;
        document.body.appendChild(el);
        _cursorTrailEls.push({ el, x: 0, y: 0 });
    }

    const _onMouseMove = (e) => {
        _mouseX = e.clientX;
        _mouseY = e.clientY;
    };
    window.addEventListener('mousemove', _onMouseMove);
    _eventListeners.push(['mousemove', _onMouseMove, window]);

    let positions = Array(5).fill(null).map(() => ({ x: 0, y: 0 }));

    function animate() {
        if (!_active) return;
        positions[0] = { x: _mouseX, y: _mouseY };
        for (let i = 1; i < positions.length; i++) {
            positions[i].x += (positions[i - 1].x - positions[i].x) * 0.35;
            positions[i].y += (positions[i - 1].y - positions[i].y) * 0.35;
        }
        for (let i = 0; i < _cursorTrailEls.length; i++) {
            const t = _cursorTrailEls[i];
            t.el.style.left = positions[i].x + 'px';
            t.el.style.top = positions[i].y + 'px';
            t.el.style.opacity = _mouseX === 0 && _mouseY === 0 ? '0' : (0.6 - i * 0.1) + '';
        }
        _cursorRAF = requestAnimationFrame(animate);
    }
    _cursorRAF = requestAnimationFrame(animate);
}

function _destroyCursorTrail() {
    if (_cursorRAF) cancelAnimationFrame(_cursorRAF);
    _cursorRAF = null;
    _cursorTrailEls.forEach(t => t.el.remove());
    _cursorTrailEls = [];
}

// ─────────────────────────────────────────────────────
// Event Handlers
// ─────────────────────────────────────────────────────

function _onOrderFilled(e) {
    if (!_active) return;
    // Burst from a random upper area (where toasts appear)
    const x = window.innerWidth / 2 + (Math.random() - 0.5) * 200;
    const y = 80 + Math.random() * 40;
    _sparkleBurst(x, y, 22);
}

function _onPositionClosed(e) {
    if (!_active) return;
    const pnl = e?.detail?.realizedPnl;
    const isProfit = pnl != null ? pnl >= 0 : true;
    _moneyRain(isProfit);
}

// ─────────────────────────────────────────────────────
// Init / Destroy
// ─────────────────────────────────────────────────────

export function initGirlyAnimations() {
    if (_active) return;
    if (!isGirly()) return;

    _active = true;

    // Ambient effects
    _spawnSakura();
    _spawnTwinkles();
    _initCursorTrail();

    // Roaming cat — start after 5s
    _catTimer = setTimeout(() => {
        if (_active) _spawnCat();
    }, 5000);

    // Event-driven effects
    window.addEventListener('order_filled', _onOrderFilled);
    window.addEventListener('position_closed', _onPositionClosed);
    _eventListeners.push(
        ['order_filled', _onOrderFilled, window],
        ['position_closed', _onPositionClosed, window],
    );
}

export function destroyGirlyAnimations() {
    _active = false;
    _destroyCat();
    _destroySakura();
    _destroyTwinkles();
    _destroyCursorTrail();

    // Remove all event listeners
    for (const [event, handler, target] of _eventListeners) {
        target.removeEventListener(event, handler);
    }
    _eventListeners = [];
}

/**
 * Call this once at boot. Watches theme changes via MutationObserver.
 */
export function setupGirlyAnimationWatcher() {
    // Initial check
    if (isGirly()) initGirlyAnimations();

    // Watch for theme changes
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.attributeName === 'data-theme') {
                if (isGirly()) {
                    initGirlyAnimations();
                } else {
                    destroyGirlyAnimations();
                }
            }
        }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

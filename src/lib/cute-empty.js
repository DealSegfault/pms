/**
 * 🎀 Cute Empty States & Spinners
 * Kawaii SVG illustrations for empty states, loading, and errors.
 * Each function returns an HTML string ready for innerHTML.
 */

// ── Shared SVG fragments ────────────────────────────

const sparkles = `
  <circle cx="40" cy="40" r="2" fill="#fbbf24" class="sparkle1"/>
  <circle cx="160" cy="50" r="1.5" fill="#f9a8d4" class="sparkle2"/>
  <circle cx="45" cy="140" r="1.8" fill="#c084fc" class="sparkle3"/>
  <circle cx="155" cy="135" r="2" fill="#fbbf24" class="sparkle1"/>
  <circle cx="30" cy="90" r="1" fill="#f472b6" class="sparkle2"/>
  <circle cx="170" cy="90" r="1.2" fill="#818cf8" class="sparkle3"/>
  <path d="M50 110 L52 106 L54 110 L52 114Z" fill="#fbbf24" opacity="0.7" class="sparkle2"/>
  <path d="M148 70 L150 67 L152 70 L150 73Z" fill="#f9a8d4" opacity="0.6" class="sparkle1"/>
  <path d="M35 60 L36.5 57 L38 60 L36.5 63Z" fill="#c084fc" opacity="0.5" class="sparkle3"/>
`;

const hearts = `
  <path d="M60 150 C60 147 63 145 65 147 C67 145 70 147 70 150 C70 154 65 157 65 157 C65 157 60 154 60 150Z" fill="#f472b6" opacity="0.5" class="sparkle2"/>
  <path d="M130 155 C130 153 132 151 133.5 152.5 C135 151 137 153 137 155 C137 158 133.5 160 133.5 160 C133.5 160 130 158 130 155Z" fill="#c084fc" opacity="0.4" class="sparkle1"/>
`;

const miniSparkles = `
  <circle cx="8" cy="8" r="1.5" fill="#fbbf24" class="sparkle1"/>
  <circle cx="42" cy="6" r="1" fill="#f9a8d4" class="sparkle2"/>
  <circle cx="6" cy="38" r="1.2" fill="#c084fc" class="sparkle3"/>
  <circle cx="44" cy="40" r="1.5" fill="#818cf8" class="sparkle1"/>
`;

function wrap(svg, title, subtitle, extraClass = '') {
    return `
    <div class="cute-empty ${extraClass}">
      <div class="cute-illustration">
        ${svg}
      </div>
      ${title ? `<div class="cute-title">${title}</div>` : ''}
      ${subtitle ? `<div class="cute-subtitle">${subtitle}</div>` : ''}
    </div>`;
}

function wrapMini(svg) {
    return `<div class="cute-empty cute-empty-mini"><div class="cute-illustration">${svg}</div></div>`;
}

// ── Spinner — bouncing cat paw ──────────────────────

export function cuteSpinner(opts = {}) {
    if (opts.mini) {
        return `
      <div class="cute-spinner-mini">
        <svg viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg" width="28" height="28">
          ${miniSparkles}
          <!-- Paw pad -->
          <ellipse cx="25" cy="28" rx="8" ry="7" fill="#f9a8d4" class="cute-bounce"/>
          <circle cx="19" cy="22" r="3" fill="#f472b6" class="cute-bounce-delay1"/>
          <circle cx="25" cy="19" r="3" fill="#f472b6" class="cute-bounce-delay2"/>
          <circle cx="31" cy="22" r="3" fill="#f472b6" class="cute-bounce-delay3"/>
        </svg>
      </div>`;
    }
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Main paw pad -->
      <ellipse cx="100" cy="110" rx="24" ry="20" fill="#f9a8d4" class="cute-bounce"/>
      <!-- Toe beans -->
      <circle cx="78" cy="90" r="10" fill="#f472b6" class="cute-bounce-delay1"/>
      <circle cx="100" cy="82" r="10" fill="#f472b6" class="cute-bounce-delay2"/>
      <circle cx="122" cy="90" r="10" fill="#f472b6" class="cute-bounce-delay3"/>
      <!-- Tiny inner pads -->
      <ellipse cx="100" cy="108" rx="10" ry="8" fill="#f472b6" opacity="0.5"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'Loading~', opts.subtitle || 'Please wait a moment ✨');
}

// ── Sleepy Cat on Moon (positions) ──────────────────

export function cuteSleepyCat(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      <circle cx="100" cy="95" r="45" fill="url(#moonGrad2)" opacity="0.9"/>
      <circle cx="120" cy="80" r="35" fill="var(--bg-primary, #0a0e17)"/>
      <ellipse cx="85" cy="72" rx="18" ry="14" fill="#f9a8d4"/>
      <ellipse cx="85" cy="76" rx="14" ry="10" fill="#f472b6"/>
      <polygon points="72,63 69,50 78,60" fill="#f9a8d4"/>
      <polygon points="98,63 101,50 92,60" fill="#f9a8d4"/>
      <polygon points="73,62 71,53 78,60" fill="#f472b6"/>
      <polygon points="97,62 99,53 92,60" fill="#f472b6"/>
      <ellipse cx="80" cy="69" rx="2" ry="1" fill="#831843" opacity="0.8"/>
      <ellipse cx="90" cy="69" rx="2" ry="1" fill="#831843" opacity="0.8"/>
      <ellipse cx="85" cy="72" rx="1.5" ry="1" fill="#ec4899"/>
      <path d="M100 76 Q110 68 108 58 Q106 52 112 48" stroke="#f9a8d4" stroke-width="3" stroke-linecap="round" fill="none"/>
      <text x="115" y="56" fill="#c084fc" font-size="10" font-weight="700" opacity="0.8" class="zzz1">z</text>
      <text x="122" y="48" fill="#a78bfa" font-size="8" font-weight="700" opacity="0.6" class="zzz2">z</text>
      <text x="128" y="42" fill="#818cf8" font-size="6" font-weight="700" opacity="0.4" class="zzz3">z</text>
      ${sparkles}
      ${hearts}
      <defs>
        <linearGradient id="moonGrad2" x1="55" y1="50" x2="145" y2="140">
          <stop offset="0%" stop-color="#c084fc"/>
          <stop offset="100%" stop-color="#818cf8"/>
        </linearGradient>
      </defs>
    </svg>`;
    return wrap(svg, opts.title || 'No More Positions ✨', opts.subtitle || 'All clear~ time to chill 🌙');
}

// ── Bunny with shopping bag (history) ───────────────

export function cuteBunnyHistory(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Bunny body -->
      <ellipse cx="100" cy="115" rx="28" ry="24" fill="#f9a8d4"/>
      <!-- Bunny head -->
      <circle cx="100" cy="85" r="22" fill="#fce7f3"/>
      <!-- Ears -->
      <ellipse cx="88" cy="55" rx="8" ry="22" fill="#fce7f3" transform="rotate(-10 88 55)"/>
      <ellipse cx="112" cy="55" rx="8" ry="22" fill="#fce7f3" transform="rotate(10 112 55)"/>
      <ellipse cx="88" cy="55" rx="5" ry="16" fill="#f9a8d4" transform="rotate(-10 88 55)"/>
      <ellipse cx="112" cy="55" rx="5" ry="16" fill="#f9a8d4" transform="rotate(10 112 55)"/>
      <!-- Face -->
      <circle cx="92" cy="82" r="3" fill="#831843"/>
      <circle cx="108" cy="82" r="3" fill="#831843"/>
      <circle cx="93" cy="81" r="1" fill="white"/>
      <circle cx="109" cy="81" r="1" fill="white"/>
      <ellipse cx="100" cy="89" rx="2" ry="1.5" fill="#ec4899"/>
      <!-- Cheeks -->
      <ellipse cx="84" cy="88" rx="5" ry="3" fill="#f472b6" opacity="0.3"/>
      <ellipse cx="116" cy="88" rx="5" ry="3" fill="#f472b6" opacity="0.3"/>
      <!-- Shopping bag -->
      <rect x="118" y="95" width="28" height="32" rx="4" fill="#c084fc"/>
      <rect x="120" y="97" width="24" height="28" rx="3" fill="#a78bfa"/>
      <path d="M126 97 V90 Q126 85 132 85 Q138 85 138 90 V97" stroke="#c084fc" stroke-width="2.5" fill="none"/>
      <!-- Star on bag -->
      <path d="M132 108 L133.5 113 L138 113 L134.5 116 L136 121 L132 118 L128 121 L129.5 116 L126 113 L130.5 113Z" fill="#fbbf24" opacity="0.8"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Trades Yet~', opts.subtitle || 'Go make some magic! ✨');
}

// ── Key with bow (no account) ───────────────────────

export function cuteKey(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Key body -->
      <rect x="75" y="90" width="70" height="20" rx="10" fill="#f9a8d4"/>
      <!-- Key head -->
      <circle cx="68" cy="100" r="22" fill="#f472b6"/>
      <circle cx="68" cy="100" r="14" fill="var(--bg-primary, #0a0e17)"/>
      <!-- Key teeth -->
      <rect x="130" y="95" width="8" height="15" rx="2" fill="#f9a8d4"/>
      <rect x="140" y="98" width="6" height="12" rx="2" fill="#f9a8d4"/>
      <!-- Bow on key -->
      <path d="M58 78 Q48 68 55 60 Q62 55 68 62" stroke="#c084fc" stroke-width="3" fill="#c084fc" opacity="0.7"/>
      <path d="M78 78 Q88 68 81 60 Q74 55 68 62" stroke="#a78bfa" stroke-width="3" fill="#a78bfa" opacity="0.7"/>
      <!-- Face on key head ring -->
      <circle cx="63" cy="98" r="1.5" fill="#831843"/>
      <circle cx="73" cy="98" r="1.5" fill="#831843"/>
      <path d="M65 103 Q68 106 71 103" stroke="#ec4899" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Account Selected ✨', opts.subtitle || 'Pick an account first, babe~');
}

// ── Seedling chart (no equity) ──────────────────────

export function cuteSeedling(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Chart axes -->
      <line x1="40" y1="150" x2="40" y2="50" stroke="#c084fc" stroke-width="2" opacity="0.4"/>
      <line x1="40" y1="150" x2="165" y2="150" stroke="#c084fc" stroke-width="2" opacity="0.4"/>
      <!-- Chart line going up -->
      <path d="M45 140 Q65 135 80 128 Q95 120 105 105 Q115 90 125 80 Q140 65 155 55" stroke="#f472b6" stroke-width="3" stroke-linecap="round" fill="none"/>
      <!-- Area under chart -->
      <path d="M45 140 Q65 135 80 128 Q95 120 105 105 Q115 90 125 80 Q140 65 155 55 V150 H45 Z" fill="url(#seedGrad)" opacity="0.3"/>
      <!-- Seedling at the end -->
      <line x1="155" y1="55" x2="155" y2="38" stroke="#34d399" stroke-width="2.5"/>
      <path d="M155 42 Q148 35 155 30 Q155 38 155 42Z" fill="#34d399"/>
      <path d="M155 38 Q162 32 155 26 Q155 34 155 38Z" fill="#22c55e"/>
      <!-- Pot at chart end -->
      <rect x="149" y="52" width="12" height="8" rx="2" fill="#f9a8d4"/>
      <!-- Face on pot -->
      <circle cx="153" cy="55" r="1" fill="#831843"/>
      <circle cx="157" cy="55" r="1" fill="#831843"/>
      <path d="M154 57.5 Q155 59 156 57.5" stroke="#ec4899" stroke-width="0.8" fill="none"/>
      ${hearts}
      <defs>
        <linearGradient id="seedGrad" x1="100" y1="55" x2="100" y2="150">
          <stop offset="0%" stop-color="#f472b6"/>
          <stop offset="100%" stop-color="transparent"/>
        </linearGradient>
      </defs>
    </svg>`;
    return wrap(svg, opts.title || 'No Equity Data Yet ✨', opts.subtitle || 'Start trading to see your growth~ 🌱');
}

// ── Crystal ball (scanning) ─────────────────────────

export function cuteCrystalBall(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Ball base -->
      <rect x="75" y="140" width="50" height="12" rx="4" fill="#a78bfa"/>
      <rect x="80" y="135" width="40" height="10" rx="3" fill="#c084fc"/>
      <!-- Crystal ball -->
      <circle cx="100" cy="100" r="38" fill="url(#ballGrad)" opacity="0.85"/>
      <circle cx="100" cy="100" r="38" fill="none" stroke="#c084fc" stroke-width="1.5" opacity="0.5"/>
      <!-- Inner glow -->
      <circle cx="92" cy="92" r="12" fill="white" opacity="0.08"/>
      <!-- Sparkles inside ball -->
      <circle cx="88" cy="85" r="2" fill="#fbbf24" class="sparkle1"/>
      <circle cx="110" cy="95" r="1.8" fill="#f9a8d4" class="sparkle2"/>
      <circle cx="95" cy="108" r="1.5" fill="#818cf8" class="sparkle3"/>
      <path d="M108 85 L109.5 82 L111 85 L109.5 88Z" fill="#fbbf24" opacity="0.8" class="sparkle1"/>
      <!-- Face on ball -->
      <circle cx="93" cy="98" r="2" fill="#831843" opacity="0.6"/>
      <circle cx="107" cy="98" r="2" fill="#831843" opacity="0.6"/>
      <path d="M96 105 Q100 109 104 105" stroke="#ec4899" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.6"/>
      ${hearts}
      <defs>
        <radialGradient id="ballGrad" cx="0.4" cy="0.4">
          <stop offset="0%" stop-color="#e9d5ff"/>
          <stop offset="60%" stop-color="#c084fc"/>
          <stop offset="100%" stop-color="#7c3aed"/>
        </radialGradient>
      </defs>
    </svg>`;
    return wrap(svg, opts.title || 'Scanning Market~ 🔮', opts.subtitle || 'Looking for hot pairs…');
}

// ── Confused kitten (no symbols) ────────────────────

export function cuteKittenSearch(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Cat body -->
      <ellipse cx="95" cy="125" rx="28" ry="22" fill="#f9a8d4"/>
      <!-- Cat head -->
      <circle cx="95" cy="90" r="24" fill="#fce7f3"/>
      <!-- Ears -->
      <polygon points="76,72 68,50 84,66" fill="#fce7f3"/>
      <polygon points="114,72 122,50 106,66" fill="#fce7f3"/>
      <polygon points="77,70 71,54 83,66" fill="#f9a8d4"/>
      <polygon points="113,70 119,54 107,66" fill="#f9a8d4"/>
      <!-- Confused eyes -->
      <circle cx="86" cy="86" r="4" fill="#831843"/>
      <circle cx="104" cy="86" r="4" fill="#831843"/>
      <circle cx="87.5" cy="85" r="1.5" fill="white"/>
      <circle cx="105.5" cy="85" r="1.5" fill="white"/>
      <!-- ? mark above head -->
      <text x="100" y="60" fill="#c084fc" font-size="18" font-weight="800" text-anchor="middle" class="cute-bounce">?</text>
      <!-- Nose & mouth -->
      <ellipse cx="95" cy="93" rx="2" ry="1.5" fill="#ec4899"/>
      <path d="M95 94.5 Q90 99 87 96" stroke="#831843" stroke-width="1" fill="none" opacity="0.5"/>
      <path d="M95 94.5 Q100 99 103 96" stroke="#831843" stroke-width="1" fill="none" opacity="0.5"/>
      <!-- Magnifying glass -->
      <circle cx="140" cy="110" r="16" fill="none" stroke="#c084fc" stroke-width="4"/>
      <line x1="152" y1="122" x2="164" y2="134" stroke="#a78bfa" stroke-width="5" stroke-linecap="round"/>
      <circle cx="140" cy="110" r="12" fill="#c084fc" opacity="0.1"/>
      <!-- Tail -->
      <path d="M120 130 Q140 120 138 105" stroke="#f9a8d4" stroke-width="4" stroke-linecap="round" fill="none"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Symbols Found~', opts.subtitle || 'Try a different search! 🔍');
}

// ── Empty wallet (no accounts) ──────────────────────

export function cuteWallet(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Wallet body -->
      <rect x="50" y="70" width="100" height="70" rx="12" fill="#f472b6"/>
      <rect x="55" y="75" width="90" height="60" rx="8" fill="#fce7f3"/>
      <!-- Wallet flap -->
      <path d="M50 90 H150 V80 Q150 70 140 70 H60 Q50 70 50 80Z" fill="#f9a8d4"/>
      <!-- Clasp -->
      <circle cx="135" cy="90" r="6" fill="#c084fc"/>
      <circle cx="135" cy="90" r="3" fill="#a78bfa"/>
      <!-- Face -->
      <circle cx="88" cy="105" r="2.5" fill="#831843"/>
      <circle cx="108" cy="105" r="2.5" fill="#831843"/>
      <circle cx="89" cy="104" r="1" fill="white"/>
      <circle cx="109" cy="104" r="1" fill="white"/>
      <path d="M93 114 Q98 118 103 114" stroke="#ec4899" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <!-- Cheeks -->
      <ellipse cx="80" cy="112" rx="5" ry="3" fill="#f472b6" opacity="0.3"/>
      <ellipse cx="116" cy="112" rx="5" ry="3" fill="#f472b6" opacity="0.3"/>
      <!-- Sparkle on wallet -->
      <path d="M70 85 L72 81 L74 85 L72 89Z" fill="#fbbf24" opacity="0.7" class="sparkle1"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Accounts ✨', opts.subtitle || 'Create one to get started~');
}

// ── Bear building blocks (no indexes) ───────────────

export function cuteBlocks(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Blocks -->
      <rect x="55" y="120" width="35" height="35" rx="5" fill="#c084fc"/>
      <text x="72" y="143" fill="white" font-size="16" font-weight="800" text-anchor="middle">β</text>
      <rect x="95" y="120" width="35" height="35" rx="5" fill="#f472b6"/>
      <text x="112" y="143" fill="white" font-size="16" font-weight="800" text-anchor="middle">📊</text>
      <rect x="75" y="82" width="35" height="35" rx="5" fill="#818cf8"/>
      <text x="92" y="105" fill="white" font-size="16" font-weight="800" text-anchor="middle">∑</text>
      <!-- Bear peeking from behind blocks -->
      <circle cx="145" cy="110" r="20" fill="#fce7f3"/>
      <!-- Bear ears -->
      <circle cx="133" cy="95" r="8" fill="#fce7f3"/>
      <circle cx="157" cy="95" r="8" fill="#fce7f3"/>
      <circle cx="133" cy="95" r="5" fill="#f9a8d4"/>
      <circle cx="157" cy="95" r="5" fill="#f9a8d4"/>
      <!-- Bear face -->
      <circle cx="139" cy="108" r="2.5" fill="#831843"/>
      <circle cx="151" cy="108" r="2.5" fill="#831843"/>
      <circle cx="140" cy="107" r="1" fill="white"/>
      <circle cx="152" cy="107" r="1" fill="white"/>
      <ellipse cx="145" cy="114" rx="3" ry="2" fill="#f9a8d4"/>
      <ellipse cx="145" cy="115" rx="1.5" ry="1" fill="#ec4899"/>
      <!-- Bear paws on block -->
      <ellipse cx="132" cy="130" rx="5" ry="4" fill="#fce7f3"/>
      <ellipse cx="158" cy="130" rx="5" ry="4" fill="#fce7f3"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Indexes Yet ✨', opts.subtitle || 'Create your first basket index~');
}

// ── Pointer with hearts (select item) ───────────────

export function cutePointer(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Hand pointer -->
      <path d="M90 130 L90 80 Q90 72 98 72 Q106 72 106 80 V100" fill="#fce7f3" stroke="#f9a8d4" stroke-width="2"/>
      <!-- Fingers -->
      <rect x="106" y="92" width="14" height="24" rx="7" fill="#fce7f3" stroke="#f9a8d4" stroke-width="1.5"/>
      <rect x="120" y="96" width="14" height="20" rx="7" fill="#fce7f3" stroke="#f9a8d4" stroke-width="1.5"/>
      <rect x="134" y="100" width="14" height="16" rx="7" fill="#fce7f3" stroke="#f9a8d4" stroke-width="1.5"/>
      <!-- Palm -->
      <path d="M90 120 Q90 140 100 145 Q118 152 148 116 V115 Q134 112 120 112 Q106 114 106 100 L106 100" fill="#fce7f3" stroke="#f9a8d4" stroke-width="1.5"/>
      <!-- Nail -->
      <ellipse cx="98" cy="74" rx="6" ry="4" fill="#f472b6" opacity="0.5"/>
      <!-- Hearts floating above -->
      <path d="M82 60 C82 56 86 53 89 56 C92 53 96 56 96 60 C96 66 89 70 89 70 C89 70 82 66 82 60Z" fill="#f472b6" opacity="0.8" class="sparkle1"/>
      <path d="M108 48 C108 45 111 43 113 45 C115 43 118 45 118 48 C118 52 113 55 113 55 C113 55 108 52 108 48Z" fill="#c084fc" opacity="0.6" class="sparkle2"/>
      <path d="M72 45 C72 43 74 42 75 43 C76 42 78 43 78 45 C78 47 75 49 75 49 C75 49 72 47 72 45Z" fill="#f9a8d4" opacity="0.5" class="sparkle3"/>
    </svg>`;
    return wrap(svg, opts.title || 'Select an Index ✨', opts.subtitle || 'Pick one to view its chart~');
}

// ── Sad face (error) ────────────────────────────────

export function cuteSadFace(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg cute-svg-sm">
      <!-- Face -->
      <circle cx="100" cy="100" r="40" fill="#fce7f3"/>
      <circle cx="100" cy="100" r="40" stroke="#f9a8d4" stroke-width="2" fill="none"/>
      <!-- Eyes -->
      <path d="M82 95 Q86 88 90 95" stroke="#831843" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M110 95 Q114 88 118 95" stroke="#831843" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <!-- Sad mouth -->
      <path d="M88 115 Q100 108 112 115" stroke="#831843" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- Tear -->
      <path d="M86 98 Q84 108 86 112 Q88 108 86 98Z" fill="#93c5fd" opacity="0.6" class="cute-bounce"/>
      <!-- Cheeks -->
      <ellipse cx="80" cy="106" rx="6" ry="3.5" fill="#f472b6" opacity="0.3"/>
      <ellipse cx="120" cy="106" rx="6" ry="3.5" fill="#f472b6" opacity="0.3"/>
      <!-- Band-aid -->
      <rect x="106" y="80" width="20" height="8" rx="3" fill="#fbbf24" opacity="0.7" transform="rotate(-20 116 84)"/>
    </svg>`;
    return wrap(svg, opts.title || 'Oops~', opts.subtitle || opts.message || 'Something went wrong 💔');
}

// ── Crying kitten (reconnecting) ────────────────────

export function cuteCryingKitten(opts = {}) {
    return `
    <div style="display:flex; align-items:center; gap:12px;">
      <svg viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg" width="40" height="40" class="cute-bounce">
        <!-- Kitten head -->
        <circle cx="25" cy="28" r="14" fill="#fce7f3"/>
        <!-- Ears -->
        <polygon points="14,18 10,6 20,14" fill="#fce7f3"/>
        <polygon points="36,18 40,6 30,14" fill="#fce7f3"/>
        <polygon points="15,17 12,8 20,14" fill="#f9a8d4"/>
        <polygon points="35,17 38,8 30,14" fill="#f9a8d4"/>
        <!-- Sad eyes -->
        <path d="M20 26 Q22 23 24 26" stroke="#831843" stroke-width="1.5" fill="none"/>
        <path d="M26 26 Q28 23 30 26" stroke="#831843" stroke-width="1.5" fill="none"/>
        <!-- Tears -->
        <path d="M19 28 Q18 33 19 35 Q20 33 19 28Z" fill="#93c5fd" opacity="0.5" class="sparkle1"/>
        <path d="M31 28 Q30 33 31 35 Q32 33 31 28Z" fill="#93c5fd" opacity="0.5" class="sparkle2"/>
        <!-- Nose -->
        <ellipse cx="25" cy="31" rx="1.5" ry="1" fill="#ec4899"/>
        <!-- Sad mouth -->
        <path d="M22 34 Q25 32 28 34" stroke="#831843" stroke-width="1" fill="none"/>
      </svg>
      <div>
        <div style="font-weight:600; color:#f472b6;">${opts.title || 'Server reconnecting…'}</div>
        <div style="font-size:11px; margin-top:2px; color:var(--text-muted);">${opts.subtitle || 'Will auto-login when ready~'}</div>
      </div>
    </div>`;
}

// ── Folder with face (no sub-accounts) ──────────────

export function cuteFolder(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Folder back -->
      <rect x="40" y="80" width="120" height="76" rx="8" fill="#c084fc"/>
      <!-- Folder tab -->
      <path d="M40 88 V80 Q40 72 48 72 H85 Q90 72 92 78 L95 85 H152 Q160 85 160 93 V88Z" fill="#a78bfa"/>
      <!-- Folder front -->
      <rect x="40" y="88" width="120" height="68" rx="6" fill="#e9d5ff"/>
      <!-- Face -->
      <circle cx="85" cy="118" r="3" fill="#831843"/>
      <circle cx="105" cy="118" r="3" fill="#831843"/>
      <circle cx="86" cy="117" r="1.2" fill="white"/>
      <circle cx="106" cy="117" r="1.2" fill="white"/>
      <path d="M90 128 Q95 132 100 128" stroke="#ec4899" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- Cheeks -->
      <ellipse cx="77" cy="124" rx="5" ry="3" fill="#f472b6" opacity="0.3"/>
      <ellipse cx="113" cy="124" rx="5" ry="3" fill="#f472b6" opacity="0.3"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Sub-Accounts ✨', opts.subtitle || 'Create one to get started~');
}

// ── People icons (no users) ─────────────────────────

export function cutePeople(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Person 1 -->
      <circle cx="75" cy="85" r="18" fill="#fce7f3"/>
      <ellipse cx="75" cy="130" rx="22" ry="18" fill="#f9a8d4"/>
      <circle cx="69" cy="83" r="2" fill="#831843"/>
      <circle cx="81" cy="83" r="2" fill="#831843"/>
      <path d="M72 90 Q75 93 78 90" stroke="#ec4899" stroke-width="1.5" fill="none"/>
      <ellipse cx="65" cy="88" rx="4" ry="2.5" fill="#f472b6" opacity="0.3"/>
      <ellipse cx="85" cy="88" rx="4" ry="2.5" fill="#f472b6" opacity="0.3"/>
      <!-- Person 2 -->
      <circle cx="130" cy="85" r="18" fill="#e9d5ff"/>
      <ellipse cx="130" cy="130" rx="22" ry="18" fill="#c084fc"/>
      <circle cx="124" cy="83" r="2" fill="#831843"/>
      <circle cx="136" cy="83" r="2" fill="#831843"/>
      <path d="M127 90 Q130 93 133 90" stroke="#a78bfa" stroke-width="1.5" fill="none"/>
      <ellipse cx="120" cy="88" rx="4" ry="2.5" fill="#a78bfa" opacity="0.3"/>
      <ellipse cx="140" cy="88" rx="4" ry="2.5" fill="#a78bfa" opacity="0.3"/>
      <!-- Connection heart between -->
      <path d="M97 100 C97 96 100 94 102 96 C104 94 107 96 107 100 C107 105 102 108 102 108 C102 108 97 105 97 100Z" fill="#f472b6" opacity="0.6" class="sparkle1"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Users Yet ✨', opts.subtitle || 'Users will appear here~');
}

// ── Empty chart with face (no data) ─────────────────

export function cuteChart(opts = {}) {
    const svg = `
    <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="cute-svg">
      ${sparkles}
      <!-- Chart box -->
      <rect x="35" y="50" width="130" height="100" rx="10" fill="var(--bg-card, #1e2235)" stroke="#c084fc" stroke-width="2"/>
      <!-- Chart bars -->
      <rect x="55" y="110" width="14" height="25" rx="3" fill="#f472b6" opacity="0.5"/>
      <rect x="75" y="95" width="14" height="40" rx="3" fill="#c084fc" opacity="0.5"/>
      <rect x="95" y="105" width="14" height="30" rx="3" fill="#818cf8" opacity="0.5"/>
      <rect x="115" y="85" width="14" height="50" rx="3" fill="#f9a8d4" opacity="0.5"/>
      <rect x="135" y="100" width="14" height="35" rx="3" fill="#a78bfa" opacity="0.5"/>
      <!-- Face on chart -->
      <circle cx="90" cy="72" r="2.5" fill="#831843" opacity="0.6"/>
      <circle cx="110" cy="72" r="2.5" fill="#831843" opacity="0.6"/>
      <path d="M95 80 Q100 83 105 80" stroke="#ec4899" stroke-width="1.5" fill="none" opacity="0.6"/>
      ${hearts}
    </svg>`;
    return wrap(svg, opts.title || 'No Data Yet ✨', opts.subtitle || 'Data will appear here~');
}

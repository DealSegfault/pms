/**
 * 🎀 Cute Confirm Modal
 * Theme-aware replacement for native confirm() dialogs.
 * Returns a Promise<boolean> — true if confirmed, false if cancelled.
 */

const worriedKittenSvg = `
<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" width="80" height="80">
  <!-- body -->
  <ellipse cx="60" cy="72" rx="32" ry="28" fill="#fce7f3"/>
  <!-- ears -->
  <polygon points="34,48 26,22 46,40" fill="#fce7f3"/>
  <polygon points="86,48 94,22 74,40" fill="#fce7f3"/>
  <polygon points="36,46 30,26 44,40" fill="#f9a8d4"/>
  <polygon points="84,46 90,26 76,40" fill="#f9a8d4"/>
  <!-- face -->
  <!-- eyes (worried) -->
  <ellipse cx="47" cy="64" rx="4.5" ry="5" fill="#831843"/>
  <ellipse cx="73" cy="64" rx="4.5" ry="5" fill="#831843"/>
  <circle cx="45" cy="62" r="1.5" fill="white"/>
  <circle cx="71" cy="62" r="1.5" fill="white"/>
  <!-- worried eyebrows -->
  <path d="M40 56 Q44 52 50 55" stroke="#831843" stroke-width="1.5" fill="none"/>
  <path d="M80 56 Q76 52 70 55" stroke="#831843" stroke-width="1.5" fill="none"/>
  <!-- nose -->
  <ellipse cx="60" cy="71" rx="2" ry="1.2" fill="#ec4899"/>
  <!-- mouth (worried) -->
  <path d="M53 77 Q60 74 67 77" stroke="#831843" stroke-width="1.2" fill="none"/>
  <!-- paws up -->
  <ellipse cx="42" cy="92" rx="7" ry="5" fill="#fce7f3" stroke="#f9a8d4" stroke-width="0.8"/>
  <ellipse cx="78" cy="92" rx="7" ry="5" fill="#fce7f3" stroke="#f9a8d4" stroke-width="0.8"/>
  <!-- tail -->
  <path d="M90 82 Q105 70 100 90" stroke="#f9a8d4" stroke-width="3" fill="none" stroke-linecap="round"/>
  <!-- sparkles -->
  <circle cx="20" cy="30" r="2" fill="#fbbf24" class="sparkle1"/>
  <circle cx="100" cy="35" r="1.5" fill="#c084fc" class="sparkle2"/>
  <circle cx="15" cy="80" r="1.5" fill="#818cf8" class="sparkle3"/>
</svg>`;

/* ⚡ Citadel: institutional shield icon */
const citadelShieldSvg = `
<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" width="80" height="80">
  <!-- glow ring -->
  <circle cx="60" cy="60" r="48" stroke="rgba(0,212,255,0.08)" stroke-width="1" fill="none"/>
  <circle cx="60" cy="60" r="42" stroke="rgba(0,212,255,0.04)" stroke-width="0.5" fill="none"/>
  <!-- shield body -->
  <path d="M60 18 L90 34 L90 62 Q90 88 60 104 Q30 88 30 62 L30 34 Z"
        fill="rgba(0,212,255,0.06)" stroke="#00d4ff" stroke-width="1.5"/>
  <!-- inner shield -->
  <path d="M60 28 L82 40 L82 60 Q82 80 60 94 Q38 80 38 60 L38 40 Z"
        fill="rgba(0,212,255,0.03)" stroke="rgba(0,212,255,0.2)" stroke-width="0.8"/>
  <!-- lock body -->
  <rect x="49" y="56" width="22" height="18" rx="3" fill="rgba(212,160,23,0.15)" stroke="#d4a017" stroke-width="1.2"/>
  <!-- lock shackle -->
  <path d="M52 56 L52 48 Q52 40 60 40 Q68 40 68 48 L68 56" stroke="#d4a017" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <!-- keyhole -->
  <circle cx="60" cy="65" r="2.5" fill="#d4a017"/>
  <rect x="59" y="66" width="2" height="4" rx="0.5" fill="#d4a017"/>
  <!-- corner accents -->
  <path d="M18 24 L18 18 L24 18" stroke="rgba(0,212,255,0.3)" stroke-width="1.5" fill="none"/>
  <path d="M102 24 L102 18 L96 18" stroke="rgba(0,212,255,0.3)" stroke-width="1.5" fill="none"/>
  <path d="M18 96 L18 102 L24 102" stroke="rgba(0,212,255,0.3)" stroke-width="1.5" fill="none"/>
  <path d="M102 96 L102 102 L96 102" stroke="rgba(0,212,255,0.3)" stroke-width="1.5" fill="none"/>
  <!-- data dots -->
  <circle cx="22" cy="40" r="1" fill="rgba(0,212,255,0.3)"/>
  <circle cx="98" cy="80" r="1" fill="rgba(0,212,255,0.3)"/>
  <circle cx="26" cy="86" r="0.8" fill="rgba(212,160,23,0.3)"/>
</svg>`;

function getModalIllustration() {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'citadel') return citadelShieldSvg;
  return worriedKittenSvg;
}

/**
 * Show a confirmation modal (theme-aware).
 * @param {object} opts
 * @param {string} opts.title - Modal title (e.g. "Close Position?")
 * @param {string} [opts.message] - Optional subtitle/description
 * @param {string} [opts.confirmText='Confirm'] - Confirm button label
 * @param {string} [opts.cancelText='Cancel'] - Cancel button label
 * @param {boolean} [opts.danger=false] - If true, confirm button is red/danger style
 * @returns {Promise<boolean>} true if confirmed, false if cancelled
 */
export function cuteConfirm({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    // Prevent duplicates
    document.querySelector('.cute-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'cute-confirm-overlay';
    overlay.innerHTML = `
      <div class="cute-confirm-modal">
        <div class="cute-confirm-illustration">${getModalIllustration()}</div>
        <div class="cute-confirm-title">${title}</div>
        ${message ? `<div class="cute-confirm-message">${message}</div>` : ''}
        <div class="cute-confirm-actions">
          <button class="cute-confirm-btn cute-confirm-cancel">${cancelText}</button>
          <button class="cute-confirm-btn cute-confirm-ok ${danger ? 'cute-confirm-danger' : ''}">${confirmText}</button>
        </div>
      </div>
    `;

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    // Backdrop click → cancel
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    overlay.querySelector('.cute-confirm-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.cute-confirm-ok').addEventListener('click', () => close(true));

    document.body.appendChild(overlay);

    // Focus confirm button for keyboard accessibility
    overlay.querySelector('.cute-confirm-ok').focus();
  });
}

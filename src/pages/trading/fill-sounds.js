/**
 * Fill Sounds — extracted from Kingfisher's audioService.ts
 *
 * Plays synthesized oscillator tones when a long or short order is filled.
 * Sounds are taken directly from Kingfisher's defaultThresholds.json:
 *   - Long fill:  ascending chord  659.26 Hz → 830.6 Hz  (bright "ding-ding")
 *   - Short fill: descending chord 493.88 Hz → 392 Hz    (lower "dong-dong")
 *
 * Usage:
 *   import { playFillSound } from './fill-sounds.js';
 *   playFillSound('LONG');   // or 'SHORT'
 */

let _ctx = null;

/**
 * Get (or lazily create) the AudioContext.
 * Must be called inside a user-gesture handler or after one.
 */
function getContext() {
    if (_ctx && _ctx.state !== 'closed') return _ctx;
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    return _ctx;
}

/**
 * Resume a suspended context (browsers suspend on first init).
 */
async function ensureRunning() {
    const ctx = getContext();
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* ignore */ }
    }
    return ctx;
}

/**
 * Play a single oscillator note.
 *
 * @param {AudioContext} ctx
 * @param {number} frequency   Hz
 * @param {number} gain        0–1
 * @param {number} fadeOut     seconds
 * @param {number} delay       seconds before starting
 * @param {string} osc         OscillatorType ('sine'|'triangle'|'square'|'sawtooth')
 */
function playNote(ctx, frequency, gain, fadeOut, delay = 0, osc = 'sine') {
    const startTime = ctx.currentTime + delay + 0.02; // tiny buffer

    const gainNode = ctx.createGain();
    const source = ctx.createOscillator();

    source.type = osc;
    source.frequency.value = frequency;

    gainNode.gain.setValueAtTime(gain, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + fadeOut);

    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    source.start(startTime);
    source.stop(startTime + fadeOut + 0.05);

    source.onended = () => {
        source.disconnect();
        gainNode.disconnect();
    };
}

/**
 * Long fill sound — extracted from KF "significant" threshold buyAudio:
 *   play(659.26, 0.05 + gain/10, 0.2 + ratio*0.23, 0, , 0)
 *   play(830.6,  0.05 + gain/10, 0.2 + ratio*0.23, 0.08, , 0)
 *
 * Ascending 2-note chord: E5 → G#5 (bright, positive)
 */
async function playLongFill() {
    const ctx = await ensureRunning();
    const g = 0.12; // fixed moderate gain
    const dur = 0.35;
    playNote(ctx, 659.26, g, dur, 0.00, 'sine');
    playNote(ctx, 830.6, g, dur, 0.08, 'sine');
}

/**
 * Short fill sound — extracted from KF "significant" threshold sellAudio:
 *   play(493.88, 0.05 + gain*1.5/10, 0.2 + ratio*0.23, 0, , 0)
 *   play(392,    0.05 + gain*1.5/10, 0.2 + ratio*0.23, 0.08, , 0)
 *
 * Descending 2-note chord: B4 → G4 (lower, cautious)
 */
async function playShortFill() {
    const ctx = await ensureRunning();
    const g = 0.12;
    const dur = 0.35;
    playNote(ctx, 493.88, g, dur, 0.00, 'sine');
    playNote(ctx, 392, g, dur, 0.08, 'sine');
}

/**
 * Play the fill sound for a given side.
 *
 * @param {'LONG'|'SHORT'|'buy'|'sell'} side
 */
export async function playFillSound(side) {
    try {
        const s = String(side || '').toUpperCase();
        if (s === 'LONG' || s === 'BUY') {
            await playLongFill();
        } else if (s === 'SHORT' || s === 'SELL') {
            await playShortFill();
        }
    } catch (err) {
        // Silently ignore audio errors (e.g. suspended context before user gesture)
        console.debug('[FillSounds] Audio error:', err.message);
    }
}

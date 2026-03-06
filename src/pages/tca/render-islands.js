function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function countNodes(target) {
    if (!target || typeof target.querySelectorAll !== 'function') return 0;
    const descendants = target.querySelectorAll('*').length;
    return descendants + (target.innerHTML ? 1 : 0);
}

const PAGE_SHELL_HTML = `
    <div class="tca-page" data-tca-shell="page">
        <div data-tca-region="hero"></div>
        <div data-tca-region="tabs"></div>
        <div data-tca-region="active"></div>
        <div data-tca-region="error"></div>
        <div data-tca-region="drawer"></div>
        <div data-tca-region="debug"></div>
    </div>
`;

const STRATEGY_SHELL_HTML = `
    <section class="tca-strategy-layout" data-tca-shell="strategy">
        <div data-tca-region="strategy-rail"></div>
        <div class="tca-strategy-studio" data-tca-region="strategy-studio"></div>
    </section>
`;

function ensureShell(container, selector, html, regionMap) {
    const startedAt = nowMs();
    let root = container?.querySelector?.(selector) || null;
    let created = false;
    if (!root) {
        container.innerHTML = html;
        root = container.querySelector(selector);
        created = true;
    }
    const regions = {};
    for (const [key, regionSelector] of Object.entries(regionMap)) {
        regions[key] = root?.querySelector?.(regionSelector) || null;
    }
    return {
        root,
        created,
        durationMs: Number((nowMs() - startedAt).toFixed(2)),
        ...regions,
    };
}

export function ensureTcaPageShell(container) {
    return ensureShell(
        container,
        '[data-tca-shell="page"]',
        PAGE_SHELL_HTML,
        {
            hero: '[data-tca-region="hero"]',
            tabs: '[data-tca-region="tabs"]',
            active: '[data-tca-region="active"]',
            error: '[data-tca-region="error"]',
            drawer: '[data-tca-region="drawer"]',
            debug: '[data-tca-region="debug"]',
        },
    );
}

export function ensureTcaStrategyShell(container) {
    return ensureShell(
        container,
        '[data-tca-shell="strategy"]',
        STRATEGY_SHELL_HTML,
        {
            rail: '[data-tca-region="strategy-rail"]',
            studio: '[data-tca-region="strategy-studio"]',
        },
    );
}

export function patchTcaRegion(target, html, {
    name = 'region',
    reason = 'state',
    instrumentation = null,
} = {}) {
    if (!target) return false;
    const nextHtml = String(html || '');
    const startedAt = nowMs();
    const changed = target.innerHTML !== nextHtml;
    if (changed) {
        target.innerHTML = nextHtml;
    }
    const durationMs = Number((nowMs() - startedAt).toFixed(2));
    if (instrumentation?.recordRender) {
        instrumentation.recordRender(name, {
            changed,
            durationMs,
            reason,
            domNodes: changed ? countNodes(target) : 0,
        });
    }
    return changed;
}

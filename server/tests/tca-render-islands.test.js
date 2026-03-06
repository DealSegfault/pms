import test from 'node:test';
import assert from 'node:assert/strict';

import { createTcaInstrumentation } from '../../src/pages/tca/instrumentation.js';
import { patchTcaRegion } from '../../src/pages/tca/render-islands.js';

function createTarget(initialHtml = '') {
    let html = initialHtml;
    let writes = 0;
    return {
        get innerHTML() {
            return html;
        },
        set innerHTML(value) {
            html = value;
            writes += 1;
        },
        get writes() {
            return writes;
        },
        querySelectorAll() {
            return new Array(html ? 3 : 0);
        },
    };
}

test('patchTcaRegion avoids rewriting identical markup and records skipped renders', () => {
    const instrumentation = createTcaInstrumentation();
    const target = createTarget('<div>same</div>');

    const firstChanged = patchTcaRegion(target, '<div>same</div>', {
        name: 'active-tab',
        reason: 'noop',
        instrumentation,
    });
    const secondChanged = patchTcaRegion(target, '<div>next</div>', {
        name: 'active-tab',
        reason: 'update',
        instrumentation,
    });

    const snapshot = instrumentation.snapshot();
    assert.equal(firstChanged, false);
    assert.equal(secondChanged, true);
    assert.equal(target.writes, 1);
    assert.equal(snapshot.renders['active-tab'].count, 2);
    assert.equal(snapshot.renders['active-tab'].changed, 1);
    assert.equal(snapshot.renders['active-tab'].skipped, 1);
});

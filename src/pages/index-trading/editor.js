// ── Inline index editor (renders in left pane) ────
import { showToast } from '../../core/index.js';
import {
    formulaToBuilderWeights, builderWeightsToFormula,
    toggleBuilderSymbol, removeBuilderSymbol, flipBuilderFactor,
    setBuilderFactor, summarizeBuilderWeights, validateIndexBuilderInput,
    normalizeBuilderWeights, equalizeBuilderWeights,
} from '../../lib/index-builder.js';
import { st, saveIndexes, genId } from './state.js';
import { renderIndexList, selectIndex } from './index-list.js';
import { loadAllSymbols } from './pair-builder.js';
import { initChart, loadCompositeChart, recomputeCompositeFromCache } from './chart.js';

// ── Open / Close (swap list ↔ editor in-place) ───

export function openEditor(idToEdit) {
    st.editorVisible = true;
    st.editingId = idToEdit || null;
    st.editorName = '';
    st.editorSymbols = [];
    if (st.editingId) {
        const idx = st.indexes.find(i => i.id === st.editingId);
        if (idx) { st.editorName = idx.name; st.editorSymbols = formulaToBuilderWeights(idx.formula); }
    }

    // Hide list + header buttons, show inline editor
    const list = document.getElementById('idx-list');
    const headerBtns = document.getElementById('idx-list-header-btns');
    const headerTitle = document.getElementById('idx-list-header-title');
    if (list) list.style.display = 'none';
    if (headerBtns) headerBtns.style.display = 'none';
    if (headerTitle) headerTitle.textContent = st.editingId ? '✏️ Edit Index' : '✨ Create Index';

    let container = document.getElementById('idx-editor-inline');
    if (!container) {
        container = document.createElement('div');
        container.id = 'idx-editor-inline';
        container.className = 'idx-editor-inline';
        const panel = document.querySelector('.idx-list-panel');
        if (panel) panel.appendChild(container);
    }
    container.style.display = '';
    renderInlineEditor();
    if (!st.symbolsLoaded) loadAllSymbols().then(() => renderEditorSymbols());

    // Trigger live preview right away if editing
    if (st.editingId) livePreviewIndex();
}

export function closeEditor() {
    st.editorVisible = false;
    const container = document.getElementById('idx-editor-inline');
    const list = document.getElementById('idx-list');
    const headerBtns = document.getElementById('idx-list-header-btns');
    const headerTitle = document.getElementById('idx-list-header-title');
    if (container) container.style.display = 'none';
    if (list) list.style.display = '';
    if (headerBtns) headerBtns.style.display = '';
    if (headerTitle) headerTitle.textContent = 'My Indexes';
    renderIndexList();
    // Restore the real selected index chart
    if (st.selectedIndex) {
        selectIndex(st.selectedIndex.id);
    }
}

// ── Render the inline editor panel ──────────────────

function renderInlineEditor() {
    const container = document.getElementById('idx-editor-inline');
    if (!container) return;
    container.innerHTML = `
        <button class="idx-editor-back-btn" id="idx-editor-back">← Back to Indexes</button>
        <div style="padding:0 8px;">
            <input type="text" id="idx-editor-name" placeholder="Index name (e.g. DeFi Basket)"
                value="${escAttr(st.editorName)}"
                style="width:100%; padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text-primary); font-size:13px; outline:none; margin-bottom:8px;" />
            <input type="text" id="idx-editor-search" placeholder="Search symbols..."
                class="search-input" style="margin-bottom:6px; font-size:12px; padding:6px 10px;" />
        </div>
        <div id="idx-editor-symbols" class="idx-editor-symbols" style="padding:0 8px;"></div>
        <div id="idx-editor-weights" class="idx-editor-weights" style="padding:0 8px; margin-top:8px;"></div>
        <div style="display:flex; gap:6px; padding:8px; margin-top:auto;">
            <button class="btn btn-outline btn-sm" id="idx-editor-normalize" style="flex:1;" disabled>Normalize</button>
            <button class="btn btn-outline btn-sm" id="idx-editor-equal" style="flex:1;" disabled>Equal Wt</button>
            <button class="btn btn-primary btn-sm" id="idx-editor-save" style="flex:1;" disabled>Save</button>
        </div>
    `;

    // Wire events
    document.getElementById('idx-editor-back')?.addEventListener('click', closeEditor);
    document.getElementById('idx-editor-search')?.addEventListener('input', renderEditorSymbols);
    document.getElementById('idx-editor-normalize')?.addEventListener('click', () => {
        if (st.editorSymbols.length === 0) return;
        st.editorSymbols = normalizeBuilderWeights(st.editorSymbols);
        renderEditorWeights();
        livePreviewIndex();
    });
    document.getElementById('idx-editor-equal')?.addEventListener('click', () => {
        if (st.editorSymbols.length === 0) return;
        st.editorSymbols = equalizeBuilderWeights(st.editorSymbols);
        renderEditorWeights();
        livePreviewIndex();
    });
    document.getElementById('idx-editor-save')?.addEventListener('click', saveIndex);
    document.getElementById('idx-editor-name')?.addEventListener('input', (e) => { st.editorName = e.target.value; });

    renderEditorSymbols();
    renderEditorWeights();
}

// ── Symbol list ─────────────────────────────────────

export function renderEditorSymbols() {
    const container = document.getElementById('idx-editor-symbols');
    if (!container) return;
    const scrollBox = container.querySelector('[data-sym-scroll]');
    const savedScroll = scrollBox ? scrollBox.scrollTop : 0;
    const searchVal = (document.getElementById('idx-editor-search')?.value || '').toUpperCase();
    const selectedSet = new Set(st.editorSymbols.map(s => s.symbol));
    const filtered = st.allSymbols.filter(s => {
        if (searchVal && !s.base.includes(searchVal) && !s.symbol.includes(searchVal)) return false;
        return true;
    }).slice(0, 60);

    container.innerHTML = `<div data-sym-scroll style="max-height:160px; overflow-y:auto; border:1px solid var(--border); border-radius:var(--radius-sm);">
      ${filtered.length === 0 ? '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:11px;">No symbols found</div>' :
            filtered.map(s => {
                const sel = selectedSet.has(s.symbol);
                return `<div class="idx-sym-item ${sel ? 'idx-sym-selected' : ''}" data-symbol="${s.symbol}" style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.1s; ${sel ? 'background:rgba(99,102,241,0.08);' : ''}">
              <span style="font-weight:500; font-size:12px;">${s.base}<span style="color:var(--text-muted); font-size:10px;">/USDT</span></span>
              ${sel ? '<span style="color:var(--accent); font-size:11px;">✓</span>' : ''}
            </div>`;
            }).join('')}
    </div>`;
    const newScrollBox = container.querySelector('[data-sym-scroll]');
    if (newScrollBox && savedScroll > 0) newScrollBox.scrollTop = savedScroll;
    container.querySelectorAll('.idx-sym-item').forEach(item => {
        item.addEventListener('click', () => {
            st.editorSymbols = toggleBuilderSymbol(st.editorSymbols, item.dataset.symbol);
            renderEditorSymbols();
            renderEditorWeights();
            livePreviewIndex();
        });
    });
}

// ── Weight rows ─────────────────────────────────────

export function renderEditorWeights() {
    const container = document.getElementById('idx-editor-weights');
    const saveBtn = document.getElementById('idx-editor-save');
    const normalizeBtn = document.getElementById('idx-editor-normalize');
    const equalBtn = document.getElementById('idx-editor-equal');
    if (!container) return;
    const cleanedFormula = builderWeightsToFormula(st.editorSymbols);
    if (saveBtn) saveBtn.disabled = cleanedFormula.length < 2;
    if (normalizeBtn) normalizeBtn.disabled = st.editorSymbols.length < 2;
    if (equalBtn) equalBtn.disabled = st.editorSymbols.length < 2;
    if (st.editorSymbols.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:11px; padding:12px;">Select 2+ symbols to build your index</div>';
        return;
    }
    const { sumWeights, longCount, shortCount } = summarizeBuilderWeights(st.editorSymbols);
    container.innerHTML = `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
      <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Components (${st.editorSymbols.length})</div>
      <div style="display:flex; gap:4px;"><span class="badge badge-long" style="font-size:8px;">${longCount} L</span><span class="badge badge-short" style="font-size:8px;">${shortCount} S</span></div>
    </div>
    <div style="max-height:200px; overflow-y:auto;">
    ${st.editorSymbols.map((es, i) => {
        const f = Number(es.factor) || 0, isL = f >= 0, af = Math.abs(f);
        const pct = sumWeights > 0 ? Math.round((af / sumWeights) * 100) : 0;
        const base = es.symbol.split('/')[0];
        const bc = isL ? 'var(--green)' : 'var(--red)', bg = isL ? 'var(--green-bg)' : 'var(--red-bg)';
        return `<div class="idx-weight-row" data-idx="${i}" style="padding:4px 6px; margin-bottom:3px;">
          <div style="display:flex; align-items:center; gap:6px; flex:1;">
            <button class="idx-side-toggle" data-symbol="${es.symbol}" style="padding:1px 5px; border:1px solid ${bc}; border-radius:3px; background:${bg}; color:${bc}; font-size:8px; font-weight:700; cursor:pointer; min-width:28px;">${isL ? 'L' : 'S'}</button>
            <span style="font-weight:600; font-size:12px;">${base}</span>
            <span style="color:var(--text-muted); font-size:9px;">${pct}%</span>
          </div>
          <div style="display:flex; align-items:center; gap:4px;">
            <input type="number" min="0.01" step="0.1" value="${af.toFixed(4)}" data-symbol="${es.symbol}" class="idx-weight-input" style="width:68px; padding:3px 5px; background:var(--bg-primary); border:1px solid var(--border); border-radius:3px; color:var(--text-primary); font-family:var(--font-mono); font-size:10px;" />
            <button class="idx-remove-sym" data-symbol="${es.symbol}" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding:1px; font-size:13px;">×</button>
          </div>
        </div>`;
    }).join('')}
    </div>`;

    container.querySelectorAll('.idx-side-toggle').forEach(btn => {
        btn.addEventListener('click', () => { st.editorSymbols = flipBuilderFactor(st.editorSymbols, btn.dataset.symbol); renderEditorWeights(); livePreviewIndex(); });
    });
    container.querySelectorAll('.idx-weight-input').forEach(input => {
        input.addEventListener('change', () => { st.editorSymbols = setBuilderFactor(st.editorSymbols, input.dataset.symbol, input.value); renderEditorWeights(); livePreviewIndex(); });
    });
    container.querySelectorAll('.idx-remove-sym').forEach(btn => {
        btn.addEventListener('click', () => { st.editorSymbols = removeBuilderSymbol(st.editorSymbols, btn.dataset.symbol); renderEditorSymbols(); renderEditorWeights(); livePreviewIndex(); });
    });
}

// ── Live chart preview ──────────────────────────────

function livePreviewIndex() {
    const formula = builderWeightsToFormula(st.editorSymbols);
    if (formula.length < 2) return;
    // Temporarily set selectedIndex to a preview so chart updates
    const previewName = st.editorName || 'Preview';
    st.selectedIndex = {
        id: st.editingId || '__preview__',
        name: previewName,
        formula,
    };
    const subtitle = document.getElementById('idx-subtitle');
    if (subtitle) subtitle.textContent = `${previewName} (editing)`;
    // Try instant recompute from cache first (no API calls!)
    // This handles weight changes, side flips, and symbol removals instantly.
    // Only falls back to full fetch if a NEW symbol was added that isn't cached yet.
    if (!recomputeCompositeFromCache()) {
        initChart();
        loadCompositeChart();
    }
}

// ── Save ────────────────────────────────────────────

export function saveIndex() {
    const nameInput = document.getElementById('idx-editor-name');
    st.editorName = nameInput?.value || '';
    const validation = validateIndexBuilderInput(st.editorName, st.editorSymbols, 2);
    if (!validation.ok) { showToast(validation.error, 'error'); return; }
    st.editorName = validation.name;
    const formula = validation.formula;
    if (st.editingId) {
        const idx = st.indexes.findIndex(i => i.id === st.editingId);
        if (idx >= 0) { st.indexes[idx].name = st.editorName; st.indexes[idx].formula = formula; }
    } else {
        st.indexes.push({ id: genId(), name: st.editorName, formula });
    }
    saveIndexes();
    closeEditor();
    renderIndexList();
    showToast(st.editingId ? 'Index updated' : 'Index created', 'success');
    selectIndex(st.editingId || st.indexes[st.indexes.length - 1].id);
}

// ── Helpers ─────────────────────────────────────────

function escAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

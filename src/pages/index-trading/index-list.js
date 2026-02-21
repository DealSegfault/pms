// ── Index list rendering + selection ─────────────
import { showToast } from '../../core/index.js';
import { cuteConfirm } from '../../lib/cute-confirm.js';
import { st, saveIndexes } from './state.js';
import { initChart, loadCompositeChart, cleanupCompositeStreams } from './chart.js';
import { openEditor } from './editor.js';

const LS_LAST_INDEX_KEY = 'pms_last_selected_index';

// ── Weight computation ───────────────────────────

export function computeWeights(formula, size) {
  if (!formula || formula.length === 0 || size <= 0) return null;
  const totalWeight = formula.reduce((s, f) => s + Math.abs(f.factor), 0);
  if (totalWeight === 0) return null;

  const weights = {};
  for (const { symbol, factor } of formula) {
    const pct = Math.abs(factor) / totalWeight;
    weights[symbol] = {
      sizeUsd: pct * size,
      side: factor > 0 ? 'LONG' : 'SHORT',
    };
  }
  return weights;
}

// ── Rendering ────────────────────────────────────

export function renderIndexList() {
  const list = document.getElementById('idx-list');
  const empty = document.getElementById('idx-empty');
  if (!list) return;

  if (st.indexes.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }

  if (empty) empty.style.display = 'none';

  list.innerHTML = st.indexes.map(idx => {
    const isSelected = st.selectedIndex?.id === idx.id;
    const longs = idx.formula.filter(f => f.factor > 0);
    const shorts = idx.formula.filter(f => f.factor < 0);
    const totalWeight = idx.formula.reduce((s, f) => s + Math.abs(f.factor), 0);

    return `
        <div class="idx-card ${isSelected ? 'idx-card-active' : ''}" data-id="${idx.id}" draggable="true">
          <div class="idx-card-header">
            <div style="display:flex; align-items:center; gap:4px;">
              <span class="idx-drag-handle" style="cursor:grab; color:var(--text-muted); font-size:12px; opacity:0.4; user-select:none;">⠿</span>
              <div class="idx-card-name">${idx.name}</div>
            </div>
            <div class="idx-card-actions">
              <button class="idx-card-btn idx-edit-btn" data-id="${idx.id}" title="Edit">✏️</button>
              <button class="idx-card-btn idx-delete-btn" data-id="${idx.id}" title="Delete">🗑</button>
            </div>
          </div>
          <div class="idx-card-composition">
            ${longs.length > 0 ? `<span class="badge badge-long" style="font-size:9px; margin-right:3px;">L: ${longs.map(f => f.symbol.split('/')[0]).join(', ')}</span>` : ''}
            ${shorts.length > 0 ? `<span class="badge badge-short" style="font-size:9px;">S: ${shorts.map(f => f.symbol.split('/')[0]).join(', ')}</span>` : ''}
          </div>
          <div class="idx-card-weights">
            ${idx.formula.slice(0, 6).map(f => {
      const pct = totalWeight > 0 ? Math.round((Math.abs(f.factor) / totalWeight) * 100) : 0;
      return `<span class="idx-weight-chip ${f.factor > 0 ? 'chip-long' : 'chip-short'}">${f.symbol.split('/')[0]} ${pct}%</span>`;
    }).join('')}
            ${idx.formula.length > 6 ? `<span class="idx-weight-chip" style="opacity:0.5;">+${idx.formula.length - 6}</span>` : ''}
          </div>
        </div>`;
  }).join('');

  // ── Event listeners ───
  list.querySelectorAll('.idx-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.idx-card-btn') || e.target.closest('.idx-drag-handle')) return;
      selectIndex(card.dataset.id);
    });
  });

  list.querySelectorAll('.idx-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(btn.dataset.id);
    });
  });

  list.querySelectorAll('.idx-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteIndex(btn.dataset.id);
    });
  });

  // ── Drag & drop reording ───
  let draggedId = null;

  list.querySelectorAll('.idx-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedId = card.dataset.id;
      card.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
    });

    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      draggedId = null;
      list.querySelectorAll('.idx-card').forEach(c => {
        c.style.borderTop = '';
        c.style.borderBottom = '';
      });
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (card.dataset.id === draggedId) return;
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        card.style.borderTop = '2px solid var(--accent)';
        card.style.borderBottom = '';
      } else {
        card.style.borderTop = '';
        card.style.borderBottom = '2px solid var(--accent)';
      }
    });

    card.addEventListener('dragleave', () => {
      card.style.borderTop = '';
      card.style.borderBottom = '';
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.style.borderTop = '';
      card.style.borderBottom = '';
      const fromId = e.dataTransfer.getData('text/plain');
      const toId = card.dataset.id;
      if (!fromId || fromId === toId) return;

      const fromIdx = st.indexes.findIndex(i => i.id === fromId);
      const toIdx = st.indexes.findIndex(i => i.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;

      // Determine insert position based on mouse position
      const rect = card.getBoundingClientRect();
      const insertAfter = e.clientY >= rect.top + rect.height / 2;

      const [moved] = st.indexes.splice(fromIdx, 1);
      const newToIdx = st.indexes.findIndex(i => i.id === toId);
      st.indexes.splice(insertAfter ? newToIdx + 1 : newToIdx, 0, moved);

      saveIndexes();
      renderIndexList();
    });
  });
}

// ── Selection ────────────────────────────────────

export function selectIndex(id) {
  st.selectedIndex = st.indexes.find(idx => idx.id === id) || null;
  // Persist last selection
  try { localStorage.setItem(LS_LAST_INDEX_KEY, id || ''); } catch { }

  renderIndexList();

  const subtitle = document.getElementById('idx-subtitle');
  const noSel = document.getElementById('idx-no-selection');
  const form = document.getElementById('idx-trade-form');
  const chartEmpty = document.getElementById('idx-chart-empty');

  if (st.selectedIndex) {
    if (subtitle) subtitle.textContent = st.selectedIndex.name;
    if (noSel) noSel.style.display = 'none';
    if (form) form.style.display = '';
    if (chartEmpty) chartEmpty.style.display = 'none';

    updateSelectedInfo();
    updateAllocation();
    initChart();
    loadCompositeChart();
  } else {
    if (subtitle) subtitle.textContent = 'Select or create an index';
    if (noSel) noSel.style.display = '';
    if (form) form.style.display = 'none';
    if (chartEmpty) chartEmpty.style.display = '';
    cleanupCompositeStreams();
    st.compositeContext = null;
    const priceEl = document.getElementById('idx-price');
    if (priceEl) priceEl.textContent = '—';
  }
}

export function updateSelectedInfo() {
  const el = document.getElementById('idx-selected-info');
  if (!el || !st.selectedIndex) return;

  const longs = st.selectedIndex.formula.filter(f => f.factor > 0);
  const shorts = st.selectedIndex.formula.filter(f => f.factor < 0);

  el.innerHTML = `
    <div style="background:var(--bg-input); border-radius:6px; padding:8px 10px; margin-bottom:8px;">
      <div style="font-weight:600; font-size:13px; margin-bottom:4px;">${st.selectedIndex.name}</div>
      <div style="font-size:11px; color:var(--text-muted);">
        ${st.selectedIndex.formula.length} symbols · ${longs.length} long · ${shorts.length} short
      </div>
    </div>`;
}

export function updateAllocation() {
  const el = document.getElementById('idx-allocation');
  const buyBtn = document.getElementById('idx-buy-btn');
  const sellBtn = document.getElementById('idx-sell-btn');
  if (!el || !st.selectedIndex) return;

  const weights = computeWeights(st.selectedIndex.formula, st.tradeSize);
  if (!weights) {
    el.innerHTML = '';
    if (buyBtn) buyBtn.disabled = true;
    if (sellBtn) sellBtn.disabled = true;
    return;
  }

  const canTrade = st.tradeSize >= 10 && !st.isExecuting;
  if (buyBtn) buyBtn.disabled = !canTrade;
  if (sellBtn) sellBtn.disabled = !canTrade;

  const totalWeight = st.selectedIndex.formula.reduce((s, f) => s + Math.abs(f.factor), 0);

  el.innerHTML = `
    <div style="background:var(--bg-input); border-radius:6px; padding:8px; margin-top:8px;">
      <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Allocation Preview ($${st.tradeSize})</div>
      ${st.selectedIndex.formula.map(f => {
    const pct = totalWeight > 0 ? (Math.abs(f.factor) / totalWeight) : 0;
    const usd = (pct * st.tradeSize).toFixed(1);
    const base = f.symbol.split('/')[0];
    const side = f.factor > 0 ? 'LONG' : 'SHORT';
    const color = f.factor > 0 ? 'var(--green)' : 'var(--red)';
    return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:3px 0; font-size:11px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="width:4px; height:4px; border-radius:50%; background:${color};"></span>
            <span style="font-weight:500;">${base}</span>
            <span style="color:${color}; font-size:9px; font-weight:600;">${side}</span>
          </div>
          <div style="font-family:var(--font-mono); color:var(--text-secondary);">
            $${usd} <span style="color:var(--text-muted); font-size:9px;">(${Math.round(pct * 100)}%)</span>
          </div>
        </div>`;
  }).join('')}
      <div style="border-top:1px solid var(--border); margin-top:6px; padding-top:6px; display:flex; justify-content:space-between; font-size:11px; font-weight:600;">
        <span>Total Exposure</span>
        <span style="font-family:var(--font-mono);">$${st.tradeSize}</span>
      </div>
    </div>`;
}

async function deleteIndex(id) {
  if (!(await cuteConfirm({ title: 'Delete This Index?', message: 'This cannot be undone~', confirmText: 'Delete', danger: true }))) return;
  st.indexes = st.indexes.filter(i => i.id !== id);
  if (st.selectedIndex?.id === id) st.selectedIndex = null;
  saveIndexes();
  renderIndexList();
  selectIndex(null);
  showToast('Index deleted', 'success');
}

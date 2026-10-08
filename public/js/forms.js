/* Generic list, form and print engine driven by SCHEMAS. */
'use strict';

const DOC_COLS = new Set(['purchaseOrders', 'grn', 'purchaseBills', 'payments', 'transfers', 'stockAdjust', 'knitting', 'dyeing', 'finishing', 'overheads', 'salesOrders', 'deliveries', 'invoices', 'receipts']);
const BASE_REFS = ['items', 'units', 'parties', 'locations', 'machines', 'processes', 'boms', 'priceList'];

function refsFor(s) {
  const cols = new Set(BASE_REFS);
  const scan = f => { if (f.type === 'ref') cols.add(f.ref); };
  s.fields.forEach(scan);
  s.grids.forEach(g => g.cols.forEach(scan));
  cols.add(s.col);
  (s.needs || []).forEach(c => cols.add(c));
  return [...cols];
}

const isEmpty = v => v === undefined || v === null || v === '';

// Text shown for a stored value in lists / print.
function displayValue(f, v) {
  if (isEmpty(v)) return '';
  if (f.type === 'ref') {
    const r = Cache.byId(f.ref, v);
    if (!r) return v;
    if (DOC_COLS.has(f.ref)) return r.no || '';
    if (f.ref === 'items' || f.ref === 'parties' || f.ref === 'locations' || f.ref === 'processes' || f.ref === 'boms') return r.name;
    if (f.ref === 'machines') return r.code;
    if (f.ref === 'units') return r.code;
    return refLabel(f.ref, r);
  }
  if (f.type === 'check') return v ? 'Yes' : 'No';
  if (f.type === 'select' && typeof f.options === 'function') { const o = f.options({}).find(x => Array.isArray(x) && x[0] === v); if (o) return o[1]; }
  if (f.type === 'date') return U.fmtDate(v);
  if (f.fmt) return U.fmt(f.fmt, v);
  return String(v);
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */

function listColumns(s) {
  const find = k => s.fields.find(f => f.k === k) || { k, label: k };
  let cols = s.listCols;
  if (!cols) {
    cols = s.fields.filter(f => f.list).map(f => f.k);
    if (s.isDoc) cols = ['no', 'date'].concat(cols.filter(k => k !== 'no' && k !== 'date'));
  }
  return cols.map(c => {
    if (typeof c === 'string') { const f = find(c); return { k: c, label: f.label, fmt: f.fmt || (f.type === 'date' ? 'date' : null), get: r => displayValue(f, r[c]), raw: r => r[c] }; }
    const f = s.fields.find(x => x.k === c.k);
    return { k: c.k, label: c.label, fmt: c.fmt, get: r => { const v = c.value ? c.value(r) : r[c.k]; if (f && !c.fmt) return displayValue(f, v); return c.fmt ? U.fmt(c.fmt, v) : (isEmpty(v) ? '' : String(v)); }, raw: r => c.value ? c.value(r) : r[c.k] };
  });
}

async function renderList(main, key, query) {
  const s = SCHEMAS[key];
  if (!s) return renderNotFound(main);
  if (!Perm.can(s.area, 'view')) return renderDenied(main);
  Cache.invalidate(s.col);
  await Cache.load(refsFor(s));
  const all = Cache.list(s.col).filter(r => !s.where || s.where(r));
  const cols = listColumns(s);
  const state = { q: query.q || '', from: query.from || '', to: query.to || '', f: query.f || '', limit: 200, sortK: null, sortDir: 1 };

  const tbody = h('tbody');
  const foot = h('div', { class: 'list-foot' });
  const draw = () => {
    let rows = all.filter(r => {
      if (s.isDoc && state.from && r.date < state.from) return false;
      if (s.isDoc && state.to && r.date > state.to) return false;
      if (state.f && s.listFilter && r[s.listFilter.k] !== state.f) return false;
      if (state.q) { const t = state.q.toLowerCase(); return cols.some(c => String(c.get(r)).toLowerCase().includes(t)); }
      return true;
    });
    if (state.sortK) {
      const c = cols.find(x => x.k === state.sortK);
      rows.sort((a, b) => { const x = c.raw(a), y = c.raw(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(c.get(a)).localeCompare(String(c.get(b)), undefined, { numeric: true })) * state.sortDir; });
    } else if (s.isDoc) rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.no || '').localeCompare(a.no || ''));
    else rows.sort((a, b) => String(a.name || a.code || a.username || '').localeCompare(String(b.name || b.code || b.username || '')));
    tbody.innerHTML = '';
    if (!rows.length) tbody.appendChild(h('tr', null, h('td', { colspan: cols.length, class: 'empty' }, all.length ? 'No records match the filters.' : 'No ' + s.title.toLowerCase() + ' yet. Click "New" to add one.')));
    rows.slice(0, state.limit).forEach(r => tbody.appendChild(h('tr', { class: 'click', tabindex: 0, onclick: () => { location.hash = '#/edit/' + key + '/' + r.id; }, onkeydown: e => { if (e.key === 'Enter') location.hash = '#/edit/' + key + '/' + r.id; } },
      cols.map(c => h('td', { class: c.fmt && c.fmt !== 'date' ? 'num' : '' }, c.get(r))))));
    foot.innerHTML = '';
    foot.append(rows.length + ' record' + (rows.length === 1 ? '' : 's'));
    const moneyCol = cols.find(c => c.fmt === 'money' && /total|amount|value/i.test(c.label));
    if (moneyCol && rows.length) foot.append(' · ' + moneyCol.label + ': ₹ ' + U.money(rows.reduce((t, r) => t + (+moneyCol.raw(r) || 0), 0)));
    if (rows.length > state.limit) foot.appendChild(h('button', { class: 'btn small', onclick: () => { state.limit += 500; draw(); } }, 'Show more'));
  };

  const thead = h('thead', null, h('tr', null, cols.map(c => h('th', {
    class: (c.fmt && c.fmt !== 'date' ? 'num ' : '') + 'sortable', tabindex: 0,
    onclick: () => { state.sortDir = state.sortK === c.k ? -state.sortDir : 1; state.sortK = c.k; draw(); },
  }, c.label))));

  const canCreate = Perm.can(s.area, 'edit');
  main.append(
    pageHead(s.title, s.note, [
      canCreate ? h('a', { class: 'btn primary', href: '#/edit/' + key + '/new' }, icon('plus', 16), 'New ' + s.singular.toLowerCase()) : null,
    ]),
    h('div', { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search', 16), h('input', { type: 'search', placeholder: 'Search…', value: state.q, 'aria-label': 'Search', oninput: U.debounce(e => { state.q = e.target.value; draw(); }, 150) })),
      s.isDoc ? [h('label', { class: 'inline' }, 'From ', h('input', { type: 'date', value: state.from, onchange: e => { state.from = e.target.value; draw(); } })),
        h('label', { class: 'inline' }, 'To ', h('input', { type: 'date', value: state.to, onchange: e => { state.to = e.target.value; draw(); } }))] : null,
      s.listFilter ? h('select', { 'aria-label': 'Filter', onchange: e => { state.f = e.target.value; draw(); } }, h('option', { value: '' }, 'All'), s.listFilter.options.map(o => h('option', { value: o, selected: o === state.f }, o))) : null,
    ),
    h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, thead, tbody))),
    foot,
  );
  draw();
}

/* ================================================================== */
/* FORM                                                                */
/* ================================================================== */

async function renderForm(main, key, id) {
  const s = SCHEMAS[key];
  if (!s) return renderNotFound(main);
  const isNew = id === 'new';
  if (!Perm.can(s.area, isNew ? 'edit' : 'view')) return renderDenied(main);
  await Promise.all([Cache.load(refsFor(s)), Cache.getSettings()]);
  let doc;
  if (isNew) {
    doc = {};
    for (const f of s.fields) if (f.def !== undefined) doc[f.k] = typeof f.def === 'function' ? f.def() : f.def;
    Object.assign(doc, s.fixed || {});
    for (const g of s.grids) doc[g.k] = [{}];
    if (s.onNew) await s.onNew(doc);
  } else {
    doc = JSON.parse(JSON.stringify(await API.get('/api/' + s.col + '/' + id)));
    doc._wastageQtyTouched = true; doc._labourTouched = true;
    for (const g of s.grids) if (!Array.isArray(doc[g.k]) || !doc[g.k].length) doc[g.k] = [{}];
  }
  const original = isNew ? null : JSON.parse(JSON.stringify(doc));
  const hasLots = s.fields.some(f => f.type === 'lot') || s.grids.some(g => g.cols.some(c => c.type === 'lot'));
  const stock = new Map();
  if (hasLots) {
    const r = await API.report('stockChoices');
    for (const x of r.rows) { const k = x.loc + '|' + x.item; if (!stock.has(k)) stock.set(k, []); stock.get(k).push(x); }
    // When editing, give back what this document itself consumed so its own lots remain selectable.
    if (original) {
      const give = (loc, item, lot, qty) => { const k = loc + '|' + item; if (!stock.has(k)) stock.set(k, []); const arr = stock.get(k); const e = arr.find(x => x.lot === (lot || '')); if (e) e.qty = S.r3(e.qty + qty); else arr.push({ loc, item, lot: lot || '', qty }); };
      for (const f of s.fields) if (f.type === 'lot') give(f.loc(original), original[f.itemKey], original[f.k], S.num(original.inQty));
      for (const g of s.grids) for (const c of g.cols) if (c.type === 'lot') for (const r of original[g.k] || []) give(c.loc(original, r), r.item, r.lot, S.num(r.qty));
    }
  }

  const form = h('div', { class: 'form' });
  const ctx = {
    s, doc, isNew, bindings: [], calcs: [],
    available(loc, item, lot) { const e = (stock.get(loc + '|' + item) || []).find(x => x.lot === (lot || '')); return e ? e.qty : 0; },
    lots(loc, item) { return stock.get(loc + '|' + item) || []; },
    refresh() {
      if (s.recalc) s.recalc(doc);
      for (const b of ctx.bindings) if (b.el !== document.activeElement && b.el.isConnected) { const v = b.obj[b.k]; const nv = isEmpty(v) ? '' : String(v); if (b.el.value !== nv) b.el.value = nv; }
      for (const c of ctx.calcs) if (c.el.isConnected) c.el.textContent = c.fn();
    },
    rerender() {
      const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.path : null;
      const sc = document.getElementById('main') || document.scrollingElement;
      const y = sc.scrollTop;
      ctx.bindings = []; ctx.calcs = [];
      if (s.recalc) s.recalc(doc);
      form.replaceChildren(...buildBlocks());
      ctx.refresh();
      if (ctx.readOnly) form.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
      sc.scrollTop = y;
      if (active) { const el = form.querySelector('[data-path="' + active + '"]'); if (el) el.focus(); }
    },
    async loadBalance() {
      doc._balText = ''; doc._bal = 0;
      if (!doc.party) return ctx.refresh();
      try {
        const r = await API.report('partyBalance', { party: doc.party });
        const p = Cache.byId('parties', doc.party) || {};
        doc._bal = r.balance;
        doc._balText = '₹ ' + U.money(Math.abs(r.balance)) + (r.balance >= 0 ? ' Dr' : ' Cr') + (S.num(p.creditLimit) ? ' (limit ₹ ' + U.money(p.creditLimit) + ')' : '');
      } catch (e) { doc._balText = ''; }
      ctx.refresh();
    },
  };

  function fieldControl(f, obj, row, grid, path) {
    const get = () => obj[f.k];
    const afterInput = () => { if (f.onInput) f.onInput(doc, row, ctx); if (grid && grid.onEdit) grid.onEdit(doc, row); ctx.refresh(); };
    const afterChange = () => {
      if (f.onChange) { if (row) f.onChange(row, doc, ctx); else f.onChange(doc, ctx); }
      if (grid && grid.onEdit) grid.onEdit(doc, row);
      ctx.rerender();
    };
    const bind = el => { ctx.bindings.push({ el, obj, k: f.k }); el.dataset.path = path; return el; };
    const label = f.label + (f.req ? ' (required)' : '');
    switch (f.type) {
      case 'ro':
        return h('div', { class: 'ro' }, isEmpty(get()) ? (f.placeholder || '') : get());
      case 'calc': {
        const el = h('div', { class: 'calc' + (f.fmt && f.fmt !== 'pct' ? ' num' : '') });
        ctx.calcs.push({ el, fn: () => { const v = f.value(obj, doc, ctx); return f.fmt ? U.fmt(f.fmt, v) : (isEmpty(v) ? '' : String(v)); } });
        return el;
      }
      case 'textarea':
        return bind(h('textarea', { rows: 2, 'aria-label': label, value: get() || '', oninput: e => { obj[f.k] = e.target.value; afterInput(); } }));
      case 'number':
        return bind(h('input', { type: 'number', step: 'any', 'aria-label': label, class: 'num', value: isEmpty(get()) ? '' : get(), placeholder: f.placeholder || '',
          oninput: e => { obj[f.k] = e.target.value === '' ? '' : +e.target.value; afterInput(); },
          onchange: () => { if (f.onChange) afterChange(); } }));
      case 'date':
        return bind(h('input', { type: 'date', 'aria-label': label, value: get() || '', onchange: e => { obj[f.k] = e.target.value; afterChange(); } }));
      case 'check':
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!get(), onchange: e => { obj[f.k] = e.target.checked; afterChange(); } }), ' ', f.label);
      case 'select': {
        const opts = (typeof f.options === 'function' ? f.options(doc) : f.options).map(o => Array.isArray(o) ? o : [o, o]);
        return bind(h('select', { 'aria-label': label, onchange: e => { obj[f.k] = e.target.value; afterChange(); } },
          h('option', { value: '' }, '—'), opts.map(([v, l]) => h('option', { value: v, selected: v === get() }, l))));
      }
      case 'perms': {
        const perms = obj[f.k] || (obj[f.k] = {});
        const names = { none: 'No access', view: 'View', edit: 'Add & edit', full: 'Full (incl. delete)' };
        const rows = [];
        let group = null;
        for (const a of S.PERM_AREAS) {
          if (a.group !== group) { group = a.group; rows.push(h('tr', { class: 'grp' }, h('th', { colspan: 2 }, group))); }
          const lv = a.viewOnly ? ['none', 'view'] : S.LEVELS;
          rows.push(h('tr', null, h('td', null, a.label), h('td', null, h('select', { 'aria-label': a.label, class: 'perm-sel', 'data-level': perms[a.k] || 'none',
            onchange: e => { perms[a.k] = e.target.value; e.target.dataset.level = e.target.value; } }, lv.map(l => h('option', { value: l, selected: (perms[a.k] || 'none') === l }, names[l]))))));
        }
        const setAll = lvl => { for (const a of S.PERM_AREAS) perms[a.k] = a.viewOnly && lvl !== 'none' ? 'view' : lvl; ctx.rerender(); };
        return h('div', null,
          h('div', { class: 'actions', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'Set all to:'),
            ['none', 'view', 'edit', 'full'].map(l => h('button', { type: 'button', class: 'btn small', onclick: () => setAll(l) }, names[l]))),
          h('table', { class: 'perm-table' }, h('tbody', null, rows)));
      }
      case 'ref': {
        const cur = get();
        let opts = Cache.list(f.ref).filter(r => !f.filter || f.filter(r, doc));
        if (f.ref === 'users') opts = opts.filter(u => u.active !== false);
        if (cur && !opts.some(r => r.id === cur)) { const c = Cache.byId(f.ref, cur); if (c) opts.unshift(c); }
        if (DOC_COLS.has(f.ref)) opts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        else opts.sort((a, b) => refLabel(f.ref, a).localeCompare(refLabel(f.ref, b)));
        return bind(h('select', { 'aria-label': label, onchange: e => { obj[f.k] = e.target.value; afterChange(); } },
          h('option', { value: '' }, DOC_COLS.has(f.ref) ? '— none —' : '— select —'), opts.map(r => h('option', { value: r.id, selected: r.id === cur }, refLabel(f.ref, r)))));
      }
      case 'lot': {
        const loc = f.loc(doc, row), item = obj[f.itemKey], cur = get() || '';
        const opts = item ? ctx.lots(loc, item).filter(x => x.qty > 0.0005 || x.lot === cur) : [];
        if (cur && !opts.some(x => x.lot === cur)) opts.unshift({ lot: cur, qty: 0 });
        const u = unitOf(item);
        return bind(h('select', { 'aria-label': label, onchange: e => { obj[f.k] = e.target.value; afterChange(); } },
          h('option', { value: '' }, !item ? 'pick item first' : opts.length ? (opts.some(x => x.lot === '') ? '— no lot —' : '— select lot —') : 'no stock here'),
          opts.filter(x => x.lot !== '').map(x => h('option', { value: x.lot, selected: x.lot === cur }, x.lot + ' — ' + U.qty(x.qty) + ' ' + u)),
          opts.filter(x => x.lot === '').map(x => h('option', { value: '', selected: cur === '' }, '(no lot) — ' + U.qty(x.qty) + ' ' + u))));
      }
      case 'password':
        return bind(h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': label, value: get() || '', oninput: e => { obj[f.k] = e.target.value; } }));
      default:
        return bind(h('input', { type: 'text', 'aria-label': label, value: get() || '', placeholder: f.placeholder || '', oninput: e => { obj[f.k] = e.target.value; afterInput(); }, onchange: () => { if (f.onChange) afterChange(); } }));
    }
  }

  function fieldsBlock(b) {
    return h('div', { class: 'fields' }, b.fields.filter(f => !(s.fixed && f.k in s.fixed) || f.type === 'ro').map(f => h('div', { class: 'field w' + (f.w || 1) + (f.type === 'check' ? ' checkfield' : '') },
      f.type === 'check' ? null : h('span', { class: 'lbl' }, f.label, f.req ? h('b', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
      fieldControl(f, doc, null, null, f.k),
      f.help ? h('small', { class: 'help' }, f.help) : null)));
  }

  function gridBlock(g) {
    const rows = doc[g.k];
    const sumCols = g.totals || [];
    return h('div', { class: 'grid-wrap' },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', { class: 'idx' }, '#'), g.cols.map(c => h('th', { class: (c.wide ? 'wide ' : '') + (c.narrow ? 'narrow ' : '') + (c.fmt && c.fmt !== 'pct' ? 'num' : '') }, c.label, c.req ? h('b', { class: 'req', 'aria-hidden': 'true' }, ' *') : null)), h('th', { class: 'idx' }, h('span', { class: 'sr' }, 'Remove')))),
        h('tbody', null, rows.map((r, i) => h('tr', null,
          h('td', { class: 'idx' }, i + 1),
          g.cols.map(c => h('td', { class: c.type === 'calc' ? 'calc-cell' : '' }, fieldControl(c, r, r, g, g.k + '.' + i + '.' + c.k))),
          h('td', { class: 'idx' }, h('button', { class: 'icon-btn', type: 'button', title: 'Remove line', 'aria-label': 'Remove line ' + (i + 1), onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push({}); if (g.onEdit) g.onEdit(doc); ctx.rerender(); } }, icon('x', 14)))))),
        sumCols.length ? h('tfoot', null, h('tr', null, h('td'), g.cols.map(c => {
          if (!sumCols.includes(c.k)) return h('td');
          const el = h('td', { class: 'num strong' });
          ctx.calcs.push({ el, fn: () => U.fmt(c.fmt || 'qty', rows.reduce((t, x) => t + S.num(x[c.k]), 0)) });
          return el;
        }), h('td'))) : null),
      h('button', { class: 'btn small', type: 'button', onclick: () => { rows.push({}); ctx.rerender(); const el = form.querySelector('[data-path="' + g.k + '.' + (rows.length - 1) + '.' + g.cols[0].k + '"]'); if (el) el.focus(); } }, icon('plus', 14), 'Add line'));
  }

  function totalsBlock() {
    const t = () => S.applyTotals(s.col, JSON.parse(JSON.stringify(doc)), Cache.settings, Cache.byId('parties', doc.party));
    const line = (label, fn, cls) => { const v = h('span', { class: 'num' }); ctx.calcs.push({ el: v, fn }); return h('div', { class: 'tot-line ' + (cls || '') }, h('span', null, label), v); };
    const inter = () => S.isInterState(Cache.settings, Cache.byId('parties', doc.party), doc);
    const box = h('div', { class: 'totals' },
      line('Goods value', () => U.money(t().goodsValue)),
      line('Freight & other charges', () => U.money(S.num(doc.freight) + S.num(doc.otherCharges))),
      line('Less discount', () => U.money(-S.num(doc.discount))),
      line('Taxable value', () => U.money(t().taxable), 'sub'),
      line('CGST', () => inter() ? '—' : U.money(t().cgst)),
      line('SGST', () => inter() ? '—' : U.money(t().sgst)),
      line('IGST', () => inter() ? U.money(t().igst) : '—'),
      line('Round off', () => U.money(t().roundOff)),
      line('Grand total', () => '₹ ' + U.money(t().total), 'grand'),
      h('p', { class: 'tot-note' }, 'Freight and charges are taxed at the goods\' rate; the discount is taken off before GST.'));
    return h('div', { class: 'totals-row' }, box);
  }

  function buildBlocks() {
    return s.layout.map(b => {
      if (b.totals) return totalsBlock();
      if (b.grid) return h('section', { class: 'card' }, h('h3', null, b.grid.title), gridBlock(b.grid));
      return h('section', { class: 'card' }, b.title ? h('h3', null, b.title) : null, fieldsBlock(b));
    });
  }

  function validateForm() {
    const missing = [];
    for (const f of s.fields) if (f.req && isEmpty(doc[f.k]) && !(s.fixed && f.k in s.fixed)) missing.push(f.label);
    for (const g of s.grids) {
      const filled = doc[g.k].filter(r => r.item);
      filled.forEach((r) => { for (const c of g.cols) if (c.req && isEmpty(r[c.k])) missing.push(g.title + ' line ' + (doc[g.k].indexOf(r) + 1) + ': ' + c.label); });
    }
    return missing;
  }

  async function save(andNew) {
    const missing = validateForm();
    if (missing.length) { toast('Please fill: ' + missing.slice(0, 4).join(', ') + (missing.length > 4 ? '…' : ''), 'err'); return; }
    if (s.credit && doc.party) {
      const p = Cache.byId('parties', doc.party) || {};
      const limit = S.num(p.creditLimit);
      if (limit) {
        const r = await API.report('partyBalance', { party: doc.party });
        const total = S.applyTotals(s.col, JSON.parse(JSON.stringify(doc)), Cache.settings, p).total;
        const exposure = r.balance + (s.col === 'invoices' ? total - (original ? S.num(original.total) : 0) : total);
        if (exposure > limit && !(await confirmBox(p.name + ' will be at ₹ ' + U.money(exposure) + ', above the credit limit of ₹ ' + U.money(limit) + '. Save anyway?', 'Save anyway'))) return;
      }
    }
    const body = JSON.parse(JSON.stringify(doc));
    saveBtn.disabled = true;
    try {
      const saved = isNew ? await API.post('/api/' + s.col, body) : await API.put('/api/' + s.col + '/' + doc.id, body);
      Cache.invalidate(s.col);
      if (s.col === 'parties' || s.col === 'items') Cache.invalidate();
      toast('Saved' + (saved.no ? ' ' + saved.no : ''));
      const target = andNew ? '#/edit/' + key + '/new' : '#/edit/' + key + '/' + saved.id;
      if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = target;
    } catch (e) { toast(e.message, 'err'); }
    finally { saveBtn.disabled = false; }
  }

  async function remove() {
    if (!(await confirmBox('Delete this ' + s.singular.toLowerCase() + (doc.no ? ' ' + doc.no : '') + '? This cannot be undone.', 'Delete', true))) return;
    try { await API.del('/api/' + s.col + '/' + doc.id); Cache.invalidate(s.col); toast('Deleted'); location.hash = '#/list/' + key; }
    catch (e) { toast(e.message, 'err'); }
  }

  const saveBtn = h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save');
  const canEdit = Perm.can(s.area, 'edit') && Perm.can(S.areaOf(s.col, doc), 'edit');
  const canDelete = !isNew && canEdit && Perm.can(S.areaOf(s.col, doc), 'full') && !doc.system;
  ctx.readOnly = !canEdit;
  const title = (isNew ? 'New ' + s.singular.toLowerCase() : s.singular + ' ' + (doc.no || doc.name || doc.code || doc.username || ''));
  main.append(
    pageHead(title, s.note, [
      h('a', { class: 'btn ghost', href: '#/list/' + key }, icon('back', 16), s.title),
      !isNew && s.isDoc ? h('button', { class: 'btn', onclick: () => printDoc(s, doc) }, icon('print', 16), 'Print') : null,
      canDelete ? h('button', { class: 'btn danger-ghost', onclick: remove }, 'Delete') : null,
      canEdit ? h('button', { class: 'btn', onclick: () => save(true) }, 'Save & new') : null,
      canEdit ? saveBtn : h('span', { class: 'badge muted-b' }, 'View only'),
    ]),
    !isNew && (doc.updatedAt || doc.createdAt) ? h('p', { class: 'meta' }, 'Created ' + U.fmtDate(doc.createdAt) + ' by ' + (doc.createdBy || '?') + (doc.updatedAt ? ' · last edited ' + U.fmtDate(doc.updatedAt) + ' by ' + doc.updatedBy : '')) : null,
    form,
  );
  form.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); } });
  ctx.rerender();
  if (doc.party && s.fields.some(f => f.k === '_bal')) ctx.loadBalance();
  const first = form.querySelector('input:not([type=checkbox]), select, textarea');
  if (first && isNew) first.focus();
}

/* ================================================================== */
/* PRINT                                                               */
/* ================================================================== */

function amountInWords(n) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
  const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  n = Math.round(+n || 0);
  if (!n) return 'Zero';
  const parts = [];
  const cr = Math.floor(n / 1e7); n %= 1e7;
  const la = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1e3); n %= 1e3;
  if (cr) parts.push(three(cr) + ' Crore');
  if (la) parts.push(two(la) + ' Lakh');
  if (th) parts.push(two(th) + ' Thousand');
  if (n) parts.push(three(n));
  return parts.join(' ');
}

async function printDoc(s, doc) {
  const st = await Cache.getSettings();
  const esc = v => String(v === undefined || v === null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const money = v => U.money(v);
  const party = Cache.byId('parties', doc.party);
  const isTax = s.hasTotals;
  const isInvoice = s.col === 'invoices';
  const title = s.printTitle || s.singular.toUpperCase();
  const initials = (st.companyName || 'ERP').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const inter = isTax ? S.isInterState(st, party, doc) : false;
  const pos = doc.placeOfSupply || (party && party.state) || '';

  // ---- details box: number, date and every filled-in header field
  const skip = new Set(['party', 'remarks', 'terms', 'date', 'freight', 'otherCharges', 'discount', 'placeOfSupply']);
  const details = [[(s.singular === 'Invoice' ? 'Invoice' : s.singular) + ' no.', doc.no || ''], ['Date', U.fmtDate(doc.date)]];
  if (isTax && pos) details.push(['Place of supply', pos + (S.stateCode(pos) ? ' (' + S.stateCode(pos) + ')' : '')]);
  for (const f of s.fields) {
    if (['ro', 'calc', 'password'].includes(f.type) || skip.has(f.k) || isEmpty(doc[f.k]) || (s.fixed && f.k in s.fixed)) continue;
    if (f.k === 'amount' && !isTax) continue; // shown in the big amount box
    details.push([f.label.replace(/ \((optional|new)\)$/, ''), displayValue(f, doc[f.k])]);
  }
  const dl = rows => '<dl class="kv">' + rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>';

  const partyLabel = (s.fields.find(f => f.k === 'party') || {}).label || 'Party';
  const partyBox = party ? '<section class="box"><h3>' + (isInvoice ? 'Billed to' : esc(partyLabel)) + '</h3>' +
    '<div class="pname">' + esc(party.name) + '</div>' +
    '<div class="addr">' + [party.address, [party.city, party.state].filter(Boolean).join(', ')].filter(Boolean).map(esc).join('<br>') + '</div>' +
    dl([party.gstin ? ['GSTIN', party.gstin] : ['GSTIN', 'Unregistered'], party.state ? ['State code', S.stateCode(party.state) || '—'] : null, party.phone ? ['Phone', party.phone] : null].filter(Boolean)) +
    '</section>' : '';
  const detailBox = '<section class="box' + (party ? '' : ' wide') + '"><h3>' + esc(s.singular) + ' details</h3>' + dl(details) + '</section>';

  // ---- item tables: lot and HSN sit under the item name instead of extra columns
  const grids = s.grids.map(g => {
    const rows = (doc[g.k] || []).filter(r => r.item);
    if (!rows.length) return '';
    const cols = g.cols.filter(c => c.k !== 'lot' && c.k !== 'item');
    const numeric = c => !!c.fmt || c.type === 'number' || c.k === 'gst';
    const cell = (c, r) => {
      if (c.type === 'calc') { const v = c.value(r, doc); return c.fmt ? U.fmt(c.fmt, v) : esc(v); }
      if (c.k === 'gst') return isEmpty(r.gst) ? '' : esc(r.gst) + '%';
      return esc(displayValue(c, r[c.k]));
    };
    const desc = r => {
      const it = Cache.byId('items', r.item) || {};
      const sub = [isTax && it.hsn ? 'HSN ' + it.hsn : '', r.lot ? 'Lot ' + r.lot : '', it.code || ''].filter(Boolean).join(' · ');
      return '<div class="iname">' + esc(it.name || '') + '</div>' + (sub ? '<div class="isub">' + esc(sub) + '</div>' : '');
    };
    return (s.grids.length > 1 || !isTax ? '<h4>' + esc(g.title) + '</h4>' : '') +
      '<table class="items"><thead><tr><th class="c">#</th><th>Description</th>' + cols.map(c => '<th' + (numeric(c) ? ' class="n"' : '') + '>' + esc(c.label.replace(/ \(.*\)$/, '')) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map((r, i) => '<tr><td class="c">' + (i + 1) + '</td><td>' + desc(r) + '</td>' + cols.map(c => '<td' + (numeric(c) ? ' class="n"' : '') + '>' + cell(c, r) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>';
  }).join('');

  // ---- bottom: words / HSN / bank on the left, totals on the right
  let left = '', right = '';
  const line = (label, v, cls) => '<div class="tl ' + (cls || '') + '"><span>' + label + '</span><span>' + v + '</span></div>';
  if (isTax) {
    const hsn = {};
    for (const l of (doc.lines || []).filter(x => x.item)) {
      const it = Cache.byId('items', l.item) || {};
      const k = (it.hsn || '—') + '|' + S.num(l.gst);
      const e = hsn[k] || (hsn[k] = { hsn: it.hsn || '—', rate: S.num(l.gst), taxable: 0, tax: 0 });
      e.taxable += S.num(l.taxable !== undefined ? l.taxable : l.amount); e.tax += S.num(l.taxAmt);
    }
    left += '<section class="words"><h3>Amount in words</h3><p>Rupees ' + esc(amountInWords(doc.total)) + ' only</p></section>' +
      '<section class="hsn"><h3>Tax summary (HSN-wise)</h3><table><thead><tr><th>HSN</th><th class="n">Taxable</th><th class="n">Rate</th>' +
      (inter ? '<th class="n">IGST</th>' : '<th class="n">CGST</th><th class="n">SGST</th>') + '</tr></thead><tbody>' +
      Object.values(hsn).map(e => '<tr><td>' + esc(e.hsn) + '</td><td class="n">' + money(e.taxable) + '</td><td class="n">' + e.rate + '%</td>' +
        (inter ? '<td class="n">' + money(e.tax) + '</td>' : '<td class="n">' + money(e.tax / 2) + '</td><td class="n">' + money(e.tax / 2) + '</td>') + '</tr>').join('') +
      '</tbody></table><p class="note">' + (inter ? 'Inter-state supply: IGST charged.' : 'Intra-state supply: CGST + SGST charged.') + '</p></section>';
    if (isInvoice && st.bankDetails) left += '<section class="bank"><h3>Bank details for payment</h3><p>' + esc(st.bankDetails).replace(/\n/g, '<br>') + '</p></section>';
    right = '<section class="totals">' +
      line('Goods value', money(doc.goodsValue !== undefined ? doc.goodsValue : doc.taxable)) +
      (S.num(doc.freight) ? line('Freight', money(doc.freight)) : '') +
      (S.num(doc.otherCharges) ? line('Other charges', money(doc.otherCharges)) : '') +
      (S.num(doc.discount) ? line('Less discount', '− ' + money(doc.discount)) : '') +
      line('Taxable value', money(doc.taxable), 'strong') +
      (inter ? line('IGST', money(doc.igst)) : line('CGST', money(doc.cgst)) + line('SGST', money(doc.sgst))) +
      (S.num(doc.roundOff) ? line('Round off', money(doc.roundOff)) : '') +
      '<div class="grand"><span>Grand total</span><span>₹ ' + money(doc.total) + '</span></div></section>';
  } else if (S.num(doc.amount)) {
    left = '<section class="words"><h3>Amount in words</h3><p>Rupees ' + esc(amountInWords(doc.amount)) + ' only</p></section>';
    right = '<section class="totals"><div class="grand"><span>' + (s.col === 'receipts' ? 'Amount received' : 'Amount') + '</span><span>₹ ' + money(doc.amount) + '</span></div></section>';
  } else if (S.num(doc.total)) {
    right = '<section class="totals"><div class="grand"><span>Total value</span><span>₹ ' + money(doc.total) + '</span></div></section>';
  }
  const notes = (doc.remarks ? '<p><b>Remarks:</b> ' + esc(doc.remarks) + '</p>' : '') + (doc.terms ? '<p><b>Terms:</b> ' + esc(doc.terms) + '</p>' : '');

  const css = `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    :root { --ink: #1b2230; --muted: #667085; --line: #e3e6ec; --accent: #1f2f6b; --soft: #f1f3f9; }
    body { margin: 0; background: #e9ecf1; color: var(--ink); font: 12px/1.45 "Segoe UI", Arial, Helvetica, sans-serif; }
    .bar { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; justify-content: center; padding: 10px; background: #1b2230; color: #fff; font-size: 13px; z-index: 2; }
    .bar button, .bar select { font: inherit; border-radius: 6px; border: 0; padding: 6px 14px; cursor: pointer; }
    .bar button.primary { background: #4f6bdc; color: #fff; font-weight: 600; }
    .page { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; padding: 14mm 14mm 12mm; box-shadow: 0 6px 24px rgba(0,0,0,.12); display: flex; flex-direction: column; }
    header.top { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 14px; border-bottom: 2px solid var(--accent); }
    .brand { display: flex; gap: 12px; align-items: flex-start; }
    .mono { width: 44px; height: 44px; border-radius: 10px; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 17px; letter-spacing: .02em; flex: none; }
    .cname { font-size: 20px; font-weight: 700; letter-spacing: -.01em; line-height: 1.15; }
    .caddr { color: var(--muted); margin-top: 3px; }
    .doc { text-align: right; }
    .dtitle { color: var(--accent); font-weight: 700; letter-spacing: .12em; font-size: 15px; white-space: nowrap; }
    .brand { flex: 1 1 auto; min-width: 0; } .doc { flex: none; }
    .caddr b { color: var(--ink); font-weight: 600; }
    .dno { font-size: 22px; font-weight: 700; margin-top: 2px; }
    .ddate { color: var(--muted); }
    .copy { display: inline-block; white-space: nowrap; margin-top: 6px; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 1px 9px; }
    .boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
    .box { background: var(--soft); border-radius: 10px; padding: 11px 13px; }
    .box.wide { grid-column: 1 / -1; }
    .box.wide .kv { grid-template-columns: max-content 1fr max-content 1fr; }
    h3 { margin: 0 0 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
    h4 { margin: 14px 0 6px; font-size: 12px; }
    .pname { font-size: 14px; font-weight: 700; }
    .addr { color: #3d4555; margin: 2px 0 6px; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; }
    .kv dt { color: var(--muted); }
    .kv dd { margin: 0; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; }
    .items thead th { background: var(--accent); color: #fff; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; padding: 7px 8px; text-align: left; }
    .items thead th:first-child { border-radius: 6px 0 0 6px; } .items thead th:last-child { border-radius: 0 6px 6px 0; }
    .items td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    .items tbody tr:nth-child(even) td { background: #fafbfd; }
    .iname { font-weight: 600; }
    .isub { color: var(--muted); font-size: 10.5px; margin-top: 1px; }
    .n { text-align: right !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .c { text-align: center; color: var(--muted); width: 26px; }
    thead { display: table-header-group; } tr { break-inside: avoid; }
    .bottom { display: grid; grid-template-columns: 1fr 270px; gap: 18px; margin-top: 16px; align-items: start; break-inside: avoid; }
    .bottom > .left > section { margin-bottom: 12px; }
    .words p { margin: 0; font-weight: 600; }
    .hsn table th { font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); text-align: left; border-bottom: 1px solid var(--line); padding: 3px 6px 3px 0; font-weight: 600; }
    .hsn table td { padding: 3px 6px 3px 0; border-bottom: 1px solid var(--line); }
    .note { color: var(--muted); font-size: 10.5px; margin: 4px 0 0; }
    .bank p { margin: 0; }
    .totals { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .tl { display: flex; justify-content: space-between; padding: 6px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
    .tl span:first-child { color: var(--muted); }
    .tl.strong span { color: var(--ink); font-weight: 600; }
    .grand { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 11px 12px; background: var(--accent); color: #fff; font-weight: 700; }
    .grand span:last-child { font-size: 17px; font-variant-numeric: tabular-nums; }
    .notes { margin-top: 10px; } .notes p { margin: 0 0 4px; }
    footer { margin-top: auto; padding-top: 18px; display: grid; grid-template-columns: 1fr 220px; gap: 24px; align-items: end; break-inside: avoid; }
    .terms { color: var(--muted); font-size: 10.5px; }
    .terms b { color: var(--ink); }
    .sign { text-align: center; }
    .recv { color: var(--ink); font-size: 11px; max-width: 260px; }
    .recv .line { margin-top: 38px; border-top: 1px solid var(--ink); padding-top: 4px; color: var(--muted); text-align: center; }
    .sign .for { font-weight: 600; margin-bottom: 38px; }
    .sign .line { border-top: 1px solid var(--ink); padding-top: 4px; color: var(--muted); }
    .comp { grid-column: 1 / -1; text-align: center; color: #98a2b3; font-size: 9.5px; border-top: 1px solid var(--line); padding-top: 6px; }
    @media print { body { background: #fff; } .bar { display: none; } .page { margin: 0; width: auto; min-height: calc(297mm - 24mm); padding: 0; box-shadow: none; } }`;

  const copyLabels = ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title + ' ' + (doc.no || '')) + '</title><style>' + css + '</style></head><body>' +
    '<div class="bar"><button class="primary" onclick="window.print()">Print / Save as PDF</button>' +
    (isInvoice ? '<label>Copy: <select onchange="document.getElementById(\'copy\').textContent=this.value">' + copyLabels.map(c => '<option>' + c + '</option>').join('') + '</select></label>' : '') +
    '<button onclick="window.close()">Close</button></div>' +
    '<div class="page">' +
    '<header class="top"><div class="brand"><div class="mono">' + esc(initials) + '</div><div>' +
    '<div class="cname">' + esc(st.companyName) + '</div>' +
    '<div class="caddr">' + [st.address, [st.city, st.state].filter(Boolean).join(', ')].filter(Boolean).map(esc).join('<br>') + '</div>' +
    (st.gstin ? '<div class="caddr"><b>GSTIN ' + esc(st.gstin) + '</b>' + (st.state && S.stateCode(st.state) ? ' · State code ' + S.stateCode(st.state) : '') + '</div>' : '') +
    '<div class="caddr">' + [esc(st.phone || ''), esc(st.email || '')].filter(Boolean).join(' · ') + '</div>' +
    '</div></div>' +
    '<div class="doc"><div class="dtitle">' + esc(title) + '</div><div class="dno">' + esc(doc.no || '') + '</div><div class="ddate">' + esc(U.fmtDate(doc.date)) + '</div>' +
    (isInvoice ? '<div class="copy" id="copy">' + copyLabels[0] + '</div>' : '') + '</div></header>' +
    '<div class="boxes">' + partyBox + detailBox + '</div>' +
    grids +
    (left || right ? '<div class="bottom"><div class="left">' + left + '</div><div>' + right + '</div></div>' : '') +
    (notes ? '<div class="notes">' + notes + '</div>' : '') +
    '<footer><div class="terms">' + (isInvoice && st.invoiceTerms ? '<b>Terms &amp; conditions</b><br>' + esc(st.invoiceTerms) : '') +
    (s.col === 'deliveries' ? '<div class="recv"><div>Received the above goods in good condition.</div><div class="line">Receiver&#39;s signature &amp; stamp</div></div>' : '') + '</div>' +
    '<div class="sign"><div class="for">For ' + esc(st.companyName) + '</div><div class="line">Authorised signatory</div></div>' +
    '<div class="comp">This is a computer-generated document' + (isInvoice ? '. Thank you for your business.' : '.') + '</div></footer>' +
    '</div>' +
    '<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>';
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups for this site to print', 'err'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

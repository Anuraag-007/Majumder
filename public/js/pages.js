/* Dashboard, reports, settings. */
'use strict';

function pageHead(title, note, actions) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), note ? h('p', { class: 'note' }, note) : null),
    h('div', { class: 'actions' }, actions || []));
}
function renderDenied(main) { main.append(pageHead('No access', 'Your login does not have access to this screen. Ask the administrator to change your role if you need it.', [h('a', { class: 'btn', href: '#/dashboard' }, 'Go to home')])); }
function renderNotFound(main) { main.append(pageHead('Page not found', 'That screen does not exist.', [h('a', { class: 'btn', href: '#/dashboard' }, 'Go to dashboard')])); }

/* ================================================================== */
/* Dashboard                                                           */
/* ================================================================== */

// Links to the user's own entry screens and reports (department home page).
function homeLinks() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const sections = [];
  for (const g of NAV) {
    if (!g.kids) continue;
    const kids = g.kids.filter(([, t]) => Perm.target(t) && !(t === '#/settings'));
    if (!kids.length) continue;
    sections.push(h('section', { class: 'card' }, h('h3', null, icon(g.icon, 16), ' ', g.t),
      h('div', { class: 'home-links' }, kids.map(([label, t]) => {
        const s = t.startsWith('#') ? null : SCHEMAS[t];
        return h('div', { class: 'home-link' },
          h('a', { href: t.startsWith('#') ? t : '#/list/' + t }, label),
          s && s.isDoc && Perm.can(s.area, 'edit') ? h('a', { class: 'chip', href: '#/edit/' + t + '/new' }, icon('plus', 14), 'New') : null);
      }))));
  }
  void greet;
  return sections.length ? h('div', { class: 'hub' }, sections) : h('div', { class: 'banner warn' }, 'Your login has no screens assigned yet. Ask the administrator to set your role.');
}

/* ================================================================== */
/* Reports                                                             */
/* ================================================================== */

const FILTERS = {
  from: { p: 'from', label: 'From', type: 'date' },
  to: { p: 'to', label: 'To', type: 'date' },
  asOn: { p: 'asOn', label: 'As on', type: 'date' },
  location: { p: 'location', label: 'Location', type: 'ref', ref: 'locations' },
  category: { p: 'category', label: 'Category', type: 'select', options: S.CATEGORIES.map(c => [c, c]) },
  item: { p: 'item', label: 'Item', type: 'ref', ref: 'items' },
  fgItem: { p: 'item', label: 'Item', type: 'ref', ref: 'items', filter: i => i.category === 'Finished Goods' },
  supplier: { p: 'party', label: 'Supplier', type: 'ref', ref: 'parties', filter: p => S.partyIs(p, 'Supplier') },
  customer: { p: 'party', label: 'Customer', type: 'ref', ref: 'parties', filter: p => S.partyIs(p, 'Customer') },
  party: { p: 'party', label: 'Party', type: 'ref', ref: 'parties' },
  stage: { p: 'stage', label: 'Stage', type: 'select', options: S.STAGES.map(s => [s, s]) },
  stockGroup: { p: 'group', label: 'Show', type: 'select', options: [['lot', 'Lot-wise'], ['item', 'Item-wise']], noAll: true },
  groupBy: { p: 'groupBy', label: 'Group by', type: 'select', options: [['', 'Invoice lines'], ['party', 'Customer'], ['item', 'Item'], ['lot', 'Lot']], noAll: true },
  type: { p: 'type', label: 'Type', type: 'select', options: [['receivable', 'Receivables (customers)'], ['payable', 'Payables (suppliers)']], noAll: true },
  lot: { p: 'lot', label: 'Lot contains', type: 'text' },
  zero: { p: 'zero', label: 'Show zero stock', type: 'check' },
  all: { p: 'all', label: 'Include completed', type: 'check' },
};

function reportTable(t) {
  const cols = t.columns;
  const numeric = c => ['money', 'qty', 'int', 'pct'].includes(c.type);
  const sums = cols.map(c => c.sum ? t.rows.reduce((s, r) => s + (+r[c.k] || 0), 0) : null);
  const cell = (c, v) => {
    if (c.type === 'flag') return v ? h('span', { class: 'badge ' + (/over|overdue|below|short/i.test(v) ? 'bad' : /sold|closed/i.test(v) ? 'muted-b' : 'info') }, v) : '';
    return U.fmt(c.type, v);
  };
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data report' },
    h('thead', null, h('tr', null, cols.map(c => h('th', { class: numeric(c) ? 'num' : '' }, c.label)))),
    h('tbody', null, t.rows.length ? t.rows.map(r => h('tr', r._link ? { class: 'click', tabindex: 0, onclick: () => { location.hash = r._link; }, onkeydown: e => { if (e.key === 'Enter') location.hash = r._link; } } : null,
      cols.map(c => h('td', { class: numeric(c) ? 'num' : '' }, cell(c, r[c.k]))))) : h('tr', null, h('td', { colspan: cols.length || 1, class: 'empty' }, 'No data for these filters.'))),
    sums.some(x => x !== null) && t.rows.length > 1 ? h('tfoot', null, h('tr', null, cols.map((c, i) => h('td', { class: numeric(c) ? 'num' : '' }, i === 0 ? 'Total' : sums[i] === null ? '' : U.fmt(c.type, sums[i]))))) : null));
}

function toCsv(tables) {
  const q = v => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return tables.map(t => [t.title ? q(t.title) : null, t.columns.map(c => q(c.label)).join(','), ...t.rows.map(r => t.columns.map(c => q(r[c.k])).join(','))].filter(x => x !== null).join('\n')).join('\n\n');
}

async function renderReport(main, name, query) {
  const def = REPORTS[name];
  if (!def) return renderNotFound(main);
  if (!Perm.report(name)) return renderDenied(main);
  await Cache.load(['items', 'parties', 'locations', 'units']);
  const q = Object.assign({}, query);
  if (name === 'stock' && !q.group) q.group = 'lot';
  if (name === 'outstanding' && !q.type) q.type = 'receivable';

  const setQ = (p, v) => { if (v === '' || v === false) delete q[p]; else q[p] = v; history.replaceState(null, '', '#/report/' + name + U.qs(q)); load(); };
  const filterEl = key => {
    const f = FILTERS[key];
    let ctl;
    if (f.type === 'date') ctl = h('input', { type: 'date', value: q[f.p] || '', onchange: e => setQ(f.p, e.target.value) });
    else if (f.type === 'text') ctl = h('input', { type: 'text', value: q[f.p] || '', oninput: U.debounce(e => setQ(f.p, e.target.value.trim()), 300) });
    else if (f.type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!q[f.p], onchange: e => setQ(f.p, e.target.checked ? '1' : '') }), ' ' + f.label);
    else if (f.type === 'select') ctl = h('select', { onchange: e => setQ(f.p, e.target.value) }, f.noAll ? null : h('option', { value: '' }, 'All'), f.options.map(([v, l]) => h('option', { value: v, selected: (q[f.p] || '') === v }, l)));
    else {
      const opts = Cache.list(f.ref).filter(r => !f.filter || f.filter(r)).sort((a, b) => refLabel(f.ref, a).localeCompare(refLabel(f.ref, b)));
      ctl = h('select', { onchange: e => setQ(f.p, e.target.value) }, h('option', { value: '' }, name === 'stockLedger' || name === 'partyLedger' ? '— choose —' : 'All'), opts.map(r => h('option', { value: r.id, selected: q[f.p] === r.id }, refLabel(f.ref, r))));
    }
    return h('label', { class: 'filter' }, h('span', null, f.label), ctl);
  };

  const body = h('div');
  const titleEl = h('h1', null, def.title);
  const noteEl = h('p', { class: 'note' });
  let last = null;
  const presets = h('div', { class: 'presets' },
    def.filters.includes('from') ? [
      ['This month', U.monthStart(), U.today()],
      ['Last month', (() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 8) + '01'; })(), (() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 10); })()],
      ['This FY', (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return y + '-04-01'; })(), U.today()],
      ['All time', '', ''],
    ].map(([l, f, t]) => h('button', { class: 'chip', onclick: () => { if (f) q.from = f; else delete q.from; if (t) q.to = t; else delete q.to; location.hash = '#/report/' + name + U.qs(q); } }, l)) : null);

  async function load() {
    body.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const r = await API.report(name, q);
      last = r;
      titleEl.textContent = r.title || def.title;
      noteEl.textContent = r.note || '';
      const tables = r.tables || [{ columns: r.columns, rows: r.rows }];
      body.replaceChildren(...tables.map(t => h('section', { class: 'card flush' }, t.title ? h('h3', { class: 'pad' }, t.title) : null, t.columns.length ? reportTable(t) : h('p', { class: 'pad muted' }, r.note || 'Choose filters above.'))));
    } catch (e) { body.replaceChildren(h('div', { class: 'banner err' }, e.message)); }
  }

  main.append(
    h('div', { class: 'page-head' }, h('div', null, titleEl, noteEl), h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { if (last) U.download(name + '-' + U.today() + '.csv', toCsv(last.tables || [{ columns: last.columns, rows: last.rows }]), 'text/csv'); } }, icon('down', 16), 'Export CSV'),
      h('button', { class: 'btn', onclick: () => window.print() }, icon('print', 16), 'Print'))),
    def.filters.length ? h('div', { class: 'filters card' }, def.filters.map(filterEl), presets) : null,
    body);
  load();
}

function renderReportsHub(main) {
  const groups = {};
  for (const [k, r] of Object.entries(REPORTS)) if (Perm.report(k)) (groups[r.group] = groups[r.group] || []).push([k, r]);
  const extra = { Accounts: [['outstanding?type=payable', { title: 'Outstanding Payables' }]] };
  if (!Object.keys(groups).length) return renderDenied(main);
  main.append(pageHead('Reports & Analytics', 'All reports can be filtered, exported to CSV and printed.'),
    h('div', { class: 'hub' }, Object.entries(groups).map(([g, list]) => h('section', { class: 'card' }, h('h3', null, g),
      h('ul', { class: 'plain links' }, list.concat(extra[g] || []).map(([k, r]) => h('li', null, h('a', { href: '#/report/' + k }, r.title))),
        g === 'Inventory' && Perm.can('dashboard') ? h('li', null, h('a', { href: '#/dashboard' }, 'MIS Dashboard')) : null)))));
}

/* ================================================================== */
/* Settings                                                            */
/* ================================================================== */

async function renderSettings(main) {
  const st = Object.assign({}, await Cache.getSettings(true));
  const isAdmin = API.user.role === 'admin';
  const fld = (k, label, type, extra) => {
    let ctl;
    if (type === 'textarea') ctl = h('textarea', { rows: 2, value: st[k] || '', disabled: !isAdmin, oninput: e => { st[k] = e.target.value; } });
    else if (type === 'select') ctl = h('select', { disabled: !isAdmin, onchange: e => { st[k] = e.target.value; } }, extra.map(([v, l]) => h('option', { value: v, selected: st[k] === v }, l)));
    else if (type === 'check') return h('div', { class: 'field w2 checkfield' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st[k], disabled: !isAdmin, onchange: e => { st[k] = e.target.checked; } }), ' ' + label));
    else ctl = h('input', { type: 'text', value: st[k] || '', disabled: !isAdmin, oninput: e => { st[k] = e.target.value; } });
    return h('div', { class: 'field ' + (type === 'textarea' ? 'w4' : 'w2') }, h('span', { class: 'lbl' }, label), ctl);
  };

  const pw = { current: '', password: '' };
  const restoreInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!(await confirmBox('Replace ALL current data with this backup? A copy of the current data is kept on the server.', 'Restore', true))) return;
      await API.post('/api/restore', data);
      toast('Backup restored. Please sign in again.');
      API.setSession('', null); location.hash = '#/dashboard'; location.reload();
    } catch (err) { toast(err.message, 'err'); }
  } });

  main.append(
    pageHead('Settings & Backup', isAdmin ? 'Company details appear on printed invoices and documents.' : 'Only an administrator can change company settings.'),
    h('section', { class: 'card' }, h('h3', null, 'Company'),
      h('div', { class: 'fields' },
        fld('companyName', 'Company name'), fld('gstin', 'GSTIN'), fld('address', 'Address', 'textarea'), fld('city', 'City'), fld('state', 'State (for GST: same state = CGST+SGST)', 'select', Shared.STATE_NAMES.map(n => [n, n + ' (' + Shared.stateCode(n) + ')'])),
        fld('phone', 'Phone'), fld('email', 'Email'), fld('bankDetails', 'Bank details (printed on invoice)', 'textarea'), fld('invoiceTerms', 'Invoice terms', 'textarea'))),
    h('section', { class: 'card' }, h('h3', null, 'Inventory'),
      h('div', { class: 'fields' },
        fld('valuation', 'Store stock valuation', 'select', [['AVG', 'Weighted average'], ['FIFO', 'FIFO (first in, first out)']]),
        fld('allowNegativeStock', 'Allow entries that make stock negative (not recommended)', 'check'))),
    isAdmin ? h('div', { class: 'actions end' }, h('button', { class: 'btn primary', onclick: async () => { try { await API.put('/api/settings', st); await Cache.getSettings(true); toast('Settings saved'); } catch (e) { toast(e.message, 'err'); } } }, 'Save settings')) : null,
    h('section', { class: 'card' }, h('h3', null, 'Change my password'),
      h('div', { class: 'fields' },
        h('div', { class: 'field w1' }, h('span', { class: 'lbl' }, 'Current password'), h('input', { type: 'password', autocomplete: 'current-password', oninput: e => { pw.current = e.target.value; } })),
        h('div', { class: 'field w1' }, h('span', { class: 'lbl' }, 'New password (min 6)'), h('input', { type: 'password', autocomplete: 'new-password', oninput: e => { pw.password = e.target.value; } })),
        h('div', { class: 'field w1 bottom' }, h('button', { class: 'btn', onclick: async () => { try { await API.put('/api/me', pw); toast('Password changed'); } catch (e) { toast(e.message, 'err'); } } }, 'Change password')))),
    isAdmin ? h('section', { class: 'card' }, h('h3', null, 'Backup & data'),
      h('p', { class: 'muted' }, 'All data is stored in an SQLite database (data/erp.sqlite) on the server. Download a backup regularly. The backup file can be restored here; the database file opens in tools such as DB Browser for SQLite.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => {
          try {
            const res = await fetch('/api/backup', { headers: { Authorization: 'Bearer ' + API.token } });
            if (!res.ok) throw new Error('Backup failed');
            U.download('erp-backup-' + U.today() + '.json', await res.text(), 'application/json');
          } catch (e) { toast(e.message, 'err'); }
        } }, icon('down', 16), 'Download backup'),
        h('button', { class: 'btn', onclick: async () => {
          try {
            const res = await fetch('/api/backup?format=sqlite', { headers: { Authorization: 'Bearer ' + API.token } });
            if (!res.ok) throw new Error('Database download failed');
            const a = h('a', { href: URL.createObjectURL(await res.blob()), download: 'erp-' + U.today() + '.sqlite' });
            document.body.appendChild(a); a.click(); a.remove();
          } catch (e) { toast(e.message, 'err'); }
        } }, icon('down', 16), 'Download database (SQLite)'),
        h('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Restore from backup…'), restoreInput,
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmBox('Load sample items, parties and a full month of purchase → knitting → dyeing → finishing → sales entries? Only works on an empty database.', 'Load demo'))) return;
          try { await API.post('/api/demo'); Cache.invalidate(); toast('Demo data loaded'); location.hash = '#/dashboard'; } catch (e) { toast(e.message, 'err'); }
        } }, 'Load demo data'))) : null,
  );
}

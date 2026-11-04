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
  agency: { p: 'location', label: 'Agency / unit', type: 'ref', ref: 'locations', filter: l => !!l.party || ['Factory', 'Job Worker'].includes(l.type) },
  category: { p: 'category', label: 'Category', type: 'select', options: S.CATEGORIES.map(c => [c, c]) },
  item: { p: 'item', label: 'Item', type: 'ref', ref: 'items' },
  fgItem: { p: 'item', label: 'Item', type: 'ref', ref: 'items', filter: i => i.category === 'Finished Goods' },
  supplier: { p: 'party', label: 'Supplier', type: 'ref', ref: 'parties', filter: p => S.partyIs(p, 'Supplier') },
  customer: { p: 'party', label: 'Customer', type: 'ref', ref: 'parties', filter: p => S.partyIs(p, 'Customer') },
  party: { p: 'party', label: 'Party', type: 'ref', ref: 'parties' },
  stage: { p: 'stage', label: 'Stage', type: 'select', options: S.STAGES.map(s => [s, s]) },
  process: { p: 'stage', label: 'Process', type: 'select', options: S.STAGES.map(s => [s, S.STAGE_LABELS[s]]) },
  stockGroup: { p: 'group', label: 'Show', type: 'select', options: [['lot', 'Lot-wise'], ['item', 'Item-wise']], noAll: true },
  groupBy: { p: 'groupBy', label: 'Group by', type: 'select', options: [['', 'Invoice lines'], ['party', 'Customer'], ['item', 'Item'], ['lot', 'Lot']], noAll: true },
  type: { p: 'type', label: 'Type', type: 'select', options: [['receivable', 'Receivables (customers)'], ['payable', 'Payables (suppliers)']], noAll: true },
  lot: { p: 'lot', label: 'Lot contains', type: 'text' },
  zero: { p: 'zero', label: 'Show zero stock', type: 'check' },
  all: { p: 'all', label: 'Include completed', type: 'check' },
  godown: { p: 'location', label: 'Godown', type: 'ref', ref: 'locations', filter: l => S.isGodown(l) },
  customerPick: { p: 'party', label: 'Customer', type: 'ref', ref: 'parties', filter: p => S.partyIs(p, 'Customer'), choose: true },
  account: { p: 'account', label: 'Account', type: 'ref', ref: 'banks', allLabel: 'All accounts (balances)' },
  bankAccount: { p: 'account', label: 'Bank account', type: 'ref', ref: 'banks', filter: b => b.type === 'Bank', choose: true },
  anyBank: { p: 'account', label: 'Bank account', type: 'ref', ref: 'banks', filter: b => b.type === 'Bank' },
  expCategory: { p: 'category', label: 'Expense head', type: 'select', options: S.OVERHEAD_CATEGORIES.map(c => [c, c]) },
  month: { p: 'month', label: 'Month', type: 'month' },
  department: { p: 'department', label: 'Department', type: 'select', options: S.DEPARTMENTS.map(d => [d, d]) },
  partyType: { p: 'ptype', label: 'Type', type: 'select', options: S.PARTY_TYPES.map(t => [t, t]) },
  userName: { p: 'user', label: 'User name', type: 'text' },
  search: { p: 'q', label: 'Contains', type: 'text' },
};
// Colour of a status badge in a report, from its text.
function flagClass(v) {
  const t = String(v);
  if (/overdue|over limit|below|short|due today|check gstin|^🔴/i.test(t)) return 'bad';
  if (/due in|unpaid|part |part$|not yet|not cashed|^🟠|no date|^🟡/i.test(t)) return 'warn';
  if (/sold|closed|used up|lost/i.test(t)) return 'muted-b';
  if (/^paid|^🟢|^✅|completed|received|^cashed|^won|^ok$/i.test(t)) return 'ok';
  return 'info';
}

function reportTable(t) {
  const cols = t.columns;
  const numeric = c => ['money', 'qty', 'int', 'pct'].includes(c.type);
  const sums = cols.map(c => c.sum ? t.rows.reduce((s, r) => s + (+r[c.k] || 0), 0) : null);
  const cell = (c, v) => {
    if (c.type === 'flag') return v ? h('span', { class: 'badge ' + flagClass(v) }, v) : '';
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
  await Cache.load(['items', 'parties', 'locations', 'units', 'banks']);
  const q = Object.assign({}, query);
  if (name === 'stock' && !q.group) q.group = 'lot';
  if (name === 'outstanding' && !q.type) q.type = 'receivable';

  const setQ = (p, v) => { if (v === '' || v === false) delete q[p]; else q[p] = v; history.replaceState(null, '', '#/report/' + name + U.qs(q)); load(); };
  const filterEl = key => {
    const f = FILTERS[key];
    let ctl;
    if (f.type === 'date') ctl = h('input', { type: 'date', value: q[f.p] || '', onchange: e => setQ(f.p, e.target.value) });
    else if (f.type === 'month') ctl = h('input', { type: 'month', value: q[f.p] || '', onchange: e => setQ(f.p, e.target.value) });
    else if (f.type === 'text') ctl = h('input', { type: 'text', value: q[f.p] || '', oninput: U.debounce(e => setQ(f.p, e.target.value.trim()), 300) });
    else if (f.type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!q[f.p], onchange: e => setQ(f.p, e.target.checked ? '1' : '') }), ' ' + f.label);
    else if (f.type === 'select') ctl = h('select', { onchange: e => setQ(f.p, e.target.value) }, f.noAll ? null : h('option', { value: '' }, 'All'), f.options.map(([v, l]) => h('option', { value: v, selected: (q[f.p] || '') === v }, l)));
    else {
      const opts = Cache.list(f.ref).filter(r => !f.filter || f.filter(r)).sort((a, b) => refLabel(f.ref, a).localeCompare(refLabel(f.ref, b)));
      ctl = h('select', { onchange: e => setQ(f.p, e.target.value) }, h('option', { value: '' }, f.choose || name === 'stockLedger' || name === 'partyLedger' ? '— choose —' : f.allLabel || 'All'), opts.map(r => h('option', { value: r.id, selected: q[f.p] === r.id }, refLabel(f.ref, r))));
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
      // Optional headline figures above the tables.
      const cards = r.cards && r.cards.length ? h('div', { class: 'kpis' }, r.cards.map(c => h('div', { class: 'kpi' },
        h('span', { class: 'kpi-label' }, c.label), h('span', { class: 'kpi-value' }, c.type === 'money' ? U.rupee(c.value) : U.fmt(c.type, c.value)), c.sub ? h('span', { class: 'kpi-sub' }, c.sub) : null))) : null;
      body.replaceChildren(...[cards].concat(tables.map(t => h('section', { class: 'card flush' }, t.title ? h('h3', { class: 'pad' }, t.title) : null, t.columns.length ? reportTable(t) : h('p', { class: 'pad muted' }, r.note || 'Choose filters above.')))).filter(Boolean));
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
  const extra = { Accounts: [['outstanding?type=payable', { title: 'Outstanding Payables' }]], Inventory: [['stockMovement?category=Yarn', { title: 'Yarn Stock' }]] };
  if (!Object.keys(groups).length) return renderDenied(main);
  main.append(pageHead('Reports & Analytics', 'All reports can be filtered, exported to CSV and printed.'),
    h('div', { class: 'hub' }, Object.entries(groups).map(([g, list]) => h('section', { class: 'card' }, h('h3', null, g),
      h('ul', { class: 'plain links' }, list.concat(extra[g] || []).map(([k, r]) => h('li', null, h('a', { href: '#/report/' + k }, r.title))),
        g === 'Inventory' && Perm.can('dashboard') ? h('li', null, h('a', { href: '#/dashboard' }, 'MIS Dashboard')) : null)))));
}

/* ================================================================== */
/* Approvals                                                           */
/* ================================================================== */

// Changes and deletions staff asked for (Settings → Approvals). Approvers decide; others see their own.
async function renderApprovals(main) {
  const canDecide = API.isAdmin || Perm.can('approvals', 'view');
  const body = h('div');
  const load = async () => {
    const list = await API.get('/api/approvals');
    const pend = list.filter(a => a.status === 'Pending'), done = list.filter(a => a.status !== 'Pending');
    const keyOf = col => Object.keys(SCHEMAS).find(k => SCHEMAS[k].col === col && !SCHEMAS[k].fixed) || Object.keys(SCHEMAS).find(k => SCHEMAS[k].col === col);
    const docLink = a => h('a', { href: '#/edit/' + keyOf(a.col) + '/' + a.docId }, a.label);
    const decide = async (a, ok) => {
      let reason = '';
      if (!ok) { const r = await promptBox('Reason for rejecting (optional)', ''); if (r === null) return; reason = r; }
      try { await API.post('/api/approvals/' + a.id + '/' + (ok ? 'approve' : 'reject'), { reason }); toast(ok ? 'Approved: the change is made' : 'Rejected'); Cache.invalidate(); load(); }
      catch (e) { toast(e.message, 'err'); }
    };
    const table = (rows, open) => h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, ['Asked', 'By', 'Entry', 'Wants to', 'What changes'].concat(open ? (canDecide ? [''] : []) : ['Decision', 'By', 'Reason']).map(t => h('th', null, t)))),
      h('tbody', null, rows.length ? rows.map(a => h('tr', null,
        h('td', null, U.fmtDateTime(a.at)), h('td', null, a.by), h('td', null, docLink(a)), h('td', null, a.action === 'delete' ? h('span', { class: 'badge bad' }, 'Delete') : 'Change'), h('td', { class: 'wrap' }, a.summary),
        open ? (canDecide ? h('td', { class: 'actions' }, h('button', { class: 'btn small primary', onclick: () => decide(a, true) }, 'Approve'), h('button', { class: 'btn small danger-ghost', onclick: () => decide(a, false) }, 'Reject')) : null)
          : [h('td', null, h('span', { class: 'badge ' + (a.status === 'Approved' ? 'ok' : 'bad') }, a.status)), h('td', null, a.decidedBy || ''), h('td', null, a.reason || '')]))
        : h('tr', null, h('td', { colspan: 8, class: 'empty' }, open ? 'Nothing is waiting for approval.' : 'No decisions yet.')))));
    body.replaceChildren(
      h('section', { class: 'card flush' }, h('h3', { class: 'pad' }, 'Waiting (' + pend.length + ')'), table(pend, true)),
      h('section', { class: 'card flush' }, h('h3', { class: 'pad' }, 'Decided'), table(done.slice(0, 100), false)));
  };
  main.append(pageHead('Approvals', canDecide
    ? 'Changes and deletions of saved entries that staff asked for. Approving makes the change exactly as they entered it. Turn approval on or off in Settings.'
    : 'Changes and deletions you asked for, and what the administrator decided.'), body);
  await load();
}

/* ================================================================== */
/* Settings                                                            */
/* ================================================================== */

async function renderSettings(main) {
  const st = Object.assign({}, await Cache.getSettings(true));
  await Cache.load(['banks']);
  const isAdmin = API.user.role === 'admin';
  const fld = (k, label, type, extra) => {
    let ctl;
    if (type === 'textarea') ctl = h('textarea', { rows: 2, value: st[k] || '', disabled: !isAdmin, oninput: e => { st[k] = e.target.value; } });
    else if (type === 'select') ctl = h('select', { disabled: !isAdmin, onchange: e => { st[k] = e.target.value; } }, extra.map(([v, l]) => h('option', { value: v, selected: st[k] === v }, l)));
    else if (type === 'check') return h('div', { class: 'field w2 checkfield' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st[k], disabled: !isAdmin, onchange: e => { st[k] = e.target.checked; } }), ' ' + label));
    else if (type === 'date') ctl = h('input', { type: 'date', value: st[k] || '', disabled: !isAdmin, onchange: e => { st[k] = e.target.value; } });
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
        fld('allowNegativeStock', 'Allow entries that make stock negative (not recommended)', 'check'),
        fld('lotPattern', 'Lot number format: # = running number, {YYYY} = year (L-#### gives L-0001; MH-{YYYY}-### gives MH-2026-001, from 001 each year). Existing lots keep their numbers.'),
        fld('rollKg', 'Average roll weight (kg), to estimate kg from rolls where the lot has no average yet (orders, quotations)'),
        fld('weighRolls', "Finished rolls are weighed one by one (type each roll's weight on finishing). Leave unticked when rolls are only counted: rolls then go out with the kg at each lot's average (1000 kg in 300 rolls: 100 kg = 30 rolls).", 'check'))),
    h('section', { class: 'card' }, h('h3', null, 'Bank & cash'),
      h('div', { class: 'fields' },
        fld('defaultBank', 'Receipts, payments and expenses saved without an account (for example before the bank accounts were set up) count in', 'select',
          [['', '— not assigned —']].concat(Cache.list('banks').filter(b => b.type === 'Bank').map(b => [b.id, b.name]))))),
    h('section', { class: 'card' }, h('h3', null, 'Approvals'),
      h('div', { class: 'fields' },
        fld('approveChanges', 'Staff changes and deletions of saved entries (bills, invoices, payments, stock and production entries) wait for an administrator\'s approval. Staff can still correct entries they made the same day.', 'check'))),
    h('section', { class: 'card' }, h('h3', null, 'Labour payable'),
      h('div', { class: 'fields' },
        fld('labourFrom', 'Count labour payable from (labour and payments before this date are treated as settled)', 'date'))),
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

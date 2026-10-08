/*
 * End-to-end test: every department logs in and does its own part of one full
 * production cycle through the real screens, starting from an empty database.
 *
 *   node tests/e2e.js
 *
 * Needs Node.js 22+ (for the built-in WebSocket) and Google Chrome or Microsoft Edge.
 * Uses a throwaway database in the temp folder; your real data/ is never touched.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-e2e-'));
const SHOTS = path.join(WORK, 'screenshots');
fs.mkdirSync(SHOTS);
const PORT = 3997, CDP_PORT = 9337;
const BASE = 'http://localhost:' + PORT + '/';
const TODAY = new Date().toISOString().slice(0, 10);

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserPath = process.env.BROWSER || BROWSERS.find(p => fs.existsSync(p));
if (!browserPath) { console.error('Chrome or Edge not found. Set BROWSER=<path to chrome>'); process.exit(2); }
if (typeof WebSocket === 'undefined') { console.error('Node.js 22 or newer is needed to run this test.'); process.exit(2); }

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: path.join(WORK, 'data'), PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
const browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + path.join(WORK, 'profile'), '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

/* ---------------- CDP plumbing ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, msgId = 0;
const pending = new Map(), jsErrors = [];
const send = (method, params) => new Promise((res, rej) => { const i = ++msgId; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
const J = JSON.stringify;
async function waitFor(expr, ms) { const t = Date.now(); while (Date.now() - t < (ms || 6000)) { if (await ev(expr)) return true; await sleep(80); } return false; }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64')); }

// Helpers injected into every page load.
const PAGE_HELPERS = `window.T = {
  lbl(f) { const l = f.querySelector('.lbl'); return l ? l.textContent.replace('*', '').trim() : ''; },
  field(label) { const fs = [...document.querySelectorAll('.form .field')]; return fs.find(f => T.lbl(f) === label) || fs.find(f => T.lbl(f).startsWith(label)); },
  set(el, val) {
    if (el.tagName === 'SELECT') {
      const opts = [...el.options];
      const o = opts.find(o => o.value === val) || opts.find(o => o.textContent.includes(val));
      if (!o) throw new Error('No option "' + val + '" in: ' + opts.map(o => o.textContent).join(' | '));
      el.value = o.value; el.dispatchEvent(new Event('change')); return o.textContent;
    }
    el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); return val;
  },
  fill(label, val) { const f = T.field(label); if (!f) throw new Error('No field "' + label + '"'); return T.set(f.querySelector('select, input, textarea'), String(val)); },
  get(label) { const f = T.field(label); if (!f) throw new Error('No field "' + label + '"'); const el = f.querySelector('select, input, textarea'); return el ? el.value : f.querySelector('.calc, .ro').textContent; },
  grid(gi, row, col, val) {
    const g = document.querySelectorAll('.form table.grid')[gi];
    const hs = [...g.querySelectorAll('thead th')].map(t => t.textContent.replace('*', '').trim());
    let c = hs.indexOf(col); if (c < 0) c = hs.findIndex(t => t.startsWith(col)); if (c < 0) throw new Error('No column "' + col + '"');
    const tr = g.querySelectorAll('tbody tr')[row]; if (!tr) throw new Error('No line ' + (row + 1));
    const el = tr.cells[c].querySelector('select, input');
    if (val === undefined) return el ? el.value : tr.cells[c].textContent;
    return T.set(el, String(val));
  },
  rows(gi) { return document.querySelectorAll('.form table.grid')[gi].querySelectorAll('tbody tr').length; },
  addLine(gi) { document.querySelectorAll('.form .grid-wrap')[gi].querySelector(':scope > button').click(); },
  btn(text) { const b = [...document.querySelectorAll('.page-head button, .page-head a.btn')].find(b => b.textContent.trim() === text); if (!b) throw new Error('No button "' + text + '"'); b.click(); },
  h1() { const e = document.querySelector('.view h1'); return e ? e.textContent : ''; },
  settled() { return !!document.querySelector('.view h1') && !document.querySelector('.view .loading'); },
  toastErr() { const e = document.querySelector('.toast.err'); return e ? e.textContent : ''; },
  api(url) { return fetch(url, { headers: { Authorization: 'Bearer ' + API.token } }).then(r => r.json()); },
  status(method, url, body) { return fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API.token }, body: body ? JSON.stringify(body) : undefined }).then(r => r.status); },
  async go(hash) { location.hash = hash; await new Promise(r => setTimeout(r, 30)); for (let i = 0; i < 200 && !T.settled(); i++) await new Promise(r => setTimeout(r, 25)); await new Promise(r => setTimeout(r, 40)); return T.h1(); },
};`;

/* ---------------- test bookkeeping ---------------- */
const results = [];
let section = '';
function begin(name) { section = name; console.log('\n' + name); }
function ok(cond, msg) { results.push({ section, pass: !!cond, msg }); console.log((cond ? '  PASS ' : '  FAIL ') + msg); }
async function step(msg, fn) {
  try { const r = await fn(); ok(r !== false, msg + (typeof r === 'string' && r ? ' → ' + r : '')); return r; }
  catch (e) { ok(false, msg + ' → ' + e.message); return false; }
}
const near = (a, b) => Math.abs(a - b) < 0.02;

/* ---------------- UI actions ---------------- */
async function go(hash) { return ev('T.go(' + J(hash) + ')'); }
// Sign out the way a person does: open the app, click "Sign out" if someone is signed in,
// then wait for the sign-in screen. (Wiping storage + reload raced with the page loading.)
async function signOutPage() {
  await send('Page.navigate', { url: BASE });
  const signOut = `document.querySelector('.side-foot [aria-label="Sign out"]')`;
  await waitFor(`document.readyState === 'complete' && !!window.T && (!!document.querySelector('.login-card') || !!${signOut})`, 10000);
  if (await ev(`!!${signOut}`)) await ev(`${signOut}.click()`);
  if (!(await waitFor(`!!document.querySelector('.login-card')`, 10000))) throw new Error('sign-in screen did not appear after signing out');
}
async function login(user, pass) {
  await signOutPage();
  await waitFor(`!!document.querySelector('.login-card')`);
  await ev(`(() => { const i = document.querySelectorAll('.login-card input'); i[0].value = ${J(user)}; i[0].dispatchEvent(new Event('input')); i[1].value = ${J(pass)}; i[1].dispatchEvent(new Event('input')); document.querySelector('.login-card button').click(); })()`);
  if (!(await waitFor(`!!document.querySelector('.side') && T.settled()`))) throw new Error('login failed: ' + await ev(`(document.querySelector('.login-err') || {}).textContent || ''`));
  return ev(`API.user.roleName`);
}
async function openNew(key) { const h = await go('#/edit/' + key + '/new'); if (!/^New /.test(h)) throw new Error('could not open new ' + key + ': ' + h); await sleep(150); }
const fill = (label, val) => ev(`T.fill(${J(label)}, ${J(String(val))})`).then(r => sleep(120).then(() => r));
const grid = (gi, row, col, val) => ev(`T.grid(${gi}, ${row}, ${J(col)}${val === undefined ? '' : ', ' + J(String(val))})`).then(r => sleep(100).then(() => r));
const get = label => ev(`T.get(${J(label)})`);
async function addLine(gi) { await ev(`T.addLine(${gi || 0})`); await sleep(120); }
async function save(confirmLabel) {
  await ev(`document.getElementById('toasts').innerHTML = ''`);
  const before = await ev('location.hash');
  await ev(`T.btn('Save')`);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (confirmLabel && await ev(`!!document.querySelector('.modal')`)) { await ev(`[...document.querySelectorAll('.modal button')].find(b => b.textContent === ${J(confirmLabel)}).click()`); confirmLabel = null; }
    const err = await ev('T.toastErr()');
    if (err) throw new Error('save refused: ' + err);
    const h = await ev('location.hash');
    if (h !== before && !h.endsWith('/new') && await ev(`T.settled() && !/^New /.test(T.h1())`)) return ev('T.h1()');
    await sleep(80);
  }
  throw new Error('save timed out');
}
async function saveExpectError() {
  await ev(`document.getElementById('toasts').innerHTML = ''`);
  await ev(`T.btn('Save')`);
  if (!(await waitFor(`!!T.toastErr()`, 5000))) throw new Error('expected the save to be refused, but it was accepted');
  return ev('T.toastErr()');
}
const api = url => ev(`T.api(${J(url)})`);

/* ---------------- access matrix ---------------- */
// For every screen and report: the menu, the screen itself and the server must all agree with the role.
async function accessMatrix() {
  return ev(`(async () => {
    const me = await T.api('/api/me');
    const can = (a, l) => me.isAdmin || (!!a && a !== 'admin' && Shared.levelAtLeast(me.perms[a], l)) || (!a);
    const navLinks = new Set([...document.querySelectorAll('.nav a[data-match]')].map(a => a.dataset.match.split('?')[0]));
    const problems = []; let checks = 0; const visible = []; const editable = [];
    for (const [k, s] of Object.entries(SCHEMAS)) {
      const view = can(s.area, 'view'), edit = can(s.area, 'edit');
      const h = await T.go('#/list/' + k);
      const shown = h !== 'No access';
      const newBtn = !!document.querySelector('.page-head a.btn.primary');
      const status = await T.status('POST', '/api/' + s.col, Object.assign({}, s.fixed || {}));
      const serverEdit = status !== 403;
      checks += 3;
      if (shown !== view) problems.push(k + ': screen ' + (shown ? 'opens' : 'blocked') + ' but role says ' + (view ? 'view' : 'no access'));
      if (shown && newBtn !== edit) problems.push(k + ': New button ' + (newBtn ? 'shown' : 'hidden') + ' but role edit=' + edit);
      if (serverEdit !== edit) problems.push(k + ': server ' + (serverEdit ? 'accepts' : 'refuses') + ' writes (HTTP ' + status + ') but role edit=' + edit);
      if (view) visible.push(k); if (edit) editable.push(k);
    }
    for (const [k] of Object.entries(REPORTS)) {
      const allowed = can(Shared.REPORT_AREA[k], 'view');
      const h = await T.go('#/report/' + k);
      const status = await T.status('GET', '/api/report/' + k);
      checks += 2;
      if ((h !== 'No access') !== allowed) problems.push('report ' + k + ': screen disagrees with role');
      if ((status === 200) !== allowed) problems.push('report ' + k + ': server HTTP ' + status + ' but role allowed=' + allowed);
    }
    await T.go('#/dashboard');
    const hasKpis = !!document.querySelector('.hero-card');
    checks++;
    if (hasKpis !== can('dashboard', 'view')) problems.push('dashboard: KPIs ' + (hasKpis ? 'shown' : 'hidden') + ' but role dashboard=' + can('dashboard', 'view'));
    const leaked = [...navLinks].filter(t => t.startsWith('#/list/') && !can(SCHEMAS[t.slice(7)].area, 'view'));
    if (leaked.length) problems.push('menu shows forbidden screens: ' + leaked.join(', '));
    return { problems, checks, visible, editable, role: me.user.roleName };
  })()`);
}

// What each department must (yes) and must not (no) be able to open. Written by hand, independent of the role table.
const SPOT = {
  purchase: { yes: ['purchaseOrders', 'purchaseBills', 'items', 'parties', 'boms'], no: ['knitting', 'dyeing', 'invoices', 'receipts', 'users'] },
  store: { yes: ['grn', 'yarnIssue', 'stockAdjust'], no: ['knitting', 'invoices', 'purchaseBills', 'payments'] },
  knitting: { yes: ['knitting', 'greyTransfer'], no: ['dyeing', 'finishing', 'invoices', 'grn', 'yarnIssue', 'purchaseOrders'] },
  dyeing: { yes: ['dyeing'], no: ['knitting', 'finishing', 'invoices', 'purchaseOrders', 'receipts'] },
  finishing: { yes: ['finishing'], no: ['knitting', 'dyeing', 'invoices', 'grn'] },
  sales: { yes: ['salesOrders', 'deliveries', 'invoices', 'priceList', 'customers'], no: ['knitting', 'purchaseBills', 'payments', 'overheads'] },
  accounts: { yes: ['receipts', 'payments', 'purchaseBills', 'overheads', 'invoices'], no: ['knitting', 'dyeing', 'finishing', 'users', 'roles'] },
  manager: { yes: ['invoices', 'knitting', 'dyeing', 'grn', 'overheads', 'receipts'], no: ['users', 'roles'] },
};

async function checkAccess(dept) {
  let m;
  try { m = await accessMatrix(); } catch (e) { ok(false, 'access matrix could not run → ' + e.message); return; }
  ok(!m.problems.length, 'access matrix: menu, screens and server agree on ' + m.checks + ' checks' + (m.problems.length ? ' → ' + m.problems.join('; ') : ''));
  const spot = SPOT[dept];
  if (spot) {
    const wrongYes = spot.yes.filter(k => !m.visible.includes(k));
    const wrongNo = spot.no.filter(k => m.visible.includes(k));
    ok(!wrongYes.length && !wrongNo.length, 'department boundaries: can open ' + spot.yes.join(', ') + '; cannot open ' + spot.no.join(', ') + (wrongYes.length || wrongNo.length ? ' → wrong: ' + wrongYes.concat(wrongNo).join(', ') : ''));
  }
  return m;
}

/* ---------------- the scenario ---------------- */
const USERS = [
  ['purchase1', 'Purchase Department', 'purchase'], ['store1', 'Store / Inventory', 'store'], ['knitting1', 'Knitting Department', 'knitting'],
  ['dyeing1', 'Dyeing / Color Department', 'dyeing'], ['finishing1', 'Finishing & Packing', 'finishing'], ['sales1', 'Sales Department', 'sales'],
  ['accounts1', 'Finance & Accounts', 'accounts'], ['manager1', 'Management', 'manager'],
];
const PASS = 'pass123';

async function run() {
  begin('0. Setup');
  await step('server and browser start', async () => {
    let targets;
    for (let i = 0; i < 80; i++) { try { targets = await (await fetch('http://localhost:' + CDP_PORT + '/json')).json(); if (targets.find(t => t.type === 'page')) break; } catch (e) { /* wait */ } await sleep(150); }
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', m => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
      if (d.method === 'Runtime.exceptionThrown') jsErrors.push(section + ': ' + (d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text).split('\n')[0]);
    });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE)).ok) return 'empty database at ' + WORK; } catch (e) { /* wait */ } await sleep(150); }
    throw new Error('server did not start: ' + serverLog);
  });

  /* ---- Admin ---- */
  begin('1. Administrator: create one login per department');
  await step('admin signs in with default password', () => login('admin', 'admin123'));
  await step('9 ready-made department roles exist', async () => { const r = await api('/api/roles'); return r.length === 9 ? r.map(x => x.name).join(', ') : false; });
  for (const [u, roleName] of USERS) {
    await step('create user ' + u + ' (' + roleName + ')', async () => {
      await openNew('users');
      await fill('Username', u); await fill('Full name', roleName + ' user'); await fill('Password', PASS); await fill('Role / department', roleName);
      return save();
    });
  }
  await step('wrong password is refused', async () => {
    await signOutPage(); await waitFor(`!!document.querySelector('.login-card')`);
    await ev(`(() => { const i = document.querySelectorAll('.login-card input'); i[0].value = 'store1'; i[0].dispatchEvent(new Event('input')); i[1].value = 'nope'; i[1].dispatchEvent(new Event('input')); document.querySelector('.login-card button').click(); })()`);
    await waitFor(`!!document.querySelector('.login-err').textContent`);
    return ev(`document.querySelector('.login-err').textContent`);
  });

  /* ---- Purchase ---- */
  begin('2. Purchase Department: masters, recipe, purchase order');
  await step('signs in', () => login('purchase1', PASS));
  const items = [
    ['Y30', 'Cotton Yarn 30s', 'Yarn', 'Kg - ', 5, 250], ['DRED', 'Reactive Red', 'Dyes & Chemicals', 'Kg - ', 18, 500], ['SODA', 'Soda Ash', 'Dyes & Chemicals', 'Kg - ', 18, 40],
    ['POLY', 'Poly Bag', 'Packing Material', 'Nos - ', 18, 5], ['GSJ', 'Grey Single Jersey', 'Grey Fabric', 'Kg - ', 5, 0], ['CSJ', 'Dyed Single Jersey', 'Colored Fabric', 'Kg - ', 5, 0],
    ['FSJ', 'Finished Single Jersey', 'Finished Goods', 'Kg - ', 5, 400],
  ];
  for (const [code, name, cat, unit, gst, rate] of items) {
    await step('add item ' + code + ' - ' + name + ' (' + cat + ')', async () => {
      await openNew('items');
      await fill('Item code', code); await fill('Item name', name); await fill('Category', cat); await fill('Unit', unit); await fill('GST %', gst); await fill('Standard rate (₹)', rate);
      return save();
    });
  }
  await step('duplicate item name is refused', async () => { await openNew('items'); await fill('Item name', 'cotton yarn 30s'); await fill('Category', 'Yarn'); await fill('Unit', 'Kg - '); return saveExpectError(); });
  await step('add supplier Shree Mills', async () => { await openNew('parties'); await fill('Party name', 'Shree Mills'); await fill('Type', 'Supplier'); await fill('State', 'West Bengal'); return save(); });
  await step('add dye recipe (BOM): Red = 0.02 kg dye + 0.1 kg soda per kg', async () => {
    await openNew('boms');
    await fill('Recipe name', 'Red Recipe'); await fill('Stage', 'Dyeing');
    await grid(0, 0, 'Item', 'DRED'); await grid(0, 0, 'Qty per kg', 0.02);
    await addLine(0); await grid(0, 1, 'Item', 'SODA'); await grid(0, 1, 'Qty per kg', 0.1);
    return save();
  });
  await step('purchase order with 4 items; rate and GST fill in from the item master', async () => {
    await openNew('purchaseOrders');
    await fill('Supplier', 'Shree Mills');
    const lines = [['Y30', 1000], ['DRED', 20], ['SODA', 100], ['POLY', 50]];
    for (let i = 0; i < lines.length; i++) { if (i) await addLine(0); await grid(0, i, 'Item', lines[i][0]); await grid(0, i, 'Qty', lines[i][1]); }
    const autoRate = await grid(0, 0, 'Rate'), autoGst = await grid(0, 0, 'GST %');
    if (autoRate !== '250' || autoGst !== '5') throw new Error('auto-fill gave rate ' + autoRate + ', GST ' + autoGst);
    await shot('02-purchase-order');
    return save();
  });
  await step('PO total = 2,64,250 + GST 15,065 = 2,79,315 (CGST+SGST, same state)', async () => {
    const po = (await api('/api/purchaseOrders'))[0];
    return po.taxable === 264250 && po.tax === 15065 && po.total === 279315 && po.cgst === 7532.5 && po.igst === 0 ? po.no : false;
  });
  await checkAccess('purchase');

  /* ---- Store ---- */
  begin('3. Store / Inventory: goods receipt and yarn issue');
  await step('signs in', () => login('store1', PASS));
  await step('GRN against PO-0001 loads the 4 pending lines; yarn gets batch YB-1', async () => {
    await openNew('grn');
    await fill('Supplier', 'Shree Mills'); await fill('Against PO', 'PO-0001');
    const n = await ev('T.rows(0)'); if (n !== 4) throw new Error(n + ' lines loaded');
    await grid(0, 0, 'Lot / Batch', 'YB-1'); await fill('Supplier challan no', 'CH-55');
    return save();
  });
  await step('Main Store now holds 1000 kg yarn in batch YB-1', async () => { const s = await api('/api/report/stock?location=STORE'); const y = s.rows.find(r => r.item === 'Cotton Yarn 30s'); return y && y.qty === 1000 && y.lot === 'YB-1' && y.value === 250000; });
  await step('issuing 2000 kg yarn (more than stock) is refused', async () => {
    await openNew('yarnIssue');
    await grid(0, 0, 'Item', 'Y30'); await grid(0, 0, 'Yarn lot', 'YB-1'); await grid(0, 0, 'Qty', 2000);
    return saveExpectError();
  });
  await step('issue 600 kg yarn YB-1 to Knitting Factory', async () => {
    await openNew('yarnIssue');
    await grid(0, 0, 'Item', 'Y30'); await grid(0, 0, 'Yarn lot', 'YB-1'); await grid(0, 0, 'Qty', 600);
    return save();
  });
  await checkAccess('store');

  /* ---- Purchase bill ---- */
  begin('4. Purchase Department: supplier bill against GRN');
  await step('signs in', () => login('purchase1', PASS));
  await step('bill SM/101 against GRN-0001 copies lines with GST', async () => {
    await openNew('purchaseBills');
    await fill('Supplier', 'Shree Mills'); await fill('Supplier bill no', 'SM/101'); await fill('Against GRN', 'GRN-0001');
    return save();
  });
  await step('bill total 2,79,315', async () => { const b = (await api('/api/purchaseBills'))[0]; return b.total === 279315 ? b.no : false; });

  /* ---- Accounts: payment ---- */
  begin('5. Finance & Accounts: supplier payment');
  await step('signs in', () => login('accounts1', PASS));
  await step('pay Shree Mills 1,00,000; form shows current balance first', async () => {
    await openNew('payments');
    await fill('Supplier', 'Shree Mills');
    await waitFor(`/Cr/.test(T.get('Current balance'))`);
    const bal = await get('Current balance');
    await fill('Amount (₹)', 100000); await fill('Mode', 'Bank Transfer'); await fill('Cheque / UTR no', 'NEFT-1');
    await save();
    return 'balance was ' + bal;
  });

  /* ---- Knitting ---- */
  begin('6. Knitting Department: knitting production and grey transfer');
  await step('signs in', () => login('knitting1', PASS));
  await step('home page shows knitting analytics only, with no money figures', async () => {
    await waitFor(`!!document.querySelector('.dept-section') || !!document.querySelector('.banner.err')`);
    const r = await ev(`({ sections: [...document.querySelectorAll('.dept-head h2')].map(x => x.textContent), charts: document.querySelectorAll('.dept-section .csvg, .dept-section .hbars, .dept-section .cempty').length, rupee: [...document.querySelectorAll('.dept-section')].some(x => x.innerText.includes('₹')), hero: !!document.querySelector('.hero-card') })`);
    if (r.sections.join() !== 'Knitting' || !r.charts || r.rupee || r.hero) throw new Error(JSON.stringify(r));
    return r.sections.join();
  });
  await step('new knitting entry proposes lot L-0001 and labour rate ₹8/kg', async () => {
    await openNew('knitting');
    const lot = await get('Lot no (new)'), rate = await get('Labour rate (₹/kg)');
    return lot === 'L-0001' && rate === '8' ? lot : false;
  });
  await step('600 kg yarn → 585 kg grey; wastage (15 kg) and labour (₹4,680) fill in automatically', async () => {
    await grid(0, 0, 'Item', 'Y30'); await grid(0, 0, 'Yarn lot', 'YB-1'); await grid(0, 0, 'Qty', 600);
    await fill('Grey fabric produced', 'GSJ'); await fill('Output qty (kg)', 585); await fill('Rolls', 25); await fill('GSM', 160);
    const w = await get('Wastage qty (kg)'), l = await get('Labour amount (₹)');
    if (w !== '15' || l !== '4680') throw new Error('wastage ' + w + ', labour ' + l);
    await shot('06-knitting');
    return save();
  });
  await step('transfer grey lot L-0001 (585 kg, 25 rolls) to Color Factory', async () => {
    await openNew('greyTransfer');
    await grid(0, 0, 'Item', 'GSJ'); await grid(0, 0, 'Lot', 'L-0001'); await grid(0, 0, 'Qty', 585); await grid(0, 0, 'Rolls', 25); await fill('Vehicle no', 'WB-11-1234');
    return save();
  });
  await checkAccess('knitting');

  /* ---- Dyeing ---- */
  begin('7. Dyeing / Color Department: dyeing batch');
  await step('signs in', () => login('dyeing1', PASS));
  await step('picking lot L-0001 fills 585 kg; Red recipe fills 11.7 kg dye + 58.5 kg soda', async () => {
    await openNew('dyeing');
    await fill('Grey fabric', 'GSJ'); await fill('Grey lot', 'L-0001');
    const q = await get('Input qty (kg)');
    await fill('Dye recipe (BOM)', 'Red Recipe');
    const a = await grid(0, 0, 'Qty'), b = await grid(0, 1, 'Qty');
    if (q !== '585' || a !== '11.7' || b !== '58.5') throw new Error('input ' + q + ', dye ' + a + ', soda ' + b);
    return 'ok';
  });
  await step('585 kg grey → 570 kg red; wastage 15 kg, labour ₹8,775 (585 × 15)', async () => {
    await fill('Color', 'Red'); await fill('Colored fabric produced', 'CSJ'); await fill('Output qty (kg)', 570);
    const w = await get('Wastage qty (kg)'), l = await get('Labour amount (₹)');
    if (w !== '15' || l !== '8775') throw new Error('wastage ' + w + ', labour ' + l);
    await shot('07-dyeing');
    return save();
  });
  await checkAccess('dyeing');

  /* ---- Finishing ---- */
  begin('8. Finishing & Packing: finish and pack into finished goods');
  await step('signs in', () => login('finishing1', PASS));
  await step('570 kg dyed → 560 kg finished (24 rolls, 2200 m) using 24 poly bags', async () => {
    await openNew('finishing');
    await fill('Colored fabric', 'CSJ'); await fill('Lot', 'L-0001');
    if (await get('Input qty (kg)') !== '570') throw new Error('input qty not filled');
    await grid(0, 0, 'Item', 'POLY'); await grid(0, 0, 'Qty', 24);
    await fill('Finished goods produced', 'FSJ'); await fill('Output qty (kg)', 560); await fill('Rolls', 24); await fill('Meters', 2200);
    const w = await get('Wastage qty (kg)'), l = await get('Labour amount (₹)');
    if (w !== '10' || l !== '3360') throw new Error('wastage ' + w + ', labour ' + l);
    return save();
  });
  await checkAccess('finishing');

  /* ---- Accounts: overhead ---- */
  begin('9. Finance & Accounts: monthly overhead');
  await step('signs in', () => login('accounts1', PASS));
  await step('power bill ₹11,200 (absorbed at ₹20/kg over the 560 kg finished)', async () => {
    await openNew('overheads');
    await fill('Category', 'Utilities (Power/Water)'); await fill('Amount (₹)', 11200); await fill('Paid to', 'CESC');
    return save();
  });

  /* ---- Sales ---- */
  begin('10. Sales Department: customers, price list, order, challan, invoices');
  await step('signs in', () => login('sales1', PASS));
  await step('add customer Kolkata Garments (West Bengal, credit limit 1,00,000)', async () => {
    await openNew('customers'); await fill('Party name', 'Kolkata Garments'); await fill('State', 'West Bengal'); await fill('Credit limit (₹)', 100000); await fill('Credit days', 30);
    return save();
  });
  await step('add customer Odisha Traders (Odisha → IGST)', async () => { await openNew('customers'); await fill('Party name', 'Odisha Traders'); await fill('State', 'Odisha'); return save(); });
  await step('party price: Kolkata Garments pays ₹420/kg for FSJ', async () => {
    await openNew('priceList'); await fill('Customer', 'Kolkata Garments'); await fill('Item', 'FSJ'); await fill('Rate (₹/kg)', 420);
    return save();
  });
  await step('sales order 300 kg; rate 420 comes from the party price list; ₹1,32,300 > limit so a credit warning appears', async () => {
    await openNew('salesOrders'); await fill('Customer', 'Kolkata Garments');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Qty', 300);
    const r = await grid(0, 0, 'Rate'); if (r !== '420') throw new Error('rate ' + r);
    return save('Save anyway');
  });
  await step('delivery challan against SO-0001 loads 300 kg; dispatch lot L-0001, 13 rolls', async () => {
    await openNew('deliveries'); await fill('Customer', 'Kolkata Garments'); await fill('Against sales order', 'SO-0001');
    if (await grid(0, 0, 'Qty') !== '300') throw new Error('pending qty not loaded');
    await grid(0, 0, 'Lot', 'L-0001'); await grid(0, 0, 'Rolls', 13); await fill('Vehicle no', 'WB-19-9999');
    return save();
  });
  await step('invoice against DC-0001 → credit limit warning appears, confirmed', async () => {
    await openNew('invoices'); await fill('Customer', 'Kolkata Garments'); await fill('Against challan', 'DC-0001');
    await shot('10-invoice');
    return save('Save anyway');
  });
  await step('invoice INV-0001: 1,26,000 + CGST 3,150 + SGST 3,150 = 1,32,300', async () => {
    const i = (await api('/api/invoices')).find(x => x.no === 'INV-0001');
    return i.taxable === 126000 && i.cgst === 3150 && i.sgst === 3150 && i.igst === 0 && i.total === 132300;
  });
  await step('direct invoice to Odisha: 100 kg @430 → IGST 2,150, total 45,150', async () => {
    await openNew('invoices'); await fill('Customer', 'Odisha Traders');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Lot', 'L-0001'); await grid(0, 0, 'Qty', 100); await grid(0, 0, 'Rate', 430);
    await save();
    const i = (await api('/api/invoices')).find(x => x.no === 'INV-0002');
    return i.igst === 2150 && i.cgst === 0 && i.total === 45150 ? i.no : false;
  });
  await step('selling 500 kg more than the 160 kg left is refused', async () => {
    await openNew('invoices'); await fill('Customer', 'Odisha Traders');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Lot', 'L-0001'); await grid(0, 0, 'Qty', 500);
    return saveExpectError();
  });
  await checkAccess('sales');

  /* ---- Accounts: receipt ---- */
  begin('11. Finance & Accounts: customer receipt');
  await step('signs in', () => login('accounts1', PASS));
  await step('receive ₹50,000 from Kolkata Garments', async () => {
    await openNew('receipts'); await fill('Customer', 'Kolkata Garments'); await fill('Amount received (₹)', 50000); await fill('Mode', 'UPI');
    return save();
  });
  await checkAccess('accounts');

  /* ---- Management ---- */
  begin('12. Management: dashboard and every report, numbers checked');
  await step('signs in and sees the MIS dashboard', async () => { await login('manager1', PASS); return ev(`!!document.querySelector('.hero-card')`); });
  await shot('12-dashboard');
  // Expected lot cost, worked out by hand:
  //   yarn 600 × 250 = 1,50,000   dyes 11.7 × 500 + 58.5 × 40 = 8,190   packing 24 × 5 = 120
  //   labour 4,680 + 8,775 + 3,360 = 16,815   overhead 11,200   → total 1,86,325 for 560 kg
  const TOTAL = 186325, KG = 560;
  const cost = await api('/api/report/costing');
  const row = cost.rows[0] || {};
  await step('lot L-0001 total cost = ₹1,86,325 (material + labour + overhead + wastage)', () => { if (!near(row.total, TOTAL)) throw new Error('got ' + row.total); return '₹' + row.total; });
  await step('cost per kg = ₹332.72, per roll = ₹7,763.54, per meter = ₹84.69', () => near(row.perKg, 332.72) && near(row.perRoll, 7763.54) && near(row.perMeter, 84.69));
  // Knitting/dyeing labour spent on fabric later lost as waste moves into the wastage bucket; finishing labour, packing and overhead arrive whole.
  await step('finishing labour ₹3,360, packing ₹120 and overhead ₹11,200 reach the lot in full', () => near(row.finLabour, 3360) && near(row.packing, 120) && near(row.overhead, 11200));
  await step('all labour (₹16,815) is accounted for: in the lot or in its wastage cost', () => row.knitLabour + row.dyeLabour + row.finLabour < 16815 && row.knitLabour + row.dyeLabour + row.finLabour > 16815 * 0.95);
  await step('wastage cost is part of the total, not added twice', () => near(row.yarn + row.dyes + row.packing + row.knitLabour + row.dyeLabour + row.finLabour + row.overhead + row.wastage, TOTAL));
  await step('wastage report: 15 + 15 + 10 kg across the three stages', async () => { const w = await api('/api/report/wastage'); const s = w.tables[0].rows; return s.length === 3 && s.reduce((a, r) => a + r.qty, 0) === 40; });
  await step('lot tracking: L-0001 yarn 600 → FG 560 (yield 93.33%), 400 kg sold, 160 kg in stock', async () => {
    const l = (await api('/api/report/lots')).rows[0];
    return l.yarnIn === 600 && l.fgOut === 560 && l.yieldPct === 93.33 && l.sold === 400 && l.inStock === 160 ? l.status : false;
  });
  await step('stock: 400 kg yarn in store, 0 in process, 160 kg finished goods worth ₹53,235.71', async () => {
    const s = (await api('/api/report/stock')).rows;
    const y = s.find(r => r.item === 'Cotton Yarn 30s' && r.location === 'Main Store');
    const fg = s.find(r => r.location === 'Finished Goods Store');
    const wip = s.filter(r => ['Knitting Factory', 'Color Factory'].includes(r.location));
    return y.qty === 400 && fg.qty === 160 && near(fg.value, TOTAL / KG * 160) && !wip.length;
  });
  await step('store chemicals left: dye 8.3 kg, soda 41.5 kg, poly bags 26', async () => {
    const s = (await api('/api/report/stock?location=STORE')).rows;
    const q = n => (s.find(r => r.item === n) || {}).qty;
    return q('Reactive Red') === 8.3 && q('Soda Ash') === 41.5 && q('Poly Bag') === 26;
  });
  await step('profitability: sales ₹1,69,000 − cost ₹1,33,089.29 = profit ₹35,910.71', async () => {
    const p = (await api('/api/report/profitability')).rows;
    const sale = p.reduce((a, r) => a + r.sale, 0), c = p.reduce((a, r) => a + r.cost, 0);
    return near(sale, 169000) && near(c, TOTAL / KG * 400) ? 'margin ' + (((sale - c) / sale) * 100).toFixed(2) + '%' : false;
  });
  await step('receivables: Kolkata ₹82,300 (back under its ₹1,00,000 limit after the receipt), Odisha ₹45,150', async () => {
    const r = (await api('/api/report/outstanding?type=receivable')).rows;
    const k = r.find(x => x.party === 'Kolkata Garments'), o = r.find(x => x.party === 'Odisha Traders');
    return k.balance === 82300 && !/Over limit/.test(k.alert) && o.balance === 45150;
  });
  await step('payables: Shree Mills ₹1,79,315', async () => { const r = (await api('/api/report/outstanding?type=payable')).rows; return r[0].party === 'Shree Mills' && r[0].balance === 179315; });
  await step('GST: output ₹8,450 − input ₹15,065 = −₹6,615 (credit)', async () => { const g = (await api('/api/report/gst')).rows[0]; return near(g.net, 8450 - 15065); });
  await step('pending sales order: nothing pending (300 of 300 dispatched)', async () => (await api('/api/report/soPending')).rows.length === 0);
  await step('dashboard shows 0 open sales orders once fully dispatched', async () => (await api('/api/report/dashboard')).kpi.pendingSO === 0);
  await step('pending purchase: none (all received)', async () => (await api('/api/report/poPending')).rows.length === 0);
  await step('party ledger for Kolkata ends at ₹82,300 Dr', async () => {
    const p = (await api('/api/parties')).find(x => x.name === 'Kolkata Garments');
    const l = await api('/api/report/partyLedger?party=' + p.id); const last = l.rows[l.rows.length - 1];
    return last.balance === 82300 && last.drcr === 'Dr';
  });
  await step('no stock exceptions anywhere', async () => (await api('/api/report/negativeStock')).rows.length === 0);
  await step('every report page opens without errors', async () => {
    const bad = await ev(`(async () => { const bad = []; for (const k of Object.keys(REPORTS)) { await T.go('#/report/' + k); await new Promise(r => setTimeout(r, 250)); if (document.querySelector('.banner.err')) bad.push(k); } return bad; })()`);
    return bad.length ? false : Object.keys(await ev('REPORTS')).length + ' reports';
  });
  await go('#/report/costing'); await sleep(400); await shot('12-costing');
  await checkAccess('manager');

  /* ---- Guard rails ---- */
  begin('13. Guard rails');
  await step('manager cannot open user management', async () => (await go('#/list/users')) === 'No access');
  await step('knitting login cannot open an invoice even by typing its address', async () => {
    await login('knitting1', PASS);
    return (await go('#/edit/invoices/' + 'x')) === 'No access';
  });
  await step('admin cannot delete a GRN that is billed and whose yarn has been used', async () => {
    await login('admin', 'admin123');
    const g = (await api('/api/grn'))[0];
    const st = await ev(`fetch('/api/grn/${g.id}', { method: 'DELETE', headers: { Authorization: 'Bearer ' + API.token } }).then(r => r.json())`);
    return /Not enough stock|Cannot delete/.test(st.error) ? st.error : false;
  });
  await step('admin cannot delete an item that is in use', async () => {
    const i = (await api('/api/items')).find(x => x.code === 'Y30');
    const st = await ev(`fetch('/api/items/${i.id}', { method: 'DELETE', headers: { Authorization: 'Bearer ' + API.token } }).then(r => r.json())`);
    return /Cannot delete/.test(st.error) ? st.error : false;
  });
  await step('deactivated user can no longer sign in', async () => {
    const u = (await api('/api/users')).find(x => x.username === 'store1');
    await ev(`fetch('/api/users/${u.id}', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API.token }, body: JSON.stringify(Object.assign(${J(u)}, { active: false })) }).then(r => r.status)`);
    try { await login('store1', PASS); return false; } catch (e) { return 'refused'; }
  });
  await step('phone-width layout has no sideways scrolling', async () => {
    await login('manager1', PASS);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await go('#/dashboard'); await sleep(500);
    const wide = await ev('document.documentElement.scrollWidth > window.innerWidth + 1');
    await shot('13-phone');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return !wide;
  });

  begin('14. Browser errors');
  ok(!jsErrors.length, 'no JavaScript errors in any department session' + (jsErrors.length ? ' → ' + jsErrors.slice(0, 5).join(' | ') : ''));
}

run().catch(e => ok(false, 'test crashed: ' + e.stack)).finally(() => {
  const sections = [...new Set(results.map(r => r.section))];
  console.log('\n================ SUMMARY ================');
  for (const s of sections) {
    const rs = results.filter(r => r.section === s);
    const f = rs.filter(r => !r.pass).length;
    console.log((f ? 'FAIL ' : 'PASS ') + s.padEnd(66) + (rs.length - f) + '/' + rs.length);
  }
  const failed = results.filter(r => !r.pass).length;
  console.log('-----------------------------------------');
  console.log(failed ? failed + ' of ' + results.length + ' checks FAILED' : 'ALL ' + results.length + ' CHECKS PASSED');
  console.log('Screenshots: ' + SHOTS);
  fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 1));
  try { ws.close(); } catch (e) { /* ignore */ }
  browser.kill(); server.kill();
  process.exitCode = failed ? 1 : 0;
});

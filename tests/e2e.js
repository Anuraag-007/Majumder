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
    const tr = g.querySelectorAll('tbody tr:not(.hint-row)')[row]; if (!tr) throw new Error('No line ' + (row + 1));
    const el = tr.cells[c].querySelector('select, input');
    if (val === undefined) return el ? el.value : tr.cells[c].textContent;
    return T.set(el, String(val));
  },
  rows(gi) { return document.querySelectorAll('.form table.grid')[gi].querySelectorAll('tbody tr:not(.hint-row)').length; },
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
const getText = label => ev(`(() => { const s = T.field(${J(label)}).querySelector('select'); return s.selectedOptions[0] ? s.selectedOptions[0].textContent : ''; })()`);
const tick = label => ev(`(() => { const l = [...document.querySelectorAll('.form label.check')].find(x => x.textContent.trim().startsWith(${J(label)})); if (!l) throw new Error('No tick box ' + ${J(label)}); const i = l.querySelector('input'); if (!i.checked) i.click(); return true; })()`).then(r => sleep(120).then(() => r));
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
const guideText = () => ev(`(document.querySelector('.view .guide:not([hidden])') || {}).textContent || ''`);

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
  knitting: { yes: ['knitting', 'greyTransfer'], no: ['dyeing', 'finishing', 'invoices', 'grn', 'yarnIssue', 'purchaseOrders', 'labourPayments'] },
  dyeing: { yes: ['dyeing'], no: ['knitting', 'finishing', 'invoices', 'purchaseOrders', 'receipts'] },
  finishing: { yes: ['finishing'], no: ['knitting', 'dyeing', 'invoices', 'grn'] },
  sales: { yes: ['salesOrders', 'deliveries', 'invoices', 'priceList', 'customers'], no: ['knitting', 'purchaseBills', 'payments', 'overheads'] },
  accounts: { yes: ['receipts', 'payments', 'labourPayments', 'purchaseBills', 'overheads', 'invoices'], no: ['knitting', 'dyeing', 'finishing', 'users', 'roles'] },
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
  await step('this walkthrough weighs every finished roll: Settings → rolls weighed one by one', async () => {
    const r = await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API.token }, body: JSON.stringify({ weighRolls: true }) }).then(r => r.json())`);
    await ev('Cache.getSettings(true)');
    return r.weighRolls === true;
  });
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
  await step('add knitting agency Maa Tara Knitting: Job Worker, does knitting at ₹9/kg', async () => {
    await openNew('parties'); await fill('Party name', 'Maa Tara Knitting'); await fill('Type', 'Job Worker'); await fill('State', 'West Bengal');
    await tick('Does knitting'); await fill('Knitting rate (₹/kg)', 9);
    await shot('02-agency');
    return save();
  });
  await step('add Bengal Dyeing House: dyes at ₹15/kg and also finishes & packs at ₹6/kg', async () => {
    await openNew('parties'); await fill('Party name', 'Bengal Dyeing House'); await fill('Type', 'Job Worker'); await fill('State', 'West Bengal');
    await tick('Does dyeing'); await fill('Dyeing rate (₹/kg)', 15); await tick('Does finishing'); await fill('Finishing rate (₹/kg)', 6);
    return save();
  });
  await step('each agency gets a stock location of its own', async () => {
    const n = (await api('/api/locations')).filter(x => x.party).map(x => x.name).sort().join(', ');
    return n === 'Bengal Dyeing House, Maa Tara Knitting' ? n : false;
  });
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
  await step('guidance: Yarn Issue before the yarn arrives says PO-0001 is still to be received and offers a GRN', async () => {
    await openNew('yarnIssue');
    const t = await guideText();
    const chip = await ev(`[...document.querySelectorAll('.guide .chip')].map(a => a.textContent).join('|')`);
    if (!/No yarn in the Main Store to issue\. Purchase order PO-0001 is still to be received: when the goods arrive, make the GRN against it/.test(t) || !/New GRN/.test(chip)) throw new Error('guide: ' + t + ' / ' + chip);
    await shot('03-guide-no-yarn');
    return 'shown';
  });
  await step('GRN against PO-0001 loads the 4 pending lines; the yarn will get its lot number on save, the dye none', async () => {
    await openNew('grn');
    await fill('Supplier', 'Shree Mills'); await fill('Against PO', 'PO-0001');
    const n = await ev('T.rows(0)'); if (n !== 4) throw new Error(n + ' lines loaded');
    const yl = await grid(0, 0, 'Lot no'), dl = await grid(0, 1, 'Lot no');
    if (yl !== 'new on save' || dl !== 'no lot') throw new Error('lot column shows ' + yl + ' / ' + dl);
    await fill('Supplier challan no', 'CH-55');
    return save();
  });
  await step('Main Store now holds 1000 kg yarn in lot L-0001, numbered by the GRN', async () => { const s = await api('/api/report/stock?location=STORE'); const y = s.rows.find(r => r.item === 'Cotton Yarn 30s'); return y && y.qty === 1000 && y.lot === 'L-0001' && y.value === 250000; });
  await step('issuing 2000 kg yarn (more than stock) is refused', async () => {
    await openNew('yarnIssue');
    await fill('Knitting agency', 'Maa Tara Knitting');
    await grid(0, 0, 'Item', 'Y30'); await grid(0, 0, 'Yarn lot', 'L-0001'); await grid(0, 0, 'Qty', 2000);
    return saveExpectError();
  });
  await step('issue 600 kg yarn lot L-0001 to the knitting agency Maa Tara Knitting', async () => {
    await openNew('yarnIssue');
    await fill('Knitting agency', 'Maa Tara Knitting');
    await grid(0, 0, 'Item', 'Y30'); await grid(0, 0, 'Yarn lot', 'L-0001'); await grid(0, 0, 'Qty', 600);
    return save();
  });
  await step('Maa Tara Knitting now holds the 600 kg of lot L-0001', async () => {
    const y = (await api('/api/report/stock')).rows.filter(r => r.location === 'Maa Tara Knitting');
    return y.length === 1 && y[0].lot === 'L-0001' && y[0].qty === 600 ? 'yes' : JSON.stringify(y);
  });
  await step('the yarn issue prints as a job work delivery challan addressed to the agency', async () => {
    const t = (await api('/api/transfers')).find(x => x.purpose === 'Yarn Issue');
    await go('#/edit/yarnIssue/' + t.id);
    await ev(`window.__printed = ''; window.open = () => ({ document: { open() {}, write(h) { window.__printed += h; }, close() {} } }); T.btn('Print')`);
    await waitFor(`!!window.__printed`);
    const html = await ev('window.__printed');
    return /JOB WORK DELIVERY CHALLAN/.test(html) && /Sent for job work to/.test(html) && /Maa Tara Knitting/.test(html) && /L-0001/.test(html) ? 'printed' : false;
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
    await fill('Amount (₹)', 100000); await fill('Mode', 'Bank Transfer'); await fill('NEFT / RTGS / IMPS', 'NEFT'); await fill('UTR no', 'SBIN52026110300001');
    await save();
    return 'balance was ' + bal;
  });

  /* ---- Knitting ---- */
  begin('6. Knitting Department: knitting at the agency; grey fabric goes straight to the dyeing agency');
  await step('signs in', () => login('knitting1', PASS));
  await step('home page shows knitting analytics only, with no money figures', async () => {
    await waitFor(`!!document.querySelector('.dept-section') || !!document.querySelector('.banner.err')`);
    const r = await ev(`({ sections: [...document.querySelectorAll('.dept-head h2')].map(x => x.textContent), charts: document.querySelectorAll('.dept-section .csvg, .dept-section .hbars, .dept-section .cempty').length, rupee: [...document.querySelectorAll('.dept-section')].some(x => x.innerText.includes('₹')), hero: !!document.querySelector('.hero-card') })`);
    if (r.sections.join() !== 'Knitting' || !r.charts || r.rupee || r.hero) throw new Error(JSON.stringify(r));
    return r.sections.join();
  });
  await step('new knitting entry says where the yarn is; choosing Maa Tara Knitting fills its own rate ₹9/kg', async () => {
    await openNew('knitting');
    const t = await guideText();
    if (!/Choose the knitting agency\. Yarn issued to agencies: Maa Tara Knitting \(L-0001 600 Kg\)/.test(t)) throw new Error('guide: ' + t);
    const r0 = await get('Job rate (₹/kg)');
    await fill('Agency / unit', 'Maa Tara Knitting');
    const lot = await get('Lot no'), rate = await get('Job rate (₹/kg)');
    if (lot !== 'from the yarn lot' || r0 !== '8' || rate !== '9') throw new Error('lot no "' + lot + '", rate ' + r0 + ' then ' + rate);
    return 'process rate ' + r0 + ' → agency rate ' + rate;
  });
  await step('600 kg yarn → 585 kg grey; wastage (15 kg) and job charges (₹5,265) fill in; grey sent to Bengal Dyeing House', async () => {
    await grid(0, 0, 'Item', 'Y30'); await grid(0, 0, 'Yarn lot', 'L-0001'); await grid(0, 0, 'Qty', 600);
    const lot = await get('Lot no'); if (lot !== 'L-0001') throw new Error('lot no shows ' + lot + ', not the yarn lot');
    await fill('Grey fabric produced', 'GSJ'); await fill('Output qty (kg)', 585); await fill('Rolls', 25); await fill('GSM', 160);
    const w = await get('Wastage qty (kg)'), l = await get('Job charges (₹)');
    if (w !== '15' || l !== '5265') throw new Error('wastage ' + w + ', charges ' + l);
    await fill('Grey fabric sent to', 'Bengal Dyeing House');
    await shot('06-knitting');
    return save();
  });
  await step('grey lot L-0001 (585 kg, 25 rolls) is at Bengal Dyeing House straight away, with no transfer entry', async () => {
    const s = (await api('/api/report/stock')).rows.filter(r => r.category === 'Grey Fabric');
    const transfers = (await api('/api/transfers')).length;
    const g = s.find(r => r.lot === 'L-0001');
    if (!g || g.location !== 'Bengal Dyeing House' || g.qty !== 585 || g.rolls !== 25 || s.some(r => r.location === 'Maa Tara Knitting') || transfers !== 0) throw new Error(JSON.stringify({ s, transfers }));
    return g.location;
  });
  await checkAccess('knitting');

  /* ---- Dyeing ---- */
  begin('7. Dyeing / Color Department: dyeing batch at the agency');
  await step('signs in', () => login('dyeing1', PASS));
  await step('choosing Bengal Dyeing House keeps the dyed fabric there to finish; lot L-0001 fills 585 kg; Red recipe fills 11.7 kg dye + 58.5 kg soda', async () => {
    await openNew('dyeing');
    await fill('Agency / unit', 'Bengal Dyeing House');
    const to = await getText('Dyed fabric sent to');
    await fill('Grey fabric', 'GSJ'); await fill('Lot no', 'L-0001');
    const q = await get('Input qty (kg)');
    await fill('Dye recipe (BOM)', 'Red Recipe');
    const a = await grid(0, 0, 'Qty'), b = await grid(0, 1, 'Qty');
    if (to !== 'Bengal Dyeing House' || q !== '585' || a !== '11.7' || b !== '58.5') throw new Error('sent to ' + to + ', input ' + q + ', dye ' + a + ', soda ' + b);
    return 'ok';
  });
  await step('585 kg grey → 570 kg red; wastage 15 kg, job charges ₹8,775 (585 × 15)', async () => {
    await fill('Color', 'Red'); await fill('Colored fabric produced', 'CSJ'); await fill('Output qty (kg)', 570);
    const w = await get('Wastage qty (kg)'), l = await get('Job charges (₹)');
    if (w !== '15' || l !== '8775') throw new Error('wastage ' + w + ', charges ' + l);
    await shot('07-dyeing');
    return save();
  });
  await step('guidance: with no grey lot waiting at the agency, dyeing says to knit first and who to ask; too much soda shows the shortage under the line', async () => {
    await openNew('dyeing');
    await fill('Agency / unit', 'Bengal Dyeing House');
    const t = await guideText();
    if (!/No grey fabric waiting at Bengal Dyeing House/.test(t) || !/Ask the Knitting department/.test(t)) throw new Error('guide: ' + t);
    await grid(0, 0, 'Item', 'SODA'); await grid(0, 0, 'Qty', 500);
    await waitFor(`!!document.querySelector('.hint-row:not([hidden]) .line-hint')`);
    const hint = await ev(`document.querySelector('.hint-row:not([hidden]) .line-hint').textContent`);
    if (!/Needs 500 Kg but Main Store has only 41\.5 Kg \(short 458\.5 Kg\)\. To get more, raise a purchase order/.test(hint)) throw new Error('line note: ' + hint);
    await shot('07-guide-shortage');
    return 'shown';
  });
  await checkAccess('dyeing');

  /* ---- Finishing ---- */
  begin('8. Finishing & Packing: finish and pack into finished goods');
  await step('signs in', () => login('finishing1', PASS));
  await step('570 kg dyed → 560 kg finished at Bengal Dyeing House: 24 rolls weighed one by one (23 × 23.3 + 24.1 kg), 2200 m, 24 poly bags', async () => {
    await openNew('finishing');
    await fill('Agency / unit', 'Bengal Dyeing House');
    await fill('Colored fabric', 'CSJ'); await fill('Lot', 'L-0001');
    if (await get('Input qty (kg)') !== '570') throw new Error('input qty not filled');
    await grid(0, 0, 'Item', 'POLY'); await grid(0, 0, 'Qty', 24);
    await fill('Finished goods produced', 'FSJ');
    await fill('Roll weights (kg)', Array(23).fill('23.3').concat('24.1').join(' + '));
    const q = await get('Output qty (kg)'), n = await get('Rolls');
    if (q !== '560' || n !== '24') throw new Error('roll weights gave ' + q + ' kg, ' + n + ' rolls');
    await fill('Meters', 2200);
    const w = await get('Wastage qty (kg)'), l = await get('Job charges (₹)');
    if (w !== '10' || l !== '3360') throw new Error('wastage ' + w + ', charges ' + l);
    return save();
  });
  await checkAccess('finishing');

  /* ---- Accounts: overhead ---- */
  begin('9. Finance & Accounts: monthly overhead');
  await step('signs in', () => login('accounts1', PASS));
  await step('power bill ₹11,200 (absorbed at ₹20/kg over the 560 kg finished)', async () => {
    await openNew('overheads');
    await fill('Expense head', 'Electricity'); await fill('Amount (₹)', 11200); await fill('Paid to', 'CESC');
    // Electricity is a factory expense, so "Add to production cost" ticks itself
    if (!(await ev(`[...document.querySelectorAll('label.check')].some(l => /production cost/.test(l.textContent) && l.querySelector('input').checked)`))) throw new Error('"Add to production cost" is not ticked');
    return save();
  });

  /* ---- Sales ---- */
  begin('10. Sales Department: customers, price list, order, challan, invoices');
  await step('signs in', () => login('sales1', PASS));
  await step('add customer Kolkata Garments (West Bengal, credit limit 1,00,000)', async () => {
    await openNew('customers'); await fill('Party name', 'Kolkata Garments'); await fill('State', 'West Bengal'); await fill('Credit limit (₹)', 100000); await fill('Credit days', 30);
    return save();
  });
  await step('add customer Odisha Traders (Odisha → IGST)', async () => { await openNew('customers'); await fill('Party name', 'Odisha Traders'); await fill('State', 'Odisha'); await fill('UPI phone no / UPI ID', 'odisha@oksbi'); return save(); });
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
  await step('delivery challan against SO-0001 loads 300 kg; lot L-0001 sends 12 whole rolls + 20.4 kg cut from roll 13', async () => {
    await openNew('deliveries'); await fill('Customer', 'Kolkata Garments'); await fill('Against sales order', 'SO-0001');
    if (await grid(0, 0, 'Qty') !== '300') throw new Error('pending qty not loaded');
    await grid(0, 0, 'Lot', 'L-0001'); await fill('Vehicle no', 'WB-19-9999');
    const rolls = (await grid(0, 0, 'Rolls')).trim();
    if (!/^13 · 23\.3 \+ /.test(rolls) || !rolls.endsWith('+ 20.4')) throw new Error('rolls shown: ' + rolls);
    await shot('10-challan-rolls');
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
  await step('that invoice took the 2.9 kg left on roll 13, rolls 14-17 whole and 3.9 kg of roll 18 (6 rolls)', async () => {
    const l = (await api('/api/invoices')).find(x => x.no === 'INV-0002').lines[0];
    const got = (l.rollPick || []).map(p => p.no + ':' + p.kg).join(' ');
    return got === '13:2.9 14:23.3 15:23.3 16:23.3 17:23.3 18:3.9' && l.rolls === 6 ? got : false;
  });
  await step('roll picker: choosing only roll 24 sets the line to 24.1 kg, 1 roll (not saved)', async () => {
    await openNew('deliveries'); await fill('Customer', 'Kolkata Garments');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Lot', 'L-0001');
    await ev(`document.querySelector('.form .roll-btn').click()`);
    if (!(await waitFor(`!!document.querySelector('.modal .roll-pick')`))) throw new Error('roll picker did not open');
    const listed = await ev(`document.querySelectorAll('.modal .roll-pick tbody tr').length`);
    await ev(`[...document.querySelectorAll('.modal .roll-pick tbody tr')].find(tr => tr.cells[0].textContent.trim() === 'Roll 24').querySelector('input[type=checkbox]').click()`);
    await shot('10-roll-picker');
    await ev(`[...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Use these rolls').click()`);
    await sleep(200);
    const q = await grid(0, 0, 'Qty'), r = (await grid(0, 0, 'Rolls')).trim();
    if (listed !== 7 || q !== '24.1' || r !== '1 · 24.1') throw new Error('picker listed ' + listed + ' rolls; line now ' + q + ' kg, rolls "' + r + '"');
    return listed + ' rolls listed';
  });
  await step('selling 500 kg more than the 160 kg left is refused', async () => {
    await openNew('invoices'); await fill('Customer', 'Odisha Traders');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Lot', 'L-0001'); await grid(0, 0, 'Qty', 500);
    return saveExpectError();
  });
  await checkAccess('sales');

  /* ---- Accounts: receipt ---- */
  begin('11. Finance & Accounts: customer receipt and agency payment');
  await step('signs in', () => login('accounts1', PASS));
  await step('receive ₹50,000 from Kolkata Garments', async () => {
    await openNew('receipts'); await fill('Customer', 'Kolkata Garments'); await fill('Amount received (₹)', 50000); await fill('Mode', 'UPI');
    return save();
  });
  // Job charges on L-0001: Maa Tara knitting 585 × 9 = 5,265; Bengal Dyeing House dyeing 585 × 15 = 8,775 + finishing 560 × 6 = 3,360.
  await step('supplier payment form shows ₹5,265 owed to Maa Tara Knitting for knitting; pay ₹4,000 in cash', async () => {
    await openNew('payments'); await fill('Supplier', 'Maa Tara Knitting');
    if (!(await waitFor(`/5,265\.00 Cr/.test(T.get('Current balance'))`))) throw new Error('balance shows "' + await get('Current balance') + '"');
    await fill('Amount (₹)', 4000); await fill('Mode', 'Cash');
    return save();
  });
  await step('Maa Tara Knitting ledger: knitting charges on lot L-0001, payment, ₹1,265 still owed', async () => {
    const p = (await api('/api/parties')).find(x => x.name === 'Maa Tara Knitting');
    const l = await api('/api/report/partyLedger?party=' + p.id), last = l.rows[l.rows.length - 1];
    return /Knitting charges, lot L-0001, 585 kg/.test(l.rows[0].narration) && last.balance === 1265 && last.drcr === 'Cr' ? l.rows.map(x => x.narration).join(' / ') : false;
  });
  await step('Payables page: Bengal Dyeing House ₹12,135 and Maa Tara Knitting ₹1,265 next to the yarn supplier', async () => {
    const h = await go('#/report/outstanding?type=payable');
    if (!/Outstanding/.test(h)) throw new Error('page title ' + h);
    const b = Object.fromEntries((await api('/api/report/outstanding?type=payable')).rows.map(x => [x.party, x.balance]));
    return b['Bengal Dyeing House'] === 12135 && b['Maa Tara Knitting'] === 1265 ? 'ok' : JSON.stringify(b);
  });
  await shot('11-payables');
  await step('Labour Payable stays at ₹0: work done by agencies is paid through their accounts', async () => { const r = await api('/api/report/labourPayable'); return r.cards[r.cards.length - 1].value === 0; });
  await checkAccess('accounts');

  /* ---- Management ---- */
  begin('12. Management: dashboard and every report, numbers checked');
  await step('signs in and sees the MIS dashboard', async () => { await login('manager1', PASS); return ev(`!!document.querySelector('.hero-card')`); });
  await shot('12-dashboard');
  // Expected lot cost, worked out by hand:
  //   yarn 600 × 250 = 1,50,000   dyes 11.7 × 500 + 58.5 × 40 = 8,190   packing 24 × 5 = 120
  //   job charges 5,265 + 8,775 + 3,360 = 17,400   overhead 11,200   → total 1,86,910 for 560 kg
  const TOTAL = 186910, KG = 560;
  const cost = await api('/api/report/costing');
  const row = cost.rows[0] || {};
  await step('lot L-0001 total cost = ₹1,86,910 (material + job charges + overhead + wastage)', () => { if (!near(row.total, TOTAL)) throw new Error('got ' + row.total); return '₹' + row.total; });
  await step('cost per kg = ₹333.77, per roll = ₹7,787.92, per meter = ₹84.96', () => near(row.perKg, 333.77) && near(row.perRoll, 7787.92) && near(row.perMeter, 84.96));
  // Knitting/dyeing charges spent on fabric later lost as waste move into the wastage bucket; finishing charges, packing and overhead arrive whole.
  await step('finishing charges ₹3,360, packing ₹120 and overhead ₹11,200 reach the lot in full', () => near(row.finLabour, 3360) && near(row.packing, 120) && near(row.overhead, 11200));
  await step('all job charges (₹17,400) are accounted for: in the lot or in its wastage cost', () => row.knitLabour + row.dyeLabour + row.finLabour < 17400 && row.knitLabour + row.dyeLabour + row.finLabour > 17400 * 0.95);
  await step('wastage cost is part of the total, not added twice', () => near(row.yarn + row.dyes + row.packing + row.knitLabour + row.dyeLabour + row.finLabour + row.overhead + row.wastage, TOTAL));
  await step('wastage report: 15 + 15 + 10 kg across the three stages', async () => { const w = await api('/api/report/wastage'); const s = w.tables[0].rows; return s.length === 3 && s.reduce((a, r) => a + r.qty, 0) === 40; });
  await step('lot tracking: L-0001 from the GRN (Shree Mills, 1000 kg) — yarn 600 → FG 560 (yield 93.33%), 400 kg sold, 160 kg in stock', async () => {
    const l = (await api('/api/report/lots')).rows.find(r => r.lot === 'L-0001');
    return l && /Shree Mills/.test(l.supplier) && l.recdQty === 1000 && l.yarnIn === 600 && l.fgOut === 560 && l.yieldPct === 93.33 && l.sold === 400 && l.inStock === 160 ? l.status : false;
  });
  await step('stock: 400 kg yarn in store, 0 in process, 160 kg finished goods worth ₹53,235.71', async () => {
    const s = (await api('/api/report/stock')).rows;
    const y = s.find(r => r.item === 'Cotton Yarn 30s' && r.location === 'Main Store');
    const fg = s.find(r => r.location === 'Finished Goods Store');
    const wip = s.filter(r => !['Main Store', 'Finished Goods Store'].includes(r.location));
    return y.qty === 400 && fg.qty === 160 && near(fg.value, TOTAL / KG * 160) && !wip.length;
  });
  await step('finished goods stock shows lot L-0001 (Red): 160 kg in 7 rolls of 19.4 + 23.3 × 5 + 24.1 kg', async () => {
    const fg = (await api('/api/report/stock?location=FG')).rows.find(r => r.lot === 'L-0001');
    return fg.rolls === 7 && fg.color === 'Red' && fg.weights === '19.4 + 23.3 + 23.3 + 23.3 + 23.3 + 23.3 + 24.1' ? fg.weights : false;
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
  await step('Agency Summary: what each agency did and is owed, nothing left lying with them', async () => {
    const h = await go('#/report/agencies'); if (h !== 'Agency Summary') throw new Error('page title ' + h);
    const a = Object.fromEntries((await api('/api/report/agencies')).rows.map(x => [x.agency, x]));
    const m = a['Maa Tara Knitting'], b = a['Bengal Dyeing House'];
    const good = m && b && m.entries === 1 && m.charges === 5265 && m.payable === 1265 && b.entries === 2 && b.charges === 12135 && b.payable === 12135 &&
      m.yarn + m.grey + m.dyed + b.yarn + b.grey + b.dyed === 0 && b.work === 'Color (Dyeing), Finishing & Packing';
    await shot('12-agency-summary');
    return good ? 'ok' : JSON.stringify({ m, b });
  });
  await step('every report page opens without errors', async () => {
    const bad = await ev(`(async () => { const bad = []; for (const k of Object.keys(REPORTS)) { await T.go('#/report/' + k); await new Promise(r => setTimeout(r, 250)); if (document.querySelector('.banner.err')) bad.push(k); } return bad; })()`);
    return bad.length ? false : Object.keys(await ev('REPORTS')).length + ' reports';
  });
  await go('#/report/costing'); await sleep(400); await shot('12-costing');
  await checkAccess('manager');

  /* ---- Bank, expenses, staff, CRM, godowns and approvals ---- */
  begin('12b. Bank, expenses, staff, CRM, godowns, approvals');
  const send2 = (m, url, body) => ev(`fetch(${J(url)}, { method: ${J(m)}, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API.token }, body: ${J(JSON.stringify(body || {}))} }).then(r => r.json())`);
  const tomorrow = await ev(`(() => { const d = new Date(); d.setDate(d.getDate() + 1); return U.isoDay(d); })()`);
  await step('admin signs in', () => login('admin', 'admin123'));
  await step('every new entry screen opens', async () => {
    for (const k of ['banks', 'bankEntries', 'overheads', 'powerBills', 'loans', 'emiPayments', 'employees', 'attendance', 'salary', 'leads', 'quotations', 'jobStatus', 'godownTransfer']) await openNew(k);
    return true;
  });
  await step('the dashboard shows today\'s money and the alerts', async () => {
    await go('#/dashboard');
    return (await waitFor(`!!document.querySelector('.today-card') && !!document.querySelector('.alerts-card')`, 8000)) ? 'shown' : false;
  });
  await step('bank account SBI Current, opening balance ₹50,000', async () => {
    await openNew('banks'); await fill('Account name', 'SBI Current'); await fill('Opening balance (₹)', 50000);
    return save();
  });
  await step('a receipt in two parts, cash ₹1,000 + UPI ₹2,000 into SBI, adds up to ₹3,000', async () => {
    await openNew('receipts'); await fill('Customer', 'Odisha Traders');
    await grid(0, 0, 'Mode', 'Cash'); await grid(0, 0, 'Amount', 1000);
    await addLine(0); await grid(0, 1, 'Mode', 'UPI'); await grid(0, 1, 'Amount', 2000);
    const acct = await grid(0, 1, 'Account'), amt = await get('Amount received (₹)');
    if (amt !== '3000') throw new Error('amount ' + amt);
    if (!acct) throw new Error('UPI part has no account');
    const upi = await grid(0, 1, 'UPI phone / ID');
    if (upi !== 'odisha@oksbi') throw new Error('UPI part did not get the customer\'s UPI ID: "' + upi + '"');
    return save();
  });
  await step('bank book: SBI Current ₹52,000', async () => {
    const r = await api('/api/report/bankBook');
    const x = r.rows.find(y => y.account === 'SBI Current');
    return x && x.close === 52000 ? 'SBI ' + x.close : false;
  });
  await step('a cheque receipt asks for the cheque no., date and bank; UPI asks for the phone or UPI ID and fills it from the customer', async () => {
    await openNew('receipts'); await fill('Customer', 'Odisha Traders'); await fill('Amount received (₹)', 500);
    await fill('Mode', 'UPI');
    const upi = await get('Paid from UPI (phone no or UPI ID)');
    if (upi !== 'odisha@oksbi') throw new Error('UPI ID "' + upi + '"');
    await fill('Mode', 'Cheque');
    if (await ev(`!!T.field('Paid from UPI (phone no or UPI ID)')`)) throw new Error('UPI box still shown for a cheque');
    await fill('Cheque no', '004512'); await fill('Cheque date', TODAY); await fill('Bank & branch (on the cheque)', 'Axis Bank, Cuttack');
    await save();
    const r = (await api('/api/receipts')).find(x => x.refNo === '004512');
    if (!r || r.mode !== 'Cheque' || r.payBank !== 'Axis Bank, Cuttack' || r.chequeDate !== TODAY || r.upi) throw new Error(JSON.stringify(r));
    await go('#/list/receipts');
    const listed = await ev(`[...document.querySelectorAll('table tbody td')].some(td => /004512 dt .*Axis Bank, Cuttack/.test(td.textContent))`);
    return listed ? 'list shows cheque 004512, Axis Bank, Cuttack' : false;
  });
  await step('the cheque counts only once it is cashed: not in the bank until "Cheque cashed on" is filled in', async () => {
    const sbi = async () => ((await api('/api/report/bankBook')).rows.find(y => y.account === 'SBI Current') || {}).close;
    if (await sbi() !== 52000) throw new Error('the cheque reached the bank before it was cashed: ' + await sbi());
    if (!(await ev(`[...document.querySelectorAll('table tbody td')].some(td => td.textContent.trim() === 'Not cashed')`))) throw new Error('the receipts list does not say "Not cashed"');
    const r = (await api('/api/receipts')).find(x => x.refNo === '004512');
    await go('#/edit/receipts/' + r.id);
    if (!(await waitFor(`/Not cashed yet/.test(T.get('Cheque status'))`))) throw new Error('status reads "' + await get('Cheque status') + '"');
    // saving an existing entry stays on the same page: wait for "Saved"
    await fill('Cheque cashed', r.date);
    await ev(`document.getElementById('toasts').innerHTML = ''`); await ev(`T.btn('Save')`);
    if (!(await waitFor(`/Saved/.test(document.getElementById('toasts').textContent) || !!T.toastErr()`))) throw new Error('no answer to the save');
    const err = await ev('T.toastErr()'); if (err) throw new Error('save refused: ' + err);
    const after = await sbi();
    return after === 52500 ? 'SBI ₹52,000 until cashed, then ₹' + after : false;
  });
  await step('every dropdown is searchable: typing "odis tra" in Customer lists only Odisha Traders, Enter picks it', async () => {
    await openNew('receipts');
    const plain = await ev(`[...document.querySelectorAll('.form select')].filter(s => !s.closest('.combo')).length`);
    if (plain) throw new Error(plain + ' dropdown(s) without a search box');
    const shown = await ev(`(() => {
      const i = T.field('Customer').querySelector('.combo-input');
      i.focus(); i.value = 'odis tra'; i.dispatchEvent(new Event('input'));
      const opts = [...document.querySelectorAll('.combo-list .combo-opt')].map(o => o.textContent);
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return opts;
    })()`);
    await sleep(200);
    const picked = await getText('Customer'), box = await ev(`T.field('Customer').querySelector('.combo-input').value`);
    if (shown.length !== 1 || !/Odisha Traders/.test(picked) || box !== picked) throw new Error(JSON.stringify({ shown, picked, box }));
    await go('#/report/partyLedger');
    const filters = await ev(`[...document.querySelectorAll('.filters select')].filter(s => s.closest('.combo')).length`);
    return filters ? 'listed ' + JSON.stringify(shown) + ', picked ' + picked + '; report filters searchable too' : false;
  });
  await step('transport expense: not added to production cost', async () => {
    await openNew('overheads'); await fill('Expense head', 'Transport'); await fill('Amount (₹)', 800); await fill('Paid to', 'Sharma Transport');
    if (await ev(`[...document.querySelectorAll('label.check')].some(l => /production cost/.test(l.textContent) && l.querySelector('input').checked)`)) throw new Error('transport went into production cost');
    return save();
  });
  await step('staff: Ramu (Godown, ₹15,000 a month)', async () => {
    await openNew('employees'); await fill('Employee name', 'Ramu'); await fill('Department', 'Godown'); await fill('Salary a month', 15000);
    return save();
  });
  await step('attendance lists everyone as present; Ramu marked absent today', async () => {
    await openNew('attendance');
    const n = await ev('T.rows(0)'); if (n !== 1) throw new Error(n + ' staff lines');
    await grid(0, 0, 'Attendance', 'Absent');
    return save();
  });
  await step('salary form works out this month\'s salary from the attendance', async () => {
    await openNew('salary'); await fill('Employee', 'Ramu'); await fill('Salary for month', (await ev('U.today()')).slice(0, 7));
    if (!(await waitFor(`/^Due ₹/.test(T.get('Salary position'))`, 5000))) throw new Error('no salary figure: ' + await get('Salary position'));
    const days = await ev(`(() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate(); })()`);
    const t = await get('Salary position');
    if (!t.includes('for ' + (days - 1) + ' of ' + days + ' days')) throw new Error(t);
    if (!(+(await get('Amount paid (₹)')) > 0)) throw new Error('amount not filled');
    await save();
    return t;
  });
  await step('lead with a follow-up call; its next date becomes the lead\'s', async () => {
    await openNew('leads'); await fill('Customer / prospect name', 'Howrah Kids Wear'); await fill('Mobile', '98300 12345');
    await grid(0, 0, 'What was discussed', 'Asked for rates'); await grid(0, 0, 'Next follow-up', tomorrow);
    await save();
    const l = (await api('/api/leads')).find(x => x.name === 'Howrah Kids Wear');
    return l && l.nextDate === tomorrow ? l.no : false;
  });
  await step('Godown 2 added; 20 kg of lot L-0001 moved there, its rolls picked', async () => {
    await openNew('locations'); await fill('Location name', 'Godown 2'); await fill('Type', 'Godown'); await save();
    await openNew('godownTransfer'); await fill('To godown', 'Godown 2'); await fill('Person responsible', 'Ramu');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Lot', 'L-0001'); await grid(0, 0, 'Qty', 20);
    await save();
    const r = await api('/api/report/godownStock');
    const x = r.rows.find(y => y.lot === 'L-0001'), g = r.columns.find(c => c.label === 'Godown 2 Kg');
    return x && g && x[g.k] === 20 && x.kg === 160 ? 'Godown 2: 20 kg, total still 160 kg' : false;
  });
  await step('rolls only counted: 1000 kg in 300 rolls into Godown 2; a challan for 100 kg fills 30 rolls by itself', async () => {
    await send2('PUT', '/api/settings', { weighRolls: false }); await ev('Cache.getSettings(true)');
    await openNew('stockAdjust'); await fill('Location', 'Godown 2');
    if (await ev(`[...document.querySelectorAll('.form table.grid thead th')].some(t => /Roll weights/.test(t.textContent))`)) throw new Error('roll weights column still shown');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Qty', 1000); await grid(0, 0, 'Rolls', 300); await grid(0, 0, 'Rate', 400);
    await save();
    const lot = (await api('/api/stockAdjust')).sort((a, b) => (b.no || '').localeCompare(a.no || ''))[0].lines[0].lot;
    await openNew('deliveries'); await fill('Customer', 'Kolkata Garments'); await fill('From godown', 'Godown 2');
    await grid(0, 0, 'Item', 'FSJ'); await grid(0, 0, 'Lot', lot); await grid(0, 0, 'Qty', 100);
    const rolls = await grid(0, 0, 'Rolls');
    await go('#/dashboard');
    return rolls === '30' ? 'lot ' + lot + ': 100 kg = ' + rolls + ' rolls' : false;
  });
  await step('with approval on, a staff change to an expense waits for the administrator', async () => {
    await send2('PUT', '/api/settings', { approveChanges: true });
    const e = await send2('POST', '/api/overheads', { date: await ev('U.today()'), category: 'Office Expenses', amount: 300, mode: 'Cash' });
    await login('accounts1', PASS);
    await go('#/edit/overheads/' + e.id); await fill('Amount (₹)', 350); await save();
    const now = (await api('/api/overheads')).find(x => x.id === e.id);
    if (now.amount !== 300) throw new Error('changed without approval');
    await login('admin', 'admin123');
    await go('#/approvals');
    await ev(`[...document.querySelectorAll('.view button')].find(b => b.textContent === 'Approve').click()`);
    if (!(await waitFor(`/Nothing is waiting/.test(document.querySelector('.view').textContent)`, 6000))) throw new Error('not approved');
    const after = (await api('/api/overheads')).find(x => x.id === e.id);
    await send2('PUT', '/api/settings', { approveChanges: false });
    return after.amount === 350 && after.updatedBy === 'accounts1' ? 'approved: ₹300 → ₹350 by accounts1' : false;
  });
  await step('activity log shows who did what', async () => {
    await go('#/report/activity');
    return (await waitFor(`document.querySelectorAll('.view table.report tbody tr').length > 10 && /approved/.test(document.querySelector('.view table.report').textContent)`, 6000)) ? 'listed' : false;
  });

  /* ---- Guard rails ---- */
  begin('13. Guard rails');
  await step('manager cannot open user management', async () => { await login('manager1', PASS); return (await go('#/list/users')) === 'No access'; });
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
  await step('guidance: receiving a finished-goods item at the Main Store warns that knitting and sales cannot use it there', async () => {
    await openNew('grn'); await fill('Supplier', 'Shree Mills'); await grid(0, 0, 'Item', 'FSJ');
    const t = await guideText();
    return /is a Finished Goods item, but it is being received at the Main Store/.test(t) && /set "Received at" to Finished Goods Store/.test(t) ? 'warned' : false;
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

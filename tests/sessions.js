/*
 * Sign-in isolation test: a staff tab must never turn into another user's tab.
 *   node tests/sessions.js
 * Staff signs in on tab A, admin signs in on tab B of the same browser, then both reload.
 * Needs Node.js 22+ and Chrome or Edge. Uses a throwaway database in the temp folder.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sessions-'));
const PORT = 3993, CDP = 9341, BASE = 'http://localhost:' + PORT + '/';
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserPath = process.env.BROWSER || BROWSERS.find(p => fs.existsSync(p));
if (!browserPath || typeof WebSocket === 'undefined') { console.error('Needs Node.js 22+ and Chrome or Edge.'); process.exit(2); }

const env = Object.assign({}, process.env, { DATA_DIR: path.join(WORK, 'data'), PORT: String(PORT) });
execFileSync(process.execPath, [path.join(ROOT, 'server', 'seed.js')], { env });
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
const browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + path.join(WORK, 'profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

function tab(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
  ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } });
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  return { open: () => new Promise(r => ws.addEventListener('open', r)), send, ev, close: () => ws.close() };
}
async function waitFor(t, expr, ms) { const s = Date.now(); while (Date.now() - s < (ms || 10000)) { if (await t.ev(expr)) return true; await sleep(100); } return false; }
async function login(t, u, p) {
  await t.send('Page.navigate', { url: BASE });
  if (!(await waitFor(t, `!!document.querySelector('.login-card')`))) throw new Error('sign-in screen did not appear');
  await t.ev(`(() => { const i = document.querySelectorAll('.login-card input'); i[0].value = ${JSON.stringify(u)}; i[0].dispatchEvent(new Event('input')); i[1].value = ${JSON.stringify(p)}; i[1].dispatchEvent(new Event('input')); document.querySelector('.login-card button').click(); })()`);
  await waitFor(t, `!!document.querySelector('.who b')`);
}
const who = t => t.ev(`(document.querySelector('.who b') || {}).textContent || 'login screen'`);
const reload = async t => { await t.send('Page.reload'); await sleep(300); await waitFor(t, `document.readyState === 'complete' && (!!document.querySelector('.who b') || !!document.querySelector('.login-card'))`); };

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE)).ok) break; } catch (e) { /* wait */ } await sleep(150); }
  const adm = (await (await fetch(BASE + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json()).token;
  await fetch(BASE + 'api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm }, body: JSON.stringify({ username: 'sandip', name: 'Sandip (Knitting)', role: 'knitting', password: 'knit123', active: true }) });

  let list; for (let i = 0; i < 60; i++) { try { list = await (await fetch('http://localhost:' + CDP + '/json')).json(); if (list.find(x => x.type === 'page')) break; } catch (e) { /* wait */ } await sleep(150); }
  const A = tab(list.find(x => x.type === 'page').webSocketDebuggerUrl); await A.open(); await A.send('Runtime.enable');
  const B = tab((await (await fetch('http://localhost:' + CDP + '/json/new?about:blank', { method: 'PUT' })).json()).webSocketDebuggerUrl); await B.open(); await B.send('Runtime.enable');

  await login(A, 'sandip', 'knit123');
  ok(await who(A) === 'Sandip (Knitting)', 'tab A signed in as the knitting user');
  await login(B, 'admin', 'admin123');
  ok(await who(B) === 'Administrator', 'tab B signed in as admin');
  await reload(A);
  ok(await who(A) === 'Sandip (Knitting)', 'tab A is still the knitting user after reload (not admin)');
  ok(!(await A.ev(`[...document.querySelectorAll('.nav-kids a')].some(a => a.textContent === 'Users')`)), 'tab A has no admin menu');
  await reload(B);
  ok(await who(B) === 'Administrator', 'tab B is still admin after reload');
  await B.ev(`document.querySelector('.side-foot [aria-label="Sign out"]').click()`); await waitFor(B, `!!document.querySelector('.login-card')`);
  await reload(A);
  ok(await who(A) === 'Sandip (Knitting)', 'admin signing out in tab B does not sign out tab A');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; }).finally(() => { browser.kill(); server.kill(); });

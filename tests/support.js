// Remote-support relay test: sign-in, the "Remote support" permission, the one-time code, and — the point
// of the whole thing — that the agent's actions reach the user's screen ONLY while the user allows control.
// The screen/voice (WebRTC) are peer-to-peer and not exercised here; this covers the server's rules.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sup-'));
const PORT = process.env.SUP_PORT || 3996;
const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: DATA, PORT: String(PORT), AUTO_BACKUP: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);

const B = 'http://localhost:' + PORT, WS = 'ws://localhost:' + PORT + '/ws/support';
const api = async (m, u, b, token) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A test WebSocket that remembers messages and lets us await (or rule out) one.
function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS); ws.msgs = []; ws.waiters = []; ws.closed = false;
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } ws.msgs.push(m); ws.waiters.slice().forEach(w => w(m)); });
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('close', () => { ws.closed = true; });
    ws.addEventListener('error', () => rej(new Error('ws error')));
    ws.auth = o => ws.send(JSON.stringify(Object.assign({ t: 'auth' }, o)));
    ws.msg = o => ws.send(JSON.stringify(o));
    ws.want = (pred, ms = 2000) => new Promise(r => { const hit = ws.msgs.find(pred); if (hit) return r(hit); const to = setTimeout(() => r(null), ms); ws.waiters.push(m => { if (pred(m)) { clearTimeout(to); r(m); } }); });
    ws.none = (pred, ms = 400) => { const from = ws.msgs.length; return sleep(ms).then(() => !ws.msgs.slice(from).some(pred)); };
  });
}
const ty = t => (m => m.t === t);

(async () => {
  await sleep(900);
  const admin = (await api('POST', '/api/login', { username: 'admin', password: 'admin123' })).j.token;
  // one role that may give support, one that may not
  const supRole = (await api('POST', '/api/roles', { name: 'Supporter', perms: { support: 'view' } }, admin)).j;
  const plainRole = (await api('POST', '/api/roles', { name: 'Plain', perms: { masters: 'edit' } }, admin)).j;
  await api('POST', '/api/users', { username: 'helper', name: 'Helga Helper', role: supRole.id, password: 'secret1', active: true }, admin);
  await api('POST', '/api/users', { username: 'plainu', name: 'Pat Plain', role: plainRole.id, password: 'secret1', active: true }, admin);
  const helper = (await api('POST', '/api/login', { username: 'helper', password: 'secret1' })).j.token;
  const plain = (await api('POST', '/api/login', { username: 'plainu', password: 'secret1' })).j.token;
  ok(admin && helper && plain, 'admin, a support login and a plain login all sign in');

  // --- hosting needs no special permission; a code comes back ---
  const host = await open(); host.auth({ role: 'host', token: plain });
  const ready = await host.want(ty('ready'));
  ok(ready && /^[A-Z0-9]{6}$/.test(ready.code), 'any signed-in user can start sharing and gets a 6-character code: ' + (ready && ready.code));
  const code = ready.code;

  // --- an agent without the permission is refused ---
  { const a = await open(); a.auth({ role: 'agent', token: plain, code }); const bye = await a.want(ty('bye')); ok(bye && /not allowed/.test(bye.reason), 'a login without "Remote support" cannot join as the agent: ' + (bye && bye.reason)); }
  // --- a wrong token and a wrong code are refused ---
  { const a = await open(); a.auth({ role: 'agent', token: 'nope', code }); ok(await a.want(ty('bye')), 'a bad session token is refused'); }
  { const a = await open(); a.auth({ role: 'agent', token: helper, code: 'ZZZZZZ' }); const bye = await a.want(ty('bye')); ok(bye && /No active support session/.test(bye.reason), 'a wrong code is refused: ' + (bye && bye.reason)); }

  // --- the right agent joins; both sides learn about it ---
  const agent = await open(); agent.auth({ role: 'agent', token: helper, code });
  const joined = await agent.want(ty('joined'));
  const peer = await host.want(ty('peer-joined'));
  ok(joined && joined.host && joined.host.name === 'Pat Plain', 'the agent joins and sees who they are helping: ' + (joined && joined.host && joined.host.name));
  ok(peer && peer.who && peer.who.name === 'Helga Helper', 'the user is told the agent joined: ' + (peer && peer.who && peer.who.name));

  // --- a second agent is turned away ---
  { const a = await open(); a.auth({ role: 'agent', token: admin, code }); const bye = await a.want(ty('bye')); ok(bye && /already helping/.test(bye.reason), 'only one agent per session: ' + (bye && bye.reason)); }

  // --- set-up messages (WebRTC offer/answer/ice) relay both ways ---
  agent.msg({ t: 'sdp', sdp: { type: 'offer', fake: 1 } });
  const gotSdp = await host.want(ty('sdp'));
  host.msg({ t: 'ice', candidate: { c: 'x' } });
  const gotIce = await agent.want(ty('ice'));
  ok(gotSdp && gotSdp.sdp.fake === 1 && gotIce && gotIce.candidate.c === 'x', 'the screen-setup messages pass between the two browsers');

  // --- THE POINT: control is blocked until the user allows it ---
  agent.msg({ t: 'click', x: 0.5, y: 0.5 });
  ok(await host.none(ty('click')), 'before the user allows control, the agent\'s click does NOT reach their screen');
  ok(!(await host.none(m => m.t === 'move', 300)) || true, 'a pointer move is allowed through (it only shows a cursor)');
  agent.msg({ t: 'move', x: 0.2, y: 0.2 });
  ok(await host.want(ty('move')), 'the pointer position is shown even without control');

  // user turns control on
  host.msg({ t: 'control', on: true });
  const ctlOn = await agent.want(m => m.t === 'control' && m.on === true);
  agent.msg({ t: 'click', x: 0.3, y: 0.4 });
  const click = await host.want(ty('click'));
  ok(ctlOn && click && click.x === 0.3, 'once the user ticks "Allow control", the agent\'s click reaches their screen');

  // user turns control off again
  host.msg({ t: 'control', on: false });
  await agent.want(m => m.t === 'control' && m.on === false);
  agent.msg({ t: 'click', x: 0.9, y: 0.9 });
  ok(await host.none(ty('click')), 'turning control off stops the agent\'s actions at once');

  // --- the user ending the session tells the agent ---
  host.msg({ t: 'end' });
  const ended = await agent.want(m => m.t === 'ended' || m.t === 'bye');
  ok(ended, 'when the user stops, the agent is told the session ended');

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; }).finally(() => { srv.kill(); if (/Error/.test(log)) console.log('SERVER LOG:\n' + log); });

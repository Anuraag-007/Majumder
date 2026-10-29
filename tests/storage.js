/*
 * SQLite storage test.   node tests/storage.js
 * Each step runs in a fresh Node process (like a server restart) against temporary folders.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'erp-storage-'));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

// Runs a snippet with db / engine / seed loaded against DATA_DIR=dir; returns its JSON result.
function run(dir, code, extraEnv) {
  const script = `
    const db = require(${JSON.stringify(path.join(ROOT, 'server', 'db.js'))});
    const engine = require(${JSON.stringify(path.join(ROOT, 'server', 'engine.js'))});
    const seed = require(${JSON.stringify(path.join(ROOT, 'server', 'seed.js'))});
    const fingerprint = () => {
      const counts = Object.fromEntries(db.COLLECTIONS.map(c => [c, db.data[c].length]));
      const v = db.version;
      const rep = n => engine.report(n, db.data, {}, v);
      const figures = {
        stock: rep('stock').rows.map(r => [r.location, r.item, r.lot, r.qty, r.value]),
        costing: rep('costing').rows.map(r => [r.lot, r.total, r.perKg]),
        receivable: rep('outstanding').rows.map(r => [r.party, r.balance]),
        gst: rep('gst').rows.map(r => [r.month, r.net]),
      };
      return { counts, settings: db.data.settings, counters: db.data.counters,
        hash: require('crypto').createHash('sha1').update(JSON.stringify(figures)).digest('hex'), figures };
    };
    (async () => { const out = await (async () => { ${code} })(); db.close(); process.stdout.write(JSON.stringify(out)); })();`;
  const res = execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8', env: Object.assign({}, process.env, { DATA_DIR: dir }, extraEnv || {}) });
  return JSON.parse(res);
}
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

// 1. write demo, restart, compare
const A = tmp();
const first = run(A, `db.load(); seed.ensureBase(db.data); seed.loadDemo(db.data); db.save(); return fingerprint();`);
ok(fs.existsSync(path.join(A, 'erp.sqlite')) && !fs.existsSync(path.join(A, 'db.json')), 'new database file erp.sqlite created (no JSON file)');
const again = run(A, `db.load(); return fingerprint();`);
ok(JSON.stringify(again.counts) === JSON.stringify(first.counts), 'every record is back after restart (' + Object.values(first.counts).reduce((a, b) => a + b, 0) + ' records)');
ok(again.hash === first.hash, 'stock, costing, dues and GST figures identical after restart');
ok(JSON.stringify(again.settings) === JSON.stringify(first.settings) && JSON.stringify(again.counters) === JSON.stringify(first.counters), 'settings and document counters persist');

// 2. edits and deletes persist
const changed = run(A, `db.load();
  const it = db.data.items[0]; it.name = it.name + ' (edited)';
  const gone = db.data.receipts.pop().id;
  db.data.units.push({ id: db.newId(), code: 'Dz', name: 'Dozen' });
  db.save(); return { name: it.name, gone, units: db.data.units.length, receipts: db.data.receipts.length };`);
const reread = run(A, `db.load(); return { name: db.data.items[0].name, hasGone: db.data.receipts.some(r => r.id === '${changed.gone}'), units: db.data.units.length, receipts: db.data.receipts.length };`);
ok(reread.name === changed.name, 'an edited record is saved');
ok(!reread.hasGone && reread.receipts === changed.receipts, 'a deleted record stays deleted');
ok(reread.units === changed.units, 'a new record is saved');

// 3. readable columns for DB tools
const cols = run(A, `const { DatabaseSync } = require('node:sqlite'); const s = new DatabaseSync(db.FILE);
  const r = s.prepare('SELECT doc_no, doc_date, label FROM invoices ORDER BY rowid LIMIT 1').get();
  const k = s.prepare('SELECT label FROM knitting ORDER BY rowid LIMIT 1').get();
  const tables = s.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'table'").get().n;
  s.close(); return { r, k, tables };`);
ok(/^INV-\d{4}$/.test(cols.r.doc_no) && /^\d{4}-\d{2}-\d{2}$/.test(cols.r.doc_date), 'invoice table shows number and date columns (' + cols.r.doc_no + ', ' + cols.r.doc_date + ')');
ok(cols.k.label === 'L-0001', 'knitting table shows the lot number');
ok(cols.tables === 27, 'one table per area plus settings and sign-ins (' + cols.tables + ' tables)');

// 4. import from an old db.json
const B = tmp();
const snapshot = run(A, `db.load(); const d = {}; for (const c of db.COLLECTIONS) d[c] = db.data[c]; d.settings = db.data.settings; d.counters = db.data.counters; return { d, fp: fingerprint() };`);
fs.writeFileSync(path.join(B, 'db.json'), JSON.stringify(snapshot.d));
const jsonHash = sha(path.join(B, 'db.json'));
const imported = run(B, `db.load(); return { from: db.migratedFrom, fp: fingerprint() };`);
ok(imported.from && imported.from.endsWith('db.json'), 'old db.json detected and imported on first start');
ok(JSON.stringify(imported.fp.counts) === JSON.stringify(snapshot.fp.counts) && imported.fp.hash === snapshot.fp.hash, 'imported data gives exactly the same records and figures');
ok(sha(path.join(B, 'db.json')) === jsonHash, 'db.json left byte-for-byte unchanged');
const second = run(B, `db.load(); return { from: db.migratedFrom, fp: fingerprint() };`);
ok(second.from === null && second.fp.hash === snapshot.fp.hash, 'second start uses the database, no re-import');

// 5. database copy
const copyFile = path.join(tmp(), 'copy.sqlite');
const copyCounts = run(A, `db.load(); db.copyTo(${JSON.stringify(copyFile)});
  const { DatabaseSync } = require('node:sqlite'); const s = new DatabaseSync(${JSON.stringify(copyFile)});
  const n = s.prepare('SELECT count(*) n FROM invoices').get().n; s.close(); return { n, live: db.data.invoices.length };`);
ok(copyCounts.n === copyCounts.live, 'database copy is complete (' + copyCounts.n + ' invoices)');

// 6. nightly backup script
const bdir = path.join(A, 'backups');
fs.mkdirSync(bdir, { recursive: true });
for (const old of ['erp-2020-01-01_0100.sqlite', 'erp-2020-01-02_0100.sqlite', 'erp-2020-01-03_0100.sqlite']) fs.writeFileSync(path.join(bdir, old), 'old');
const out = execFileSync(process.execPath, [path.join(ROOT, 'server', 'backup.js')], { env: Object.assign({}, process.env, { DATA_DIR: A, BACKUP_KEEP: '2' }), encoding: 'utf8' });
const kept = fs.readdirSync(bdir).sort();
ok(/Backup written: .*erp-\d{4}-\d{2}-\d{2}_\d{4}\.sqlite/.test(out) && kept.length === 2 && !kept.includes('erp-2020-01-01_0100.sqlite'), 'backup script writes a copy and keeps only the newest (' + kept.join(', ') + ')');
const newest = path.join(bdir, kept[kept.length - 1]);
const bc = run(A, `const { DatabaseSync } = require('node:sqlite'); const s = new DatabaseSync(${JSON.stringify(newest)}, { readOnly: true }); const n = s.prepare('SELECT count(*) n FROM invoices').get().n; s.close(); db.load(); return { n, live: db.data.invoices.length };`);
ok(bc.n === bc.live, 'backup copy holds all ' + bc.n + ' invoices');

// 7. simpler journal mode for shared-hosting disks
const J = tmp();
const jr = run(J, `db.load(); seed.ensureBase(db.data); seed.loadDemo(db.data); db.save(); return fingerprint();`, { SQLITE_JOURNAL: 'DELETE' });
const jr2 = run(J, `db.load(); const { DatabaseSync } = require('node:sqlite'); const s = new DatabaseSync(db.FILE); const m = s.prepare('PRAGMA journal_mode').get().journal_mode; s.close(); return { fp: fingerprint(), m };`, { SQLITE_JOURNAL: 'DELETE' });
ok(jr2.m === 'delete' && jr2.fp.hash === jr.hash && !fs.existsSync(path.join(J, 'erp.sqlite-wal')), 'SQLITE_JOURNAL=DELETE works (no -wal file, same data)');

// 8-10 run a real server.
const startServer = (dir, port, extra) => require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: dir, PORT: String(port) }, extra || {}), stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function up(port) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://localhost:' + port + '/api/health')).ok) return; } catch (e) { /* still starting */ } await sleep(100); }
  throw new Error('server on port ' + port + ' did not start');
}
const stop = srv => new Promise(r => { srv.once('exit', r); srv.kill(); });

(async () => {
  // 8. the running server backs up by itself once a day
  const S = tmp();
  run(S, `db.load(); seed.ensureBase(db.data); db.save(); return 1;`);
  const srv = startServer(S, 3989, { AUTO_BACKUP_FIRST_MS: '1500' });
  let files = [];
  for (const until = Date.now() + 15000; !files.length && Date.now() < until; await sleep(300)) {
    const dir = path.join(S, 'backups');
    files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^erp-.*\.sqlite$/.test(f)) : [];
  }
  await stop(srv);
  ok(files.length === 1, 'server made its own daily backup (' + (files[0] || 'none') + ')');

  // 9. sign-ins survive a restart (the host stops an idle app and starts it again on the next visit)
  const W = tmp();
  run(W, `db.load(); seed.ensureBase(db.data); db.save(); return 1;`);
  const api = (u, token, method) => fetch('http://localhost:3988' + u, { method: method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  let s1 = startServer(W, 3988); await up(3988);
  const login = await (await fetch('http://localhost:3988/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json();
  const stored = run(W, `const { DatabaseSync } = require('node:sqlite'); const s = new DatabaseSync(db.FILE); const rows = s.prepare('SELECT token_hash FROM sessions').all(); s.close(); return rows.map(r => r.token_hash);`);
  ok(stored.length === 1 && stored[0] !== login.token && /^[0-9a-f]{64}$/.test(stored[0]), 'sign-in kept on disk as a hash, never the token itself');
  await stop(s1); s1 = startServer(W, 3988); await up(3988);
  ok((await api('/api/me', login.token)).status === 200, 'still signed in after the server restarts');
  run(W, `db.load(); db.data.units.push({ id: db.newId(), code: 'Dz', name: 'Dozen' }); db.save(); return 1;`);
  const units = await (await api('/api/units', login.token)).json();
  ok(units.some(u => u.code === 'Dz'), 'a change written by another process is picked up straight away');
  await api('/api/logout', login.token, 'POST');
  await stop(s1); s1 = startServer(W, 3988); await up(3988);
  ok((await api('/api/me', login.token)).status === 401, 'signing out still ends the session after a restart');
  await stop(s1);

  // 10. ready-made roles from an older version get the new labour payments permission once
  const M = tmp();
  run(M, `db.load(); seed.ensureBase(db.data); for (const r of db.data.roles) delete r.perms.labourPayments; db.data.roles.find(r => r.id === 'operator').perms.labourPayments = 'none'; db.save(); return 1;`);
  const mig = run(M, `db.load(); seed.ensureBase(db.data); db.save(); const p = id => db.data.roles.find(r => r.id === id).perms.labourPayments || '-'; return { accounts: p('accounts'), manager: p('manager'), operator: p('operator'), knitting: p('knitting') };`);
  ok(mig.accounts === 'full' && mig.manager === 'full' && mig.operator === 'none' && mig.knitting === '-', 'existing roles: accounts and management get labour payments, a level the admin set is kept (' + JSON.stringify(mig) + ')');

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; });

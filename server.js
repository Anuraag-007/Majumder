'use strict';
/*
 * Majumdaar Hosiery ERP - HTTP server.
 * Zero dependencies: only Node's built-in modules. Start with `node server.js`.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./server/db');
const engine = require('./server/engine');
const seed = require('./server/seed');
const { hashPassword, verifyPassword } = require('./server/auth');
const Shared = require('./public/js/shared');
const { PERM_AREAS, MASTER_COLS, areaOf, REPORT_AREA, levelAtLeast } = Shared;

const PORT = process.env.PORT || 3000;
// HOST: leave unset on an office PC (reachable from the LAN). On an internet server set HOST=127.0.0.1
// so only the HTTPS front end (Nginx) can reach the ERP. TRUST_PROXY=1 when running behind Nginx.
const HOST = process.env.HOST || undefined;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
};

// Collections exposed over the API. `prefix` => documents get an auto number. `admin` => admin only.
const COLS = {
  units: {}, items: {}, parties: {}, locations: {}, machines: {}, processes: {}, boms: {}, priceList: {},
  purchaseOrders: { prefix: 'PO' }, grn: { prefix: 'GRN' }, purchaseBills: { prefix: 'PB' }, payments: { prefix: 'PAY' },
  transfers: { prefix: 'TRF' }, stockAdjust: { prefix: 'ADJ' },
  knitting: { prefix: 'KNT' }, dyeing: { prefix: 'DYE' }, finishing: { prefix: 'FIN' }, overheads: { prefix: 'OH' },
  salesOrders: { prefix: 'SO' }, deliveries: { prefix: 'DC' }, invoices: { prefix: 'INV' }, receipts: { prefix: 'RCT' },
  users: { admin: true }, roles: { admin: true },
};

db.load();
seed.ensureBase(db.data);
db.save();

/* ---------------- sessions ---------------- */
const sessions = new Map();
const SESSION_MS = 12 * 3600e3;

function currentUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) { if (s) sessions.delete(token); return null; }
  s.exp = Date.now() + SESSION_MS;
  const u = db.data.users.find(x => x.id === s.userId && x.active !== false);
  return u ? Object.assign({ token }, u) : null;
}
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, department: u.department || '', active: u.active !== false, createdAt: u.createdAt });

/* ---------------- permissions ---------------- */
// Admin has everything. Everyone else gets the levels of their role (read live, so role edits apply at once).
function permsOf(user) {
  if (user.role === 'admin') return Object.fromEntries(PERM_AREAS.map(a => [a.k, a.viewOnly ? 'view' : 'full']));
  const role = db.data.roles.find(r => r.id === user.role);
  return Object.assign({}, role ? role.perms : {});
}
const roleName = user => user.role === 'admin' ? 'Administrator' : ((db.data.roles.find(r => r.id === user.role) || {}).name || 'No role');
const can = (user, area, level) => user.role === 'admin' || (area !== 'admin' && levelAtLeast(permsOf(user)[area], level));
const session = user => ({ user: Object.assign(publicUser(user), { roleName: roleName(user) }), perms: permsOf(user), isAdmin: user.role === 'admin' });
const denied = () => fail(403, 'Your login does not have access to this. Ask the administrator to change your role.');

/* ---------------- sign-in protection ---------------- */
// After 5 wrong passwords for the same username from the same address, or 30 from one address,
// sign-in from there is paused for 15 minutes. A correct sign-in clears the count.
const LOCK_MS = 15 * 60e3;
const attempts = new Map();
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
function loginBlocked(keys) {
  const now = Date.now();
  for (const k of keys) { const a = attempts.get(k); if (a && a.until > now) return Math.ceil((a.until - now) / 60e3); }
  return 0;
}
function loginFailed(keys) {
  const now = Date.now();
  keys.forEach((k, i) => {
    const limit = i === 0 ? 5 : 30;
    const a = attempts.get(k) || { n: 0, first: now, until: 0 };
    if (now - a.first > LOCK_MS) { a.n = 0; a.first = now; }
    a.n++;
    if (a.n >= limit) { a.until = now + LOCK_MS; a.n = 0; a.first = now; }
    attempts.set(k, a);
  });
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.until < now && now - a.first > LOCK_MS) attempts.delete(k); }, 10 * 60e3).unref();

/* ---------------- helpers ---------------- */
function send(res, status, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS, headers || {}));
  res.end(data);
}
const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 20e6) { reject(fail(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(fail(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
    fs.createReadStream(file).pipe(res);
  });
}

// Is this record id referenced by any other record? (prevents deleting used masters / linked docs)
function referencedBy(id, selfCol) {
  const needle = '"' + id + '"';
  for (const col of Object.keys(COLS)) {
    for (const r of db.data[col]) {
      if (r.id === id) continue;
      const json = JSON.stringify(r);
      if (json.includes(needle)) return (engine.DOC_LABELS[col] || col) + ' ' + (r.no || r.name || r.code || '');
    }
  }
  void selfCol;
  return null;
}

// Reject a change that would make any stock go negative (unless settings allow it).
function checkStock(col, trialData) {
  if (!engine.STOCK_COLS.includes(col) || db.data.settings.allowNegativeStock) return;
  const before = new Set(engine.compute(db.data).errors.map(e => e.key));
  const fresh = engine.compute(trialData).errors.filter(e => !before.has(e.key));
  if (fresh.length) {
    const items = Object.fromEntries(db.data.items.map(i => [i.id, i.name]));
    const locs = Object.fromEntries(db.data.locations.map(l => [l.id, l.name]));
    const e = fresh[0];
    throw fail(400, 'Not enough stock: ' + (items[e.item] || 'item') + (e.lot ? ' (lot ' + e.lot + ')' : '') + ' at ' + (locs[e.loc] || e.loc) + ' is short by ' + e.short + (e.docNo && e.date ? ' on ' + e.date : '') + '.');
  }
}

/* ---------------- CRUD ---------------- */
function saveRecord(col, body, user, existing) {
  const meta = COLS[col];
  const doc = Object.assign({}, body);
  for (const k of ['id', 'no', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'salt', 'hash', 'system']) delete doc[k];
  const stamp = new Date().toISOString();
  if (existing) Object.assign(doc, { id: existing.id, no: existing.no, createdAt: existing.createdAt, createdBy: existing.createdBy, updatedAt: stamp, updatedBy: user.username, system: existing.system });
  else Object.assign(doc, { id: col === 'locations' && body.id && /^[A-Z0-9_]{2,12}$/.test(body.id) && !db.data.locations.some(l => l.id === body.id) ? body.id : db.newId(), createdAt: stamp, createdBy: user.username });
  if (!doc.system) delete doc.system;

  if (col === 'users') {
    const pw = doc.password; delete doc.password;
    if (pw) { if (String(pw).length < 6) throw fail(400, 'Password must be at least 6 characters'); Object.assign(doc, hashPassword(pw)); }
    else if (existing) { doc.salt = existing.salt; doc.hash = existing.hash; }
    else throw fail(400, 'Password is required');
    doc.active = doc.active !== false;
    if (existing && existing.id === user.id && (doc.role !== 'admin' || !doc.active)) throw fail(400, 'You cannot remove your own admin access');
  }

  engine.prepare(col, doc, db.data);
  engine.validate(col, doc, db.data);

  const list = db.data[col];
  const trial = Object.assign({}, db.data, { [col]: existing ? list.map(r => r.id === doc.id ? doc : r) : list.concat([doc]) });
  checkStock(col, trial);

  if (!existing && meta.prefix) doc.no = db.nextNo(col, meta.prefix);
  if (existing) db.data[col] = list.map(r => r.id === doc.id ? doc : r);
  else list.push(doc);
  db.save();
  return col === 'users' ? publicUser(doc) : doc;
}

function deleteRecord(col, id) {
  const rec = db.data[col].find(r => r.id === id);
  if (!rec) throw fail(404, 'Record not found');
  if (rec.system) throw fail(400, 'This is a built-in record and cannot be deleted');
  const ref = col === 'roles'
    ? (db.data.users.some(u => u.role === id) ? 'user ' + db.data.users.find(u => u.role === id).username : null)
    : referencedBy(id, col);
  if (ref) throw fail(400, 'Cannot delete: it is used in ' + ref.trim());
  const trial = Object.assign({}, db.data, { [col]: db.data[col].filter(r => r.id !== id) });
  checkStock(col, trial);
  db.data[col] = trial[col];
  db.save();
}

/* ---------------- API router ---------------- */
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const method = req.method;
  const q = Object.fromEntries(url.searchParams.entries());

  if (parts[0] === 'login' && method === 'POST') {
    const { username, password } = await readBody(req);
    const ip = clientIp(req);
    const keys = [ip + '|' + String(username || '').trim().toLowerCase(), ip];
    const wait = loginBlocked(keys);
    if (wait) throw fail(429, 'Too many wrong passwords. Sign-in is paused for ' + wait + ' minute' + (wait === 1 ? '' : 's') + '.');
    // Compare trimmed on both sides so a stray space typed when the user was created can't lock them out.
    const u = db.data.users.find(x => String(x.username || '').trim().toLowerCase() === String(username || '').trim().toLowerCase());
    if (!u || u.active === false || !verifyPassword(password || '', u.salt, u.hash)) { loginFailed(keys); throw fail(401, 'Wrong username or password'); }
    attempts.delete(keys[0]);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userId: u.id, exp: Date.now() + SESSION_MS });
    return send(res, 200, Object.assign({ token }, session(u)));
  }

  const user = currentUser(req);
  if (!user) throw fail(401, 'Please sign in');

  if (parts[0] === 'logout') { sessions.delete(user.token); return send(res, 200, { ok: true }); }
  if (parts[0] === 'me') {
    if (method === 'PUT') { // change own password
      const { current, password } = await readBody(req);
      if (!verifyPassword(current || '', user.salt, user.hash)) throw fail(400, 'Current password is wrong');
      if (!password || String(password).length < 6) throw fail(400, 'New password must be at least 6 characters');
      const u = db.data.users.find(x => x.id === user.id);
      Object.assign(u, hashPassword(password));
      db.save();
    }
    return send(res, 200, session(user));
  }

  if (parts[0] === 'settings') {
    if (method === 'PUT') {
      if (user.role !== 'admin') throw fail(403, 'Only an administrator can change settings');
      const body = await readBody(req);
      const next = Object.assign({}, db.data.settings, body);
      if (next.gstin) next.gstin = String(next.gstin).trim().toUpperCase();
      const bad = Shared.checkGstin(next.gstin, next.state);
      if (bad) throw fail(400, 'Company ' + bad);
      db.data.settings = next;
      db.save();
    }
    return send(res, 200, db.data.settings);
  }

  if (parts[0] === 'report' && parts[1] && method === 'GET') {
    const area = REPORT_AREA[parts[1]];
    if (area && !can(user, area, 'view')) throw denied();
    return send(res, 200, engine.report(parts[1], db.data, q, db.version, permsOf(user)));
  }

  if (parts[0] === 'backup' && method === 'GET') {
    if (user.role !== 'admin') throw fail(403, 'Only an administrator can download backups');
    const day = new Date().toISOString().slice(0, 10);
    if (q.format === 'sqlite') { // the database file itself, e.g. to open in DB Browser for SQLite
      const tmp = path.join(require('os').tmpdir(), 'erp-' + crypto.randomBytes(6).toString('hex') + '.sqlite');
      db.copyTo(tmp);
      const buf = fs.readFileSync(tmp);
      fs.unlinkSync(tmp);
      res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="erp-' + day + '.sqlite"' });
      return res.end(buf);
    }
    return send(res, 200, JSON.stringify(db.data), { 'Content-Disposition': 'attachment; filename="erp-backup-' + day + '.json"' });
  }
  if (parts[0] === 'restore' && method === 'POST') {
    if (user.role !== 'admin') throw fail(403, 'Only an administrator can restore backups');
    const body = await readBody(req);
    if (!body || !Array.isArray(body.users) || !body.users.length) throw fail(400, 'This file is not an ERP backup');
    db.copyTo(db.FILE.replace(/\.sqlite$/, '') + '-before-restore-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite');
    db.replace(body);
    seed.ensureBase(db.data); db.save();
    sessions.clear();
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'demo' && method === 'POST') {
    if (user.role !== 'admin') throw fail(403, 'Only an administrator can load demo data');
    try { seed.loadDemo(db.data); } catch (e) { throw fail(400, e.message); }
    db.save();
    return send(res, 200, { ok: true });
  }

  const col = parts[0], id = parts[1];
  if (!COLS[col]) throw fail(404, 'Unknown resource');
  const out = r => col === 'users' ? publicUser(r) : r;
  const isMaster = MASTER_COLS.includes(col);
  // Admin-only collections; masters are readable by everyone (needed to fill dropdowns).
  if (COLS[col].admin && user.role !== 'admin' && !(col === 'roles' && method === 'GET')) throw denied();
  const mayView = r => isMaster || COLS[col].admin || can(user, areaOf(col, r), 'view');
  const mayWrite = (r, level) => can(user, areaOf(col, r), level);

  if (method === 'GET') {
    if (id) { const r = db.data[col].find(x => x.id === id); if (!r) throw fail(404, 'Record not found'); if (!mayView(r)) throw denied(); return send(res, 200, out(r)); }
    return send(res, 200, db.data[col].filter(mayView).map(out));
  }
  if (method === 'POST' && !id) {
    const body = await readBody(req);
    if (!mayWrite(body, 'edit')) throw denied();
    return send(res, 201, saveRecord(col, body, user, null));
  }
  if (method === 'PUT' && id) {
    const existing = db.data[col].find(x => x.id === id);
    if (!existing) throw fail(404, 'Record not found');
    const body = await readBody(req);
    if (!mayWrite(existing, 'edit') || !mayWrite(body, 'edit')) throw denied();
    return send(res, 200, saveRecord(col, body, user, existing));
  }
  if (method === 'DELETE' && id) {
    const existing = db.data[col].find(x => x.id === id);
    if (!existing) throw fail(404, 'Record not found');
    if (!mayWrite(existing, 'full')) throw fail(403, 'Your login is not allowed to delete this');
    if (col === 'users' && id === user.id) throw fail(400, 'You cannot delete yourself');
    deleteRecord(col, id);
    return send(res, 200, { ok: true });
  }
  throw fail(405, 'Method not allowed');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'Server error: ' + e.message : e.message });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
  serveStatic(req, res, url.pathname);
});

// Daily automatic backup while the server runs (AUTO_BACKUP=0 turns it off). Checked shortly after
// start and then every hour; at most one backup per calendar day.
const backup = require('./server/backup');
function autoBackup() {
  try {
    if (backup.backedUpToday(db.DIR)) return;
    const r = backup.runBackup({ dataDir: db.DIR, copyTo: f => db.copyTo(f) });
    console.log('Daily backup saved: ' + r.file);
  } catch (e) { console.error('Daily backup failed: ' + e.message); }
}
if (process.env.AUTO_BACKUP !== '0') {
  setTimeout(autoBackup, +process.env.AUTO_BACKUP_FIRST_MS || 60e3).unref();
  setInterval(autoBackup, 60 * 60e3).unref();
}

// Close the database cleanly on Ctrl + C / window close.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { db.close(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('Majumdaar Hosiery ERP running at http://' + (HOST || 'localhost') + ':' + PORT);
  const adm = db.data.users.find(u => u.username === 'admin' && u.active !== false);
  if (adm && verifyPassword('admin123', adm.salt, adm.hash)) console.log('WARNING: the admin password is still the default (admin123). Change it in Settings before using the ERP on a network or the internet.');
  console.log('Database: ' + db.FILE + ' (SQLite)');
  if (db.migratedFrom) {
    const n = db.COLLECTIONS.reduce((s, c) => s + db.data[c].length, 0);
    console.log('Imported ' + n + ' records from ' + db.migratedFrom + ' into the new database. That JSON file was left unchanged as a safety copy.');
  }
  if (db.data.users.length === 1 && db.data.users[0].username === 'admin') console.log('Default login: admin / admin123 (change it after first login)');
});

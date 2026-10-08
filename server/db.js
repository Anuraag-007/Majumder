'use strict';
/*
 * SQLite storage, using the SQLite engine built into Node.js (node:sqlite) - nothing to install.
 *
 * File: data/erp.sqlite. One table per collection (items, parties, invoices, knitting ...):
 *   id         primary key
 *   data       the full record as JSON
 *   doc_no, doc_date, label   read-only columns pulled out of the JSON for browsing / querying
 *   updated_at when the row was last written
 * plus a `meta` table holding settings, document counters and the schema version.
 *
 * The whole dataset is also kept in memory (db.data) because the business engine replays every
 * document to build stock and costs. db.save() compares memory with what is on disk and writes only
 * the rows that changed, all inside one transaction: a save is written completely or not at all.
 *
 * First start: if the database is new and an old data/db.json exists, it is imported automatically.
 * db.json itself is never changed or removed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) {
  console.error('This ERP needs Node.js 22.13 or newer (it uses the SQLite engine built into Node).');
  console.error('Download the LTS version from https://nodejs.org and start the ERP again.');
  process.exit(1);
}

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'erp.sqlite');
const LEGACY_JSON = path.join(DIR, 'db.json');
const SCHEMA_VERSION = 1;

const COLLECTIONS = [
  'users', 'roles', 'units', 'items', 'parties', 'locations', 'machines', 'processes', 'boms', 'priceList',
  'purchaseOrders', 'grn', 'purchaseBills', 'payments',
  'transfers', 'stockAdjust', 'knitting', 'dyeing', 'finishing', 'overheads',
  'salesOrders', 'deliveries', 'invoices', 'receipts',
];

const DEFAULT_SETTINGS = {
  companyName: 'Majumdaar Hosiery',
  address: '',
  city: '',
  state: 'West Bengal',
  gstin: '',
  phone: '',
  email: '',
  bankDetails: '',
  valuation: 'AVG',          // AVG | FIFO for store items
  allowNegativeStock: false,
  invoiceTerms: 'Goods once sold will not be taken back. Interest @18% p.a. will be charged on overdue bills.',
};

const db = { data: null, DIR, FILE, LEGACY_JSON, COLLECTIONS, version: 0, migratedFrom: null };

let conn = null;
const stmt = {};          // prepared statements per collection
const onDisk = {};        // collection -> Map(id -> JSON string as stored)
let metaOnDisk = {};      // meta key -> JSON string as stored

function normalize(d) {
  for (const c of COLLECTIONS) if (!Array.isArray(d[c])) d[c] = [];
  d.counters = d.counters || {};
  d.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  return d;
}

function open() {
  fs.mkdirSync(DIR, { recursive: true });
  conn = new DatabaseSync(FILE);
  // WAL is fastest and safest on a normal disk. Some shared-hosting file systems don't support it:
  // set SQLITE_JOURNAL=DELETE there.
  const journal = /^(WAL|DELETE|TRUNCATE)$/i.test(process.env.SQLITE_JOURNAL || '') ? process.env.SQLITE_JOURNAL.toUpperCase() : 'WAL';
  conn.exec('PRAGMA journal_mode = ' + journal + '; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const c of COLLECTIONS) {
    conn.exec(`CREATE TABLE IF NOT EXISTS "${c}" (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      doc_no TEXT GENERATED ALWAYS AS (json_extract(data, '$.no')) VIRTUAL,
      doc_date TEXT GENERATED ALWAYS AS (json_extract(data, '$.date')) VIRTUAL,
      label TEXT GENERATED ALWAYS AS (coalesce(json_extract(data, '$.name'), json_extract(data, '$.username'), json_extract(data, '$.lotNo'), json_extract(data, '$.code'))) VIRTUAL,
      updated_at TEXT
    )`);
    stmt[c] = {
      all: conn.prepare(`SELECT id, data FROM "${c}" ORDER BY rowid`),
      upsert: conn.prepare(`INSERT INTO "${c}" (id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
      del: conn.prepare(`DELETE FROM "${c}" WHERE id = ?`),
    };
  }
  stmt.metaGet = conn.prepare('SELECT key, value FROM meta');
  stmt.metaSet = conn.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
}

db.load = function () {
  if (!conn) open();
  metaOnDisk = {};
  for (const r of stmt.metaGet.all()) metaOnDisk[r.key] = r.value;
  const isNew = !metaOnDisk.schema;
  let d;
  if (isNew) {
    // Brand-new database: bring over the old JSON data if there is any.
    d = {};
    if (fs.existsSync(LEGACY_JSON)) {
      d = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8') || '{}');
      db.migratedFrom = LEGACY_JSON;
    }
    for (const c of COLLECTIONS) onDisk[c] = new Map();
  } else {
    d = { settings: JSON.parse(metaOnDisk.settings || '{}'), counters: JSON.parse(metaOnDisk.counters || '{}') };
    for (const c of COLLECTIONS) {
      onDisk[c] = new Map();
      d[c] = stmt[c].all.all().map(r => { onDisk[c].set(r.id, r.data); return JSON.parse(r.data); });
    }
  }
  db.data = normalize(d);
  if (isNew) db.save();
  db.version++;
  return db.data;
};

// Write every change since the last save in one transaction.
db.save = function () {
  const stamp = new Date().toISOString();
  const nextDisk = {};
  const nextMeta = {
    schema: JSON.stringify(SCHEMA_VERSION),
    settings: JSON.stringify(db.data.settings),
    counters: JSON.stringify(db.data.counters),
  };
  conn.exec('BEGIN IMMEDIATE');
  try {
    for (const c of COLLECTIONS) {
      const before = onDisk[c] || new Map();
      const after = new Map();
      for (const r of db.data[c]) {
        if (!r || !r.id) continue;
        const json = JSON.stringify(r);
        after.set(r.id, json);
        if (before.get(r.id) !== json) stmt[c].upsert.run(r.id, json, stamp);
      }
      for (const id of before.keys()) if (!after.has(id)) stmt[c].del.run(id);
      nextDisk[c] = after;
    }
    for (const [k, v] of Object.entries(nextMeta)) if (metaOnDisk[k] !== v) stmt.metaSet.run(k, v);
    conn.exec('COMMIT');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch (x) { /* already rolled back */ }
    throw e;
  }
  Object.assign(onDisk, nextDisk);
  metaOnDisk = Object.assign({}, metaOnDisk, nextMeta);
  db.version++;
};

db.replace = function (d) {
  db.data = normalize(d);
  db.save();
};

// Consistent copy of the whole database to another file (safe while the ERP is running).
db.copyTo = function (file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  conn.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
};

db.close = function () {
  if (conn) { try { conn.close(); } catch (e) { /* ignore */ } conn = null; }
};

db.newId = () => crypto.randomBytes(8).toString('hex');

db.nextNo = function (col, prefix) {
  const n = (db.data.counters[col] || 0) + 1;
  db.data.counters[col] = n;
  return prefix + '-' + String(n).padStart(4, '0');
};

db.normalize = normalize;
module.exports = db;

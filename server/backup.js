'use strict';
/*
 * Database backups.
 *   node server/backup.js        make one backup now (e.g. from cron on a VPS)
 * The running server also calls runBackup() once a day by itself (see server.js), so on managed
 * hosting nothing has to be scheduled.
 *
 * Each backup is a consistent copy of data/erp.sqlite (safe while the ERP is running), saved as
 * <data>/backups/erp-YYYY-MM-DD_HHMM.sqlite. The newest 30 are kept.
 *   BACKUP_DIR=/path   put the copies somewhere else
 *   BACKUP_KEEP=60     keep a different number of copies
 */
const fs = require('fs');
const path = require('path');

const pad = n => String(n).padStart(2, '0');
const NAME = /^erp-\d{4}-\d{2}-\d{2}_\d{4}\.sqlite$/;

function backupDir(dataDir) { return process.env.BACKUP_DIR || path.join(dataDir, 'backups'); }

// copyTo(target) must write a consistent copy of the live database to `target`.
function runBackup({ dataDir, copyTo }) {
  const out = backupDir(dataDir);
  const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP || '30', 10));
  fs.mkdirSync(out, { recursive: true });
  const d = new Date();
  const name = 'erp-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + '.sqlite';
  const target = path.join(out, name);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  copyTo(target);
  const removed = [];
  const copies = fs.readdirSync(out).filter(f => NAME.test(f)).sort().reverse();
  for (const old of copies.slice(keep)) { fs.unlinkSync(path.join(out, old)); removed.push(old); }
  return { file: target, size: fs.statSync(target).size, removed };
}

// Has a backup already been made today?
function backedUpToday(dataDir) {
  const out = backupDir(dataDir);
  if (!fs.existsSync(out)) return false;
  const d = new Date();
  const prefix = 'erp-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_';
  return fs.readdirSync(out).some(f => NAME.test(f) && f.startsWith(prefix));
}

module.exports = { runBackup, backedUpToday, backupDir };

if (require.main === module) {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dataDir, 'erp.sqlite');
  if (!fs.existsSync(file)) { console.error('No database found at ' + file); process.exit(1); }
  const r = runBackup({
    dataDir,
    copyTo: target => {
      const conn = new DatabaseSync(file);
      conn.exec('PRAGMA busy_timeout = 10000');
      conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      conn.close();
    },
  });
  const check = new DatabaseSync(r.file, { readOnly: true });
  const users = check.prepare('SELECT count(*) n FROM users').get().n;
  check.close();
  console.log('Backup written: ' + r.file + ' (' + Math.round(r.size / 1024) + ' KB, ' + users + ' users)');
  for (const old of r.removed) console.log('Removed old backup ' + old);
}

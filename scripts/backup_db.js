#!/usr/bin/env node
/**
 * Safe DB snapshot. Uses the SQLite online backup API so the running bot is
 * never interrupted and the copy is always transactionally consistent.
 *
 *   node scripts/backup_db.js [label]
 *
 * Keeps the newest KEEP backups in ./backups and deletes the rest.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'database.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const KEEP = parseInt(process.env.BACKUP_KEEP || '20', 10);

function stamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backup] database not found at ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const label = (process.argv[2] || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dest = path.join(BACKUP_DIR, `database.${stamp()}.${label}.sqlite`);

  const src = new Database(DB_PATH, { readonly: true });
  try {
    src.backup(dest);
  } finally {
    src.close();
  }

  const size = fs.statSync(dest).size;
  console.log(`[backup] wrote ${path.relative(ROOT, dest)} (${(size / 1024).toFixed(1)} KiB)`);

  // Prune old backups with the same prefix pattern.
  const all = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^database\.\d{8}-\d{6}\..*\.sqlite$/.test(f))
    .sort();
  const stale = all.slice(0, Math.max(0, all.length - KEEP));
  for (const f of stale) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[backup] pruned ${f}`);
  }
}

main();

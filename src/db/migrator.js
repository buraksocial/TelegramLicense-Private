/**
 * Forward-only, idempotent migration runner.
 *
 * Rules that make this safe to run on a live VDS database:
 *   - Every migration runs inside a transaction and is recorded in
 *     schema_migrations, so it never runs twice.
 *   - Migrations are ADDITIVE ONLY: CREATE TABLE IF NOT EXISTS,
 *     ALTER TABLE ... ADD COLUMN (guarded), and data backfills that are
 *     written to be re-runnable. Nothing here ever drops a column or table.
 *   - If a migration throws, the DB is rolled back to before it and the
 *     process exits non-zero, so the bot never starts half-migrated.
 *
 * Usage: require('./migrator').run(db)
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function appliedIds(db) {
  return new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
}

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.js$/.test(f))
    .sort()
    .map((f) => {
      const mod = require(path.join(MIGRATIONS_DIR, f));
      return { id: f.replace(/\.js$/, ''), up: mod.up, label: mod.label || f };
    });
}

/** Add a column only if it is missing — the workhorse of additive migrations. */
function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

function hasTable(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function run(db, { log = console.log } = {}) {
  ensureTable(db);
  const done = appliedIds(db);
  const migrations = loadMigrations().filter((m) => !done.has(m.id));

  if (migrations.length === 0) {
    log('[migrations] up to date');
    return { applied: [] };
  }

  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const applied = [];

  for (const m of migrations) {
    const started = Date.now();
    log(`[migrations] applying ${m.id} ...`);
    try {
      db.transaction(() => {
        m.up(db, { addColumn, hasTable });
        record.run(m.id);
      })();
      applied.push(m.id);
      log(`[migrations] ✓ ${m.id} (${Date.now() - started}ms)`);
    } catch (err) {
      console.error(`[migrations] ✗ ${m.id} FAILED: ${err.message}`);
      console.error('[migrations] aborting; database left at last good migration.');
      throw err;
    }
  }

  return { applied };
}

module.exports = { run, addColumn, hasTable, MIGRATIONS_DIR };

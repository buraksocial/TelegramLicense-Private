/**
 * CatalogStore — the single source of truth for supplier product data.
 *
 * The old design polled per product (N products => N requests => 429 storms).
 * Here one refresher pulls a supplier's ENTIRE catalog with ONE request per
 * poll_interval_ms and writes it to supplier_catalogs; every consumer
 * (pricing engine, user menus, matching, translation, watchdog) reads the
 * local table. Live reads fall back to the DB snapshot when the governor is
 * still cooling down, so the bot degrades gracefully instead of hammering.
 */
const crypto = require('crypto');
const { db } = require('../db');
const { getGovernor } = require('./RateGovernor');
const { CATALOG_MAX_AGE_MS } = require('../constants');
const { classifyWarranty } = require('../utils/warranty');

const memory = new Map(); // supplierId -> { services, fetchedAt }
const inFlight = new Map(); // supplierId -> Promise
const balanceCache = new Map(); // supplierId -> { value, expires }
const BALANCE_TTL = 15000;

function hash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function getAdapter(supplier) {
  const registry = require('./adapterRegistry');
  const adapter = registry.forSupplier(supplier);
  if (!adapter) throw new Error(`No adapter for supplier type ${supplier.type}`);
  return adapter;
}

/** Rows from the DB snapshot (may be stale; callers check age). */
function readSnapshot(supplierId) {
  const rows = db
    .prepare('SELECT * FROM supplier_catalogs WHERE supplier_id = ?')
    .all(supplierId);
  return rows.map((r) => ({
    remote_service_id: r.remote_service_id,
    name: r.name,
    description: r.description,
    category_raw: r.category_raw,
    price_usd: r.price_usd,
    stock: r.stock,
    tiers: r.tiers_json ? JSON.parse(r.tiers_json) : null,
    warranty: r.warranty || 'unknown',
    content_hash: r.content_hash,
    fetched_at: r.fetched_at
  }));
}

/**
 * Return the freshest possible catalog for a supplier without ever exceeding
 * its rate limit:
 *  1. in-flight refresh -> await it
 *  2. memory snapshot fresh enough -> use it
 *  3. governor ready -> fire ONE catalog request, store, return
 *  4. governor cooling -> serve DB/memory snapshot even if slightly stale
 */
async function getCatalog(supplier, { maxAgeMs = CATALOG_MAX_AGE_MS, force = false } = {}) {
  const mem = memory.get(supplier.id);
  const fresh = mem && Date.now() - mem.fetchedAt < maxAgeMs;
  if (fresh && !force) return mem.services;

  if (!force && inFlight.has(supplier.id)) return inFlight.get(supplier.id);

  const governor = getGovernor(supplier);
  const canAfford = governor.waitTime('/api/v1/products') === 0 || governor.waitTime('/reseller/api/') === 0;

  if (!canAfford) {
    // Serve what we have (memory, then DB); null only if we never fetched.
    if (mem) return mem.services;
    const snap = readSnapshot(supplier.id);
    return snap.length ? snap : null;
  }

  const task = (async () => {
    try {
      const adapter = getAdapter(supplier);
      const services = await adapter.fetchCatalog(supplier);
      // classify warranty on the LIVE objects too (memory serves these directly;
      // the DB snapshot is classified inside upsertRows)
      for (const s of services) {
        if (!s.warranty) s.warranty = classifyWarranty(`${s.name || ''} ${s.description || ''}`);
      }
      const fetchedAt = Date.now();
      memory.set(supplier.id, { services, fetchedAt });
      upsertRows(supplier.id, services);
      db.prepare('UPDATE suppliers SET last_error = NULL, last_ok_at = CURRENT_TIMESTAMP WHERE id = ?').run(supplier.id);
      return services;
    } catch (err) {
      db.prepare('UPDATE suppliers SET last_error = ? WHERE id = ?').run(String(err.message).slice(0, 500), supplier.id);
      console.error(`[CatalogStore] ${supplier.type}#${supplier.id} fetch failed:`, err.message);
      if (mem) return mem.services; // degrade to stale
      const snap = readSnapshot(supplier.id);
      return snap.length ? snap : null;
    } finally {
      inFlight.delete(supplier.id);
    }
  })();

  inFlight.set(supplier.id, task);
  return task;
}

const upsert = db.prepare(`
  INSERT INTO supplier_catalogs
    (supplier_id, remote_service_id, name, description, category_raw, price_usd, stock, tiers_json, currency, content_hash, warranty, fetched_at)
  VALUES (@supplier_id, @remote_service_id, @name, @description, @category_raw, @price_usd, @stock, @tiers_json, @currency, @content_hash, @warranty, CURRENT_TIMESTAMP)
  ON CONFLICT (supplier_id, remote_service_id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    category_raw = excluded.category_raw,
    price_usd = excluded.price_usd,
    stock = excluded.stock,
    tiers_json = excluded.tiers_json,
    currency = excluded.currency,
    content_hash = excluded.content_hash,
    warranty = excluded.warranty,
    fetched_at = CURRENT_TIMESTAMP
`);

function upsertRows(supplierId, services) {
  const write = db.transaction((rows) => {
    const seen = new Set();
    for (const s of rows) {
      const h = hash({ n: s.name, d: s.description, p: s.price_usd, t: s.tiers });
      upsert.run({
        supplier_id: supplierId,
        remote_service_id: s.remote_service_id,
        name: s.name || '',
        description: s.description || '',
        category_raw: s.category_raw || '',
        price_usd: s.price_usd ?? null,
        stock: s.stock ?? null,
        tiers_json: s.tiers ? JSON.stringify(s.tiers.map((t) => ({ ...t, max: t.max === Infinity ? null : t.max }))) : null,
        currency: s.currency || 'USD',
        content_hash: h,
        warranty: classifyWarranty(`${s.name || ''} ${s.description || ''}`)
      });
      seen.add(s.remote_service_id);
    }
    // Remove vanished services so sold-out-forever items don't linger.
    const existing = db
      .prepare('SELECT remote_service_id FROM supplier_catalogs WHERE supplier_id = ?')
      .all(supplierId)
      .map((r) => r.remote_service_id);
    const del = db.prepare('DELETE FROM supplier_catalogs WHERE supplier_id = ? AND remote_service_id = ?');
    for (const id of existing) if (!seen.has(id)) del.run(supplierId, id);
  });
  write(services);
}

async function getBalance(supplier) {
  const hit = balanceCache.get(supplier.id);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const adapter = getAdapter(supplier);
    const value = await adapter.getBalance(supplier);
    balanceCache.set(supplier.id, { value, expires: Date.now() + BALANCE_TTL });
    return value;
  } catch (err) {
    // Serve last known balance (even if expired) rather than guessing.
    return hit ? hit.value : null;
  }
}

function invalidateBalance(supplierId) {
  balanceCache.delete(supplierId);
}

function invalidateCatalog(supplierId) {
  memory.delete(supplierId);
}

module.exports = { getCatalog, getBalance, invalidateBalance, invalidateCatalog, readSnapshot, hash };

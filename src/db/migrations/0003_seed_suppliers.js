/**
 * 0003 — Seed / repair suppliers from env (idempotent).
 *
 * Fixes the dead LootPaglu ngrok URL, registers the three new suppliers
 * (AIVault, Cuppon, Bunny) and normalises their behaviour flags. Runs on the
 * VDS against live data without deleting anything: it only INSERTs missing
 * rows and UPDATEs the credential/behaviour fields it owns.
 */
const { SUPPLIERS } = require('../../config/env');

// adapter key -> [name, behaviour]
const SPEC = {
  lootpaglu: {
    name: 'LootPaglu (Paglu_Shopp_Bot)',
    currency: 'crypto', // settle in USDT/crypto so usd_rate = 1
    usd_rate: 1,
    supports_tiers: 1,
    price_protected: 0,
    delivery_mode: 'instant',
    poll_interval_ms: 60000
  },
  aivault: {
    name: 'AIVault Hub (Gemini_Shop_Robot)',
    currency: 'USD',
    usd_rate: 1,
    supports_tiers: 1,
    price_protected: 0,
    delivery_mode: 'instant',
    poll_interval_ms: 60000
  },
  cuppon: {
    name: "Cuppon'sHub (Cupponbot)",
    currency: 'USDT',
    usd_rate: 1,
    supports_tiers: 0,
    price_protected: 0,
    delivery_mode: 'instant',
    poll_interval_ms: 60000
  },
  bunny: {
    name: 'Bunny AI (bunnytoolss_bot)',
    currency: 'USD',
    usd_rate: 1,
    supports_tiers: 0,
    price_protected: 1, // order/create requires selling_price >= base_price
    delivery_mode: 'instant',
    poll_interval_ms: 60000
  },
  aiversexhub: {
    name: 'AIVerse X Hub (AIVerseXBot)',
    currency: 'USDT',
    usd_rate: 1,
    supports_tiers: 0,
    price_protected: 0,
    delivery_mode: 'instant',
    poll_interval_ms: 120000 // hard 1 req / 10s per endpoint -> poll slowly
  },
  uniqueaizone: {
    name: 'Unique AI Zone (UniqueAIZone_bot)',
    currency: 'USDT',
    usd_rate: 1,
    supports_tiers: 0,
    price_protected: 0,
    delivery_mode: 'instant',
    poll_interval_ms: 120000
  }
};

module.exports = {
  label: 'seed & repair suppliers',
  up(db) {
    const getByName = db.prepare('SELECT * FROM suppliers WHERE name = ? OR type = ?');
    const insert = db.prepare(
      'INSERT INTO suppliers (name, type, base_url, api_key, currency, usd_rate, supports_tiers, price_protected, delivery_mode, poll_interval_ms, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,1)'
    );
    const update = db.prepare(`
      UPDATE suppliers
      SET base_url = COALESCE(NULLIF(?, ''), base_url),
          api_key  = COALESCE(NULLIF(?, ''), api_key),
          currency = ?, usd_rate = ?, supports_tiers = ?, price_protected = ?,
          delivery_mode = ?, poll_interval_ms = ?, enabled = 1
      WHERE id = ?
    `);

    for (const [type, spec] of Object.entries(SPEC)) {
      const creds = SUPPLIERS[type] || {};
      const existing = getByName.get(spec.name, type);
      if (!existing) {
        insert.run(
          spec.name, type, creds.base_url || '', creds.api_key || '',
          spec.currency, spec.usd_rate, spec.supports_tiers, spec.price_protected,
          spec.delivery_mode, spec.poll_interval_ms
        );
      } else {
        update.run(
          creds.base_url || '', creds.api_key || '',
          spec.currency, spec.usd_rate, spec.supports_tiers, spec.price_protected,
          spec.delivery_mode, spec.poll_interval_ms, existing.id
        );
      }
    }
  }
};

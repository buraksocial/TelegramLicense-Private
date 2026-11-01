const { db } = require('./index');

function migrate() {
  console.log("Running migration 5...");
  try {
    db.prepare('ALTER TABLE product_suppliers ADD COLUMN manual_tiers TEXT').run();
    console.log("Migration 5: Added manual_tiers to product_suppliers.");
  } catch (err) {
    if (err.message.includes("duplicate column name")) {
      console.log("Migration 5: column manual_tiers already exists.");
    } else {
      console.error("Migration 5 failed:", err);
    }
  }
}

migrate();

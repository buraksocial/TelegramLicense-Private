#!/usr/bin/env bash
# deploy_vds.sh — VDS'de güvenli, sıralı yayın:
#   backup -> pull -> deps -> migrate (initDb idempotent) -> audit -> tests -> pm2 restart
# Kullanım:  ./scripts/deploy_vds.sh [pm2-name]
# pm2-name varsayılan: telegramlisans
set -euo pipefail

PM2_NAME="${1:-telegramlisans}"
cd "$(dirname "$0")/.."

echo "▶️  1/6 Veritabanı yedeği"
node scripts/backup_db.js

echo "▶️  2/6 Kod güncelleme"
git pull --ff-only

echo "▶️  3/6 Bağımlılıklar"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install; fi

echo "▶️  4/6 Migrasyonlar (additive, idempotent)"
node -e "require('./src/db').initDb(); console.log('[migrations] ok')"

echo "▶️  5/6 Testler + para denetimi (salt-okunur)"
node scripts/test_money.js
node scripts/test_pricing.js
node scripts/test_matcher.js
node scripts/audit_money.js || true   # rapor; başarısızliği deploy'u durdurmasın

echo "▶️  6/6 Yayın"
pm2 restart "$PM2_NAME" --update-env
sleep 2
pm2 logs "$PM2_NAME" --lines 25 --nostream

echo "✅ Deploy bitti. Admin panelinden: eşleşme onayı → fiyat modları → kategoriler."

# VDS Deploy — TelegramLisans

Bu proje VDS'de **şu anki sürümle** çalışıyor. Yeni sürüm **ekleyici (additive)** migrasyonlar
içerir; mevcut satış davranışını değiştirmez (0004 tüm ürünleri `pricing_mode='manual'` yapar,
yani dinamik fiyatlar admin ürün bazında açana kadar devreye girmez).

## Gereksinimler
- Node 18+ , pm2, git
- `.env` VDS'de zaten var (BOT_TOKEN, admin id, tedarikçi anahtarları, LLM_*).
  Yeni anahtar gerekirse `.env`'e elle ekle:
  - `SUPPLIER_DRY_RUN=1` → **ilk açılışta önerilir**: tedarikçiye gerçek sipariş gitmez, logla.
  - `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` → çeviri ajanı (yoksa çeviri pasif kalır, bot çalışır).
  - `PRICE_LOCK_TTL_MS` (varsayılan 600000), `MARGIN_ALERT_COOLDOWN_MS` (varsayılan 1800000).

## Adımlar (scripts/deploy_vds.sh otomatize eder)
```bash
cd /path/to/TelegramLisans

# 1) Yedek — database.sqlite korumalı kopya
node scripts/backup_db.js

# 2) Kod güncelle
git pull

# 3) Bağımlılık (yeni paket yok; yine de)
npm ci --omit=dev   # veya npm install

# 4) Migrasyonlar — initDb açılışta idempotent çalıştırır; ön izleme için:
node -e "require('./src/db').initDb()"   # additive, veri silmez

# 5) Para denetimi (salt-okunur): geçmişte 100x bozulmuş kayıt kalmış mı?
node scripts/audit_money.js

# 6) Canlı yayın
pm2 restart telegramlisans --update-env
pm2 logs telegramlisans --lines 50   # "[migrations] up to date" + servis başlangıç logları
```

## İlk açılışta ne olur
- Migrasyon 0001–0004: yeni tablolar (categories, languages, translations, i18n_overrides,
  supplier_catalogs, product_matches, margin_events, alerts, price_locks) + `orders` provenance
  kolonları + tüm ürünlere `pricing_mode='manual'` (davranış değişikliği YOK).
- CatalogPoller tedarikçi kataloglarını 60 sn'lik kadansla çekip `supplier_catalogs`'a yazar
  (rate governor: AIVerseX ailesi global 12 sn aralık — ilk tam katalog ~5–10 dk sürebilir).
- TranslationService kuyruğu doldurur; LLM çevirisi arka planda ~20 dk içinde menüdeki
  bağlı servisleri çevirir (token maliyeti küçük).
- MarginWatchdog 5 dk'da bir karar üretir; sapma olursa admin'e
  "📊 X kadar servis daha düşük kâr ediliyor" mesajı atar (30 dk cooldown).

## Sonra (admin panelinden)
1. ⚙️ API & Otomatik Stok → **🔗 Eşleşme Onayı** → "🧠 Tara" → yüksek skorlu eşleşmeleri onayla
   (onaylanınca `product_suppliers` linki oluşur, fiyat/marj editörleri aktif olur).
2. Ürün detay → **Fiyat Modu** → `max_profit` / `cheapest` / `manual` geçişi (ürün ürün).
3. 🗂 Kategoriler → kategori ekle → **🔗 Ürünleri Kategorile (auto)** → müşteri menüsü
   kategori ızgarasına dönüşür.
4. 🌐 Diller & Çeviri → yeni dil ekle (örn `es İspanyolca`) → ajan tüm metinleri çevirir.
5. Ürün/bağlık marj + taban fiyat editörleri ve sipariş detayında kâr düzenleme hazır.

## Geri alma (rollback)
```bash
pm2 stop telegramlisans
cp backups/database-<en-yeni>.sqlite database.sqlite
git checkout <onceki-tag> && pm2 restart telegramlisans
```
Migrasyonlar geri alınmaz ama **ekleyicidir**: eski kod yeni DB ile çalışmaya devam eder.

## Rate-limit notu
- AIVerseX ailesi (aivault, cuppon, lootpaglu, bunny, aiversex, uniqueaizone aynı API tipinde
  olanlar) anahtar-bağımsız **1 istek/10 sn** global limit: governor 12 sn aralıklı tek bucket.
- 429 alırsan poller'a dokunma; governor retry-backoff uygular. El ile smoke testi
  (`npm run smoke`) 429 cezası süresince başarısız olur — 10–15 dk bekle.

## DRY_RUN'dan canlıya
`.env` → `SUPPLIER_DRY_RUN=1` satırını sil/kapat, `pm2 restart`. İlk siparişte
supplier sipariş ekranından external order id ile doğrula.

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

## Web mağazası (bot ile aynı süreçte)
Bot açılışta `web/server.js`'i `WEB_PORT` (varsayılan 3000) üzerinde başlatır.
`WEB_ENABLED=0` ile kapatılabilir. Yeni npm paketi **yok** — dümdüz `node:http`.

Giriş **yalnızca Telegram Login Widget** ile olur (imza HMAC doğrulaması; sahte
ID ile giriş mümkün değil). Widget'ın çalışması için iki şart:

1. **BotFather → `/setdomain`** (veya "Bot Settings → Menu Button") ile site
   alan adını bağla; widget `data-telegram-login` alan adı bunu kullanır.
2. Sayfa **HTTPS** sunulmalı (widget localhost'ta localhost'a izin verir ama
   gerçek kullanıcı için şart). Nginx reverse proxy örneği:

```nginx
server {
  listen 443 ssl http2;
  server_name magaza.alanadiniz.com;          # BotFather'da kayıtlı alan adı
  ssl_certificate     /etc/letsencrypt/live/magaza.alanadiniz.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/magaza.alanadiniz.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;          # WEB_PORT
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Notlar:
- Web oturumları bellekte (restart'te düşer; kullanıcı widget ile tekrar girer).
- Fiyat/indirim/teslim mantığı bot ile **aynı kod** (`CheckoutService`) — fiyat
  farklılığı gösterilemez.
- Rezervasyon: tükendi üründe "⏳ Rezerve" kutucuğu ile; bot ile aynı kurallar.
- Misafirler katalogu baz fiyatla gezer; sipariş için giriş şart.

## Garanti sınıfları (warranty)
- `products.warranty`: `none` (klasik, filtre yok — canlıdaki tüm eski ürünler),
  `guaranteed` (yalnız garantili servislerden teslim), `instant` (garantili
  stoktan **asla** teslim etmez; unknown kabul eder).
- Servis sınıfı katalog adına göre otomatik sınıflandırılır (`utils/warranty.js`
  regex: warranty/garantie→🛡, instant/no warranty→⚡); admin link detayından
  override edebilir (auto→guaranteed→instant→mixed döngüsü).
- Uyumsuz teklifler müşteri listesinde hiç görünmez, fallback kuyruğuna girmez.

## Public REST API — bot-api.developer.org.tr
`api/server.js` bağımsız bir `node:http` sunucusudur; bot ile **aynı beyin**
(CheckoutService/PricingEngine/RateGovernor) ama ayrı port: `API_PORT`
(varsayılan **3100**), `API_ENABLED=0` ile kapatılır. CORS: `API_CORS_ORIGIN`
(`*` veya alan adı listesi).

- Doküman & deneme konsolu: `https://bot-api.../v1/docs` + `/v1/openapi.json` (public).
- Kimlik: admin panelinden (🔑 API Anahtarları) üretilen `sk-…` anahtarları;
  scope (`read`/`orders`/`wallet`), anahtar başına rpm + günlük kota, bağlanan
  kullanıcı hesabı (siparişler o hesabın bakiye/indiriminden yürür), opsiyonel
  webhook (HMAC-SHA256 imzalı `order.created`).
- Rate limit katmanları: per-IP flood bucket (`API_IP_RPM`, varsayılan 600) +
  per-key token bucket (ağırlıklı maliyet: katalog okuma 1, sipariş 8) + UTC
  günlük kota. Yanıtlarda `X-RateLimit-*` / `Retry-After`.
- Sipariş POST **Idempotency-Key zorunlu** (24 saat replay → aynı sipariş).
- Nginx (Linux):

```nginx
server {
  listen 443 ssl http2;
  server_name bot-api.alanadiniz.com;
  ssl_certificate     /etc/letsencrypt/live/bot-api.alanadiniz.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bot-api.alanadiniz.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3100;           # API_PORT
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # per-IP limit doğru olsun diye
  }
}
```

Windows VDS kurulumunun tamamı (nginx GUI yöneticisi, NSSM/pm2, win-acme,
IPN, yedekleme): **DEPLOY-WINDOWS.md**.

## Binance Pay otomatik yükleme
Müşterinin yapıştırdığı numara `GET /sapi/v1/pay/transactions` geçmişinde
(orderId eşleşmesi) aranır; henüz sonuçlanmamışsa `pending_topups` kuyruğuna
gider ve DepositPoller (3 dk) Binance onayladığı anda **tam bir kez** bakiyeye
yazar (txid UNIQUE + transactions dedup). Kismî ama doğrulanmış ödeme anında
bakiyeye geçer. Bekleyenleri admin paneli 📊 Panel kartında gör.

## Çok ağlı kripto yatırma (kişiye özel cüzdan)
USDT·BEP20 / USDT·Polygon / USDT·TRC20 / TON (memo'lu) / USDT·TON / LTC —
adresi ve ödeme algılamasını bir **agregatör** verir (kendi node'unu
çalıştırmadan). Anahtar tanımlanana kadar özellik bot+web'de görünmez:

```ini
# .env — birini seç
DEPOSIT_PROVIDER=coinpayments
COINPAYMENTS_MERCHANT_ID=...
COINPAYMENTS_API_KEY=...
COINPAYMENTS_API_SECRET=...
COINPAYMENTS_IPN_SECRET=...     # hesap panelinde IPN secret ile AYNI olmalı
# veya
DEPOSIT_PROVIDER=nowpayments
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...

DEPOSIT_NETWORKS=usdt_bep20,usdt_polygon,ton,usdt_ton,ltc,usdt_trc20   # opsiyonel filtre
WEB_PUBLIC_URL=https://bot.developer.org.tr   # NOWPayments ipn_callback_url buradan üretilir
```

- CoinPayments: kalıcı kişiye özel adres (`create_deposit_address`, label=u<id>);
  IPN'i hesap panelinde `https://bot.../ipn/coinpayments` olarak kur
  (form-urlencoded, `X-CoinPay-Signature: HMAC-SHA1`).
- NOWPayments: ödeme başına benzersiz adresli invoice; webhook
  `https://bot.../ipn/nowpayments` (JSON, `x-nowpayments-sig: HMAC-SHA256`) +
  15 dk'lık polling sweep yedek rail.
- Kredi tek noktadan: `deposit_events UNIQUE(provider,ref)` → çift ödeme imkânsız;
  tutar USD'ye normalize edilip bakiyeye yazılır, kullanıcı+admin bildirilir.
- Admin paneli 🌐 Kripto Yatırma sekmesi: cüzdanlar + provider olayları.

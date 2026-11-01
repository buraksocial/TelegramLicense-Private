# Windows VDS Kurulumu — TelegramLisans

Hedef yapı (hepsi TEK Node sürecinde, tek `.env`):

| Bileşen | İç adres | Dış adres |
|---|---|---|
| Bot + web mağaza + admin paneli | `127.0.0.1:3000` | `https://bot.developer.org.tr` (`/admin` → panel) |
| Public REST API | `127.0.0.1:3100` | `https://bot-api.developer.org.tr` |
| Provider IPN (NOWPayments/CoinPayments) | 3000 üzerinden `/ipn/...` | bot domain'i |

Nginx (GUI yöneticinle) reverse proxy + tek TLS noktası olur; Node portları
dışa **asla** açılmaz.

---

## 0. Ön hazırlık
1. **Node.js LTS** kur (x64 MSI, "Add to PATH" kutulu). Kurulumdan sonra
   yeni bir PowerShell/ CMD penceresinde `node -v` → v20/v22 olmalı.
2. **Git for Windows** kur (varsayılan options yeterlidir).
3. Visual C++ Redistributable gerekiyorsa (yalnızca `canvas` native modülü
   için) zaten kurulu görünüyor — çoğu VDS'de hazırdır.
4. Projeyi **klasör adı Türkçe/boşluk içermeyen** bir yere koy (nginx ve
   win-acme yollarında sorun çıkarmaz):
   ```bat
   cd /d C:\
   git clone <repo-url> C:\srv\telegramlisans
   cd C:\srv\telegramlisans
   npm ci
   ```
   > `npm ci` hata verirse `npm install` dene; `canvas` derlenemezse
   > `npm rm canvas` — canvas yalnız bot'un QR/görsel özelliği içindir,
   > mağaza/API/deposit çalışmaya devam eder.

## 1. `.env`
Projeye `C:\srv\telegramlisans\.env` olarak şunları ekle (mevcut değerler
korunur, yeni anahtarlar eklenir):

```ini
BOT_TOKEN=...
ADMIN_ID=...
# ---- tedarikçi & LLM (zaten var) ----
SUPPLIER_DRY_RUN=1          # ilk açılışda önerilir; canlıya alınca sil
LLM_BASE_URL=...            # opsiyonel (çeviri ajanı)

# ---- web mağaza + admin ----
WEB_ENABLED=1
WEB_PORT=3000
WEB_PUBLIC_URL=https://bot.developer.org.tr

# ---- public REST API ----
API_ENABLED=1
API_PORT=3100
API_CORS_ORIGIN=*           # sadece kendi sitenden çağıracaksan: https://bot.developer.org.tr
API_DEFAULT_RPM=60          # anahtar başına dakikalık istek üst varsayılanı
API_IP_RPM=600              # IP başına flood koruması

# ---- kripto yatırma (hesabın yoksa hiç yazma; özellik otomatik gizli) ----
# DEPOSIT_PROVIDER=coinpayments
# COINPAYMENTS_MERCHANT_ID=...
# COINPAYMENTS_API_KEY=...
# COINPAYMENTS_API_SECRET=...
# COINPAYMENTS_IPN_SECRET=...
# DEPOSIT_PROVIDER=nowpayments
# NOWPAYMENTS_API_KEY=...
# NOWPAYMENTS_IPN_SECRET=...
# DEPOSIT_NETWORKS=usdt_bep20,usdt_polygon,ton,usdt_ton,ltc,usdt_trc20
```

İlk çalıştırma ön izlemesi (migrasyonları uygular, konsolda durdur: Ctrl+C):
```bat
node -e "require('./src/db').initDb()"
```
`[migrations] ✓ 0005_… 0006_api 0007_pending_topups 0008_deposit_wallets`
satırlarını görmelisin (VDS 0004'teyse 4 migrasyon eklenir — hepsi **additive**,
veri silmez).

## 2. Servis olarak çalıştır (iki seçenekten biri)

### A) NSSM (önerilen — Windows hizmeti, reboot sonrası otomatik)
1. https://nssm.cc/download → `nssm.exe`yi `C:\Windows\`e koy.
2. CMD (Admin):
   ```bat
   nssm install TelegramLisans "C:\Program Files\nodejs\node.exe" "C:\srv\telegramlisans\src\bot.js"
   nssm set TelegramLisans AppDirectory C:\srv\telegramlisans
   nssm set TelegramLisans AppStdout C:\srv\telegramlisans\logs\out.log
   nssm set TelegramLisans AppStderr C:\srv\telegramlisans\logs\err.log
   nssm set TelegramLisans AppRotateFiles 1
   nssm start TelegramLisans
   ```
   (`logs` klasörünü önce elle oluştur: `mkdir C:\srv\telegramlisans\logs`)

### B) pm2
```bat
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd /d C:\srv\telegramlisans
pm2 start src\bot.js --name telegramlisans
pm2 save
```

Başlangıç kanıtı (`logs\out.log` veya `pm2 logs`):
```
[migrations] up to date
[Web] mağaza http://0.0.0.0:3000
[Api] REST v1 http://0.0.0.0:3100/v1/ (docs: /v1/docs)
[DepositPoller] started ...
```

## 3. TLS sertifikası — win-acme (Let's Encrypt)
Telegram Login Widget **HTTPS zorunlu**; API de HTTPS olmalı.
1. https://www.win-acme.com → kur.
2. `wacs.exe` → **N** (new certificate) → **1** (contact me for a certificate):
   - Alan adı: önce `bot.developer.org.tr`, sonra aynı işi `bot-api.developer.org.tr` için tekrarla.
   - Validation: **Autoselect** (http-01) — nginx 80 portunu dinliyor olmalı;
     istekler başarısızsa geçici bir "static site" sekmesi aç (bkz. 4. adım).
   - Installation: **None** (nginx GUI'n sertifika dosya yollarını kendin vereceksin).
   - Sertifika dosyaları genelde `C:\Certbot\live\<domain>\fullchain.pem` + `privkey.pem`
     (v2'de `C:\ProgramData\win-acme\acme-v02.api.letsencrypt.org\...` de olabilir —
     kurulum özeti ekranındaki yolları not al).
3. Yenileme win-acme zamanlanmış göreviyle otomatik (kurdugunda oluşur;
   "renewal" task'ının Admin çalıştığını Görev Zamanlayıcı'dan doğrula).

## 4. Nginx (GUI yönetici) — domain başına sekme
GUI'n "site/tab" modeliyle iki site tanımla. Elle düzenleme yapabiliyorsan
konfig şöyle olmalı (GUI'de karşılıkları parantez içinde):

### 4.1 Sekme: `bot.developer.org.tr`
```nginx
upstream shop { server 127.0.0.1:3000; keepalive 8; }
server {
  listen 443 ssl;
  http2 on;
  server_name bot.developer.org.tr;
  ssl_certificate      C:/Certbot/live/bot.developer.org.tr/fullchain.pem;
  ssl_certificate_key  C:/Certbot/live/bot.developer.org.tr/privkey.pem;

  location / {
    proxy_pass http://shop;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    client_max_body_size 2m;
  }
}
server { listen 80; server_name bot.developer.org.tr; return 301 https://$host$request_uri; }
```
GUI ayarlarında mutlaka:
- **Static Cache / "Statik dosya önbelleği": KAPALI** — proxy vhost'unda
  açarsan widget callback'i ve `/api/*` POST'larını bayatlatır.
- **GZIP: AÇIK** olabilir (SPA için faydalı).
- **PHP: KAPALI** (bu vhost'ta PHP engine istemiyorsun; GUI "PHP tablosu"
  eklemesin).
- **Workers / Timeout**: worker_connections varsayılan yeter; `proxy_read_timeout` ≥ 60s.

### 4.2 Sekme: `bot-api.developer.org.tr`
Aynı yapı, sadece:
- `proxy_pass http://127.0.0.1:3100;`
- `X-Forwarded-For $remote_addr;` **şart** — per-IP rate limit client IP'yi
  bu head'den okur (nginx GUI genellikle otomatik ekler; kontrol et).
- `limit_req zone=api rate=20r/s burst=40 nodelay;` **gerek yok** — uygulama
  kendi katmanlı limitini uyguluyor; nginx'i sadece flood tamponu olarak
  düşünüp config'e dokunma.

### 4.3 Ortak ayarlar
- **DNS**: her iki subdomain için A kaydı → VDS'in public IP'si.
- **Windows Firewall**: yalnız **80 ve 443** açık (GUI nginx'i genelde ilk
  başlatışta izin verir; kontrol: `netsh advfirewall firewall show rule name=all | findstr /i nginx`).
  Node portları (3000/3100) dışarı kapalı kalsın — servis zaten `0.0.0.0`
  dinliyor, sadece firewall seviyesinde kapat:
  ```bat
  netsh advfirewall firewall add rule name="block-node-public" dir=in action=block protocol=tcp localport=3000,3100 remoteip=any
  ```
  (localhost proxy'yi etkilemez; rule yanlışsa `delete rule` ile silersin.)
- **Cloud panel varsa** (VDS sağlayıcı güvenlik grubu) orada da sadece 80/443 aç.

## 5. Bot tarafı son dokunuşlar
1. **BotFather → `/setdomain`** → `bot.developer.org.tr` (widget imza
   doğrulaması bu domain'e bağlı). Menu Butonu da aynı domaini göster.
2. Kripto yatırma kullanacaksan:
   - NOWPayments panel → Webhook → `https://bot.developer.org.tr/ipn/nowpayments`,
     secret = `.env`'deki `NOWPAYMENTS_IPN_SECRET`.
   - CoinPayments → Account Settings → IPN Sandbox off, Live URL =
     `https://bot.developer.org.tr/ipn/coinpayments`, secret =
     `COINPAYMENTS_IPN_SECRET` (ayarlar CP'nin gönderdiğini gösterdiğinle
     aynı olmalı; HMAC-SHA1 doğrulanıyor).
3. Binance Pay: ekstra ayet yok — `BINANCE_API_KEY/SECRET` + `BINANCE_PAY_ID`
   zaten `.env`'de; otomatik yükleme `pending_topups` kuyruğuyla çalışır.

## 6. Smoke testi (kurulumdan sonra)
Sırayla dene ve beklenen sonucu doğrula:
- [ ] `https://bot-api.developer.org.tr/v1/health` → `{"ok":true,...}`
- [ ] `https://bot-api.developer.org.tr/v1/docs` → API konsolu açılıyor
- [ ] `https://bot.developer.org.tr` → mağaza + **Giriş yap** (widget) akışı
- [ ] `https://bot.developer.org.tr/admin` → admin paneli (yalnız ADMIN_ID
      oturumunda görünür; 403 alıyorsan widget ile admin hesabıyla gir)
- [ ] Panelde 📊 stats + 🔑 anahtar üret → `curl -H "Authorization: Bearer sk-..." https://bot-api.developer.org.tr/v1/categories`
- [ ] Bot /start → menü → 📊 Wallet'te "Binance Pay ile yükle" (+ sağlayıcı
      anahtarı girdiyse ağ butonları)
- [ ] 429 simülasyonu: docs sayfasından 30 istek → limit başlıyorsa
      `X-RateLimit-Remaining` düşüyor, `Retry-After` geldiğini gör
- [ ] `npm test` (VDS'te de çalıştırabilirsin; `test:topup` canlı Binance
      sorgusu yapar, onu sunucuda değil lokalde koş)

## 7. Güncelleme akışı
```bat
cd /d C:\srv\telegramlisans
node scripts\backup_db.js
git pull
npm ci --omit=dev
nssm restart TelegramLisans   &rem   veya: pm2 restart telegramlisans
```
Migrasyonlar açılışta otomatik + idempotent (additive — eski veriye dokunmaz).
`logs\out.log` son satırlarında `[migrations] up to date` görmeden bırakma.

## 8. Zamanlanmış yedekleme
Görev Zamanlayıcı → Daily 03:00 →
```
Program   : C:\Program Files\nodejs\node.exe
Arguments : C:\srv\telegramlisans\scripts\backup_db.js
Başlangıç : C:\srv\telegramlisans
```
Yedekler `C:\srv\telegramlisans\backups\database-<tarih>.sqlite`. En az 7
sını koru; ayda bir VDS dışına (zip'le indir) kopyala.

## 9. Troubleshooting
| Belirti | Sebep / çözüm |
|---|---|
| nginx'de **502** | Node servisi ölü: `nssm status TelegramLisans` / `pm2 ls`; `logs\err.log` son satır. Port çakışması: `netstat -ano | findstr :3000`. |
| Sayfa açılıyor ama **giriş butonu yok / widget hatası** | BotFather domain kaydı yok veya HTTP üzerinden giriyorsun (HTTPS şart). `X-Forwarded-Proto $scheme` eksik. |
| `/admin` **403** | Oturum ADMIN_ID'ne ait değil. Admin Telegram hesabıyla widget'tan giriş yap. |
| API **401** | Yanlış/eksik `Authorization: Bearer sk-...`. Raw anahtarı yalnız üretimde gösterilir — kaybolduysa yeni anahtar üret. |
| API **429** çok erken | `API_IP_RPM` düşükse `.env`'de artır ve servisi yeniden başlat; `Retry-After` header'ına uyan istemci sayfası bunu yutmalıdır. |
| IP limiti **hep aynı IP'den** yiyor (NAT şikâyeti) | nginx `X-Forwarded-For` yazmıyor → per-IP bucket tüm siteni tek IP sayar. 4.2'ye bak. |
| Binance ödeme gönderildi, bakiye yatmadı | Panelde 📊 → Bekleyen yatırmalar: PENDING ise poller (3 dk) doğrulayınca yazar; EXPIRED ise müşteri yanlış numara vermiştir. Ödeme geçmişinde görünüyorsa numara yanlıştır. |
| IPN hiç gelmiyor | `/ipn/...` yollarına gelen istekler `[ipn:...] BAD SIGNATURE` olarak loglanır → secret'lar uyuşmuyor ya da provider form/JSON tipini karıştırıyorsun (NP=JSON+sha256, CP=form+sha1). |
| `npm ci` `canvas` derleme hatası | VC++ Redist kur ya da `npm rm canvas` (görsel özellik devre dışı, geri kalan çalışır). |
| reboot sonrası site kapalı | NSSM otomatik başlat (Automatic). pm2 kullanıyorsan `pm2-startup install` + `pm2 save`. |
| Sertifika süresi düştü | win-acme renewal görevi Admin çalışmıyorsa elle: `wacs.exe --renew --scope all` |

## 10. Güvenlik notları
- `.env`'i asla git'e commit etme (repo zaten `.gitignore`luyor); VDS'te
  dosya izinlerini `icacls .env /inheritance:r /grant:r Administrators:F` ile daralt.
- Node portlarını dışarı açma; sadece nginx 80/443 görsün.
- API anahtarları salt-hash olarak saklanır; ham anahtarı yalnız üretirken
  gösterilir — kaybedersen rotate et (panel 🔑 → yenile/silin).
- Admin paneli aynı Telegram widget oturumuna bağlıdır, ayrı parola yoktur;
  ADMIN_ID dışındaki kullanıcılar API yüzünden 403 alır.

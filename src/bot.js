require("dns").setDefaultResultOrder("ipv4first");
const { Telegraf, session } = require('telegraf');
const { BOT_TOKEN, ADMIN_ID } = require('./config/env');
const { initDb } = require('./db');
const checkMembership = require('./middlewares/forceSub');

const setupStartCommand = require('./handlers/start');
const setupUserHandlers = require('./handlers/user');
const setupAdminHandlers = require('./handlers/admin');
const setupAdminPricing = require('./handlers/admin_pricing');
const setupResellerHandlers = require('./handlers/reseller');

// Veritabanı tablolarını oluştur/başlat
initDb();

// Telegraf Bot Örneği
const https = require('https');
const agent = new https.Agent({ family: 4, keepAlive: true });
const bot = new Telegraf(BOT_TOKEN, { telegram: { agent } });

// Global Middlewares
bot.use((ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return;
  return next();
});

bot.use(session());             // Kullanıcı state (session) takibi için
bot.use(checkMembership);       // Zorunlu Kanal/Grup aboneliği kontrolü

// Başlat ReservationManager
const ReservationManager = require('./services/ReservationManager');
const reservationManager = new ReservationManager(bot);
reservationManager.start(10000); // snapshot tabanlı; governor'a dokunmaz

const StockWatcher = require('./services/StockWatcher');
const stockWatcher = new StockWatcher(bot);
stockWatcher.start(20000); // katalog snapshot'ını diff'ler, API'ye istek atmaz

// Tek merkezli katalog tazeleyici (her tedarikçi kendi hız limitinde)
const CatalogPoller = require('./services/CatalogPoller');
CatalogPoller.start();

// Kâr/dengeye admin izleme + çeviri ajanı
const MarginWatchdog = require('./services/MarginWatchdog');
MarginWatchdog.start(bot);

const TranslationService = require('./services/TranslationService');
TranslationService.start(bot);

const userBotManager = require('./services/UserBotManager');
userBotManager.init().catch(err => console.error('UserBot init error:', err));

// Handler'ları (İşleyicileri) Bota Ekle
setupStartCommand(bot);
setupAdminHandlers(bot);
setupAdminPricing(bot);
setupResellerHandlers(bot);
setupUserHandlers(bot);

// Genel Hata Yakalama (Botun çökmesini önler)
bot.catch((err, ctx) => {
  console.error(`Bot Hatası [UpdateType: ${ctx.updateType}]:`, err);
});

// Genel kullanıcılara komut menüsünü ayarla
bot.telegram.setMyCommands([
  { command: 'start', description: 'Ana menüyü açar / Start the bot' },
  { command: 'promo', description: 'Promosyon kodu kullan / Use promo code' },
  { command: 'rank', description: 'Rank bilgini görüntüle / View your rank' }
]);

// Eğer ADMIN_ID girilmişse, sadece admine özel komut menüsünü ayarla
if (ADMIN_ID) {
  bot.telegram.setMyCommands([
    { command: 'start', description: 'Ana menüyü açar / Start the bot' },
    { command: 'admin', description: 'Yönetici Paneli / Admin Panel' },
    { command: 'botstats', description: 'Bot İstatistikleri / Bot Statistics' },
    { command: 'setresfee', description: 'Özel Rezerve Ücreti (Kullanım: /setresfee <user_id> <ücret>)' }
  ], { scope: { type: 'chat', chat_id: ADMIN_ID } }).catch(err => {
    console.error('Admin komut menüsü ayarlanamadı (Bunun sebebi admin ID hatalı veya bot başlatılmamış olabilir):', err.message);
  });
}

// Botu Başlat
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('🤖 Bot başarıyla başlatıldı ve istekleri bekliyor...');
});

// Graceful Stop (Güvenli Kapatma) İşlemleri
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Prevent Node.js from crashing on unhandled promise rejections (like Telegram 400 Bad Request)
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

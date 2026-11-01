require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

async function main() {
  let apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  let apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || isNaN(apiId)) {
    const inputApiId = await input.text('Lütfen my.telegram.org adresinden aldığınız TELEGRAM_API_ID giriniz: ');
    apiId = parseInt(inputApiId.trim(), 10);
  }

  if (!apiHash) {
    apiHash = (await input.text('Lütfen my.telegram.org adresinden aldığınız TELEGRAM_API_HASH giriniz: ')).trim();
  }

  if (!apiId || !apiHash) {
    console.error('❌ Geçersiz API ID veya API Hash!');
    process.exit(1);
  }

  console.log('\n🤖 Telegram UserBot Girişi Başlatılıyor...\n');

  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('📱 Telefon numaranızı uluslararası formatta girin (Örn: +905xxxxxxxxx): '),
    password: async () => await input.text('🔐 2FA Şifreniz (Yoksa boş bırakıp Enter yapın): '),
    phoneCode: async () => await input.text('💬 Telegram SMS / Uygulama içi gelen doğrulama kodunu girin: '),
    onError: (err) => console.error('Hata:', err.message || err),
  });

  const sessionString = client.session.save();

  console.log('\n======================================================');
  console.log('✅ GİRİŞ BAŞARILI!');
  console.log('======================================================\n');
  console.log('Lütfen aşağıdaki TELEGRAM_SESSION değerini .env dosyanıza kopyalayın:\n');
  console.log(`TELEGRAM_API_ID=${apiId}`);
  console.log(`TELEGRAM_API_HASH=${apiHash}`);
  console.log(`TELEGRAM_SESSION=${sessionString}\n`);
  console.log('======================================================\n');

  await client.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Kritik Hata:', err);
  process.exit(1);
});

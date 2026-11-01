const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new Database(dbPath);

const API_KEY = 'AK_nNBOXg1oAybyxxOnkPU2I0KYnrhdR32L';
const BASE_URL = 'https://uniqueaizone.grabtools.io';

const specificPrices = {
  'duolingo super 12m': 0.40,
  'gemini pro 18 month': 1.50,
  'apple music 5m': 0.45,
  'adobe express 12m': 0.70
};

async function importProducts() {
  console.log('Fetching products from Unique AI Zone...');
  try {
    const response = await axios.get(`${BASE_URL}/api/v1/products`, {
      headers: { 'X-API-Key': API_KEY }
    });
    const products = response.data.services || response.data;

    if (!Array.isArray(products)) {
      console.error('Invalid response format');
      return;
    }

    // Ensure supplier exists
    let supplier = db.prepare(`SELECT * FROM suppliers WHERE type = 'uniqueaizone'`).get();
    if (!supplier) {
      db.prepare(`INSERT INTO suppliers (name, type, base_url, api_key) VALUES (?, ?, ?, ?)`).run(
        'Unique AI Zone Bot', 'uniqueaizone', BASE_URL, API_KEY
      );
      supplier = db.prepare(`SELECT * FROM suppliers WHERE type = 'uniqueaizone'`).get();
      console.log('Inserted new supplier uniqueaizone');
    }

    let insertedCount = 0;
    for (const p of products) {
      const nameLower = (p.name || '').toLowerCase();
      let sellPrice = parseFloat(p.price || 0) * 2; // Default 2x markup
      
      // Check specific mappings
      for (const [key, mappedPrice] of Object.entries(specificPrices)) {
        if (nameLower.includes(key)) {
          sellPrice = mappedPrice;
          break;
        }
      }

      const nameTranslations = {
        'gemini pro 18 month': {
          en: 'Gemini Pro 18 Month',
          tr: 'Gemini Pro 18 Aylık',
          ru: 'Gemini Pro 18 Месяцев',
          zh: 'Gemini Pro 18 个月',
          hi: 'Gemini Pro 18 महीने',
          de: 'Gemini Pro 18 Monate',
          fr: 'Gemini Pro 18 Mois'
        },
        'apple music 5m': {
          en: 'Apple Music 5M',
          tr: 'Apple Music 5 Aylık',
          ru: 'Apple Music 5 Месяцев',
          zh: 'Apple Music 5 个月',
          hi: 'Apple Music 5 महीने',
          de: 'Apple Music 5 Monate',
          fr: 'Apple Music 5 Mois'
        },
        'adobe express 12m': {
          en: 'Adobe Express 12M',
          tr: 'Adobe Express 12 Aylık',
          ru: 'Adobe Express 12 Месяцев',
          zh: 'Adobe Express 12 个月',
          hi: 'Adobe Express 12 महीने',
          de: 'Adobe Express 12 Monate',
          fr: 'Adobe Express 12 Mois'
        },
        'duolingo super 12m': {
          en: 'Duolingo Super 12M',
          tr: 'Duolingo Super 12 Aylık',
          ru: 'Duolingo Super 12 Месяцев',
          zh: 'Duolingo Super 12 个月',
          hi: 'Duolingo Super 12 महीने',
          de: 'Duolingo Super 12 Monate',
          fr: 'Duolingo Super 12 Mois'
        },
        'spotify 2m redeem link': {
          en: 'Spotify 2M Redeem Link',
          tr: 'Spotify 2 Aylık Kod',
          ru: 'Spotify 2 Месяца Код',
          zh: 'Spotify 2 个月兑换链接',
          hi: 'Spotify 2 महीने का रिडीम लिंक',
          de: 'Spotify 2 Monate Einlöselink',
          fr: "Spotify 2 Mois Lien d'Échange"
        }
      };

      const languages = ['en', 'tr', 'ru', 'zh', 'hi', 'de', 'fr'];
      const multiLangName = {};
      const multiLangDesc = {};
      
      let matchedTranslation = null;
      for (const key of Object.keys(nameTranslations)) {
        if (nameLower.includes(key)) {
          matchedTranslation = nameTranslations[key];
          break;
        }
      }

      for (const lang of languages) {
        multiLangName[lang] = matchedTranslation ? matchedTranslation[lang] : p.name;
        multiLangDesc[lang] = matchedTranslation ? `${matchedTranslation[lang]} (Auto Imported)` : `Automated import from Unique AI Zone.\nService ID: ${p.service_id || p.id}`;
      }

      const nameJson = JSON.stringify(multiLangName);
      const descJson = JSON.stringify(multiLangDesc);
      
      // Check if product already exists by remote_service_id
      const existingLink = db.prepare(`SELECT product_id FROM product_suppliers WHERE supplier_id = ? AND remote_service_id = ?`).get(supplier.id, String(p.service_id || p.id));
      
      if (!existingLink) {
        const result = db.prepare(`
          INSERT INTO products (name, price, description, api_service_id, auto_restock_enabled, auto_restock_qty) 
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(nameJson, sellPrice, descJson, p.service_id || p.id, 1, 1);
        
        const productId = result.lastInsertRowid;
        
        db.prepare(`
          INSERT INTO product_suppliers (product_id, supplier_id, remote_service_id, priority)
          VALUES (?, ?, ?, ?)
        `).run(productId, supplier.id, String(p.service_id || p.id), 1);
        
        console.log(`Inserted product: ${p.name} (Sell: $${sellPrice})`);
        insertedCount++;
      } else {
        db.prepare(`
          UPDATE products 
          SET price = ?
          WHERE id = ?
        `).run(sellPrice, existingLink.product_id);
        console.log(`Updated existing product price: ${p.name}`);
      }
    }
    
    console.log(`Import complete. Inserted ${insertedCount} new products.`);
  } catch (error) {
    console.error('Error fetching products:', error.message);
  }
}

importProducts();

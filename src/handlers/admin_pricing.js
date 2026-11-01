const { db } = require('../db');
const { ADMIN_ID } = require('../config/env');

function setupAdminPricing(bot) {
  const adminMiddleware = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) return next();
  };

  // /listproducts
  bot.command('listproducts', adminMiddleware, (ctx) => {
    const products = db.prepare('SELECT id, name, price FROM products').all();
    if (products.length === 0) return ctx.reply('No products found.');
    let msg = '<b>Products:</b>\n\n';
    products.forEach(p => {
      let name = p.name;
      try {
        const parsed = JSON.parse(p.name);
        name = parsed['en'] || parsed['tr'] || p.name;
      } catch(e) {}
      msg += `ID: <b>${p.id}</b> | Name: ${name} | Price: ${p.price}$\n`;
    });
    ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /listgroups
  bot.command('listgroups', adminMiddleware, (ctx) => {
    const groups = db.prepare('SELECT * FROM pricing_groups').all();
    if (groups.length === 0) return ctx.reply('No pricing groups found.');
    let msg = '<b>Pricing Groups:</b>\n\n';
    groups.forEach(g => {
      msg += `ID: <b>${g.id}</b> | Name: ${g.name} | Discount: ${g.discount_percent}%\n`;
    });
    ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /addgroup <Name> <DiscountPercent>
  bot.command('addgroup', adminMiddleware, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Usage: /addgroup <Name> <DiscountPercent>');
    const discount = parseFloat(args.pop());
    const name = args.join(' ');
    
    try {
      const info = db.prepare('INSERT INTO pricing_groups (name, discount_percent) VALUES (?, ?)').run(name, discount);
      ctx.reply(`✅ Group created! ID: ${info.lastInsertRowid}`);
    } catch (e) {
      ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  // /groupuser <GroupID> <UserID>
  bot.command('groupuser', adminMiddleware, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Usage: /groupuser <GroupID> <UserID>');
    const groupId = parseInt(args[0], 10);
    const userId = parseInt(args[1], 10);
    
    try {
      // First delete existing user from other groups
      db.prepare('DELETE FROM user_pricing_groups WHERE user_id = ?').run(userId);
      db.prepare('INSERT INTO user_pricing_groups (user_id, group_id) VALUES (?, ?)').run(userId, groupId);
      ctx.reply(`✅ User ${userId} added to group ${groupId}.`);
    } catch (e) {
      ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  // /groupprice <GroupID> <ProductID> <Price>
  bot.command('groupprice', adminMiddleware, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3) return ctx.reply('Usage: /groupprice <GroupID> <ProductID> <Price>');
    const groupId = parseInt(args[0], 10);
    const productId = parseInt(args[1], 10);
    const price = parseFloat(args[2]);
    
    try {
      db.prepare(`
        INSERT INTO pricing_group_products (group_id, product_id, price) 
        VALUES (?, ?, ?)
        ON CONFLICT(group_id, product_id) DO UPDATE SET price = excluded.price
      `).run(groupId, productId, price);
      ctx.reply(`✅ Custom price ${price}$ set for product ${productId} in group ${groupId}.`);
    } catch (e) {
      ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  // /bulkdiscount <ProductID> <MinQty> <percent|fixed> <Value>
  bot.command('bulkdiscount', adminMiddleware, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 4) return ctx.reply('Usage: /bulkdiscount <ProductID> <MinQty> <percent|fixed> <Value>');
    const productId = parseInt(args[0], 10);
    const minQty = parseInt(args[1], 10);
    const type = args[2].toLowerCase();
    const value = parseFloat(args[3]);
    
    let discount_percent = 0;
    let fixed_price = null;
    
    if (type === 'percent') {
      discount_percent = value;
    } else if (type === 'fixed') {
      fixed_price = value;
    } else {
      return ctx.reply('❌ Type must be "percent" or "fixed".');
    }
    
    try {
      db.prepare(`
        INSERT INTO product_bulk_discounts (product_id, min_qty, discount_percent, fixed_price) 
        VALUES (?, ?, ?, ?)
      `).run(productId, minQty, discount_percent, fixed_price);
      ctx.reply(`✅ Bulk discount tier added for product ${productId}! Min Qty: ${minQty}, Type: ${type}, Value: ${value}`);
    } catch (e) {
      ctx.reply(`❌ Error: ${e.message}`);
    }
  });
  
  // /listbulkdiscounts <ProductID>
  bot.command('listbulkdiscounts', adminMiddleware, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) return ctx.reply('Usage: /listbulkdiscounts <ProductID>');
    const productId = parseInt(args[0], 10);
    
    const discounts = db.prepare('SELECT * FROM product_bulk_discounts WHERE product_id = ? ORDER BY min_qty ASC').all(productId);
    if (discounts.length === 0) return ctx.reply('No bulk discounts found for this product.');
    
    let msg = `<b>Bulk Discounts for Product ${productId}:</b>\n\n`;
    discounts.forEach(d => {
      msg += `ID: <b>${d.id}</b> | Min Qty: ${d.min_qty} | `;
      if (d.fixed_price !== null) msg += `Fixed Price: ${d.fixed_price}$\n`;
      else msg += `Discount: ${d.discount_percent}%\n`;
    });
    ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /delbulkdiscount <DiscountID>
  bot.command('delbulkdiscount', adminMiddleware, (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) return ctx.reply('Usage: /delbulkdiscount <DiscountID>');
    const id = parseInt(args[0], 10);
    
    try {
      db.prepare('DELETE FROM product_bulk_discounts WHERE id = ?').run(id);
      ctx.reply(`✅ Bulk discount ${id} deleted.`);
    } catch (e) {
      ctx.reply(`❌ Error: ${e.message}`);
    }
  });
}

module.exports = setupAdminPricing;

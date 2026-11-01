const { db } = require('../db');
const lootPagluAdapter = require('./adapters/lootpaglu');
const aiVerseXHubAdapter = require('./adapters/aiversexhub');
const aixShopBotAdapter = require('./adapters/aixshopbot');

const adapters = {
  'lootpaglu': lootPagluAdapter,
  'aiversexhub': aiVerseXHubAdapter,
  'aixshopbot': aixShopBotAdapter,
  'uniqueaizone': aiVerseXHubAdapter
};

class SupplierManager {
  static async getAffordableQuantity(product, neededQty) {
    const mappedSuppliers = db.prepare(`
      SELECT ps.*, s.type, s.base_url, s.api_key 
      FROM product_suppliers ps 
      JOIN suppliers s ON ps.supplier_id = s.id 
      WHERE ps.product_id = ? 
      ORDER BY ps.priority ASC
    `).all(product.id);

    if (!mappedSuppliers || mappedSuppliers.length === 0) {
      return 0; // No suppliers mapped
    }

    let maxAffordable = 0;
    
    // Check all mapped suppliers to find the maximum we can afford across any of them
    for (const supplier of mappedSuppliers) {
      const adapter = adapters[supplier.type];
      if (!adapter) continue;
      
      try {
        const [info, balance] = await Promise.all([
          adapter.getPrice(supplier),
          adapter.getBalance(supplier).catch(() => Infinity)
        ]);
        
        let tiers = (typeof info === 'object' && Array.isArray(info.tiers)) ? info.tiers : [{ min: 1, max: Infinity, price: (typeof info === 'object' ? info.price : info) }];
        
        if (supplier.manual_tiers) {
           try {
             const parsedManualTiers = JSON.parse(supplier.manual_tiers);
             tiers = parsedManualTiers.map(t => ({
                min: t.min,
                max: t.max === null ? Infinity : t.max,
                price: t.price
             }));
           } catch(e) {}
        }

        const stock = typeof info === 'object' ? info.stock : Infinity;
        
        // Find maximum qty we can afford up to `neededQty` from this supplier
        let supplierMax = 0;
        const limit = Math.min(neededQty, stock);
        
        for (let q = 1; q <= limit; q++) {
          let applicableTier = tiers[0];
          for (const tier of tiers) {
             if (q >= tier.min && q <= tier.max) {
                 applicableTier = tier;
                 break;
             }
          }
          if ((applicableTier.price * q) <= balance) {
            supplierMax = q;
          } else {
            break; // Stop checking higher quantities if we can't afford this one
          }
        }
        
        if (supplierMax > maxAffordable) {
          maxAffordable = supplierMax;
        }
      } catch (e) {
        // Skip failed supplier
      }
    }
    
    return maxAffordable;
  }

  static async placeOrder(product, quantity) {
    const mode = product.supplier_selection_mode || 'priority';
    
    const mappedSuppliers = db.prepare(`
      SELECT ps.*, s.type, s.base_url, s.api_key 
      FROM product_suppliers ps 
      JOIN suppliers s ON ps.supplier_id = s.id 
      WHERE ps.product_id = ? 
      ORDER BY ps.priority ASC
    `).all(product.id);

    if (!mappedSuppliers || mappedSuppliers.length === 0) {
      throw new Error("No suppliers configured for this product.");
    }

    if (mode === 'cheapest') {
      return await this._placeOrderCheapest(mappedSuppliers, quantity);
    } else if (mode === 'optimal') {
      return await this._placeOrderOptimal(mappedSuppliers, quantity);
    } else {
      return await this._placeOrderPriority(mappedSuppliers, quantity);
    }
  }

  static async _placeOrderPriority(suppliers, quantity) {
    for (const supplier of suppliers) {
      const adapter = adapters[supplier.type];
      if (!adapter) continue;

      try {
        const result = await adapter.placeOrder(supplier, quantity);
        return { supplier_id: supplier.supplier_id, result };
      } catch (err) {
        console.error(`Supplier ${supplier.supplier_id} (${supplier.type}) failed:`, err.message);
        // Continue to the next priority supplier
      }
    }
    throw new Error("All prioritized suppliers failed to fulfill the order.");
  }

  static async _placeOrderCheapest(suppliers, quantity) {
    // 1. Fetch prices from all adapters concurrently
    const pricePromises = suppliers.map(async (supplier) => {
      const adapter = adapters[supplier.type];
      if (!adapter) return { supplier, price: Infinity };
      
      try {
        const info = await adapter.getPrice(supplier);
        const price = typeof info === 'object' ? info.price : info;
        return { supplier, price };
      } catch (err) {
        console.error(`Failed to fetch price for supplier ${supplier.supplier_id}:`, err.message);
        return { supplier, price: Infinity };
      }
    });

    const results = await Promise.all(pricePromises);
    
    // 2. Sort by price
    results.sort((a, b) => a.price - b.price);
    
    const cheapest = results.filter(r => r.price !== Infinity);
    if (cheapest.length === 0) {
      throw new Error("Could not fetch prices from any supplier or all are unavailable.");
    }

    // 3. Try placing order starting from cheapest
    for (const option of cheapest) {
      const supplier = option.supplier;
      const adapter = adapters[supplier.type];
      
      try {
        const result = await adapter.placeOrder(supplier, quantity);
        return { supplier_id: supplier.supplier_id, result };
      } catch (err) {
        console.error(`Cheapest Supplier ${supplier.supplier_id} failed, trying next:`, err.message);
      }
    }

    throw new Error("All cheapest suppliers failed to fulfill the order.");
  }

  static async _placeOrderOptimal(suppliers, quantity) {
    // 1. Fetch prices (tiers), stock, and balance from all adapters concurrently
    const infoPromises = suppliers.map(async (supplier) => {
      const adapter = adapters[supplier.type];
      if (!adapter) return null;
      
      try {
        const [info, balance] = await Promise.all([
          adapter.getPrice(supplier),
          adapter.getBalance(supplier).catch(() => Infinity) // Default to Infinity if getBalance isn't supported
        ]);
        
        let tiers = (typeof info === 'object' && Array.isArray(info.tiers)) ? info.tiers : [{ min: 1, max: Infinity, price: (typeof info === 'object' ? info.price : info) }];
        
        // --- OVERRIDE WITH MANUAL TIERS IF EXISTS ---
        if (supplier.manual_tiers) {
           try {
             const parsedManualTiers = JSON.parse(supplier.manual_tiers);
             // Ensure Infinity is correctly represented if max is null
             tiers = parsedManualTiers.map(t => ({
                min: t.min,
                max: t.max === null ? Infinity : t.max,
                price: t.price
             }));
           } catch(e) {
             console.error(`Failed to parse manual_tiers for ps_id ${supplier.id}`, e.message);
           }
        }

        const stock = typeof info === 'object' ? info.stock : Infinity;
        
        return { supplier, tiers, stock, balance, type: supplier.type };
      } catch (err) {
        console.error(`Failed to fetch info for optimal split on supplier ${supplier.supplier_id}:`, err.message);
        return null;
      }
    });

    let results = await Promise.all(infoPromises);
    results = results.filter(r => r !== null && r.stock > 0 && r.balance > 0);
    
    // 2. Pre-check: Can we fulfill the ENTIRE order with total available stock?
    const totalStock = results.reduce((acc, r) => acc + r.stock, 0);
    if (totalStock < quantity) {
      throw new Error("OUT_OF_STOCK_OR_BALANCE");
    }

    // Cost calculation helper based on tiers
    function getCost(supplierData, qty) {
      if (qty === 0) return 0;
      if (qty > supplierData.stock) return Infinity;
      
      let applicableTier = supplierData.tiers[0];
      for (const tier of supplierData.tiers) {
         if (qty >= tier.min && qty <= tier.max) {
             applicableTier = tier;
             break;
         }
      }
      
      const cost = applicableTier.price * qty;
      if (cost > supplierData.balance) return Infinity;
      return cost;
    }

    // 3. Knapsack DFS with Memoization to find the absolute minimum cost path
    const memo = new Map();

    function dfs(supplierIdx, remainingQty) {
       if (remainingQty === 0) return { cost: 0, path: [] };
       if (supplierIdx >= results.length) return { cost: Infinity, path: null };
       
       const memoKey = `${supplierIdx}_${remainingQty}`;
       if (memo.has(memoKey)) return memo.get(memoKey);

       let minCost = Infinity;
       let bestPath = null;
       
       const currentSupplier = results[supplierIdx];
       // Check up to the maximum we could theoretically buy from this supplier
       const maxBuy = Math.min(remainingQty, currentSupplier.stock);
       
       for (let qty = 0; qty <= maxBuy; qty++) {
           const currentCost = getCost(currentSupplier, qty);
           if (currentCost === Infinity) continue; // Exceeds balance or stock
           
           const nextResult = dfs(supplierIdx + 1, remainingQty - qty);
           if (nextResult.cost === Infinity) continue;

           const totalCost = currentCost + nextResult.cost;
           if (totalCost < minCost) {
               minCost = totalCost;
               bestPath = qty > 0 
                  ? [{ supplier: currentSupplier.supplier, qty, cost: currentCost }, ...nextResult.path] 
                  : nextResult.path;
           }
       }
       
       const result = { cost: minCost, path: bestPath };
       memo.set(memoKey, result);
       return result;
    }

    const optimalResult = dfs(0, quantity);
    
    if (optimalResult.cost === Infinity || !optimalResult.path) {
       throw new Error("OUT_OF_STOCK_OR_BALANCE");
    }

    // 4. Place orders by executing the calculated optimal path
    const finalResult = {
      success: true,
      products: []
    };
    
    for (const alloc of optimalResult.path) {
      const supplier = alloc.supplier;
      const adapter = adapters[supplier.type];
      const qtyToBuy = alloc.qty;
      
      try {
        const apiResponse = await adapter.placeOrder(supplier, qtyToBuy);
        // Normalize returned products
        let delivered = [];
        if (apiResponse && apiResponse.products) {
           delivered = apiResponse.products;
        } else if (Array.isArray(apiResponse)) {
           delivered = apiResponse;
        } else if (apiResponse && apiResponse.data) {
           delivered = Array.isArray(apiResponse.data) ? apiResponse.data : [apiResponse.data];
        } else {
           // Fallback, just pushing a raw success object if the API format is unknown
           delivered = Array.from({length: qtyToBuy}).map(() => "Delivered");
        }
        
        finalResult.products.push(...delivered);
      } catch (err) {
        console.error(`Optimal split failed on supplier ${supplier.supplier_id}:`, err.message);
        // If an order fails here, it breaks the optimal math, but we still return what we managed to buy.
      }
    }

    if (finalResult.products.length < quantity) {
      if (finalResult.products.length === 0) {
        throw new Error("All suppliers failed during optimal split.");
      }
      console.warn(`Optimal split partially fulfilled: wanted ${quantity}, got ${finalResult.products.length}`);
    }

    return { supplier_id: 'optimal_split', result: finalResult };
  }
}

module.exports = SupplierManager;

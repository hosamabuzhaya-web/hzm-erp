import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// Parse .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const parts = line.split('=');
  if (parts.length >= 2) {
    env[parts[0].trim()] = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  }
});

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  console.log("Downloading db_snapshot.json from Supabase...");
  const { data, error } = await supabase.storage.from('hzm_data').download('db_snapshot.json');
  if (error) {
    console.error("Failed to download database snapshot:", error);
    return;
  }

  const text = await data.text();
  const json = JSON.parse(text);

  const products = json.products || {};
  const inventory = json.inventory || [];
  
  const productCount = Object.keys(products).length;
  console.log(`Product catalog size: ${productCount} items`);
  console.log(`Inventory size: ${inventory.length} records`);

  // Measure productList computation (O(N) mapping)
  console.time("Compute productList");
  const productList = [];
  for (const [barcode, info] of Object.entries(products)) {
    if (!info) continue;
    const name = String(info[0] || '');
    const brand = String(info[3] || '');
    const supplier = String(info[1] || '');
    productList.push({
      barcode,
      name,
      nameLower: name.toLowerCase(),
      brand,
      brandLower: brand.toLowerCase(),
      supplier,
      supplierLower: supplier.toLowerCase(),
      packSize: info[4] || 1
    });
  }
  console.timeEnd("Compute productList");

  // Test search queries
  const testQueries = ["א", "אב", "וולפסון", "קוקה", "729010", "לא קיים בכלל", "שקולד"];
  
  console.log("\nTesting search performance (simulating key-presses):");
  testQueries.forEach(query => {
    const q = query.trim().toLowerCase();
    
    // Simulate query of length >= 2
    console.time(`Search query: "${query}"`);
    const results = [];
    for (let i = 0; i < productList.length; i++) {
      const p = productList[i];
      if (
        p.barcode.includes(q) ||
        p.nameLower.includes(q) ||
        p.brandLower.includes(q) ||
        p.supplierLower.includes(q)
      ) {
        results.push(p);
        if (results.length >= 10) break;
      }
    }
    console.timeEnd(`Search query: "${query}"`);
    console.log(` -> Found ${results.length} matches`);
  });
}

run().catch(console.error);

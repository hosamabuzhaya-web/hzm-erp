import fs from 'fs';
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
  console.log("Downloading snapshot to validate...");
  const { data, error } = await supabase.storage.from('hzm_data').download('db_snapshot.json');
  if (error) {
    console.error("Failed to download database snapshot:", error);
    return;
  }

  const text = await data.text();
  const json = JSON.parse(text);

  const products = json.products || {};
  const inventory = json.inventory || [];
  const monthlySales = json.monthlySales || {};

  console.log(`Products: ${Object.keys(products).length}`);
  console.log(`Inventory: ${inventory.length}`);

  let invalidProducts = 0;
  for (const [barcode, info] of Object.entries(products)) {
    if (!info) {
      console.log(`[Warning] Product ${barcode} is null/undefined`);
      invalidProducts++;
      continue;
    }
    if (!Array.isArray(info)) {
      console.log(`[Error] Product ${barcode} is not an array:`, info);
      invalidProducts++;
      continue;
    }
    if (info.length < 5) {
      console.log(`[Warning] Product ${barcode} has short array length:`, info.length);
    }
  }

  let invalidInventory = 0;
  inventory.forEach((row, i) => {
    if (!row) {
      console.log(`[Error] Inventory row ${i} is null/undefined`);
      invalidInventory++;
      return;
    }
    if (!Array.isArray(row)) {
      console.log(`[Error] Inventory row ${i} is not an array:`, row);
      invalidInventory++;
      return;
    }
    if (row.length < 3) {
      console.log(`[Warning] Inventory row ${i} has short array length:`, row);
    }
  });

  console.log(`Validation complete. Invalid Products: ${invalidProducts}, Invalid Inventory: ${invalidInventory}`);
}

run().catch(console.error);

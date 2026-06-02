const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabaseUrl = 'https://ajcmepmfbjfwgaeihdnt.supabase.co';
const supabaseKey = 'sb_publishable_7_mW3UtTsxyqkW9JX_k_nQ_v0HDK-cZ'; // wait, is this the anon key? Yes!
const supabase = createClient(supabaseUrl, supabaseKey);

const barcodes = ['7296073730217', '3412242508027'];

async function check() {
  try {
    console.log('Downloading snapshot...');
    const { data, error } = await supabase.storage.from('hzm_data').download('db_snapshot.json');
    if (error) {
      console.error('Download error:', error);
      return;
    }
    const text = await data.text();
    const json = JSON.parse(text);
    console.log('Snapshot parsed. Total products in snapshot:', Object.keys(json.products || {}).length);
    
    barcodes.forEach(bc => {
      const prod = json.products?.[bc];
      console.log(`Product ${bc} in Supabase snapshot:`, prod);
    });
  } catch (err) {
    console.error('Error:', err);
  }
}

check();

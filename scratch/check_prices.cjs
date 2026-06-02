const fs = require('fs');
const XLSX = require('xlsx');

const files = ['קטלוג חדש.xlsx', 'כל הפריטים עם נתונים.xlsx'];
const barcodes = ['7296073730217', '3412242508027'];

files.forEach(file => {
  if (!fs.existsSync(file)) {
    console.log(`File not found: ${file}`);
    return;
  }
  console.log(`Searching in ${file}...`);
  try {
    const workbook = XLSX.readFile(file);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet);
    
    // Find barcode column name
    const sample = json[0] || {};
    const barcodeKey = Object.keys(sample).find(k => k.includes('ברקוד') || k.includes('מק"ט') || k.includes('קוד') || k.includes('פריט'));
    const priceKey = Object.keys(sample).find(k => k.includes('מחיר') || k.includes('עלות') || k.includes('מכירה'));
    
    console.log(`Found keys: barcode = ${barcodeKey}, price = ${priceKey}`);
    
    barcodes.forEach(bc => {
      const match = json.find(row => String(row[barcodeKey]).trim() === bc);
      if (match) {
        console.log(`MATCH for ${bc}:`, match);
      } else {
        console.log(`No match for ${bc}`);
      }
    });
  } catch (err) {
    console.error(err);
  }
});

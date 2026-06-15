const BRANCH_NAMES = {
  '631': 'וולפסון',
  '614': 'נתניה',
  '668': 'קרית השרון',
  '198': 'יהלום'
};

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://ajcmepmfbjfwgaeihdnt.supabase.co';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.TO_EMAIL || 'hosam.abu.zhaya@gmail.com';

  if (!supabaseAnonKey) {
    console.error('Error: SUPABASE_ANON_KEY is required.');
    process.exit(1);
  }

  console.log('Downloading db_snapshot.json from Supabase Storage...');
  let data;
  try {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/authenticated/hzm_data/db_snapshot.json`, {
      headers: {
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    data = await response.json();
  } catch (err) {
    console.error('Failed to download database snapshot:', err);
    process.exit(1);
  }

  const orderSchedule = data.orderSchedule || [];
  const products = data.products || {};
  const inventory = data.inventory || [];
  const monthlySales = data.monthlySales || {};
  const settings = data.settings || {};

  // Calculate local date/time in Israel timezone
  const targetDateStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
  const localDate = new Date(targetDateStr);
  const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const todayHebrew = HEBREW_DAYS[localDate.getDay()];
  const formattedDate = localDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });

  console.log(`Processing orders for ${todayHebrew} (${formattedDate})...`);

  // --- 1. Compute Inventory Map ---
  const inventoryMap = {};
  inventory.forEach(i => {
    if (!i) return;
    const [barcode, branch, stock] = i;
    if (!inventoryMap[branch]) inventoryMap[branch] = {};
    inventoryMap[branch][barcode] = Number(stock) || 0;
  });

  const getStock = (branchId, barcode) => {
    return inventoryMap[branchId]?.[barcode] || 0;
  };

  // --- 2. Compute Sales Averages (up to 6 months) ---
  const stableSalesMap = {};
  const allMonthsSet = new Set();
  Object.values(monthlySales).forEach(branchData => {
    if (branchData) {
      Object.values(branchData).forEach(months => {
        if (months) {
          Object.keys(months).forEach(m => allMonthsSet.add(m));
        }
      });
    }
  });

  const sortedMonths = Array.from(allMonthsSet).sort((a, b) => {
    const pA = a.split('.'), pB = b.split('.');
    return (Number(pA[1]) - Number(pB[1])) || (Number(pA[0]) - Number(pB[0]));
  });

  Object.keys(products).forEach(barcode => {
    stableSalesMap[barcode] = {};
    Object.keys(BRANCH_NAMES).forEach(branchId => {
      const itemMonthly = monthlySales[branchId]?.[barcode] || null;
      if (itemMonthly) {
        const mValues = [];
        for (let i = sortedMonths.length - 1; i >= 0; i--) {
          const m = sortedMonths[i];
          const val = itemMonthly[m];
          if (val !== undefined) {
            mValues.push(val);
            if (mValues.length === 6) break;
          }
        }
        if (mValues.length > 0) {
          const rawAvg = mValues.reduce((a, b) => a + b, 0) / mValues.length;
          const normalValues = mValues.filter(v => v <= rawAvg * 1.6);
          stableSalesMap[barcode][branchId] = normalValues.length > 0 ? (normalValues.reduce((a, b) => a + b, 0) / normalValues.length) : rawAvg;
        } else {
          stableSalesMap[barcode][branchId] = 0;
        }
      } else {
        stableSalesMap[barcode][branchId] = 0;
      }
    });
  });

  const getAvgSales = (branchId, barcode) => {
    return stableSalesMap[barcode]?.[branchId] || 0;
  };

  const getSupplierName = (supplierId, uploadedName) => {
    const cleanId = supplierId?.toString().trim();
    const cleanName = uploadedName?.toString().trim();
    const isGeneric = !cleanName || cleanName === 'כללי' || cleanName === '-' || cleanName === cleanId;
    
    if (isGeneric && cleanId) {
      for (const barcode in products) {
        const p = products[barcode];
        if (p) {
          const pSupId = p[2]?.toString().trim();
          const pWhId = p[5]?.toString().trim();
          const pSupName = p[1]?.toString().trim();
          
          if ((pSupId === cleanId || pWhId === cleanId) && pSupName && pSupName !== 'כללי' && pSupName !== '-') {
            return pSupName;
          }
        }
      }
    }
    return cleanName || 'כללי';
  };

  const matchProduct = (p, os) => {
    const barcodeWh = p[5]?.toString().trim();
    const barcodeSupId = p[2]?.toString().trim();
    const schedId = os.supplierId?.toString().trim();
    
    const hasWarehouse = barcodeWh && barcodeWh !== '-' && barcodeWh !== 'כללי' && barcodeWh !== 'undefined';
    
    if (hasWarehouse) {
      if (barcodeWh !== schedId) return false;
      
      const cond = os.storageCondition?.toString().trim();
      const hasCond = cond && cond !== '-' && cond !== 'כללי' && cond !== 'undefined';
      
      if (hasCond) {
        const cleanCond = cond.toLowerCase();
        const cleanDept = (p[7] || '').toString().toLowerCase();
        const cleanGroup = (p[8] || '').toString().toLowerCase();
        const cleanType = (p[6] || '').toString().toLowerCase();
        
        const matchCond = cleanDept.includes(cleanCond) || cleanCond.includes(cleanDept) ||
                          cleanGroup.includes(cleanCond) || cleanCond.includes(cleanGroup) ||
                          cleanType.includes(cleanCond) || cleanCond.includes(cleanType);
        
        if (!matchCond) return false;
      }
      return true;
    } else {
      return barcodeSupId === schedId;
    }
  };

  // --- 3. Filter and Calculate Shortages ---
  const todaySchedules = orderSchedule.filter(row => row.orderDay === todayHebrew);
  const targetMonths = settings.targetInventoryMonths || 1;

  const ordersByBranch = {};
  let totalCostAll = 0;
  let totalShortagesCount = 0;

  todaySchedules.forEach(os => {
    const branchId = os.branchId;
    if (!ordersByBranch[branchId]) {
      ordersByBranch[branchId] = [];
    }

    const shortages = [];
    Object.entries(products).forEach(([barcode, p]) => {
      if (!matchProduct(p, os)) return;

      const status = p[10] || 'פעיל';
      if (status !== 'פעיל') return;

      const stock = getStock(branchId, barcode);
      if (stock > 0) return;

      const avg = getAvgSales(branchId, barcode);
      if (avg <= 0) return;

      const targetStock = avg * targetMonths;
      const needed = Math.max(0, targetStock - stock);
      if (needed <= 0) return;

      const packFactor = p[4] || 1;
      const packs = Math.ceil(needed / packFactor);
      const unitsToOrder = packs * packFactor;
      const price = Number(p[11]) || 0;

      shortages.push({
        barcode,
        desc: p[0] || 'ללא תיאור',
        brand: p[3] || '-',
        price,
        stock,
        avgMonthlySales: avg,
        recommendedPacks: packs,
        recommendedUnits: unitsToOrder,
        totalCost: unitsToOrder * price
      });
    });

    const totalCost = shortages.reduce((acc, curr) => acc + curr.totalCost, 0);
    totalCostAll += totalCost;
    totalShortagesCount += shortages.length;

    ordersByBranch[branchId].push({
      supplierId: os.supplierId,
      supplierName: getSupplierName(os.supplierId, os.supplierName),
      storageCondition: os.storageCondition,
      orderTime: os.orderTime || '12:00',
      deliveryDay: os.deliveryDay,
      shortages,
      totalCost
    });
  });

  // Sort orders by time within each branch
  Object.keys(ordersByBranch).forEach(bId => {
    ordersByBranch[bId].sort((a, b) => a.orderTime.localeCompare(b.orderTime));
  });

  // --- 4. Build HTML Email Content ---
  let emailHtml = `
  <!DOCTYPE html>
  <html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f3f4f6; color: #1f2937; margin: 0; padding: 20px; direction: rtl; text-align: right; }
      .container { max-width: 650px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); margin: 0 auto; overflow: hidden; border: 1px solid #e5e7eb; }
      .header { background: #4f46e5; color: white; padding: 30px 20px; text-align: center; }
      .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
      .header p { margin: 5px 0 0 0; font-size: 16px; opacity: 0.9; }
      .summary-card { background: #f9fafb; border-bottom: 1px solid #e5e7eb; padding: 20px; display: flex; justify-content: space-around; text-align: center; }
      .summary-stat { flex: 1; }
      .summary-val { font-size: 22px; font-weight: bold; color: #4f46e5; }
      .summary-lbl { font-size: 12px; color: #6b7280; margin-top: 4px; }
      .content { padding: 25px; }
      .branch-section { margin-bottom: 30px; }
      .branch-title { font-size: 18px; font-weight: bold; border-bottom: 2px solid #4f46e5; padding-bottom: 6px; margin-bottom: 15px; color: #111827; }
      .order-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; margin-bottom: 15px; background: #fff; border-right: 4px solid #f59e0b; }
      .order-card.no-shortage { border-right: 4px solid #10b981; }
      .order-meta { display: flex; justify-content: space-between; font-size: 12px; color: #6b7280; margin-top: 5px; background: #f9fafb; padding: 6px 10px; border-radius: 4px; }
      .supplier-name { font-size: 15px; font-weight: bold; color: #111827; }
      .shortages-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
      .shortages-table th { background: #f3f4f6; color: #4b5563; font-weight: 600; text-align: right; padding: 8px; border-bottom: 1px solid #e5e7eb; }
      .shortages-table td { padding: 8px; border-bottom: 1px solid #f3f4f6; }
      .shortages-table tr:hover { background: #f9fafb; }
      .cost-badge { background: #fee2e2; color: #b91c1c; padding: 2px 8px; border-radius: 12px; font-weight: bold; font-size: 11px; }
      .no-orders { text-align: center; padding: 40px 20px; color: #6b7280; }
      .footer { background: #f9fafb; color: #9ca3af; text-align: center; padding: 15px; font-size: 11px; border-top: 1px solid #e5e7eb; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>דוח הזמנות וחוסרים יומי</h1>
        <p>יום ${todayHebrew} - ${formattedDate}</p>
      </div>
  `;

  if (todaySchedules.length === 0) {
    emailHtml += `
      <div class="no-orders">
        <p style="font-size: 18px; font-weight: bold; margin-bottom: 10px;">אין הזמנות מתוזמנות להיום 🎉</p>
        <p style="font-size: 14px;">כל הסניפים פטורים מהזמנות לפי לוח הזמנים השבועי.</p>
      </div>
    `;
  } else {
    // Add stats bar
    emailHtml += `
      <div class="summary-card">
        <div class="summary-stat">
          <div class="summary-val">${Object.keys(ordersByBranch).length}</div>
          <div class="summary-lbl">סניפים פעילים</div>
        </div>
        <div class="summary-stat" style="border-right: 1px solid #e5e7eb; border-left: 1px solid #e5e7eb;">
          <div class="summary-val">${totalShortagesCount}</div>
          <div class="summary-lbl">סה"כ פריטים בחוסר</div>
        </div>
        <div class="summary-stat">
          <div class="summary-val">₪${Math.round(totalCostAll).toLocaleString()}</div>
          <div class="summary-lbl">שווי הזמנות מוערך</div>
        </div>
      </div>
      <div class="content">
    `;

    // Add branch details
    Object.entries(ordersByBranch).forEach(([branchId, orders]) => {
      const branchName = BRANCH_NAMES[branchId] || branchId;
      emailHtml += `
        <div class="branch-section">
          <div class="branch-title">סניף ${branchName} (${branchId})</div>
      `;

      orders.forEach(order => {
        const shortagesCount = order.shortages.length;
        const cardClass = shortagesCount > 0 ? 'order-card' : 'order-card no-shortage';
        
        emailHtml += `
          <div class="${cardClass}">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="supplier-name">${order.supplierName} (${order.supplierId})</span>
              ${shortagesCount > 0 
                ? `<span class="cost-badge">₪${Math.round(order.totalCost).toLocaleString()} (${shortagesCount} פריטים)</span>`
                : '<span style="color: #10b981; font-weight: bold; font-size: 13px;">במלאי תקין (0 חוסרים)</span>'
              }
            </div>
            
            <div class="order-meta">
              <span>שעת cutoff להזמנה: <strong>${order.orderTime}</strong></span>
              <span>יום אספקה מתוזמן: <strong>יום ${order.deliveryDay}</strong></span>
              ${order.storageCondition !== '-' ? `<span>קטגוריה/מחלקה: <strong>${order.storageCondition}</strong></span>` : ''}
            </div>
        `;

        if (shortagesCount > 0) {
          emailHtml += `
            <table class="shortages-table">
              <thead>
                <tr>
                  <th>ברקוד</th>
                  <th>תיאור פריט</th>
                  <th style="text-align: center;">מכר חודשי</th>
                  <th style="text-align: center;">מארז</th>
                  <th style="text-align: center;">המלצה</th>
                  <th style="text-align: left;">עלות</th>
                </tr>
              </thead>
              <tbody>
          `;

          // Show top 10 shortages in email to keep it clean, note if there are more
          const visibleShortages = order.shortages.slice(0, 10);
          visibleShortages.forEach(item => {
            emailHtml += `
              <tr>
                <td style="font-family: monospace;">${item.barcode}</td>
                <td><strong>${item.desc}</strong></td>
                <td style="text-align: center;">${item.avgMonthlySales.toFixed(1)}</td>
                <td style="text-align: center;">${item.recommendedPacks} קרט' (${item.packFactor})</td>
                <td style="text-align: center; font-weight: bold; color: #f59e0b;">${item.recommendedUnits} יח'</td>
                <td style="text-align: left; font-weight: bold;">₪${Math.round(item.totalCost)}</td>
              </tr>
            `;
          });

          emailHtml += `
              </tbody>
            </table>
          `;

          if (shortagesCount > 10) {
            emailHtml += `
              <p style="font-size: 11px; color: #4f46e5; text-align: center; margin-top: 10px; font-weight: bold;">
                + עוד ${shortagesCount - 10} פריטים חסרים נוספים. היכנס למערכת כדי לראות ולייצא את הרשימה המלאה.
              </p>
            `;
          }
        }

        emailHtml += `
          </div>
        `;
      });

      emailHtml += `
        </div>
      `;
    });

    emailHtml += `
      </div>
    `;
  }

  emailHtml += `
      <div class="footer">
        <p>דוח זה הופק אוטומטית על ידי מערכת ניהול מלאי BE.</p>
        <p>© 2026 BE Stock Manager | DataPlus Enterprise</p>
      </div>
    </div>
  </body>
  </html>
  `;

  // --- 5. Send Email via Resend API ---
  if (!resendApiKey) {
    console.warn('Warning: RESEND_API_KEY is not defined. Printing email summary only.');
    console.log(`Email Subject: Daily Order Summary for ${todayHebrew}`);
    console.log(`To: ${toEmail}`);
    console.log(`Total Cost: ₪${totalCostAll}`);
    process.exit(0);
  }

  console.log(`Sending email to ${toEmail} via Resend...`);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'BE Stock Alert <onboarding@resend.dev>',
        to: toEmail,
        subject: `דוח הזמנות וחוסרים יומי - יום ${todayHebrew} ${formattedDate}`,
        html: emailHtml
      })
    });

    const resJson = await res.json();
    if (!res.ok) {
      throw new Error(`Resend API error: ${JSON.stringify(resJson)}`);
    }
    console.log('Email sent successfully! Message ID:', resJson.id);
  } catch (err) {
    console.error('Failed to send email:', err);
    process.exit(1);
  }
}

main();

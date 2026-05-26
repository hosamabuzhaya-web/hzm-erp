import React, { useState, useMemo, useEffect } from 'react';
import { useData, BRANCH_NAMES } from '../context/DataContext';
import { Clipboard, RefreshCw, AlertCircle, CheckCircle2, Copy, Trash2, Search, Filter, CalendarDays, DatabaseZap, Download, LayoutGrid } from 'lucide-react';
import * as XLSX from 'xlsx';
import OrderReviewModal from '../components/OrderReviewModal';

const QUICK_DAYS = [7, 10, 14, 21, 30];

const MERCHANDISE_TYPES = [
  'בודדים',
  'בית מרקחת',
  'פארם',
  'NF',
  'מכולת',
  'כללי',
  'משוקלד',
  'נקיון',
];

const WAREHOUSES = ['6000', '6032', '6030', '6047'];

const SapOrder = () => {
  const { recommendations, sales, monthlySales, inventory, products, settings, salesMetadata, syncInventoryFromSap, addToWatchlist, externalFilters, isProcessing } = useData();
  const [pastedText, setPastedText] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('631');
  const branches = ['631', '668', '614', '198'];
  const [searchTerm, setSearchTerm] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (externalFilters?.search) {
      setSearchTerm(externalFilters.search);
    }
  }, [externalFilters]);
  const [filterMode, setFilterMode] = useState('all'); // all | to-order | opportunity | no-order
  const [filterWarehouse, setFilterWarehouse] = useState('all');
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderDays, setOrderDays] = useState(30);
  const [opportunityLevel, setOpportunityLevel] = useState(2); // 1, 2, or 3
  const [opportunityLookback, setOpportunityLookback] = useState(0); // 0 = all time, 3 = 3 months, 6 = 6 months
  const [manualOverrides, setManualOverrides] = useState({}); // { [barcode]: number }
  // Sync fields
  const [warehouseInput, setWarehouseInput] = useState('');
  const [supplierInput, setSupplierInput] = useState('');
  const [supplierNameInput, setSupplierNameInput] = useState('');
  const [merchandiseType, setMerchandiseType] = useState('');
  const [customMerchandiseType, setCustomMerchandiseType] = useState('');
  const [syncConfirm, setSyncConfirm] = useState(false); // show confirm card

  // Transfer Integration State
  const [transferSource, setTransferSource] = useState('none');
  const [applyTransfers, setApplyTransfers] = useState(false);
  const [transferDays, setTransferDays] = useState(30);

  // Fast Lookup Maps for Inventory
  const inventoryMap = useMemo(() => {
    const map = {};
    if (Array.isArray(inventory)) {
      for (let i = 0; i < inventory.length; i++) {
        const row = inventory[i];
        if (!row) continue;
        const barcode = row[0];
        const branch = row[1];
        if (!map[branch]) map[branch] = {};
        map[branch][barcode] = Number(row[2]) || 0;
      }
    }
    return map;
  }, [inventory]);

  const getStock = (branchId, barcode) => {
    return (inventoryMap[branchId] && inventoryMap[branchId][barcode]) || 0;
  };

  const getAvgSales = (branchId, barcode) => {
    const itemMonthly = (monthlySales[branchId] && monthlySales[branchId][barcode]) || {};
    const values = Object.values(itemMonthly).map(Number).filter(v => !isNaN(v));
    if (values.length === 0) return 0;
    const rawAvg = values.reduce((a, b) => a + b, 0) / values.length;
    const normalValues = values.filter(v => v <= rawAvg * 1.6);
    return normalValues.length > 0 ? (normalValues.reduce((a, b) => a + b, 0) / normalValues.length) : rawAvg;
  };

  const getMonthValue = (m, defaultYear = 26) => {
    if (!m) return 0;
    if (!m.includes('.')) return defaultYear * 100 + Number(m);
    const parts = m.split('.');
    return Number(parts[1]) * 100 + Number(parts[0]);
  };

  // 1. Pre-calculate global sales map for cross-branch opportunities (uses monthlySales)
  const globalSalesMap = useMemo(() => {
    const map = new Map();
    
    if (opportunityLookback === 0) {
      // Sum monthly sales and track branches with sales across ALL branches for each barcode (All time)
      Object.entries(monthlySales).forEach(([branchId, branchData]) => {
        Object.entries(branchData).forEach(([barcode, months]) => {
          const total = Object.values(months).reduce((a, b) => a + (Number(b) || 0), 0);
          if (!map.has(barcode)) {
             map.set(barcode, { total: 0, branches: new Set() });
          }
          const data = map.get(barcode);
          data.total += total;
          if (total > 0) data.branches.add(branchId);
        });
      });
      return map;
    }

    // Filter by recent N months
    const allMonthsSet = new Set();
    Object.values(monthlySales).forEach(branchData => {
      Object.values(branchData).forEach(months => {
        Object.keys(months).forEach(m => allMonthsSet.add(m));
      });
    });
    
    let mYear = 26;
    allMonthsSet.forEach(m => {
      if (m.includes('.')) {
        const y = Number(m.split('.')[1]);
        if (y > mYear) mYear = y;
      }
    });

    const sortedMonths = Array.from(allMonthsSet).sort((a, b) => {
      return getMonthValue(b, mYear) - getMonthValue(a, mYear); // Descending (newest first)
    });

    const allowedMonthsSet = new Set(sortedMonths.slice(0, opportunityLookback));

    Object.entries(monthlySales).forEach(([branchId, branchData]) => {
      Object.entries(branchData).forEach(([barcode, months]) => {
        let total = 0;
        Object.entries(months).forEach(([m, qty]) => {
          if (allowedMonthsSet.has(m)) total += (Number(qty) || 0);
        });
        
        if (!map.has(barcode)) {
           map.set(barcode, { total: 0, branches: new Set() });
        }
        const data = map.get(barcode);
        data.total += total;
        if (total > 0) data.branches.add(branchId);
      });
    });

    return map;
  }, [monthlySales, opportunityLookback]);


  // 2. Helper for SAP numbers (handles trailing minus and commas)
  const parseSapNumber = (val) => {
    if (!val || val === '-') return 0;
    let s = val.toString().trim();
    // 1. Handle trailing minus (SAP format 1.00-)
    if (s.endsWith('-')) s = '-' + s.slice(0, -1);
    // 2. Remove commas (1,000.00 -> 1000.00)
    s = s.replace(/,/g, '');
    // 3. Handle Unicode minus/dash signs
    s = s.replace(/[–—]/g, '-');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };

  const recLookup = useMemo(() => {
    const lookup = {};
    if (Array.isArray(recommendations)) {
      for (let i = 0; i < recommendations.length; i++) {
        const r = recommendations[i];
        if (r && r.barcode && r.branchId) {
          lookup[`${r.barcode}_${r.branchId}`] = r;
        }
      }
    }
    return lookup;
  }, [recommendations]);

  // 3. Parser Logic
  const parsedData = useMemo(() => {
    if (!pastedText.trim()) return [];

    const lines = pastedText.split('\n');
    return lines.map(line => {
      const cols = line.split('\t');
      if (cols.length < 2) return null;

      const barcode = cols[0]?.trim();
      const desc = cols[1]?.trim();
      const sapStock = parseSapNumber(cols[2]);
      const sapSalesCurr = parseSapNumber(cols[3]);
      const sapSalesPrev = parseSapNumber(cols[4]);
      const sapPack = parseSapNumber(cols[5]) || 1;
      const sapInTransit = parseSapNumber(cols[6]);


      // --- Unified Average: app monthly sales + SAP curr/prev month ---
      const systemItem = recLookup[`${barcode}_${selectedBranch}`];
      const itemMonthly = (monthlySales[selectedBranch] && monthlySales[selectedBranch][barcode]) || {};
      const partialMonths = salesMetadata?.[selectedBranch]?.partialMonths || {};

      // App monthly values (last 6 months, normalized for partial months)
      const mValues = Object.keys(itemMonthly).sort((a,b) => {
        const pA = a.split('.'), pB = b.split('.');
        return (Number(pA[1]) - Number(pB[1])) || (Number(pA[0]) - Number(pB[0]));
      }).slice(-6).map(m => {
        const raw = itemMonthly[m] || 0;
        const days = partialMonths[m]?.days;
        return (days && days > 0 && days < 30) ? raw * (30 / days) : raw;
      });

      // Merge with SAP curr/prev month (only if > 0, to avoid adding empty months)
      const allValues = [...mValues];
      if (sapSalesPrev > 0) allValues.push(sapSalesPrev);   // previous month (complete)
      if (sapSalesCurr > 0) allValues.push(sapSalesCurr);   // current month (may be partial)

      let stableAvg = 0;
      let spikeVal = 0;

      if (allValues.length > 0) {
        const rawAvg = allValues.reduce((a,b) => a+b, 0) / allValues.length;
        const normalValues = allValues.filter(v => v <= rawAvg * 1.6);
        const spikes = allValues.filter(v => v > rawAvg * 1.6);

        stableAvg = normalValues.length > 0 ? (normalValues.reduce((a,b) => a+b, 0) / normalValues.length) : rawAvg;
        spikeVal = spikes.length > 0 ? Math.max(...spikes) : 0;
      }

      // Final avg: unified stableAvg, fallback to system recommendations
      const systemAvg = stableAvg || (systemItem ? systemItem.avgMonthlySales : 0);
      let targetAvg = systemAvg;


      let isOpportunity = false;
      let globalSalesVal = 0;
      let opportunityBranchesCount = 0;

      if (targetAvg === 0 && sapStock <= 0) {
        const globalData = globalSalesMap.get(barcode);
        if (globalData) {
          globalSalesVal = globalData.total;
          
          // Exclude the current branch from the "other branches" count
          const otherBranchesSet = new Set(globalData.branches);
          otherBranchesSet.delete(selectedBranch);
          opportunityBranchesCount = otherBranchesSet.size;

          if (globalSalesVal > 0 && opportunityBranchesCount >= opportunityLevel) {
            isOpportunity = true;
            targetAvg = (globalSalesVal / (settings.salesMonths || 6)) * 0.3;
          }
        }
      }

      // Convert selected days to months fraction for the target calculation
      const targetMonths = (orderDays || 30) / 30;
      const targetStock = targetAvg * targetMonths;
      const needed = Math.max(0, targetStock - sapStock - sapInTransit);
      
      // Transfer Logic
      let transferRec = 0;
      let transferStock = 0;
      let transferAvg = 0;

      if (transferSource !== 'none') {
        transferStock = getStock(transferSource, barcode);
        transferAvg = getAvgSales(transferSource, barcode);

        if (needed > 0) {
          const tIdealStock = Math.ceil((transferAvg / 30) * transferDays);
          const surplus = Math.max(0, transferStock - tIdealStock);
          
          if (surplus > 0) {
             transferRec = Math.floor(Math.min(surplus, needed));
          }
        }
      }

      let packs = Math.ceil(needed / (sapPack || 1));
      let orderPacksBase = packs;
      let finalNeeded = needed;
      
      // Apply Transfers
      if (applyTransfers && transferRec > 0) {
         finalNeeded = Math.max(0, needed - transferRec);
         orderPacksBase = Math.ceil(finalNeeded / (sapPack || 1));
      }
      
      const finalOrderPacks = manualOverrides[barcode] !== undefined ? manualOverrides[barcode] : orderPacksBase;
      const finalOrderQty = finalOrderPacks * (sapPack || 1);

      let reason = "";
      if (isOpportunity) reason = `⚡ פוטנציאל מתחרים (נמכר ב-${opportunityBranchesCount} סניפים)`;
      else if (transferRec > 0 && applyTransfers) reason = `🔄 קוזז עקב העברה (${transferRec} יח')`;
      else if (needed > 0 && sapStock === 0) reason = "🚨 חוסר מלאי אקוטי";
      else if (needed > 0) reason = "📦 השלמת מלאי קבוע";
      else if (finalOrderPacks > packs) reason = "✏️ יזומה (ידני)";
      else reason = "✅ לא נדרש";

      const p = products[barcode] || [];
      const supplierName = p[1] || '-';
      const supplierId = p[2] || '-';
      const warehouse = p[5] || '-';
      const merchandiseType = p[6] || '-';
      
      const isOrphan = !p || p.length === 0 || warehouse === '-' || warehouse === '';

      return {
        barcode, desc, sapStock, sapSalesCurr, sapSalesPrev,
        sapPack, sapInTransit,
        systemAvg: parseFloat(systemAvg.toFixed(2)),
        stableAvg: parseFloat(stableAvg.toFixed(2)),
        spikeVal: parseFloat(spikeVal.toFixed(2)),
        targetAvg: parseFloat(targetAvg.toFixed(2)),
        transferRec, transferSource: transferSource !== 'none' ? transferSource : 'none',
        transferStock, transferAvg,
        orderPacksBase, finalOrderPacks, finalOrderQty, isOpportunity, globalSalesVal, reason,
        supplierName, supplierId, warehouse, merchandiseType, isOrphan
      };
    }).filter(Boolean);
  }, [pastedText, recommendations, selectedBranch, globalSalesMap, settings, orderDays, opportunityLevel, opportunityLookback, manualOverrides, products, transferSource, transferDays, applyTransfers, inventoryMap, monthlySales]);

  // 3. Auto-detect warehouse and merchandise type based on majority
  useEffect(() => {
    if (parsedData.length === 0) return;

    const warehouseCounts = {};
    const typeCounts = {};

    parsedData.forEach(d => {
      if (d.warehouse && d.warehouse !== '-') {
        warehouseCounts[d.warehouse] = (warehouseCounts[d.warehouse] || 0) + 1;
      }
      if (d.merchandiseType && d.merchandiseType !== '-') {
        typeCounts[d.merchandiseType] = (typeCounts[d.merchandiseType] || 0) + 1;
      }
    });

    // Find modes
    const topWarehouse = Object.entries(warehouseCounts).sort((a,b) => b[1] - a[1])[0]?.[0];
    const topType = Object.entries(typeCounts).sort((a,b) => b[1] - a[1])[0]?.[0];

    if (topWarehouse) setWarehouseInput(topWarehouse);
    if (topType) setMerchandiseType(topType);
    
    // Auto-detect supplier from majority if possible
    const supplierCounts = {};
    parsedData.forEach(d => {
       if (d.supplierId && d.supplierId !== '-') {
         supplierCounts[d.supplierId] = (supplierCounts[d.supplierId] || 0) + 1;
       }
    });
    const topSupplier = Object.entries(supplierCounts).sort((a,b) => b[1] - a[1])[0]?.[0];
    if (topSupplier) {
      setSupplierInput(topSupplier);
      // Auto-detect name from existing products if possible
      const itemsWithThisSup = parsedData.filter(d => d.supplierId === topSupplier);
      const sampleItem = itemsWithThisSup.find(d => d.supplierName && d.supplierName !== 'כללי' && d.supplierName !== '-');
      if (sampleItem) {
        setSupplierNameInput(sampleItem.supplierName);
      }
    }

  }, [parsedData]);
  const displayData = useMemo(() => {
    return parsedData.filter(d => {
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch = !searchTerm ||
        d.desc.toLowerCase().includes(searchLower) ||
        d.barcode.includes(searchTerm);

      const matchesFilter =
        filterMode === 'all' ||
        (filterMode === 'to-order' && d.finalOrderPacks > 0) ||
        (filterMode === 'opportunity' && d.isOpportunity) ||
        (filterMode === 'no-order' && d.finalOrderPacks === 0 && !d.isOpportunity);

      const matchesWarehouse = filterWarehouse === 'all' || d.warehouse === filterWarehouse;

      return matchesSearch && matchesFilter && matchesWarehouse;
    });
  }, [parsedData, searchTerm, filterMode, filterWarehouse]);

  const copyQuantities = () => {
    if (displayData.length === 0) return;
    const qtys = displayData.map(d => d.finalOrderPacks).join('\n');
    navigator.clipboard.writeText(qtys);
    setSuccessMsg(`הועתקו ${displayData.length} כמויות (של הפריטים המוצגים בלבד)`);
    
    // Auto-save opportunities to Watchlist
    const opportunitiesOrdered = displayData.filter(d => d.isOpportunity && d.finalOrderPacks > 0);
    if (opportunitiesOrdered.length > 0) {
       addToWatchlist(opportunitiesOrdered, selectedBranch);
    }
    setTimeout(() => setSuccessMsg(''), 4000);
  };

  const copyBarcodes = () => {
    if (displayData.length === 0) return;
    const barcodes = displayData.map(d => d.barcode).join('\n');
    navigator.clipboard.writeText(barcodes);
    setSuccessMsg(`הועתקו ${displayData.length} ברקודים (של הפריטים המוצגים בלבד)`);
    setTimeout(() => setSuccessMsg(''), 4000);
  };

  // Sync handler
  const handleSyncInventory = () => {
    const finalMerchandiseType = merchandiseType === '__custom__' ? customMerchandiseType : merchandiseType;
    
    // Check for missing data
    const orphans = parsedData.filter(d => d.isOrphan || !d.supplierId || d.supplierId === '-');
    
    if (orphans.length > 0) {
      if (!supplierInput && !warehouseInput && !finalMerchandiseType) {
        alert(`שים לב: זוהו ${orphans.length} פריטים ללא ספק או מחסן. מומלץ למלא את השדות (ספק/מחסן) לפני הסנכרון כדי לעדכן אותם.`);
      } else {
        if (!window.confirm(`המערכת תעדכן כעת את הפרטים החסרים עבור ${orphans.length} פריטים. להמשיך?`)) {
          return;
        }
      }
    }

    syncInventoryFromSap(parsedData, selectedBranch, {
      supplierId: supplierInput,
      supplierName: supplierNameInput,
      warehouseId: warehouseInput,
      merchandiseType: finalMerchandiseType
    });
    setSyncConfirm(false);
    setSuccessMsg(`סונכן בהצלחה! עודכן ${parsedData.length} פריטים למלאי סניף ${selectedBranch}`);
    setTimeout(() => setSuccessMsg(''), 5000);
  };

  const exportToExcel = () => {
    const dataForExport = displayData.map(d => ({
      'ברקוד': d.barcode,
      'תיאור פריט': d.desc,
      'ספק': d.supplierName,
      'מספר ספק': d.supplierId,
      'מחלקה': (products[d.barcode] && products[d.barcode][7]) || '-',
      'קבוצה': (products[d.barcode] && products[d.barcode][8]) || '-',
      'מלאי (SAP)': d.sapStock,
      'מכר חודשי יציב': d.stableAvg ? d.stableAvg.toFixed(1) : d.systemAvg,
      'בדרך': d.sapInTransit,
      'מארז': d.sapPack,
      'כמות מומלצת לפני קיזוז (יח)': d.orderPacksBase * d.sapPack,
      'המלצת העברה (יח)': d.transferRec > 0 ? d.transferRec : 0,
      'מקור העברה': d.transferRec > 0 ? (BRANCH_NAMES[d.transferSource] || d.transferSource) : '-',
      'סה"כ כמות להזמנה סופית': d.finalOrderQty,
      'סיבה': d.reason
    }));

    const ws = XLSX.utils.json_to_sheet(dataForExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SAP Orders");
    XLSX.writeFile(wb, `SAP_Order_${selectedBranch}_${new Date().toLocaleDateString('he-IL').replace(/\./g, '-')}.xlsx`);
  };

  const clearData = () => {
    setPastedText('');
    setSearchTerm('');
    setFilterMode('all');
    setFilterWarehouse('all');
    setSuccessMsg('');
    setSyncConfirm(false);
    setManualOverrides({});
  };

  const filterCounts = useMemo(() => ({
    all: parsedData.length,
    'to-order': parsedData.filter(d => d.finalOrderPacks > 0).length,
    opportunity: parsedData.filter(d => d.isOpportunity).length,
    'no-order': parsedData.filter(d => d.finalOrderPacks === 0 && !d.isOpportunity).length,
  }), [parsedData]);

  return (
    <div className="sap-order-page">
      <div className="card mb-4 border-primary">
        <h3 className="mb-3 flex align-center gap-2">
          <Clipboard className="text-primary" />
          שלב 1: הדבקת נתונים מ-SAP
        </h3>
        <p className="text-secondary mb-3" style={{ fontSize: '0.9rem' }}>
          העתק את הטבלה מה-SAP (סמן את כל השורות הרלוונטיות) והדבק אותן כאן.
          סדר עמודות: ברקוד | תיאור | מלאי | מכר נוכחי | מכר קודם | מארז | בדרך
        </p>

        <div className="flex gap-4 mb-3 flex-wrap">
          <div style={{ flex: '0 0 160px' }}>
            <label className="label">בחר סניף להזמנה:</label>
            <select className="form-control" value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)}>
              {branches.map(b => (
                <option key={b} value={b}>{BRANCH_NAMES[b] || `סניף ${b}`} ({b})</option>
              ))}
            </select>
          </div>

          <div style={{ flex: '0 0 160px' }}>
            <label className="label">רמת דיוק הזדמנויות:</label>
            <select className="form-control" value={opportunityLevel} onChange={(e) => setOpportunityLevel(Number(e.target.value))}>
              <option value={1}>זמינות 1 (סניף אחד +)</option>
              <option value={2}>זמינות 2 (2 סניפים +)</option>
              <option value={3}>זמינות 3 (3 סניפים +)</option>
            </select>
          </div>

          <div style={{ flex: '0 0 180px' }}>
            <label className="label">היסטוריה (להזדמנויות):</label>
            <select className="form-control" value={opportunityLookback} onChange={(e) => setOpportunityLookback(Number(e.target.value))}>
              <option value={0}>כל ההיסטוריה</option>
              <option value={6}>6 חודשים אחרונים</option>
              <option value={3}>3 חודשים אחרונים</option>
            </select>
          </div>

          {/* ── Days-to-Order control ── */}
          <div style={{ flex: '1', minWidth: '280px' }}>
            <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <CalendarDays size={15} />
              כמה ימים להזמין:
              <span style={{
                marginRight: '0.4rem',
                background: 'var(--primary-color)',
                color: '#fff',
                borderRadius: '9999px',
                padding: '0.1rem 0.6rem',
                fontWeight: 700,
                fontSize: '0.85rem',
              }}>{orderDays} יום</span>
            </label>
            <div className="flex align-center gap-2 flex-wrap">
              {QUICK_DAYS.map(d => (
                <button
                  key={d}
                  onClick={() => setOrderDays(d)}
                  className={`btn btn-sm ${orderDays === d ? 'btn-primary' : 'btn-outline'}`}
                  style={{ padding: '0.3rem 0.75rem', fontSize: '0.85rem', minWidth: '42px' }}
                >
                  {d}
                </button>
              ))}
              <input
                id="sap-order-days-input"
                type="number"
                min="1"
                max="365"
                className="form-control"
                style={{ width: '80px', padding: '0.3rem 0.5rem', fontSize: '0.9rem' }}
                value={orderDays}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  if (v > 0) setOrderDays(v);
                }}
                placeholder="ימים"
              />
            </div>
          </div>

          <div className="flex align-end gap-2">
            <button className="btn btn-outline" onClick={clearData}>
              <Trash2 size={18} /> נקה הכל
            </button>
          </div>
        </div>

        <textarea
          className="form-control"
          rows="6"
          placeholder="הדבק כאן את הנתונים מה-SAP..."
          style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
        ></textarea>

        {parsedData.some(d => d.isOrphan) && (
          <div style={{
            marginTop: '1rem',
            padding: '0.75rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid #ef4444',
            borderRadius: '8px',
            color: '#b91c1c',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <AlertCircle size={18} />
            <strong>שים לב:</strong> זוהו פריטים ללא מחסן או סיווג. מילוי השדות למטה (ספק/מחסן) יעדכן אותם אוטומטית בסנכרון.
          </div>
        )}

        {/* ── Transfer Integration (NEW) ── */}
        <div className="flex align-center gap-4 mt-3 mb-3 p-3" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '8px', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 'bold', color: '#059669', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <RefreshCw size={18} /> שילוב העברות אוטומטי (חיסכון ברכש):
          </div>
          <select 
             className="form-control" 
             style={{ width: '250px', background: '#fff', border: '1px solid #10b981' }}
             value={transferSource}
             onChange={e => setTransferSource(e.target.value)}
          >
             <option value="none">ללא חיפוש העברות</option>
             {branches.filter(b => b !== selectedBranch).map(b => (
               <option key={b} value={b}>בדוק עודפים ב-{BRANCH_NAMES[b] || b} ({b})</option>
             ))}
          </select>
          {transferSource !== 'none' && (
            <>
              <div className="flex align-center gap-2">
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#059669' }}>תשאיר מלאי (ימים):</span>
                <input 
                  type="number" 
                  className="form-control" 
                  style={{ width: '70px', background: '#fff', border: '1px solid #10b981', textAlign: 'center', fontWeight: 'bold' }} 
                  value={transferDays} 
                  onChange={e => setTransferDays(Number(e.target.value) || 0)} 
                  min="1"
                />
              </div>
              <label className="flex align-center gap-2" style={{ cursor: 'pointer', fontWeight: 'bold', color: applyTransfers ? '#059669' : 'var(--text-color)', padding: '0.4rem 0.8rem', background: applyTransfers ? 'rgba(16,185,129,0.1)' : 'transparent', borderRadius: '8px', border: applyTransfers ? '1px solid #10b981' : '1px solid transparent', transition: 'all 0.2s' }}>
                <input 
                  type="checkbox" 
                  checked={applyTransfers}
                  onChange={e => setApplyTransfers(e.target.checked)}
                  style={{ width: '18px', height: '18px', accentColor: '#10b981' }}
                />
                אשר העברה וקזז אוטומטית מההזמנה
              </label>
            </>
          )}
        </div>

        {/* ── Sync metadata fields (show only when there's data) ── */}
        {parsedData.length > 0 && (
          <div style={{
            marginTop: '1rem',
            padding: '1rem',
            background: 'rgba(79,70,229,0.04)',
            border: '1px solid rgba(79,70,229,0.2)',
            borderRadius: '8px',
          }}>
            <div className="flex align-center gap-2 mb-3" style={{ fontWeight: 700, color: 'var(--primary-color)' }}>
              <DatabaseZap size={18} />
              עדכון מלאי מה-SAP – מידע לסיווג פריטים
            </div>
            <div className="flex gap-4 flex-wrap align-end">
              <div style={{ flex: '0 0 160px' }}>
                <label className="label">בחר מחסן:</label>
                <select 
                  className="form-control"
                  value={warehouseInput}
                  onChange={e => setWarehouseInput(e.target.value)}
                >
                  <option value="">-- ללא מחסן --</option>
                  {WAREHOUSES.map(wh => <option key={wh} value={wh}>{wh}</option>)}
                  <option value="__custom__">✏️ מחסן אחר</option>
                </select>
              </div>
              
              {warehouseInput === '__custom__' && (
                 <div style={{ flex: '0 0 120px' }}>
                    <label className="label">מספר מחסן:</label>
                    <input 
                      type="text" 
                      className="form-control" 
                      placeholder="מחסן..." 
                      onChange={e => setWarehouseInput(e.target.value)} 
                    />
                 </div>
              )}

              <div style={{ flex: '0 0 140px' }}>
                <label className="label">מספר ספק:</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="לדוגמא: 910320"
                  value={supplierInput}
                  onChange={e => setSupplierInput(e.target.value)}
                />
              </div>

              <div style={{ flex: '0 0 160px' }}>
                <label className="label">שם ספק:</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="לדוגמא: פארם אקספרס"
                  value={supplierNameInput}
                  onChange={e => setSupplierNameInput(e.target.value)}
                />
              </div>

              <div style={{ flex: '0 0 180px' }}>
                <label className="label">סוג סחורה:</label>
                <select
                  id="sap-merchandise-type-select"
                  className="form-control"
                  value={merchandiseType}
                  onChange={e => setMerchandiseType(e.target.value)}
                >
                  <option value="">ללא סיווג</option>
                  {MERCHANDISE_TYPES.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                  <option value="__custom__">✏️ אחר (ידני)</option>
                </select>
              </div>
              {merchandiseType === '__custom__' && (
                <div style={{ flex: '0 0 200px' }}>
                  <label className="label">סוג חופשי:</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="הקלד סוג סחורה..."
                    value={customMerchandiseType}
                    onChange={e => setCustomMerchandiseType(e.target.value)}
                  />
                </div>
              )}
              <div>
                <button
                  id="sap-sync-inventory-btn"
                  className="btn"
                  style={{
                    background: syncConfirm ? '#dc2626' : '#0d9488',
                    color: '#fff',
                    fontWeight: 700,
                    transition: 'background 0.2s',
                  }}
                  onClick={() => setSyncConfirm(v => !v)}
                  disabled={parsedData.length === 0}
                >
                  <DatabaseZap size={18} />
                  {syncConfirm ? 'בטל' : 'עדכן מלאי מ-SAP'}
                </button>
              </div>
            </div>

            {/* Confirmation panel */}
            {syncConfirm && (
              <div style={{
                marginTop: '1rem',
                padding: '1rem',
                background: 'rgba(220,38,38,0.07)',
                border: '1px solid rgba(220,38,38,0.3)',
                borderRadius: '8px',
              }}>
                <p style={{ fontWeight: 700, marginBottom: '0.5rem', color: '#dc2626' }}>
                  ⚠️ אישור עדכון מלאי
                </p>
                <div className="flex gap-4 mb-3" style={{ fontSize: '0.9rem' }}>
                  <span>סניף: <strong>{selectedBranch}</strong></span>
                  <span>פריטים: <strong>{parsedData.length}</strong></span>
                  {warehouseInput && <span>מחסן/ספק: <strong>{warehouseInput}</strong></span>}
                  {(merchandiseType || customMerchandiseType) && (
                    <span>סוג סחורה: <strong>{merchandiseType === '__custom__' ? customMerchandiseType : merchandiseType}</strong></span>
                  )}
                </div>
                <p className="text-secondary" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                  פריטים קיימים – יעודכן למלאי SAP. פריטים חדשים שאינם במערכת – יתווספו אוטומטית. פעולה זו אינה הפיכה!
                </p>
                <button
                  className="btn"
                  style={{ background: '#dc2626', color: '#fff', fontWeight: 700 }}
                  onClick={handleSyncInventory}
                >
                  ✅ אשר – עדכן {parsedData.length} פריטים
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {parsedData.length > 0 && (
        <div className="card">
          <div className="flex justify-between align-center mb-4">
            <h3 className="flex align-center gap-2">
              <RefreshCw className="text-success" />
              שלב 2: המלצת רכש משולבת ({displayData.length} / {parsedData.length} פריטים)
              <span style={{
                marginRight: '0.5rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                background: 'rgba(79,70,229,0.1)',
                color: 'var(--primary-color)',
                padding: '0.2rem 0.7rem',
                borderRadius: '9999px',
              }}>⏱ {orderDays} יום</span>
            </h3>
            <div className="flex align-center gap-3">
              {successMsg && <span className="text-success font-bold flex align-center gap-1"><CheckCircle2 size={18}/> {successMsg}</span>}
              <button
                className="btn"
                style={{
                  background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                  color: '#fff',
                  fontWeight: 700,
                  boxShadow: '0 2px 8px rgba(79,70,229,0.35)',
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                }}
                onClick={() => setShowOrderModal(true)}
              >
                <LayoutGrid size={18} /> 📋 סקירת הזמנה מהירה
              </button>
              <button className="btn btn-outline" style={{ color: 'var(--primary-color)', borderColor: 'var(--primary-color)' }} onClick={exportToExcel}>
                <Download size={18} /> ייצא לאקסל
              </button>
              <button className="btn btn-secondary" onClick={copyBarcodes}>
                <Copy size={18} /> העתק ברקודים ל-SAP
              </button>
              <button className="btn btn-success" onClick={copyQuantities}>
                <Clipboard size={18} /> העתק כמויות ל-SAP
              </button>
            </div>
          </div>

          {/* Search + Filter bar */}
          <div className="flex gap-3 mb-4 align-center flex-wrap">
            <div className="flex align-center gap-2 flex-1" style={{ minWidth: '250px' }}>
              <Search size={18} className="text-muted" />
              <input
                type="text"
                placeholder="חיפוש לפי שם פריט או ברקוד..."
                className="form-control"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            
            <div className="flex align-center gap-2">
              <select
                className="form-control"
                style={{ width: '150px' }}
                value={filterWarehouse}
                onChange={(e) => setFilterWarehouse(e.target.value)}
              >
                <option value="all">כל המחסנים</option>
                <option value="6000">6000</option>
                <option value="6030">6030</option>
                <option value="6032">6032</option>
                <option value="6047">6047</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Filter size={18} className="text-muted" style={{ marginTop: '8px' }}/>
              {[
                { key: 'all', label: 'הכל' },
                { key: 'to-order', label: '📦 להזמנה' },
                { key: 'opportunity', label: '⚡ הזדמנויות' },
                { key: 'no-order', label: '✅ ללא הזמנה' },
              ].map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilterMode(f.key)}
                  className={`btn btn-sm ${filterMode === f.key ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: '0.85rem', padding: '0.35rem 0.75rem' }}
                >
                  {f.label} ({filterCounts[f.key]})
                </button>
              ))}
            </div>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>פריט (SAP)</th>
                  <th>מלאי (SAP)</th>
                  <th>מכר (נוכחי/קודם)</th>
                  <th style={{ minWidth: '120px' }}>ספק</th>
                  <th>מכר (אתר)</th>
                  <th>בדרך</th>
                  <th>סיבת המלצה</th>
                  <th>מכר חודשי (היסטוריה)</th>
                  {transferSource !== 'none' && <th style={{ color: '#059669', textAlign: 'center' }}>העברה זמינה</th>}
                  <th className="text-primary-color" style={{width: '120px', textAlign: 'center'}}>כמות למארז</th>
                </tr>
              </thead>
              <tbody>
                {displayData.length > 0 ? displayData.map((d, idx) => (
                  <tr key={idx} className={d.isOpportunity ? 'bg-info-light' : ''}>
                    <td>
                      <div className="flex align-center gap-2">
                        <div className="font-bold">{d.desc}</div>
                        {d.isOrphan && (
                           <span className="badge" style={{ background: '#f59e0b', color: '#fff', fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>חדש / ללא סיווג</span>
                        )}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>{d.barcode}</div>
                    </td>
                    <td>{d.sapStock}</td>
                    <td>
                      <div>{d.sapSalesCurr} / {d.sapSalesPrev}</div>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>חודש נוכחי/קודם</div>
                    </td>
                    <td>
                      <div className="font-bold" style={{ fontSize: '0.85rem' }}>{d.supplierName}</div>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>{d.supplierId}</div>
                    </td>
                    <td>{d.systemAvg}</td>
                    <td><span className={d.sapInTransit > 0 ? 'text-primary font-bold' : ''}>{d.sapInTransit}</span></td>
                    <td>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{d.reason}</div>
                      {d.isOpportunity && (
                        <div className="text-warning font-bold" style={{fontSize: '0.75rem'}}>
                           ({d.globalSalesVal} יח׳ ברשת)
                        </div>
                      )}
                    </td>
                    <td>
                       <div className="flex gap-2 align-center">
                         <div style={{
                           padding: '6px 12px',
                           background: 'rgba(59,130,246,0.1)',
                           color: '#2563eb',
                           borderRadius: '10px',
                           border: '1px solid rgba(59,130,246,0.2)',
                           textAlign: 'center',
                           minWidth: '60px'
                         }}>
                           <div style={{fontSize:'0.6rem', fontWeight:'bold'}}>ממוצע יציב</div>
                           <div style={{fontSize:'1rem', fontWeight:'900'}}>{d.stableAvg ? d.stableAvg.toFixed(1) : '-'}</div>
                         </div>
                         
                         {d.spikeVal > 0 && (
                           <div style={{
                             padding: '6px 12px',
                             background: 'rgba(239,68,68,0.1)',
                             color: '#ef4444',
                             borderRadius: '10px',
                             border: '1px solid rgba(239,68,68,0.2)',
                             textAlign: 'center',
                             minWidth: '60px'
                           }}>
                             <div style={{fontSize:'0.6rem', fontWeight:'bold'}}>מבצע/חריג</div>
                             <div style={{fontSize:'1rem', fontWeight:'900'}}>{d.spikeVal}</div>
                           </div>
                         )}
                       </div>
                     </td>
                     
                     {/* TRANSFER COLUMN */}
                     {transferSource !== 'none' && (
                       <td style={{ textAlign: 'center', background: d.transferRec > 0 ? 'rgba(16,185,129,0.08)' : 'transparent', borderLeft: '2px solid rgba(16,185,129,0.2)' }}>
                         {d.transferRec > 0 ? (
                           <div>
                             <div style={{ fontSize: '1.2rem', fontWeight: 900, color: '#059669' }}>{d.transferRec} יח'</div>
                             <div style={{ fontSize: '0.7rem', fontWeight: 'bold', color: '#64748b' }}>
                               מסניף {BRANCH_NAMES[d.transferSource] || d.transferSource}<br/>
                               מלאי: {d.transferStock} | מכר: {d.transferAvg.toFixed(1)}
                             </div>
                           </div>
                         ) : (
                           <div style={{ color: '#94a3b8', fontSize: '0.7rem', fontWeight: 'bold' }}>
                             אין העברה<br/>
                             <span style={{ fontSize: '0.65rem', fontWeight: 'normal' }}>מלאי שם: {d.transferStock} | מכר: {d.transferAvg.toFixed(1)}</span>
                           </div>
                         )}
                       </td>
                     )}

                    <td className="bg-primary-light" style={{textAlign: 'center'}}>
                      <input 
                         type="number" 
                         min="0"
                         className="form-control mb-1" 
                         value={d.finalOrderPacks}
                         onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            setManualOverrides(prev => ({...prev, [d.barcode]: val}));
                         }}
                         style={{ 
                            width: '70px', 
                            textAlign: 'center', 
                            fontWeight: 'bold', 
                            fontSize: '1.1rem',
                            display: 'inline-block',
                            border: d.finalOrderPacks !== d.orderPacksBase ? '2px solid var(--warning-color)' : '1px solid #ccc'
                         }}
                      />
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                        סה"כ {d.finalOrderQty} יח'
                      </div>
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan="7" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                      לא נמצאו תוצאות לחיפוש/סינון הנוכחי.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Order Review Modal ── */}
      {showOrderModal && (
        <OrderReviewModal
          items={parsedData}
          manualOverrides={manualOverrides}
          setManualOverrides={setManualOverrides}
          monthlySales={monthlySales}
          products={products}
          selectedBranch={selectedBranch}
          onClose={() => setShowOrderModal(false)}
        />
      )}
    </div>
  );
};

export default SapOrder;

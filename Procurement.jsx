import React, { useState, useMemo, useEffect } from 'react';
import { useData, BRANCH_NAMES } from '../context/DataContext';
import { Search, Filter, Download, ShoppingCart, Store, ArrowLeftRight, HelpCircle, Package, Layers, Info, Check } from 'lucide-react';
import * as XLSX from 'xlsx';

const Procurement = () => {
  const { products, inventory, monthlySales, sales, settings, loading, externalFilters } = useData();
  const branches = Object.keys(BRANCH_NAMES);

  // Settings
  const [targetBranch, setTargetBranch] = useState(branches[0] || '631');
  const [shortageType, setShortageType] = useState('all'); // all | localSales | networkOpps
  const [availabilityLevel, setAvailabilityLevel] = useState(1); // 1 | 2 | 3
  const [orderDays, setOrderDays] = useState(30);
  const [noLocalSalesMethod, setNoLocalSalesMethod] = useState('networkAvg'); // networkAvg | bestBranch | zero

  // Search & Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [filterGroup, setFilterGroup] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterBrand, setFilterBrand] = useState('');

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  useEffect(() => {
    if (externalFilters?.search) {
      setSearchTerm(externalFilters.search);
    }
  }, [externalFilters]);

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

  // Get all barcodes that have any sales data (either in monthlySales or sales array)
  const barcodesWithSales = useMemo(() => {
    const set = new Set();
    if (Array.isArray(sales)) {
      for (let i = 0; i < sales.length; i++) {
        const s = sales[i];
        if (s && s[0]) {
          set.add(s[0]);
        }
      }
    }
    if (monthlySales) {
      Object.keys(monthlySales).forEach(branchId => {
        const branchData = monthlySales[branchId];
        if (branchData) {
          Object.keys(branchData).forEach(barcode => {
            set.add(barcode);
          });
        }
      });
    }
    return set;
  }, [sales, monthlySales]);

  // Branch total sales power for scaling logic
  const branchPower = useMemo(() => {
    const power = {};
    branches.forEach(b => {
      power[b] = 0;
    });

    let hasSalesData = sales.length > 0;
    if (hasSalesData) {
      sales.forEach(s => {
        if (s && power[s[1]] !== undefined) {
          power[s[1]] += s[2] || 0;
        }
      });
    } else {
      Object.entries(monthlySales).forEach(([branchId, branchData]) => {
        if (power[branchId] !== undefined) {
          Object.values(branchData).forEach(months => {
            power[branchId] += Object.values(months).reduce((acc, v) => acc + (Number(v) || 0), 0);
          });
        }
      });
    }
    return power;
  }, [sales, monthlySales, branches]);

  // Pre-calculated average monthly sales map for O(1) lookups
  const averageSalesMap = useMemo(() => {
    const map = {};
    if (!products) return map;

    // Create a fast lookup map for the sales array: `${barcode}_${branchId}` -> qty
    const salesLookup = {};
    if (Array.isArray(sales)) {
      for (let i = 0; i < sales.length; i++) {
        const s = sales[i];
        if (s && s[0] && s[1]) {
          salesLookup[`${s[0]}_${s[1]}`] = s[2] || 0;
        }
      }
    }

    const monthsCount = Math.max(1, settings.salesMonths || 6);

    barcodesWithSales.forEach(barcode => {
      if (!products[barcode]) return;

      map[barcode] = {};
      branches.forEach(branchId => {
        const itemMonthly = (monthlySales[branchId] && monthlySales[branchId][barcode]) || {};
        const mKeys = Object.keys(itemMonthly);
        if (mKeys.length > 0) {
          const sorted = mKeys.sort((a, b) => {
            const pA = a.split('.'), pB = b.split('.');
            return (Number(pA[1]) - Number(pB[1])) || (Number(pA[0]) - Number(pB[0]));
          }).slice(-6);
          const values = sorted.map(m => itemMonthly[m] || 0);
          const sum = values.reduce((acc, val) => acc + val, 0);
          map[barcode][branchId] = parseFloat((sum / Math.max(1, sorted.length)).toFixed(2));
        } else {
          const qty = salesLookup[`${barcode}_${branchId}`] || 0;
          map[barcode][branchId] = parseFloat((qty / monthsCount).toFixed(2));
        }
      });
    });

    return map;
  }, [products, monthlySales, sales, settings.salesMonths, branches, barcodesWithSales]);

  // Main shortage identification logic
  const shortages = useMemo(() => {
    if (!products || Object.keys(products).length === 0) return [];

    const list = [];

    barcodesWithSales.forEach(barcode => {
      const p = products[barcode];
      if (!p) return;

      const status = p[10] || 'פעיל';
      if (status !== 'פעיל') return; // only active items

      // Shortage check: stock in target branch must be 0
      const stockInTarget = getStock(targetBranch, barcode);
      if (stockInTarget > 0) return;

      const avgInTarget = (averageSalesMap[barcode] && averageSalesMap[barcode][targetBranch]) || 0;

      // Count how many branches have sales (> 0)
      const sellingBranches = branches.filter(bId => ((averageSalesMap[barcode] && averageSalesMap[barcode][bId]) || 0) > 0);
      const totalSellingCount = sellingBranches.length;

      // Shortage classification
      const isLocalShortage = avgInTarget > 0;

      // Filter by availability level
      if (totalSellingCount < availabilityLevel) return;

      // Filter by shortage type
      if (shortageType === 'localSales' && !isLocalShortage) return;
      if (shortageType === 'networkOpps' && isLocalShortage) return;

      // Calculate order recommendations
      let needed = 0;
      if (isLocalShortage) {
        // Based on local sales history
        needed = avgInTarget * (orderDays / 30);
      } else {
        // Based on network sales (variety shortage)
        if (noLocalSalesMethod === 'networkAvg') {
          const otherSellingBranches = sellingBranches.filter(b => b !== targetBranch);
          const sumOtherAvg = otherSellingBranches.reduce((acc, b) => acc + (averageSalesMap[barcode][b] || 0), 0);
          const networkAvg = otherSellingBranches.length > 0 ? (sumOtherAvg / otherSellingBranches.length) : 0;
          needed = networkAvg * (orderDays / 30);
        } else if (noLocalSalesMethod === 'bestBranch') {
          let bestBranch = null;
          let bestAvg = 0;
          branches.forEach(b => {
            const avg = (averageSalesMap[barcode] && averageSalesMap[barcode][b]) || 0;
            if (avg > bestAvg) {
              bestAvg = avg;
              bestBranch = b;
            }
          });
          if (bestBranch) {
            const targetPower = branchPower[targetBranch] || 1;
            const bestPower = branchPower[bestBranch] || 1;
            const ratio = targetPower / bestPower;
            needed = bestAvg * ratio * (orderDays / 30);
          }
        } else {
          needed = 0;
        }
      }

      const packFactor = p[4] || 1;
      const packs = Math.ceil(needed / packFactor);
      const recommendedUnits = packs * packFactor;

      list.push({
        barcode,
        desc: p[0] || 'ללא תיאור',
        supplierName: p[1] || '-',
        supplierId: p[2] || '-',
        brand: p[3] || '-',
        packFactor,
        warehouse: p[5] || '-',
        merchandiseType: p[6] || '-',
        department: p[7] || '-',
        group: p[8] || '-',
        subGroup: p[9] || '-',
        status,
        price: p[11] || 0,
        avgInTarget,
        totalSellingCount,
        sellingBranches,
        isLocalShortage,
        needed,
        recommendedUnits,
        recommendedPacks: packs
      });
    });

    // Sort by sales in target branch (if local shortage) or network sales desc
    return list.sort((a, b) => {
      if (a.isLocalShortage && b.isLocalShortage) {
        return b.avgInTarget - a.avgInTarget;
      }
      if (a.isLocalShortage !== b.isLocalShortage) {
        return a.isLocalShortage ? -1 : 1; // local shortages first
      }
      // Sort variety shortages by average sales in other branches
      const aOtherAvg = a.sellingBranches.reduce((sum, b) => sum + (averageSalesMap[a.barcode][b] || 0), 0) / a.sellingBranches.length;
      const bOtherAvg = b.sellingBranches.reduce((sum, b) => sum + (averageSalesMap[b.barcode][b] || 0), 0) / b.sellingBranches.length;
      return bOtherAvg - aOtherAvg;
    });
  }, [products, inventoryMap, targetBranch, availabilityLevel, shortageType, averageSalesMap, orderDays, noLocalSalesMethod, branchPower, branches, barcodesWithSales]);

  // Apply filters
  const filteredShortages = useMemo(() => {
    return shortages.filter(item => {
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch = !searchTerm ||
        item.desc.toLowerCase().includes(searchLower) ||
        item.barcode.includes(searchLower);

      const matchesSupplier = !filterSupplier ||
        item.supplierName.toLowerCase().includes(filterSupplier.toLowerCase()) ||
        item.supplierId.includes(filterSupplier);

      const matchesWarehouse = !filterWarehouse ||
        item.warehouse.toLowerCase().includes(filterWarehouse.toLowerCase());

      const matchesDepartment = !filterDepartment ||
        item.department.toLowerCase().includes(filterDepartment.toLowerCase());

      const matchesGroup = !filterGroup ||
        item.group.toLowerCase().includes(filterGroup.toLowerCase());

      const matchesType = !filterType ||
        item.merchandiseType.toLowerCase().includes(filterType.toLowerCase());

      const matchesBrand = !filterBrand ||
        item.brand.toLowerCase().includes(filterBrand.toLowerCase());

      return matchesSearch && matchesSupplier && matchesWarehouse && matchesDepartment && matchesGroup && matchesType && matchesBrand;
    });
  }, [shortages, searchTerm, filterSupplier, filterWarehouse, filterDepartment, filterGroup, filterType, filterBrand]);

  // Reset page on filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [targetBranch, shortageType, availabilityLevel, searchTerm, filterSupplier, filterWarehouse, filterDepartment, filterGroup, filterType, filterBrand]);

  // Unique options for dropdown filters
  const filterOptions = useMemo(() => {
    const opts = { suppliers: new Set(), warehouses: new Set(), departments: new Set(), groups: new Set(), types: new Set(), brands: new Set() };
    shortages.forEach(item => {
      if (item.supplierName && item.supplierName !== '-') opts.suppliers.add(`${item.supplierId} | ${item.supplierName}`);
      if (item.warehouse && item.warehouse !== '-') opts.warehouses.add(item.warehouse);
      if (item.department && item.department !== '-') opts.departments.add(item.department);
      if (item.group && item.group !== '-') opts.groups.add(item.group);
      if (item.merchandiseType && item.merchandiseType !== '-') opts.types.add(item.merchandiseType);
      if (item.brand && item.brand !== '-') opts.brands.add(item.brand);
    });
    return {
      suppliers: Array.from(opts.suppliers).sort(),
      warehouses: Array.from(opts.warehouses).sort(),
      departments: Array.from(opts.departments).sort(),
      groups: Array.from(opts.groups).sort(),
      types: Array.from(opts.types).sort(),
      brands: Array.from(opts.brands).sort(),
    };
  }, [shortages]);

  // Pagination
  const totalPages = Math.ceil(filteredShortages.length / itemsPerPage);
  const displayItems = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredShortages.slice(start, start + itemsPerPage);
  }, [filteredShortages, currentPage]);

  const stats = useMemo(() => {
    return {
      total: filteredShortages.length,
      localCount: filteredShortages.filter(i => i.isLocalShortage).length,
      varietyCount: filteredShortages.filter(i => !i.isLocalShortage).length,
      totalUnits: filteredShortages.reduce((acc, i) => acc + i.recommendedUnits, 0),
      totalPacks: filteredShortages.reduce((acc, i) => acc + i.recommendedPacks, 0),
    };
  }, [filteredShortages]);

  const exportToExcel = () => {
    const dataToExport = filteredShortages.map(item => {
      const row = {
        'برקוד / קוד פריט': item.barcode,
        'תיאור פריט': item.desc,
        'מספר ספק': item.supplierId,
        'שם ספק': item.supplierName,
        'מותג': item.brand,
        'מחסן': item.warehouse,
        'סוג סחורה': item.merchandiseType,
        'מחלקה': item.department,
        'קבוצה': item.group,
        'סוג חוסר': item.isLocalShortage ? 'מכר עצמי בסניף' : 'מגוון רשת (חדש בסניף)',
        'גורם אירוז (מארז)': item.packFactor,
      };

      branches.forEach(bId => {
        row[`ממוצע מכר (${BRANCH_NAMES[bId] || bId})`] = averageSalesMap[item.barcode]?.[bId] || 0;
      });

      row['המלצה להזמנה (יחידות)'] = item.recommendedUnits;
      row['המלצה להזמנה (מארזים)'] = item.recommendedPacks;

      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(dataToExport);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "דוח חוסרים");
    
    const branchName = BRANCH_NAMES[targetBranch] || targetBranch;
    const typeLabel = shortageType === 'localSales' ? 'מכר_עצמי' : shortageType === 'networkOpps' ? 'מגוון_רשת' : 'כלל_החוסרים';
    XLSX.writeFile(workbook, `דוח_חוסרים_${branchName}_${typeLabel}_${new Date().toLocaleDateString('he-IL').replace(/\//g, '-')}.xlsx`);
  };

  const handlePageChange = (newPage) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
      document.querySelector('.page-content')?.scrollTo(0, 0);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-slate-500 font-bold">טוען נתונים ומחשב חוסרים...</div>;
  }

  return (
    <div className="procurement-page" style={{ direction: 'rtl', padding: '1rem 0' }}>
      
      {/* Introduction Card */}
      <div className="card mb-4" style={{ backgroundColor: 'rgba(79, 70, 229, 0.05)', border: '1px solid var(--primary-color)' }}>
        <div className="flex align-center gap-2 text-primary font-bold">
          <ShoppingCart size={20} />
          מידע על דוח חוסרים ורכש:
        </div>
        <p className="mt-2 text-secondary" style={{ fontSize: '0.9rem' }}>
          מנוע זה מזהה פריטים שאינם קיימים במלאי (מלאי = 0) בסניף המבוקש.
          הדוח מציג פריטים שנמכרו בעבר בסניף זה (<strong>מכר עצמי</strong>) או פריטים שטרם הוכנסו למלאי אך נמכרים בסניפי רשת אחרים (<strong>מגוון רשת</strong>) בהתאם לרמת הזמינות הנבחרת.
        </p>
      </div>

      {/* Main Settings Card */}
      <div className="card mb-4">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', alignItems: 'end' }}>
          
          <div>
            <label className="label font-bold text-secondary mb-1 block" style={{ fontSize: '0.85rem' }}>סניף מבוקש (מלאי = 0):</label>
            <select 
              className="form-control" 
              style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 'bold' }}
              value={targetBranch} 
              onChange={e => setTargetBranch(e.target.value)}
            >
              {branches.map(b => (
                <option key={b} value={b}>{BRANCH_NAMES[b] || b} ({b})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label font-bold text-secondary mb-1 block" style={{ fontSize: '0.85rem' }}>סוג חוסר לסריקה:</label>
            <select 
              className="form-control" 
              style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 'bold' }}
              value={shortageType} 
              onChange={e => setShortageType(e.target.value)}
            >
              <option value="all">כלל החוסרים (מכר עצמי + מגוון רשת)</option>
              <option value="localSales">חוסר מכר עצמי (נמכר בסניף בעבר וכרגע חסר)</option>
              <option value="networkOpps">חוסר מגוון רשת (נמכר בסניפים אחרים וחסר כאן)</option>
            </select>
          </div>

          <div>
            <label className="label font-bold text-secondary mb-1 block" style={{ fontSize: '0.85rem' }}>רמת זמינות ברשת (מכירות):</label>
            <select 
              className="form-control" 
              style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 'bold' }}
              value={availabilityLevel} 
              onChange={e => setAvailabilityLevel(Number(e.target.value))}
            >
              <option value={1}>נמכר בלפחות סניף 1 ומעלה (1+)</option>
              <option value={2}>נמכר בלפחות 2 סניפים ומעלה (2+)</option>
              <option value={3}>נמכר בלפחות 3 סניפים ומעלה (3+)</option>
            </select>
          </div>

          <div>
            <label className="label font-bold text-secondary mb-1 block" style={{ fontSize: '0.85rem' }}>ימי מלאי להזמנה (מלאי מטרה):</label>
            <input 
              type="number" 
              className="form-control" 
              style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 'bold' }}
              value={orderDays} 
              min="1" 
              onChange={e => setOrderDays(Number(e.target.value) || 30)}
            />
          </div>

          <div>
            <label className="label font-bold text-secondary mb-1 block" style={{ fontSize: '0.85rem' }}>חישוב לפריט ללא מכר מקומי:</label>
            <select 
              className="form-control" 
              style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 'bold' }}
              value={noLocalSalesMethod} 
              onChange={e => setNoLocalSalesMethod(e.target.value)}
            >
              <option value="networkAvg">לפי ממוצע רשת (ממוצע סניפים מוכרים)</option>
              <option value="bestBranch">לפי סניף מוביל (מנורמל יחס כוח סניף)</option>
              <option value="zero">ללא המלצה אוטומטית (0)</option>
            </select>
          </div>

        </div>
      </div>

      {/* Statistics Dashboard */}
      <div className="dashboard-grid mb-4">
        
        <div className="card stat-card" style={{ marginBottom: 0 }}>
          <div className="stat-icon" style={{ backgroundColor: 'rgba(79, 70, 229, 0.1)', color: 'var(--primary-color)' }}>
            <ShoppingCart size={24} />
          </div>
          <div className="stat-details">
            <h3>{stats.total}</h3>
            <p>סה"כ פריטים חסרים</p>
          </div>
        </div>

        <div className="card stat-card" style={{ marginBottom: 0 }}>
          <div className="stat-icon" style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', color: 'var(--success-color)' }}>
            <Store size={24} />
          </div>
          <div className="stat-details">
            <h3>{stats.localCount}</h3>
            <p>מכר עצמי שחסר במלאי</p>
          </div>
        </div>

        <div className="card stat-card" style={{ marginBottom: 0 }}>
          <div className="stat-icon" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning-color)' }}>
            <ArrowLeftRight size={24} />
          </div>
          <div className="stat-details">
            <h3>{stats.varietyCount}</h3>
            <p>חוסרי מגוון (מכר רשתי)</p>
          </div>
        </div>

        <div className="card stat-card" style={{ marginBottom: 0 }}>
          <div className="stat-icon" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger-color)' }}>
            <Package size={24} />
          </div>
          <div className="stat-details">
            <h3>{stats.totalUnits} <span style={{ fontSize: '0.8rem', fontWeight: 'normal', color: 'var(--text-secondary)' }}>({stats.totalPacks} מארזים)</span></h3>
            <p>סה"כ המלצת הזמנה מחושבת</p>
          </div>
        </div>

      </div>

      {/* Advanced Filters */}
      <div className="card mb-4">
        <div style={{ fontWeight: 'bold', marginBottom: '0.75rem', fontSize: '0.95rem' }} className="flex align-center gap-2">
          <Filter size={16} />
          מסננים מתקדמים
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
          
          <div style={{ gridColumn: 'span 2' }}>
            <input 
              type="text" 
              placeholder="חיפוש לפי שם או ברקוד..." 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={searchTerm} 
              onChange={e => setSearchTerm(e.target.value)} 
            />
          </div>

          <div>
            <input 
              list="procurement-suppliers" 
              placeholder="ספק" 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={filterSupplier} 
              onChange={e => setFilterSupplier(e.target.value)} 
            />
            <datalist id="procurement-suppliers">
              {filterOptions.suppliers.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>

          <div>
            <input 
              list="procurement-warehouses" 
              placeholder="מחסן" 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={filterWarehouse} 
              onChange={e => setFilterWarehouse(e.target.value)} 
            />
            <datalist id="procurement-warehouses">
              {filterOptions.warehouses.map(w => <option key={w} value={w} />)}
            </datalist>
          </div>

          <div>
            <input 
              list="procurement-departments" 
              placeholder="מחלקה" 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={filterDepartment} 
              onChange={e => setFilterDepartment(e.target.value)} 
            />
            <datalist id="procurement-departments">
              {filterOptions.departments.map(d => <option key={d} value={d} />)}
            </datalist>
          </div>

          <div>
            <input 
              list="procurement-groups" 
              placeholder="קבוצה" 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={filterGroup} 
              onChange={e => setFilterGroup(e.target.value)} 
            />
            <datalist id="procurement-groups">
              {filterOptions.groups.map(g => <option key={g} value={g} />)}
            </datalist>
          </div>

          <div>
            <input 
              list="procurement-types" 
              placeholder="סוג סחורה" 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={filterType} 
              onChange={e => setFilterType(e.target.value)} 
            />
            <datalist id="procurement-types">
              {filterOptions.types.map(t => <option key={t} value={t} />)}
            </datalist>
          </div>

          <div>
            <input 
              list="procurement-brands" 
              placeholder="מותג" 
              className="form-control" 
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius)', backgroundColor: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
              value={filterBrand} 
              onChange={e => setFilterBrand(e.target.value)} 
            />
            <datalist id="procurement-brands">
              {filterOptions.brands.map(b => <option key={b} value={b} />)}
            </datalist>
          </div>

          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            <button 
              className="btn btn-outline" 
              style={{ width: '100%', padding: '0.5rem', color: 'var(--danger-color)', borderColor: 'var(--danger-color)' }}
              onClick={() => {
                setSearchTerm('');
                setFilterSupplier('');
                setFilterWarehouse('');
                setFilterDepartment('');
                setFilterGroup('');
                setFilterType('');
                setFilterBrand('');
              }}
            >
              איפוס סינונים
            </button>
          </div>

        </div>
      </div>

      {/* Main Table Title and Actions */}
      <div className="flex justify-between align-center mb-3" style={{ padding: '0 0.5rem' }}>
        <div style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>
          נמצאו {filteredShortages.length} פריטים חסרים שעונים לסינון
        </div>
        <button 
          className="btn btn-primary" 
          onClick={exportToExcel}
          disabled={filteredShortages.length === 0}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1.25rem', borderRadius: 'var(--border-radius)', fontWeight: 'bold' }}
        >
          <Download size={18} />
          ייצוא לאקסל (XLSX)
        </button>
      </div>

      {/* Data Table */}
      <div className="table-container card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: '1200px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--bg-color)' }}>
              <th style={{ width: '250px' }}>פרטי מוצר</th>
              <th style={{ width: '110px', textAlign: 'center' }}>סיווג חוסר</th>
              <th style={{ width: '180px' }}>ספק ומחסן</th>
              <th style={{ width: '180px' }}>מחלקה וקבוצה</th>
              
              {/* Dynamic Branch Columns */}
              {branches.map(bId => (
                <th key={bId} style={{ textAlign: 'center', width: '100px', backgroundColor: bId === targetBranch ? 'rgba(239, 68, 68, 0.08)' : 'transparent' }}>
                  ממוצע {BRANCH_NAMES[bId] || bId}
                </th>
              ))}
              
              <th style={{ width: '180px', color: 'var(--primary-color)', fontWeight: 'bold', textAlign: 'center' }}>המלצת רכש</th>
            </tr>
          </thead>
          <tbody>
            {displayItems.map((item) => (
              <tr key={item.barcode} style={{ borderBottom: '1px solid var(--border-color)' }}>
                
                {/* Product Name, Barcode & Brand */}
                <td>
                  <div style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>{item.desc}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem', fontFamily: 'monospace' }}>
                    {item.barcode} | מותג: {item.brand}
                  </div>
                </td>

                {/* Shortage Type Badge */}
                <td style={{ textAlign: 'center' }}>
                  {item.isLocalShortage ? (
                    <span className="badge badge-success" style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', fontWeight: 'bold' }}>מכר עצמי</span>
                  ) : (
                    <span className="badge badge-warning" style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', fontWeight: 'bold', color: '#7c3aed', backgroundColor: 'rgba(124, 58, 237, 0.12)' }}>מגוון רשת</span>
                  )}
                </td>

                {/* Supplier & Warehouse info */}
                <td style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                  <div>{item.supplierName} ({item.supplierId})</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    מחסן: {item.warehouse} | סוג: {item.merchandiseType}
                  </div>
                </td>

                {/* Department & Group */}
                <td style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                  <div>{item.department}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    קבוצה: {item.group}
                  </div>
                </td>

                {/* Average Sales per Branch Columns */}
                {branches.map(bId => {
                  const avgVal = averageSalesMap[item.barcode]?.[bId] || 0;
                  const isTarget = bId === targetBranch;
                  return (
                    <td 
                      key={bId} 
                      style={{ 
                        textAlign: 'center', 
                        backgroundColor: isTarget ? 'rgba(239, 68, 68, 0.03)' : 'transparent',
                        fontWeight: isTarget ? 'bold' : 'normal'
                      }}
                    >
                      <div style={{ color: avgVal > 0 ? 'var(--text-primary)' : 'rgba(156, 163, 175, 0.5)' }}>
                        {avgVal > 0 ? avgVal.toFixed(1) : '-'}
                      </div>
                      {isTarget && (
                        <div style={{ fontSize: '0.65rem', color: 'var(--danger-color)', fontWeight: 'bold', marginTop: '0.15rem' }}>
                          חוסר (0)
                        </div>
                      )}
                    </td>
                  );
                })}

                {/* Order Recommendation Column */}
                <td style={{ backgroundColor: 'rgba(79, 70, 229, 0.02)', textAlign: 'center' }}>
                  {item.recommendedUnits > 0 ? (
                    <>
                      <div style={{ fontWeight: 'bold', color: 'var(--primary-color)', fontSize: '1.05rem' }}>
                        {item.recommendedUnits} יחידות
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                        ({item.recommendedPacks} מארזים x {item.packFactor})
                      </div>
                    </>
                  ) : (
                    <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontSize: '0.85rem' }}>
                      לא חושבה המלצה
                    </div>
                  )}
                </td>

              </tr>
            ))}
            {filteredShortages.length === 0 && (
              <tr>
                <td colSpan={5 + branches.length} style={{ textAlign: 'center', padding: '5rem', color: 'var(--text-secondary)', fontWeight: 'bold' }}>
                  לא נמצאו חוסרים העונים לתנאי הסינון שנבחרו.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-4 align-center mt-4">
          <button className="btn btn-outline" onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage === 1}>
            קודם
          </button>
          <div className="flex gap-2 align-center">
            <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', fontWeight: 'bold' }}>
              דף {currentPage} מתוך {totalPages}
            </span>
          </div>
          <button className="btn btn-outline" onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage === totalPages}>
            הבא
          </button>
        </div>
      )}

    </div>
  );
};

export default Procurement;

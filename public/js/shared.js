/* Code shared by the browser and the Node server (totals, constants). */
(function (root) {
  'use strict';

  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const r3 = n => Math.round((+n || 0) * 1000) / 1000;
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

  const CATEGORIES = ['Yarn', 'Dyes & Chemicals', 'Packing Material', 'Others', 'Grey Fabric', 'Colored Fabric', 'Finished Goods'];
  const RAW_CATEGORIES = ['Yarn', 'Dyes & Chemicals', 'Packing Material', 'Others'];
  // Material that carries one lot number from the GRN to the sale. Chemicals and packing are used up
  // in production, so they have no lot.
  const LOT_CATEGORIES = ['Yarn', 'Grey Fabric', 'Colored Fabric', 'Finished Goods'];
  const lotFmt = n => 'L-' + String(n).padStart(4, '0');
  // Knitted fabric keeps the lot of its main yarn: the yarn line with the most kg (Lycra etc. are minor).
  const mainLot = lines => {
    let best = null;
    for (const l of lines || []) if (l && l.item && String(l.lot || '').trim() && (!best || num(l.qty) > num(best.qty))) best = l;
    return best ? String(best.lot).trim() : '';
  };
  const PARTY_TYPES = ['Supplier', 'Customer', 'Job Worker', 'Both'];
  const OVERHEAD_CATEGORIES = ['Factory Overheads', 'Utilities (Power/Water)', 'Machine Running Cost', 'Maintenance', 'Other'];
  const PAY_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque'];
  const STAGES = ['Knitting', 'Dyeing', 'Finishing'];
  // Names used for the stages on the labour screens.
  const STAGE_LABELS = { Knitting: 'Knitting', Dyeing: 'Color (Dyeing)', Finishing: 'Finishing & Packing' };

  // Collections whose documents carry GST on their lines.
  const TAX_COLS = { purchaseOrders: 1, purchaseBills: 1, salesOrders: 1, invoices: 1 };
  // Collections whose lines are priced (qty x rate).
  const PRICED_COLS = Object.assign({ grn: 1, deliveries: 1 }, TAX_COLS);

  // GST state codes (first two digits of a GSTIN).
  const STATES = [
    ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
    ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
    ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
    ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
    ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
    ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
    ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'],
  ];
  const STATE_NAMES = STATES.map(s => s[1]);
  const norm = s => String(s || '').trim().toLowerCase();
  const stateCode = name => { const s = STATES.find(x => norm(x[1]) === norm(name)); return s ? s[0] : ''; };
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  // Returns an error message, or '' when the GSTIN is fine (or blank).
  function checkGstin(gstin, state) {
    const g = String(gstin || '').trim().toUpperCase();
    if (!g) return '';
    if (!GSTIN_RE.test(g)) return 'GSTIN "' + g + '" is not in the valid 15-character format (e.g. 19ABCDE1234F1Z5)';
    const code = stateCode(state);
    if (code && g.slice(0, 2) !== code) return 'GSTIN starts with ' + g.slice(0, 2) + ' but ' + state + ' is state code ' + code;
    return '';
  }

  // Place of supply decides the tax: same state as the company = CGST + SGST, otherwise IGST.
  // An invoice's own "Place of supply" wins over the party's state.
  function isInterState(settings, party, doc) {
    const a = norm(settings && settings.state);
    const b = norm((doc && doc.placeOfSupply) || (party && party.state));
    return !!(a && b && a !== b);
  }

  // Computes line amounts, GST and grand total in place.
  // Freight / other charges on the invoice are part of the taxable value (GST s.15) and a discount
  // shown on the invoice reduces it; both are spread over the lines by value, so each part is
  // taxed at its own line's rate.
  function applyTotals(col, doc, settings, party) {
    if (!PRICED_COLS[col]) return doc;
    const withTax = !!TAX_COLS[col];
    const lines = doc.lines || [];
    let goods = 0;
    lines.forEach(l => { l.amount = r2(num(l.qty) * num(l.rate)); goods += l.amount; });
    const charges = withTax ? num(doc.freight) + num(doc.otherCharges) : 0;
    const disc = withTax ? num(doc.discount) : 0;
    let taxable = 0, tax = 0;
    lines.forEach(l => {
      const share = goods ? l.amount / goods : 0;
      l.taxable = r2(l.amount + (charges - disc) * share);
      l.taxAmt = withTax ? r2(l.taxable * num(l.gst) / 100) : 0;
      taxable += l.taxable;
      tax += l.taxAmt;
    });
    doc.goodsValue = r2(goods);
    doc.taxable = r2(taxable);
    doc.tax = r2(tax);
    if (isInterState(settings, party, doc)) { doc.igst = doc.tax; doc.cgst = 0; doc.sgst = 0; }
    else { doc.igst = 0; doc.cgst = r2(doc.tax / 2); doc.sgst = r2(doc.tax - doc.cgst); }
    const gross = doc.taxable + doc.tax;
    doc.roundOff = withTax ? r2(Math.round(gross) - gross) : 0;
    doc.total = r2(gross + doc.roundOff);
    return doc;
  }

  /* ---------------- finished-goods rolls ---------------- */
  // "20.2 + 50.3 + 39.5" (or with commas / spaces / "kg") -> [20.2, 50.3, 39.5].
  // Empty text gives []; anything that is not a positive number gives null.
  function parseRolls(text) {
    const parts = String(text || '').replace(/kgs?/gi, ' ').split(/[+,;\s]+/).filter(Boolean);
    const out = [];
    for (const p of parts) { const n = Number(p); if (!isFinite(n) || n <= 0) return null; out.push(r3(n)); }
    return out;
  }
  const fmtRolls = list => (list || []).map(x => String(r3(typeof x === 'object' ? x.kg : x))).join(' + ');
  // Takes `qty` kg from the rolls in roll order: whole rolls first, the last one is cut.
  // bag: [{ no, kg }]. Returns { picks: [{ no, kg }], short } (short = kg the rolls could not cover).
  function allocRolls(bag, qty) {
    const picks = [];
    let need = r3(qty);
    for (const r of (bag || []).slice().sort((a, b) => a.no - b.no)) {
      if (need <= 0.0005) break;
      if (!(r.kg > 0.0005)) continue;
      const take = r3(Math.min(r.kg, need));
      picks.push({ no: r.no, kg: take });
      need = r3(need - take);
    }
    return { picks, short: need > 0.0005 ? need : 0 };
  }

  /* ---------------- guidance when stock is missing ---------------- */
  // A location has none (or too little) of an item: say where it is instead and which step brings it.
  // cat: item category; haveAt: { locId: qty } of the same item (or category) now; names: { locId: name }.
  // Returns { text, screen } where screen is the entry screen that fixes it.
  function supplyHint(cat, loc, haveAt, names, unit) {
    const nm = id => (names && names[id]) || id;
    const amt = q => r3(q) + (unit ? ' ' + unit : '');
    const at = id => (haveAt && haveAt[id]) || 0;
    const other = Object.entries(haveAt || {}).filter(([l, q]) => l !== loc && q > 0.0005);
    if (cat === 'Yarn' && loc === 'KNIT') {
      return at('STORE') > 0.0005
        ? { text: nm('STORE') + ' has ' + amt(at('STORE')) + ': issue it to the ' + nm('KNIT') + ' first (Yarn Issue to Knitting).', screen: 'yarnIssue' }
        : { text: 'There is none in the ' + nm('STORE') + ' either: receive it with a GRN first, then issue it to the ' + nm('KNIT') + '.', screen: 'grn' };
    }
    if (cat === 'Grey Fabric' && loc === 'DYE') {
      return at('KNIT') > 0.0005
        ? { text: amt(at('KNIT')) + ' is still at the ' + nm('KNIT') + ': send it with Transfer to Color Factory.', screen: 'greyTransfer' }
        : { text: 'Knit a lot first: each knitting entry sends its grey fabric straight to the ' + nm('DYE') + '.', screen: 'knitting' };
    }
    if (cat === 'Colored Fabric' && loc === 'DYE') return { text: 'Dye a lot first (Dyeing / Coloring).', screen: 'dyeing' };
    if (cat === 'Finished Goods' && loc === 'FG') {
      return other.length
        ? { text: amt(other[0][1]) + ' is at ' + nm(other[0][0]) + ': move it to the ' + nm('FG') + ' with a stock transfer.', screen: 'transfers' }
        : { text: 'Finish and pack a lot first, or receive bought-in goods at the ' + nm('FG') + ' with a GRN.', screen: 'finishing' };
    }
    if (RAW_CATEGORIES.includes(cat) && loc === 'STORE') {
      return { text: (other.length ? 'It is at ' + other.map(([l, q]) => nm(l) + ' (' + amt(q) + ')').join(', ') + ', not in the store. ' : '') + 'To get more, raise a purchase order and receive it with a GRN.', screen: 'purchaseOrders' };
    }
    return other.length
      ? { text: 'It is at ' + other.map(([l, q]) => nm(l) + ' (' + amt(q) + ')').join(', ') + ': move it with a stock transfer.', screen: 'transfers' }
      : { text: 'Receive it with a GRN, or enter it as opening stock.', screen: 'grn' };
  }

  function partyIs(p, kind) {
    if (!p) return false;
    if (p.type === 'Both') return true;
    if (kind === 'Supplier') return p.type === 'Supplier' || p.type === 'Job Worker';
    return p.type === kind;
  }

  /* ---------------- department permissions ---------------- */
  // Levels: none < view < edit (add + change) < full (also delete).
  const LEVELS = ['none', 'view', 'edit', 'full'];
  const PERM_AREAS = [
    { k: 'dashboard', label: 'MIS dashboard (sales, dues, stock value)', group: 'General', viewOnly: true },
    { k: 'masters', label: 'Masters: items, parties, machines, processes, recipes', group: 'General' },
    { k: 'purchaseOrders', label: 'Purchase orders', group: 'Purchase' },
    { k: 'grn', label: 'Goods receipt (GRN)', group: 'Purchase' },
    { k: 'purchaseBills', label: 'Purchase bills', group: 'Purchase' },
    { k: 'storeTransfers', label: 'Yarn issue & store transfers', group: 'Store / Inventory' },
    { k: 'stockAdjust', label: 'Opening stock & adjustments', group: 'Store / Inventory' },
    { k: 'knitting', label: 'Knitting production', group: 'Production' },
    { k: 'greyTransfer', label: 'Grey transfer to color factory', group: 'Production' },
    { k: 'dyeing', label: 'Dyeing / coloring', group: 'Production' },
    { k: 'finishing', label: 'Finishing & packing', group: 'Production' },
    { k: 'overheads', label: 'Overhead entries', group: 'Costing' },
    { k: 'priceList', label: 'Party price list', group: 'Sales' },
    { k: 'salesOrders', label: 'Sales orders', group: 'Sales' },
    { k: 'deliveries', label: 'Delivery challans', group: 'Sales' },
    { k: 'invoices', label: 'Sales invoices', group: 'Sales' },
    { k: 'receipts', label: 'Customer receipts', group: 'Finance & Accounts' },
    { k: 'payments', label: 'Supplier payments', group: 'Finance & Accounts' },
    { k: 'labourPayments', label: 'Labour payments (knitting, color, finishing)', group: 'Finance & Accounts' },
    { k: 'rep_inventory', label: 'Stock reports', group: 'Reports', viewOnly: true },
    { k: 'rep_purchase', label: 'Purchase reports', group: 'Reports', viewOnly: true },
    { k: 'rep_production', label: 'Production, lot & wastage reports', group: 'Reports', viewOnly: true },
    { k: 'rep_costing', label: 'Costing & profitability reports', group: 'Reports', viewOnly: true },
    { k: 'rep_sales', label: 'Sales reports', group: 'Reports', viewOnly: true },
    { k: 'rep_accounts', label: 'Outstanding, ledger, labour payable & GST reports', group: 'Reports', viewOnly: true },
  ];
  const MASTER_COLS = ['units', 'items', 'parties', 'locations', 'machines', 'processes', 'boms'];
  const ADMIN_COLS = ['users', 'roles'];
  // Which permission area a record belongs to (transfers depend on their purpose).
  function areaOf(col, doc) {
    if (MASTER_COLS.includes(col)) return 'masters';
    if (ADMIN_COLS.includes(col)) return 'admin';
    if (col === 'transfers') return doc && doc.purpose === 'Grey Transfer' ? 'greyTransfer' : 'storeTransfers';
    return col;
  }
  const REPORT_AREA = {
    dashboard: 'dashboard',
    stock: 'rep_inventory', stockLedger: 'rep_inventory', negativeStock: 'rep_inventory',
    purchase: 'rep_purchase', poPending: 'rep_purchase',
    production: 'rep_production', lots: 'rep_production', wastage: 'rep_production',
    costing: 'rep_costing', itemCosting: 'rep_costing', overheads: 'rep_costing', profitability: 'rep_costing',
    sales: 'rep_sales', soPending: 'rep_sales',
    outstanding: 'rep_accounts', partyLedger: 'rep_accounts', gst: 'rep_accounts', labourPayable: 'rep_accounts',
    labourBalance: 'labourPayments', // "still payable" figure shown on the labour payment form
    // stockChoices, nextLot, partyBalance are helpers used inside forms: open to every signed-in user
  };
  const levelAtLeast = (have, need) => LEVELS.indexOf(have || 'none') >= LEVELS.indexOf(need);

  const Shared = { r2, r3, num, CATEGORIES, RAW_CATEGORIES, LOT_CATEGORIES, lotFmt, mainLot, PARTY_TYPES, OVERHEAD_CATEGORIES, PAY_MODES, STAGES, STAGE_LABELS, TAX_COLS, PRICED_COLS, applyTotals, isInterState, parseRolls, fmtRolls, allocRolls, supplyHint, STATES, STATE_NAMES, stateCode, checkGstin, partyIs, LEVELS, PERM_AREAS, MASTER_COLS, ADMIN_COLS, areaOf, REPORT_AREA, levelAtLeast };
  if (typeof module !== 'undefined' && module.exports) module.exports = Shared;
  else root.Shared = Shared;
})(this);

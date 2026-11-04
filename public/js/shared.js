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
  // Lot numbers follow a pattern set in Settings: # marks the running number (as many digits as #s),
  // {YYYY} the year of the entry. "L-####" gives L-0001; "MH-{YYYY}-###" gives MH-2026-001, starting
  // again at 001 each year.
  const LOT_PATTERN = 'L-####';
  const lotPattern = p => /#/.test(String(p || '')) ? String(p).trim().toUpperCase() : LOT_PATTERN;
  const yearOf = date => String(date || '').slice(0, 4) || String(new Date().getFullYear());
  const lotPrefix = (pattern, date) => lotPattern(pattern).replace(/\{YYYY\}/g, yearOf(date)).split('#')[0];
  const lotFmt = (n, pattern, date) => {
    const p = lotPattern(pattern), digits = (p.match(/#+/) || ['####'])[0].length;
    return p.replace(/\{YYYY\}/g, yearOf(date)).replace(/#+/, String(n).padStart(digits, '0'));
  };
  // Knitted fabric keeps the lot of its main yarn: the yarn line with the most kg (Lycra etc. are minor).
  const mainLot = lines => {
    let best = null;
    for (const l of lines || []) if (l && l.item && String(l.lot || '').trim() && (!best || num(l.qty) > num(best.qty))) best = l;
    return best ? String(best.lot).trim() : '';
  };
  const PARTY_TYPES = ['Supplier', 'Customer', 'Job Worker', 'Both'];
  // Expense heads. Those in COST_CATEGORIES are added to production cost (spread over the kg finished
  // in the month) unless the entry says otherwise; the last three are from the first release.
  const EXPENSE_CATEGORIES = ['Electricity', 'Rent', 'Repairs & Maintenance', 'Machine Running Cost', 'Factory Overheads', 'Transport', 'Staff Salary', 'Job Work Charges',
    'Office Expenses', 'Telephone / Internet', 'Miscellaneous'];
  const COST_CATEGORIES = ['Electricity', 'Rent', 'Repairs & Maintenance', 'Machine Running Cost', 'Factory Overheads', 'Utilities (Power/Water)', 'Maintenance', 'Other'];
  const OVERHEAD_CATEGORIES = EXPENSE_CATEGORIES.concat(['Utilities (Power/Water)', 'Maintenance', 'Other']);
  const PAY_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Online Payment'];
  // What is noted down for each way of paying: a cheque's no., date and bank; the UPI phone or ID; the UTR ...
  const PAY_DETAILS = {
    Cash: ['person', 'refNo'],
    'Bank Transfer': ['transferType', 'refNo', 'payBank', 'accountNo'],
    UPI: ['upi', 'refNo'],
    Cheque: ['refNo', 'chequeDate', 'payBank'],
    'Online Payment': ['payVia', 'refNo'],
  };
  const PAY_DETAIL_KEYS = ['person', 'transferType', 'refNo', 'chequeDate', 'payBank', 'accountNo', 'upi', 'payVia'];
  const TRANSFER_TYPES = ['NEFT', 'RTGS', 'IMPS'];
  // The details in one line for lists, ledgers and the bank book, e.g. "004512 dt 05-11-2026, Axis Bank, Burrabazar" for a cheque.
  // A bare number gets its name in front (UTR, Txn). A receipt in parts lists each part.
  function payDetail(p) {
    if (!p) return '';
    const parts = Array.isArray(p.parts) ? p.parts : [];
    if (parts.length > 1) return parts.map(x => [x.mode, payDetail(x)].filter(Boolean).join(' ')).join(' + ');
    if (parts.length === 1) p = Object.assign({}, p, parts[0]);
    const v = k => String(p[k] === undefined || p[k] === null ? '' : p[k]).trim();
    const tag = (name, x) => /^\d/.test(x) ? name + ' ' + x : x;
    const bits = {
      Cash: [v('person'), tag('No', v('refNo'))],
      Cheque: [[v('refNo'), v('chequeDate') && 'dt ' + v('chequeDate').split('-').reverse().join('-')].filter(Boolean).join(' '), v('payBank')],
      'Bank Transfer': [[v('transferType'), tag('UTR', v('refNo'))].filter(Boolean).join(' '), v('payBank'), v('accountNo') && 'A/c ' + v('accountNo')],
      UPI: [v('upi'), tag('Txn', v('refNo'))],
      'Online Payment': [v('payVia'), tag('Txn', v('refNo'))],
    }[p.mode] || [v('refNo')];
    return bits.filter(Boolean).join(', ');
  }
  const DEPARTMENTS = ['Purchase', 'Yarn Department', 'Knitting', 'Processing', 'Godown', 'Sales', 'Accounts', 'Administration'];
  // Attendance marks: [code, name, share of the day paid].
  const ATTENDANCE = [['P', 'Present', 1], ['H', 'Half day', 0.5], ['A', 'Absent', 0], ['L', 'Paid leave', 1], ['O', 'Holiday / weekly off', 1]];
  // Steps a lot goes through at a dyeing / finishing agency (Processing Status). Sent and received are automatic.
  const JOB_STATUSES = ['Material sent', 'Processing started', 'Colouring', 'Finishing', 'Finished & ready'];
  // Finished goods are kept in the Finished Goods Store and in any location of type Godown.
  const isGodown = l => !!l && (l.id === 'FG' || l.type === 'Godown');
  const STAGES = ['Knitting', 'Dyeing', 'Finishing'];
  // Names used for the stages on the labour screens.
  const STAGE_LABELS = { Knitting: 'Knitting', Dyeing: 'Color (Dyeing)', Finishing: 'Finishing & Packing' };

  /* ---------------- job-work agencies ---------------- */
  // An agency is a party that does knitting, dyeing or finishing for us. Its party record ticks the
  // work it does and its rate per kg; the ERP gives it a location of its own that holds the
  // material sent to it.
  const AGENCY_WORK = { Knitting: ['doesKnitting', 'knitRate'], Dyeing: ['doesDyeing', 'dyeRate'], Finishing: ['doesFinishing', 'finRate'] };
  const workOf = p => STAGES.filter(s => p && p[AGENCY_WORK[s][0]]);
  const isAgency = p => !!p && (p.type === 'Job Worker' || workOf(p).length > 0);
  // Can this stage be done at this location? Agencies: the work their party ticks (none ticked = any).
  // Own factories: the built-in Knitting Factory knits, the Color Factory dyes and finishes, others do anything.
  function doesWork(loc, stage, partyOf) {
    if (!loc || loc.inactive) return false;
    if (loc.party) { const w = workOf(partyOf(loc.party)); return !w.length || w.includes(stage); }
    if (loc.id === 'KNIT') return stage === 'Knitting';
    if (loc.id === 'DYE') return stage !== 'Knitting';
    return loc.type === 'Factory' || loc.type === 'Job Worker';
  }

  // Collections whose documents carry GST on their lines.
  const TAX_COLS = { purchaseOrders: 1, purchaseBills: 1, quotations: 1, salesOrders: 1, invoices: 1 };
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
    const where = () => other.map(([l, q]) => nm(l) + ' (' + amt(q) + ')').join(', ');
    // Yarn, grey and dyed fabric are worked at a knitting / dyeing / finishing agency (or own factory).
    if (cat === 'Yarn' && loc !== 'STORE') {
      if (at('STORE') > 0.0005) return { text: nm('STORE') + ' has ' + amt(at('STORE')) + ': issue it to ' + nm(loc) + ' first (Yarn Issue to Knitting).', screen: 'yarnIssue' };
      return other.length
        ? { text: 'It is at ' + where() + ': move it with a stock transfer.', screen: 'transfers' }
        : { text: 'There is none in the ' + nm('STORE') + ' either: receive it with a GRN first, then issue it to ' + nm(loc) + '.', screen: 'grn' };
    }
    if (cat === 'Grey Fabric' && loc !== 'STORE' && loc !== 'FG') {
      return other.length
        ? { text: 'It is at ' + where() + ': send it to ' + nm(loc) + ' with Send Grey for Dyeing.', screen: 'greyTransfer' }
        : { text: 'Knit a lot first, and send its grey fabric to ' + nm(loc) + ' on the knitting entry.', screen: 'knitting' };
    }
    if (cat === 'Colored Fabric' && loc !== 'STORE' && loc !== 'FG') {
      return other.length
        ? { text: 'It is at ' + where() + ': move it to ' + nm(loc) + ' with a stock transfer.', screen: 'transfers' }
        : { text: 'Dye a lot first (Dyeing / Coloring).', screen: 'dyeing' };
    }
    if (cat === 'Finished Goods') {
      return other.length
        ? { text: 'It is at ' + where() + ': move it to ' + nm(loc) + ' with a Godown Transfer.', screen: 'godownTransfer' }
        : { text: 'Finish and pack a lot first, or receive bought-in goods at ' + nm(loc) + ' with a GRN.', screen: 'finishing' };
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
    { k: 'approvals', label: 'Approve changes & deletions made by other staff', group: 'General', viewOnly: true },
    { k: 'leads', label: 'Sales leads & follow-ups', group: 'CRM' },
    { k: 'purchaseOrders', label: 'Purchase orders', group: 'Purchase' },
    { k: 'grn', label: 'Goods receipt (GRN)', group: 'Purchase' },
    { k: 'purchaseBills', label: 'Purchase bills', group: 'Purchase' },
    { k: 'storeTransfers', label: 'Yarn issue & store transfers', group: 'Store / Inventory' },
    { k: 'stockAdjust', label: 'Opening stock & adjustments', group: 'Store / Inventory' },
    { k: 'knitting', label: 'Knitting production', group: 'Production' },
    { k: 'greyTransfer', label: 'Send grey fabric for dyeing', group: 'Production' },
    { k: 'dyeing', label: 'Dyeing / coloring', group: 'Production' },
    { k: 'finishing', label: 'Finishing & packing', group: 'Production' },
    { k: 'jobStatus', label: 'Processing status updates', group: 'Production' },
    { k: 'priceList', label: 'Party price list', group: 'Sales' },
    { k: 'quotations', label: 'Quotations', group: 'Sales' },
    { k: 'salesOrders', label: 'Sales orders', group: 'Sales' },
    { k: 'deliveries', label: 'Delivery challans', group: 'Sales' },
    { k: 'invoices', label: 'Sales invoices', group: 'Sales' },
    { k: 'receipts', label: 'Customer receipts', group: 'Finance & Accounts' },
    { k: 'payments', label: 'Supplier payments', group: 'Finance & Accounts' },
    { k: 'labourPayments', label: 'Labour payments (knitting, color, finishing)', group: 'Finance & Accounts' },
    { k: 'overheads', label: 'Expenses (and production overheads)', group: 'Finance & Accounts' },
    { k: 'banking', label: 'Bank & cash: accounts, deposits, withdrawals, transfers, bank book', group: 'Finance & Accounts' },
    { k: 'loans', label: 'Loans & EMI payments', group: 'Finance & Accounts' },
    { k: 'powerBills', label: 'Electricity bills', group: 'Finance & Accounts' },
    { k: 'staff', label: 'Staff list & attendance (without salaries)', group: 'Staff & Salary' },
    { k: 'salary', label: 'Salaries & advances (sees salaries)', group: 'Staff & Salary' },
    { k: 'rep_inventory', label: 'Stock reports', group: 'Reports', viewOnly: true },
    { k: 'rep_purchase', label: 'Purchase reports', group: 'Reports', viewOnly: true },
    { k: 'rep_production', label: 'Production, lot & wastage reports', group: 'Reports', viewOnly: true },
    { k: 'rep_costing', label: 'Costing & profitability reports', group: 'Reports', viewOnly: true },
    { k: 'rep_sales', label: 'Sales reports', group: 'Reports', viewOnly: true },
    { k: 'rep_accounts', label: 'Outstanding, ledger, labour payable & GST summary', group: 'Reports', viewOnly: true },
    { k: 'rep_gst', label: 'GST registers, GSTR-1 & GSTR-3B data', group: 'Reports', viewOnly: true },
  ];
  const MASTER_COLS = ['units', 'items', 'parties', 'locations', 'machines', 'processes', 'boms'];
  const ADMIN_COLS = ['users', 'roles'];
  // Collections whose permission area is not their own name.
  const COL_AREA = { banks: 'banking', bankEntries: 'banking', emiPayments: 'loans', employees: 'staff', attendance: 'staff' };
  // Which permission area a record belongs to (transfers depend on their purpose).
  function areaOf(col, doc) {
    if (MASTER_COLS.includes(col)) return 'masters';
    if (ADMIN_COLS.includes(col)) return 'admin';
    if (col === 'transfers') return doc && doc.purpose === 'Grey Transfer' ? 'greyTransfer' : 'storeTransfers';
    return COL_AREA[col] || col;
  }
  const REPORT_AREA = {
    dashboard: 'dashboard',
    stock: 'rep_inventory', stockLedger: 'rep_inventory', negativeStock: 'rep_inventory',
    purchase: 'rep_purchase', poPending: 'rep_purchase',
    production: 'rep_production', lots: 'rep_production', wastage: 'rep_production', agencies: 'rep_production',
    costing: 'rep_costing', itemCosting: 'rep_costing', overheads: 'rep_costing', profitability: 'rep_costing',
    sales: 'rep_sales', soPending: 'rep_sales',
    outstanding: 'rep_accounts', partyLedger: 'rep_accounts', gst: 'rep_accounts', labourPayable: 'rep_accounts',
    labourBalance: 'labourPayments', // "still payable" figure shown on the labour payment form
    stockMovement: 'rep_inventory', godownStock: 'rep_inventory',
    jobWork: 'rep_production', processStatus: 'rep_production',
    customer: 'rep_sales', followUps: 'leads',
    bankBook: 'banking', bankReco: 'banking', cheques: 'banking', expenses: 'overheads', loans: 'loans', powerBills: 'powerBills',
    salaryRegister: 'salary', salaryDue: 'salary', attendanceReport: 'staff',
    salesRegister: 'rep_gst', purchaseRegister: 'rep_gst', gstr1: 'rep_gst', gstr3b: 'rep_gst', partyGst: 'rep_gst',
    activity: 'admin',
    // billStatus (paid / due on each bill) is shown on the invoice and purchase bill lists: open to their users
    // stockChoices, nextLot, partyBalance are helpers used inside forms: open to every signed-in user
  };
  const levelAtLeast = (have, need) => LEVELS.indexOf(have || 'none') >= LEVELS.indexOf(need);

  const Shared = { r2, r3, num, CATEGORIES, RAW_CATEGORIES, LOT_CATEGORIES, LOT_PATTERN, lotPattern, lotPrefix, lotFmt, mainLot, PARTY_TYPES, EXPENSE_CATEGORIES, COST_CATEGORIES, OVERHEAD_CATEGORIES, PAY_MODES, PAY_DETAILS, PAY_DETAIL_KEYS, TRANSFER_TYPES, payDetail, DEPARTMENTS, ATTENDANCE, JOB_STATUSES, isGodown, STAGES, STAGE_LABELS, AGENCY_WORK, workOf, isAgency, doesWork, TAX_COLS, PRICED_COLS, applyTotals, isInterState, parseRolls, fmtRolls, allocRolls, supplyHint, STATES, STATE_NAMES, stateCode, checkGstin, partyIs, LEVELS, PERM_AREAS, MASTER_COLS, ADMIN_COLS, COL_AREA, areaOf, REPORT_AREA, levelAtLeast };
  if (typeof module !== 'undefined' && module.exports) module.exports = Shared;
  else root.Shared = Shared;
})(this);

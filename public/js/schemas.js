/*
 * Screen definitions. Every master / transaction screen is described here and
 * rendered by the generic list + form engine in forms.js.
 *
 * Block types in `layout`:  { title, fields: [...] } | { grid: {...} } | { totals: true }
 * Field types: text, textarea, number, date, select, ref, check, password, lot, calc, ro
 */
'use strict';

const S = Shared;
const byId = (col, id) => Cache.byId(col, id);
const itemOf = id => byId('items', id);
const unitOf = id => { const i = itemOf(id); const u = i && byId('units', i.unit); return u ? u.code : ''; };
const sumQty = rows => (rows || []).reduce((s, r) => s + S.num(r.qty), 0);
const partyName = id => { const p = byId('parties', id); return p ? p.name : ''; };

const REF_LABEL = {
  items: r => (r.code ? r.code + ' · ' : '') + r.name,
  parties: r => r.name + (r.city ? ' (' + r.city + ')' : ''),
  units: r => r.code + ' - ' + r.name,
  locations: r => r.name,
  machines: r => r.code + ' · ' + r.name,
  processes: r => r.name,
  boms: r => r.name,
  users: r => r.username,
};
const refLabel = (col, r) => r ? (REF_LABEL[col] ? REF_LABEL[col](r) : (r.no || '') + ' · ' + U.fmtDate(r.date) + (r.party ? ' · ' + partyName(r.party) : '')) : '';

// Latest party-specific price for an item, falling back to the item's standard rate.
function priceFor(party, item) {
  const p = Cache.list('priceList').filter(x => x.party === party && x.item === item).sort((a, b) => (b.wef || '').localeCompare(a.wef || ''))[0];
  if (p) return S.num(p.rate);
  const i = itemOf(item);
  return i ? S.num(i.rate) : 0;
}

/* ---------- reusable fields ---------- */
const F = {
  no: { k: 'no', label: 'Number', type: 'ro', placeholder: 'Auto', list: true },
  date: { k: 'date', label: 'Date', type: 'date', req: true, def: () => U.today() },
  party: (kind, extra) => Object.assign({
    k: 'party', label: kind === 'Customer' ? 'Customer' : kind === 'Supplier' ? 'Supplier' : 'Party',
    type: 'ref', ref: 'parties', req: true, w: 2, filter: p => !kind || S.partyIs(p, kind),
  }, extra || {}),
  remarks: { k: 'remarks', label: 'Remarks', type: 'textarea', w: 4 },
  mode: { k: 'mode', label: 'Mode', type: 'select', options: S.PAY_MODES, def: 'Bank Transfer' },
};

const C = {
  item: (cats, extra) => Object.assign({ k: 'item', label: 'Item', type: 'ref', ref: 'items', req: true, wide: true, filter: i => !cats || cats.includes(i.category) }, extra || {}),
  unit: { k: '_unit', label: 'Unit', type: 'calc', value: r => unitOf(r.item), narrow: true },
  qty: (label) => ({ k: 'qty', label: label || 'Qty', type: 'number', req: true, fmt: 'qty' }),
  rate: { k: 'rate', label: 'Rate', type: 'number', fmt: 'money' },
  gst: { k: 'gst', label: 'GST %', type: 'number', narrow: true },
  rolls: { k: 'rolls', label: 'Rolls', type: 'number', narrow: true, fmt: 'int' },
  amount: { k: '_amount', label: 'Amount', type: 'calc', fmt: 'money', value: r => S.num(r.qty) * S.num(r.rate) },
  lotText: { k: 'lot', label: 'Lot / Batch', type: 'text', placeholder: 'optional' },
  lotFrom: (locFn, label) => ({ k: 'lot', label: label || 'Lot / Batch', type: 'lot', loc: locFn, itemKey: 'item' }),
};

// When an item is picked on a priced line, pull GST and a sensible rate.
const fillPurchaseLine = (row) => { const i = itemOf(row.item); if (i) { row.gst = S.num(i.gst); if (!S.num(row.rate)) row.rate = S.num(i.rate); } };
const fillSaleLine = (row, doc) => { const i = itemOf(row.item); if (i) { row.gst = S.num(i.gst); row.rate = priceFor(doc.party, row.item); } };

/* ---------- pending quantity helpers for "copy lines from" ---------- */
function pendingFrom(srcDoc, childCol, linkKey, selfId) {
  const done = {};
  for (const c of Cache.list(childCol)) {
    if (c[linkKey] !== srcDoc.id || c.id === selfId) continue;
    for (const l of c.lines || []) done[l.item] = (done[l.item] || 0) + S.num(l.qty);
  }
  return (srcDoc.lines || []).map(l => {
    const left = S.num(l.qty) - (done[l.item] || 0);
    done[l.item] = Math.max(0, (done[l.item] || 0) - S.num(l.qty));
    return Object.assign({}, l, { qty: S.r3(Math.max(0, left)) });
  }).filter(l => l.qty > 0);
}

/* ---------- production helpers ---------- */
// Keeps wastage (input - output) and labour (rate x qty) filled in until the user overrides them.
function productionRecalc(stage) {
  return doc => {
    const inQ = stage === 'Knitting' ? sumQty(doc.lines) : S.num(doc.inQty);
    const outQ = S.num(doc.outQty);
    if (!doc._wastageQtyTouched && outQ > 0) doc.wastageQty = S.r3(Math.max(0, inQ - outQ));
    if (!doc._labourTouched) doc.labour = S.r2(S.num(doc.labourRate) * (stage === 'Dyeing' ? inQ : outQ));
    if (doc.bom && doc._bomAuto) {
      const b = byId('boms', doc.bom);
      if (b) for (const l of doc.lines || []) { const bl = (b.lines || []).find(x => x.item === l.item); if (bl) l.qty = S.r3(S.num(bl.qtyPerKg) * inQ); }
    }
  };
}
const processField = stage => ({
  k: 'process', label: 'Process', type: 'ref', ref: 'processes', filter: p => p.stage === stage,
  onChange: doc => { const p = byId('processes', doc.process); if (p) { doc.labourRate = S.num(p.labourRate); doc._labourTouched = false; } },
});
const bomField = stage => ({
  k: 'bom', label: stage === 'Dyeing' ? 'Dye recipe (BOM)' : 'Packing standard (BOM)', type: 'ref', ref: 'boms', filter: b => b.stage === stage,
  help: 'Fills the materials below, scaled to the input kg',
  onChange: doc => {
    const b = byId('boms', doc.bom);
    if (!b) return;
    const inQ = S.num(doc.inQty);
    doc.lines = (b.lines || []).map(l => ({ item: l.item, lot: '', qty: S.r3(S.num(l.qtyPerKg) * inQ) }));
    doc._bomAuto = true;
    if (b.outItem && !doc.outItem) doc.outItem = b.outItem;
  },
});
const outputFields = (stage, outCats, extra) => [
  { k: 'outItem', label: stage === 'Knitting' ? 'Grey fabric produced' : stage === 'Dyeing' ? 'Colored fabric produced' : 'Finished goods produced', type: 'ref', ref: 'items', req: true, w: 2, filter: i => outCats.includes(i.category) },
  stage === 'Knitting' ? null : { k: 'outLot', label: 'Output lot', type: 'text', help: 'Normally same as input lot' },
  { k: 'outQty', label: 'Output qty (kg)', type: 'number', req: true, fmt: 'qty' },
  { k: 'rolls', label: 'Rolls', type: 'number', fmt: 'int' },
].concat(extra || [], [
  { k: '_diff', label: 'Input - output (kg)', type: 'calc', fmt: 'qty', value: d => (stage === 'Knitting' ? sumQty(d.lines) : S.num(d.inQty)) - S.num(d.outQty) },
  { k: 'wastageQty', label: 'Wastage qty (kg)', type: 'number', fmt: 'qty', onInput: d => { d._wastageQtyTouched = true; } },
  { k: 'scrapValue', label: 'Scrap sale value (₹)', type: 'number', fmt: 'money', help: 'Recovery from selling waste, if any' },
  { k: '_wpct', label: 'Wastage %', type: 'calc', fmt: 'pct', value: d => { const i = stage === 'Knitting' ? sumQty(d.lines) : S.num(d.inQty); return i ? S.num(d.wastageQty) / i * 100 : 0; } },
  { k: 'labourRate', label: 'Labour rate (₹/kg)', type: 'number', fmt: 'money', onInput: d => { d._labourTouched = false; } },
  { k: 'labour', label: 'Labour amount (₹)', type: 'number', fmt: 'money', onInput: d => { d._labourTouched = true; } },
]).filter(Boolean);

/* ---------- screens ---------- */
const SCHEMAS = {
  /* ===== Masters ===== */
  items: {
    title: 'Items', singular: 'Item', col: 'items', master: true,
    layout: [{ fields: [
      { k: 'code', label: 'Item code', type: 'text', list: true },
      { k: 'name', label: 'Item name', type: 'text', req: true, w: 2, list: true },
      { k: 'category', label: 'Category', type: 'select', options: S.CATEGORIES, req: true, list: true },
      { k: 'unit', label: 'Unit', type: 'ref', ref: 'units', req: true, list: true },
      { k: 'hsn', label: 'HSN code', type: 'text', list: true },
      { k: 'gst', label: 'GST %', type: 'number', def: 5, list: true },
      { k: 'rate', label: 'Standard rate (₹)', type: 'number', fmt: 'money', help: 'Default purchase/sale rate', list: true },
      { k: 'reorderLevel', label: 'Re-order level', type: 'number', fmt: 'qty' },
      { k: 'description', label: 'Description / quality spec', type: 'textarea', w: 4 },
    ] }],
    listFilter: { k: 'category', options: S.CATEGORIES },
  },
  parties: {
    title: 'Parties', singular: 'Party', col: 'parties', master: true,
    layout: [
      { fields: [
        { k: 'name', label: 'Party name', type: 'text', req: true, w: 2, list: true },
        { k: 'type', label: 'Type', type: 'select', options: S.PARTY_TYPES, req: true, def: 'Customer', list: true },
        { k: 'contactPerson', label: 'Contact person', type: 'text' },
        { k: 'phone', label: 'Phone', type: 'text', list: true },
        { k: 'email', label: 'Email', type: 'text' },
        { k: 'state', label: 'State', type: 'select', options: S.STATE_NAMES, def: 'West Bengal', req: true, list: true, help: 'Same state as us = CGST + SGST, other state = IGST' },
        { k: 'gstin', label: 'GSTIN', type: 'text', list: true, placeholder: 'e.g. 19ABCDE1234F1Z5', help: 'Blank for unregistered (B2C) parties' },
        { k: 'city', label: 'City', type: 'text', list: true },
        { k: 'address', label: 'Address', type: 'textarea', w: 3 },
      ] },
      { title: 'Credit & opening balance', fields: [
        { k: 'creditLimit', label: 'Credit limit (₹)', type: 'number', fmt: 'money', list: true },
        { k: 'creditDays', label: 'Credit days', type: 'number' },
        { k: 'openingBalance', label: 'Opening balance (₹)', type: 'number', fmt: 'money' },
        { k: 'openingType', label: 'Dr / Cr', type: 'select', options: ['Dr', 'Cr'], def: 'Dr', help: 'Dr = party owes us' },
      ] },
    ],
    listFilter: { k: 'type', options: S.PARTY_TYPES },
  },
  units: {
    title: 'Units', singular: 'Unit', col: 'units', master: true,
    layout: [{ fields: [{ k: 'code', label: 'Symbol', type: 'text', req: true, list: true }, { k: 'name', label: 'Unit name', type: 'text', w: 2, list: true }] }],
  },
  locations: {
    title: 'Locations', singular: 'Location', col: 'locations', master: true,
    note: 'Main Store, Knitting Factory, Color Factory and Finished Goods Store are built in; production entries use them automatically.',
    layout: [{ fields: [
      { k: 'name', label: 'Location name', type: 'text', req: true, w: 2, list: true },
      { k: 'type', label: 'Type', type: 'select', options: ['Store', 'Factory', 'Job Worker'], def: 'Store', list: true },
      { k: 'remarks', label: 'Remarks', type: 'textarea', w: 4, list: true },
    ] }],
  },
  machines: {
    title: 'Machines', singular: 'Machine', col: 'machines', master: true,
    layout: [{ fields: [
      { k: 'code', label: 'Machine code', type: 'text', req: true, list: true },
      { k: 'name', label: 'Description', type: 'text', w: 2, list: true },
      { k: 'type', label: 'Used for', type: 'select', options: ['Knitting', 'Dyeing', 'Finishing', 'Other'], def: 'Knitting', list: true },
      { k: 'dia', label: 'Diameter', type: 'text', list: true },
      { k: 'gauge', label: 'Gauge', type: 'text', list: true },
      { k: 'feeders', label: 'Feeders', type: 'number' },
      { k: 'capacity', label: 'Capacity', type: 'text', list: true },
      { k: 'status', label: 'Status', type: 'select', options: ['Running', 'Idle', 'Under maintenance'], def: 'Running', list: true },
    ] }],
  },
  processes: {
    title: 'Processes', singular: 'Process', col: 'processes', master: true,
    layout: [{ fields: [
      { k: 'name', label: 'Process name', type: 'text', req: true, w: 2, list: true },
      { k: 'stage', label: 'Stage', type: 'select', options: S.STAGES, req: true, list: true },
      { k: 'labourRate', label: 'Labour rate (₹/kg)', type: 'number', fmt: 'money', list: true },
      { k: 'remarks', label: 'Remarks', type: 'textarea', w: 4 },
    ] }],
  },
  boms: {
    title: 'BOM / Recipes', singular: 'Recipe', col: 'boms', master: true,
    note: 'Standard consumption per kg of fabric. Pick a recipe in a dyeing or finishing entry to fill its materials automatically.',
    layout: [
      { fields: [
        { k: 'name', label: 'Recipe name', type: 'text', req: true, w: 2, list: true },
        { k: 'stage', label: 'Stage', type: 'select', options: ['Dyeing', 'Finishing'], req: true, def: 'Dyeing', list: true },
        { k: 'outItem', label: 'For output item', type: 'ref', ref: 'items', filter: i => ['Colored Fabric', 'Finished Goods'].includes(i.category), list: true },
        { k: 'wastagePct', label: 'Expected wastage %', type: 'number' },
      ] },
      { grid: { k: 'lines', title: 'Materials per 1 kg of fabric', cols: [C.item(['Dyes & Chemicals', 'Packing Material', 'Others']), { k: 'qtyPerKg', label: 'Qty per kg', type: 'number', req: true }, C.unit] } },
    ],
  },
  priceList: {
    title: 'Party Price List', singular: 'Price', col: 'priceList', master: true,
    note: 'Party-wise sale price. Sales orders and invoices pick this rate automatically.',
    layout: [{ fields: [
      F.party('Customer', { list: true }),
      { k: 'item', label: 'Item', type: 'ref', ref: 'items', req: true, w: 2, filter: i => i.category === 'Finished Goods', list: true },
      { k: 'rate', label: 'Rate (₹/kg)', type: 'number', req: true, fmt: 'money', list: true },
      { k: 'wef', label: 'Effective from', type: 'date', def: () => U.today(), list: true },
    ] }],
  },

  /* ===== Purchase ===== */
  purchaseOrders: {
    title: 'Purchase Orders', singular: 'Purchase Order', col: 'purchaseOrders', printTitle: 'PURCHASE ORDER',
    layout: [
      { fields: [F.no, F.date, F.party('Supplier', { list: true }), { k: 'deliveryDate', label: 'Delivery by', type: 'date' }, { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed', 'Cancelled'], def: 'Open', list: true }] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(S.RAW_CATEGORIES, { onChange: fillPurchaseLine }), C.qty(), C.unit, C.rate, C.gst, C.amount] } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'terms', label: 'Terms', type: 'textarea', w: 3 }] },
      { totals: true },
    ],
    listCols: ['no', 'date', 'party', { k: 'total', label: 'Total', fmt: 'money' }, 'status'],
  },
  grn: {
    title: 'Goods Receipt (GRN)', singular: 'GRN', col: 'grn', printTitle: 'GOODS RECEIPT NOTE',
    layout: [
      { fields: [
        F.no, F.date, F.party('Supplier'),
        { k: 'poId', label: 'Against PO', type: 'ref', ref: 'purchaseOrders', filter: (r, d) => r.party === d.party && r.status !== 'Cancelled',
          help: 'Loads pending PO quantities',
          onChange: (d) => { const po = byId('purchaseOrders', d.poId); if (po) d.lines = pendingFrom(po, 'grn', 'poId', d.id).map(l => ({ item: l.item, lot: '', qty: l.qty, rate: l.rate })); } },
        { k: 'location', label: 'Received at', type: 'ref', ref: 'locations', def: 'STORE', req: true },
        { k: 'challanNo', label: 'Supplier challan no', type: 'text' },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Items received', cols: [C.item(S.CATEGORIES, { onChange: fillPurchaseLine }), C.lotText, C.qty('Qty received'), C.unit, C.rolls, C.rate, C.amount] } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'party', { k: 'poId', label: 'PO' }, 'challanNo', { k: 'total', label: 'Value', fmt: 'money' }],
  },
  purchaseBills: {
    title: 'Purchase Bills', singular: 'Purchase Bill', col: 'purchaseBills', printTitle: 'PURCHASE BILL',
    layout: [
      { fields: [
        F.no, F.date, F.party('Supplier'),
        { k: 'billNo', label: 'Supplier bill no', type: 'text', req: true, list: true },
        { k: 'billDate', label: 'Bill date', type: 'date', def: () => U.today() },
        { k: 'grnId', label: 'Against GRN', type: 'ref', ref: 'grn',
          filter: (r, d) => r.party === d.party && !Cache.list('purchaseBills').some(b => b.grnId === r.id && b.id !== d.id),
          onChange: d => { const g = byId('grn', d.grnId); if (g) d.lines = g.lines.map(l => ({ item: l.item, qty: l.qty, rate: l.rate, gst: S.num((itemOf(l.item) || {}).gst) })); } },
      ] },
      { grid: { k: 'lines', title: 'Bill items', cols: [C.item(S.CATEGORIES, { onChange: fillPurchaseLine }), C.qty(), C.unit, C.rate, C.gst, C.amount] } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'otherCharges', label: 'Other charges (₹)', type: 'number', fmt: 'money' }, F.remarks] },
      { totals: true },
    ],
    listCols: ['no', 'billNo', 'date', 'party', { k: 'taxable', label: 'Taxable', fmt: 'money' }, { k: 'tax', label: 'GST', fmt: 'money' }, { k: 'total', label: 'Total', fmt: 'money' }],
  },
  payments: {
    title: 'Supplier Payments', singular: 'Payment', col: 'payments', printTitle: 'PAYMENT VOUCHER',
    layout: [{ fields: [
      F.no, F.date, F.party('Supplier', { onChange: (d, ctx) => ctx.loadBalance() }),
      { k: '_bal', label: 'Current balance', type: 'calc', value: d => d._balText || '' },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      F.mode, { k: 'refNo', label: 'Cheque / UTR no', type: 'text', list: true }, F.remarks,
    ] }],
    listCols: ['no', 'date', 'party', 'mode', 'refNo', { k: 'amount', label: 'Amount', fmt: 'money' }],
  },

  /* ===== Inventory movements ===== */
  yarnIssue: {
    title: 'Yarn Issue to Knitting', singular: 'Yarn Issue', col: 'transfers', printTitle: 'YARN ISSUE / TRANSFER NOTE',
    fixed: { purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT' }, where: d => d.purpose === 'Yarn Issue',
    note: 'Moves yarn from Main Store to the Knitting Factory (transfer note).',
    layout: [
      { fields: [F.no, F.date, { k: 'vehicleNo', label: 'Vehicle no', type: 'text' }, { k: 'issuedTo', label: 'Issued to', type: 'text' }] },
      { grid: { k: 'lines', title: 'Yarn issued', cols: [C.item(['Yarn']), C.lotFrom(() => 'STORE', 'Yarn lot'), C.qty('Qty (kg)'), C.unit] } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', { k: '_qty', label: 'Total kg', fmt: 'qty', value: d => sumQty(d.lines) }, 'vehicleNo', 'remarks'],
  },
  greyTransfer: {
    title: 'Transfer to Color Factory', singular: 'Grey Transfer', col: 'transfers', printTitle: 'GREY FABRIC TRANSFER NOTE',
    fixed: { purpose: 'Grey Transfer', fromLoc: 'KNIT', toLoc: 'DYE' }, where: d => d.purpose === 'Grey Transfer',
    note: 'Moves grey fabric lots from the Knitting Factory to the Color Factory.',
    layout: [
      { fields: [F.no, F.date, { k: 'vehicleNo', label: 'Vehicle no', type: 'text' }, { k: 'driver', label: 'Driver', type: 'text' }] },
      { grid: { k: 'lines', title: 'Grey fabric lots', cols: [C.item(['Grey Fabric']), C.lotFrom(() => 'KNIT', 'Lot'), C.qty('Qty (kg)'), C.rolls, C.unit] } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', { k: '_lots', label: 'Lots', value: d => (d.lines || []).map(l => l.lot).join(', ') }, { k: '_qty', label: 'Total kg', fmt: 'qty', value: d => sumQty(d.lines) }, 'vehicleNo'],
  },
  transfers: {
    title: 'Stock Transfers', singular: 'Stock Transfer', col: 'transfers', printTitle: 'STOCK TRANSFER NOTE',
    layout: [
      { fields: [
        F.no, F.date,
        { k: 'purpose', label: 'Purpose', type: 'select', options: ['General', 'Yarn Issue', 'Grey Transfer', 'Chemical Issue', 'Return to Store'], def: 'General', list: true },
        { k: 'fromLoc', label: 'From', type: 'ref', ref: 'locations', req: true, def: 'STORE', list: true },
        { k: 'toLoc', label: 'To', type: 'ref', ref: 'locations', req: true, list: true },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(S.CATEGORIES), C.lotFrom(d => d.fromLoc, 'Lot'), C.qty(), C.rolls, C.unit] } },
      { fields: [F.remarks] },
    ],
  },
  stockAdjust: {
    title: 'Opening Stock / Adjustment', singular: 'Stock Adjustment', col: 'stockAdjust',
    note: 'Enter opening stock with positive qty and rate. Use negative qty to write off damaged or short stock.',
    layout: [
      { fields: [F.no, F.date, { k: 'location', label: 'Location', type: 'ref', ref: 'locations', req: true, def: 'STORE', list: true }, { k: 'reason', label: 'Reason', type: 'select', options: ['Opening Stock', 'Physical Verification', 'Damage / Write-off', 'Other'], def: 'Opening Stock', list: true }] },
      { grid: { k: 'lines', title: 'Items (+ adds, - removes)', cols: [C.item(S.CATEGORIES, { onChange: r => { const i = itemOf(r.item); if (i && !S.num(r.rate)) r.rate = S.num(i.rate); } }), C.lotText, C.qty('Qty (+/-)'), C.unit, C.rolls, { k: 'rate', label: 'Rate (for +)', type: 'number', fmt: 'money' }, C.amount] } },
      { fields: [F.remarks] },
    ],
  },

  /* ===== Production ===== */
  knitting: {
    title: 'Knitting Production', singular: 'Knitting Entry', col: 'knitting', printTitle: 'KNITTING PRODUCTION SLIP',
    fixed: { location: 'KNIT' },
    note: 'Consumes yarn at the Knitting Factory and produces a new grey fabric lot.',
    onNew: async doc => { doc.lotNo = (await API.report('nextLot')).lot; const p = Cache.list('processes').find(x => x.stage === 'Knitting'); if (p) { doc.process = p.id; doc.labourRate = S.num(p.labourRate); } },
    recalc: productionRecalc('Knitting'),
    layout: [
      { fields: [
        F.no, F.date,
        { k: 'lotNo', label: 'Lot no (new)', type: 'text', req: true, list: true },
        { k: 'machine', label: 'Machine', type: 'ref', ref: 'machines', filter: m => m.type === 'Knitting', list: true },
        processField('Knitting'),
        { k: 'shift', label: 'Shift', type: 'select', options: ['Day', 'Night', 'General'], def: 'Day' },
        { k: 'operator', label: 'Operator', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Yarn consumed (from Knitting Factory stock)', cols: [C.item(['Yarn']), C.lotFrom(() => 'KNIT', 'Yarn lot'), C.qty('Qty (kg)'), C.unit], totals: ['qty'] } },
      { title: 'Grey fabric output, wastage & labour', fields: outputFields('Knitting', ['Grey Fabric'], [{ k: 'gsm', label: 'GSM', type: 'number' }, { k: 'dia', label: 'Dia', type: 'text' }]) },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'lotNo', 'machine', { k: '_in', label: 'Yarn kg', fmt: 'qty', value: d => sumQty(d.lines) }, { k: 'outQty', label: 'Grey kg', fmt: 'qty' }, { k: 'rolls', label: 'Rolls', fmt: 'int' }, { k: 'wastageQty', label: 'Wastage kg', fmt: 'qty' }],
  },
  dyeing: {
    title: 'Dyeing / Coloring', singular: 'Dyeing Entry', col: 'dyeing', printTitle: 'DYEING BATCH CARD',
    fixed: { chemLoc: 'STORE' },
    note: 'Takes a grey lot at the Color Factory, issues dyes & chemicals from Main Store, and produces colored fabric.',
    onNew: async doc => { const p = Cache.list('processes').find(x => x.stage === 'Dyeing'); if (p) { doc.process = p.id; doc.labourRate = S.num(p.labourRate); } },
    recalc: productionRecalc('Dyeing'),
    layout: [
      { fields: [
        F.no, F.date,
        { k: 'inItem', label: 'Grey fabric', type: 'ref', ref: 'items', req: true, w: 2, filter: i => i.category === 'Grey Fabric' },
        { k: 'lotNo', label: 'Grey lot', type: 'lot', loc: () => 'DYE', itemKey: 'inItem', req: true, list: true,
          onChange: (d, ctx) => { const a = ctx.available('DYE', d.inItem, d.lotNo); if (a > 0) d.inQty = a; d.outLot = d.lotNo; } },
        { k: 'inQty', label: 'Input qty (kg)', type: 'number', req: true, fmt: 'qty' },
        { k: 'machine', label: 'Machine', type: 'ref', ref: 'machines', filter: m => m.type === 'Dyeing' },
        processField('Dyeing'),
        { k: 'color', label: 'Color', type: 'text', list: true },
        { k: 'shade', label: 'Shade / %', type: 'text' },
        bomField('Dyeing'),
      ] },
      { grid: { k: 'lines', title: 'Dyes & chemicals issued (from Main Store)', cols: [C.item(['Dyes & Chemicals']), C.lotFrom(d => d.chemLoc || 'STORE', 'Batch'), C.qty('Qty'), C.unit], onEdit: d => { d._bomAuto = false; } } },
      { title: 'Colored fabric output, wastage & labour', fields: outputFields('Dyeing', ['Colored Fabric']) },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'lotNo', 'color', { k: 'inQty', label: 'Grey kg', fmt: 'qty' }, { k: 'outQty', label: 'Dyed kg', fmt: 'qty' }, { k: 'wastageQty', label: 'Wastage kg', fmt: 'qty' }],
  },
  finishing: {
    title: 'Finishing & Packing', singular: 'Finishing Entry', col: 'finishing', printTitle: 'FINISHING & PACKING SLIP',
    fixed: { packLoc: 'STORE' },
    note: 'Finishes a dyed lot, uses packing material from Main Store and puts finished rolls into the Finished Goods Store.',
    onNew: async doc => { const p = Cache.list('processes').find(x => x.stage === 'Finishing'); if (p) { doc.process = p.id; doc.labourRate = S.num(p.labourRate); } },
    recalc: productionRecalc('Finishing'),
    layout: [
      { fields: [
        F.no, F.date,
        { k: 'inItem', label: 'Colored fabric', type: 'ref', ref: 'items', req: true, w: 2, filter: i => i.category === 'Colored Fabric' },
        { k: 'lotNo', label: 'Lot', type: 'lot', loc: () => 'DYE', itemKey: 'inItem', req: true, list: true,
          onChange: (d, ctx) => { const a = ctx.available('DYE', d.inItem, d.lotNo); if (a > 0) d.inQty = a; d.outLot = d.lotNo; } },
        { k: 'inQty', label: 'Input qty (kg)', type: 'number', req: true, fmt: 'qty' },
        processField('Finishing'),
        { k: 'finishType', label: 'Finish', type: 'select', options: ['Compacting', 'Stentering', 'Open width', 'Tubular', 'Raising', 'Other'] },
        bomField('Finishing'),
      ] },
      { grid: { k: 'lines', title: 'Packing materials used (from Main Store)', cols: [C.item(['Packing Material', 'Others']), C.lotFrom(d => d.packLoc || 'STORE', 'Batch'), C.qty(), C.unit], onEdit: d => { d._bomAuto = false; } } },
      { title: 'Finished goods output (roll / kg), wastage & labour', fields: outputFields('Finishing', ['Finished Goods'], [{ k: 'meters', label: 'Meters', type: 'number', fmt: 'qty' }, { k: 'quality', label: 'Quality / grade', type: 'select', options: ['A', 'B', 'Seconds'], def: 'A' }]) },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'lotNo', { k: 'outItem', label: 'Item' }, { k: 'inQty', label: 'In kg', fmt: 'qty' }, { k: 'outQty', label: 'FG kg', fmt: 'qty' }, { k: 'rolls', label: 'Rolls', fmt: 'int' }, { k: 'wastageQty', label: 'Wastage kg', fmt: 'qty' }],
  },

  /* ===== Costing ===== */
  overheads: {
    title: 'Overhead Entries', singular: 'Overhead', col: 'overheads',
    note: 'Monthly overheads are spread over the kg finished in that month and added to each lot\'s cost.',
    layout: [{ fields: [
      F.no, F.date,
      { k: 'category', label: 'Category', type: 'select', options: S.OVERHEAD_CATEGORIES, req: true, w: 2, list: true },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      { k: 'paidTo', label: 'Paid to', type: 'text', list: true }, F.mode, F.remarks,
    ] }],
  },

  /* ===== Sales ===== */
  salesOrders: {
    title: 'Sales Orders', singular: 'Sales Order', col: 'salesOrders', printTitle: 'SALES ORDER', credit: true,
    layout: [
      { fields: [F.no, F.date, F.party('Customer', { list: true, onChange: (d, ctx) => ctx.loadBalance() }), { k: '_bal', label: 'Outstanding', type: 'calc', value: d => d._balText || '' }, { k: 'customerPo', label: 'Customer PO no', type: 'text' }, { k: 'deliveryDate', label: 'Delivery by', type: 'date' }, { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed', 'Cancelled'], def: 'Open', list: true }] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), C.qty('Qty (kg)'), C.rolls, C.unit, C.rate, C.gst, C.amount] } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'terms', label: 'Terms', type: 'textarea', w: 3 }] },
      { totals: true },
    ],
    listCols: ['no', 'date', 'party', 'customerPo', 'deliveryDate', { k: 'total', label: 'Total', fmt: 'money' }, 'status'],
  },
  deliveries: {
    title: 'Delivery Challans', singular: 'Delivery Challan', col: 'deliveries', printTitle: 'DELIVERY CHALLAN',
    fixed: { location: 'FG' },
    note: 'Dispatches finished lots from the Finished Goods Store.',
    layout: [
      { fields: [
        F.no, F.date, F.party('Customer'),
        { k: 'soId', label: 'Against sales order', type: 'ref', ref: 'salesOrders', filter: (r, d) => r.party === d.party && r.status !== 'Cancelled',
          onChange: d => { const so = byId('salesOrders', d.soId); if (so) d.lines = pendingFrom(so, 'deliveries', 'soId', d.id).map(l => ({ item: l.item, lot: '', qty: l.qty, rolls: '', rate: l.rate })); } },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text', list: true },
        { k: 'transporter', label: 'Transporter', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Goods dispatched', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), C.lotFrom(() => 'FG', 'Lot'), C.qty('Qty (kg)'), C.rolls, C.unit, C.rate, C.amount], totals: ['qty', 'rolls'] } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'party', { k: '_qty', label: 'Kg', fmt: 'qty', value: d => sumQty(d.lines) }, 'vehicleNo', { k: '_inv', label: 'Invoiced', value: d => { const i = Cache.list('invoices').find(x => x.challanId === d.id); return i ? i.no : '—'; } }],
    needs: ['invoices'],
  },
  invoices: {
    title: 'Sales Invoices', singular: 'Invoice', col: 'invoices', printTitle: 'TAX INVOICE', credit: true,
    fixed: { location: 'FG' },
    note: 'Pick a delivery challan to bill it, or enter lots directly (stock then leaves with the invoice).',
    layout: [
      { fields: [
        F.no, F.date, F.party('Customer', { onChange: (d, ctx) => ctx.loadBalance() }),
        { k: '_bal', label: 'Outstanding', type: 'calc', value: d => d._balText || '' },
        { k: 'challanId', label: 'Against challan', type: 'ref', ref: 'deliveries',
          filter: (r, d) => r.party === d.party && !Cache.list('invoices').some(i => i.challanId === r.id && i.id !== d.id),
          onChange: d => { const c = byId('deliveries', d.challanId); if (c) d.lines = c.lines.map(l => ({ item: l.item, lot: l.lot, qty: l.qty, rolls: l.rolls, rate: S.num(l.rate) || priceFor(d.party, l.item), gst: S.num((itemOf(l.item) || {}).gst) })); } },
        { k: 'placeOfSupply', label: 'Place of supply', type: 'select', options: S.STATE_NAMES, help: 'Blank = customer\'s state. Decides CGST+SGST or IGST' },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' },
        { k: 'dueDate', label: 'Due date', type: 'date' },
      ] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), C.lotFrom(() => 'FG', 'Lot'), C.qty('Qty (kg)'), C.rolls, C.unit, C.rate, C.gst, C.amount] } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'otherCharges', label: 'Other charges (₹)', type: 'number', fmt: 'money' }, { k: 'discount', label: 'Discount (₹)', type: 'number', fmt: 'money' }, F.remarks] },
      { totals: true },
    ],
    listCols: ['no', 'date', 'party', { k: 'challanId', label: 'Challan' }, { k: 'taxable', label: 'Taxable', fmt: 'money' }, { k: 'tax', label: 'GST', fmt: 'money' }, { k: 'total', label: 'Total', fmt: 'money' }],
  },

  /* ===== Customers ===== */
  customers: {
    title: 'Customer Master', singular: 'Customer', col: 'parties', master: true, extends: 'parties',
    fixed: {}, where: p => S.partyIs(p, 'Customer'),
  },
  receipts: {
    title: 'Payment Receipts', singular: 'Receipt', col: 'receipts', printTitle: 'PAYMENT RECEIPT',
    layout: [{ fields: [
      F.no, F.date, F.party('Customer', { onChange: (d, ctx) => ctx.loadBalance() }),
      { k: '_bal', label: 'Outstanding', type: 'calc', value: d => d._balText || '' },
      { k: 'amount', label: 'Amount received (₹)', type: 'number', req: true, fmt: 'money', list: true },
      F.mode, { k: 'refNo', label: 'Cheque / UTR no', type: 'text', list: true },
      { k: 'invoiceId', label: 'Against invoice (optional)', type: 'ref', ref: 'invoices', filter: (r, d) => r.party === d.party },
      F.remarks,
    ] }],
    listCols: ['no', 'date', 'party', 'mode', 'refNo', { k: 'amount', label: 'Amount', fmt: 'money' }],
  },

  /* ===== Admin ===== */
  users: {
    title: 'Users', singular: 'User', col: 'users', master: true, adminOnly: true,
    note: 'Each login gets a role. The role decides which departments, screens and reports the person can see and whether they can add, edit or delete.',
    needs: ['roles'],
    layout: [{ fields: [
      { k: 'username', label: 'Username', type: 'text', req: true, list: true },
      { k: 'name', label: 'Full name', type: 'text', w: 2, list: true },
      { k: 'role', label: 'Role / department', type: 'select', req: true, list: true, w: 2, help: 'Decides which screens and reports this login can use',
        options: () => [['admin', 'Administrator (everything)']].concat(Cache.list('roles').map(r => [r.id, r.name])) },
      { k: 'department', label: 'Department / unit', type: 'text', placeholder: 'e.g. Knitting unit 1', list: true },
      { k: 'password', label: 'Password', type: 'password', help: 'Leave blank to keep the current password' },
      { k: 'active', label: 'Active', type: 'check', def: true, list: true },
    ] }],
  },
};

SCHEMAS.roles = {
  title: 'Roles & Permissions', singular: 'Role', col: 'roles', master: true, adminOnly: true, area: 'admin',
  note: 'View = can open and print. Add & edit = can also enter and change. Full = can also delete. Changes apply to every user with this role immediately.',
  layout: [
    { fields: [
      { k: 'name', label: 'Role name', type: 'text', req: true, w: 2, list: true },
      { k: 'description', label: 'Description', type: 'text', w: 2, list: true },
    ] },
    { title: 'What this role can do', fields: [{ k: 'perms', label: 'Permissions', type: 'perms', w: 4, def: () => ({}) }] },
  ],
  listCols: ['name', 'description', { k: '_areas', label: 'Access', value: r => S.PERM_AREAS.filter(a => r.perms && r.perms[a.k] && r.perms[a.k] !== 'none').length + ' of ' + S.PERM_AREAS.length + ' areas' }, { k: '_users', label: 'Users', value: r => Cache.list('users').filter(u => u.role === r.id).length }],
  needs: ['users'],
};

// `customers` reuses the party layout with Customer as default type.
SCHEMAS.customers.layout = SCHEMAS.parties.layout.map(b => Object.assign({}, b, { fields: b.fields.map(f => f.k === 'type' ? Object.assign({}, f, { def: 'Customer' }) : f) }));

// Fill in keys / flattened field lists.
for (const [key, s] of Object.entries(SCHEMAS)) {
  s.key = key;
  s.fields = [];
  s.grids = [];
  for (const b of s.layout) { if (b.fields) s.fields.push(...b.fields); if (b.grid) s.grids.push(b.grid); }
  s.hasTotals = s.layout.some(b => b.totals);
  s.isDoc = !s.master;
  if (!s.area) s.area = s.adminOnly ? 'admin' : S.areaOf(s.col, s.fixed);
}

/* ---------- navigation (mirrors the process-flow chart) ---------- */
const NAV = [
  { t: 'Dashboard', icon: 'home', href: '#/dashboard' },
  { t: 'Masters', icon: 'db', kids: [['Items', 'items'], ['Parties', 'parties'], ['Units', 'units'], ['Locations', 'locations'], ['Machines', 'machines'], ['Processes', 'processes'], ['BOM / Recipes', 'boms']] },
  { t: 'Purchase', icon: 'cart', kids: [['Purchase Orders', 'purchaseOrders'], ['Goods Receipt (GRN)', 'grn'], ['Purchase Bills', 'purchaseBills'], ['Supplier Payments', 'payments'], ['Pending POs', '#/report/poPending']] },
  { t: 'Inventory', icon: 'box', kids: [['Stock Summary', '#/report/stock'], ['Stock Ledger', '#/report/stockLedger'], ['Yarn Issue to Knitting', 'yarnIssue'], ['Transfer to Color Factory', 'greyTransfer'], ['All Transfers', 'transfers'], ['Opening / Adjustment', 'stockAdjust']] },
  { t: 'Production', icon: 'factory', kids: [['Knitting', 'knitting'], ['Dyeing / Coloring', 'dyeing'], ['Finishing & Packing', 'finishing'], ['Production Report', '#/report/production'], ['Batch / Lot Tracking', '#/report/lots']] },
  { t: 'Wastage', icon: 'trash', kids: [['Wastage Report', '#/report/wastage']] },
  { t: 'Costing', icon: 'calc', kids: [['Lot Costing Sheet', '#/report/costing'], ['Item-wise Costing', '#/report/itemCosting'], ['Overhead Entries', 'overheads'], ['Overhead Absorption', '#/report/overheads']] },
  { t: 'Sales', icon: 'tag', kids: [['Sales Orders', 'salesOrders'], ['Delivery Challans', 'deliveries'], ['Invoices', 'invoices'], ['Party Price List', 'priceList'], ['Pending Orders', '#/report/soPending']] },
  { t: 'Customers', icon: 'users', kids: [['Customer Master', 'customers'], ['Payment Receipts', 'receipts'], ['Receivables & Credit', '#/report/outstanding?type=receivable']] },
  { t: 'Finance & Accounts', icon: 'rupee', kids: [['Customer Receipts', 'receipts'], ['Supplier Payments', 'payments'], ['Party Ledger', '#/report/partyLedger'], ['Receivables', '#/report/outstanding?type=receivable'], ['Payables', '#/report/outstanding?type=payable'], ['GST Summary', '#/report/gst']] },
  { t: 'Reports', icon: 'chart', href: '#/reports' },
  { t: 'User Management', icon: 'shield', kids: [['Users', 'users'], ['Roles & Permissions', 'roles'], ['Settings & Password', '#/settings']] },
];

/* ---------- reports ---------- */
const REPORTS = {
  stock: { title: 'Stock Summary', group: 'Inventory', filters: ['asOn', 'location', 'category', 'item', 'stockGroup', 'zero'] },
  stockLedger: { title: 'Stock Ledger', group: 'Inventory', filters: ['item', 'location', 'lot', 'from', 'to'] },
  negativeStock: { title: 'Stock Exceptions', group: 'Inventory', filters: [] },
  purchase: { title: 'Purchase Report', group: 'Purchase', filters: ['from', 'to', 'supplier', 'item'] },
  poPending: { title: 'Pending Purchase Orders', group: 'Purchase', filters: ['supplier', 'all'] },
  production: { title: 'Production Report', group: 'Production', filters: ['from', 'to', 'stage'] },
  lots: { title: 'Batch / Lot Tracking', group: 'Production', filters: ['lot'] },
  wastage: { title: 'Wastage Report', group: 'Production', filters: ['from', 'to', 'stage'] },
  costing: { title: 'Lot Costing Sheet', group: 'Costing', filters: ['from', 'to', 'fgItem'] },
  itemCosting: { title: 'Item-wise Costing', group: 'Costing', filters: ['from', 'to'] },
  overheads: { title: 'Overhead Absorption', group: 'Costing', filters: ['from', 'to'] },
  profitability: { title: 'Profitability Report', group: 'Costing', filters: ['from', 'to', 'customer', 'fgItem', 'groupBy'] },
  sales: { title: 'Sales Report', group: 'Sales', filters: ['from', 'to', 'customer', 'fgItem'] },
  soPending: { title: 'Pending Sales Orders', group: 'Sales', filters: ['customer', 'all'] },
  outstanding: { title: 'Outstanding Report', group: 'Accounts', filters: ['type', 'asOn'] },
  partyLedger: { title: 'Party Ledger', group: 'Accounts', filters: ['party', 'from', 'to'] },
  gst: { title: 'GST Summary', group: 'Accounts', filters: ['from', 'to'] },
};

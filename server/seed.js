'use strict';
// Base records every installation needs, plus an optional demo data set.
//   node server/seed.js --demo     loads the demo into an empty database
const crypto = require('crypto');
const { hashPassword } = require('./auth');
const engine = require('./engine');
const { isAgency } = require('../public/js/shared');

const now = () => new Date().toISOString();
const id = () => crypto.randomBytes(8).toString('hex');

// The four fixed locations of the process flow. Production entries refer to these ids.
const BASE_LOCATIONS = [
  { id: 'STORE', name: 'Main Store', type: 'Store', remarks: 'Raw material store (yarn, dyes & chemicals, packing)' },
  { id: 'KNIT', name: 'Knitting Factory', type: 'Factory', remarks: 'Yarn is knitted into grey fabric here' },
  { id: 'DYE', name: 'Color Factory', type: 'Factory', remarks: 'Dyeing, finishing and packing' },
  { id: 'FG', name: 'Finished Goods Store', type: 'Store', remarks: 'Packed finished fabric ready for sale' },
];

// Ready-made department roles. Admin can edit them or add more from User Management -> Roles.
// Ids "manager" and "operator" keep users from the earlier fixed-role version working.
const ALL = lvl => Object.fromEntries(require('../public/js/shared').PERM_AREAS.map(a => [a.k, a.viewOnly && lvl !== 'none' ? 'view' : lvl]));
const PRESET_ROLES = [
  { id: 'manager', name: 'Management', description: 'Owner / factory manager: sees and controls everything except users', perms: ALL('full') },
  { id: 'operator', name: 'Data Entry (all modules)', description: 'Can enter and edit in every module but cannot delete', perms: Object.assign(ALL('edit'), { dashboard: 'none', rep_costing: 'none', rep_accounts: 'none', rep_gst: 'none', approvals: 'none', salary: 'none', banking: 'none' }) },
  { id: 'purchase', name: 'Purchase Department', description: 'Raises POs, books supplier bills',
    perms: { masters: 'edit', purchaseOrders: 'full', grn: 'view', purchaseBills: 'full', payments: 'view', rep_purchase: 'view', rep_inventory: 'view' } },
  { id: 'store', name: 'Store / Inventory', description: 'Receives material (GRN), issues yarn, keeps stock',
    perms: { purchaseOrders: 'view', grn: 'full', storeTransfers: 'full', stockAdjust: 'edit', rep_inventory: 'view', rep_purchase: 'view' } },
  { id: 'knitting', name: 'Knitting Department', description: 'Knitting production and grey fabric dispatch to color factory',
    perms: { knitting: 'full', greyTransfer: 'full', jobStatus: 'full', rep_production: 'view', rep_inventory: 'view' } },
  { id: 'dyeing', name: 'Dyeing / Color Department', description: 'Dyeing batches and chemical consumption',
    perms: { dyeing: 'full', jobStatus: 'full', rep_production: 'view', rep_inventory: 'view' } },
  { id: 'finishing', name: 'Finishing & Packing', description: 'Finishing, packing and finished goods output',
    perms: { finishing: 'full', jobStatus: 'full', rep_production: 'view', rep_inventory: 'view' } },
  { id: 'sales', name: 'Sales Department', description: 'Leads, quotations, orders, dispatch challans, invoices and customer prices',
    perms: { masters: 'edit', leads: 'full', quotations: 'full', priceList: 'full', salesOrders: 'full', deliveries: 'full', invoices: 'full', receipts: 'view', rep_sales: 'view', rep_inventory: 'view', rep_accounts: 'view' } },
  { id: 'accounts', name: 'Finance & Accounts', description: 'Receipts, payments, bank, expenses, salaries, EMIs, bills, GST and costing',
    perms: { dashboard: 'view', purchaseBills: 'full', payments: 'full', receipts: 'full', invoices: 'view', overheads: 'full', labourPayments: 'full', banking: 'full', loans: 'full', powerBills: 'full', staff: 'edit', salary: 'full',
      rep_accounts: 'view', rep_gst: 'view', rep_purchase: 'view', rep_sales: 'view', rep_costing: 'view', rep_inventory: 'view' } },
];
// Areas added after the first release: ready-made roles that have never had them set get the preset level.
const NEW_AREAS = ['labourPayments', 'approvals', 'leads', 'jobStatus', 'quotations', 'banking', 'loans', 'powerBills', 'staff', 'salary', 'rep_gst'];

function ensureBase(data) {
  const stamp = { createdAt: now(), createdBy: 'system' };
  if (!data.roles.length) for (const r of PRESET_ROLES) data.roles.push(Object.assign({}, r, stamp));
  for (const r of data.roles) {
    const preset = PRESET_ROLES.find(p => p.id === r.id);
    if (!preset) continue;
    for (const k of NEW_AREAS) if (preset.perms[k] && (r.perms || {})[k] === undefined) r.perms = Object.assign({}, r.perms, { [k]: preset.perms[k] });
  }
  if (!data.users.length) {
    const { salt, hash } = hashPassword('admin123');
    data.users.push(Object.assign({ id: id(), username: 'admin', name: 'Administrator', role: 'admin', active: true, salt, hash }, stamp));
  }
  for (const l of BASE_LOCATIONS) if (!data.locations.some(x => x.id === l.id)) data.locations.push(Object.assign({}, l, stamp, { system: true }));
  // Cash in hand is always there; bank accounts are added in Accounts → Bank & Cash Accounts.
  if (!data.banks.some(b => b.id === 'CASH')) data.banks.push(Object.assign({ id: 'CASH', name: 'Cash in Hand', type: 'Cash', system: true }, stamp));
  syncAgencies(data);
  if (!data.units.length) {
    for (const [code, name] of [['Kg', 'Kilogram'], ['Nos', 'Numbers'], ['Roll', 'Roll'], ['Mtr', 'Meter'], ['Ltr', 'Litre'], ['Pcs', 'Pieces'], ['Box', 'Box']]) {
      data.units.push(Object.assign({ id: id(), code, name }, stamp));
    }
  }
  if (!data.processes.length) {
    for (const [name, stage, labourRate] of [['Knitting', 'Knitting', 8], ['Dyeing', 'Dyeing', 15], ['Finishing & Packing', 'Finishing', 6]]) {
      data.processes.push(Object.assign({ id: id(), name, stage, labourRate }, stamp));
    }
  }
}

// Each agency (a party that does knitting, dyeing or finishing for us) has a location of its own,
// named after it, that holds the material sent to it. Made when the party is saved; renamed with it.
function syncAgencies(data) {
  for (const p of data.parties) {
    if (!isAgency(p)) continue;
    let l = data.locations.find(x => x.party === p.id);
    if (!l) { l = { id: id(), party: p.id, type: 'Job Worker', createdAt: now(), createdBy: 'system', system: true }; data.locations.push(l); }
    const taken = n => data.locations.some(x => x !== l && String(x.name || '').trim().toLowerCase() === n.toLowerCase());
    l.name = taken(p.name) ? p.name + ' (agency)' : p.name;
    l.remarks = 'Agency: material sent to ' + p.name + ' for job work';
  }
}

function hasTransactions(data) {
  return engine.STOCK_COLS.concat(['purchaseOrders', 'purchaseBills', 'payments', 'receipts', 'salesOrders', 'overheads', 'labourPayments', 'quotations', 'bankEntries', 'salary', 'emiPayments', 'powerBills']).some(c => data[c].length);
}

function loadDemo(data) {
  if (hasTransactions(data)) throw new Error('Demo data can only be loaded into an empty database (no transactions yet).');
  ensureBase(data);
  const base = new Date();
  const day = n => { const d = new Date(base); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  let seq = 0;
  const stamp = () => ({ createdAt: new Date(Date.now() - 1e8 + (seq++) * 1000).toISOString(), createdBy: 'admin' });
  const unit = code => data.units.find(u => u.code === code).id;
  const counters = data.counters;
  const add = (col, prefix, doc) => {
    const d = Object.assign({ id: id() }, doc, stamp());
    if (prefix) { counters[col] = (counters[col] || 0) + 1; d.no = prefix + '-' + String(counters[col]).padStart(4, '0'); }
    engine.prepare(col, d, data);
    data[col].push(d);
    return d;
  };

  data.settings.address = '12, B.T. Road';
  data.settings.city = 'Kolkata';
  data.settings.gstin = '19ABCDE1234F1Z5';
  data.settings.phone = '+91 98300 00000';

  const I = {};
  const items = [
    ['Y30', 'Cotton Yarn 30s Combed', 'Yarn', 'Kg', 5, '5205', 245, 500],
    ['Y40', 'Cotton Yarn 40s Combed', 'Yarn', 'Kg', 5, '5205', 275, 200],
    ['LY40', 'Lycra 40D', 'Yarn', 'Kg', 5, '5402', 520, 20],
    ['DRED', 'Reactive Red ME4BL', 'Dyes & Chemicals', 'Kg', 18, '3204', 480, 10],
    ['DBLU', 'Reactive Blue RR', 'Dyes & Chemicals', 'Kg', 18, '3204', 520, 10],
    ['CSODA', 'Soda Ash', 'Dyes & Chemicals', 'Kg', 18, '2836', 38, 100],
    ['CSALT', 'Glauber Salt', 'Dyes & Chemicals', 'Kg', 18, '2833', 12, 300],
    ['CSOFT', 'Silicone Softener', 'Dyes & Chemicals', 'Kg', 18, '3809', 160, 20],
    ['PPOLY', 'Poly Bag (Large)', 'Packing Material', 'Nos', 18, '3923', 6, 100],
    ['PTUBE', 'Paper Core Tube', 'Packing Material', 'Nos', 18, '4822', 14, 100],
    ['PTAPE', 'BOPP Tape Roll', 'Packing Material', 'Nos', 18, '3919', 35, 10],
    ['GSJ30', 'Grey Single Jersey 30s', 'Grey Fabric', 'Kg', 5, '6006', 0, 0],
    ['GRIB', 'Grey 1x1 Rib 30s', 'Grey Fabric', 'Kg', 5, '6006', 0, 0],
    ['CSJ30', 'Dyed Single Jersey 30s', 'Colored Fabric', 'Kg', 5, '6006', 0, 0],
    ['CRIB', 'Dyed 1x1 Rib 30s', 'Colored Fabric', 'Kg', 5, '6006', 0, 0],
    ['FSJ30', 'Finished Single Jersey 30s', 'Finished Goods', 'Kg', 5, '6006', 420, 0],
    ['FRIB', 'Finished 1x1 Rib 30s', 'Finished Goods', 'Kg', 5, '6006', 445, 0],
  ];
  for (const [code, name, category, u, gst, hsn, rate, reorderLevel] of items) I[code] = add('items', null, { code, name, category, unit: unit(u), gst, hsn, rate, reorderLevel }).id;

  const P = {};
  const parties = [
    ['SSM', 'Shree Spinning Mills', 'Supplier', 'West Bengal', 'Howrah', '19AAACS1111A1Z1', 0, 30],
    ['CTX', 'Colourtex Chemicals', 'Supplier', 'Gujarat', 'Surat', '24AAACC2222B1Z2', 0, 30],
    ['BPK', 'Bengal Packaging Co.', 'Supplier', 'West Bengal', 'Kolkata', '19AAACB3333C1Z3', 0, 15],
    ['KGP', 'Kolkata Garments Pvt Ltd', 'Customer', 'West Bengal', 'Kolkata', '19AAACK4444D1Z4', 500000, 30],
    ['SUN', 'Sunrise Apparels', 'Customer', 'West Bengal', 'Howrah', '19AAACS5555E1Z5', 300000, 45],
    ['EHT', 'Eastern Hosiery Traders', 'Customer', 'Odisha', 'Cuttack', '21AAACE6666F1Z6', 200000, 30],
    ['MKW', 'Metro Knit Wear', 'Customer', 'Jharkhand', 'Ranchi', '20AAACM7777G1Z7', 150000, 30],
    ['BGC', 'Bharat Garments Co.', 'Customer', 'West Bengal', 'Siliguri', '19AAACB8888H1Z8', 150000, 21],
  ];
  for (const [k, name, type, state, city, gstin, creditLimit, creditDays] of parties) P[k] = add('parties', null, { name, type, state, city, gstin, creditLimit, creditDays, phone: '+91 90000 0000' + Object.keys(P).length, openingBalance: 0, openingType: 'Dr' }).id;
  // bank details on file fill in by themselves on payments and receipts
  Object.assign(data.parties.find(p => p.id === P.SSM), { bankName: 'HDFC Bank, Howrah', bankAccount: '50200012345678', ifsc: 'HDFC0001234' });
  Object.assign(data.parties.find(p => p.id === P.KGP), { bankName: 'Axis Bank, Burrabazar' });
  Object.assign(data.parties.find(p => p.id === P.SUN), { upi: 'sunrise@okhdfcbank' });
  // Job-work agencies: two knitters, a dyeing house that also finishes, and a finishing house.
  const agencies = [
    ['AK1', 'Maa Tara Knitting Works', 'Howrah', { doesKnitting: true, knitRate: 8 }],
    ['AK2', 'Sree Durga Knitters', 'Kolkata', { doesKnitting: true, knitRate: 8.5 }],
    ['AD1', 'Bengal Dyeing & Processing', 'Howrah', { doesDyeing: true, dyeRate: 15, doesFinishing: true, finRate: 6 }],
    ['AF1', 'Kolkata Compacting House', 'Kolkata', { doesFinishing: true, finRate: 5.5 }],
  ];
  for (const [k, name, city, work] of agencies) P[k] = add('parties', null, Object.assign({ name, type: 'Job Worker', state: 'West Bengal', city, phone: '+91 91000 0000' + Object.keys(P).length, openingBalance: 0, openingType: 'Cr' }, work)).id;
  syncAgencies(data);
  const A = k => data.locations.find(l => l.party === P[k]).id; // the agency's stock location
  const rate = (k, f) => data.parties.find(x => x.id === P[k])[f];

  const M = {};
  M.K1 = add('machines', null, { code: 'KM-01', name: 'Single Jersey 30" 24G', type: 'Knitting', dia: '30"', gauge: '24G', feeders: 90, capacity: '350 kg/day', status: 'Running' }).id;
  M.K2 = add('machines', null, { code: 'KM-02', name: 'Rib 30" 18G', type: 'Knitting', dia: '30"', gauge: '18G', feeders: 60, capacity: '250 kg/day', status: 'Running' }).id;
  M.D1 = add('machines', null, { code: 'DM-01', name: 'Soft Flow 600 kg', type: 'Dyeing', capacity: '600 kg/batch', status: 'Running' }).id;
  const proc = stage => data.processes.find(p => p.stage === stage);

  add('boms', null, { name: 'Red Reactive Recipe', stage: 'Dyeing', outItem: I.CSJ30, wastagePct: 3, lines: [{ item: I.DRED, qtyPerKg: 0.03 }, { item: I.CSODA, qtyPerKg: 0.1 }, { item: I.CSALT, qtyPerKg: 0.5 }, { item: I.CSOFT, qtyPerKg: 0.02 }] });
  add('boms', null, { name: 'Blue Reactive Recipe', stage: 'Dyeing', outItem: I.CSJ30, wastagePct: 3, lines: [{ item: I.DBLU, qtyPerKg: 0.025 }, { item: I.CSODA, qtyPerKg: 0.1 }, { item: I.CSALT, qtyPerKg: 0.5 }, { item: I.CSOFT, qtyPerKg: 0.02 }] });
  add('boms', null, { name: 'Standard Roll Packing', stage: 'Finishing', outItem: I.FSJ30, wastagePct: 2, lines: [{ item: I.PPOLY, qtyPerKg: 0.04 }, { item: I.PTUBE, qtyPerKg: 0.04 }, { item: I.PTAPE, qtyPerKg: 0.005 }] });
  add('priceList', null, { party: P.KGP, item: I.FSJ30, rate: 420, wef: day(200) });
  add('priceList', null, { party: P.SUN, item: I.FSJ30, rate: 415, wef: day(200) });
  add('priceList', null, { party: P.EHT, item: I.FRIB, rate: 455, wef: day(200) });

  // Six months of activity, one block per ~30 days, oldest first. Quantities are chosen so stock never goes negative.
  const itemGst = it => data.items.find(i => i.id === it).gst;
  const COLORS = [['Red', 'DRED', 0.03], ['Navy Blue', 'DBLU', 0.025], ['Maroon', 'DRED', 0.035], ['Royal Blue', 'DBLU', 0.02]];
  const CHEM = [['CSODA', 0.1], ['CSALT', 0.5], ['CSOFT', 0.02]];
  const openInv = []; // [date, party, total]
  const openBills = [];
  // Agencies are paid at the start of each month for the month before, so the newest month is still owed.
  const agencyDue = {};
  const owe = (k, amt) => { agencyDue[k] = (agencyDue[k] || 0) + amt; };
  const BLOCKS = 12;
  let lastBatch = () => '';
  for (let b = 0; b < BLOCKS; b++) {
    const s0 = 30 * (BLOCKS - b) - 4;          // block start, in days ago (356, 326 ... 26)
    const last = b === BLOCKS - 1;
    const yarnRate = 242 + b * 2 + (b % 2);     // yarn prices drift up a little
    // --- purchase
    const poY = add('purchaseOrders', 'PO', { date: day(s0), party: P.SSM, deliveryDate: day(s0 - 3), status: 'Closed', lines: [{ item: I.Y30, qty: 1250, rate: yarnRate, gst: 5 }] });
    const poC = add('purchaseOrders', 'PO', { date: day(s0), party: P.CTX, status: 'Closed', lines: [{ item: I.DRED, qty: 25, rate: 480, gst: 18 }, { item: I.DBLU, qty: 20, rate: 520, gst: 18 }, { item: I.CSODA, qty: 130, rate: 38, gst: 18 }, { item: I.CSALT, qty: 620, rate: 12, gst: 18 }, { item: I.CSOFT, qty: 26, rate: 160, gst: 18 }] });
    const poP = add('purchaseOrders', 'PO', { date: day(s0), party: P.BPK, status: 'Closed', lines: [{ item: I.PPOLY, qty: 60, rate: 6, gst: 18 }, { item: I.PTUBE, qty: 60, rate: 14, gst: 18 }, { item: I.PTAPE, qty: 6, rate: 35, gst: 18 }] });
    let batch = ''; // the yarn's lot number, given by the GRN; it stays with the fabric up to the sale
    lastBatch = () => batch;
    for (const po of [poY, poC, poP]) {
      const g = add('grn', 'GRN', { date: day(s0 - 1), party: po.party, poId: po.id, location: 'STORE', challanNo: 'CH-' + (500 + seq), lines: po.lines.map(l => ({ item: l.item, lot: '', qty: l.qty, rate: l.rate })) });
      if (po === poY) batch = g.lines[0].lot;
      const bill = add('purchaseBills', 'PB', { date: day(s0 - 1), billDate: day(s0 - 1), billNo: 'B/' + (900 + seq), party: g.party, grnId: g.id, freight: po === poY ? 2500 : 0, lines: g.lines.map(l => ({ item: l.item, qty: l.qty, rate: l.rate, gst: itemGst(l.item) })) });
      openBills.push(bill);
    }
    // pay last block's bills
    for (const bill of openBills.splice(0, openBills.length - 3)) {
      add('payments', 'PAY', { date: day(s0 - 2), party: bill.party, amount: bill.total, mode: 'Bank Transfer', transferType: bill.total > 200000 ? 'RTGS' : 'NEFT', refNo: String(70000 + seq) });
    }

    for (const [k, amt] of Object.entries(agencyDue)) {
      if (amt > 0) add('payments', 'PAY', { date: day(s0 - 2), party: P[k], amount: Math.round(amt * 100) / 100, mode: 'Bank Transfer', transferType: 'NEFT', refNo: String(80000 + seq), remarks: 'Job charges, previous month' });
      agencyDue[k] = 0;
    }

    // --- knitting at an agency (the two knitters take turns): 600 kg of the yarn lot into single jersey,
    // 600 kg into rib (both keep the yarn's lot number); the grey fabric goes straight to the dyeing house
    const knitter = b % 2 ? 'AK2' : 'AK1', kr = rate(knitter, 'knitRate');
    add('transfers', 'TRF', { date: day(s0 - 2), purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: A(knitter), expectedQty: 1170, jobRate: kr, expectedDate: day(s0 - 6), lines: [{ item: I.Y30, lot: batch, qty: 1200 }] });
    const lots = [];
    for (let k = 0; k < 2; k++) {
      const lot = batch;
      const waste = 10 + ((b + k) % 4) * 2;          // 10-16 kg
      const out = 600 - waste - 2;
      const rolls = Math.round(out / 24);
      add('knitting', 'KNT', { date: day(s0 - 3 - k), machine: k ? M.K2 : M.K1, process: proc('Knitting').id, location: A(knitter), outLoc: A('AD1'), shift: k ? 'Night' : 'Day', lines: [{ item: I.Y30, lot: batch, qty: 600 }], outItem: k ? I.GRIB : I.GSJ30, outQty: out, rolls, gsm: 160, dia: '30"', wastageQty: waste, scrapValue: waste * 40, labourRate: kr, labour: out * kr });
      owe(knitter, out * kr);
      lots.push({ lot, grey: out, rolls, g: k ? I.GRIB : I.GSJ30, c: k ? I.CRIB : I.CSJ30, f: k ? I.FRIB : I.FSJ30 });
    }

    // --- dyeing at the dyeing house; it finishes the single jersey itself and sends the rib to the
    // finishing house (the newest block's second lot stays waiting at the dyeing house, not yet dyed)
    let fgKg = 0;
    const fgLotsHere = [];
    lots.forEach((l, k) => {
      if (last && k === 1) return;
      const [color, dye, per] = COLORS[(b * 2 + k) % COLORS.length];
      const dWaste = 12 + ((b + k) % 3) * 2;
      const dyed = l.grey - dWaste;
      const finisher = k ? 'AF1' : 'AD1', dr = rate('AD1', 'dyeRate'), fr = rate(finisher, 'finRate');
      add('dyeing', 'DYE', { date: day(s0 - 7 - k), location: A('AD1'), outLoc: A(finisher), lotNo: l.lot, inItem: l.g, inQty: l.grey, machine: M.D1, process: proc('Dyeing').id, chemLoc: 'STORE', color, shade: color + ' ' + (per * 100).toFixed(1) + '%', outItem: l.c, outQty: dyed, rolls: l.rolls, wastageQty: dWaste, scrapValue: 0, labourRate: dr, labour: l.grey * dr,
        lines: [[dye, per]].concat(CHEM).map(([code, q]) => ({ item: I[code], lot: '', qty: Math.round(l.grey * q * 100) / 100 })) });
      const fWaste = 6 + ((b + k) % 3) * 2;
      const fg = dyed - fWaste;
      const rolls = Math.round(fg / 23.5);
      // rolls are counted, not weighed (about 23.5 kg each)
      add('finishing', 'FIN', { date: day(s0 - 10 - k), location: A(finisher), lotNo: l.lot, inItem: l.c, inQty: dyed, process: proc('Finishing').id, packLoc: 'STORE', finishType: 'Compacting', quality: 'A', outItem: l.f, outQty: fg, rolls, meters: Math.round(fg * 3.9), wastageQty: fWaste, scrapValue: 0, labourRate: fr, labour: fg * fr,
        lines: [{ item: I.PPOLY, lot: '', qty: rolls }, { item: I.PTUBE, lot: '', qty: rolls }, { item: I.PTAPE, lot: '', qty: 2 }] });
      fgKg += fg;
      owe('AD1', l.grey * dr);
      owe(finisher, fg * fr);
      fgLotsHere.push({ lot: l.lot, kg: fg, item: l.f });
    });

    // --- electricity bill and expenses in the finishing month so they are absorbed
    const ohDate = day(s0 - 10);
    add('powerBills', 'EB', { date: ohDate, provider: 'CESC Ltd', consumerNo: '01 2345 6789', billMonth: ohDate.slice(0, 7), units: 1150 + b * 40, amount: 9800 + b * 400, dueDate: day(s0 - 20), paidOn: ohDate, mode: 'Bank Transfer', toCost: true });
    add('overheads', 'EXP', { date: ohDate, category: 'Rent', amount: 6000, paidTo: 'Factory rent', mode: 'Bank Transfer' });
    add('overheads', 'EXP', { date: ohDate, category: 'Machine Running Cost', amount: 3000 + (b % 3) * 500, paidTo: 'Oil & spares', mode: 'Cash' });
    if (b % 2) add('overheads', 'EXP', { date: ohDate, category: 'Repairs & Maintenance', amount: 2500, paidTo: 'Knit-Tech Services', mode: 'Cash' });
    add('overheads', 'EXP', { date: day(s0 - 12), category: 'Transport', amount: 1800 + (b % 4) * 150, paidTo: 'Sharma Transport', mode: 'Cash' });
    add('overheads', 'EXP', { date: day(s0 - 14), category: 'Telephone / Internet', amount: 1199, paidTo: 'Jio Fiber', mode: 'UPI' });

    // --- sales: Kolkata via order + challan, Sunrise and Odisha direct invoices
    const [la, lb] = [fgLotsHere[0], fgLotsHere[1] || fgLotsHere[0]];
    const growth = 1 + b * 0.03;
    const kgpQty = last ? 320 : Math.min(Math.round(380 * growth), Math.floor(la.kg) - 20); // newest month has only one finished lot
    const prem = it => (it === I.FRIB ? 25 : 0) + (b % 3) * 2;   // rib sells higher; small month-to-month variation
    const so = add('salesOrders', 'SO', { date: day(s0 - 11), party: P.KGP, deliveryDate: day(s0 - 16), status: 'Open', customerPo: 'KGP/PO/' + (700 + b), lines: [{ item: la.item, qty: kgpQty, rate: 400 + b * 2 + prem(la.item), gst: 5 }] });
    const dc = add('deliveries', 'DC', { date: day(s0 - 13), party: P.KGP, soId: so.id, location: 'FG', vehicleNo: 'WB-19-B-55' + (10 + b), lines: [{ item: la.item, lot: la.lot, qty: kgpQty, rate: 400 + b * 2 + prem(la.item) }] });
    const inv1 = add('invoices', 'INV', { date: day(s0 - 13), party: P.KGP, challanId: dc.id, freight: 1200, lines: dc.lines.map(l => ({ item: l.item, lot: l.lot, qty: l.qty, rolls: l.rolls, rate: l.rate, gst: 5 })) });
    const cur = [inv1];
    const sunQty = last ? 180 : Math.min(Math.round(300 * growth), Math.floor(lb.kg) - (lb === la ? kgpQty + 5 : 30));
    const inv2 = add('invoices', 'INV', { date: day(s0 - 17), party: P.SUN, freight: 0, lines: [{ item: lb.item, lot: lb.lot, qty: sunQty, rate: 396 + b * 2 + prem(lb.item), gst: 5 }] });
    cur.push(inv2);
    if (!last) {
      const ehtQty = Math.min(Math.round(170 * growth), Math.floor(lb.kg - sunQty) - 5);
      cur.push(add('invoices', 'INV', { date: day(s0 - 21), party: P.EHT, freight: 1500, lines: [{ item: lb.item, lot: lb.lot, qty: ehtQty, rate: 408 + b * 2 + prem(lb.item), gst: 5 }] }));
      const leftA = Math.floor(la.kg - kgpQty) - 10;          // what remains of lot A goes to a smaller buyer
      if (leftA >= 40) {
        const buyer = b % 2 ? P.BGC : P.MKW;
        cur.push(add('invoices', 'INV', { date: day(s0 - 19), party: buyer, freight: buyer === P.MKW ? 1800 : 600, lines: [{ item: la.item, lot: la.lot, qty: leftA, rate: 412 + b * 2 + prem(la.item), gst: 5 }] }));
      }
    }
    // --- collections: previous block's invoices get paid (Odisha pays 90%)
    for (const inv of openInv.splice(0)) {
      const amt = inv.party === P.EHT ? Math.round(inv.total * 0.9) : inv.total;
      const how = inv.party === P.SUN ? { mode: 'UPI', upi: 'sunrise@okhdfcbank', refNo: String(412055000000 + seq) } : { mode: 'Bank Transfer', transferType: amt > 200000 ? 'RTGS' : 'NEFT', refNo: String(55000 + seq) };
      add('receipts', 'RCT', Object.assign({ date: day(Math.max(0, s0 - 6)), party: inv.party, amount: amt, invoiceId: inv.id }, how));
    }
    openInv.push(...cur);
    void fgKg;
  }
  // one part-payment on the newest Kolkata invoice
  const lastKgp = openInv.find(i => i.party === P.KGP);
  if (lastKgp) add('receipts', 'RCT', { date: day(1), party: P.KGP, amount: 75000, mode: 'Cheque', refNo: '004512', chequeDate: day(1), payBank: 'Axis Bank, Burrabazar' });
  // an open order waiting for dispatch
  add('salesOrders', 'SO', { date: day(2), party: P.SUN, deliveryDate: day(-10), status: 'Open', customerPo: 'SUN/88', lines: [{ item: I.FSJ30, qty: 250, rate: 428, gst: 5 }] });
  add('purchaseOrders', 'PO', { date: day(1), party: P.SSM, deliveryDate: day(-6), status: 'Open', lines: [{ item: I.Y30, qty: 1500, rate: 256, gst: 5 }] });

  // Record on each challan / direct invoice line the rolls it took (the lot's average share), and copy
  // them onto invoices made from a challan, as the screens do.
  const R = engine.compute(data);
  for (const d of data.deliveries.concat(data.invoices.filter(i => !i.challanId))) {
    d.lines.forEach((l, i) => {
      const p = R.salePieces[d.id + '|' + i];
      if (p && Math.abs(p.reduce((t, x) => t + x.kg, 0) - l.qty) < 0.001) { l.rollPick = p; l.rolls = p.length; }
      else if (R.saleRolls[d.id + '|' + i] !== undefined) l.rolls = R.saleRolls[d.id + '|' + i];
    });
  }
  for (const inv of data.invoices.filter(i => i.challanId)) {
    const dc = data.deliveries.find(x => x.id === inv.challanId);
    inv.lines.forEach((l, i) => { const c = dc && dc.lines[i]; if (c) { if (c.rollPick) l.rollPick = c.rollPick; l.rolls = c.rolls; } });
  }

  // --- bank & cash: money not paid in cash went through the current account
  const sbi = add('banks', null, { name: 'SBI Current A/c', type: 'Bank', bankName: 'State Bank of India', accountNo: '30124455667', ifsc: 'SBIN0001234', branch: 'B.T. Road, Kolkata', openingBalance: 4000000, openingDate: day(365) }).id;
  Object.assign(data.banks.find(b => b.id === 'CASH'), { openingBalance: 60000, openingDate: day(365) });
  for (const col of ['receipts', 'payments', 'overheads', 'labourPayments', 'powerBills']) for (const d of data[col]) if (d.mode !== 'Cash' && !d.bank) d.bank = sbi;
  for (let m = 11; m >= 1; m--) add('bankEntries', 'BNK', { date: day(30 * m + 2), kind: 'Cash withdrawal', fromBank: sbi, toBank: 'CASH', amount: 15000, remarks: 'Petty cash' });
  // receipts and payments up to a week ago have cleared in the bank
  for (const col of ['receipts', 'payments', 'overheads', 'powerBills', 'bankEntries']) for (const d of data[col]) if (d.bank === sbi || d.fromBank === sbi) { const dt = d.paidOn || d.date; if (dt <= day(7)) d.clearedOn = dt; }

  // --- a second godown: part of a finished lot moved there
  const g2 = add('locations', null, { id: id(), name: 'Godown 2 (Burrabazar)', type: 'Godown', remarks: 'Customer-ready stock near the market' });
  const R2 = engine.compute(data);
  const qtyOf = k => k.layers.reduce((t, l) => t + l.qty, 0);
  const fgLot = [...R2.keys.values()].filter(k => k.loc === 'FG' && qtyOf(k) > 100 && k.rolls > 4).sort((a, b) => qtyOf(b) - qtyOf(a))[0];
  if (fgLot) {
    const rolls = Math.round(fgLot.rolls / 3), qty = Math.round(qtyOf(fgLot) * rolls / fgLot.rolls * 1000) / 1000;
    add('transfers', 'TRF', { date: day(1), purpose: 'Godown Transfer', fromLoc: 'FG', toLoc: g2.id, person: 'Sunil Mondal', vehicleNo: 'WB-19-C-1020', lines: [{ item: fgLot.item, lot: fgLot.lot, qty, rolls }] });
  }

  // --- processing status of the lot waiting at the dyeing house
  if (lastBatch()) add('jobStatus', 'PS', { date: day(1), location: A('AD1'), lot: lastBatch(), status: 'Processing started', remarks: 'Loaded in the soft flow machine' });

  // --- staff, attendance and salaries
  const E = {};
  for (const [k, name, department, designation, salary, basis] of [['RD', 'Ramesh Das', 'Yarn Department', 'Store keeper', 14000], ['SM', 'Sunil Mondal', 'Godown', 'Godown in-charge', 13000], ['PS', 'Priya Saha', 'Accounts', 'Accountant', 22000],
    ['AG', 'Arup Ghosh', 'Sales', 'Sales executive', 18000], ['BR', 'Bikash Roy', 'Processing', 'Supervisor', 16000], ['ML', 'Mohan Lal', 'Godown', 'Helper', 11000]]) {
    E[k] = add('employees', null, { name, department, designation, salary, basis: basis || 'Monthly', phone: '+91 98000 1' + String(Object.keys(E).length).padStart(4, '0'), joinDate: day(700 + Object.keys(E).length * 30), active: true }).id;
  }
  const lastMonth = (() => { const d = new Date(base); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); })();
  for (let n = 1; n <= 12; n++) {
    const dt = day(n);
    if (new Date(dt + 'T00:00:00Z').getUTCDay() === 0) continue; // Sundays off
    const mark = k => (k === 'ML' && n % 5 === 0) ? 'A' : (k === 'BR' && n === 3) ? 'H' : (k === 'AG' && n === 6) ? 'L' : 'P';
    add('attendance', 'ATT', { date: dt, staff: Object.keys(E).map(k => ({ employee: E[k], mark: mark(k) })) });
  }
  add('salary', 'SAL', { date: lastMonth + '-15', employee: E.ML, kind: 'Advance', amount: 3000, mode: 'Cash', remarks: 'Advance against salary' });
  for (const k of Object.keys(E)) {
    const due = engine.salaryCalc(data, E[k], lastMonth).due;
    const rec = k === 'ML' ? 1000 : 0;
    add('salary', 'SAL', { date: day(1), employee: E[k], kind: 'Salary', month: lastMonth, advanceDeducted: rec, amount: Math.max(0, Math.round(due - rec)), mode: k === 'ML' ? 'Cash' : 'Bank Transfer', bank: k === 'ML' ? 'CASH' : sbi });
  }

  // --- a machinery loan paid by EMI on the 5th
  const first = (() => { const d = new Date(base); d.setDate(5); d.setMonth(d.getMonth() - 9); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-05'; })();
  const loan = add('loans', null, { name: 'HDFC Bank - Machinery Loan', loanNo: 'ML-778210', amount: 800000, rate: 10.5, emi: 18500, tenure: 48, firstEmi: first, bank: sbi, status: 'Active' });
  const today = day(0);
  for (let k = 0; ; k++) {
    const d = new Date(first + 'T00:00:00'); d.setMonth(d.getMonth() + k);
    const dt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-05';
    if (dt > today) break;
    add('emiPayments', 'EMI', { date: dt, loan: loan.id, amount: 18500, forMonth: dt.slice(0, 7), mode: 'Bank Transfer', bank: sbi, refNo: 'ECS ' + (31000 + k), clearedOn: dt <= day(7) ? dt : '' });
  }

  // --- this month's electricity bill, not paid yet
  add('powerBills', 'EB', { date: day(3), provider: 'CESC Ltd', consumerNo: '01 2345 6789', billMonth: today.slice(0, 7), units: 1640, amount: 14650, dueDate: day(-4), toCost: true });

  // --- leads and a quotation
  add('leads', 'LD', { date: day(9), name: 'Kalyani Kids Wear', contactPerson: 'Mr. Bose', phone: '+91 98311 22334', city: 'Kalyani', source: 'Reference', requirement: 'Single jersey 30s', color: 'Assorted', qty: 800, status: 'Quotation sent', assignedTo: 'Arup Ghosh', nextDate: day(0),
    followUps: [{ date: day(9), mode: 'Visit', notes: 'Met the owner, wants samples', nextDate: day(5) }, { date: day(5), mode: 'Call', notes: 'Samples liked, sent the quotation', nextDate: day(0) }] });
  add('leads', 'LD', { date: day(14), name: 'Durgapur Hosiery House', phone: '+91 94340 55667', city: 'Durgapur', source: 'Phone', requirement: '1x1 rib 30s', color: 'Navy Blue', qty: 400, status: 'Contacted', assignedTo: 'Arup Ghosh', nextDate: day(2),
    followUps: [{ date: day(14), mode: 'Call', notes: 'Asked for price list', nextDate: day(2) }] });
  add('leads', 'LD', { date: day(40), name: 'Metro Knit Wear', party: P.MKW, phone: '+91 90000 00006', city: 'Ranchi', source: 'Existing customer', requirement: 'Single jersey 30s', color: 'Red', qty: 300, status: 'Won', assignedTo: 'Arup Ghosh' });
  add('quotations', 'QT', { date: day(5), prospect: 'Kalyani Kids Wear', validTill: day(-10), status: 'Open', lines: [{ item: I.FSJ30, color: 'Assorted', qty: 800, rate: 430, gst: 5 }], terms: '50% advance, balance on delivery. Freight extra.' });
}

module.exports = { ensureBase, loadDemo, hasTransactions, syncAgencies, BASE_LOCATIONS };

if (require.main === module) {
  const db = require('./db');
  db.load();
  ensureBase(db.data);
  if (process.argv.includes('--demo')) {
    try { loadDemo(db.data); db.save(); console.log('Demo data loaded into', db.FILE); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
  } else { db.save(); console.log('Base data ensured in', db.FILE); }
}

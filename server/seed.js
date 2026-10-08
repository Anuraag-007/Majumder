'use strict';
// Base records every installation needs, plus an optional demo data set.
//   node server/seed.js --demo     loads the demo into an empty database
const crypto = require('crypto');
const { hashPassword } = require('./auth');
const engine = require('./engine');

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
  { id: 'operator', name: 'Data Entry (all modules)', description: 'Can enter and edit in every module but cannot delete', perms: Object.assign(ALL('edit'), { dashboard: 'none', rep_costing: 'none', rep_accounts: 'none' }) },
  { id: 'purchase', name: 'Purchase Department', description: 'Raises POs, books supplier bills',
    perms: { masters: 'edit', purchaseOrders: 'full', grn: 'view', purchaseBills: 'full', payments: 'view', rep_purchase: 'view', rep_inventory: 'view' } },
  { id: 'store', name: 'Store / Inventory', description: 'Receives material (GRN), issues yarn, keeps stock',
    perms: { purchaseOrders: 'view', grn: 'full', storeTransfers: 'full', stockAdjust: 'edit', rep_inventory: 'view', rep_purchase: 'view' } },
  { id: 'knitting', name: 'Knitting Department', description: 'Knitting production and grey fabric dispatch to color factory',
    perms: { knitting: 'full', greyTransfer: 'full', rep_production: 'view', rep_inventory: 'view' } },
  { id: 'dyeing', name: 'Dyeing / Color Department', description: 'Dyeing batches and chemical consumption',
    perms: { dyeing: 'full', rep_production: 'view', rep_inventory: 'view' } },
  { id: 'finishing', name: 'Finishing & Packing', description: 'Finishing, packing and finished goods output',
    perms: { finishing: 'full', rep_production: 'view', rep_inventory: 'view' } },
  { id: 'sales', name: 'Sales Department', description: 'Orders, dispatch challans, invoices and customer prices',
    perms: { masters: 'edit', priceList: 'full', salesOrders: 'full', deliveries: 'full', invoices: 'full', receipts: 'view', rep_sales: 'view', rep_inventory: 'view', rep_accounts: 'view' } },
  { id: 'accounts', name: 'Finance & Accounts', description: 'Receipts, payments, bills, overheads, GST and costing',
    perms: { dashboard: 'view', purchaseBills: 'full', payments: 'full', receipts: 'full', invoices: 'view', overheads: 'full', rep_accounts: 'view', rep_purchase: 'view', rep_sales: 'view', rep_costing: 'view', rep_inventory: 'view' } },
];

function ensureBase(data) {
  const stamp = { createdAt: now(), createdBy: 'system' };
  if (!data.roles.length) for (const r of PRESET_ROLES) data.roles.push(Object.assign({}, r, stamp));
  if (!data.users.length) {
    const { salt, hash } = hashPassword('admin123');
    data.users.push(Object.assign({ id: id(), username: 'admin', name: 'Administrator', role: 'admin', active: true, salt, hash }, stamp));
  }
  for (const l of BASE_LOCATIONS) if (!data.locations.some(x => x.id === l.id)) data.locations.push(Object.assign({}, l, stamp, { system: true }));
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

function hasTransactions(data) {
  return engine.STOCK_COLS.concat(['purchaseOrders', 'purchaseBills', 'payments', 'receipts', 'salesOrders', 'overheads']).some(c => data[c].length);
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
  let lotNo = 0;
  const newLot = () => 'L-' + String(++lotNo).padStart(4, '0');
  const openInv = []; // [date, party, total]
  const openBills = [];
  const BLOCKS = 12;
  for (let b = 0; b < BLOCKS; b++) {
    const s0 = 30 * (BLOCKS - b) - 4;          // block start, in days ago (356, 326 ... 26)
    const last = b === BLOCKS - 1;
    const yarnRate = 242 + b * 2 + (b % 2);     // yarn prices drift up a little
    // --- purchase
    const poY = add('purchaseOrders', 'PO', { date: day(s0), party: P.SSM, deliveryDate: day(s0 - 3), status: 'Closed', lines: [{ item: I.Y30, qty: 1250, rate: yarnRate, gst: 5 }] });
    const poC = add('purchaseOrders', 'PO', { date: day(s0), party: P.CTX, status: 'Closed', lines: [{ item: I.DRED, qty: 25, rate: 480, gst: 18 }, { item: I.DBLU, qty: 20, rate: 520, gst: 18 }, { item: I.CSODA, qty: 130, rate: 38, gst: 18 }, { item: I.CSALT, qty: 620, rate: 12, gst: 18 }, { item: I.CSOFT, qty: 26, rate: 160, gst: 18 }] });
    const poP = add('purchaseOrders', 'PO', { date: day(s0), party: P.BPK, status: 'Closed', lines: [{ item: I.PPOLY, qty: 60, rate: 6, gst: 18 }, { item: I.PTUBE, qty: 60, rate: 14, gst: 18 }, { item: I.PTAPE, qty: 6, rate: 35, gst: 18 }] });
    const batch = 'SSM-B' + (b + 1);
    for (const [po, lot] of [[poY, batch], [poC, ''], [poP, '']]) {
      const g = add('grn', 'GRN', { date: day(s0 - 1), party: po.party, poId: po.id, location: 'STORE', challanNo: 'CH-' + (500 + seq), lines: po.lines.map(l => ({ item: l.item, lot, qty: l.qty, rate: l.rate })) });
      const bill = add('purchaseBills', 'PB', { date: day(s0 - 1), billDate: day(s0 - 1), billNo: 'B/' + (900 + seq), party: g.party, grnId: g.id, freight: po === poY ? 2500 : 0, lines: g.lines.map(l => ({ item: l.item, qty: l.qty, rate: l.rate, gst: itemGst(l.item) })) });
      openBills.push(bill);
    }
    // pay last block's bills
    for (const bill of openBills.splice(0, openBills.length - 3)) {
      add('payments', 'PAY', { date: day(s0 - 2), party: bill.party, amount: bill.total, mode: 'Bank Transfer', refNo: 'NEFT ' + (70000 + seq) });
    }

    // --- knitting: two lots of 600 kg
    add('transfers', 'TRF', { date: day(s0 - 2), purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: I.Y30, lot: batch, qty: 1200 }] });
    const lots = [];
    for (let k = 0; k < 2; k++) {
      const lot = newLot();
      const waste = 10 + ((b + k) % 4) * 2;          // 10-16 kg
      const out = 600 - waste - 2;
      const rolls = Math.round(out / 24);
      add('knitting', 'KNT', { date: day(s0 - 3 - k), lotNo: lot, machine: k ? M.K2 : M.K1, process: proc('Knitting').id, location: 'KNIT', shift: k ? 'Night' : 'Day', lines: [{ item: I.Y30, lot: batch, qty: 600 }], outItem: k ? I.GRIB : I.GSJ30, outQty: out, rolls, gsm: 160, dia: '30"', wastageQty: waste, scrapValue: waste * 40, labourRate: 8, labour: out * 8 });
      lots.push({ lot, grey: out, rolls, g: k ? I.GRIB : I.GSJ30, c: k ? I.CRIB : I.CSJ30, f: k ? I.FRIB : I.FSJ30 });
    }
    add('transfers', 'TRF', { date: day(s0 - 5), purpose: 'Grey Transfer', fromLoc: 'KNIT', toLoc: 'DYE', vehicleNo: 'WB-11-A-2231', lines: lots.map(l => ({ item: l.g, lot: l.lot, qty: l.grey, rolls: l.rolls })) });

    // --- dyeing + finishing (the newest block's second lot stays waiting at the color factory)
    let fgKg = 0;
    const fgLotsHere = [];
    lots.forEach((l, k) => {
      if (last && k === 1) return;
      const [color, dye, per] = COLORS[(b * 2 + k) % COLORS.length];
      const dWaste = 12 + ((b + k) % 3) * 2;
      const dyed = l.grey - dWaste;
      add('dyeing', 'DYE', { date: day(s0 - 7 - k), lotNo: l.lot, inItem: l.g, inQty: l.grey, machine: M.D1, process: proc('Dyeing').id, chemLoc: 'STORE', color, shade: color + ' ' + (per * 100).toFixed(1) + '%', outItem: l.c, outLot: l.lot, outQty: dyed, rolls: l.rolls, wastageQty: dWaste, scrapValue: 0, labourRate: 15, labour: l.grey * 15,
        lines: [[dye, per]].concat(CHEM).map(([code, q]) => ({ item: I[code], lot: '', qty: Math.round(l.grey * q * 100) / 100 })) });
      const fWaste = 6 + ((b + k) % 3) * 2;
      const fg = dyed - fWaste;
      const rolls = Math.round(fg / 23.5);
      add('finishing', 'FIN', { date: day(s0 - 10 - k), lotNo: l.lot, inItem: l.c, inQty: dyed, process: proc('Finishing').id, packLoc: 'STORE', finishType: 'Compacting', quality: 'A', outItem: l.f, outLot: l.lot, outQty: fg, rolls, meters: Math.round(fg * 3.9), wastageQty: fWaste, scrapValue: 0, labourRate: 6, labour: fg * 6,
        lines: [{ item: I.PPOLY, lot: '', qty: rolls }, { item: I.PTUBE, lot: '', qty: rolls }, { item: I.PTAPE, lot: '', qty: 2 }] });
      fgKg += fg;
      fgLotsHere.push({ lot: l.lot, kg: fg, item: l.f });
    });

    // --- overheads in the finishing month so they are absorbed
    const ohDate = day(s0 - 10);
    add('overheads', 'OH', { date: ohDate, category: 'Utilities (Power/Water)', amount: 9800 + b * 400, paidTo: 'CESC Ltd', mode: 'Bank Transfer' });
    add('overheads', 'OH', { date: ohDate, category: 'Factory Overheads', amount: 6000, paidTo: 'Factory rent', mode: 'Bank Transfer' });
    add('overheads', 'OH', { date: ohDate, category: 'Machine Running Cost', amount: 3000 + (b % 3) * 500, paidTo: 'Oil & spares', mode: 'Cash' });
    if (b % 2) add('overheads', 'OH', { date: ohDate, category: 'Maintenance', amount: 2500, paidTo: 'Knit-Tech Services', mode: 'Cash' });

    // --- sales: Kolkata via order + challan, Sunrise and Odisha direct invoices
    const [la, lb] = [fgLotsHere[0], fgLotsHere[1] || fgLotsHere[0]];
    const growth = 1 + b * 0.03;
    const kgpQty = last ? 320 : Math.min(Math.round(380 * growth), Math.floor(la.kg) - 20); // newest month has only one finished lot
    const prem = it => (it === I.FRIB ? 25 : 0) + (b % 3) * 2;   // rib sells higher; small month-to-month variation
    const so = add('salesOrders', 'SO', { date: day(s0 - 11), party: P.KGP, deliveryDate: day(s0 - 16), status: 'Open', customerPo: 'KGP/PO/' + (700 + b), lines: [{ item: la.item, qty: kgpQty, rate: 400 + b * 2 + prem(la.item), gst: 5 }] });
    const dc = add('deliveries', 'DC', { date: day(s0 - 13), party: P.KGP, soId: so.id, location: 'FG', vehicleNo: 'WB-19-B-55' + (10 + b), lines: [{ item: la.item, lot: la.lot, qty: kgpQty, rolls: Math.round(kgpQty / 23.5), rate: 400 + b * 2 + prem(la.item) }] });
    const inv1 = add('invoices', 'INV', { date: day(s0 - 13), party: P.KGP, challanId: dc.id, freight: 1200, lines: dc.lines.map(l => ({ item: l.item, lot: l.lot, qty: l.qty, rolls: l.rolls, rate: l.rate, gst: 5 })) });
    const cur = [inv1];
    const sunQty = last ? 180 : Math.min(Math.round(300 * growth), Math.floor(lb.kg) - (lb === la ? kgpQty + 5 : 30));
    const inv2 = add('invoices', 'INV', { date: day(s0 - 17), party: P.SUN, freight: 0, lines: [{ item: lb.item, lot: lb.lot, qty: sunQty, rolls: Math.round(sunQty / 23.5), rate: 396 + b * 2 + prem(lb.item), gst: 5 }] });
    cur.push(inv2);
    if (!last) {
      const ehtQty = Math.min(Math.round(170 * growth), Math.floor(lb.kg - sunQty) - 5);
      cur.push(add('invoices', 'INV', { date: day(s0 - 21), party: P.EHT, freight: 1500, lines: [{ item: lb.item, lot: lb.lot, qty: ehtQty, rolls: Math.round(ehtQty / 23.5), rate: 408 + b * 2 + prem(lb.item), gst: 5 }] }));
      const leftA = Math.floor(la.kg - kgpQty) - 10;          // what remains of lot A goes to a smaller buyer
      if (leftA >= 40) {
        const buyer = b % 2 ? P.BGC : P.MKW;
        cur.push(add('invoices', 'INV', { date: day(s0 - 19), party: buyer, freight: buyer === P.MKW ? 1800 : 600, lines: [{ item: la.item, lot: la.lot, qty: leftA, rolls: Math.round(leftA / 23.5), rate: 412 + b * 2 + prem(la.item), gst: 5 }] }));
      }
    }
    // --- collections: previous block's invoices get paid (Odisha pays 90%)
    for (const inv of openInv.splice(0)) {
      const amt = inv.party === P.EHT ? Math.round(inv.total * 0.9) : inv.total;
      add('receipts', 'RCT', { date: day(Math.max(0, s0 - 6)), party: inv.party, amount: amt, mode: inv.party === P.SUN ? 'UPI' : 'Bank Transfer', refNo: 'UTR ' + (55000 + seq), invoiceId: inv.id });
    }
    openInv.push(...cur);
    void fgKg;
  }
  // one part-payment on the newest Kolkata invoice
  const lastKgp = openInv.find(i => i.party === P.KGP);
  if (lastKgp) add('receipts', 'RCT', { date: day(1), party: P.KGP, amount: 75000, mode: 'Bank Transfer', refNo: 'UTR 99001' });
  // an open order waiting for dispatch
  add('salesOrders', 'SO', { date: day(2), party: P.SUN, deliveryDate: day(-10), status: 'Open', customerPo: 'SUN/88', lines: [{ item: I.FSJ30, qty: 250, rate: 428, gst: 5 }] });
  add('purchaseOrders', 'PO', { date: day(1), party: P.SSM, deliveryDate: day(-6), status: 'Open', lines: [{ item: I.Y30, qty: 1500, rate: 256, gst: 5 }] });
}

module.exports = { ensureBase, loadDemo, hasTransactions, BASE_LOCATIONS };

if (require.main === module) {
  const db = require('./db');
  db.load();
  ensureBase(db.data);
  if (process.argv.includes('--demo')) {
    try { loadDemo(db.data); db.save(); console.log('Demo data loaded into', db.FILE); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
  } else { db.save(); console.log('Base data ensured in', db.FILE); }
}

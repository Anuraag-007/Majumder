'use strict';
/*
 * Business engine.
 *
 * Only master records and documents are stored. Everything else (stock ledger,
 * stock balances, lot costing, wastage, party balances) is DERIVED by replaying
 * all documents in date order. That keeps edits/deletes of old entries exact.
 *
 * Exact costing: every unit of stock carries a cost "vector" split into buckets
 * (yarn, dyes, packing, labour per stage, overhead, wastage). When material moves
 * through knitting -> dyeing -> finishing, its vector moves with it and each stage
 * adds its own labour / chemicals / wastage. The finished lot therefore knows
 * exactly what it cost and why.
 */
const { r2, r3, num, applyTotals, partyIs, STATE_NAMES, checkGstin, levelAtLeast } = require('../public/js/shared');

const BUCKETS = ['yarn', 'dyes', 'packing', 'otherMat', 'knitLabour', 'dyeLabour', 'finLabour', 'overhead', 'wastage'];
const CAT_BUCKET = { 'Yarn': 'yarn', 'Dyes & Chemicals': 'dyes', 'Packing Material': 'packing' };
const STOCK_COLS = ['stockAdjust', 'grn', 'transfers', 'knitting', 'dyeing', 'finishing', 'deliveries', 'invoices'];
const EPS = 1e-6;

const vz = () => { const v = {}; for (const b of BUCKETS) v[b] = 0; return v; };
const vadd = (a, b, k = 1) => { for (const x of BUCKETS) a[x] += (b[x] || 0) * k; return a; };
const vscale = (a, k) => { const v = vz(); for (const x of BUCKETS) v[x] = (a[x] || 0) * k; return v; };
const vsum = a => BUCKETS.reduce((s, x) => s + (a[x] || 0), 0);

const index = arr => { const m = {}; for (const r of arr || []) m[r.id] = r; return m; };
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }; // local date, not UTC
const inRange = (d, q) => (!q.from || d >= q.from) && (!q.to || d <= q.to);
const byDate = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || '');

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

function compute(data) {
  const settings = data.settings || {};
  const method = settings.valuation === 'FIFO' ? 'FIFO' : 'AVG';
  const items = index(data.items);

  const keys = new Map();
  const ledger = [], errors = [], wastage = [], production = [], fgLots = [];
  const unitCost = {};     // "docId|item|lot" -> cost per unit sold (deliveries / direct invoices)
  const rootOf = {};       // any lot -> originating knitting lot
  const lotInfo = {};      // root lot -> trace
  const colorOf = {};      // colored/finished lot -> color

  const K = (item, loc, lot) => {
    const k = item + '|' + loc + '|' + (lot || '');
    let s = keys.get(k);
    if (!s) { s = { key: k, item, loc, lot: lot || '', layers: [], neg: 0, rolls: 0, lastUnit: null }; keys.set(k, s); }
    return s;
  };
  const matVec = (itemId, value) => { const v = vz(); const it = items[itemId]; v[CAT_BUCKET[it && it.category] || 'otherMat'] = value; return v; };

  function stockIn(ev, item, loc, lot, qty, vec, rolls) {
    if (!(qty > EPS) || !item || !loc) return;
    const s = K(item, loc, lot);
    s.rolls += num(rolls);
    s.lastUnit = vscale(vec, 1 / qty);
    let q = qty, v = vec;
    if (s.neg > EPS) { const c = Math.min(s.neg, q); s.neg -= c; v = vscale(vec, (q - c) / q); q -= c; }
    if (q > EPS) {
      if (method === 'AVG' && s.layers.length) { s.layers[0].qty += q; vadd(s.layers[0].vec, v); }
      else s.layers.push({ qty: q, vec: Object.assign({}, v) });
    }
    ledger.push({ date: ev.date, col: ev.col, docId: ev.doc.id, docNo: ev.doc.no, item, loc, lot: lot || '', qin: qty, qout: 0, value: vsum(vec), rolls: num(rolls), party: ev.doc.party || '' });
  }

  function stockOut(ev, item, loc, lot, qty, rolls) {
    const out = vz();
    if (!(qty > EPS) || !item || !loc) return out;
    const s = K(item, loc, lot);
    s.rolls -= num(rolls);
    let need = qty;
    while (need > EPS && s.layers.length) {
      const L = s.layers[0];
      if (L.qty <= need + EPS) { vadd(out, L.vec); need -= L.qty; s.layers.shift(); }
      else { const part = vscale(L.vec, need / L.qty); vadd(out, part); vadd(L.vec, part, -1); L.qty -= need; need = 0; }
    }
    if (need > EPS) {
      errors.push({ key: s.key, date: ev.date, col: ev.col, docId: ev.doc.id, docNo: ev.doc.no, item, loc, lot: lot || '', short: r3(need) });
      if (s.lastUnit) vadd(out, s.lastUnit, need);
      s.neg += need;
    }
    ledger.push({ date: ev.date, col: ev.col, docId: ev.doc.id, docNo: ev.doc.no, item, loc, lot: lot || '', qin: 0, qout: qty, value: -vsum(out), rolls: -num(rolls), party: ev.doc.party || '' });
    return out;
  }

  // Overhead absorption: each month's overheads are spread over the kg finished in that month.
  const fgKgByMonth = {}, ohByMonth = {};
  for (const f of data.finishing || []) { const m = (f.date || '').slice(0, 7); fgKgByMonth[m] = (fgKgByMonth[m] || 0) + num(f.outQty); }
  for (const o of data.overheads || []) { const m = (o.date || '').slice(0, 7); ohByMonth[m] = (ohByMonth[m] || 0) + num(o.amount); }
  const ohRate = m => fgKgByMonth[m] ? (ohByMonth[m] || 0) / fgKgByMonth[m] : 0;

  const trace = root => lotInfo[root] || (lotInfo[root] = { lot: root, knit: [], dye: [], fin: [] });

  // One production stage: material in, (chemicals/packing/labour/overhead) added, good output + wastage out.
  function stage(ev, name, fabricVec, inQ, inItem, labourBucket, addVec, outLoc) {
    const d = ev.doc;
    const outQ = num(d.outQty);
    const wq = Math.min(num(d.wastageQty), inQ);
    const w = inQ > 0 ? wq / inQ : 0;
    const wasteVal = vsum(fabricVec) * w;
    const scrap = num(d.scrapValue);
    const outVec = vscale(fabricVec, 1 - w);
    vadd(outVec, addVec);
    outVec.wastage += wasteVal - scrap;
    outVec[labourBucket] += num(d.labour);
    const outLot = d.outLot || d.lotNo;
    stockIn(ev, d.outItem, outLoc, outLot, outQ, outVec, d.rolls);

    const row = {
      date: d.date, stage: name, col: ev.col, docId: d.id, docNo: d.no, lot: d.lotNo, outLot,
      inItem, outItem: d.outItem, machine: d.machine || '', inQty: inQ, outQty: outQ, rolls: num(d.rolls),
      wastageQty: wq, processLoss: Math.max(0, inQ - outQ - wq), labour: num(d.labour),
      inValue: vsum(fabricVec), addCost: vsum(addVec), outValue: vsum(outVec), vec: outVec, color: d.color || '',
    };
    production.push(row);
    wastage.push({ date: d.date, stage: name, col: ev.col, docId: d.id, docNo: d.no, lot: d.lotNo, item: inItem, inQty: inQ, outQty: outQ, qty: wq, value: wasteVal, scrap, net: wasteVal - scrap });
    return row;
  }

  const evs = [];
  for (const c of STOCK_COLS) for (const d of data[c] || []) evs.push({ col: c, doc: d, date: d.date || '' });
  evs.sort((a, b) => byDate(a.doc, b.doc));

  for (const ev of evs) {
    const d = ev.doc, lines = d.lines || [];
    switch (ev.col) {
      case 'stockAdjust': {
        const loc = d.location || 'STORE';
        for (const l of lines) {
          const q = num(l.qty);
          if (q > 0) stockIn(ev, l.item, loc, l.lot, q, matVec(l.item, q * num(l.rate)), l.rolls);
          else if (q < 0) stockOut(ev, l.item, loc, l.lot, -q, l.rolls);
        }
        break;
      }
      case 'grn': {
        const loc = d.location || 'STORE';
        for (const l of lines) stockIn(ev, l.item, loc, l.lot, num(l.qty), matVec(l.item, num(l.qty) * num(l.rate)), l.rolls);
        break;
      }
      case 'transfers': {
        for (const l of lines) {
          const v = stockOut(ev, l.item, d.fromLoc, l.lot, num(l.qty), l.rolls);
          stockIn(ev, l.item, d.toLoc, l.lot, num(l.qty), v, l.rolls);
        }
        break;
      }
      case 'knitting': {
        const loc = d.location || 'KNIT';
        const cons = vz(); let inQ = 0;
        for (const l of lines) { inQ += num(l.qty); vadd(cons, stockOut(ev, l.item, loc, l.lot, num(l.qty))); }
        const row = stage(ev, 'Knitting', cons, inQ, (lines[0] || {}).item, 'knitLabour', vz(), loc);
        rootOf[row.outLot] = d.lotNo;
        trace(d.lotNo).knit.push(row);
        break;
      }
      case 'dyeing': {
        const inQ = num(d.inQty);
        const fv = stockOut(ev, d.inItem, 'DYE', d.lotNo, inQ);
        const chem = vz();
        for (const l of lines) vadd(chem, stockOut(ev, l.item, d.chemLoc || 'STORE', l.lot, num(l.qty)));
        const row = stage(ev, 'Dyeing', fv, inQ, d.inItem, 'dyeLabour', chem, 'DYE');
        const root = rootOf[d.lotNo] || d.lotNo;
        rootOf[row.outLot] = root;
        colorOf[row.outLot] = d.color || '';
        trace(root).dye.push(row);
        break;
      }
      case 'finishing': {
        const inQ = num(d.inQty);
        const fv = stockOut(ev, d.inItem, 'DYE', d.lotNo, inQ);
        const add = vz();
        for (const l of lines) vadd(add, stockOut(ev, l.item, d.packLoc || 'STORE', l.lot, num(l.qty)));
        add.overhead += ohRate((d.date || '').slice(0, 7)) * num(d.outQty);
        const row = stage(ev, 'Finishing', fv, inQ, d.inItem, 'finLabour', add, 'FG');
        const root = rootOf[d.lotNo] || d.lotNo;
        rootOf[row.outLot] = root;
        colorOf[row.outLot] = colorOf[d.lotNo] || d.color || '';
        trace(root).fin.push(row);
        fgLots.push({ date: d.date, docId: d.id, docNo: d.no, lot: row.outLot, root, item: d.outItem, qty: num(d.outQty), rolls: num(d.rolls), meters: num(d.meters), vec: row.vec, color: colorOf[row.outLot] });
        break;
      }
      case 'deliveries':
      case 'invoices': {
        if (ev.col === 'invoices' && d.challanId) break; // stock already left with the challan
        const loc = d.location || 'FG';
        for (const l of lines) {
          const q = num(l.qty);
          const v = stockOut(ev, l.item, loc, l.lot, q, l.rolls);
          if (q > 0) unitCost[d.id + '|' + l.item + '|' + (l.lot || '')] = vsum(v) / q;
        }
        break;
      }
    }
  }

  return { keys, ledger, errors, wastage, production, fgLots, unitCost, rootOf, lotInfo, colorOf, ohByMonth, fgKgByMonth, method };
}

/* ------------------------------------------------------------------ */
/* Party accounts                                                      */
/* ------------------------------------------------------------------ */

// Returns ledger rows: dr = party owes us / we paid them; cr = we owe / they paid us.
function partyTxns(data) {
  const rows = [];
  for (const p of data.parties || []) {
    const ob = num(p.openingBalance);
    if (ob) rows.push({ date: '', party: p.id, col: 'parties', docId: p.id, docNo: 'Opening', narration: 'Opening balance', dr: p.openingType === 'Cr' ? 0 : ob, cr: p.openingType === 'Cr' ? ob : 0 });
  }
  for (const d of data.invoices || []) rows.push({ date: d.date, party: d.party, col: 'invoices', docId: d.id, docNo: d.no, narration: 'Sales invoice', dr: num(d.total), cr: 0, dueDays: null });
  for (const d of data.receipts || []) rows.push({ date: d.date, party: d.party, col: 'receipts', docId: d.id, docNo: d.no, narration: 'Receipt' + (d.mode ? ' (' + d.mode + ')' : ''), dr: 0, cr: num(d.amount) });
  for (const d of data.purchaseBills || []) rows.push({ date: d.billDate || d.date, party: d.party, col: 'purchaseBills', docId: d.id, docNo: d.no + (d.billNo ? ' / ' + d.billNo : ''), narration: 'Purchase bill', dr: 0, cr: num(d.total) });
  for (const d of data.payments || []) rows.push({ date: d.date, party: d.party, col: 'payments', docId: d.id, docNo: d.no, narration: 'Payment' + (d.mode ? ' (' + d.mode + ')' : ''), dr: num(d.amount), cr: 0 });
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return rows;
}

function partyBalances(data) {
  const bal = {};
  for (const r of partyTxns(data)) bal[r.party] = (bal[r.party] || 0) + r.dr - r.cr;
  return bal;
}

// FIFO-allocates the opposite side against open items to produce ageing.
function ageing(rows, side, asOn) {
  const other = side === 'dr' ? 'cr' : 'dr';
  const open = rows.filter(r => r[side] > 0).map(r => ({ date: r.date, docNo: r.docNo, amt: r[side] }));
  let credit = rows.reduce((s, r) => s + r[other], 0);
  for (const o of open) { const c = Math.min(o.amt, credit); o.amt -= c; credit -= c; }
  const b = { b30: 0, b60: 0, b90: 0, b90p: 0, oldest: null };
  const t = new Date(asOn).getTime();
  for (const o of open) {
    if (o.amt < 0.005) continue;
    const days = o.date ? Math.floor((t - new Date(o.date).getTime()) / 864e5) : 999;
    if (days <= 30) b.b30 += o.amt; else if (days <= 60) b.b60 += o.amt; else if (days <= 90) b.b90 += o.amt; else b.b90p += o.amt;
    if (b.oldest === null || days > b.oldest) b.oldest = days;
  }
  return b;
}

/* ------------------------------------------------------------------ */
/* Save-time helpers                                                   */
/* ------------------------------------------------------------------ */

function prepare(col, doc, data) {
  for (const k of Object.keys(doc)) if (k.startsWith('_')) delete doc[k];
  if (Array.isArray(doc.lines)) {
    doc.lines = doc.lines.filter(l => l && l.item).map(l => { const c = {}; for (const k of Object.keys(l)) if (!k.startsWith('_')) c[k] = l[k]; return c; });
  }
  const party = (data.parties || []).find(p => p.id === doc.party);
  applyTotals(col, doc, data.settings, party);
  return doc;
}

function validate(col, doc, data) {
  const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); };
  const isDoc = col in DOC_LABELS;
  if (isDoc) need(/^\d{4}-\d{2}-\d{2}$/.test(doc.date || ''), 'Date is required');
  const lines = doc.lines || [];
  const posLines = () => { need(lines.length > 0, 'Add at least one line item'); for (const l of lines) need(num(l.qty) > 0, 'Every line needs a quantity greater than zero'); };
  const unique = (field, label) => {
    const v = (doc[field] || '').toString().trim().toLowerCase();
    need(v, label + ' is required');
    need(!(data[col] || []).some(r => r.id !== doc.id && (r[field] || '').toString().trim().toLowerCase() === v), label + ' "' + doc[field] + '" already exists');
  };
  switch (col) {
    case 'items': unique('name', 'Item name'); need(doc.category, 'Category is required'); if (doc.code) unique('code', 'Item code'); break;
    case 'parties': {
      unique('name', 'Party name'); need(doc.type, 'Party type is required');
      if (doc.state) need(STATE_NAMES.includes(doc.state), 'Choose the state from the list');
      if (doc.gstin) doc.gstin = String(doc.gstin).trim().toUpperCase();
      const bad = checkGstin(doc.gstin, doc.state); need(!bad, bad);
      break;
    }
    case 'units': unique('code', 'Unit symbol'); break;
    case 'locations': unique('name', 'Location name'); break;
    case 'machines': unique('code', 'Machine code'); break;
    case 'processes': unique('name', 'Process name'); break;
    case 'boms': unique('name', 'Recipe name'); need(lines.length, 'Add at least one ingredient'); break;
    case 'priceList': need(doc.party && doc.item, 'Party and item are required'); need(num(doc.rate) > 0, 'Rate is required'); break;
    case 'users': doc.username = String(doc.username || '').trim(); need(!/\s/.test(doc.username), 'Username cannot contain spaces'); unique('username', 'Username'); need(doc.role === 'admin' || (data.roles || []).some(r => r.id === doc.role), 'Choose a valid role'); break;
    case 'roles': {
      unique('name', 'Role name');
      const LEVELS = ['none', 'view', 'edit', 'full'];
      const perms = {};
      for (const [k, v] of Object.entries(doc.perms || {})) if (LEVELS.includes(v)) perms[k] = v;
      doc.perms = perms;
      break;
    }
    case 'purchaseOrders': case 'purchaseBills': case 'salesOrders': case 'invoices': case 'deliveries': case 'grn':
      need(doc.party, 'Party is required'); posLines(); break;
    case 'payments': case 'receipts': need(doc.party, 'Party is required'); need(num(doc.amount) > 0, 'Amount must be greater than zero'); break;
    case 'overheads': need(doc.category, 'Category is required'); need(num(doc.amount) > 0, 'Amount must be greater than zero'); break;
    case 'transfers': need(doc.fromLoc && doc.toLoc, 'From and To locations are required'); need(doc.fromLoc !== doc.toLoc, 'From and To locations must differ'); posLines(); break;
    case 'stockAdjust': need(doc.location, 'Location is required'); need(lines.length, 'Add at least one line'); for (const l of lines) need(num(l.qty) !== 0, 'Quantity cannot be zero'); break;
    case 'knitting':
      unique('lotNo', 'Lot number'); posLines();
      need(doc.outItem, 'Output grey fabric item is required'); need(num(doc.outQty) > 0, 'Output quantity is required'); break;
    case 'dyeing': case 'finishing':
      need(doc.inItem && doc.lotNo, 'Input item and lot are required'); need(num(doc.inQty) > 0, 'Input quantity is required');
      need(doc.outItem, 'Output item is required'); need(num(doc.outQty) > 0, 'Output quantity is required');
      for (const l of lines) need(num(l.qty) > 0, 'Every material line needs a quantity');
      break;
  }
  if (['knitting', 'dyeing', 'finishing'].includes(col)) need(num(doc.wastageQty) >= 0, 'Wastage cannot be negative');
}

const DOC_LABELS = {
  purchaseOrders: 'Purchase Order', grn: 'GRN', purchaseBills: 'Purchase Bill', payments: 'Payment',
  transfers: 'Transfer', stockAdjust: 'Stock Adjustment', knitting: 'Knitting', dyeing: 'Dyeing', finishing: 'Finishing',
  overheads: 'Overhead', salesOrders: 'Sales Order', deliveries: 'Delivery Challan', invoices: 'Invoice', receipts: 'Receipt',
};

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

let cache = { version: -1, result: null };
function computed(data, version) {
  if (cache.version !== version) cache = { version, result: compute(data) };
  return cache.result;
}

const C = (k, label, type, sum) => ({ k, label, type: type || 'text', sum: !!sum });

// Report implementations. Each returns { title, columns, rows } or { title, tables: [...] }.
function buildReports(ctx) {
  const { R, data, q, iName, iCat, iUnit, pName, lName, link, docName, stockRows, items, parties, machines } = ctx;

  // Invoice lines in a date range with sale value (ex-GST) and the exact cost of the goods sold.
  function saleLines(range, filter) {
    const deliv = index(data.deliveries);
    const out = [];
    for (const d of data.invoices) {
      if (!inRange(d.date, range) || (filter && filter.party && d.party !== filter.party)) continue;
      const srcId = d.challanId && deliv[d.challanId] ? d.challanId : d.id;
      for (const l of d.lines || []) {
        if (filter && filter.item && l.item !== filter.item) continue;
        let uc = R.unitCost[srcId + '|' + l.item + '|' + (l.lot || '')];
        if (uc === undefined) { // fall back to the lot's production cost
          const f = R.fgLots.filter(x => x.lot === l.lot && x.item === l.item);
          const fq = f.reduce((s, x) => s + x.qty, 0);
          uc = fq ? f.reduce((s, x) => s + vsum(x.vec), 0) / fq : 0;
        }
        // sale value = goods value less its share of the invoice discount (freight recovered is not product margin)
        const goods = num(d.goodsValue) || (d.lines || []).reduce((s, x) => s + num(x.amount), 0);
        const sale = num(l.amount) - (goods ? num(d.discount) * num(l.amount) / goods : 0);
        out.push({ date: d.date, no: d.no, partyId: d.party, party: pName(d.party), item: iName(l.item), lot: l.lot || '', qty: num(l.qty), sale, cost: uc * num(l.qty), _link: link('invoices', d.id) });
      }
    }
    return out;
  }

  // Period helper shared by department analytics: buckets by day (short ranges) or month.
  function periodOf(q) {
    const t = today();
    const to = q.to || t, from = q.from || t.slice(0, 8) + '01';
    const D = s => new Date(s + 'T00:00:00Z');
    const iso = d => d.toISOString().slice(0, 10);
    const days = Math.max(1, Math.round((D(to) - D(from)) / 864e5) + 1);
    const prevTo = iso(new Date(D(from).getTime() - 864e5));
    const prevFrom = iso(new Date(D(from).getTime() - days * 864e5));
    const byDay = days <= 62;
    const keys = [];
    if (byDay) for (let d = D(from); d <= D(to); d = new Date(d.getTime() + 864e5)) keys.push(iso(d));
    else { let y = +from.slice(0, 4), m = +from.slice(5, 7); while (y * 100 + m <= +to.slice(0, 4) * 100 + +to.slice(5, 7)) { keys.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } } }
    const bucketOf = date => byDay ? date : date.slice(0, 7);
    const series = (rows, dateOf, valOf) => {
      const m = {};
      for (const r of rows) { const dt = dateOf(r); if (dt >= from && dt <= to) m[bucketOf(dt)] = (m[bucketOf(dt)] || 0) + valOf(r); }
      return keys.map(k => r3(m[k] || 0));
    };
    return { from, to, prevFrom, prevTo, days, byDay, labels: keys, series, cur: { from, to }, prev: { from: prevFrom, to: prevTo } };
  }

  return {
    stockChoices() {
      const rows = [];
      for (const s of R.keys.values()) {
        const qty = s.layers.reduce((a, l) => a + l.qty, 0) - s.neg;
        if (Math.abs(qty) > EPS) rows.push({ item: s.item, loc: s.loc, lot: s.lot, qty: r3(qty), rolls: s.rolls });
      }
      return { rows };
    },

    stock() {
      const group = q.group || 'lot';
      let rows = stockRows(q.asOn);
      rows = rows.filter(r => (!q.location || r.loc === q.location) && (!q.item || r.item === q.item) && (!q.category || iCat(r.item) === q.category));
      if (group === 'item') {
        const m = new Map();
        for (const r of rows) {
          const k = r.item + '|' + r.loc;
          const s = m.get(k) || { item: r.item, loc: r.loc, lot: '', qty: 0, value: 0, rolls: 0 };
          s.qty += r.qty; s.value += r.value; s.rolls += r.rolls; m.set(k, s);
        }
        rows = [...m.values()];
      }
      if (!q.zero) rows = rows.filter(r => Math.abs(r.qty) > 0.0005);
      const out = rows.map(r => ({
        item: iName(r.item), category: iCat(r.item), location: lName(r.loc), lot: r.lot,
        qty: r3(r.qty), unit: iUnit(r.item), rolls: Math.round(r.rolls), value: r2(r.value), rate: r.qty ? r2(r.value / r.qty) : 0,
        reorder: items[r.item] && num(items[r.item].reorderLevel) && r.qty < num(items[r.item].reorderLevel) ? 'Below reorder' : '',
      })).sort((a, b) => a.location.localeCompare(b.location) || a.item.localeCompare(b.item) || a.lot.localeCompare(b.lot));
      return {
        title: 'Stock Summary' + (q.asOn ? ' as on ' + q.asOn : ''), note: 'Valuation method: ' + (R.method === 'FIFO' ? 'FIFO' : 'Weighted average') + '. Lots are valued at their exact accumulated cost.',
        columns: [C('location', 'Location'), C('item', 'Item'), C('category', 'Category'), C('lot', 'Lot / Batch'), C('qty', 'Qty', 'qty', true), C('unit', 'Unit'), C('rolls', 'Rolls', 'int', true), C('rate', 'Avg Rate', 'money'), C('value', 'Value', 'money', true), C('reorder', 'Alert', 'flag')],
        rows: out,
      };
    },

    stockLedger() {
      if (!q.item) return { title: 'Stock Ledger', note: 'Choose an item to see its ledger.', columns: [], rows: [] };
      const match = r => r.item === q.item && (!q.location || r.loc === q.location) && (!q.lot || r.lot === q.lot);
      let bq = 0, bv = 0;
      const rows = [];
      for (const r of R.ledger) {
        if (!match(r)) continue;
        if (q.from && r.date < q.from) { bq += r.qin - r.qout; bv += r.value; continue; }
        if (q.to && r.date > q.to) continue;
        if (!rows.length) rows.push({ date: q.from || '', doc: 'Opening balance', location: '', lot: '', qin: 0, qout: 0, value: 0, balQty: r3(bq), balValue: r2(bv) });
        bq += r.qin - r.qout; bv += r.value;
        rows.push({ date: r.date, doc: docName(r.col) + ' ' + (r.docNo || ''), party: pName(r.party), location: lName(r.loc), lot: r.lot, qin: r3(r.qin), qout: r3(r.qout), value: r2(r.value), balQty: r3(bq), balValue: r2(bv), _link: link(r.col, r.docId) });
      }
      return {
        title: 'Stock Ledger - ' + iName(q.item),
        columns: [C('date', 'Date', 'date'), C('doc', 'Document'), C('party', 'Party'), C('location', 'Location'), C('lot', 'Lot'), C('qin', 'In', 'qty', true), C('qout', 'Out', 'qty', true), C('value', 'Value +/-', 'money', true), C('balQty', 'Balance Qty', 'qty'), C('balValue', 'Balance Value', 'money')],
        rows,
      };
    },

    production() {
      const rows = R.production.filter(r => inRange(r.date, q) && (!q.stage || r.stage === q.stage)).map(r => ({
        date: r.date, stage: r.stage, doc: r.docNo, lot: r.outLot, inItem: iName(r.inItem), outItem: iName(r.outItem),
        machine: machines[r.machine] ? machines[r.machine].code : '', inQty: r3(r.inQty), outQty: r3(r.outQty), rolls: r.rolls,
        wastageQty: r3(r.wastageQty), wastPct: r.inQty ? r2(r.wastageQty / r.inQty * 100) : 0, processLoss: r3(r.processLoss),
        labour: r2(r.labour), outValue: r2(r.outValue), rate: r.outQty ? r2(r.outValue / r.outQty) : 0, _link: link(r.col, r.docId),
      })).sort((a, b) => a.date.localeCompare(b.date));
      return {
        title: 'Production Report',
        columns: [C('date', 'Date', 'date'), C('stage', 'Stage'), C('doc', 'Entry No'), C('lot', 'Lot'), C('inItem', 'Input'), C('outItem', 'Output'), C('machine', 'Machine'), C('inQty', 'Input Kg', 'qty', true), C('outQty', 'Output Kg', 'qty', true), C('rolls', 'Rolls', 'int', true), C('wastageQty', 'Wastage Kg', 'qty', true), C('wastPct', 'Wastage %', 'pct'), C('processLoss', 'Process Loss Kg', 'qty', true), C('labour', 'Labour', 'money', true), C('outValue', 'Output Value', 'money', true), C('rate', 'Cost/Kg', 'money')],
        rows,
      };
    },

    wastage() {
      const list = R.wastage.filter(r => inRange(r.date, q) && (!q.stage || r.stage === q.stage));
      const by = {};
      for (const r of list) {
        const s = by[r.stage] || (by[r.stage] = { stage: r.stage, inQty: 0, qty: 0, value: 0, scrap: 0, net: 0 });
        s.inQty += r.inQty; s.qty += r.qty; s.value += r.value; s.scrap += r.scrap; s.net += r.net;
      }
      const summary = ['Knitting', 'Dyeing', 'Finishing'].filter(s => by[s]).map(s => {
        const x = by[s];
        return { stage: s, inQty: r3(x.inQty), qty: r3(x.qty), pct: x.inQty ? r2(x.qty / x.inQty * 100) : 0, value: r2(x.value), scrap: r2(x.scrap), net: r2(x.net) };
      });
      const cols = [C('inQty', 'Input Kg', 'qty', true), C('qty', 'Wastage Kg', 'qty', true), C('pct', 'Wastage %', 'pct'), C('value', 'Wastage Value', 'money', true), C('scrap', 'Scrap Recovery', 'money', true), C('net', 'Net Wastage Cost', 'money', true)];
      return {
        title: 'Wastage Report',
        tables: [
          { title: 'By stage', columns: [C('stage', 'Stage')].concat(cols), rows: summary },
          {
            title: 'Wastage entries', columns: [C('date', 'Date', 'date'), C('stage', 'Stage'), C('doc', 'Entry No'), C('lot', 'Lot'), C('item', 'Material')].concat(cols),
            rows: list.map(r => ({ date: r.date, stage: r.stage, doc: r.docNo, lot: r.lot, item: iName(r.item), inQty: r3(r.inQty), qty: r3(r.qty), pct: r.inQty ? r2(r.qty / r.inQty * 100) : 0, value: r2(r.value), scrap: r2(r.scrap), net: r2(r.net), _link: link(r.col, r.docId) })),
          },
        ],
      };
    },

    costing() {
      const m = new Map();
      for (const f of R.fgLots) {
        if (!inRange(f.date, q) || (q.item && f.item !== q.item)) continue;
        const k = f.item + '|' + f.lot;
        const s = m.get(k) || { date: f.date, lot: f.lot, root: f.root, item: f.item, color: f.color, qty: 0, rolls: 0, meters: 0, vec: vz(), docs: [] };
        s.qty += f.qty; s.rolls += f.rolls; s.meters += f.meters; vadd(s.vec, f.vec); s.docs.push(f.docNo); m.set(k, s);
      }
      const rows = [...m.values()].sort((a, b) => a.date.localeCompare(b.date)).map(s => {
        const v = s.vec, total = vsum(v);
        return {
          date: s.date, lot: s.lot, item: iName(s.item), color: s.color, qty: r3(s.qty), rolls: s.rolls,
          yarn: r2(v.yarn), dyes: r2(v.dyes), packing: r2(v.packing + v.otherMat),
          rm: r2(v.yarn + v.dyes + v.packing + v.otherMat), labour: r2(v.knitLabour + v.dyeLabour + v.finLabour),
          knitLabour: r2(v.knitLabour), dyeLabour: r2(v.dyeLabour), finLabour: r2(v.finLabour),
          overhead: r2(v.overhead), wastage: r2(v.wastage), total: r2(total),
          perKg: s.qty ? r2(total / s.qty) : 0, perRoll: s.rolls ? r2(total / s.rolls) : 0, perMeter: s.meters ? r2(total / s.meters) : 0,
        };
      });
      return {
        title: 'Manufacturing Costing - Lot wise (Exact Costing)',
        note: 'Total = Raw material (yarn + dyes & chemicals + packing) + Direct labour (knitting + dyeing + finishing) + Overheads + Wastage. Overheads are absorbed per kg finished in the same month.',
        columns: [C('date', 'Finished', 'date'), C('lot', 'Lot'), C('item', 'Item'), C('color', 'Color'), C('qty', 'FG Kg', 'qty', true), C('rolls', 'Rolls', 'int', true),
          C('yarn', 'Yarn', 'money', true), C('dyes', 'Dyes & Chem', 'money', true), C('packing', 'Packing', 'money', true),
          C('knitLabour', 'Knit Labour', 'money', true), C('dyeLabour', 'Dye Labour', 'money', true), C('finLabour', 'Finish Labour', 'money', true),
          C('overhead', 'Overhead', 'money', true), C('wastage', 'Wastage', 'money', true), C('total', 'Total Cost', 'money', true),
          C('perKg', 'Cost / Kg', 'money'), C('perRoll', 'Cost / Roll', 'money'), C('perMeter', 'Cost / Mtr', 'money')],
        rows,
      };
    },

    itemCosting() {
      const m = new Map();
      for (const f of R.fgLots) {
        if (!inRange(f.date, q)) continue;
        const s = m.get(f.item) || { item: f.item, qty: 0, rolls: 0, lots: 0, vec: vz() };
        s.qty += f.qty; s.rolls += f.rolls; s.lots++; vadd(s.vec, f.vec); m.set(f.item, s);
      }
      const rows = [...m.values()].map(s => {
        const v = s.vec, k = s.qty || 1;
        return {
          item: iName(s.item), lots: s.lots, qty: r3(s.qty), rolls: s.rolls,
          rmKg: r2((v.yarn + v.dyes + v.packing + v.otherMat) / k), labourKg: r2((v.knitLabour + v.dyeLabour + v.finLabour) / k),
          ohKg: r2(v.overhead / k), wastKg: r2(v.wastage / k), totalKg: r2(vsum(v) / k), total: r2(vsum(v)),
        };
      });
      return {
        title: 'Item-wise Costing',
        columns: [C('item', 'Item'), C('lots', 'Lots', 'int', true), C('qty', 'FG Kg', 'qty', true), C('rolls', 'Rolls', 'int', true), C('rmKg', 'Material / Kg', 'money'), C('labourKg', 'Labour / Kg', 'money'), C('ohKg', 'Overhead / Kg', 'money'), C('wastKg', 'Wastage / Kg', 'money'), C('totalKg', 'Cost / Kg', 'money'), C('total', 'Total Cost', 'money', true)],
        rows,
      };
    },

    lots() {
      const fgSold = {}, fgIn = {};
      for (const r of R.ledger) {
        if (r.loc !== 'FG' || !r.lot) continue;
        if (r.col === 'deliveries' || r.col === 'invoices') fgSold[r.lot] = (fgSold[r.lot] || 0) + r.qout;
        fgIn[r.lot] = (fgIn[r.lot] || 0) + r.qin - r.qout;
      }
      const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
      const rows = Object.values(R.lotInfo).filter(t => !q.lot || t.lot.toLowerCase().includes(q.lot.toLowerCase())).map(t => {
        const k = t.knit, d = t.dye, f = t.fin;
        const fgLotsOf = [...new Set(f.map(x => x.outLot))];
        const yarn = sum(k, 'inQty'), fg = sum(f, 'outQty');
        const sold = fgLotsOf.reduce((s, l) => s + (fgSold[l] || 0), 0);
        const inStock = fgLotsOf.reduce((s, l) => s + (fgIn[l] || 0), 0);
        let status = 'Knitted';
        if (d.length) status = 'Dyed';
        if (f.length) status = 'Finished';
        if (f.length && inStock < 0.001) status = 'Sold out';
        const first = a => a.length ? a[0].date : '';
        return {
          lot: t.lot, status, knitDate: first(k), yarnIn: r3(yarn), greyOut: r3(sum(k, 'outQty')), knitWaste: r3(sum(k, 'wastageQty')),
          dyeDate: first(d), color: d.map(x => x.color).filter(Boolean).join(', '), dyeIn: r3(sum(d, 'inQty')), dyeOut: r3(sum(d, 'outQty')), dyeWaste: r3(sum(d, 'wastageQty')),
          finDate: first(f), finIn: r3(sum(f, 'inQty')), fgOut: r3(fg), finWaste: r3(sum(f, 'wastageQty')),
          yieldPct: yarn && fg ? r2(fg / yarn * 100) : 0, sold: r3(sold), inStock: r3(inStock),
        };
      }).sort((a, b) => (b.knitDate || '').localeCompare(a.knitDate || ''));
      return {
        title: 'Batch / Lot Tracking',
        note: 'Follows each knitting lot through dyeing and finishing to sales. Yield = finished kg / yarn kg.',
        columns: [C('lot', 'Lot'), C('status', 'Status', 'flag'), C('knitDate', 'Knitted', 'date'), C('yarnIn', 'Yarn Kg', 'qty', true), C('greyOut', 'Grey Kg', 'qty', true), C('knitWaste', 'Knit Waste', 'qty', true),
          C('dyeDate', 'Dyed', 'date'), C('color', 'Color'), C('dyeIn', 'Dye In', 'qty', true), C('dyeOut', 'Dyed Kg', 'qty', true), C('dyeWaste', 'Dye Waste', 'qty', true),
          C('finDate', 'Finished', 'date'), C('finIn', 'Finish In', 'qty', true), C('fgOut', 'FG Kg', 'qty', true), C('finWaste', 'Finish Waste', 'qty', true),
          C('yieldPct', 'Yield %', 'pct'), C('sold', 'Sold Kg', 'qty', true), C('inStock', 'FG Stock Kg', 'qty', true)],
        rows,
      };
    },

    purchase() {
      const rows = data.purchaseBills.filter(d => inRange(d.date, q) && (!q.party || d.party === q.party)).sort(byDate).map(d => ({
        date: d.date, no: d.no, billNo: d.billNo || '', party: pName(d.party), goods: num(d.goodsValue !== undefined ? d.goodsValue : d.taxable), charges: r2(num(d.freight) + num(d.otherCharges) - num(d.discount)), taxable: num(d.taxable), cgst: num(d.cgst), sgst: num(d.sgst), igst: num(d.igst), roundOff: num(d.roundOff), total: num(d.total), _link: link('purchaseBills', d.id),
      }));
      const itemRows = [];
      const m = new Map();
      for (const d of data.grn) {
        if (!inRange(d.date, q) || (q.party && d.party !== q.party)) continue;
        for (const l of d.lines || []) {
          if (q.item && l.item !== q.item) continue;
          const s = m.get(l.item) || { item: iName(l.item), category: iCat(l.item), qty: 0, amount: 0, unit: iUnit(l.item) };
          s.qty += num(l.qty); s.amount += num(l.qty) * num(l.rate); m.set(l.item, s);
        }
      }
      for (const s of m.values()) itemRows.push({ item: s.item, category: s.category, qty: r3(s.qty), unit: s.unit, amount: r2(s.amount), rate: s.qty ? r2(s.amount / s.qty) : 0 });
      return {
        title: 'Purchase Report',
        tables: [
          { title: 'Purchase register (bills)', columns: [C('date', 'Date', 'date'), C('no', 'Entry No'), C('billNo', 'Supplier Bill'), C('party', 'Supplier'), C('goods', 'Goods', 'money', true), C('charges', 'Freight/Other', 'money', true), C('taxable', 'Taxable', 'money', true), C('cgst', 'CGST', 'money', true), C('sgst', 'SGST', 'money', true), C('igst', 'IGST', 'money', true), C('roundOff', 'Round off', 'money', true), C('total', 'Total', 'money', true)], rows },
          { title: 'Item-wise receipts (GRN)', columns: [C('item', 'Item'), C('category', 'Category'), C('qty', 'Qty', 'qty', true), C('unit', 'Unit'), C('rate', 'Avg Rate', 'money'), C('amount', 'Amount', 'money', true)], rows: itemRows },
        ],
      };
    },

    poPending() {
      const recd = {};
      for (const g of data.grn) if (g.poId) for (const l of g.lines || []) { const k = g.poId + '|' + l.item; recd[k] = (recd[k] || 0) + num(l.qty); }
      const rows = [];
      for (const po of data.purchaseOrders) {
        if (q.party && po.party !== q.party) continue;
        for (const l of po.lines || []) {
          const r = recd[po.id + '|' + l.item] || 0, pend = num(l.qty) - r;
          if (!q.all && pend <= 0.0005) continue;
          rows.push({ date: po.date, no: po.no, party: pName(po.party), item: iName(l.item), ordered: r3(num(l.qty)), received: r3(r), pending: r3(Math.max(0, pend)), rate: num(l.rate), pendingValue: r2(Math.max(0, pend) * num(l.rate)), status: po.status || 'Open', _link: link('purchaseOrders', po.id) });
        }
      }
      return { title: 'Pending Purchase Orders', columns: [C('date', 'PO Date', 'date'), C('no', 'PO No'), C('party', 'Supplier'), C('item', 'Item'), C('ordered', 'Ordered', 'qty', true), C('received', 'Received', 'qty', true), C('pending', 'Pending', 'qty', true), C('rate', 'Rate', 'money'), C('pendingValue', 'Pending Value', 'money', true), C('status', 'Status', 'flag')], rows };
    },

    sales() {
      const inv = data.invoices.filter(d => inRange(d.date, q) && (!q.party || d.party === q.party)).sort(byDate);
      const rows = inv.map(d => ({ date: d.date, no: d.no, party: pName(d.party), qty: r3((d.lines || []).reduce((s, l) => s + num(l.qty), 0)), gstin: (parties[d.party] || {}).gstin || 'Unregistered', pos: d.placeOfSupply || (parties[d.party] || {}).state || '', goods: num(d.goodsValue !== undefined ? d.goodsValue : d.taxable), charges: r2(num(d.freight) + num(d.otherCharges) - num(d.discount)), taxable: num(d.taxable), cgst: num(d.cgst), sgst: num(d.sgst), igst: num(d.igst), roundOff: num(d.roundOff), total: num(d.total), _link: link('invoices', d.id) }));
      const m = new Map();
      for (const d of inv) for (const l of d.lines || []) {
        if (q.item && l.item !== q.item) continue;
        const s = m.get(l.item) || { item: iName(l.item), qty: 0, rolls: 0, amount: 0 };
        s.qty += num(l.qty); s.rolls += num(l.rolls); s.amount += num(l.amount); m.set(l.item, s);
      }
      const itemRows = [...m.values()].map(s => ({ item: s.item, qty: r3(s.qty), rolls: s.rolls, amount: r2(s.amount), rate: s.qty ? r2(s.amount / s.qty) : 0 }));
      return {
        title: 'Sales Report',
        tables: [
          { title: 'Sales register', columns: [C('date', 'Date', 'date'), C('no', 'Invoice No'), C('party', 'Customer'), C('gstin', 'GSTIN'), C('pos', 'Place of supply'), C('qty', 'Qty Kg', 'qty', true), C('goods', 'Goods', 'money', true), C('charges', 'Freight/Other', 'money', true), C('taxable', 'Taxable', 'money', true), C('cgst', 'CGST', 'money', true), C('sgst', 'SGST', 'money', true), C('igst', 'IGST', 'money', true), C('roundOff', 'Round off', 'money', true), C('total', 'Total', 'money', true)], rows },
          { title: 'Item-wise sales', columns: [C('item', 'Item'), C('qty', 'Qty Kg', 'qty', true), C('rolls', 'Rolls', 'int', true), C('rate', 'Avg Rate', 'money'), C('amount', 'Taxable Value', 'money', true)], rows: itemRows },
        ],
      };
    },

    soPending() {
      const sent = {};
      for (const c of data.deliveries) if (c.soId) for (const l of c.lines || []) { const k = c.soId + '|' + l.item; sent[k] = (sent[k] || 0) + num(l.qty); }
      const rows = [];
      for (const so of data.salesOrders) {
        if (q.party && so.party !== q.party) continue;
        for (const l of so.lines || []) {
          const s = sent[so.id + '|' + l.item] || 0, pend = num(l.qty) - s;
          if (!q.all && pend <= 0.0005) continue;
          rows.push({ date: so.date, no: so.no, party: pName(so.party), item: iName(l.item), ordered: r3(num(l.qty)), dispatched: r3(s), pending: r3(Math.max(0, pend)), deliveryDate: so.deliveryDate || '', status: so.status || 'Open', _link: link('salesOrders', so.id) });
        }
      }
      return { title: 'Pending Sales Orders', columns: [C('date', 'SO Date', 'date'), C('no', 'SO No'), C('party', 'Customer'), C('item', 'Item'), C('ordered', 'Ordered', 'qty', true), C('dispatched', 'Dispatched', 'qty', true), C('pending', 'Pending', 'qty', true), C('deliveryDate', 'Due', 'date'), C('status', 'Status', 'flag')], rows };
    },

    outstanding() {
      const type = q.type === 'payable' ? 'payable' : 'receivable';
      const asOn = q.asOn || today();
      const txns = partyTxns(data).filter(r => !r.date || r.date <= asOn);
      const byParty = {};
      for (const r of txns) (byParty[r.party] = byParty[r.party] || []).push(r);
      const rows = [];
      for (const pid of Object.keys(byParty)) {
        const p = parties[pid]; if (!p) continue;
        const list = byParty[pid];
        const bal = list.reduce((s, r) => s + r.dr - r.cr, 0);
        if (type === 'receivable' && bal <= 0.005) continue;
        if (type === 'payable' && bal >= -0.005) continue;
        const a = ageing(list, type === 'receivable' ? 'dr' : 'cr', asOn);
        const amt = Math.abs(bal);
        const limit = num(p.creditLimit), cdays = num(p.creditDays);
        rows.push({
          party: p.name, phone: p.phone || '', balance: r2(amt), b30: r2(a.b30), b60: r2(a.b60), b90: r2(a.b90), b90p: r2(a.b90p),
          oldest: a.oldest === null ? '' : a.oldest, creditLimit: limit, creditDays: cdays,
          alert: type === 'receivable' ? [limit && amt > limit ? 'Over limit' : '', cdays && a.oldest > cdays ? 'Overdue' : ''].filter(Boolean).join(', ') : '',
          _link: '#/report/partyLedger?party=' + pid,
        });
      }
      rows.sort((a, b) => b.balance - a.balance);
      const cols = [C('party', type === 'receivable' ? 'Customer' : 'Supplier'), C('phone', 'Phone'), C('balance', type === 'receivable' ? 'Receivable' : 'Payable', 'money', true), C('b30', '0-30 days', 'money', true), C('b60', '31-60', 'money', true), C('b90', '61-90', 'money', true), C('b90p', '90+ days', 'money', true), C('oldest', 'Oldest (days)', 'int')];
      if (type === 'receivable') cols.push(C('creditLimit', 'Credit Limit', 'money'), C('creditDays', 'Credit Days', 'int'), C('alert', 'Alert', 'flag'));
      return { title: type === 'receivable' ? 'Outstanding Receivables' : 'Outstanding Payables', note: 'Ageing assumes payments settle the oldest bills first.', columns: cols, rows };
    },

    partyLedger() {
      if (!q.party) return { title: 'Party Ledger', note: 'Choose a party to see its ledger.', columns: [], rows: [] };
      let bal = 0; const rows = [];
      for (const r of partyTxns(data).filter(r => r.party === q.party)) {
        if (q.from && r.date && r.date < q.from) { bal += r.dr - r.cr; continue; }
        if (q.to && r.date > q.to) continue;
        if (!rows.length && q.from) rows.push({ date: q.from, doc: '', narration: 'Opening balance', dr: 0, cr: 0, balance: r2(Math.abs(bal)), drcr: bal >= 0 ? 'Dr' : 'Cr' });
        bal += r.dr - r.cr;
        rows.push({ date: r.date, doc: r.docNo, narration: r.narration, dr: r2(r.dr), cr: r2(r.cr), balance: r2(Math.abs(bal)), drcr: bal >= 0 ? 'Dr' : 'Cr', _link: r.col === 'parties' ? '' : link(r.col, r.docId) });
      }
      return {
        title: 'Party Ledger - ' + pName(q.party),
        note: 'Dr balance = party owes us. Cr balance = we owe the party.',
        columns: [C('date', 'Date', 'date'), C('doc', 'Document'), C('narration', 'Particulars'), C('dr', 'Debit', 'money', true), C('cr', 'Credit', 'money', true), C('balance', 'Balance', 'money'), C('drcr', '', 'text')],
        rows,
      };
    },

    profitability() {
      const lines = saleLines(q, q).map(l => { const c = Object.assign({}, l); delete c.partyId; return c; });
      const fin = r => Object.assign(r, { qty: r3(r.qty), sale: r2(r.sale), cost: r2(r.cost), profit: r2(r.sale - r.cost), margin: r.sale ? r2((r.sale - r.cost) / r.sale * 100) : 0 });
      const g = q.groupBy;
      if (g === 'party' || g === 'item' || g === 'lot') {
        const m = new Map();
        for (const l of lines) { const s = m.get(l[g]) || { [g]: l[g], qty: 0, sale: 0, cost: 0 }; s.qty += l.qty; s.sale += l.sale; s.cost += l.cost; m.set(l[g], s); }
        const rows = [...m.values()].map(fin).sort((a, b) => b.profit - a.profit);
        const label = { party: 'Customer', item: 'Item', lot: 'Lot' }[g];
        return { title: 'Profitability by ' + label, columns: [C(g, label), C('qty', 'Qty Kg', 'qty', true), C('sale', 'Sale Value', 'money', true), C('cost', 'Cost', 'money', true), C('profit', 'Profit', 'money', true), C('margin', 'Margin %', 'pct')], rows };
      }
      return {
        title: 'Profitability Report', note: 'Sale value excludes GST. Cost is the exact lot cost of the goods dispatched.',
        columns: [C('date', 'Date', 'date'), C('no', 'Invoice'), C('party', 'Customer'), C('item', 'Item'), C('lot', 'Lot'), C('qty', 'Qty Kg', 'qty', true), C('sale', 'Sale Value', 'money', true), C('cost', 'Cost', 'money', true), C('profit', 'Profit', 'money', true), C('margin', 'Margin %', 'pct')],
        rows: lines.map(fin),
      };
    },

    gst() {
      const m = {};
      const get = k => m[k] || (m[k] = { month: k, outTaxable: 0, outCgst: 0, outSgst: 0, outIgst: 0, inTaxable: 0, inCgst: 0, inSgst: 0, inIgst: 0 });
      for (const d of data.invoices) if (inRange(d.date, q)) { const s = get(d.date.slice(0, 7)); s.outTaxable += num(d.taxable); s.outCgst += num(d.cgst); s.outSgst += num(d.sgst); s.outIgst += num(d.igst); }
      for (const d of data.purchaseBills) if (inRange(d.date, q)) { const s = get(d.date.slice(0, 7)); s.inTaxable += num(d.taxable); s.inCgst += num(d.cgst); s.inSgst += num(d.sgst); s.inIgst += num(d.igst); }
      const rows = Object.values(m).sort((a, b) => a.month.localeCompare(b.month)).map(s => {
        const o = {}; for (const k of Object.keys(s)) o[k] = k === 'month' ? s[k] : r2(s[k]);
        o.net = r2(s.outCgst + s.outSgst + s.outIgst - s.inCgst - s.inSgst - s.inIgst);
        return o;
      });
      return { title: 'GST Summary', note: 'Net = output tax on sales minus input tax credit on purchases. Positive means payable.', columns: [C('month', 'Month'), C('outTaxable', 'Sales Taxable', 'money', true), C('outCgst', 'Out CGST', 'money', true), C('outSgst', 'Out SGST', 'money', true), C('outIgst', 'Out IGST', 'money', true), C('inTaxable', 'Purchase Taxable', 'money', true), C('inCgst', 'In CGST', 'money', true), C('inSgst', 'In SGST', 'money', true), C('inIgst', 'In IGST', 'money', true), C('net', 'Net GST', 'money', true)], rows };
    },

    overheads() {
      const months = new Set([...Object.keys(R.ohByMonth), ...Object.keys(R.fgKgByMonth)]);
      const cats = {};
      for (const o of data.overheads) { const k = o.date.slice(0, 7) + '|' + o.category; cats[k] = (cats[k] || 0) + num(o.amount); }
      const rows = [...months].filter(mo => (!q.from || mo >= q.from.slice(0, 7)) && (!q.to || mo <= q.to.slice(0, 7))).sort().map(mo => {
        const total = R.ohByMonth[mo] || 0, kg = R.fgKgByMonth[mo] || 0;
        return {
          month: mo, factory: r2(cats[mo + '|Factory Overheads'] || 0), utilities: r2(cats[mo + '|Utilities (Power/Water)'] || 0), machine: r2(cats[mo + '|Machine Running Cost'] || 0),
          maintenance: r2(cats[mo + '|Maintenance'] || 0), other: r2(cats[mo + '|Other'] || 0), total: r2(total), kg: r3(kg), rate: kg ? r2(total / kg) : 0, unabsorbed: kg ? 0 : r2(total),
        };
      });
      return { title: 'Overhead Absorption', note: 'Overheads for a month are charged to lots finished in that month (per kg). If nothing was finished, the overhead stays unabsorbed.', columns: [C('month', 'Month'), C('factory', 'Factory', 'money', true), C('utilities', 'Power/Water', 'money', true), C('machine', 'Machine Running', 'money', true), C('maintenance', 'Maintenance', 'money', true), C('other', 'Other', 'money', true), C('total', 'Total', 'money', true), C('kg', 'FG Kg', 'qty', true), C('rate', 'Rate / Kg', 'money'), C('unabsorbed', 'Unabsorbed', 'money', true)], rows };
    },

    negativeStock() {
      return {
        title: 'Stock Exceptions',
        columns: [C('date', 'Date', 'date'), C('doc', 'Document'), C('item', 'Item'), C('location', 'Location'), C('lot', 'Lot'), C('short', 'Short Qty', 'qty')],
        rows: R.errors.map(e => ({ date: e.date, doc: docName(e.col) + ' ' + (e.docNo || ''), item: iName(e.item), location: lName(e.loc), lot: e.lot, short: e.short, _link: link(e.col, e.docId) })),
      };
    },

    partyBalance() {
      const bal = partyBalances(data);
      return { balance: r2(bal[q.party] || 0) };
    },

    nextLot() {
      let max = 0;
      for (const k of data.knitting) { const m = /(\d+)\s*$/.exec(k.lotNo || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
      return { lot: 'L-' + String(max + 1).padStart(4, '0') };
    },

    // Department analytics: only the sections the signed-in user's role may view.
    deptDashboard() {
      const perms = ctx.perms || {};
      const can = a => levelAtLeast(perms[a], 'view');
      const P = periodOf(q);
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const kgUnit = id => (iUnit(id) || '').toLowerCase() === 'kg';
      const inP = (col, range) => data[col].filter(d => inRange(d.date, range));
      const latest = (col, map) => inP(col, P.cur).sort(byDate).reverse().slice(0, 8).map(map);
      const stockAt = (loc, cat) => stockRows().filter(s => s.loc === loc && (!cat || iCat(s.item) === cat) && s.qty > 0.0005);
      const kpi = (label, value, prev, unit, good, spark, prevActive) => ({
        label, unit, good: good === undefined ? null : good, spark: spark || null,
        value: unit === 'pct' ? r2(value) : unit === 'money' ? r2(value) : r3(value),
        prev: prev === null ? null : unit === 'pct' ? r2(prev) : r3(prev),
        prevActive: prevActive === undefined ? !!prev : !!prevActive,
      });
      const byLabel = (rows, top) => rows.filter(r => Math.abs(r.value) > 0.0005).sort((a, b) => b.value - a.value).slice(0, top || 8);
      const sections = [];

      if (can('knitting')) {
        const fig = r => { const k = inP('knitting', r); const yarn = sum(k, d => sum(d.lines || [], l => num(l.qty))); return { k, yarn, grey: sum(k, d => num(d.outQty)), w: sum(k, d => num(d.wastageQty)), rolls: sum(k, d => num(d.rolls)) }; };
        const c = fig(P.cur), p = fig(P.prev);
        const byM = {};
        for (const d of c.k) { const m = machines[d.machine]; const key = m ? m.code + ' · ' + m.name : 'No machine'; byM[key] = (byM[key] || 0) + num(d.outQty); }
        const greyS = P.series(data.knitting, d => d.date, d => num(d.outQty));
        sections.push({
          key: 'knitting', title: 'Knitting', icon: 'yarn', link: '#/list/knitting',
          kpis: [kpi('Grey knitted', c.grey, p.grey, 'kg', true, greyS), kpi('Yarn used', c.yarn, p.yarn, 'kg'),
            kpi('Wastage', c.yarn ? c.w / c.yarn * 100 : 0, p.yarn ? p.w / p.yarn * 100 : 0, 'pct', false, null, p.k.length > 0),
            kpi('Lots knitted', c.k.length, p.k.length, 'int', true), kpi('Rolls', c.rolls, p.rolls, 'int', true)],
          trend: { title: 'Knitting output', sub: 'kg per ' + (P.byDay ? 'day' : 'month'), unit: 'kg', series: [{ name: 'Grey knitted', values: greyS }, { name: 'Yarn used', values: P.series(data.knitting, d => d.date, d => sum(d.lines || [], l => num(l.qty))) }] },
          bars: [
            { title: 'Output by machine', sub: 'Grey kg in the period', unit: 'kg', rows: byLabel(Object.entries(byM).map(([label, value]) => ({ label, value: r3(value) }))) },
            { title: 'Yarn at knitting factory', sub: 'Right now, by lot', unit: 'kg', rows: byLabel(stockAt('KNIT', 'Yarn').map(s => ({ label: iName(s.item), note: s.lot ? 'lot ' + s.lot : '', value: r3(s.qty) }))) },
          ],
          table: { title: 'Latest knitting entries', link: '#/list/knitting', columns: [C('date', 'Date', 'date'), C('lot', 'Lot'), C('machine', 'Machine'), C('yarn', 'Yarn kg', 'qty'), C('grey', 'Grey kg', 'qty'), C('wpct', 'Wastage %', 'pct')],
            rows: latest('knitting', d => { const y = sum(d.lines || [], l => num(l.qty)); return { date: d.date, lot: d.lotNo, machine: (machines[d.machine] || {}).code || '', yarn: r3(y), grey: r3(num(d.outQty)), wpct: y ? r2(num(d.wastageQty) / y * 100) : 0, _link: link('knitting', d.id) }; }) },
        });
      }

      if (can('dyeing')) {
        const fig = r => { const x = inP('dyeing', r); return { x, inQ: sum(x, d => num(d.inQty)), out: sum(x, d => num(d.outQty)), w: sum(x, d => num(d.wastageQty)), chem: sum(x, d => sum(d.lines || [], l => kgUnit(l.item) ? num(l.qty) : 0)) }; };
        const c = fig(P.cur), p = fig(P.prev);
        const byColor = {}, chem = {};
        for (const d of c.x) { byColor[d.color || 'Not given'] = (byColor[d.color || 'Not given'] || 0) + num(d.outQty); for (const l of d.lines || []) chem[l.item] = (chem[l.item] || 0) + num(l.qty); }
        const outS = P.series(data.dyeing, d => d.date, d => num(d.outQty));
        sections.push({
          key: 'dyeing', title: 'Dyeing / Coloring', icon: 'drop', link: '#/list/dyeing',
          kpis: [kpi('Fabric dyed', c.out, p.out, 'kg', true, outS), kpi('Grey taken in', c.inQ, p.inQ, 'kg'),
            kpi('Wastage', c.inQ ? c.w / c.inQ * 100 : 0, p.inQ ? p.w / p.inQ * 100 : 0, 'pct', false, null, p.x.length > 0),
            kpi('Batches', c.x.length, p.x.length, 'int', true), kpi('Dyes & chemicals used', c.chem, p.chem, 'kg')],
          trend: { title: 'Dyeing output', sub: 'kg per ' + (P.byDay ? 'day' : 'month'), unit: 'kg', series: [{ name: 'Fabric dyed', values: outS }, { name: 'Grey taken in', values: P.series(data.dyeing, d => d.date, d => num(d.inQty)) }] },
          bars: [
            { title: 'Dyed by colour', sub: 'kg in the period', unit: 'kg', rows: byLabel(Object.entries(byColor).map(([label, value]) => ({ label, value: r3(value) }))) },
            { title: 'Dyes & chemicals used', sub: 'Quantity in the period', unit: 'qty', rows: byLabel(Object.entries(chem).map(([id, value]) => ({ label: iName(id), note: iUnit(id), value: r3(value) }))) },
            { title: 'Waiting to be dyed', sub: 'Grey lots at the color factory, right now', unit: 'kg', rows: byLabel(stockAt('DYE', 'Grey Fabric').map(s => ({ label: s.lot || iName(s.item), note: iName(s.item), value: r3(s.qty) }))) },
          ],
          table: { title: 'Latest dyeing batches', link: '#/list/dyeing', columns: [C('date', 'Date', 'date'), C('lot', 'Lot'), C('color', 'Colour'), C('grey', 'Grey kg', 'qty'), C('dyed', 'Dyed kg', 'qty'), C('wpct', 'Wastage %', 'pct')],
            rows: latest('dyeing', d => ({ date: d.date, lot: d.lotNo, color: d.color || '', grey: r3(num(d.inQty)), dyed: r3(num(d.outQty)), wpct: num(d.inQty) ? r2(num(d.wastageQty) / num(d.inQty) * 100) : 0, _link: link('dyeing', d.id) })) },
        });
      }

      if (can('finishing')) {
        const fig = r => { const x = inP('finishing', r); return { x, inQ: sum(x, d => num(d.inQty)), out: sum(x, d => num(d.outQty)), w: sum(x, d => num(d.wastageQty)), rolls: sum(x, d => num(d.rolls)), meters: sum(x, d => num(d.meters)) }; };
        const c = fig(P.cur), p = fig(P.prev);
        const pack = {};
        for (const d of c.x) for (const l of d.lines || []) pack[l.item] = (pack[l.item] || 0) + num(l.qty);
        const fgByItem = {};
        for (const s of stockAt('FG', 'Finished Goods')) fgByItem[s.item] = (fgByItem[s.item] || 0) + s.qty;
        const outS = P.series(data.finishing, d => d.date, d => num(d.outQty));
        sections.push({
          key: 'finishing', title: 'Finishing & Packing', icon: 'box', link: '#/list/finishing',
          kpis: [kpi('Finished', c.out, p.out, 'kg', true, outS), kpi('Rolls packed', c.rolls, p.rolls, 'int', true), kpi('Meters', c.meters, p.meters, 'int', true),
            kpi('Wastage', c.inQ ? c.w / c.inQ * 100 : 0, p.inQ ? p.w / p.inQ * 100 : 0, 'pct', false, null, p.x.length > 0), kpi('Lots finished', c.x.length, p.x.length, 'int', true)],
          trend: { title: 'Finishing output', sub: 'kg per ' + (P.byDay ? 'day' : 'month'), unit: 'kg', series: [{ name: 'Finished', values: outS }, { name: 'Dyed fabric taken in', values: P.series(data.finishing, d => d.date, d => num(d.inQty)) }] },
          bars: [
            { title: 'Waiting to finish', sub: 'Dyed lots at the color factory, right now', unit: 'kg', rows: byLabel(stockAt('DYE', 'Colored Fabric').map(s => ({ label: s.lot || iName(s.item), note: iName(s.item), value: r3(s.qty) }))) },
            { title: 'Finished stock', sub: 'In the finished goods store, right now', unit: 'kg', rows: byLabel(Object.entries(fgByItem).map(([id, value]) => ({ label: iName(id), value: r3(value) }))) },
            { title: 'Packing material used', sub: 'In the period', unit: 'qty', rows: byLabel(Object.entries(pack).map(([id, value]) => ({ label: iName(id), note: iUnit(id), value: r3(value) }))) },
          ],
          table: { title: 'Latest finishing entries', link: '#/list/finishing', columns: [C('date', 'Date', 'date'), C('lot', 'Lot'), C('item', 'Item'), C('fg', 'Finished kg', 'qty'), C('rolls', 'Rolls', 'int'), C('wpct', 'Wastage %', 'pct')],
            rows: latest('finishing', d => ({ date: d.date, lot: d.outLot || d.lotNo, item: iName(d.outItem), fg: r3(num(d.outQty)), rolls: num(d.rolls), wpct: num(d.inQty) ? r2(num(d.wastageQty) / num(d.inQty) * 100) : 0, _link: link('finishing', d.id) })) },
        });
      }

      if (can('grn') || can('storeTransfers')) {
        const recv = r => sum(inP('grn', r), d => sum(d.lines || [], l => kgUnit(l.item) ? num(l.qty) : 0));
        const issued = r => sum(inP('transfers', r).filter(d => d.purpose === 'Yarn Issue'), d => sum(d.lines || [], l => num(l.qty)));
        const totals = {};
        for (const s of stockRows()) totals[s.item] = (totals[s.item] || 0) + s.qty;
        const low = data.items.filter(i => num(i.reorderLevel) > 0 && (totals[i.id] || 0) < num(i.reorderLevel));
        const byLoc = {};
        for (const s of stockRows()) if (kgUnit(s.item) && s.qty > 0) byLoc[lName(s.loc)] = (byLoc[lName(s.loc)] || 0) + s.qty;
        const byCat = {};
        for (const s of stockAt('STORE')) if (kgUnit(s.item)) byCat[iCat(s.item)] = (byCat[iCat(s.item)] || 0) + s.qty;
        const recvS = P.series(data.grn, d => d.date, d => sum(d.lines || [], l => kgUnit(l.item) ? num(l.qty) : 0));
        sections.push({
          key: 'store', title: 'Store / Inventory', icon: 'box', link: '#/report/stock',
          kpis: [kpi('Material received', recv(P.cur), recv(P.prev), 'kg', null, recvS), kpi('Goods receipts', inP('grn', P.cur).length, inP('grn', P.prev).length, 'int', null),
            kpi('Yarn issued to knitting', issued(P.cur), issued(P.prev), 'kg', null), kpi('Items below re-order', low.length, null, 'int', false)],
          trend: { title: 'Received vs issued', sub: 'kg per ' + (P.byDay ? 'day' : 'month'), unit: 'kg', series: [{ name: 'Received (GRN)', values: recvS }, { name: 'Yarn issued', values: P.series(data.transfers.filter(d => d.purpose === 'Yarn Issue'), d => d.date, d => sum(d.lines || [], l => num(l.qty))) }] },
          bars: [
            { title: 'Stock by location', sub: 'kg items, right now', unit: 'kg', rows: byLabel(Object.entries(byLoc).map(([label, value]) => ({ label, value: r3(value) }))) },
            { title: 'Main store by category', sub: 'kg items, right now', unit: 'kg', rows: byLabel(Object.entries(byCat).map(([label, value]) => ({ label, value: r3(value) }))) },
          ],
          table: { title: 'Re-order alerts', link: '#/report/stock', columns: [C('item', 'Item'), C('qty', 'In stock', 'qty'), C('reorder', 'Re-order level', 'qty'), C('unit', 'Unit')],
            rows: low.map(i => ({ item: i.name, qty: r3(totals[i.id] || 0), reorder: num(i.reorderLevel), unit: iUnit(i.id) })) },
        });
      }

      if (can('purchaseOrders')) {
        const poVal = r => sum(inP('purchaseOrders', r), d => num(d.taxable));
        const billVal = r => sum(inP('purchaseBills', r), d => num(d.taxable));
        const recd = {};
        for (const g of data.grn) if (g.poId) for (const l of g.lines || []) recd[g.poId + '|' + l.item] = (recd[g.poId + '|' + l.item] || 0) + num(l.qty);
        const pend = [];
        for (const po of data.purchaseOrders) {
          if (['Closed', 'Cancelled'].includes(po.status)) continue;
          for (const l of po.lines || []) { const left = num(l.qty) - (recd[po.id + '|' + l.item] || 0); if (left > 0.0005) pend.push({ date: po.date, no: po.no, party: pName(po.party), item: iName(l.item), pending: r3(left), value: r2(left * num(l.rate)), _link: link('purchaseOrders', po.id) }); }
        }
        const bySup = {};
        for (const d of inP('purchaseOrders', P.cur)) bySup[pName(d.party)] = (bySup[pName(d.party)] || 0) + num(d.taxable);
        const poS = P.series(data.purchaseOrders, d => d.date, d => num(d.taxable));
        const kp = [kpi('Orders placed', poVal(P.cur), poVal(P.prev), 'money', null, poS), kpi('Purchase orders', inP('purchaseOrders', P.cur).length, inP('purchaseOrders', P.prev).length, 'int', null),
          kpi('Still to be received', sum(pend, x => x.value), null, 'money', null)];
        if (can('purchaseBills')) kp.push(kpi('Bills booked', billVal(P.cur), billVal(P.prev), 'money', null));
        const series = [{ name: 'Orders placed', values: poS }];
        if (can('purchaseBills')) series.push({ name: 'Bills booked', values: P.series(data.purchaseBills, d => d.date, d => num(d.taxable)) });
        sections.push({
          key: 'purchase', title: 'Purchase', icon: 'cart', link: '#/list/purchaseOrders', kpis: kp,
          trend: { title: 'Purchase value', sub: 'ex-GST per ' + (P.byDay ? 'day' : 'month'), unit: 'money', series },
          bars: [{ title: 'Top suppliers', sub: 'Order value in the period', unit: 'money', rows: byLabel(Object.entries(bySup).map(([label, value]) => ({ label, value: r2(value) })), 6) }],
          table: { title: 'Pending deliveries', link: '#/report/poPending', columns: [C('date', 'PO date', 'date'), C('no', 'PO'), C('party', 'Supplier'), C('item', 'Item'), C('pending', 'Pending', 'qty'), C('value', 'Value', 'money')], rows: pend.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8) },
        });
      }

      if (can('salesOrders') || can('invoices') || can('deliveries')) {
        const sales = r => sum(inP('invoices', r), d => num(d.taxable));
        const orders = r => sum(inP('salesOrders', r), d => num(d.taxable));
        const dispatched = r => sum(inP('deliveries', r), d => sum(d.lines || [], l => num(l.qty))) + sum(inP('invoices', r).filter(d => !d.challanId), d => sum(d.lines || [], l => num(l.qty)));
        const kp = [], series = [];
        if (can('invoices')) {
          const sS = P.series(data.invoices, d => d.date, d => num(d.taxable));
          kp.push(kpi('Sales ex-GST', sales(P.cur), sales(P.prev), 'money', true, sS), kpi('Invoices', inP('invoices', P.cur).length, inP('invoices', P.prev).length, 'int', true));
          series.push({ name: 'Sales', values: sS });
        }
        if (can('salesOrders')) { kp.push(kpi('Orders received', orders(P.cur), orders(P.prev), 'money', true)); series.push({ name: 'Orders received', values: P.series(data.salesOrders, d => d.date, d => num(d.taxable)) }); }
        kp.push(kpi('Dispatched', dispatched(P.cur), dispatched(P.prev), 'kg', true));
        const byCust = {};
        for (const d of inP('invoices', P.cur)) byCust[pName(d.party)] = (byCust[pName(d.party)] || 0) + num(d.taxable);
        const fg = {};
        for (const s of stockAt('FG', 'Finished Goods')) fg[s.item] = (fg[s.item] || 0) + s.qty;
        const sent = {};
        for (const c of data.deliveries) if (c.soId) for (const l of c.lines || []) sent[c.soId + '|' + l.item] = (sent[c.soId + '|' + l.item] || 0) + num(l.qty);
        const pend = [];
        for (const so of data.salesOrders) {
          if (['Closed', 'Cancelled'].includes(so.status)) continue;
          for (const l of so.lines || []) { const left = num(l.qty) - (sent[so.id + '|' + l.item] || 0); if (left > 0.0005) pend.push({ date: so.date, no: so.no, party: pName(so.party), item: iName(l.item), pending: r3(left), due: so.deliveryDate || '', _link: link('salesOrders', so.id) }); }
        }
        const bars = [];
        if (can('invoices')) bars.push({ title: 'Top customers', sub: 'Sales in the period', unit: 'money', rows: byLabel(Object.entries(byCust).map(([label, value]) => ({ label, value: r2(value) })), 6) });
        bars.push({ title: 'Finished goods available', sub: 'Right now, by item', unit: 'kg', rows: byLabel(Object.entries(fg).map(([id, value]) => ({ label: iName(id), value: r3(value) }))) });
        sections.push({
          key: 'sales', title: 'Sales', icon: 'tag', link: can('invoices') ? '#/list/invoices' : '#/list/salesOrders', kpis: kp,
          trend: series.length ? { title: 'Sales value', sub: 'ex-GST per ' + (P.byDay ? 'day' : 'month'), unit: 'money', series } : null,
          bars,
          table: can('salesOrders') ? { title: 'Orders waiting for dispatch', link: '#/report/soPending', columns: [C('date', 'SO date', 'date'), C('no', 'SO'), C('party', 'Customer'), C('item', 'Item'), C('pending', 'Pending kg', 'qty'), C('due', 'Due', 'date')], rows: pend.slice(0, 8) } : null,
        });
      }

      if (can('receipts') || can('payments')) {
        const rc = r => sum(inP('receipts', r), d => num(d.amount)), pm = r => sum(inP('payments', r), d => num(d.amount));
        const kp = [], series = [];
        if (can('receipts')) { const s = P.series(data.receipts, d => d.date, d => num(d.amount)); kp.push(kpi('Collected from customers', rc(P.cur), rc(P.prev), 'money', true, s)); series.push({ name: 'Collections', values: s }); }
        if (can('payments')) { const s = P.series(data.payments, d => d.date, d => num(d.amount)); kp.push(kpi('Paid to suppliers', pm(P.cur), pm(P.prev), 'money', null, s)); series.push({ name: 'Payments', values: s }); }
        const both = can('receipts') && can('payments');
        const title = both ? 'Collections & payments' : can('receipts') ? 'Collections' : 'Supplier payments';
        sections.push({ key: 'cash', title, icon: 'rupee', link: can('receipts') ? '#/list/receipts' : '#/list/payments', kpis: kp,
          trend: { title: both ? 'Money in and out' : can('receipts') ? 'Collected from customers' : 'Paid to suppliers', sub: 'per ' + (P.byDay ? 'day' : 'month'), unit: 'money', series }, bars: [], table: null });
      }

      return { from: P.from, to: P.to, prevFrom: P.prevFrom, prevTo: P.prevTo, days: P.days, byDay: P.byDay, labels: P.labels, sections };
    },

    dashboard() {
      // Period: from/to (defaults to this month so far). Every figure is scoped to it and
      // compared with the previous period of the same length.
      const t = today();
      const to = q.to || t;
      const from = q.from || t.slice(0, 8) + '01';
      const D = s => new Date(s + 'T00:00:00Z');
      const iso = d => d.toISOString().slice(0, 10);
      const days = Math.max(1, Math.round((D(to) - D(from)) / 864e5) + 1);
      const prevTo = iso(new Date(D(from).getTime() - 864e5));
      const prevFrom = iso(new Date(D(from).getTime() - days * 864e5));
      const cur = { from, to }, prev = { from: prevFrom, to: prevTo };
      const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

      // Buckets for trend charts: days for short ranges, months otherwise.
      const byDay = days <= 62;
      const buckets = [];
      if (byDay) for (let d = D(from); d <= D(to); d = new Date(d.getTime() + 864e5)) buckets.push({ key: iso(d), from: iso(d), to: iso(d) });
      else {
        let y = +from.slice(0, 4), m = +from.slice(5, 7);
        while (y * 100 + m <= +to.slice(0, 4) * 100 + +to.slice(5, 7)) {
          const k = y + '-' + String(m).padStart(2, '0');
          const last = iso(new Date(Date.UTC(y, m, 0)));
          buckets.push({ key: k, from: k + '-01' < from ? from : k + '-01', to: last > to ? to : last });
          m++; if (m > 12) { m = 1; y++; }
        }
      }
      const bucketOf = date => byDay ? date : date.slice(0, 7);
      const series = (rows, dateOf, valOf) => {
        const m = {};
        for (const r of rows) { const dt = dateOf(r); if (dt >= from && dt <= to) m[bucketOf(dt)] = (m[bucketOf(dt)] || 0) + valOf(r); }
        return buckets.map(b => r2(m[b.key] || 0));
      };

      // Balances over time (receivable = what customers owe us, payable = what we owe).
      const txns = partyTxns(data);
      const balancesAt = date => {
        const bal = {};
        for (const r of txns) if (!r.date || r.date <= date) bal[r.party] = (bal[r.party] || 0) + r.dr - r.cr;
        let rec = 0, pay = 0;
        for (const [pid, b] of Object.entries(bal)) { if (!parties[pid]) continue; if (b > 0) rec += b; else pay -= b; }
        return { rec: r2(rec), pay: r2(pay) };
      };

      const periodFigures = range => {
        const inv = data.invoices.filter(d => inRange(d.date, range));
        const lines = saleLines(range);
        const sales = sum(inv, d => num(d.taxable));
        const cogs = sum(lines, l => l.cost);
        const fin = data.finishing.filter(d => inRange(d.date, range));
        const fgKg = sum(fin, d => num(d.outQty));
        const fgCost = sum(R.fgLots.filter(f => inRange(f.date, range)), f => vsum(f.vec));
        const knit = data.knitting.filter(d => inRange(d.date, range));
        const yarnIn = sum(knit, d => sum(d.lines || [], l => num(l.qty)));
        const waste = sum(R.wastage.filter(w => inRange(w.date, range)), w => w.qty);
        return {
          sales: r2(sales), purchases: r2(sum(data.purchaseBills.filter(d => inRange(d.date, range)), d => num(d.taxable))),
          profit: r2(sum(lines, l => l.sale) - cogs), margin: sum(lines, l => l.sale) ? r2((sum(lines, l => l.sale) - cogs) / sum(lines, l => l.sale) * 100) : 0,
          collections: r2(sum(data.receipts.filter(d => inRange(d.date, range)), d => num(d.amount))),
          knitKg: r3(sum(knit, d => num(d.outQty))), fgKg: r3(fgKg), avgCostKg: fgKg ? r2(fgCost / fgKg) : 0,
          wastPct: yarnIn ? r2(waste / yarnIn * 100) : 0, invoices: inv.length,
        };
      };
      const k = periodFigures(cur), kp = periodFigures(prev);
      const balNow = balancesAt(to), balPrev = balancesAt(prevTo);
      k.receivable = balNow.rec; k.payable = balNow.pay; kp.receivable = balPrev.rec; kp.payable = balPrev.pay;

      const salesLines = saleLines(cur);
      const trend = {
        labels: buckets.map(b => b.key), byDay,
        sales: series(data.invoices, d => d.date, d => num(d.taxable)),
        purchases: series(data.purchaseBills, d => d.date, d => num(d.taxable)),
        profit: (() => { const m = {}; for (const l of salesLines) m[bucketOf(l.date)] = (m[bucketOf(l.date)] || 0) + l.sale - l.cost; return buckets.map(b => r2(m[b.key] || 0)); })(),
        collections: series(data.receipts, d => d.date, d => num(d.amount)),
        knitKg: series(data.knitting, d => d.date, d => num(d.outQty)),
        fgKg: series(data.finishing, d => d.date, d => num(d.outQty)),
        receivable: buckets.map(b => balancesAt(b.to).rec),
        payable: buckets.map(b => balancesAt(b.to).pay),
      };

      // Production flow in the period
      const kn = data.knitting.filter(d => inRange(d.date, cur)), dy = data.dyeing.filter(d => inRange(d.date, cur)), fi = data.finishing.filter(d => inRange(d.date, cur));
      const yarnIn = sum(kn, d => sum(d.lines || [], l => num(l.qty)));
      const flow = [
        { stage: 'Yarn into knitting', kg: r3(yarnIn) },
        { stage: 'Grey fabric knitted', kg: r3(sum(kn, d => num(d.outQty))) },
        { stage: 'Fabric dyed', kg: r3(sum(dy, d => num(d.outQty))) },
        { stage: 'Finished & packed', kg: r3(sum(fi, d => num(d.outQty))) },
      ];

      const stageW = ['Knitting', 'Dyeing', 'Finishing'].map(st => {
        const l = R.wastage.filter(w => w.stage === st && inRange(w.date, cur));
        const inQ = sum(l, w => w.inQty), wq = sum(l, w => w.qty);
        return { stage: st, qty: r3(wq), pct: inQ ? r2(wq / inQ * 100) : 0, value: r2(sum(l, w => w.value)) };
      });

      // Top customers by sales in the period (top 5 + other)
      const byCust = {};
      for (const d of data.invoices) if (inRange(d.date, cur)) byCust[d.party] = (byCust[d.party] || 0) + num(d.taxable);
      let cust = Object.entries(byCust).map(([pid, v]) => ({ name: pName(pid), value: r2(v) })).sort((a, b) => b.value - a.value);
      if (cust.length > 6) { const rest = cust.slice(5); cust = cust.slice(0, 5).concat([{ name: 'Other (' + rest.length + ')', value: r2(sum(rest, x => x.value)) }]); }

      // Top items sold
      const byItem = {};
      for (const l of salesLines) { const e = byItem[l.item] || (byItem[l.item] = { name: l.item, kg: 0, value: 0 }); e.kg += l.qty; e.value += l.sale; }
      const topItems = Object.values(byItem).sort((a, b) => b.value - a.value).slice(0, 6).map(x => ({ name: x.name, kg: r3(x.kg), value: r2(x.value) }));

      // Receivables ageing as of `to`
      const byParty = {};
      for (const r of txns) if (!r.date || r.date <= to) (byParty[r.party] = byParty[r.party] || []).push(r);
      const age = { b30: 0, b60: 0, b90: 0, b90p: 0 };
      for (const [pid, list] of Object.entries(byParty)) {
        if (!parties[pid] || list.reduce((a, r) => a + r.dr - r.cr, 0) <= 0.005) continue;
        const a = ageing(list, 'dr', to);
        age.b30 += a.b30; age.b60 += a.b60; age.b90 += a.b90; age.b90p += a.b90p;
      }
      for (const key of Object.keys(age)) age[key] = r2(age[key]);

      // Cost per kg of lots finished in the period
      const lotCost = {};
      for (const f of R.fgLots) {
        if (!inRange(f.date, cur)) continue;
        const e = lotCost[f.lot] || (lotCost[f.lot] = { lot: f.lot, date: f.date, kg: 0, cost: 0 });
        e.kg += f.qty; e.cost += vsum(f.vec);
      }
      const lots = Object.values(lotCost).sort((a, b) => a.date.localeCompare(b.date)).slice(-12).map(e => ({ lot: e.lot, perKg: e.kg ? r2(e.cost / e.kg) : 0, kg: r3(e.kg) }));

      // Stock value by location (now)
      const stockByLoc = {};
      for (const sr of stockRows()) { const e = stockByLoc[sr.loc] || (stockByLoc[sr.loc] = { name: lName(sr.loc), value: 0 }); e.value += sr.value; }
      const stock = Object.values(stockByLoc).map(x => ({ name: x.name, value: r2(x.value) })).filter(x => Math.abs(x.value) > 0.5).sort((a, b) => b.value - a.value);

      const pipe = {};
      for (const sr of stockRows()) {
        const key = sr.loc + '|' + iCat(sr.item);
        const pp = pipe[key] || (pipe[key] = { qty: 0, value: 0 });
        pp.qty += sr.qty; pp.value += sr.value;
      }
      const P = (loc, cat) => { const pp = pipe[loc + '|' + cat] || { qty: 0, value: 0 }; return { qty: r3(pp.qty), value: r2(pp.value) }; };

      const totals = {};
      for (const sr of stockRows()) totals[sr.item] = (totals[sr.item] || 0) + sr.qty;
      const low = data.items.filter(i => num(i.reorderLevel) > 0 && (totals[i.id] || 0) < num(i.reorderLevel)).map(i => ({ item: i.name, qty: r3(totals[i.id] || 0), reorder: num(i.reorderLevel), unit: iUnit(i.id) }));

      const recent = [];
      for (const col of ['invoices', 'grn', 'knitting', 'dyeing', 'finishing', 'deliveries', 'receipts', 'payments']) {
        for (const d of data[col]) recent.push({ col, id: d.id, no: d.no, date: d.date, createdAt: d.createdAt || '', label: docName(col), party: pName(d.party), amount: num(d.total || d.amount), lot: d.outLot || d.lotNo || '' });
      }
      recent.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      const pendingSO = (() => {
        const sent = {};
        for (const c of data.deliveries) if (c.soId) for (const l of c.lines || []) sent[c.soId + '|' + l.item] = (sent[c.soId + '|' + l.item] || 0) + num(l.qty);
        return data.salesOrders.filter(so => !['Closed', 'Cancelled'].includes(so.status) && (so.lines || []).some(l => num(l.qty) - (sent[so.id + '|' + l.item] || 0) > 0.0005)).length;
      })();

      return {
        from, to, prevFrom, prevTo, days,
        kpi: Object.assign({}, k, { pendingSO, exceptions: R.errors.length }), prev: kp, trend,
        flow, stageW, customers: cust, topItems, age, lots, stock,
        pipeline: [
          Object.assign({ key: 'yarnStore', label: 'Yarn in store', loc: 'STORE' }, P('STORE', 'Yarn')),
          Object.assign({ key: 'yarnKnit', label: 'Yarn at knitting', loc: 'KNIT' }, P('KNIT', 'Yarn')),
          Object.assign({ key: 'greyKnit', label: 'Grey at knitting', loc: 'KNIT' }, P('KNIT', 'Grey Fabric')),
          Object.assign({ key: 'greyDye', label: 'Grey at color factory', loc: 'DYE' }, P('DYE', 'Grey Fabric')),
          Object.assign({ key: 'colDye', label: 'Dyed, to finish', loc: 'DYE' }, P('DYE', 'Colored Fabric')),
          Object.assign({ key: 'fg', label: 'Finished goods', loc: 'FG' }, P('FG', 'Finished Goods')),
        ],
        low, recent: recent.slice(0, 8),
      };
    },
  };
}

function reportImpl(name, data, q, version, perms) {
  const R = computed(data, version);
  const items = index(data.items), parties = index(data.parties), locs = index(data.locations), units = index(data.units), machines = index(data.machines);
  const ctx = {
    R, data, q: q || {}, items, parties, machines, perms: perms || {},
    iName: id => items[id] ? items[id].name : (id || ''),
    iCat: id => items[id] ? items[id].category : '',
    iUnit: id => items[id] && units[items[id].unit] ? units[items[id].unit].code : '',
    pName: id => parties[id] ? parties[id].name : (id || ''),
    lName: id => locs[id] ? locs[id].name : (id || ''),
    link: (col, id) => '#/edit/' + col + '/' + id,
    docName: col => DOC_LABELS[col] || col,
    stockRows: asOn => {
      const m = new Map();
      for (const r of R.ledger) {
        if (asOn && r.date > asOn) continue;
        const k = r.item + '|' + r.loc + '|' + r.lot;
        let s = m.get(k);
        if (!s) { s = { item: r.item, loc: r.loc, lot: r.lot, qty: 0, value: 0, rolls: 0 }; m.set(k, s); }
        s.qty += r.qin - r.qout; s.value += r.value; s.rolls += r.rolls;
      }
      return [...m.values()];
    },
  };
  const reports = buildReports(ctx);
  if (!reports[name]) throw Object.assign(new Error('Unknown report: ' + name), { status: 404 });
  return reports[name]();
}

module.exports = { compute, computed, report: reportImpl, prepare, validate, partyBalances, STOCK_COLS, DOC_LABELS, BUCKETS, vsum };

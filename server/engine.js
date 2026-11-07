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
const { r2, r3, num, applyTotals, partyIs, workOf: S_workOf, STATE_NAMES, checkGstin, levelAtLeast, STAGES, STAGE_LABELS, parseRolls, fmtRolls, allocRolls, LOT_CATEGORIES, lotFmt, lotPattern, mainLot, doesWork,
  isGodown, COST_CATEGORIES, ATTENDANCE, stateCode, PAY_DETAILS, PAY_DETAIL_KEYS, payDetail } = require('../public/js/shared');

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

// One lot number per lot of material, from the GRN (or opening stock) to the sale: L-0001, L-0002 ...
// (or the pattern set in Settings, e.g. MH-2026-001). `date` is the entry's date, for patterns with a year.
// Returns a function that hands out the next free number each time it is called. Lot numbers typed by
// hand (lotCustom) are never handed out again, but do not move the automatic series on.
function lotMaker(data, date) {
  const pattern = (data.settings || {}).lotPattern, day = date || today();
  const norm = v => String(v).trim().toUpperCase();
  const used = new Set(), custom = new Set();
  const add = v => { if (v) used.add(norm(v)); };
  for (const c of STOCK_COLS) for (const d of data[c] || []) { add(d.lotNo); add(d.outLot); for (const l of d.lines || []) { add(l.lot); if (l.lotCustom && l.lot) custom.add(norm(l.lot)); } }
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shape = new RegExp('^' + lotPattern(pattern).replace(/\{YYYY\}/g, day.slice(0, 4)).split(/#+/).map(esc).join('(\\d+)') + '$');
  let n = 0;
  for (const v of used) { const m = !custom.has(v) && shape.exec(v); if (m) n = Math.max(n, parseInt(m[1], 10)); }
  const next = () => { let v; do v = lotFmt(++n, pattern, day); while (used.has(v)); used.add(v); return v; };
  next.exists = lot => used.has(norm(lot));
  next.reserve = lot => used.add(norm(lot));
  return next;
}
// A lot number typed by hand: letters, digits, - / . _ and spaces (never "|", which the stock keys use).
const LOT_OK = /^[A-Z0-9][A-Z0-9 ._/-]{0,29}$/;
// The first other entry holding this lot, e.g. "Knitting KNT-0003" (a lot in use keeps its number).
function lotUsedBy(data, lot, selfId) {
  for (const c of STOCK_COLS) for (const d of data[c] || []) {
    if (d.id === selfId) continue;
    if (d.lotNo === lot || d.outLot === lot || (d.lines || []).some(l => l.lot === lot)) return (DOC_LABELS[c] || c) + ' ' + (d.no || '');
  }
  return '';
}

// Is this lot of this item taken further by another entry (dyed, finished, moved or sold)?
function lotUsed(data, lot, item, selfId) {
  return ['dyeing', 'finishing'].some(c => (data[c] || []).some(d => d.id !== selfId && d.lotNo === lot && d.inItem === item)) ||
    ['transfers', 'deliveries', 'invoices', 'stockAdjust'].some(c => (data[c] || []).some(d => d.id !== selfId && (d.lines || []).some(l => l.lot === lot && l.item === item)));
}

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
  const rootOf = {};       // any lot -> the lot it started as (only differs for lots split before lot numbers ran through)
  const lotInfo = {};      // root lot -> trace
  const colorOf = {};      // "item|lot" of colored / finished fabric -> color(s)
  const salePieces = {};   // "docId|line index" -> rolls taken by a challan / direct invoice line [{ no, kg }]
  const saleRolls = {};    // "docId|line index" -> number of rolls that line took (counted rolls: the lot's average)

  // Each stock line counts its rolls. Rolls weighed one by one (finished goods) are kept in `bag`
  // as { no, kg }; `rolls` counts the rest, whose weights were never entered.
  const K = (item, loc, lot) => {
    const k = item + '|' + loc + '|' + (lot || '');
    let s = keys.get(k);
    if (!s) { s = { key: k, item, loc, lot: lot || '', layers: [], neg: 0, rolls: 0, bag: [], nextRoll: 1, lastUnit: null }; keys.set(k, s); }
    return s;
  };
  const matVec = (itemId, value) => { const v = vz(); const it = items[itemId]; v[CAT_BUCKET[it && it.category] || 'otherMat'] = value; return v; };

  function stockIn(ev, item, loc, lot, qty, vec, rolls, weights) {
    if (!(qty > EPS) || !item || !loc) return;
    const s = K(item, loc, lot);
    const moves = [];
    if (weights && weights.length) for (const kg of weights) { const no = s.nextRoll++; s.bag.push({ no, kg: r3(kg) }); moves.push([no, r3(kg)]); }
    else s.rolls += num(rolls);
    s.lastUnit = vscale(vec, 1 / qty);
    let q = qty, v = vec;
    if (s.neg > EPS) { const c = Math.min(s.neg, q); s.neg -= c; v = vscale(vec, (q - c) / q); q -= c; }
    if (q > EPS) {
      if (method === 'AVG' && s.layers.length) { s.layers[0].qty += q; vadd(s.layers[0].vec, v); }
      else s.layers.push({ qty: q, vec: Object.assign({}, v) });
    }
    ledger.push({ date: ev.date, col: ev.col, docId: ev.doc.id, docNo: ev.doc.no, item, loc, lot: lot || '', qin: qty, qout: 0, value: vsum(vec), rolls: moves.length ? 0 : num(rolls), rollMoves: moves.length ? moves : undefined, party: ev.doc.party || '' });
  }

  // Weighed rolls leave as picked on the document (`pick`), or else in roll order: whole rolls
  // first and the last one cut. The pieces taken are left in `lastPieces` for the caller.
  // Rolls that were only counted (not weighed) are an average: a line that does not give its own
  // roll count takes the lot's rolls in proportion to the kg (1000 kg in 300 rolls: 100 kg = 30 rolls),
  // and the last kg take all that is left. The rolls taken are left in `lastRolls`.
  let lastPieces = [], lastRolls = 0;
  const blank = v => v === undefined || v === null || v === '';
  function stockOut(ev, item, loc, lot, qty, rolls, pick) {
    const out = vz();
    lastPieces = []; lastRolls = 0;
    if (!(qty > EPS) || !item || !loc) return out;
    const s = K(item, loc, lot);
    const have = s.layers.reduce((a, l) => a + l.qty, 0) - s.neg;
    const moves = [];
    if (s.bag.length) {
      const picks = pick && pick.length ? pick : allocRolls(s.bag, qty).picks;
      for (const p of picks) {
        const r = s.bag.find(x => x.no === p.no);
        if (!r || r.kg < p.kg - 0.0005) errors.push({ key: s.key + '|roll' + p.no, date: ev.date, col: ev.col, docId: ev.doc.id, docNo: ev.doc.no, item, loc, lot: lot || '', short: r3(p.kg - (r ? r.kg : 0)), roll: p.no, have: r ? r3(r.kg) : 0 });
        if (!r) continue;
        const take = r3(Math.min(r.kg, p.kg));
        r.kg = r3(r.kg - take);
        moves.push([p.no, -take]);
        lastPieces.push({ no: p.no, kg: take });
      }
      s.bag = s.bag.filter(x => x.kg > 0.0005);
      lastRolls = lastPieces.length;
    } else {
      lastRolls = !blank(rolls) ? Math.abs(num(rolls))
        : s.rolls <= 0 || have <= EPS ? 0 : qty >= have - 0.0005 ? s.rolls : Math.min(s.rolls, Math.round(qty * s.rolls / have));
      s.rolls -= lastRolls;
    }
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
    ledger.push({ date: ev.date, col: ev.col, docId: ev.doc.id, docNo: ev.doc.no, item, loc, lot: lot || '', qin: 0, qout: qty, value: -vsum(out), rolls: moves.length ? 0 : -lastRolls, rollMoves: moves.length ? moves : undefined, party: ev.doc.party || '' });
    return out;
  }

  // Overhead absorption: each month's overheads are spread over the kg finished in that month.
  const fgKgByMonth = {}, ohByMonth = {};
  for (const f of data.finishing || []) { const m = (f.date || '').slice(0, 7); fgKgByMonth[m] = (fgKgByMonth[m] || 0) + num(f.outQty); }
  for (const o of data.overheads || []) if (toCost(o)) { const m = (o.date || '').slice(0, 7); ohByMonth[m] = (ohByMonth[m] || 0) + num(o.amount); }
  for (const b of data.powerBills || []) if (b.toCost !== false) { const m = billMonth(b); ohByMonth[m] = (ohByMonth[m] || 0) + num(b.amount); }
  const ohRate = m => fgKgByMonth[m] ? (ohByMonth[m] || 0) / fgKgByMonth[m] : 0;

  const trace = root => lotInfo[root] || (lotInfo[root] = { lot: root, buy: [], knit: [], dye: [], fin: [] });
  const tracked = itemId => LOT_CATEGORIES.includes((items[itemId] || {}).category);
  const received = (d, l, party) => { if (l.lot && tracked(l.item)) trace(l.lot).buy.push({ date: d.date, docNo: d.no, party, item: l.item, qty: num(l.qty) }); };
  const ck = (item, lot) => item + '|' + (lot || '');
  const addColor = (k, c) => {
    const have = colorOf[k] ? colorOf[k].split(', ') : [];
    for (const x of String(c || '').split(', ')) if (x && !have.includes(x)) have.push(x);
    if (have.length) colorOf[k] = have.join(', ');
  };

  // One production stage: material in, (chemicals/packing/labour/overhead) added, good output + wastage out.
  // The output keeps the rolls taken in (`inRolls`) unless the entry gives its own count.
  function stage(ev, name, fabricVec, inQ, inItem, labourBucket, addVec, loc, outLoc, inRolls) {
    const d = ev.doc;
    const outQ = num(d.outQty);
    const outRolls = blank(d.rolls) ? inRolls || 0 : num(d.rolls);
    const wq = Math.min(num(d.wastageQty), inQ);
    const w = inQ > 0 ? wq / inQ : 0;
    const wasteVal = vsum(fabricVec) * w;
    const scrap = num(d.scrapValue);
    const outVec = vscale(fabricVec, 1 - w);
    vadd(outVec, addVec);
    outVec.wastage += wasteVal - scrap;
    outVec[labourBucket] += num(d.labour);
    const outLot = d.outLot || d.lotNo;
    stockIn(ev, d.outItem, outLoc, outLot, outQ, outVec, outRolls, ev.col === 'finishing' ? parseRolls(d.rollWeights) : null);

    const row = {
      date: d.date, stage: name, col: ev.col, docId: d.id, docNo: d.no, lot: d.lotNo, outLot, loc, outLoc,
      inItem, outItem: d.outItem, machine: d.machine || '', inQty: inQ, outQty: outQ, rolls: (parseRolls(d.rollWeights) || []).length || outRolls,
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
          if (q > 0) { stockIn(ev, l.item, loc, l.lot, q, matVec(l.item, q * num(l.rate)), l.rolls, parseRolls(l.rollWeights)); received(d, l, ''); }
          else if (q < 0) stockOut(ev, l.item, loc, l.lot, -q, l.rolls, l.rollPick);
        }
        break;
      }
      case 'grn': {
        const loc = d.location || 'STORE';
        for (const l of lines) { stockIn(ev, l.item, loc, l.lot, num(l.qty), matVec(l.item, num(l.qty) * num(l.rate)), l.rolls); received(d, l, d.party); }
        break;
      }
      case 'transfers': {
        for (const l of lines) {
          const v = stockOut(ev, l.item, d.fromLoc, l.lot, num(l.qty), l.rolls, l.rollPick);
          stockIn(ev, l.item, d.toLoc, l.lot, num(l.qty), v, lastRolls, lastPieces.map(p => p.kg)); // weighed rolls arrive weighed
        }
        break;
      }
      // Work is done at an agency (or own factory): `location` holds the material taken in, `outLoc` is
      // where the output is sent. Entries made before agencies have neither and used the built-in
      // Knitting Factory / Color Factory; old knitting entries without outLoc kept their grey there.
      case 'knitting': {
        const loc = d.location || 'KNIT';
        const cons = vz(); let inQ = 0;
        for (const l of lines) { inQ += num(l.qty); vadd(cons, stockOut(ev, l.item, loc, l.lot, num(l.qty))); }
        const row = stage(ev, 'Knitting', cons, inQ, (lines[0] || {}).item, 'knitLabour', vz(), loc, d.outLoc || loc);
        rootOf[row.outLot] = d.lotNo;
        trace(d.lotNo).knit.push(row);
        break;
      }
      case 'dyeing': {
        const inQ = num(d.inQty), loc = d.location || 'DYE';
        const fv = stockOut(ev, d.inItem, loc, d.lotNo, inQ), inRolls = lastRolls;
        const chem = vz();
        for (const l of lines) vadd(chem, stockOut(ev, l.item, d.chemLoc || 'STORE', l.lot, num(l.qty)));
        const row = stage(ev, 'Dyeing', fv, inQ, d.inItem, 'dyeLabour', chem, loc, d.outLoc || loc, inRolls);
        const root = rootOf[d.lotNo] || d.lotNo;
        rootOf[row.outLot] = root;
        addColor(ck(d.outItem, row.outLot), d.color);
        trace(root).dye.push(row);
        break;
      }
      case 'finishing': {
        const inQ = num(d.inQty), loc = d.location || 'DYE';
        const fv = stockOut(ev, d.inItem, loc, d.lotNo, inQ), inRolls = lastRolls;
        const add = vz();
        for (const l of lines) vadd(add, stockOut(ev, l.item, d.packLoc || 'STORE', l.lot, num(l.qty)));
        add.overhead += ohRate((d.date || '').slice(0, 7)) * num(d.outQty);
        const row = stage(ev, 'Finishing', fv, inQ, d.inItem, 'finLabour', add, loc, d.outLoc || 'FG', inRolls);
        const root = rootOf[d.lotNo] || d.lotNo;
        rootOf[row.outLot] = root;
        addColor(ck(d.outItem, row.outLot), colorOf[ck(d.inItem, d.lotNo)] || d.color);
        trace(root).fin.push(row);
        fgLots.push({ date: d.date, docId: d.id, docNo: d.no, lot: row.outLot, root, item: d.outItem, qty: num(d.outQty), rolls: row.rolls, meters: num(d.meters), vec: row.vec, color: colorOf[ck(d.outItem, row.outLot)] || '' });
        break;
      }
      case 'deliveries':
      case 'invoices': {
        if (ev.col === 'invoices' && d.challanId) break; // stock already left with the challan
        const loc = d.location || 'FG';
        lines.forEach((l, i) => {
          const q = num(l.qty);
          const v = stockOut(ev, l.item, loc, l.lot, q, l.rolls, l.rollPick);
          if (lastPieces.length) salePieces[d.id + '|' + i] = lastPieces;
          saleRolls[d.id + '|' + i] = lastRolls;
          if (q > 0) unitCost[d.id + '|' + l.item + '|' + (l.lot || '')] = vsum(v) / q;
        });
        break;
      }
    }
  }

  return { keys, ledger, errors, wastage, production, fgLots, unitCost, salePieces, saleRolls, rootOf, lotInfo, colorOf, ohByMonth, fgKgByMonth, method };
}

// " (Cheque: 004512 dt 05-11-2026, Axis Bank)" after a receipt or payment in the ledgers.
const howPaid = d => d.mode ? ' (' + [d.mode, payDetail(d)].filter(Boolean).join(': ') + ')' : '';
const dmyOf = s => String(s || '').split('-').reverse().join('-');
// When the money of a receipt or payment counts. A cheque only once it is cashed, from that day ("Cleared
// in bank on"); until then it is pending: the customer still owes it, the supplier is still owed it, and the
// bank does not have it. Other modes count on the entry's date. A split entry counts part by part.
function whenCounts(d) {
  const parts = Array.isArray(d.parts) && d.parts.length > 1 ? d.parts : [d];
  const days = {};
  let pending = 0;
  for (const p of parts) {
    if (p.mode === 'Cheque' && !d.clearedOn) { pending += num(p.amount); continue; }
    const on = p.mode === 'Cheque' ? d.clearedOn : d.date || '';
    days[on] = (days[on] || 0) + num(p.amount);
  }
  const list = Object.entries(days).map(([date, amount]) => ({ date, amount: r2(amount) }));
  return { days: list, counted: r2(list.reduce((t, x) => t + x.amount, 0)), pending: r2(pending) };
}
// The counted money of receipts / payments, each on the day it counts (for totals by day or month).
const countedDays = list => (list || []).flatMap(d => whenCounts(d).days);
// Expense entries go into production cost when they say so; entries from before the choice existed all did.
const toCost = o => o.toCost === undefined ? true : !!o.toCost;
const billMonth = b => String(b.billMonth || b.date || '').slice(0, 7);

/* ------------------------------------------------------------------ */
/* Bank & cash                                                         */
/* ------------------------------------------------------------------ */

// Every rupee in or out of a bank or cash account, from the documents that move money.
// account: bank record id, 'CASH' (cash in hand), or '' when the entry did not name one. Entries
// without an account (e.g. made before bank accounts were set up) count in the bank chosen in Settings.
function cashTxns(data) {
  const parties = index(data.parties), emps = index(data.employees), loans = index(data.loans);
  const dflt = (data.settings || {}).defaultBank || '';
  const acct = (bank, mode) => bank || (mode === 'Cash' ? 'CASH' : dflt);
  const rows = [];
  // A cheque is in the account only once it is cashed: from "Cleared in bank on", not before.
  const add = (d, col, account, inAmt, outAmt, text, date, mode) => {
    if (!(num(inAmt) > 0) && !(num(outAmt) > 0)) return;
    if ((mode || d.mode) === 'Cheque') { if (!d.clearedOn) return; date = d.clearedOn; }
    rows.push({ date: date || d.date || '', account, col, docId: d.id, docNo: d.no || '', text, in: r2(num(inAmt)), out: r2(num(outAmt)), clearedOn: d.clearedOn || '' });
  };
  const pn = id => (parties[id] || {}).name || '';
  const split = (d, col, dir, text) => {
    const parts = Array.isArray(d.parts) && d.parts.length > 1 ? d.parts : [d];
    for (const p of parts) add(d, col, acct(p.bank, p.mode), dir > 0 ? p.amount : 0, dir < 0 ? p.amount : 0, text + howPaid(p), '', p.mode);
  };
  for (const b of data.banks || []) if (num(b.openingBalance)) rows.push({ date: b.openingDate || '', account: b.id, col: 'banks', docId: b.id, docNo: 'Opening', text: 'Opening balance', in: num(b.openingBalance) > 0 ? r2(num(b.openingBalance)) : 0, out: num(b.openingBalance) < 0 ? r2(-num(b.openingBalance)) : 0, clearedOn: b.openingDate || '0000', opening: true });
  for (const d of data.receipts || []) split(d, 'receipts', 1, 'Receipt: ' + pn(d.party));
  for (const d of data.payments || []) split(d, 'payments', -1, 'Payment: ' + pn(d.party));
  for (const d of data.labourPayments || []) add(d, 'labourPayments', acct(d.bank, d.mode), 0, d.amount, 'Labour: ' + (STAGE_LABELS[d.stage] || d.stage || '') + (d.paidTo ? ', ' + d.paidTo : ''));
  for (const d of data.overheads || []) add(d, 'overheads', acct(d.bank, d.mode), 0, d.amount, 'Expense: ' + (d.category || '') + (d.paidTo ? ', ' + d.paidTo : ''));
  for (const d of data.salary || []) add(d, 'salary', acct(d.bank, d.mode), 0, d.amount, (d.kind === 'Advance' ? 'Salary advance: ' : 'Salary: ') + ((emps[d.employee] || {}).name || '') + (d.month ? ' (' + d.month + ')' : ''));
  for (const d of data.emiPayments || []) add(d, 'emiPayments', acct(d.bank, d.mode), 0, d.amount, 'EMI: ' + ((loans[d.loan] || {}).name || ''));
  for (const d of data.powerBills || []) if (d.paidOn) add(d, 'powerBills', acct(d.bank, d.mode), 0, num(d.paidAmount) || num(d.amount), 'Electricity bill: ' + (d.provider || '') + ' ' + billMonth(d), d.paidOn);
  for (const d of data.bankEntries || []) {
    const t = d.kind + (d.remarks ? ': ' + d.remarks : '');
    if (d.fromBank) add(d, 'bankEntries', d.fromBank, 0, d.amount, t);
    if (d.toBank) add(d, 'bankEntries', d.toBank, d.amount, 0, t);
  }
  return rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (b.opening ? 1 : 0) - (a.opening ? 1 : 0));
}

// Cheques received or given that are not cashed yet: they count nowhere until "Cleared in bank on" is filled in.
function pendingCheques(data) {
  const parties = index(data.parties), emps = index(data.employees), loans = index(data.loans);
  const who = (col, d) => col === 'receipts' || col === 'payments' ? (parties[d.party] || {}).name || '' : col === 'salary' ? (emps[d.employee] || {}).name || ''
    : col === 'emiPayments' ? (loans[d.loan] || {}).name || '' : col === 'powerBills' ? 'Electricity: ' + (d.provider || '') : d.paidTo || d.category || STAGE_LABELS[d.stage] || '';
  const out = [];
  for (const col of ['receipts', 'payments', 'labourPayments', 'overheads', 'salary', 'emiPayments', 'powerBills']) for (const d of data[col] || []) {
    if (d.clearedOn || (col === 'powerBills' && !d.paidOn)) continue;
    const parts = Array.isArray(d.parts) && d.parts.length > 1 ? d.parts : [d];
    for (const p of parts) if (p.mode === 'Cheque') out.push({ col, d, p, inward: col === 'receipts', party: who(col, d), date: col === 'powerBills' ? d.paidOn : d.date,
      amount: r2(col === 'powerBills' ? num(d.paidAmount) || num(d.amount) : num(p.amount)) });
  }
  return out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

/* ------------------------------------------------------------------ */
/* Staff, loans, bills                                                 */
/* ------------------------------------------------------------------ */

const daysIn = month => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

// Salary for one employee and month (YYYY-MM). Monthly staff: the month's salary less unpaid days
// (absent, half of a half day, days before joining). Daily staff: rate x days paid (present, half,
// paid leave, holidays). Days not marked count as worked for monthly staff.
function salaryCalc(data, empId, month) {
  const e = (data.employees || []).find(x => x.id === empId) || {};
  const days = daysIn(month);
  const marks = { P: 0, H: 0, A: 0, L: 0, O: 0 };
  for (const a of data.attendance || []) {
    if (!String(a.date || '').startsWith(month)) continue;
    for (const r of a.staff || []) if (r.employee === empId && marks[r.mark || 'P'] !== undefined) marks[r.mark || 'P']++;
  }
  const share = Object.fromEntries(ATTENDANCE.map(x => [x[0], x[2]]));
  let paidDays, due;
  if (e.basis === 'Daily') {
    paidDays = Object.keys(marks).reduce((t, k) => t + marks[k] * share[k], 0);
    due = num(e.salary) * paidDays;
  } else {
    const before = e.joinDate && e.joinDate.slice(0, 7) === month ? +e.joinDate.slice(8, 10) - 1 : e.joinDate && e.joinDate.slice(0, 7) > month ? days : 0;
    paidDays = Math.max(0, days - before - marks.A - marks.H * 0.5);
    due = num(e.salary) * paidDays / days;
  }
  let paid = 0, deducted = 0;
  for (const s of data.salary || []) if (s.employee === empId && s.kind !== 'Advance' && s.month === month) { paid += num(s.amount); deducted += num(s.advanceDeducted); }
  return { days, marks, paidDays: r2(paidDays), due: r2(due), paid: r2(paid), deducted: r2(deducted), balance: r2(due - paid - deducted) };
}
// Advances given less advances recovered from salaries.
function advanceLeft(data, empId) {
  let t = 0;
  for (const s of data.salary || []) if (s.employee === empId) t += s.kind === 'Advance' ? num(s.amount) : -num(s.advanceDeducted);
  return r2(t);
}

// Where a loan stands on `day`: EMIs paid and left, the next due date and a status. EMIs fall due
// monthly from the first EMI date; payments are counted in order.
function loanState(data, loan, day) {
  const pays = (data.emiPayments || []).filter(p => p.loan === loan.id);
  const count = pays.length, paidAmt = pays.reduce((t, p) => t + num(p.amount), 0);
  const tenure = Math.round(num(loan.tenure));
  const left = tenure ? Math.max(0, tenure - count) : null;
  const first = /^\d{4}-\d{2}-\d{2}$/.test(loan.firstEmi || '') ? loan.firstEmi : day;
  const dueAt = k => {
    const m0 = +first.slice(5, 7) - 1 + k, y = +first.slice(0, 4) + Math.floor(m0 / 12), mon = y + '-' + String(m0 % 12 + 1).padStart(2, '0');
    return mon + '-' + String(Math.min(+first.slice(8, 10), daysIn(mon))).padStart(2, '0');
  };
  if (loan.status === 'Closed' || left === 0) return { count, paidAmt: r2(paidAmt), left: left || 0, toPay: 0, next: '', status: 'Closed', level: 'ok' };
  const next = dueAt(count), d = daysBetween(day, next);
  let status, level;
  if (d < 0) { let behind = 0; while (dueAt(count + behind) <= day) behind++; status = 'Overdue ' + -d + ' day' + (d === -1 ? '' : 's') + (behind > 1 ? ' (' + behind + ' EMIs)' : ''); level = 'bad'; }
  else if (d === 0) { status = '🔴 Due today'; level = 'bad'; }
  else if (d <= 3) { status = '🟠 Due in ' + d + ' day' + (d === 1 ? '' : 's'); level = 'warn'; }
  else { status = count && dueAt(count - 1).slice(0, 7) === day.slice(0, 7) ? '🟢 Paid this month' : 'Due in ' + d + ' days'; level = 'ok'; }
  return { count, paidAmt: r2(paidAmt), left, toPay: left === null ? 0 : r2(left * num(loan.emi)), next, status, level };
}

// An electricity bill's status on `day`.
function billState(b, day) {
  if (b.paidOn) return { status: '🟢 Paid', level: 'ok', days: null };
  if (!b.dueDate) return { status: 'Unpaid', level: 'warn', days: null };
  const d = daysBetween(day, b.dueDate);
  if (d < 0) return { status: 'Overdue ' + -d + ' day' + (d === -1 ? '' : 's'), level: 'bad', days: d };
  if (d === 0) return { status: '🔴 Due today', level: 'bad', days: d };
  if (d <= 7) return { status: '🟠 Due in ' + d + ' day' + (d === 1 ? '' : 's'), level: 'warn', days: d };
  return { status: 'Due in ' + d + ' days', level: 'ok', days: d };
}

/* ------------------------------------------------------------------ */
/* Party accounts                                                      */
/* ------------------------------------------------------------------ */

// The agency (party) a location belongs to, or '' for our own stores and factories.
function agencyParty(data, locId) {
  const l = locId && (data.locations || []).find(x => x.id === locId);
  return (l && l.party) || '';
}

// Returns ledger rows: dr = party owes us / we paid them; cr = we owe / they paid us.
function partyTxns(data) {
  const rows = [];
  for (const p of data.parties || []) {
    const ob = num(p.openingBalance);
    if (ob) rows.push({ date: '', party: p.id, col: 'parties', docId: p.id, docNo: 'Opening', narration: 'Opening balance', dr: p.openingType === 'Cr' ? 0 : ob, cr: p.openingType === 'Cr' ? ob : 0 });
  }
  for (const d of data.invoices || []) rows.push({ date: d.date, party: d.party, col: 'invoices', docId: d.id, docNo: d.no, narration: 'Sales invoice', dr: num(d.total), cr: 0, dueDays: null });
  // Receipts and payments count on the day the money is there: a cheque only once it is cashed.
  const money = (d, col, word, side) => {
    const w = whenCounts(d);
    for (const x of w.days) rows.push({ date: x.date, party: d.party, col, docId: d.id, docNo: d.no, dr: side === 'dr' ? x.amount : 0, cr: side === 'cr' ? x.amount : 0,
      narration: word + howPaid(d) + (x.date !== d.date ? ', cheque cashed ' + dmyOf(x.date) : w.pending ? ', cheque of ₹ ' + w.pending.toLocaleString('en-IN') + ' not yet cashed' : '') });
  };
  for (const d of data.receipts || []) money(d, 'receipts', 'Receipt', 'cr');
  for (const d of data.purchaseBills || []) rows.push({ date: d.billDate || d.date, party: d.party, col: 'purchaseBills', docId: d.id, docNo: d.no + (d.billNo ? ' / ' + d.billNo : ''), narration: 'Purchase bill', dr: 0, cr: num(d.total) });
  // Job charges for work done at an agency are owed to that agency.
  for (const [col, st] of [['knitting', 'Knitting'], ['dyeing', 'Dyeing'], ['finishing', 'Finishing']]) {
    for (const d of data[col] || []) {
      const party = agencyParty(data, d.location);
      const kg = st === 'Dyeing' ? num(d.inQty) : num(d.outQty);
      if (party && num(d.labour)) rows.push({ date: d.date, party, col, docId: d.id, docNo: d.no, narration: STAGE_LABELS[st] + ' charges' + (d.lotNo ? ', lot ' + d.lotNo : '') + (kg ? ', ' + r3(kg) + ' kg' : ''), dr: 0, cr: num(d.labour) });
    }
  }
  for (const d of data.payments || []) money(d, 'payments', 'Payment', 'dr');
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return rows;
}

// How much of each sales invoice / purchase bill is still unpaid. Receipts naming an invoice settle
// that invoice first; everything else settles the oldest bills first (like the ageing).
// Returns { docId: { total, paid, due, status, dueDate } }.
function billStatus(data) {
  const out = {};
  const day = today();
  const parties = index(data.parties);
  const settle = (bills, pool, direct) => {
    const left = new Map(bills.map(b => [b, num(b.total)]));
    for (const [b, amt] of direct) { const x = bills.find(y => y.id === b); if (!x) { pool += amt; continue; } const take = Math.min(left.get(x), amt); left.set(x, left.get(x) - take); pool += amt - take; }
    for (const b of bills) { const take = Math.min(left.get(b), pool); left.set(b, left.get(b) - take); pool -= take; }
    return left;
  };
  const by = (arr, f) => { const m = {}; for (const x of arr) (m[f(x)] = m[f(x)] || []).push(x); return m; };
  const sortB = list => list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.no || '').localeCompare(b.no || ''));
  // customers
  const inv = by(data.invoices || [], d => d.party), rec = by(data.receipts || [], d => d.party);
  for (const [pid, list] of Object.entries(inv)) {
    const p = parties[pid] || {};
    const ob = num(p.openingBalance);
    const bills = sortB(list.map(d => ({ id: d.id, date: d.date, no: d.no, total: num(d.total), doc: d })));
    if (ob && p.openingType !== 'Cr') bills.unshift({ id: '_ob', date: '', total: ob });
    let pool = ob && p.openingType === 'Cr' ? ob : 0;
    const direct = [];
    // a cheque not yet cashed pays nothing yet
    for (const r of rec[pid] || []) { const amt = whenCounts(r).counted; if (!amt) continue; if (r.invoiceId) direct.push([r.invoiceId, amt]); else pool += amt; }
    const left = settle(bills, pool, direct);
    for (const b of bills) {
      if (!b.doc) continue;
      const due = r2(Math.max(0, left.get(b)));
      const dueDate = b.doc.dueDate || (num(p.creditDays) ? addDays(b.date, num(p.creditDays)) : '');
      const status = due < 0.5 ? 'Paid' : dueDate && dueDate < day ? 'Overdue' : due < b.total - 0.5 ? 'Part paid' : 'Unpaid';
      out[b.id] = { total: r2(b.total), paid: r2(b.total - due), due, status, dueDate };
    }
  }
  // suppliers: purchase bills and agency job charges, settled by payments
  const txns = partyTxns(data);
  for (const [pid, list] of Object.entries(by(txns.filter(t => t.party), t => t.party))) {
    const bills = list.filter(t => t.cr > 0 && t.col !== 'receipts').map(t => ({ id: t.col === 'purchaseBills' ? t.docId : '_' + t.col + t.docId, date: t.date, no: t.docNo, total: t.cr, bill: t.col === 'purchaseBills' }));
    if (!bills.some(b => b.bill)) continue;
    const pool = list.filter(t => t.dr > 0 && t.col !== 'invoices').reduce((s, t) => s + t.dr, 0);
    const left = settle(bills, pool, []);
    for (const b of bills) {
      if (!b.bill) continue;
      const due = r2(Math.max(0, left.get(b)));
      out[b.id] = { total: r2(b.total), paid: r2(b.total - due), due, status: due < 0.5 ? 'Paid' : due < b.total - 0.5 ? 'Part paid' : 'Unpaid', dueDate: '' };
    }
  }
  return out;
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

// Copies onto `to` the details that go with its way of paying (a cheque's no., date and bank; a UPI phone ...),
// trimmed, and drops the rest. A split entry keeps none (each part has its own); an unknown mode keeps them all.
function payKeep(to, from) {
  const keep = to.mode === 'Split' ? [] : PAY_DETAILS[to.mode];
  for (const k of PAY_DETAIL_KEYS) {
    const v = String(from[k] === undefined || from[k] === null ? '' : from[k]).trim();
    if (v && (!keep || keep.includes(k))) to[k] = v; else delete to[k];
  }
  return to;
}

function prepare(col, doc, data) {
  for (const k of Object.keys(doc)) if (k.startsWith('_')) delete doc[k];
  if (Array.isArray(doc.lines)) {
    doc.lines = doc.lines.filter(l => l && l.item).map(l => { const c = {}; for (const k of Object.keys(l)) if (!k.startsWith('_')) c[k] = l[k]; return c; });
  }
  // Roll weights typed as "20.2 + 50.3 + 39.5" set the kg and the number of rolls.
  const weighed = (o, qtyKey) => {
    if (String(o.rollWeights || '').trim() === '') { delete o.rollWeights; return; }
    const w = parseRolls(o.rollWeights);
    if (!w) return; // validate() explains the problem
    if (!w.length) { delete o.rollWeights; return; }
    o.rollWeights = fmtRolls(w); o[qtyKey] = r3(w.reduce((t, x) => t + x, 0)); o.rolls = w.length;
  };
  if (col === 'finishing') weighed(doc, 'outQty');
  for (const l of doc.lines || []) {
    if (col === 'stockAdjust' && num(l.qty) >= 0) weighed(l, 'qty'); else delete l.rollWeights;
    // Rolls picked on a challan / invoice / transfer: the roll count is the number of pieces
    // (validate() checks they add up to the line's kg).
    if (!Array.isArray(l.rollPick)) { delete l.rollPick; continue; }
    const p = l.rollPick.map(x => ({ no: Math.round(num(x && x.no)), kg: r3(num(x && x.kg)) })).filter(x => x.no > 0 && x.kg > 0);
    if (!p.length) { delete l.rollPick; continue; }
    l.rollPick = p; l.rolls = p.length;
  }
  lotNumbers(col, doc, data);
  const party = (data.parties || []).find(p => p.id === doc.party);
  applyTotals(col, doc, data.settings, party);
  // Money received or paid in more than one way (part cash, part bank): the parts add up to the amount.
  // The entry and each part keep the details of their way of paying (cheque no. and bank, UPI phone ...).
  if (col === 'receipts' || col === 'payments') {
    const parts = (Array.isArray(doc.parts) ? doc.parts : []).filter(p => p && num(p.amount) > 0)
      .map(p => payKeep({ mode: p.mode || '', bank: p.bank || '', amount: r2(num(p.amount)) }, p));
    if (parts.length) {
      doc.parts = parts; doc.amount = r2(parts.reduce((t, p) => t + p.amount, 0)); doc.mode = parts.length > 1 ? 'Split' : parts[0].mode; doc.bank = parts.length > 1 ? '' : parts[0].bank;
      // a single part is the entry itself: both carry the same details
      if (parts.length === 1) { payKeep(doc, Object.assign({}, doc, parts[0])); payKeep(parts[0], doc); }
    }
    else delete doc.parts;
    payKeep(doc, doc);
  }
  if (col === 'overheads' && (doc.toCost === undefined || doc.toCost === '')) doc.toCost = COST_CATEGORIES.includes(doc.category);
  if (col === 'attendance') doc.staff = (Array.isArray(doc.staff) ? doc.staff : []).filter(r => r && r.employee).map(r => ({ employee: r.employee, mark: r.mark || 'P', note: r.note || '' }));
  if (col === 'leads') {
    doc.followUps = (Array.isArray(doc.followUps) ? doc.followUps : []).filter(f => f && (f.date || f.notes || f.nextDate)).map(f => { const c = {}; for (const k of Object.keys(f)) if (!k.startsWith('_')) c[k] = f[k]; return c; });
    // the latest follow-up's "next follow-up" date becomes the lead's
    const last = doc.followUps.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).pop();
    if (last && last.nextDate) doc.nextDate = last.nextDate;
  }
  if (col === 'salary' && doc.kind === 'Advance') { delete doc.month; delete doc.advanceDeducted; }
  if (col === 'emiPayments' && !doc.forMonth) doc.forMonth = String(doc.date || '').slice(0, 7);
  if (col === 'bankEntries') {
    if (doc.kind === 'Cash deposit') doc.fromBank = 'CASH';
    if (doc.kind === 'Cash withdrawal') doc.toBank = 'CASH';
    if (['Bank charges', 'Other payment'].includes(doc.kind)) delete doc.toBank;
    if (['Interest received', 'Other receipt'].includes(doc.kind)) delete doc.fromBank;
  }
  return doc;
}

// The lot number is given once, when yarn or fabric comes in, and the same number follows it to the sale:
//   GRN / opening stock line  -> new lot L-0001 ... (left blank), or the lot number typed on the line
//   knitting                  -> the lot of the main yarn (the yarn line with the most kg)
//   dyeing, finishing         -> the lot taken in (no new number)
function lotNumbers(col, doc, data) {
  const old = doc.id ? (data[col] || []).find(r => r.id === doc.id) : null;
  const cat = id => ((data.items || []).find(i => i.id === id) || {}).category;
  let maker = null;
  const lots = () => (maker = maker || lotMaker(data, doc.date));
  const newLot = () => lots()();
  if (col === 'grn' || col === 'stockAdjust') {
    const bad = msg => { throw Object.assign(new Error(msg), { status: 400 }); };
    const oldLines = (old && old.lines) || [];
    const oldLots = new Set(oldLines.map(l => l.lot).filter(Boolean)), oldCustom = new Set(oldLines.filter(l => l.lotCustom).map(l => l.lot));
    // Entries saved before lot numbers were automatic may hold yarn without a lot: those lines stay as they were.
    const legacy = new Set(oldLines.filter(l => !l.lot).map(l => l.item));
    const blank = [], typed = [];
    for (const l of doc.lines || []) {
      l.lot = String(l.lot || '').trim();
      delete l.lotCustom;
      if (!LOT_CATEGORIES.includes(cat(l.item))) continue;
      if (col === 'stockAdjust' && !(num(l.qty) > 0)) continue; // a - line takes from the lot chosen
      // Keep the lot this entry already gave, or (opening stock) add to a lot that exists.
      if (l.lot && oldLots.has(l.lot)) { if (oldCustom.has(l.lot)) l.lotCustom = true; continue; }
      if (l.lot && col === 'stockAdjust' && lots().exists(l.lot)) continue;
      if (!l.lot && legacy.has(l.item)) continue;
      if (!l.lot) { blank.push(l); continue; }
      // A lot number typed by hand is used as it is (in capitals), once.
      l.lot = l.lot.replace(/\s+/g, ' ').toUpperCase();
      if (!LOT_OK.test(l.lot)) bad('Lot no "' + l.lot + '": use letters, digits, - / . _ and spaces only (up to 30)');
      if (lots().exists(l.lot)) bad('Lot no ' + l.lot + ' is already used. Leave the lot no blank for the next automatic number, or type another');
      l.lotCustom = true; typed.push(l.lot);
    }
    for (const t of typed) lots().reserve(t);
    for (const l of blank) l.lot = newLot(); // everything left blank: the next automatic numbers
    // A lot already taken further (issued, knitted, moved, sold) keeps its number.
    for (const lot of oldLots) if (!(doc.lines || []).some(l => l.lot === lot)) {
      const by = lotUsedBy(data, lot, doc.id);
      if (by) bad('Lot ' + lot + ' is already used in ' + by + ': its lot number cannot be changed or its line removed');
    }
  }
  if (col === 'knitting') {
    const yarnLot = mainLot(doc.lines);
    // Once its grey fabric has been dyed, moved or sold, a saved entry keeps its lot number.
    const keep = old && old.lotNo && lotUsed(data, old.lotNo, old.outItem, doc.id);
    doc.lotNo = keep ? old.lotNo : yarnLot || (old && old.lotNo) || newLot();
  }
  if (col === 'dyeing' || col === 'finishing') {
    // Entries saved before this rule may have given the output its own lot (L-0005-R): they keep it.
    if (old && old.outLot && old.outLot !== old.lotNo) doc.outLot = old.outLot; else delete doc.outLot;
  }
}

function validate(col, doc, data) {
  const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); };
  const isDoc = col in DOC_LABELS;
  if (isDoc) need(/^\d{4}-\d{2}-\d{2}$/.test(doc.date || ''), 'Date is required');
  if (isDoc && doc.clearedOn && (doc.mode === 'Cheque' || (Array.isArray(doc.parts) && doc.parts.some(p => p && p.mode === 'Cheque'))))
    need(doc.clearedOn >= (doc.paidOn || doc.date), 'The cheque cannot be cashed before the date of this entry: check "Cleared in bank on"');
  const lines = doc.lines || [];
  const rollsMsg = 'Roll weights: type the kg of each roll separated by + (for example 20.2 + 50.3 + 39.5)';
  if (doc.rollWeights !== undefined) need(parseRolls(doc.rollWeights), rollsMsg);
  for (const l of lines) if (l.rollWeights !== undefined) need(parseRolls(l.rollWeights), rollsMsg);
  lines.forEach((l, i) => {
    if (!l.rollPick) return;
    const kg = r3(l.rollPick.reduce((t, x) => t + x.kg, 0));
    need(Math.abs(kg - Math.abs(num(l.qty))) < 0.001, 'Line ' + (i + 1) + ': the rolls chosen add up to ' + kg + ' kg but the quantity is ' + num(l.qty) + ' kg');
  });
  const posLines = () => { need(lines.length > 0, 'Add at least one line item'); for (const l of lines) need(num(l.qty) > 0, 'Every line needs a quantity greater than zero'); };
  const bankOk = id => need(!id || (data.banks || []).some(b => b.id === id), 'Choose the bank or cash account from the list');
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
      need(doc.party, 'Party is required'); posLines();
      if ((col === 'deliveries' || (col === 'invoices' && !doc.challanId)) && doc.location) need(isGodown((data.locations || []).find(l => l.id === doc.location)), 'Goods are sold from the Finished Goods Store or another godown');
      break;
    case 'payments': case 'receipts': need(doc.party, 'Party is required'); need(num(doc.amount) > 0, 'Amount must be greater than zero'); bankOk(doc.bank); for (const p of doc.parts || []) { need(p.mode, 'Each part of the payment needs a mode'); bankOk(p.bank); } break;
    case 'overheads': need(doc.category, 'Category is required'); need(num(doc.amount) > 0, 'Amount must be greater than zero'); bankOk(doc.bank); break;
    case 'banks': unique('name', 'Account name'); need(['Cash', 'Bank'].includes(doc.type), 'Choose Cash or Bank'); break;
    case 'employees': need(String(doc.name || '').trim(), 'Employee name is required'); need(num(doc.salary) >= 0, 'Salary cannot be negative'); break;
    case 'loans': unique('name', 'Loan name'); need(num(doc.emi) > 0, 'EMI amount is required'); need(/^\d{4}-\d{2}-\d{2}$/.test(doc.firstEmi || ''), 'First EMI date is required'); bankOk(doc.bank); break;
    case 'leads': need(String(doc.name || '').trim(), 'Name of the customer / prospect is required'); break;
    case 'quotations': need(doc.party || String(doc.prospect || '').trim(), 'Choose the customer, or type the prospect\'s name'); posLines(); break;
    case 'jobStatus': need(doc.location, 'Choose the agency'); need(doc.lot, 'Choose the lot'); need(doc.status, 'Choose the status'); break;
    case 'bankEntries': {
      need(doc.kind, 'Choose the kind of entry'); need(num(doc.amount) > 0, 'Amount must be greater than zero');
      need(doc.fromBank || doc.toBank, 'Choose the account');
      if (doc.kind === 'Transfer') need(doc.fromBank && doc.toBank, 'Choose both accounts');
      need(doc.fromBank !== doc.toBank, 'From and To accounts must differ');
      bankOk(doc.fromBank); bankOk(doc.toBank);
      break;
    }
    case 'attendance':
      need((doc.staff || []).length, 'Add the staff');
      need(!(data.attendance || []).some(a => a.id !== doc.id && a.date === doc.date), 'Attendance for ' + doc.date + ' is already entered: open that entry to change it');
      break;
    case 'salary':
      need(doc.employee, 'Choose the employee'); need(['Salary', 'Advance'].includes(doc.kind), 'Choose Salary or Advance');
      if (doc.kind === 'Salary') { need(/^\d{4}-\d{2}$/.test(doc.month || ''), 'Choose the month the salary is for'); need(num(doc.amount) > 0 || num(doc.advanceDeducted) > 0, 'Enter the amount paid'); need(num(doc.advanceDeducted) >= 0, 'Advance recovered cannot be negative'); }
      else need(num(doc.amount) > 0, 'Amount must be greater than zero');
      bankOk(doc.bank);
      break;
    case 'emiPayments': need(doc.loan, 'Choose the loan'); need(num(doc.amount) > 0, 'Amount must be greater than zero'); bankOk(doc.bank); break;
    case 'powerBills': need(num(doc.amount) > 0, 'Bill amount is required'); need(/^\d{4}-\d{2}$/.test(doc.billMonth || ''), 'Choose the bill month'); if (doc.paidOn) need(/^\d{4}-\d{2}-\d{2}$/.test(doc.paidOn), 'Paid on is not a valid date'); bankOk(doc.bank); break;
    case 'labourPayments': need(STAGES.includes(doc.stage), 'Choose the process the labour was paid for'); need(num(doc.amount) > 0, 'Amount must be greater than zero'); bankOk(doc.bank); break;
    case 'transfers':
      need(doc.fromLoc && doc.toLoc, 'From and To locations are required'); need(doc.fromLoc !== doc.toLoc, 'From and To locations must differ'); posLines();
      if (doc.purpose === 'Godown Transfer') { const L = id => (data.locations || []).find(l => l.id === id); need(isGodown(L(doc.fromLoc)) && isGodown(L(doc.toLoc)), 'A godown transfer goes from one godown to another'); }
      break;
    case 'stockAdjust': need(doc.location, 'Location is required'); need(lines.length, 'Add at least one line'); for (const l of lines) need(num(l.qty) !== 0, 'Quantity cannot be zero'); break;
    case 'knitting':
      posLines();
      need(doc.outItem, 'Output grey fabric item is required'); need(num(doc.outQty) > 0, 'Output quantity is required'); break;
    case 'dyeing': case 'finishing':
      need(doc.inItem && doc.lotNo, 'Input item and lot are required'); need(num(doc.inQty) > 0, 'Input quantity is required');
      need(doc.outItem, 'Output item is required'); need(num(doc.outQty) > 0, 'Output quantity is required');
      for (const l of lines) need(num(l.qty) > 0, 'Every material line needs a quantity');
      break;
  }
  if (['knitting', 'dyeing', 'finishing'].includes(col)) {
    need(num(doc.wastageQty) >= 0, 'Wastage cannot be negative');
    const st = { knitting: 'Knitting', dyeing: 'Dyeing', finishing: 'Finishing' }[col];
    const loc = id => (data.locations || []).find(l => l.id === id);
    const partyOf = id => (data.parties || []).find(p => p.id === id);
    if (doc.location) {
      const l = loc(doc.location);
      need(l, 'Choose the agency or unit that did the work');
      // a saved entry keeps the place it already had, even if that agency no longer ticks this work
      const old = doc.id && (data[col] || []).find(r => r.id === doc.id);
      const oldLoc = old && (old.location || (col === 'knitting' ? 'KNIT' : 'DYE'));
      need(oldLoc === doc.location || doesWork(Object.assign({}, l, { inactive: false }), st, partyOf), l.name + ' does not do ' + STAGE_LABELS[st].toLowerCase() + ' work. Tick it on the party in Masters → Parties, or choose another agency.');
    }
    if (doc.outLoc) {
      need(loc(doc.outLoc), 'Choose where the output was sent');
      if (col === 'knitting') need(doc.outLoc !== 'FG', 'Grey fabric cannot go to the Finished Goods Store: send it to a dyeing agency, the Main Store, or keep it at the knitting agency');
      if (col === 'finishing') need(isGodown(loc(doc.outLoc)), 'Finished goods go to the Finished Goods Store or another godown');
    }
  }
}

const DOC_LABELS = {
  purchaseOrders: 'Purchase Order', grn: 'GRN', purchaseBills: 'Purchase Bill', payments: 'Payment',
  transfers: 'Transfer', stockAdjust: 'Stock Adjustment', knitting: 'Knitting', dyeing: 'Dyeing', finishing: 'Finishing',
  overheads: 'Expense', salesOrders: 'Sales Order', deliveries: 'Delivery Challan', invoices: 'Invoice', receipts: 'Receipt',
  labourPayments: 'Labour Payment',
  leads: 'Lead', quotations: 'Quotation', jobStatus: 'Status Update', bankEntries: 'Bank Entry', attendance: 'Attendance',
  salary: 'Salary', emiPayments: 'EMI Payment', powerBills: 'Electricity Bill',
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
  const { R, data, q, iName, iCat, iUnit, pName, lName, link, docName, stockRows, items, parties, machines, locs } = ctx;
  const agencyOf = id => (locs[id] && locs[id].party) || '';
  // Places where this stage of work is done: agencies that tick it, and own factories.
  const workPlaces = st => data.locations.filter(l => doesWork(Object.assign({}, l, { inactive: false }), st, id => parties[id])).map(l => l.id);
  // Godowns hold finished goods; stores and godowns are "ours", everything else is an agency or factory.
  const godowns = new Set(data.locations.filter(isGodown).map(l => l.id));
  const storeSide = id => id === 'STORE' || godowns.has(id) || (!!locs[id] && locs[id].type === 'Store' && !locs[id].party);
  const workPlace = id => !!locs[id] && !storeSide(id);
  const day = today();
  const dmy = s => s ? s.split('-').reverse().join('-') : '';

  // Material sent to agencies: transfers (yarn issue, grey for dyeing ...) and production output sent
  // straight on to the next agency. Material still at the agency is matched to the newest sends of the
  // same lot (older ones were worked first), which gives what is still pending from each send.
  function jobSends() {
    const kinds = { 'Yarn Issue': 'Yarn issue', 'Grey Transfer': 'Grey for dyeing' };
    const sends = [];
    for (const t of data.transfers) {
      if (!workPlace(t.toLoc)) continue;
      for (const l of t.lines || []) sends.push({ date: t.date || '', col: 'transfers', id: t.id, no: t.no, kind: kinds[t.purpose] || 'Transfer', agency: t.toLoc, item: l.item, lot: l.lot || '', qty: num(l.qty), rolls: num(l.rolls), expected: t.expectedDate || '', color: t.colorReq || '' });
    }
    for (const r of R.production) {
      if (!r.outLoc || r.outLoc === r.loc || !workPlace(r.outLoc)) continue;
      sends.push({ date: r.date || '', col: r.col, id: r.docId, no: r.docNo, kind: STAGE_LABELS[r.stage] + ' output', agency: r.outLoc, item: r.outItem, lot: r.outLot || '', qty: r.outQty, rolls: r.rolls, expected: '', color: r.color || '' });
    }
    const have = {};
    for (const s of stockRows()) if (s.qty > 0.0005 && workPlace(s.loc)) have[s.loc + '|' + s.item + '|' + s.lot] = s.qty;
    sends.sort((a, b) => b.date.localeCompare(a.date));
    for (const s of sends) {
      const k = s.agency + '|' + s.item + '|' + s.lot;
      const p = Math.min(s.qty, have[k] || 0);
      have[k] = (have[k] || 0) - p;
      const late = p > 0.0005 && s.expected && s.expected < day ? daysBetween(s.expected, day) : 0;
      Object.assign(s, { pending: r3(p), back: r3(s.qty - p), late,
        status: p <= 0.0005 ? 'Completed' : late ? 'Overdue ' + late + ' day' + (late === 1 ? '' : 's') : s.qty - p > 0.0005 ? 'Part done' : 'At agency' });
    }
    return sends.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Bank and cash accounts with their balance on `asOn` (all dates when blank).
  const acctName = id => id === '' ? 'Not assigned to an account' : ((data.banks || []).find(b => b.id === id) || {}).name || id;
  function balances(asOn) {
    const bal = {};
    for (const b of data.banks || []) bal[b.id] = 0;
    for (const t of cashTxns(data)) if (!asOn || !t.date || t.date <= asOn) bal[t.account] = (bal[t.account] || 0) + t.in - t.out;
    return bal;
  }

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

  const qsOf = o => { const p = Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); return p ? '?' + p : ''; };

  // Labour in date order: earned on production entries, paid by labour payments. Anything dated before
  // the "count labour payable from" date in Settings is treated as already settled.
  function labourEvents() {
    const start = data.settings.labourFrom || '';
    const docs = { knitting: index(data.knitting), dyeing: index(data.dyeing), finishing: index(data.finishing) };
    const ev = [];
    R.production.forEach((r, i) => {
      if (!num(r.labour) || (start && r.date < start) || agencyOf(r.loc)) return; // agencies: in their party ledger
      const d = docs[r.col][r.docId] || {};
      const kg = r.stage === 'Dyeing' ? r.inQty : r.outQty;
      ev.push({ date: r.date || '', stage: r.stage, doc: docName(r.col) + ' ' + (r.docNo || ''), lot: r.lot || '', kg, rate: num(d.labourRate) || (kg ? r.labour / kg : 0), earned: r.labour, paid: 0, paidTo: '', _link: link(r.col, r.docId), o: i });
    });
    (data.labourPayments || []).forEach((p, j) => {
      if (start && p.date < start) return;
      ev.push({ date: p.date || '', stage: p.stage, doc: 'Payment ' + (p.no || ''), lot: '', kg: 0, rate: 0, earned: 0, paid: num(p.amount), paidTo: [p.paidTo, p.mode].filter(Boolean).join(' · '), _link: link('labourPayments', p.id), o: 1e6 + j });
    });
    return ev.sort((a, b) => a.date.localeCompare(b.date) || a.o - b.o);
  }

  return {
    stockChoices() {
      const rows = [];
      for (const s of R.keys.values()) {
        const qty = s.layers.reduce((a, l) => a + l.qty, 0) - s.neg;
        if (Math.abs(qty) > EPS) rows.push(Object.assign({ item: s.item, loc: s.loc, lot: s.lot, qty: r3(qty), rolls: s.rolls + s.bag.length }, s.bag.length ? { bag: s.bag.map(r => ({ no: r.no, kg: r.kg })) } : {}));
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
          const s = m.get(k) || { item: r.item, loc: r.loc, lot: '', qty: 0, value: 0, rolls: 0, weights: [] };
          s.qty += r.qty; s.value += r.value; s.rolls += r.rolls; m.set(k, s);
        }
        rows = [...m.values()];
      }
      if (!q.zero) rows = rows.filter(r => Math.abs(r.qty) > 0.0005);
      const out = rows.map(r => ({
        item: iName(r.item), category: iCat(r.item), location: lName(r.loc), lot: r.lot, color: r.lot ? R.colorOf[r.item + '|' + r.lot] || '' : '',
        qty: r3(r.qty), unit: iUnit(r.item), rolls: Math.round(r.rolls), avg: Math.round(r.rolls) > 0 ? r2(r.qty / Math.round(r.rolls)) : '', weights: fmtRolls(r.weights), value: r2(r.value), rate: r.qty ? r2(r.value / r.qty) : 0,
        reorder: items[r.item] && num(items[r.item].reorderLevel) && r.qty < num(items[r.item].reorderLevel) ? 'Below reorder' : '',
      })).sort((a, b) => a.location.localeCompare(b.location) || a.item.localeCompare(b.item) || a.lot.localeCompare(b.lot));
      const anyWeights = out.some(r => r.weights);
      return {
        title: 'Stock Summary' + (q.asOn ? ' as on ' + q.asOn : ''),
        note: 'Valuation method: ' + (R.method === 'FIFO' ? 'FIFO' : 'Weighted average') + '. Lots are valued at their exact accumulated cost. Rolls are counted as an average: kg taken from a lot take its rolls in proportion (Avg Kg / Roll).' + (anyWeights ? ' Roll weights are the kg left on each roll; a cut roll shows what remains of it.' : ''),
        columns: [C('location', 'Location'), C('item', 'Item'), C('category', 'Category'), C('lot', 'Lot / Batch'), C('color', 'Color'), C('qty', 'Qty', 'qty', true), C('unit', 'Unit'), C('rolls', 'Rolls', 'int', true), C('avg', 'Avg Kg / Roll', 'qty')]
          .concat(anyWeights ? [C('weights', 'Roll weights (kg)')] : [], [C('rate', 'Avg Rate', 'money'), C('value', 'Value', 'money', true), C('reorder', 'Alert', 'flag')]),
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
      const rows = R.production.filter(r => inRange(r.date, q) && (!q.stage || r.stage === q.stage) && (!q.location || r.loc === q.location)).map(r => ({
        date: r.date, stage: r.stage, doc: r.docNo, lot: r.outLot, agency: lName(r.loc), sentTo: lName(r.outLoc), inItem: iName(r.inItem), outItem: iName(r.outItem),
        machine: machines[r.machine] ? machines[r.machine].code : '', inQty: r3(r.inQty), outQty: r3(r.outQty), rolls: r.rolls,
        wastageQty: r3(r.wastageQty), wastPct: r.inQty ? r2(r.wastageQty / r.inQty * 100) : 0, processLoss: r3(r.processLoss),
        labour: r2(r.labour), outValue: r2(r.outValue), rate: r.outQty ? r2(r.outValue / r.outQty) : 0, _link: link(r.col, r.docId),
      })).sort((a, b) => a.date.localeCompare(b.date));
      return {
        title: 'Production Report',
        columns: [C('date', 'Date', 'date'), C('stage', 'Stage'), C('doc', 'Entry No'), C('lot', 'Lot'), C('agency', 'Agency / Unit'), C('inItem', 'Input'), C('outItem', 'Output'), C('sentTo', 'Sent To'), C('inQty', 'Input Kg', 'qty', true), C('outQty', 'Output Kg', 'qty', true), C('rolls', 'Rolls', 'int', true), C('wastageQty', 'Wastage Kg', 'qty', true), C('wastPct', 'Wastage %', 'pct'), C('processLoss', 'Process Loss Kg', 'qty', true), C('labour', 'Job / Labour Charges', 'money', true), C('outValue', 'Output Value', 'money', true), C('rate', 'Cost/Kg', 'money')],
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
        note: 'Total = Raw material (yarn + dyes & chemicals + packing) + Job / labour charges (knitting + dyeing + finishing) + Overheads + Wastage. Overheads are absorbed per kg finished in the same month.',
        columns: [C('date', 'Finished', 'date'), C('lot', 'Lot'), C('item', 'Item'), C('color', 'Color'), C('qty', 'FG Kg', 'qty', true), C('rolls', 'Rolls', 'int', true),
          C('yarn', 'Yarn', 'money', true), C('dyes', 'Dyes & Chem', 'money', true), C('packing', 'Packing', 'money', true),
          C('knitLabour', 'Knitting Charges', 'money', true), C('dyeLabour', 'Dyeing Charges', 'money', true), C('finLabour', 'Finishing Charges', 'money', true),
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
        columns: [C('item', 'Item'), C('lots', 'Lots', 'int', true), C('qty', 'FG Kg', 'qty', true), C('rolls', 'Rolls', 'int', true), C('rmKg', 'Material / Kg', 'money'), C('labourKg', 'Job Charges / Kg', 'money'), C('ohKg', 'Overhead / Kg', 'money'), C('wastKg', 'Wastage / Kg', 'money'), C('totalKg', 'Cost / Kg', 'money'), C('total', 'Total Cost', 'money', true)],
        rows,
      };
    },

    lots() {
      const fgSold = {}, fgIn = {}, left = {};
      for (const r of R.ledger) {
        if (!r.lot) continue;
        left[r.lot] = (left[r.lot] || 0) + r.qin - r.qout;
        if (!godowns.has(r.loc)) continue;
        if (r.col === 'deliveries' || r.col === 'invoices') fgSold[r.lot] = (fgSold[r.lot] || 0) + r.qout;
        fgIn[r.lot] = (fgIn[r.lot] || 0) + r.qin - r.qout;
      }
      const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
      const rows = Object.values(R.lotInfo).filter(t => !q.lot || t.lot.toLowerCase().includes(q.lot.toLowerCase())).map(t => {
        const b = t.buy, k = t.knit, d = t.dye, f = t.fin;
        const lotsOf = [...new Set([t.lot].concat(f.map(x => x.outLot)))];
        const yarn = sum(k, 'inQty'), fg = sum(f, 'outQty');
        const sold = lotsOf.reduce((s, l) => s + (fgSold[l] || 0), 0);
        const inStock = lotsOf.reduce((s, l) => s + (fgIn[l] || 0), 0);
        let status = 'In store';
        if (k.length) status = 'Knitted';
        if (d.length) status = 'Dyed';
        if (f.length) status = 'Finished';
        if ((f.length || sold > 0) && inStock < 0.001) status = 'Sold out';
        else if (!k.length && !sold && (left[t.lot] || 0) < 0.001) status = 'Used up';
        const first = a => a.length ? a[0].date : '';
        return {
          lot: t.lot, status, supplier: [...new Set(b.map(x => pName(x.party)).filter(Boolean))].join(', ') || (b.length ? 'Opening stock' : ''),
          recdDate: first(b), recdQty: r3(sum(b, 'qty')),
          knitDate: first(k), yarnIn: r3(yarn), greyOut: r3(sum(k, 'outQty')), knitWaste: r3(sum(k, 'wastageQty')),
          dyeDate: first(d), color: d.map(x => x.color).filter(Boolean).join(', '), dyeIn: r3(sum(d, 'inQty')), dyeOut: r3(sum(d, 'outQty')), dyeWaste: r3(sum(d, 'wastageQty')),
          finDate: first(f), finIn: r3(sum(f, 'inQty')), fgOut: r3(fg), finWaste: r3(sum(f, 'wastageQty')),
          yieldPct: yarn && fg ? r2(fg / yarn * 100) : 0, sold: r3(sold), inStock: r3(inStock),
        };
      }).sort((a, b) => (b.recdDate || b.knitDate || '').localeCompare(a.recdDate || a.knitDate || '') || b.lot.localeCompare(a.lot));
      return {
        title: 'Batch / Lot Tracking',
        note: 'Follows each lot number from the GRN through knitting, dyeing and finishing to sales. The lot number never changes. Yield = finished kg / yarn kg knitted.',
        columns: [C('lot', 'Lot'), C('status', 'Status', 'flag'), C('supplier', 'Supplier'), C('recdDate', 'Received', 'date'), C('recdQty', 'Recd Kg', 'qty', true), C('knitDate', 'Knitted', 'date'), C('yarnIn', 'Yarn Kg', 'qty', true), C('greyOut', 'Grey Kg', 'qty', true), C('knitWaste', 'Knit Waste', 'qty', true),
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
      const chq = pendingCheques(data).filter(c => c.d.party === q.party);
      for (const r of partyTxns(data).filter(r => r.party === q.party)) {
        if (q.from && r.date && r.date < q.from) { bal += r.dr - r.cr; continue; }
        if (q.to && r.date > q.to) continue;
        if (!rows.length && q.from) rows.push({ date: q.from, doc: '', narration: 'Opening balance', dr: 0, cr: 0, balance: r2(Math.abs(bal)), drcr: bal >= 0 ? 'Dr' : 'Cr' });
        bal += r.dr - r.cr;
        rows.push({ date: r.date, doc: r.docNo, narration: r.narration, dr: r2(r.dr), cr: r2(r.cr), balance: r2(Math.abs(bal)), drcr: bal >= 0 ? 'Dr' : 'Cr', _link: r.col === 'parties' ? '' : link(r.col, r.docId) });
      }
      return {
        title: 'Party Ledger - ' + pName(q.party),
        note: 'Dr balance = party owes us. Cr balance = we owe the party.' + (chq.length ? ' Not counted yet, cheque' + (chq.length === 1 ? '' : 's') + ' not cashed: ' +
          chq.map(c => (c.p.refNo ? 'no. ' + c.p.refNo + ' ' : '') + '₹ ' + c.amount.toLocaleString('en-IN') + ' (' + (c.d.no || '') + ')').join(', ') + '.' : ''),
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
      const cats = {}, names = new Set();
      const put = (mo, cat, amt) => { names.add(cat); cats[mo + '|' + cat] = (cats[mo + '|' + cat] || 0) + amt; };
      for (const o of data.overheads) if (toCost(o)) put(o.date.slice(0, 7), o.category || 'Other', num(o.amount));
      for (const b of data.powerBills || []) if (b.toCost !== false) put(billMonth(b), 'Electricity bills', num(b.amount));
      const key = c => 'c_' + c.replace(/[^a-z0-9]/gi, '');
      const rows = [...months].filter(mo => mo && (!q.from || mo >= q.from.slice(0, 7)) && (!q.to || mo <= q.to.slice(0, 7))).sort().map(mo => {
        const total = R.ohByMonth[mo] || 0, kg = R.fgKgByMonth[mo] || 0;
        const r = { month: mo };
        for (const c of names) r[key(c)] = r2(cats[mo + '|' + c] || 0);
        return Object.assign(r, { total: r2(total), kg: r3(kg), rate: kg ? r2(total / kg) : 0, unabsorbed: kg ? 0 : r2(total) });
      });
      return {
        title: 'Overhead Absorption',
        note: 'Expenses marked "add to production cost" (and electricity bills) for a month are charged to the lots finished in that month, per kg. If nothing was finished, they stay unabsorbed.',
        columns: [C('month', 'Month')].concat([...names].sort().map(c => C(key(c), c, 'money', true)), [C('total', 'Total', 'money', true), C('kg', 'FG Kg', 'qty', true), C('rate', 'Rate / Kg', 'money'), C('unabsorbed', 'Unabsorbed', 'money', true)]),
        rows,
      };
    },

    negativeStock() {
      return {
        title: 'Stock Exceptions',
        columns: [C('date', 'Date', 'date'), C('doc', 'Document'), C('item', 'Item'), C('location', 'Location'), C('lot', 'Lot'), C('short', 'Short Qty', 'qty')],
        rows: R.errors.map(e => ({ date: e.date, doc: docName(e.col) + ' ' + (e.docNo || ''), item: iName(e.item), location: lName(e.loc), lot: e.lot + (e.roll ? ' (roll ' + e.roll + ')' : ''), short: e.short, _link: link(e.col, e.docId) })),
      };
    },

    partyBalance() {
      const bal = partyBalances(data);
      const pending = pendingCheques(data).filter(c => c.d.party === q.party).reduce((t, c) => t + c.amount, 0);
      return { balance: r2(bal[q.party] || 0), pending: r2(pending) };
    },

    cheques() {
      const list = pendingCheques(data).filter(c => (!q.party || c.d.party === q.party) && (!q.account || (c.p.bank || (data.settings || {}).defaultBank || '') === q.account));
      const tot = inward => r2(list.filter(c => c.inward === inward).reduce((t, c) => t + c.amount, 0));
      return {
        title: 'Cheques Not Yet Cashed',
        note: 'A cheque counts only once it is cashed. Until then the customer still owes it, the supplier is still owed, the bill stays unpaid and the bank balance does not include it. When it shows in the bank statement, open the entry and fill in "Cleared in bank on".',
        cards: [{ label: 'Received, not cashed', value: tot(true), type: 'money' }, { label: 'Given, not cashed', value: tot(false), type: 'money' }, { label: 'Cheques', value: list.length, type: 'int' }],
        columns: [C('kind', 'Received / Given'), C('date', 'Date', 'date'), C('doc', 'Entry'), C('party', 'From / To'), C('chq', 'Cheque No'), C('chqDate', 'Cheque Date', 'date'), C('bank', 'Bank'), C('amount', 'Amount', 'money', true), C('days', 'Days Waiting', 'int')],
        rows: list.map(c => ({ kind: c.inward ? 'Received' : 'Given', date: c.date, doc: c.d.no || '', party: c.party, chq: c.p.refNo || '', chqDate: c.p.chequeDate || '', bank: c.p.payBank || '', amount: c.amount, days: daysBetween(c.date, day), _link: link(c.col, c.d.id) })),
      };
    },

    // Labour earned on production entries (rate x kg) against labour payments, per process.
    labourPayable() {
      const from = q.from || '', to = q.to || '9999-12-31';
      const stages = STAGES.filter(s => !q.stage || s === q.stage);
      const ev = labourEvents();
      const sum = {};
      for (const s of stages) sum[s] = { stage: STAGE_LABELS[s], kg: 0, opening: 0, earned: 0, paid: 0, closing: 0, _link: '#/report/labourPayable' + qsOf(Object.assign({}, q, { stage: s })) };
      for (const e of ev) if (sum[e.stage] && e.date < from) sum[e.stage].opening += e.earned - e.paid;
      const bal = {};
      const rows = [];
      for (const st of stages) {
        bal[st] = sum[st].opening;
        if (Math.abs(bal[st]) > 0.005) rows.push({ date: from, stage: STAGE_LABELS[st], doc: 'Opening balance', balance: r2(bal[st]) });
      }
      for (const e of ev) {
        const s = sum[e.stage];
        if (!s || e.date < from || e.date > to) continue;
        s.kg += e.kg; s.earned += e.earned; s.paid += e.paid;
        bal[e.stage] += e.earned - e.paid;
        rows.push({ date: e.date, stage: s.stage, doc: e.doc, lot: e.lot, kg: e.kg ? r3(e.kg) : '', rate: e.rate ? r2(e.rate) : '', paidTo: e.paidTo, earned: e.earned ? r2(e.earned) : '', paid: e.paid ? r2(e.paid) : '', balance: r2(bal[e.stage]), _link: e._link });
      }
      const summary = stages.map(st => { const s = sum[st]; return Object.assign(s, { kg: r3(s.kg), opening: r2(s.opening), earned: r2(s.earned), paid: r2(s.paid), closing: r2(s.opening + s.earned - s.paid) }); });
      const total = summary.reduce((t, s) => t + s.closing, 0);
      const start = data.settings.labourFrom;
      return {
        title: 'Labour Payable' + (q.stage ? ' - ' + STAGE_LABELS[q.stage] : ''),
        note: 'Labour for your own factory is earned on each production entry (knitting and finishing on output kg, dyeing on input kg) and reduced by Labour Payments. Work done by agencies is not here: their job charges are in each agency\'s Party Ledger and are paid in Supplier Payments. ' +
          (start ? 'Counted from ' + start.split('-').reverse().join('-') + ' (set in Settings).' : 'Counted from the first production entry; an administrator can set a start date in Settings.'),
        cards: summary.map(s => ({ label: s.stage + ' payable', value: s.closing, type: 'money' })).concat(stages.length > 1 ? [{ label: 'Total labour payable', value: r2(total), type: 'money' }] : []),
        tables: [
          { title: 'Payable by process' + (q.to ? ' as on ' + q.to.split('-').reverse().join('-') : ''),
            columns: [C('stage', 'Process'), C('kg', 'Kg worked', 'qty', true), C('opening', 'Opening payable', 'money', true), C('earned', 'Labour earned', 'money', true), C('paid', 'Paid', 'money', true), C('closing', 'Payable now', 'money', true)],
            rows: summary },
          { title: 'Labour ledger',
            columns: [C('date', 'Date', 'date'), C('stage', 'Process'), C('doc', 'Entry'), C('lot', 'Lot'), C('kg', 'Kg', 'qty', true), C('rate', 'Rate / kg', 'money'), C('paidTo', 'Paid to'), C('earned', 'Earned', 'money', true), C('paid', 'Paid', 'money', true), C('balance', 'Process balance', 'money')],
            rows },
        ],
      };
    },

    // Still payable for one process (shown on the labour payment form).
    labourBalance() {
      const ev = labourEvents().filter(e => e.stage === q.stage);
      return { payable: r2(ev.reduce((t, e) => t + e.earned - e.paid, 0)) };
    },

    // A lot number typed on a GRN or opening stock line, checked before it is used: is it allowed, is it
    // new, or where is it used already? `self` = the entry being edited (its own lots are fine).
    lotCheck() {
      const lot = String(q.lot || '').trim().replace(/\s+/g, ' ').toUpperCase();
      const next = lotMaker(data, q.date)();
      const has = (d, up) => [d.lotNo, d.outLot].concat((d.lines || []).map(l => l.lot)).some(v => v && (up ? String(v).toUpperCase() : v) === lot);
      if (q.self && STOCK_COLS.some(c => (data[c] || []).some(d => d.id === q.self && has(d, true)))) return { lot, ok: true, own: true, next };
      if (!LOT_OK.test(lot)) return { lot, ok: false, problem: 'format', next };
      // name the entry that gave the lot first (GRN, opening stock), then any other
      for (const c of ['grn', 'stockAdjust'].concat(STOCK_COLS.filter(x => x !== 'grn' && x !== 'stockAdjust'))) for (const d of data[c] || []) {
        if (d.id === q.self || !has(d, true)) continue;
        const l = (d.lines || []).find(x => String(x.lot || '').toUpperCase() === lot);
        const item = l ? l.item : d.outItem || d.inItem;
        return { lot, ok: false, problem: 'used', usedIn: (c === 'grn' ? '' : (DOC_LABELS[c] || c) + ' ') + (d.no || '') + (item ? ', ' + iName(item) : ''), next };
      }
      return { lot, ok: true, next };
    },

    nextLot() {
      const next = lotMaker(data, q.date), lots = [];
      for (let i = 0; i < Math.min(50, Math.max(1, num(q.count) || 1)); i++) lots.push(next());
      return { lot: lots[0], lots };
    },

    // One line per agency (and own factory): material lying there now, work done in the period,
    // job charges, and what the agency is owed.
    agencies() {
      const bal = partyBalances(data);
      const lying = {};
      for (const s of stockRows()) {
        if (!(s.qty > 0.0005)) continue;
        const e = lying[s.loc] || (lying[s.loc] = { yarn: 0, grey: 0, dyed: 0, other: 0, value: 0 });
        const k = { 'Yarn': 'yarn', 'Grey Fabric': 'grey', 'Colored Fabric': 'dyed' }[iCat(s.item)] || 'other';
        e[k] += s.qty; e.value += s.value;
      }
      const work = {};
      for (const r of R.production) {
        if (!inRange(r.date, q)) continue;
        const e = work[r.loc] || (work[r.loc] = { entries: 0, inQty: 0, outQty: 0, waste: 0, charges: 0 });
        e.entries++; e.inQty += r.inQty; e.outQty += r.outQty; e.waste += r.wastageQty; e.charges += r.labour;
      }
      const sent = {}, late = {};
      for (const s of jobSends()) {
        if (inRange(s.date, q)) sent[s.agency] = (sent[s.agency] || 0) + s.qty;
        if (s.late) late[s.agency] = (late[s.agency] || 0) + 1;
      }
      const places = data.locations.filter(l => l.party || ['Factory', 'Job Worker'].includes(l.type));
      const rows = places.map(l => {
        const s = lying[l.id] || { yarn: 0, grey: 0, dyed: 0, other: 0, value: 0 }, w = work[l.id] || { entries: 0, inQty: 0, outQty: 0, waste: 0, charges: 0 };
        const p = l.party ? parties[l.party] : null;
        const does = p ? S_workOf(p) : STAGES.filter(st => doesWork(Object.assign({}, l, { inactive: false }), st, () => null));
        return {
          agency: l.name + (p ? '' : ' (own)'), work: (does.length ? does : STAGES).map(st => STAGE_LABELS[st]).join(', '),
          sent: r3(sent[l.id] || 0), late: late[l.id] || 0,
          yarn: r3(s.yarn), grey: r3(s.grey), dyed: r3(s.dyed), value: r2(s.value),
          entries: w.entries, inQty: r3(w.inQty), outQty: r3(w.outQty), wastPct: w.inQty ? r2(w.waste / w.inQty * 100) : 0, charges: r2(w.charges),
          payable: p ? r2(-(bal[l.party] || 0)) : 0, _keep: !!p || s.value || s.yarn + s.grey + s.dyed + s.other > 0.0005 || w.entries,
          _link: '#/report/stock?location=' + l.id,
        };
      }).filter(r => r._keep).map(r => { delete r._keep; return r; }).sort((a, b) => a.agency.localeCompare(b.agency));
      return {
        title: 'Agency Summary',
        note: 'Material sent to each agency in the period, the work it did and its wastage, what is lying there now, and what we owe it (job charges less payments, from its Party Ledger). Late = sends past their expected date with material still there. Click a line to see its lots.',
        columns: [C('agency', 'Agency / Unit'), C('work', 'Work'), C('sent', 'Kg Sent', 'qty', true), C('inQty', 'Kg Worked', 'qty', true), C('outQty', 'Kg Delivered', 'qty', true), C('wastPct', 'Wastage %', 'pct'), C('entries', 'Entries', 'int', true),
          C('yarn', 'Yarn There (kg)', 'qty', true), C('grey', 'Grey There (kg)', 'qty', true), C('dyed', 'Dyed There (kg)', 'qty', true), C('value', 'Value There', 'money', true), C('late', 'Late Sends', 'int', true),
          C('charges', 'Job Charges', 'money', true), C('payable', 'Payable Now', 'money', true)],
        rows,
      };
    },

    /* ================= Inventory ================= */

    // Opening, received, sent to agencies, used and closing stock per item (yarn by default).
    stockMovement() {
      const cat = q.category || 'Yarn';
      const m = new Map();
      for (const r of R.ledger) {
        if (iCat(r.item) !== cat || (q.item && r.item !== q.item) || (q.to && r.date > q.to)) continue;
        const e = m.get(r.item) || { item: r.item, open: 0, recd: 0, made: 0, sent: 0, back: 0, used: 0, sold: 0, adj: 0, store: 0, away: 0 };
        m.set(r.item, e);
        const net = r.qin - r.qout;
        if (storeSide(r.loc)) e.store += net; else e.away += net;
        if (q.from && r.date < q.from) { e.open += net; continue; }
        if (r.col === 'grn' || (r.col === 'stockAdjust' && net > 0)) e.recd += net;
        else if (r.col === 'transfers') { if (r.qin > 0) { if (storeSide(r.loc)) e.back += r.qin; else e.sent += r.qin; } }
        else if (['knitting', 'dyeing', 'finishing'].includes(r.col)) { if (r.qout > 0) e.used += r.qout; else e.made += r.qin; }
        else if (r.col === 'deliveries' || r.col === 'invoices') e.sold += r.qout;
        else e.adj += net;
      }
      const rows = [...m.values()].map(e => ({ item: iName(e.item), unit: iUnit(e.item), open: r3(e.open), recd: r3(e.recd), made: r3(e.made), sent: r3(e.sent), back: r3(e.back), used: r3(e.used), sold: r3(e.sold), adj: r3(e.adj), store: r3(e.store), away: r3(e.away), total: r3(e.store + e.away), _link: '#/report/stockLedger?item=' + e.item + (q.from ? '&from=' + q.from : '') + (q.to ? '&to=' + q.to : '') }))
        .filter(r => q.zero || [r.open, r.recd, r.made, r.used, r.sold, r.total].some(v => Math.abs(v) > 0.0005)).sort((a, b) => a.item.localeCompare(b.item));
      const yarn = cat === 'Yarn';
      const cols = [C('item', 'Item'), C('unit', 'Unit'), C('open', 'Opening', 'qty', true), C('recd', yarn ? 'Purchased' : 'Received', 'qty', true), C('made', 'Produced', 'qty', true),
        C('sent', yarn ? 'Sent to Knitting' : 'Sent to Agencies', 'qty', true), C('back', 'Returned', 'qty', true), C('used', yarn ? 'Used in Knitting' : 'Used in Production', 'qty', true), C('sold', 'Sold', 'qty', true), C('adj', 'Other / Adjusted', 'qty', true),
        C('store', yarn ? 'Available in Store' : 'In Store / Godowns', 'qty', true), C('away', yarn ? 'At Knitting Houses' : 'At Agencies', 'qty', true), C('total', 'Total Stock', 'qty', true)];
      const keep = ['item', 'unit', 'open', 'store', 'away', 'total'];
      return {
        title: (yarn ? 'Yarn' : cat) + ' Stock' + (q.from || q.to ? ' ' + (dmy(q.from) || 'start') + ' to ' + (dmy(q.to) || 'today') : ''),
        note: 'Opening + purchased (or produced) − used − sold ± adjustments = closing. Sent to agencies still counts as our stock: it is shown under "' + (yarn ? 'At Knitting Houses' : 'At Agencies') + '" until it is worked. Click a line for its stock ledger.',
        columns: cols.filter(c => keep.includes(c.k) || rows.some(r => Math.abs(r[c.k]) > 0.0005)),
        rows,
      };
    },

    // Which fabric is in which godown: kg and rolls per godown, side by side.
    godownStock() {
      const gd = data.locations.filter(isGodown).sort((a, b) => (a.id === 'FG' ? -1 : b.id === 'FG' ? 1 : a.name.localeCompare(b.name)));
      const m = new Map();
      for (const s of stockRows(q.asOn)) {
        if (!godowns.has(s.loc) || !(s.qty > 0.0005) || (q.item && s.item !== q.item) || (q.location && s.loc !== q.location)) continue;
        const k = q.group === 'item' ? s.item : s.item + '|' + s.lot;
        const e = m.get(k) || { item: s.item, lot: q.group === 'item' ? '' : s.lot, kg: {}, rolls: {} };
        e.kg[s.loc] = (e.kg[s.loc] || 0) + s.qty; e.rolls[s.loc] = (e.rolls[s.loc] || 0) + s.rolls; m.set(k, e);
      }
      const shown = gd.filter(g => !q.location || g.id === q.location);
      const rows = [...m.values()].map(e => {
        const r = { item: iName(e.item), lot: e.lot, color: e.lot ? R.colorOf[e.item + '|' + e.lot] || '' : '' };
        let kg = 0, rolls = 0;
        for (const g of shown) { r['k_' + g.id] = r3(e.kg[g.id] || 0); r['r_' + g.id] = Math.round(e.rolls[g.id] || 0); kg += e.kg[g.id] || 0; rolls += e.rolls[g.id] || 0; }
        return Object.assign(r, { kg: r3(kg), rolls: Math.round(rolls), avg: rolls ? r2(kg / rolls) : '' });
      }).sort((a, b) => a.item.localeCompare(b.item) || a.lot.localeCompare(b.lot));
      const cols = [C('item', 'Item'), C('lot', 'Lot'), C('color', 'Color')];
      for (const g of shown) cols.push(C('k_' + g.id, g.name + ' Kg', 'qty', true), C('r_' + g.id, 'Rolls', 'int', true));
      if (shown.length > 1) cols.push(C('kg', 'Total Kg', 'qty', true), C('rolls', 'Total Rolls', 'int', true));
      cols.push(C('avg', 'Avg Kg / Roll', 'qty'));
      return {
        title: 'Godown Stock' + (q.asOn ? ' as on ' + dmy(q.asOn) : ''),
        note: 'Godowns are the Finished Goods Store and every location of type Godown (Masters → Locations). Move stock between them with a Godown Transfer.',
        columns: q.group === 'item' ? cols.filter(c => c.k !== 'lot' && c.k !== 'color') : cols, rows,
      };
    },

    /* ================= Job work ================= */

    jobWork() {
      const all = jobSends();
      const sends = all.filter(s => inRange(s.date, q) && (!q.location || s.agency === q.location) && (q.all || s.pending > 0.0005));
      const open = all.filter(s => s.pending > 0.0005 && (!q.location || s.agency === q.location));
      return {
        title: 'Job Work Register',
        note: 'Material sent to agencies (yarn issues, grey fabric sent for dyeing, and output sent straight on to the next agency) and how much of it is still there. What is still at an agency is matched to its latest sends of the same lot. Put an expected date on the challan to see delays. Tick "Include completed" for the full history.',
        cards: [{ label: 'Open sends', value: open.length, type: 'int' }, { label: 'Kg still at agencies', value: r3(open.reduce((t, s) => t + s.pending, 0)), type: 'qty' }, { label: 'Overdue', value: open.filter(s => s.late).length, type: 'int' }],
        columns: [C('date', 'Sent On', 'date'), C('doc', 'Challan / Entry'), C('kind', 'Type'), C('agency', 'Agency'), C('item', 'Material'), C('lot', 'Lot'), C('color', 'Colour Wanted'), C('qty', 'Kg Sent', 'qty', true), C('rolls', 'Rolls', 'int', true),
          C('back', 'Kg Worked', 'qty', true), C('pending', 'Kg Still There', 'qty', true), C('expected', 'Expected By', 'date'), C('status', 'Status', 'flag')],
        rows: sends.reverse().map(s => ({ date: s.date, doc: s.no, kind: s.kind, agency: lName(s.agency), item: iName(s.item), lot: s.lot, color: s.color, qty: r3(s.qty), rolls: s.rolls || '', back: s.back, pending: s.pending, expected: s.expected, status: s.status, _link: link(s.col, s.id) })),
      };
    },

    // Lots of grey and dyed fabric at the agencies with their processing status, plus lots received back.
    processStatus() {
      const ORDER = ['Material sent', 'Processing started', 'Colouring', 'Finishing', 'Finished & ready', 'Received'];
      const MARK = { 'Material sent': '🟡', 'Processing started': '🔵', 'Colouring': '🟠', 'Finishing': '🟣', 'Finished & ready': '🟢', 'Received': '✅' };
      const arrived = {};
      for (const r of R.ledger) if (r.qin > 0 && workPlace(r.loc)) arrived[r.loc + '|' + r.item + '|' + r.lot] = r.date;
      const upd = {};
      for (const u of data.jobStatus.slice().sort(byDate)) upd[u.location + '|' + u.lot] = u;
      const rows = [];
      for (const s of stockRows()) {
        const cat = iCat(s.item);
        if (!(s.qty > 0.0005) || !workPlace(s.loc) || !['Grey Fabric', 'Colored Fabric'].includes(cat) || (q.location && s.loc !== q.location)) continue;
        const since = arrived[s.loc + '|' + s.item + '|' + s.lot] || '';
        const u = upd[s.loc + '|' + s.lot];
        const manual = u && (!since || u.date >= since) ? u : null;
        const st = manual ? manual.status : cat === 'Grey Fabric' ? 'Material sent' : 'Finishing';
        rows.push({ o: ORDER.indexOf(st), status: (MARK[st] || '') + ' ' + st, lot: s.lot, item: iName(s.item), color: R.colorOf[s.item + '|' + s.lot] || '', agency: lName(s.loc), qty: r3(s.qty), rolls: Math.round(s.rolls), since, days: since ? daysBetween(since, day) : '',
          update: manual ? dmy(manual.date) + (manual.remarks ? ': ' + manual.remarks : '') : cat === 'Grey Fabric' ? 'grey fabric arrived' : 'dyed, waiting to be finished',
          _link: '#/edit/jobStatus/new?location=' + encodeURIComponent(s.loc) + '&lot=' + encodeURIComponent(s.lot) });
      }
      const from = q.from || addDays(day, -14), to = q.to || day;
      const fin = index(data.finishing);
      for (const f of R.fgLots) {
        const d = fin[f.docId] || {};
        if (f.date < from || f.date > to || (q.location && (d.location || 'DYE') !== q.location)) continue;
        rows.push({ o: 5, status: '✅ Received', lot: f.lot, item: iName(f.item), color: f.color, agency: lName(d.location || 'DYE'), qty: r3(f.qty), rolls: f.rolls, since: f.date, days: '', update: 'into ' + lName(d.outLoc || 'FG') + ' (' + f.docNo + ')', _link: link('finishing', f.docId) });
      }
      rows.sort((a, b) => a.o - b.o || String(a.since).localeCompare(String(b.since)));
      return {
        title: 'Processing Status',
        note: 'Grey and dyed fabric at the dyeing and finishing agencies, with lots received back from ' + dmy(from) + '. Status moves by itself when fabric is sent, dyed and received; click a lot to record a step in between (processing started, colouring, finished & ready).',
        cards: ORDER.slice(0, 5).map(st => ({ label: MARK[st] + ' ' + st, value: rows.filter(r => r.o === ORDER.indexOf(st)).length, type: 'int' })),
        columns: [C('status', 'Status', 'flag'), C('lot', 'Lot'), C('item', 'Fabric'), C('color', 'Colour'), C('agency', 'Agency'), C('qty', 'Kg', 'qty', true), C('rolls', 'Rolls', 'int', true), C('since', 'There Since', 'date'), C('days', 'Days', 'int'), C('update', 'Last Update')],
        rows: rows.map(r => { delete r.o; return r; }),
      };
    },

    /* ================= CRM ================= */

    customer() {
      if (!q.party) return { title: 'Customer Card', note: 'Choose a customer to see the profile, outstanding, sales history, open orders and follow-ups.', columns: [], rows: [] };
      const p = parties[q.party] || {};
      const st = billStatus(data);
      const bal = partyBalances(data)[q.party] || 0;
      const fy = (+day.slice(5, 7) >= 4 ? +day.slice(0, 4) : +day.slice(0, 4) - 1) + '-04-01';
      const inv = data.invoices.filter(d => d.party === q.party).sort(byDate).reverse();
      const rec = data.receipts.filter(d => d.party === q.party).sort(byDate).reverse();
      const overdue = inv.reduce((t, d) => t + ((st[d.id] || {}).status === 'Overdue' ? st[d.id].due : 0), 0);
      const sent = {};
      for (const c of data.deliveries) if (c.soId) for (const l of c.lines || []) sent[c.soId + '|' + l.item] = (sent[c.soId + '|' + l.item] || 0) + num(l.qty);
      const orders = [];
      for (const so of data.salesOrders) {
        if (so.party !== q.party || ['Closed', 'Cancelled'].includes(so.status)) continue;
        for (const l of so.lines || []) { const left = num(l.qty) - (sent[so.id + '|' + l.item] || 0); if (left > 0.0005) orders.push({ date: so.date, no: so.no, item: iName(l.item), color: l.color || '', pending: r3(left), rate: num(l.rate), due: so.deliveryDate || '', _link: link('salesOrders', so.id) }); }
      }
      const profile = [['Phone', p.phone], ['Contact person', p.contactPerson], ['Email', p.email], ['Address', [p.address, p.city].filter(Boolean).join(', ')], ['State', p.state], ['GSTIN', p.gstin || 'Unregistered'],
        ['Bank', [p.bankName, p.bankAccount && 'A/c ' + p.bankAccount, p.ifsc && 'IFSC ' + p.ifsc].filter(Boolean).join(', ')], ['UPI', p.upi],
        ['Credit limit', num(p.creditLimit) ? '₹ ' + r2(num(p.creditLimit)).toLocaleString('en-IN') : 'No limit'], ['Payment terms', p.paymentTerms || (num(p.creditDays) ? num(p.creditDays) + ' days credit' : '')]].filter(x => x[1]).map(([k, v]) => ({ k, v }));
      return {
        title: 'Customer Card - ' + (p.name || ''),
        cards: [{ label: bal >= 0 ? 'Outstanding (owes us)' : 'Advance (we owe)', value: r2(Math.abs(bal)), type: 'money' }, { label: 'Overdue', value: r2(overdue), type: 'money' },
          { label: 'Sales this FY (ex-GST)', value: r2(inv.filter(d => d.date >= fy).reduce((t, d) => t + num(d.taxable), 0)), type: 'money' }, { label: 'Invoices this FY', value: inv.filter(d => d.date >= fy).length, type: 'int' }]
          .concat(rec.some(d => whenCounts(d).pending) ? [{ label: 'Cheques not cashed (not counted)', value: r2(rec.reduce((t, d) => t + whenCounts(d).pending, 0)), type: 'money' }] : []),
        tables: [
          { title: 'Profile', columns: [C('k', 'Detail'), C('v', '')], rows: profile },
          { title: 'Invoices', columns: [C('date', 'Date', 'date'), C('no', 'Invoice'), C('total', 'Amount', 'money', true), C('paid', 'Paid', 'money', true), C('due', 'Balance', 'money', true), C('dueDate', 'Due Date', 'date'), C('status', 'Status', 'flag')],
            rows: inv.slice(0, 100).map(d => Object.assign({ date: d.date, no: d.no, _link: link('invoices', d.id) }, st[d.id] || {})) },
          { title: 'Payments received', columns: [C('date', 'Date', 'date'), C('no', 'Receipt'), C('mode', 'Mode'), C('detail', 'Cheque / UPI / bank details'), C('amount', 'Amount', 'money', true), C('status', 'Cheque', 'flag')],
            rows: rec.slice(0, 100).map(d => ({ date: d.date, no: d.no, mode: d.mode || '', detail: payDetail(d), amount: num(d.amount), _link: link('receipts', d.id),
              status: whenCounts(d).pending ? 'Not cashed' : (d.mode === 'Cheque' || (d.parts || []).some(p => p.mode === 'Cheque')) ? 'Cashed ' + dmy(d.clearedOn) : '' })) },
          { title: 'Open sales orders', columns: [C('date', 'Date', 'date'), C('no', 'Order'), C('item', 'Item'), C('color', 'Colour'), C('pending', 'Kg Pending', 'qty', true), C('rate', 'Rate', 'money'), C('due', 'Delivery By', 'date')], rows: orders },
          { title: 'Leads & follow-ups', columns: [C('date', 'Date', 'date'), C('no', 'Lead'), C('requirement', 'Requirement'), C('status', 'Status', 'flag'), C('nextDate', 'Next Follow-up', 'date')],
            rows: data.leads.filter(l => l.party === q.party).sort(byDate).reverse().map(l => ({ date: l.date, no: l.no, requirement: l.requirement || '', status: l.status || '', nextDate: l.nextDate || '', _link: link('leads', l.id) })) },
        ],
      };
    },

    followUps() {
      const done = ['Won', 'Lost'];
      const rows = data.leads.filter(l => q.all || !done.includes(l.status)).map(l => {
        const d = l.nextDate ? daysBetween(day, l.nextDate) : null;
        const last = (l.followUps || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).pop();
        return { nextDate: l.nextDate || '', when: done.includes(l.status) ? l.status : d === null ? 'No date set' : d < 0 ? 'Overdue ' + -d + ' day' + (d === -1 ? '' : 's') : d === 0 ? 'Due today' : 'In ' + d + ' day' + (d === 1 ? '' : 's'),
          o: d === null ? 9999 : d, no: l.no, name: l.name + (l.party ? '' : ''), phone: l.phone || '', city: l.city || '', requirement: [l.requirement, l.color, num(l.qty) ? num(l.qty) + ' kg' : ''].filter(Boolean).join(', '),
          status: l.status || 'New', assignedTo: l.assignedTo || '', last: last ? dmy(last.date) + ': ' + (last.notes || '') : '', _link: link('leads', l.id) };
      }).filter(r => !q.to || !r.nextDate || r.nextDate <= q.to).sort((a, b) => a.o - b.o);
      const month = day.slice(0, 7);
      return {
        title: 'Follow-ups',
        note: 'Open leads in order of their next follow-up. Record each call or visit on the lead with the next date.',
        cards: [{ label: 'Overdue', value: rows.filter(r => r.o < 0 && !done.includes(r.status)).length, type: 'int' }, { label: 'Due today', value: rows.filter(r => r.o === 0).length, type: 'int' },
          { label: 'Open leads', value: data.leads.filter(l => !done.includes(l.status)).length, type: 'int' }, { label: 'Won this month', value: data.leads.filter(l => l.status === 'Won' && String(l.updatedAt || l.date).slice(0, 7) === month).length, type: 'int' }],
        columns: [C('nextDate', 'Next Follow-up', 'date'), C('when', 'When', 'flag'), C('no', 'Lead'), C('name', 'Customer / Prospect'), C('phone', 'Phone'), C('city', 'City'), C('requirement', 'Requirement'), C('status', 'Stage'), C('assignedTo', 'Assigned To'), C('last', 'Last Follow-up')],
        rows: rows.map(r => { delete r.o; return r; }),
      };
    },

    // Paid / balance of every invoice and purchase bill (shown on their lists).
    billStatus() {
      return { bills: billStatus(data) };
    },

    /* ================= Bank, expenses, loans, bills ================= */

    bankBook() {
      const tx = cashTxns(data);
      const accts = (data.banks || []).slice().sort((a, b) => (a.id === 'CASH' ? -1 : b.id === 'CASH' ? 1 : a.name.localeCompare(b.name)));
      if (!q.account) {
        const s = {};
        const get = id => s[id] || (s[id] = { open: 0, in: 0, out: 0 });
        for (const a of accts) get(a.id);
        for (const t of tx) {
          if (q.to && t.date > q.to) continue;
          const e = get(t.account);
          if (q.from && t.date < q.from) e.open += t.in - t.out; else { e.in += t.in; e.out += t.out; }
        }
        const rows = Object.entries(s).filter(([id, e]) => id !== '' || e.in || e.out || e.open).map(([id, e]) => ({ account: acctName(id), type: id === '' ? '' : ((data.banks || []).find(b => b.id === id) || {}).type || '', open: r2(e.open), in: r2(e.in), out: r2(e.out), close: r2(e.open + e.in - e.out), _link: id ? '#/report/bankBook' + qsOf(Object.assign({}, q, { account: id })) : '' }));
        return {
          title: 'Bank & Cash Balances',
          note: 'Every receipt, payment, expense, salary, EMI, paid electricity bill and bank entry, by the account it went through. Cash goes to Cash in Hand by itself. Entries saved without an account are listed under "Not assigned": choose their account on the entry, or in Settings choose the bank they count in. Click an account for its book.',
          cards: [{ label: 'Total bank & cash', value: r2(rows.reduce((t, r) => t + r.close, 0)), type: 'money' }],
          columns: [C('account', 'Account'), C('type', 'Type'), C('open', 'Opening', 'money', true), C('in', 'Money In', 'money', true), C('out', 'Money Out', 'money', true), C('close', 'Closing Balance', 'money', true)],
          rows,
        };
      }
      const id = q.account === '-' ? '' : q.account;
      let bal = 0;
      const rows = [];
      for (const t of tx.filter(x => x.account === id)) {
        if (q.to && t.date > q.to) continue;
        if (q.from && t.date < q.from) { bal += t.in - t.out; continue; }
        if (!rows.length && q.from) rows.push({ date: q.from, doc: '', text: 'Opening balance', in: '', out: '', balance: r2(bal) });
        bal += t.in - t.out;
        rows.push({ date: t.date, doc: t.docNo, text: t.text, in: t.in || '', out: t.out || '', balance: r2(bal), cleared: t.opening ? '' : t.clearedOn, _link: t.col === 'banks' ? '#/edit/banks/' + t.docId : link(t.col, t.docId) });
      }
      return {
        title: 'Bank Book - ' + acctName(id),
        cards: [{ label: 'Balance', value: r2(bal), type: 'money' }],
        columns: [C('date', 'Date', 'date'), C('doc', 'Entry'), C('text', 'Particulars'), C('in', 'Money In', 'money', true), C('out', 'Money Out', 'money', true), C('balance', 'Balance', 'money'), C('cleared', 'Cleared in Bank', 'date')],
        rows,
      };
    },

    bankReco() {
      if (!q.account || q.account === 'CASH') return { title: 'Bank Reconciliation', note: 'Choose a bank account. Then, on each entry that has appeared in the bank statement, fill in "Cleared in bank on".', columns: [], rows: [] };
      const asOn = q.asOn || day;
      const tx = cashTxns(data).filter(t => t.account === q.account && (!t.date || t.date <= asOn));
      const books = tx.reduce((t, x) => t + x.in - x.out, 0);
      const open = tx.filter(t => !t.opening && (!t.clearedOn || t.clearedOn > asOn));
      const notIn = open.reduce((t, x) => t + x.in, 0), notOut = open.reduce((t, x) => t + x.out, 0);
      return {
        title: 'Bank Reconciliation - ' + acctName(q.account) + ' as on ' + dmy(asOn),
        note: 'Balance as per bank = balance as per our books − money received but not yet in the bank + payments not yet taken out. Compare it with the bank statement; open an entry to fill in the date it cleared. Cheques count in the books only once cashed, so they are not here: see Cheques Not Yet Cashed.',
        cards: [{ label: 'Balance as per books', value: r2(books), type: 'money' }, { label: 'Received, not yet in bank', value: r2(notIn), type: 'money' }, { label: 'Paid, not yet out of bank', value: r2(notOut), type: 'money' }, { label: 'Balance as per bank', value: r2(books - notIn + notOut), type: 'money' }],
        columns: [C('date', 'Date', 'date'), C('doc', 'Entry'), C('text', 'Particulars'), C('in', 'Not Yet Credited', 'money', true), C('out', 'Not Yet Debited', 'money', true), C('days', 'Days Pending', 'int')],
        rows: open.map(t => ({ date: t.date, doc: t.docNo, text: t.text, in: t.in || '', out: t.out || '', days: daysBetween(t.date, asOn), _link: link(t.col, t.docId) })),
      };
    },

    expenses() {
      const list = data.overheads.filter(o => inRange(o.date, q) && (!q.category || o.category === q.category));
      const by = {};
      for (const o of list) { const e = by[o.category] || (by[o.category] = { category: o.category, n: 0, amount: 0, cost: 0 }); e.n++; e.amount += num(o.amount); if (toCost(o)) e.cost += num(o.amount); }
      const other = [
        ['Salaries & advances', (data.salary || []).filter(d => inRange(d.date, q)).reduce((t, d) => t + num(d.amount), 0), '#/report/salaryRegister'],
        ['EMI payments', (data.emiPayments || []).filter(d => inRange(d.date, q)).reduce((t, d) => t + num(d.amount), 0), '#/report/loans'],
        ['Electricity bills paid', (data.powerBills || []).filter(d => d.paidOn && inRange(d.paidOn, q)).reduce((t, d) => t + (num(d.paidAmount) || num(d.amount)), 0), '#/report/powerBills'],
        ['Labour payments', (data.labourPayments || []).filter(d => inRange(d.date, q)).reduce((t, d) => t + num(d.amount), 0), '#/report/labourPayable'],
      ].filter(x => x[1] > 0);
      const total = list.reduce((t, o) => t + num(o.amount), 0);
      return {
        title: 'Expense Report',
        cards: [{ label: 'Expenses', value: r2(total), type: 'money' }, { label: 'Added to production cost', value: r2(list.filter(toCost).reduce((t, o) => t + num(o.amount), 0)), type: 'money' }].concat(q.category ? [] : [{ label: 'All spending incl. salary, EMI, bills', value: r2(total + other.reduce((t, x) => t + x[1], 0)), type: 'money' }]),
        tables: [
          { title: 'By head', columns: [C('category', 'Expense Head'), C('n', 'Entries', 'int', true), C('amount', 'Amount', 'money', true), C('cost', 'In Production Cost', 'money', true)],
            rows: Object.values(by).sort((a, b) => b.amount - a.amount).map(e => ({ category: e.category, n: e.n, amount: r2(e.amount), cost: r2(e.cost), _link: '#/report/expenses' + qsOf(Object.assign({}, q, { category: e.category })) }))
              .concat(q.category ? [] : other.map(([category, amount, href]) => ({ category, n: '', amount: r2(amount), cost: '', _link: href }))) },
          { title: 'Expense entries', columns: [C('date', 'Date', 'date'), C('no', 'Entry'), C('category', 'Head'), C('paidTo', 'Paid To'), C('account', 'Paid From'), C('cost', 'In Cost'), C('amount', 'Amount', 'money', true)],
            rows: list.sort(byDate).map(o => ({ date: o.date, no: o.no, category: o.category, paidTo: o.paidTo || '', account: acctName(o.bank || (o.mode === 'Cash' ? 'CASH' : '')), cost: toCost(o) ? 'Yes' : '', amount: num(o.amount), _link: link('overheads', o.id) })) },
        ],
      };
    },

    loans() {
      const rows = (data.loans || []).map(l => {
        const s = loanState(data, l, day);
        return { name: l.name, loanNo: l.loanNo || '', amount: num(l.amount), emi: num(l.emi), tenure: num(l.tenure) || '', count: s.count, left: s.left === null ? '' : s.left, paid: s.paidAmt, toPay: s.toPay, next: s.next, status: s.status, _link: '#/edit/loans/' + l.id };
      }).sort((a, b) => (a.next || '9').localeCompare(b.next || '9'));
      return {
        title: 'EMI & Loan Status',
        note: 'EMIs fall due every month from the first EMI date. Each EMI payment counts one EMI.',
        cards: [{ label: 'EMI per month', value: r2(rows.filter(r => r.status !== 'Closed').reduce((t, r) => t + r.emi, 0)), type: 'money' }, { label: 'Still to pay (EMIs left)', value: r2(rows.reduce((t, r) => t + r.toPay, 0)), type: 'money' },
          { label: 'Due in 3 days or late', value: rows.filter(r => /due today|due in [0-3] day|overdue/i.test(r.status)).length, type: 'int' }],
        columns: [C('name', 'Loan / Lender'), C('loanNo', 'Loan No'), C('amount', 'Loan Amount', 'money', true), C('emi', 'EMI', 'money', true), C('tenure', 'Tenure', 'int'), C('count', 'EMIs Paid', 'int'), C('left', 'EMIs Left', 'int'), C('paid', 'Paid So Far', 'money', true), C('toPay', 'Still to Pay', 'money', true), C('next', 'Next Due', 'date'), C('status', 'Status', 'flag')],
        rows,
      };
    },

    powerBills() {
      const rows = (data.powerBills || []).filter(b => (!q.from || billMonth(b) >= q.from.slice(0, 7)) && (!q.to || billMonth(b) <= q.to.slice(0, 7))).map(b => {
        const s = billState(b, day);
        return { month: billMonth(b), provider: b.provider || '', consumerNo: b.consumerNo || '', units: num(b.units) || '', amount: num(b.amount), dueDate: b.dueDate || '', paidOn: b.paidOn || '', paid: b.paidOn ? (num(b.paidAmount) || num(b.amount)) : '', status: s.status, o: b.paidOn ? 1 : 0, _link: link('powerBills', b.id) };
      }).sort((a, b) => a.o - b.o || b.month.localeCompare(a.month));
      const unpaid = rows.filter(r => !r.paidOn);
      return {
        title: 'Electricity Bills',
        cards: [{ label: 'Unpaid', value: r2(unpaid.reduce((t, r) => t + r.amount, 0)), type: 'money' }, { label: 'Overdue bills', value: unpaid.filter(r => /overdue/i.test(r.status)).length, type: 'int' }, { label: 'Billed in period', value: r2(rows.reduce((t, r) => t + r.amount, 0)), type: 'money' }],
        columns: [C('month', 'Bill Month'), C('provider', 'Provider'), C('consumerNo', 'Consumer No'), C('units', 'Units', 'int', true), C('amount', 'Bill Amount', 'money', true), C('dueDate', 'Due Date', 'date'), C('paidOn', 'Paid On', 'date'), C('paid', 'Paid', 'money', true), C('status', 'Status', 'flag')],
        rows: rows.map(r => { delete r.o; return r; }),
      };
    },

    /* ================= Staff & salary ================= */

    salaryRegister() {
      const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : day.slice(0, 7);
      const rows = (data.employees || []).filter(e => e.active !== false || data.salary.some(s => s.employee === e.id && s.month === month)).filter(e => !q.department || e.department === q.department).map(e => {
        const c = salaryCalc(data, e.id, month);
        const adv = (data.salary || []).filter(s => s.employee === e.id && s.kind === 'Advance' && String(s.date).startsWith(month)).reduce((t, s) => t + num(s.amount), 0);
        return { name: e.name, department: e.department || '', basis: e.basis === 'Daily' ? 'Daily ₹' + num(e.salary) : 'Monthly', salary: num(e.salary), present: c.marks.P, half: c.marks.H, absent: c.marks.A, leave: c.marks.L + c.marks.O, paidDays: c.paidDays,
          due: c.due, adv: r2(adv), deducted: c.deducted, paid: c.paid, balance: c.balance, advLeft: advanceLeft(data, e.id), _link: '#/edit/employees/' + e.id };
      }).sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
      return {
        title: 'Salary Register - ' + month,
        note: 'Monthly staff: salary × days paid ÷ days in the month (absent days and half of each half day are not paid; days not marked count as worked). Daily staff: daily rate × days marked present, paid leave or holiday (half days count half). Balance = salary due − paid − advance recovered.',
        cards: [{ label: 'Salary due', value: r2(rows.reduce((t, r) => t + r.due, 0)), type: 'money' }, { label: 'Paid', value: r2(rows.reduce((t, r) => t + r.paid, 0)), type: 'money' }, { label: 'Balance payable', value: r2(rows.reduce((t, r) => t + r.balance, 0)), type: 'money' }, { label: 'Advances outstanding', value: r2(rows.reduce((t, r) => t + r.advLeft, 0)), type: 'money' }],
        columns: [C('name', 'Employee'), C('department', 'Department'), C('basis', 'Basis'), C('salary', 'Salary / Rate', 'money'), C('present', 'Present', 'int', true), C('half', 'Half Days', 'int', true), C('absent', 'Absent', 'int', true), C('leave', 'Leave / Off', 'int', true), C('paidDays', 'Days Paid', 'qty', true),
          C('due', 'Salary Due', 'money', true), C('adv', 'Advance Given', 'money', true), C('deducted', 'Advance Recovered', 'money', true), C('paid', 'Paid', 'money', true), C('balance', 'Balance', 'money', true), C('advLeft', 'Advance Outstanding', 'money', true)],
        rows,
      };
    },

    // Shown on the salary form: what is due for the month and the advance still to recover.
    salaryDue() {
      if (!q.employee) return {};
      const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : day.slice(0, 7);
      const c = salaryCalc(data, q.employee, month);
      // this entry's own payment counts as unpaid while it is being edited
      const self = q.id ? (data.salary || []).find(s => s.id === q.id && s.month === month && s.kind !== 'Advance') : null;
      const back = self ? num(self.amount) + num(self.advanceDeducted) : 0;
      return { due: c.due, paidDays: c.paidDays, days: c.days, balance: r2(c.balance + back), advance: r2(advanceLeft(data, q.employee) + (self ? num(self.advanceDeducted) : 0)) };
    },

    // Muster roll: one line per employee, one column per day of the month.
    attendanceReport() {
      const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : day.slice(0, 7);
      const days = daysIn(month);
      const mark = {};
      for (const a of data.attendance || []) if (String(a.date).startsWith(month)) for (const r of a.staff || []) mark[r.employee + '|' + +a.date.slice(8, 10)] = r.mark || 'P';
      const rows = (data.employees || []).filter(e => e.active !== false && (!q.department || e.department === q.department)).map(e => {
        const r = { name: e.name, department: e.department || '' };
        const n = { P: 0, H: 0, A: 0, L: 0, O: 0 };
        for (let d = 1; d <= days; d++) { const m = mark[e.id + '|' + d] || ''; r['d' + d] = m; if (m) n[m]++; }
        return Object.assign(r, { P: n.P, H: n.H, A: n.A, L: n.L, O: n.O });
      }).sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
      const cols = [C('name', 'Employee'), C('department', 'Dept')];
      for (let d = 1; d <= days; d++) cols.push(C('d' + d, String(d)));
      return {
        title: 'Attendance - ' + month,
        note: 'P present · H half day · A absent · L paid leave · O holiday / weekly off · blank = not marked.',
        columns: cols.concat([C('P', 'P', 'int', true), C('H', 'H', 'int', true), C('A', 'A', 'int', true), C('L', 'L', 'int', true), C('O', 'O', 'int', true)]),
        rows,
      };
    },

    /* ================= GST ================= */

    salesRegister() {
      const st = data.settings || {};
      const rows = data.invoices.filter(d => inRange(d.date, q) && (!q.party || d.party === q.party)).sort(byDate).map(d => {
        const p = parties[d.party] || {};
        const pos = d.placeOfSupply || p.state || st.state || '';
        return { date: d.date, no: d.no, party: p.name || '', gstin: p.gstin || '', pos: pos + (stateCode(pos) ? ' (' + stateCode(pos) + ')' : ''), type: p.gstin ? 'B2B' : 'B2C', taxable: num(d.taxable), cgst: num(d.cgst), sgst: num(d.sgst), igst: num(d.igst), total: num(d.total), _link: link('invoices', d.id) };
      });
      return {
        title: 'Sales Register', note: 'Every sales invoice with the customer\'s GSTIN, place of supply and tax. B2B = customer has a GSTIN.',
        columns: [C('date', 'Date', 'date'), C('no', 'Invoice'), C('party', 'Customer'), C('gstin', 'GSTIN'), C('pos', 'Place of Supply'), C('type', 'Type'), C('taxable', 'Taxable', 'money', true), C('cgst', 'CGST', 'money', true), C('sgst', 'SGST', 'money', true), C('igst', 'IGST', 'money', true), C('total', 'Invoice Value', 'money', true)],
        rows,
      };
    },

    purchaseRegister() {
      const rows = data.purchaseBills.filter(d => inRange(d.billDate || d.date, q) && (!q.party || d.party === q.party)).sort((a, b) => (a.billDate || a.date).localeCompare(b.billDate || b.date)).map(d => {
        const p = parties[d.party] || {};
        return { date: d.billDate || d.date, no: d.no, billNo: d.billNo || '', party: p.name || '', gstin: p.gstin || '', state: p.state || '', taxable: num(d.taxable), cgst: num(d.cgst), sgst: num(d.sgst), igst: num(d.igst), total: num(d.total), itc: p.gstin ? 'Yes' : 'No (unregistered)', _link: link('purchaseBills', d.id) };
      });
      return {
        title: 'Purchase Register', note: 'Every purchase bill by the supplier\'s bill date. Input tax credit can be claimed only on bills from registered suppliers that appear in your GSTR-2B.',
        columns: [C('date', 'Bill Date', 'date'), C('no', 'Our No'), C('billNo', 'Supplier Bill No'), C('party', 'Supplier'), C('gstin', 'GSTIN'), C('state', 'State'), C('taxable', 'Taxable', 'money', true), C('cgst', 'CGST', 'money', true), C('sgst', 'SGST', 'money', true), C('igst', 'IGST', 'money', true), C('total', 'Bill Value', 'money', true), C('itc', 'ITC')],
        rows,
      };
    },

    gstr1() {
      const st = data.settings || {};
      const inv = data.invoices.filter(d => inRange(d.date, q)).sort(byDate);
      const posOf = d => { const p = parties[d.party] || {}; const s = d.placeOfSupply || p.state || st.state || ''; return (stateCode(s) ? stateCode(s) + '-' : '') + s; };
      const byRate = d => { const m = {}; for (const l of d.lines || []) { const k = num(l.gst); const e = m[k] || (m[k] = { taxable: 0, tax: 0 }); e.taxable += num(l.taxable); e.tax += num(l.taxAmt); } return m; };
      const split = (d, tax) => num(d.igst) > 0 ? { igst: r2(tax), cgst: 0, sgst: 0 } : { igst: 0, cgst: r2(tax / 2), sgst: r2(tax - r2(tax / 2)) };
      const b2b = [], b2cl = [], b2cs = {}, hsn = {};
      for (const d of inv) {
        const p = parties[d.party] || {};
        for (const [rate, e] of Object.entries(byRate(d))) {
          const t = split(d, e.tax);
          if (p.gstin) b2b.push(Object.assign({ gstin: p.gstin, party: p.name, no: d.no, date: d.date, value: num(d.total), pos: posOf(d), rate: +rate, taxable: r2(e.taxable) }, t, { _link: link('invoices', d.id) }));
          else if (num(d.igst) > 0 && num(d.total) > 100000) b2cl.push(Object.assign({ no: d.no, date: d.date, value: num(d.total), pos: posOf(d), rate: +rate, taxable: r2(e.taxable) }, t, { _link: link('invoices', d.id) }));
          else { const k = posOf(d) + '|' + rate; const x = b2cs[k] || (b2cs[k] = { pos: posOf(d), rate: +rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 }); x.taxable += e.taxable; x.igst += t.igst; x.cgst += t.cgst; x.sgst += t.sgst; }
        }
        for (const l of d.lines || []) {
          const it = items[l.item] || {};
          const k = (it.hsn || '-') + '|' + num(l.gst);
          const x = hsn[k] || (hsn[k] = { hsn: it.hsn || '(no HSN)', desc: it.name || '', uqc: (iUnit(l.item) || '').toLowerCase() === 'kg' ? 'KGS-KILOGRAMS' : (iUnit(l.item) || 'OTH').toUpperCase(), qty: 0, rate: num(l.gst), taxable: 0, igst: 0, cgst: 0, sgst: 0 });
          const t = split(d, num(l.taxAmt));
          x.qty += num(l.qty); x.taxable += num(l.taxable); x.igst += t.igst; x.cgst += t.cgst; x.sgst += t.sgst;
        }
      }
      const fin = o => { for (const k of ['taxable', 'igst', 'cgst', 'sgst', 'qty']) if (o[k] !== undefined) o[k] = k === 'qty' ? r3(o[k]) : r2(o[k]); return o; };
      const taxCols = [C('taxable', 'Taxable Value', 'money', true), C('igst', 'IGST', 'money', true), C('cgst', 'CGST', 'money', true), C('sgst', 'SGST', 'money', true)];
      return {
        title: 'GSTR-1 Data' + (q.from || q.to ? ' ' + (dmy(q.from) || '') + ' to ' + (dmy(q.to) || '') : ''),
        note: 'Outward supplies in the GSTR-1 tables, split by tax rate. B2C Large = inter-state sale to an unregistered buyer above ₹1,00,000. Your accountant should check these figures before filing.',
        tables: [
          { title: 'B2B invoices (4A)', columns: [C('gstin', 'GSTIN of Recipient'), C('party', 'Receiver Name'), C('no', 'Invoice No'), C('date', 'Invoice Date', 'date'), C('value', 'Invoice Value', 'money'), C('pos', 'Place of Supply'), C('rate', 'Rate %', 'qty')].concat(taxCols), rows: b2b },
          { title: 'B2C Large (5)', columns: [C('no', 'Invoice No'), C('date', 'Invoice Date', 'date'), C('value', 'Invoice Value', 'money'), C('pos', 'Place of Supply'), C('rate', 'Rate %', 'qty')].concat(taxCols), rows: b2cl },
          { title: 'B2C Small (7)', columns: [C('pos', 'Place of Supply'), C('rate', 'Rate %', 'qty')].concat(taxCols), rows: Object.values(b2cs).map(fin) },
          { title: 'HSN summary (12)', columns: [C('hsn', 'HSN'), C('desc', 'Description'), C('uqc', 'UQC'), C('qty', 'Total Quantity', 'qty', true), C('rate', 'Rate %', 'qty')].concat(taxCols), rows: Object.values(hsn).map(fin).sort((a, b) => a.hsn.localeCompare(b.hsn)) },
          { title: 'Documents issued (13)', columns: [C('doc', 'Document'), C('from', 'From No'), C('to', 'To No'), C('n', 'Total', 'int')], rows: inv.length ? [{ doc: 'Invoices for outward supply', from: inv.map(d => d.no).sort()[0], to: inv.map(d => d.no).sort().pop(), n: inv.length }] : [] },
        ],
      };
    },

    gstr3b() {
      const inv = data.invoices.filter(d => inRange(d.date, q)), bills = data.purchaseBills.filter(d => inRange(d.billDate || d.date, q));
      const s = (list, k) => r2(list.reduce((t, d) => t + num(d[k]), 0));
      let nil = 0;
      for (const d of inv) for (const l of d.lines || []) if (!num(l.gst)) nil += num(l.taxable);
      const reg = bills.filter(d => (parties[d.party] || {}).gstin);
      const out = { taxable: r2(s(inv, 'taxable') - nil), igst: s(inv, 'igst'), cgst: s(inv, 'cgst'), sgst: s(inv, 'sgst') };
      const itc = { igst: s(reg, 'igst'), cgst: s(reg, 'cgst'), sgst: s(reg, 'sgst') };
      const net = k => r2(out[k] - itc[k]);
      return {
        title: 'GSTR-3B Summary' + (q.from || q.to ? ' ' + (dmy(q.from) || '') + ' to ' + (dmy(q.to) || '') : ''),
        note: 'Input tax credit is taken from purchase bills of registered suppliers; check it against GSTR-2B. Net tax is before setting off one head against another (IGST credit can also pay CGST / SGST). Agency job charges have no GST here. Your accountant should verify before filing.',
        cards: [{ label: 'Output tax', value: r2(out.igst + out.cgst + out.sgst), type: 'money' }, { label: 'Input tax credit', value: r2(itc.igst + itc.cgst + itc.sgst), type: 'money' }, { label: 'Net tax (before set-off)', value: r2(net('igst') + net('cgst') + net('sgst')), type: 'money' }],
        tables: [
          { title: '3.1 Outward supplies', columns: [C('nature', 'Nature of Supplies'), C('taxable', 'Taxable Value', 'money'), C('igst', 'IGST', 'money'), C('cgst', 'CGST', 'money'), C('sgst', 'SGST', 'money')],
            rows: [Object.assign({ nature: '(a) Outward taxable supplies' }, out), { nature: '(c) Nil rated / exempted', taxable: r2(nil), igst: 0, cgst: 0, sgst: 0 }] },
          { title: '4 Eligible ITC', columns: [C('nature', 'Details'), C('igst', 'IGST', 'money'), C('cgst', 'CGST', 'money'), C('sgst', 'SGST', 'money')],
            rows: [Object.assign({ nature: '(A)(5) All other ITC (' + reg.length + ' purchase bill' + (reg.length === 1 ? '' : 's') + ')' }, itc)] },
          { title: 'Tax payable', columns: [C('head', 'Tax'), C('out', 'Output Tax', 'money'), C('itc', 'ITC', 'money'), C('net', 'Net (− = credit carried)', 'money')],
            rows: ['igst', 'cgst', 'sgst'].map(k => ({ head: k.toUpperCase(), out: out[k], itc: itc[k], net: net(k) })) },
        ],
      };
    },

    partyGst() {
      const rows = data.parties.filter(p => !q.ptype || p.type === q.ptype || (p.type === 'Both' && ['Customer', 'Supplier'].includes(q.ptype))).map(p => {
        const bad = checkGstin(p.gstin, p.state);
        return { name: p.name, type: p.type, gstin: p.gstin || '', state: p.state || '', code: stateCode(p.state), reg: p.gstin ? 'Registered' : 'Unregistered', check: p.gstin ? (bad ? 'Check GSTIN' : 'OK') : '', _link: '#/edit/parties/' + p.id };
      }).sort((a, b) => a.name.localeCompare(b.name));
      return {
        title: 'Party GST Details', note: 'Customers and suppliers with their GSTIN and state. "Check GSTIN" = the format or state code does not match.',
        columns: [C('name', 'Party'), C('type', 'Type'), C('gstin', 'GSTIN'), C('state', 'State'), C('code', 'State Code'), C('reg', 'Registration'), C('check', 'Check', 'flag')],
        rows,
      };
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
      const stockIn = (locSet, cat) => stockRows().filter(s => locSet.has(s.loc) && iCat(s.item) === cat && s.qty > 0.0005);
      const notStore = new Set(data.locations.map(l => l.id).filter(workPlace));
      const inGodowns = cat => stockRows().filter(s => godowns.has(s.loc) && (!cat || iCat(s.item) === cat) && s.qty > 0.0005);
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
        const byA = {};
        for (const d of c.k) { const key = lName(d.location || 'KNIT'); byA[key] = (byA[key] || 0) + num(d.outQty); }
        const knitAt = new Set(workPlaces('Knitting'));
        const greyS = P.series(data.knitting, d => d.date, d => num(d.outQty));
        sections.push({
          key: 'knitting', title: 'Knitting', icon: 'yarn', link: '#/list/knitting',
          kpis: [kpi('Grey knitted', c.grey, p.grey, 'kg', true, greyS), kpi('Yarn used', c.yarn, p.yarn, 'kg'),
            kpi('Wastage', c.yarn ? c.w / c.yarn * 100 : 0, p.yarn ? p.w / p.yarn * 100 : 0, 'pct', false, null, p.k.length > 0),
            kpi('Lots knitted', c.k.length, p.k.length, 'int', true), kpi('Rolls', c.rolls, p.rolls, 'int', true)],
          trend: { title: 'Knitting output', sub: 'kg per ' + (P.byDay ? 'day' : 'month'), unit: 'kg', series: [{ name: 'Grey knitted', values: greyS }, { name: 'Yarn used', values: P.series(data.knitting, d => d.date, d => sum(d.lines || [], l => num(l.qty))) }] },
          bars: [
            { title: 'Output by agency', sub: 'Grey kg in the period', unit: 'kg', rows: byLabel(Object.entries(byA).map(([label, value]) => ({ label, value: r3(value) }))) },
            { title: 'Yarn at knitting agencies', sub: 'Right now, by agency and lot', unit: 'kg', rows: byLabel(stockIn(knitAt, 'Yarn').map(s => ({ label: lName(s.loc), note: iName(s.item) + (s.lot ? ' · lot ' + s.lot : ''), value: r3(s.qty) }))) },
          ],
          table: { title: 'Latest knitting entries', link: '#/list/knitting', columns: [C('date', 'Date', 'date'), C('lot', 'Lot'), C('agency', 'Agency'), C('yarn', 'Yarn kg', 'qty'), C('grey', 'Grey kg', 'qty'), C('wpct', 'Wastage %', 'pct')],
            rows: latest('knitting', d => { const y = sum(d.lines || [], l => num(l.qty)); return { date: d.date, lot: d.lotNo, agency: lName(d.location || 'KNIT'), yarn: r3(y), grey: r3(num(d.outQty)), wpct: y ? r2(num(d.wastageQty) / y * 100) : 0, _link: link('knitting', d.id) }; }) },
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
            { title: 'Waiting to be dyed', sub: 'Grey lots at the agencies, right now', unit: 'kg', rows: byLabel(stockIn(notStore, 'Grey Fabric').map(s => ({ label: s.lot || iName(s.item), note: lName(s.loc) + ' · ' + iName(s.item), value: r3(s.qty) }))) },
          ],
          table: { title: 'Latest dyeing batches', link: '#/list/dyeing', columns: [C('date', 'Date', 'date'), C('lot', 'Lot'), C('agency', 'Agency'), C('color', 'Colour'), C('grey', 'Grey kg', 'qty'), C('dyed', 'Dyed kg', 'qty'), C('wpct', 'Wastage %', 'pct')],
            rows: latest('dyeing', d => ({ date: d.date, lot: d.lotNo, agency: lName(d.location || 'DYE'), color: d.color || '', grey: r3(num(d.inQty)), dyed: r3(num(d.outQty)), wpct: num(d.inQty) ? r2(num(d.wastageQty) / num(d.inQty) * 100) : 0, _link: link('dyeing', d.id) })) },
        });
      }

      if (can('finishing')) {
        const fig = r => { const x = inP('finishing', r); return { x, inQ: sum(x, d => num(d.inQty)), out: sum(x, d => num(d.outQty)), w: sum(x, d => num(d.wastageQty)), rolls: sum(x, d => num(d.rolls)), meters: sum(x, d => num(d.meters)) }; };
        const c = fig(P.cur), p = fig(P.prev);
        const pack = {};
        for (const d of c.x) for (const l of d.lines || []) pack[l.item] = (pack[l.item] || 0) + num(l.qty);
        const fgByItem = {};
        for (const s of inGodowns('Finished Goods')) fgByItem[s.item] = (fgByItem[s.item] || 0) + s.qty;
        const outS = P.series(data.finishing, d => d.date, d => num(d.outQty));
        sections.push({
          key: 'finishing', title: 'Finishing & Packing', icon: 'box', link: '#/list/finishing',
          kpis: [kpi('Finished', c.out, p.out, 'kg', true, outS), kpi('Rolls packed', c.rolls, p.rolls, 'int', true), kpi('Meters', c.meters, p.meters, 'int', true),
            kpi('Wastage', c.inQ ? c.w / c.inQ * 100 : 0, p.inQ ? p.w / p.inQ * 100 : 0, 'pct', false, null, p.x.length > 0), kpi('Lots finished', c.x.length, p.x.length, 'int', true)],
          trend: { title: 'Finishing output', sub: 'kg per ' + (P.byDay ? 'day' : 'month'), unit: 'kg', series: [{ name: 'Finished', values: outS }, { name: 'Dyed fabric taken in', values: P.series(data.finishing, d => d.date, d => num(d.inQty)) }] },
          bars: [
            { title: 'Waiting to finish', sub: 'Dyed lots at the agencies, right now', unit: 'kg', rows: byLabel(stockIn(notStore, 'Colored Fabric').map(s => ({ label: s.lot || iName(s.item), note: lName(s.loc) + ' · ' + iName(s.item), value: r3(s.qty) }))) },
            { title: 'Finished stock', sub: 'In the finished goods store, right now', unit: 'kg', rows: byLabel(Object.entries(fgByItem).map(([id, value]) => ({ label: iName(id), value: r3(value) }))) },
            { title: 'Packing material used', sub: 'In the period', unit: 'qty', rows: byLabel(Object.entries(pack).map(([id, value]) => ({ label: iName(id), note: iUnit(id), value: r3(value) }))) },
          ],
          table: { title: 'Latest finishing entries', link: '#/list/finishing', columns: [C('date', 'Date', 'date'), C('lot', 'Lot'), C('agency', 'Agency'), C('item', 'Item'), C('fg', 'Finished kg', 'qty'), C('rolls', 'Rolls', 'int'), C('wpct', 'Wastage %', 'pct')],
            rows: latest('finishing', d => ({ date: d.date, lot: d.outLot || d.lotNo, agency: lName(d.location || 'DYE'), item: iName(d.outItem), fg: r3(num(d.outQty)), rolls: num(d.rolls), wpct: num(d.inQty) ? r2(num(d.wastageQty) / num(d.inQty) * 100) : 0, _link: link('finishing', d.id) })) },
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
        for (const s of inGodowns('Finished Goods')) fg[s.item] = (fg[s.item] || 0) + s.qty;
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
        // money counts when it is there: a cheque on the day it is cashed
        const recD = countedDays(data.receipts), payD = countedDays(data.payments), inR = (l, r) => l.filter(x => inRange(x.date, r));
        const rc = r => sum(inR(recD, r), x => x.amount), pm = r => sum(inR(payD, r), x => x.amount);
        const kp = [], series = [];
        if (can('receipts')) { const s = P.series(recD, x => x.date, x => x.amount); kp.push(kpi('Collected from customers', rc(P.cur), rc(P.prev), 'money', true, s)); series.push({ name: 'Collections', values: s }); }
        if (can('payments')) { const s = P.series(payD, x => x.date, x => x.amount); kp.push(kpi('Paid to suppliers', pm(P.cur), pm(P.prev), 'money', null, s)); series.push({ name: 'Payments', values: s }); }
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
          collections: r2(sum(countedDays(data.receipts).filter(x => inRange(x.date, range)), x => x.amount)),
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
        collections: series(countedDays(data.receipts), x => x.date, x => x.amount),
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
      // Material in process, wherever it is: grey fabric at a place that dyes is "at dyeing", elsewhere "to send".
      const dyeAt = new Set(workPlaces('Dyeing'));
      const P = (where, cat) => {
        const t = { qty: 0, value: 0 };
        for (const [k, pp] of Object.entries(pipe)) { const [loc, c] = k.split('|'); if (c === cat && where(loc)) { t.qty += pp.qty; t.value += pp.value; } }
        return { qty: r3(t.qty), value: r2(t.value) };
      };
      const at = id => loc => loc === id, out = loc => workPlace(loc);

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

      // Today, and what the owner should act on.
      const mStart = day.slice(0, 8) + '01';
      const amt = (list, from, upto, f, dateOf) => (list || []).filter(d => { const dt = dateOf ? dateOf(d) : d.date; return dt && dt >= from && dt <= upto; }).reduce((s, d) => s + f(d), 0);
      const bals = balances();
      const rs = v => '₹ ' + Math.round(v).toLocaleString('en-IN');
      const now = {
        salesToday: r2(amt(data.invoices, day, day, d => num(d.taxable))),
        salesMonth: r2(amt(data.invoices, mStart, day, d => num(d.taxable))),
        collectedToday: r2(amt(countedDays(data.receipts), day, day, x => x.amount)),
        spentToday: r2(amt(data.overheads, day, day, d => num(d.amount)) + amt(data.salary, day, day, d => num(d.amount)) + amt(data.emiPayments, day, day, d => num(d.amount)) +
          amt(data.labourPayments, day, day, d => num(d.amount)) + amt(data.powerBills, day, day, d => num(d.paidAmount) || num(d.amount), d => d.paidOn)),
        bank: r2(Object.entries(bals).reduce((s, [id, v]) => s + (id ? v : 0), 0)),
        accounts: Object.entries(bals).filter(([id, v]) => id && Math.abs(v) > 0.5).map(([id, v]) => ({ name: acctName(id), value: r2(v) })).sort((a, b) => b.value - a.value),
      };
      const alerts = [];
      const A = (level, text, href) => alerts.push({ level, text, href: href || '' });
      const bs = billStatus(data);
      const od = data.invoices.filter(d => (bs[d.id] || {}).status === 'Overdue');
      if (od.length) A('bad', od.length + ' invoice' + (od.length === 1 ? '' : 's') + ' overdue: ' + rs(od.reduce((s, d) => s + bs[d.id].due, 0)) + ' from ' + new Set(od.map(d => d.party)).size + ' customer(s)', '#/report/outstanding?type=receivable');
      const late = jobSends().filter(s => s.late);
      if (late.length) A('bad', late.length + ' job work send' + (late.length === 1 ? '' : 's') + ' past the expected date (' + [...new Set(late.map(s => lName(s.agency)))].slice(0, 3).join(', ') + ')', '#/report/jobWork');
      for (const l of data.loans || []) { const s = loanState(data, l, day); if (s.level !== 'ok') A(s.level, 'EMI ' + l.name + ': ' + s.status.replace(/^\S+ /, '') + ' (' + rs(num(l.emi)) + ', ' + dmy(s.next) + ')', '#/report/loans'); }
      for (const b of data.powerBills || []) { const s = billState(b, day); if (s.level !== 'ok') A(s.level, 'Electricity bill ' + (b.provider || '') + ' ' + billMonth(b) + ': ' + s.status.replace(/^\S+ (?=Due)/, '') + ' (' + rs(num(b.amount)) + ')', '#/report/powerBills'); }
      const pc = pendingCheques(data);
      for (const [inward, word] of [[true, 'received'], [false, 'given']]) {
        const l = pc.filter(c => c.inward === inward);
        if (l.length) A('warn', l.length + ' cheque' + (l.length === 1 ? '' : 's') + ' ' + word + ', not yet cashed: ' + rs(l.reduce((s, c) => s + c.amount, 0)) + ' (not counted until cleared)', '#/report/cheques');
      }
      const fu = data.leads.filter(l => !['Won', 'Lost'].includes(l.status) && l.nextDate && l.nextDate <= day);
      if (fu.length) A('warn', fu.length + ' follow-up' + (fu.length === 1 ? '' : 's') + ' due today or overdue', '#/report/followUps');
      if (low.length) A('warn', low.length + ' item' + (low.length === 1 ? '' : 's') + ' below re-order level: ' + low.slice(0, 3).map(x => x.item).join(', ') + (low.length > 3 ? '…' : ''), '#/report/stock');
      const pend = (data.approvals || []).filter(a => a.status === 'Pending').length;
      if (pend) A('warn', pend + ' change' + (pend === 1 ? '' : 's') + ' by staff waiting for approval', '#/approvals');
      alerts.sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));

      return {
        from, to, prevFrom, prevTo, days, now, alerts,
        kpi: Object.assign({}, k, { pendingSO, exceptions: R.errors.length }), prev: kp, trend,
        flow, stageW, customers: cust, topItems, age, lots, stock,
        pipeline: [
          Object.assign({ key: 'yarnStore', label: 'Yarn in store', href: '#/report/stock?location=STORE&category=Yarn' }, P(at('STORE'), 'Yarn')),
          Object.assign({ key: 'yarnKnit', label: 'Yarn at knitting', href: '#/report/stock?category=Yarn' }, P(out, 'Yarn')),
          Object.assign({ key: 'greyKnit', label: 'Grey, to send', href: '#/report/stock?category=Grey%20Fabric' }, P(loc => !dyeAt.has(loc) && !godowns.has(loc), 'Grey Fabric')),
          Object.assign({ key: 'greyDye', label: 'Grey at dyeing', href: '#/report/stock?category=Grey%20Fabric' }, P(loc => dyeAt.has(loc), 'Grey Fabric')),
          Object.assign({ key: 'colDye', label: 'Dyed, to finish', href: '#/report/stock?category=Colored%20Fabric' }, P(out, 'Colored Fabric')),
          Object.assign({ key: 'fg', label: 'Finished goods', href: '#/report/godownStock' }, P(loc => godowns.has(loc), 'Finished Goods')),
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
    R, data, q: q || {}, items, parties, machines, locs, perms: perms || {},
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
        if (!s) { s = { item: r.item, loc: r.loc, lot: r.lot, qty: 0, value: 0, rolls: 0, bag: null }; m.set(k, s); }
        s.qty += r.qin - r.qout; s.value += r.value; s.rolls += r.rolls;
        if (r.rollMoves) { s.bag = s.bag || new Map(); for (const [no, kg] of r.rollMoves) s.bag.set(no, r3((s.bag.get(no) || 0) + kg)); }
      }
      // Weighed rolls still there (kg left on each), in roll order; they count towards the rolls too.
      return [...m.values()].map(s => {
        s.weights = s.bag ? [...s.bag].filter(([, kg]) => kg > 0.0005).sort((a, b) => a[0] - b[0]).map(([no, kg]) => ({ no, kg })) : [];
        s.rolls += s.weights.length;
        delete s.bag;
        return s;
      });
    },
  };
  const reports = buildReports(ctx);
  if (!reports[name]) throw Object.assign(new Error('Unknown report: ' + name), { status: 404 });
  return reports[name]();
}

module.exports = { compute, computed, report: reportImpl, prepare, validate, partyBalances, agencyParty, cashTxns, billStatus, salaryCalc, loanState, STOCK_COLS, DOC_LABELS, BUCKETS, vsum };

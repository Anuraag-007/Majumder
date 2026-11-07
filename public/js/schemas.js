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
const lotTracked = id => S.LOT_CATEGORIES.includes((itemOf(id) || {}).category);
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
  banks: r => r.name,
  employees: r => r.name + (r.department ? ' (' + r.department + ')' : ''),
  loans: r => r.name,
  leads: r => (r.no || '') + ' · ' + r.name,
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
  // Mode + account: cash goes to Cash in Hand, anything else to a bank account.
  modeBank: { k: 'mode', label: 'Mode', type: 'select', options: S.PAY_MODES, def: 'Bank Transfer', onChange: d => { if (d.mode === 'Cash') d.bank = 'CASH'; else if (!d.bank || d.bank === 'CASH') d.bank = mainBank(); } },
  bank: label => ({ k: 'bank', label: label || 'Paid from (account)', type: 'ref', ref: 'banks', def: () => mainBank(), help: 'Bank & Cash Accounts. Cash = Cash in Hand' }),
  refNo: { k: 'refNo', label: 'Cheque / UTR no', type: 'text' },
  cleared: { k: 'clearedOn', label: 'Cleared in bank on', type: 'date', help: 'Date it shows in the bank statement (for reconciliation)',
    show: d => !isCheque(d) && ((!!d.bank && d.bank !== 'CASH') || (d.parts || []).some(p => p.bank && p.bank !== 'CASH')) },
  // A cheque counts (party balance, bills, bank) only from the day it is cashed.
  chequeCleared: { k: 'clearedOn', label: 'Cheque cashed (cleared in bank) on', type: 'date', show: d => isCheque(d),
    help: 'Fill in when the cheque shows in the bank statement. Until then it does not count' },
  chequeNote: { k: '_chqNote', label: 'Cheque status', type: 'calc', w: 2, show: d => isCheque(d),
    value: d => d.clearedOn ? 'Cashed: counts from ' + U.fmtDate(d.clearedOn) : 'Not cashed yet: not counted (party balance, bills, bank) until the date it is cashed is filled in' },
};
const isCheque = d => d.mode === 'Cheque' || (d.parts || []).some(p => p && p.mode === 'Cheque');
// "Not cashed" / "Cashed 04-11-2026" for cheque entries in the lists.
const chequeState = d => !isCheque(d) ? '' : d.clearedOn ? 'Cashed ' + U.fmtDate(d.clearedOn) : 'Not cashed';
// The bank account most money goes through: the only (or first) bank account.
function mainBank() { const b = Cache.list('banks').filter(x => x.type === 'Bank').sort((a, c) => (a.createdAt || '').localeCompare(c.createdAt || ''))[0]; return b ? b.id : ''; }
const rollKg = () => S.num((Cache.settings || {}).rollKg) || 17;
// Rolls typed without kg: estimate the kg at the average roll weight (Settings).
const estimateKg = r => { if (r && !S.num(r.qty) && S.num(r.rolls) > 0) r.qty = S.r3(S.num(r.rolls) * rollKg()); };
const isGodown = l => S.isGodown(l) && !l.inactive;
const colorCol = { k: 'color', label: 'Colour', type: 'text' };
/* Receipts and payments: the details of each way of paying (a cheque's no., date and bank; the UPI phone
   or ID; a transfer's UTR ...). `inward` = money from a customer: their cheque, their bank, their UPI. */
// Fills the bank / UPI boxes from the party master (our own cheque: from our bank account).
// Only blank boxes, or boxes filled this way, change: what was typed stays.
function payDefaults(row, d, inward) {
  const p = byId('parties', d.party) || {}, ours = byId('banks', row.bank) || {};
  const auto = row._auto || (row._auto = {});
  const put = (k, v) => { if (row[k] && row[k] !== auto[k]) return; row[k] = v || ''; auto[k] = row[k]; };
  if (row.mode === 'Cheque') put('payBank', inward ? p.bankName : [ours.bankName || ours.name, ours.branch].filter(Boolean).join(', '));
  if (row.mode === 'Bank Transfer') { put('payBank', p.bankName); if (!inward) put('accountNo', [p.bankAccount, p.ifsc && 'IFSC ' + p.ifsc].filter(Boolean).join(', ')); }
  if (row.mode === 'UPI') put('upi', p.upi || p.phone);
}
const payParty = (d, inward) => { payDefaults(d, d, inward); for (const r of d.parts || []) payDefaults(r, d, inward); };
// Mode, account and the boxes for that mode. Paid in parts? The details go on each part instead.
function payFields(inward) {
  const when = m => d => d.mode === m && !(d.parts || []).some(p => p && p.mode);
  return [
    Object.assign({}, F.modeBank, { onChange: d => { F.modeBank.onChange(d); payDefaults(d, d, inward); } }),
    Object.assign(F.bank(inward ? 'Received into (account)' : ''), { onChange: d => payDefaults(d, d, inward) }),
    { k: 'person', label: inward ? 'Cash received by (our staff)' : 'Cash handed to', type: 'text', show: when('Cash') },
    { k: 'refNo', label: inward ? 'Receipt book no' : 'Voucher no', type: 'text', show: when('Cash') },
    { k: 'refNo', label: 'Cheque no', type: 'text', req: true, show: when('Cheque') },
    { k: 'chequeDate', label: 'Cheque date', type: 'date', show: when('Cheque') },
    { k: 'payBank', label: inward ? 'Bank & branch (on the cheque)' : 'Bank (on the cheque)', type: 'text', show: when('Cheque') },
    { k: 'transferType', label: 'NEFT / RTGS / IMPS', type: 'select', options: S.TRANSFER_TYPES, show: when('Bank Transfer') },
    { k: 'refNo', label: 'UTR no', type: 'text', show: when('Bank Transfer') },
    { k: 'payBank', label: inward ? 'Customer\'s bank' : 'Supplier\'s bank', type: 'text', show: when('Bank Transfer') },
    { k: 'accountNo', label: 'Supplier\'s A/c no & IFSC', type: 'text', show: d => !inward && when('Bank Transfer')(d) },
    { k: 'upi', label: inward ? 'Paid from UPI (phone no or UPI ID)' : 'Paid to UPI (phone no or UPI ID)', type: 'text', show: when('UPI') },
    { k: 'refNo', label: 'UPI transaction ID', type: 'text', show: when('UPI') },
    { k: 'payVia', label: 'Paid through', type: 'text', placeholder: 'Net banking, card, payment link ...', show: when('Online Payment') },
    { k: 'refNo', label: 'Transaction ID', type: 'text', show: when('Online Payment') },
    { k: 'refNo', label: 'Ref no', type: 'text', show: d => !d.mode },
  ];
}
// Parts of a receipt / payment paid in different ways (part cash, part bank ...), each with its details.
function partsGrid(title, inward) {
  const any = (...m) => d => (d.parts || []).some(p => p && m.includes(p.mode));
  return { grid: { k: 'parts', title, cols: [
    { k: 'mode', label: 'Mode', type: 'select', options: S.PAY_MODES, onChange: (r, d) => { if (r.mode === 'Cash') r.bank = 'CASH'; else if (!r.bank || r.bank === 'CASH') r.bank = mainBank(); payDefaults(r, d, inward); } },
    { k: 'bank', label: 'Account', type: 'ref', ref: 'banks', wide: true, onChange: (r, d) => payDefaults(r, d, inward) },
    { k: 'amount', label: 'Amount (₹)', type: 'number', fmt: 'money' },
    { k: 'refNo', label: 'Cheque / UTR / Txn no', type: 'text' },
    { k: 'chequeDate', label: 'Cheque date', type: 'date', show: any('Cheque') },
    { k: 'payBank', label: 'Bank name', type: 'text', show: any('Cheque', 'Bank Transfer') },
    { k: 'upi', label: 'UPI phone / ID', type: 'text', show: any('UPI') },
    { k: 'person', label: inward ? 'Cash received by' : 'Cash handed to', type: 'text', show: any('Cash') }],
    totals: ['amount'], onEdit: d => { const t = (d.parts || []).reduce((s, p) => s + S.num(p.amount), 0); if (t > 0) d.amount = S.r2(t); } } };
}
const payDetailCol = { k: '_det', label: 'Details', value: d => S.payDetail(d) };
const LEAD_STAGES = ['New', 'Contacted', 'Quotation sent', 'Negotiation', 'Won', 'Lost'];
const BANK_KINDS = ['Cash deposit', 'Cash withdrawal', 'Transfer', 'Bank charges', 'Interest received', 'Other receipt', 'Other payment'];
const FROM_KINDS = ['Cash withdrawal', 'Transfer', 'Bank charges', 'Other payment'], TO_KINDS = ['Cash deposit', 'Transfer', 'Interest received', 'Other receipt'];
const fabricCat = id => ['Grey Fabric', 'Colored Fabric'].includes((itemOf(id) || {}).category);
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
// Figures some lists show beside each record, loaded with the list (see `listExtra`).
const Extra = {};
// Paid / balance of invoices and purchase bills.
const billOf = d => ((Extra.billStatus || {}).bills || {})[d.id] || null;
const payInfo = async doc => {
  if (!doc.id) return '';
  const r = await API.report('billStatus');
  const b = (r.bills || {})[doc.id];
  return b ? b.status + ': paid ₹ ' + U.money(b.paid) + ', balance ₹ ' + U.money(b.due) + (b.dueDate ? ' (due ' + U.fmtDate(b.dueDate) + ')' : '') : '';
};

const C = {
  item: (cats, extra) => Object.assign({ k: 'item', label: 'Item', type: 'ref', ref: 'items', req: true, wide: true, filter: i => !cats || cats.includes(i.category) }, extra || {}),
  unit: { k: '_unit', label: 'Unit', type: 'calc', value: r => unitOf(r.item), narrow: true },
  qty: (label) => ({ k: 'qty', label: label || 'Qty', type: 'number', req: true, fmt: 'qty' }),
  rate: { k: 'rate', label: 'Rate', type: 'number', fmt: 'money' },
  gst: { k: 'gst', label: 'GST %', type: 'number', narrow: true },
  // Typing a roll count stops it being worked out from the kg.
  rolls: { k: 'rolls', label: 'Rolls', type: 'number', narrow: true, fmt: 'int', onInput: (d, r) => { if (r) r._rollsTouched = true; } },
  amount: { k: '_amount', label: 'Amount', type: 'calc', fmt: 'money', value: r => S.num(r.qty) * S.num(r.rate) },
  // Lot numbers are given by the ERP when yarn or fabric is received: the next number shows greyed in the
  // box and is used unless someone types their own.
  lotAuto: { k: 'lot', label: 'Lot no', type: 'lotNew', tracked: r => lotTracked(r.item), auto: (r, d, ctx) => nextLotFor(r, d, ctx), onChange: (r, d, ctx) => askLot(r, d, ctx) },
  // Opening stock / adjustment: a + line can start a new lot (automatic or typed) or add to one; a - line takes from a lot.
  lotAdjust: { k: 'lot', label: 'Lot no', type: 'lot', loc: d => d.location, itemKey: 'item', signed: true,
    blank: r => lotTracked(r.item) ? 'new lot (auto) – or type a new lot no' : '— no lot —', allowNew: r => lotTracked(r.item) && !(S.num(r.qty) < 0),
    // a lot number typed here ("New lot: ...") gets the same check and explanation as on a GRN
    onChange: (r, d, ctx) => { r._lotNew = !!r.lot && !ctx.lots(d.location, r.item).some(x => x.lot === r.lot); if (r._lotNew) askLot(r, d, ctx, true); } },
  lotFrom: (locFn, label) => ({ k: 'lot', label: label || 'Lot / Batch', type: 'lot', loc: locFn, itemKey: 'item' }),
  // Rolls going out of a lot: for lots weighed roll by roll, a button to choose which rolls.
  rollsOut: (locFn, locked) => ({ k: 'rolls', label: 'Rolls', type: 'rolls', fmt: 'int', loc: locFn, locked, onInput: (d, r) => { if (r) r._rollsTouched = true; } }),
  // Only when rolls are weighed one by one (Settings), or the entry already has weights.
  rollWeights: { k: 'rollWeights', label: 'Roll weights (kg)', type: 'text', placeholder: 'e.g. 20.2 + 50.3', wide: true, show: d => weighRolls() || (d.lines || []).some(l => l.rollWeights) },
};
// The next automatic lot numbers, shown greyed in blank lot boxes ("L-0012 (auto)"). Loaded once per form
// and date; the numbers are given for real when the entry is saved.
const NextLots = { date: null, list: [], busy: false };
function nextLotFor(r, d, ctx) {
  const date = d.date || U.today();
  if (NextLots.date !== date && !NextLots.busy) {
    NextLots.busy = true;
    API.report('nextLot', { date, count: 30 }).then(x => { NextLots.list = x.lots || []; }, () => { NextLots.list = []; })
      .finally(() => { NextLots.date = date; NextLots.busy = false; if (ctx) ctx.rerender(); });
  }
  const i = (d.lines || []).filter(l => l.item && lotTracked(l.item) && !String(l.lot || '').trim()).indexOf(r);
  return (NextLots.date === date && NextLots.list[i] ? NextLots.list[i] : 'next number') + ' (auto)';
}
/* A lot number typed by hand (GRN, or "New lot" on opening stock) is checked with the server and explained
   in a pop-up before it is used, because that number then follows the material everywhere. Returns true when
   the line can be saved as it is (own number confirmed, or left to the automatic number). */
function askLot(r, d, ctx, adding) {
  const lot = String(r.lot || '').trim().replace(/\s+/g, ' ').toUpperCase();
  r.lot = lot;
  if (!lot || r._lotOk === lot) return Promise.resolve(true);
  if (r._ask && r._ask.lot === lot) return r._ask.p; // already asking (leaving the box and pressing Save)
  const p = (async () => {
    let x;
    try { x = await API.report('lotCheck', { lot, date: d.date || U.today(), self: d.id || '' }); } catch (e) { return true; } // the server checks again on save
    if (x.own) { r._lotOk = lot; return true; }
    const item = (itemOf(r.item) || {}).name || 'this material';
    const P = (...t) => h('p', null, ...t), B = t => h('b', null, t);
    const auto = { label: 'Use the automatic number (' + x.next + ')', value: 'auto' }, again = { label: 'Type another', value: 'edit' };
    let pick;
    if (x.problem === 'format') {
      pick = await modal('This lot number is not allowed', [P('"', B(lot), '" cannot be a lot number: use letters, digits, - / . _ and spaces only, up to 30 characters.'),
        P('Or leave the Lot no box blank and the ERP gives the next number by itself.')], [again, Object.assign({ primary: true }, auto)]);
    } else if (x.problem === 'used' && !adding) {
      pick = await modal('Lot number ' + lot + ' is already used', [P('Lot ', B(lot), ' is already used in ', B(x.usedIn), '.'),
        P('Each lot number is given only once, so that every lot can be traced from purchase to sale. Type a different number, or leave the box blank for the automatic one.')],
        [again, Object.assign({ primary: true }, auto)]);
    } else {
      pick = await modal('Your own lot number: ' + lot, [
        P(B(item), ' will get lot number ', B(lot), x.problem === 'used' ? ' and be added to that existing lot (used in ' + x.usedIn + ')' : '', '.'),
        h('ul', { class: 'modal-list' },
          h('li', null, 'This number stays with the material everywhere: yarn issue, knitting, dyeing, finishing, delivery challan and invoice.'),
          h('li', null, 'Once the material has been issued, used or sold, the number can no longer be changed.'),
          h('li', null, 'The automatic numbers carry on as before (next free: ', h('span', { class: 'nowrap' }, x.next), ').')),
        P('Leave the box blank instead if you want the automatic number.'),
      ], [auto, { label: 'Use ' + lot, value: 'use', primary: true }]);
    }
    if (pick === 'use') { r._lotOk = lot; ctx.rerender(); return true; } // redraw: the other lines' automatic numbers move up
    if (pick === 'auto') { r.lot = ''; r._lotNew = false; ctx.rerender(); return true; }
    // "Type another" (or Esc): back to the box to correct it
    ctx.rerender();
    const el = document.querySelector('.form [data-path="lines.' + (d.lines || []).indexOf(r) + '.lot"]');
    if (el) { el.focus(); if (el.select) el.select(); }
    return false;
  })();
  r._ask = { lot, p };
  return p.finally(() => { r._ask = null; });
}
// Before saving: every typed lot number has been checked and explained.
const lotsChecked = (typed, adding) => async (doc, ctx) => { for (const r of doc.lines || []) if (r.item && lotTracked(r.item) && typed(r) && !(await askLot(r, doc, ctx, adding))) return false; return true; };
// "Saved GRN-0007 · lot numbers: SM/4471 (typed), L-0013"
const lotsSaved = saved => { const l = (saved.lines || []).filter(x => x.lot && lotTracked(x.item)); return l.length ? (l.length === 1 ? ' · lot number ' : ' · lot numbers ') + [...new Set(l.map(x => x.lot + (x.lotCustom ? ' (typed)' : '')))].join(', ') : ''; };
// Rolls are counted, not weighed, unless Settings say each roll is weighed.
const weighRolls = () => !!(Cache.settings || {}).weighRolls;
// Rolls in `kg` of a lot, at the lot's average (1000 kg in 300 rolls: 100 kg = 30 rolls; the last kg take what is left).
function avgRolls(ctx, loc, item, lot, kg) {
  const e = ctx && ctx.lots ? ctx.lots(loc, item).find(x => x.lot === (lot || '')) : null;
  if (!e || !(e.rolls > 0) || !(e.qty > 0) || !(kg > 0)) return '';
  return kg >= e.qty - 0.0005 ? e.rolls : Math.round(kg * e.rolls / e.qty);
}
// Dyeing / finishing: the output keeps the rolls of the kg taken in, until someone types a count.
const fillInRolls = (d, ctx) => { if (d._rollsTouched) return; const r = avgRolls(ctx, d.location || 'DYE', d.inItem, d.lotNo, S.num(d.inQty)); if (r !== '') d.rolls = r; };
// "20.2 + 50.3 + 39.5" typed in a roll weights box fills the kg and the number of rolls.
function applyRollWeights(obj, qtyKey) {
  const w = S.parseRolls(obj.rollWeights);
  if (w && w.length) { obj[qtyKey] = S.r3(w.reduce((t, x) => t + x, 0)); obj.rolls = w.length; }
}

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
// Job work is done at an agency (a party that knits, dyes or finishes for us) or at an own factory.
const partyOf = id => byId('parties', id);
const doesWork = (l, stage) => S.doesWork(l, stage, partyOf);
// The agency's own rate per kg for this work, if its party record has one.
const agencyRate = (locId, stage) => { const l = byId('locations', locId); const p = l && l.party ? partyOf(l.party) : null; return p ? S.num(p[S.AGENCY_WORK[stage][1]]) : 0; };
// "Agency / unit" on a production entry: where the work is done, which is also where its input is taken from.
const workPlace = (stage, onPick) => ({
  k: 'location', label: 'Agency / unit', type: 'ref', ref: 'locations', req: true, w: 2, list: true,
  filter: l => doesWork(l, stage),
  help: 'Agencies are parties that tick this work in Masters → Parties',
  onChange: (doc, ctx) => {
    const r = agencyRate(doc.location, stage);
    if (r) { doc.labourRate = r; doc._labourTouched = false; }
    if (onPick) onPick(doc, ctx);
  },
});
// Keeps wastage (input - output) and labour (rate x qty) filled in until the user overrides them.
function productionRecalc(stage) {
  return doc => {
    if (stage === 'Finishing') applyRollWeights(doc, 'outQty');
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
  onChange: doc => { const p = byId('processes', doc.process); if (p) { doc.labourRate = agencyRate(doc.location, stage) || S.num(p.labourRate); doc._labourTouched = false; } },
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
  stage === 'Finishing' ? { k: 'rollWeights', label: 'Roll weights (kg)', type: 'text', w: 4, placeholder: 'e.g. 20.2 + 50.3 + 39.5', show: d => weighRolls() || !!String(d.rollWeights || '').trim(),
    help: 'Weigh each finished roll and type its kg with + between them. Output kg and rolls then fill in by themselves, and each roll is tracked through to the sale.' } : null,
  { k: 'outQty', label: 'Output qty (kg)', type: 'number', req: true, fmt: 'qty' },
  { k: 'rolls', label: 'Rolls', type: 'number', fmt: 'int', onInput: d => { d._rollsTouched = true; },
    help: stage === 'Knitting' ? 'Count of rolls (an approximate count is fine)' : 'Filled from the rolls of the kg taken in (the lot\'s average); change it only if the count changed' },
].concat(extra || [], [
  { k: '_diff', label: 'Input - output (kg)', type: 'calc', fmt: 'qty', value: d => (stage === 'Knitting' ? sumQty(d.lines) : S.num(d.inQty)) - S.num(d.outQty) },
  { k: 'wastageQty', label: 'Wastage qty (kg)', type: 'number', fmt: 'qty', onInput: d => { d._wastageQtyTouched = true; } },
  { k: 'scrapValue', label: 'Scrap sale value (₹)', type: 'number', fmt: 'money', help: 'Recovery from selling waste, if any' },
  { k: '_wpct', label: 'Wastage %', type: 'calc', fmt: 'pct', value: d => { const i = stage === 'Knitting' ? sumQty(d.lines) : S.num(d.inQty); return i ? S.num(d.wastageQty) / i * 100 : 0; } },
  { k: 'labourRate', label: 'Job rate (₹/kg)', type: 'number', fmt: 'money', onInput: d => { d._labourTouched = false; } },
  { k: 'labour', label: 'Job charges (₹)', type: 'number', fmt: 'money', onInput: d => { d._labourTouched = true; },
    help: 'Added to the agency\'s account (pay it in Supplier Payments). At your own factory it is labour.' },
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
      { k: 'count', label: 'Count / specification', type: 'text', list: true, placeholder: 'e.g. 30s combed, 40D', help: 'Yarn count, or fabric quality' },
      { k: 'color', label: 'Colour', type: 'text' },
      { k: 'description', label: 'Description / quality spec', type: 'textarea', w: 4 },
    ] }],
    listFilter: { k: 'category', options: S.CATEGORIES },
  },
  parties: {
    title: 'Parties', singular: 'Party', col: 'parties', master: true,
    layout: [
      { fields: [
        { k: 'name', label: 'Party name', type: 'text', req: true, w: 2, list: true },
        { k: 'type', label: 'Type', type: 'select', options: S.PARTY_TYPES, req: true, def: 'Customer', list: true, help: 'Job Worker = an agency that knits, dyes or finishes for us' },
        { k: 'contactPerson', label: 'Contact person', type: 'text' },
        { k: 'phone', label: 'Phone / mobile', type: 'text', list: true },
        { k: 'email', label: 'Email', type: 'text' },
        { k: 'state', label: 'State', type: 'select', options: S.STATE_NAMES, def: 'West Bengal', req: true, list: true, help: 'Same state as us = CGST + SGST, other state = IGST' },
        { k: 'gstin', label: 'GSTIN', type: 'text', list: true, placeholder: 'e.g. 19ABCDE1234F1Z5', help: 'Blank for unregistered (B2C) parties' },
        { k: 'city', label: 'City', type: 'text', list: true },
        { k: 'address', label: 'Address', type: 'textarea', w: 3 },
      ] },
      { title: 'Credit & opening balance', fields: [
        { k: 'creditLimit', label: 'Credit limit (₹)', type: 'number', fmt: 'money', list: true },
        { k: 'creditDays', label: 'Credit days', type: 'number', help: 'Invoices are overdue after this many days' },
        { k: 'paymentTerms', label: 'Payment terms', type: 'select', options: ['Advance', 'Cash on delivery', 'Part advance', '7 days', '15 days', '30 days', '45 days', '60 days', '90 days'] },
        { k: 'openingBalance', label: 'Opening balance (₹)', type: 'number', fmt: 'money' },
        { k: 'openingType', label: 'Dr / Cr', type: 'select', options: ['Dr', 'Cr'], def: 'Dr', help: 'Dr = party owes us' },
      ] },
      { title: 'Bank & UPI: filled in by itself on their payments and receipts', fields: [
        { k: 'bankName', label: 'Bank & branch', type: 'text', w: 2 },
        { k: 'bankAccount', label: 'Account no', type: 'text' },
        { k: 'ifsc', label: 'IFSC', type: 'text' },
        { k: 'upi', label: 'UPI phone no / UPI ID', type: 'text', w: 2, help: 'Blank = the phone / mobile above' },
      ] },
      { title: 'Job work agency: the work it does for us and its rate', agency: true, fields: [
        { k: 'doesKnitting', label: 'Does knitting', type: 'check', w: 2 },
        { k: 'knitRate', label: 'Knitting rate (₹/kg)', type: 'number', fmt: 'money', w: 2, help: 'Per kg of grey fabric delivered' },
        { k: 'doesDyeing', label: 'Does dyeing / color', type: 'check', w: 2 },
        { k: 'dyeRate', label: 'Dyeing rate (₹/kg)', type: 'number', fmt: 'money', w: 2, help: 'Per kg of grey fabric taken in' },
        { k: 'doesFinishing', label: 'Does finishing & packing', type: 'check', w: 2 },
        { k: 'finRate', label: 'Finishing rate (₹/kg)', type: 'number', fmt: 'money', w: 2, help: 'Per kg of finished fabric' },
      ] },
    ],
    listCols: ['name', 'type', { k: '_work', label: 'Job work', value: p => S.workOf(p).map(st => S.STAGE_LABELS[st]).join(', ') || (p.type === 'Job Worker' ? 'Any' : '') }, 'phone', 'state', 'gstin', 'city', 'creditLimit'],
    listFilter: { k: 'type', options: S.PARTY_TYPES },
  },
  units: {
    title: 'Units', singular: 'Unit', col: 'units', master: true,
    layout: [{ fields: [{ k: 'code', label: 'Symbol', type: 'text', req: true, list: true }, { k: 'name', label: 'Unit name', type: 'text', w: 2, list: true }] }],
  },
  locations: {
    title: 'Locations', singular: 'Location', col: 'locations', master: true,
    note: 'Main Store and Finished Goods Store are built in. Add more godowns with type Godown: finished goods can be kept, moved and sold from any of them. Every agency (a party of type Job Worker, or one that ticks knitting, dyeing or finishing) gets a location of its own here, named after it, that holds the material sent to it. Knitting Factory and Color Factory are for work done in your own factory: tick "Not in use" on them if all work goes to agencies.',
    layout: [{ fields: [
      { k: 'name', label: 'Location name', type: 'text', req: true, w: 2, list: true },
      { k: 'type', label: 'Type', type: 'select', options: ['Store', 'Godown', 'Factory', 'Job Worker'], def: 'Godown', list: true, help: 'Godown = holds finished goods for sale' },
      { k: 'inactive', label: 'Not in use (hide it on entry screens)', type: 'check', w: 2, list: true },
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
      { k: 'labourRate', label: 'Standard rate (₹/kg)', type: 'number', fmt: 'money', list: true, help: 'Used when the agency has no rate of its own, and for work in your own factory' },
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
    note: 'Each yarn or fabric line gets the next lot number (shown greyed in the Lot no box) when you save. To use your own lot number, type it in the box. That one number stays with the material through knitting, dyeing and finishing to the sale. Dyes, chemicals and packing have no lot.',
    onNew: async () => { NextLots.date = null; },
    beforeSave: lotsChecked(r => !!String(r.lot || '').trim()), savedNote: lotsSaved,
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
      { grid: { k: 'lines', title: 'Items received', cols: [C.item(S.CATEGORIES, { onChange: fillPurchaseLine }), C.lotAuto, C.qty('Qty received'), C.unit, C.rolls, C.rate, C.amount] } },
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
        { k: '_info', label: 'Payment status', type: 'calc', w: 2, value: d => d._infoText || '', show: d => !!d.id },
        { k: 'grnId', label: 'Against GRN', type: 'ref', ref: 'grn',
          filter: (r, d) => r.party === d.party && !Cache.list('purchaseBills').some(b => b.grnId === r.id && b.id !== d.id),
          onChange: d => { const g = byId('grn', d.grnId); if (g) d.lines = g.lines.map(l => ({ item: l.item, qty: l.qty, rate: l.rate, gst: S.num((itemOf(l.item) || {}).gst) })); } },
      ] },
      { grid: { k: 'lines', title: 'Bill items', cols: [C.item(S.CATEGORIES, { onChange: fillPurchaseLine }), C.qty(), C.unit, C.rate, C.gst, C.amount] } },
      { fields: [{ k: 'freight', label: 'Transport / freight (₹)', type: 'number', fmt: 'money' }, { k: 'otherCharges', label: 'Other charges (₹)', type: 'number', fmt: 'money' }, F.remarks] },
      { totals: true },
    ],
    info: payInfo, listExtra: 'billStatus',
    listCols: ['no', 'billNo', 'date', 'party', { k: 'taxable', label: 'Taxable', fmt: 'money' }, { k: 'tax', label: 'GST', fmt: 'money' }, { k: 'total', label: 'Total', fmt: 'money' },
      { k: '_due', label: 'Balance', fmt: 'money', value: d => (billOf(d) || {}).due }, { k: '_st', label: 'Payment', value: d => (billOf(d) || {}).status || '' }],
  },
  payments: {
    title: 'Supplier Payments', singular: 'Payment', col: 'payments', printTitle: 'PAYMENT VOUCHER',
    layout: [
      { fields: [
        F.no, F.date, F.party('Supplier', { onChange: (d, ctx) => { payParty(d, false); ctx.loadBalance(); } }),
        { k: '_bal', label: 'Current balance', type: 'calc', value: d => d._balText || '' },
        { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
        ...payFields(false), F.cleared, F.chequeCleared, F.chequeNote, F.remarks,
      ] },
      partsGrid('Paid in more than one way? List each part (the amount adds up by itself)', false),
    ],
    listCols: ['no', 'date', 'party', 'mode', 'bank', payDetailCol, { k: 'amount', label: 'Amount', fmt: 'money' }, { k: '_chq', label: 'Cheque', value: chequeState }],
  },
  labourPayments: {
    title: 'Labour Payments', singular: 'Labour Payment', col: 'labourPayments', printTitle: 'LABOUR PAYMENT VOUCHER',
    note: 'Wages paid to your own workers for knitting, color (dyeing) or finishing & packing. Labour earned comes from the production entries done at your own factory; the Labour Payable page shows what is still owed. Agencies are paid in Supplier Payments: their job charges are in their Party Ledger.',
    info: async doc => {
      if (!doc.stage) return '';
      const r = await API.report('labourBalance', { stage: doc.stage });
      return '₹ ' + U.money(r.payable) + (doc.id ? ' (after saved payments)' : '');
    },
    layout: [{ fields: [
      F.no, F.date,
      { k: 'stage', label: 'Process', type: 'select', req: true, w: 2, list: true, options: S.STAGES.map(s => [s, S.STAGE_LABELS[s]]), onChange: (d, ctx) => ctx.loadInfo() },
      { k: '_info', label: 'Still payable for this process', type: 'calc', value: d => d._infoText || '' },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      { k: 'paidTo', label: 'Paid to (worker / contractor)', type: 'text', w: 2, list: true },
      { k: 'period', label: 'For (week / month)', type: 'text' },
      F.modeBank, F.bank(), F.refNo, F.cleared, F.chequeCleared, F.chequeNote, F.remarks,
    ] }],
    listCols: ['no', 'date', 'stage', 'paidTo', 'period', 'mode', { k: 'amount', label: 'Amount', fmt: 'money' }],
  },

  /* ===== Inventory movements ===== */
  yarnIssue: {
    title: 'Yarn Issue to Knitting', singular: 'Yarn Issue', col: 'transfers', printTitle: 'YARN ISSUE / TRANSFER NOTE',
    fixed: { purpose: 'Yarn Issue', fromLoc: 'STORE' }, where: d => d.purpose === 'Yarn Issue',
    note: 'Sends yarn from the Main Store to a knitting agency (job work challan). The yarn keeps its lot number and stays ours: the agency holds it until it delivers the grey fabric. With an expected date, the Job Work Register shows when it is late.',
    layout: [
      { fields: [F.no, F.date,
        { k: 'toLoc', label: 'Knitting agency', type: 'ref', ref: 'locations', req: true, w: 2, list: true, filter: l => doesWork(l, 'Knitting'), onChange: d => { const r = agencyRate(d.toLoc, 'Knitting'); if (r) d.jobRate = r; } },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' }, { k: 'issuedTo', label: 'Handed to (person)', type: 'text' },
        { k: 'expectedQty', label: 'Expected grey fabric (kg)', type: 'number', fmt: 'qty', help: 'Usually 2-3% less than the yarn' },
        { k: 'jobRate', label: 'Job work rate (₹/kg)', type: 'number', fmt: 'money' },
        { k: 'expectedDate', label: 'Expected delivery by', type: 'date', list: true }] },
      { grid: { k: 'lines', title: 'Yarn issued', cols: [C.item(['Yarn']), C.lotFrom(() => 'STORE', 'Yarn lot'), C.qty('Qty (kg)'), C.unit], totals: ['qty'],
        onEdit: d => { const q = sumQty(d.lines); if (q && !d._expTouched) d.expectedQty = S.r3(q * 0.975); } } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'toLoc', { k: '_qty', label: 'Total kg', fmt: 'qty', value: d => sumQty(d.lines) }, 'expectedDate', 'vehicleNo', 'remarks'],
  },
  greyTransfer: {
    title: 'Send Grey for Dyeing', singular: 'Grey Fabric Transfer', col: 'transfers', printTitle: 'GREY FABRIC TRANSFER NOTE',
    fixed: { purpose: 'Grey Transfer' }, where: d => d.purpose === 'Grey Transfer',
    note: 'Sends grey fabric to a dyeing agency: from the knitting agency that kept it, or from the Main Store. Not needed when the knitting entry already sent the fabric straight to the dyeing agency.',
    layout: [
      { fields: [F.no, F.date,
        { k: 'fromLoc', label: 'From', type: 'ref', ref: 'locations', req: true, w: 2, list: true, filter: l => !l.inactive && l.id !== 'FG', help: 'Where the grey fabric is now', onChange: d => { for (const l of d.lines || []) l.lot = ''; } },
        { k: 'toLoc', label: 'Dyeing agency', type: 'ref', ref: 'locations', req: true, w: 2, list: true, filter: l => doesWork(l, 'Dyeing'), onChange: d => { const r = agencyRate(d.toLoc, 'Dyeing'); if (r) d.jobRate = r; } },
        { k: 'colorReq', label: 'Colour required', type: 'text', list: true }, { k: 'shade', label: 'Shade / colour code', type: 'text' },
        { k: 'jobRate', label: 'Job work rate (₹/kg)', type: 'number', fmt: 'money' }, { k: 'expectedDate', label: 'Expected delivery by', type: 'date' },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' }, { k: 'driver', label: 'Driver', type: 'text' }] },
      { grid: { k: 'lines', title: 'Grey fabric lots (rolls fill in at the lot\'s average)', cols: [C.item(['Grey Fabric']), C.lotFrom(d => d.fromLoc, 'Lot'), C.qty('Qty (kg)'), C.rolls, C.unit], onEdit: (d, r, ctx) => { if (r) ctx.autoRolls(r, d.fromLoc); } } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'fromLoc', 'toLoc', { k: '_lots', label: 'Lots', value: d => (d.lines || []).map(l => l.lot).join(', ') }, { k: '_qty', label: 'Total kg', fmt: 'qty', value: d => sumQty(d.lines) }, 'vehicleNo'],
  },
  transfers: {
    title: 'Stock Transfers', singular: 'Stock Transfer', col: 'transfers', printTitle: 'STOCK TRANSFER NOTE',
    layout: [
      { fields: [
        F.no, F.date,
        { k: 'purpose', label: 'Purpose', type: 'select', options: ['General', 'Yarn Issue', 'Grey Transfer', 'Godown Transfer', 'Chemical Issue', 'Return to Store'], def: 'General', list: true },
        { k: 'fromLoc', label: 'From', type: 'ref', ref: 'locations', req: true, def: 'STORE', list: true },
        { k: 'toLoc', label: 'To', type: 'ref', ref: 'locations', req: true, list: true },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' }, { k: 'person', label: 'Person responsible', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(S.CATEGORIES), C.lotFrom(d => d.fromLoc, 'Lot'), C.qty(), C.rollsOut(d => d.fromLoc), C.unit], onEdit: (d, r, ctx) => { if (r) ctx.autoRolls(r, d.fromLoc); } } },
      { fields: [F.remarks] },
    ],
  },
  godownTransfer: {
    title: 'Godown Transfer', singular: 'Godown Transfer', col: 'transfers', printTitle: 'GODOWN TRANSFER NOTE',
    fixed: { purpose: 'Godown Transfer' }, where: d => d.purpose === 'Godown Transfer',
    note: 'Moves finished rolls from one godown to another. Choose the lot and the rolls: their kg go with them, and each roll keeps its weight.',
    layout: [
      { fields: [F.no, F.date,
        { k: 'fromLoc', label: 'From godown', type: 'ref', ref: 'locations', req: true, def: 'FG', w: 2, list: true, filter: isGodown, onChange: d => { for (const l of d.lines || []) { l.lot = ''; delete l.rollPick; } } },
        { k: 'toLoc', label: 'To godown', type: 'ref', ref: 'locations', req: true, w: 2, list: true, filter: (l, d) => isGodown(l) && l.id !== d.fromLoc },
        { k: 'person', label: 'Person responsible', type: 'text', list: true }, { k: 'vehicleNo', label: 'Vehicle no', type: 'text' }] },
      { grid: { k: 'lines', title: 'Fabric moved', cols: [C.item(['Finished Goods']), C.lotFrom(d => d.fromLoc, 'Lot'), C.qty('Qty (kg)'), C.rollsOut(d => d.fromLoc), C.unit], totals: ['qty', 'rolls'],
        onEdit: (d, r, ctx) => { if (r) ctx.autoRolls(r, d.fromLoc); } } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'fromLoc', 'toLoc', { k: '_lots', label: 'Lots', value: d => (d.lines || []).map(l => l.lot).join(', ') }, { k: '_qty', label: 'Kg', fmt: 'qty', value: d => sumQty(d.lines) },
      { k: '_rolls', label: 'Rolls', fmt: 'int', value: d => (d.lines || []).reduce((t, l) => t + S.num(l.rolls), 0) }, 'person'],
  },
  stockAdjust: {
    title: 'Opening Stock / Adjustment', singular: 'Stock Adjustment', col: 'stockAdjust',
    note: 'Enter opening stock with positive qty and rate: leave the lot on "new lot (auto)" and yarn or fabric gets the next lot number when you save, or type your own lot number in the lot box and pick "New lot". Use negative qty, and choose the lot, to write off damaged or short stock.',
    layout: [
      { fields: [F.no, F.date, { k: 'location', label: 'Location', type: 'ref', ref: 'locations', req: true, def: 'STORE', list: true }, { k: 'reason', label: 'Reason', type: 'select', options: ['Opening Stock', 'Physical Verification', 'Damage / Write-off', 'Other'], def: 'Opening Stock', list: true }] },
      { grid: { k: 'lines', title: 'Items (+ adds, - removes)', cols: [C.item(S.CATEGORIES, { onChange: r => { const i = itemOf(r.item); if (i && !S.num(r.rate)) r.rate = S.num(i.rate); } }), C.lotAdjust, C.rollWeights, C.qty('Qty (+/-)'), C.unit, C.rolls, { k: 'rate', label: 'Rate (for +)', type: 'number', fmt: 'money' }, C.amount],
        onEdit: (d, r) => { if (r) applyRollWeights(r, 'qty'); } } },
      { fields: [F.remarks] },
    ],
    beforeSave: lotsChecked(r => r._lotNew && !!r.lot, true), savedNote: lotsSaved,
  },

  /* ===== Production ===== */
  knitting: {
    title: 'Knitting Production', singular: 'Knitting Entry', col: 'knitting', printTitle: 'KNITTING PRODUCTION SLIP',
    note: 'Record the grey fabric a knitting agency delivers. It uses the yarn issued to that agency, keeps the yarn\'s lot number, and goes to the dyeing agency you choose. The job charges go to the agency\'s account.',
    onNew: async doc => { const p = Cache.list('processes').find(x => x.stage === 'Knitting'); if (p) { doc.process = p.id; doc.labourRate = S.num(p.labourRate); } },
    recalc: productionRecalc('Knitting'),
    layout: [
      { fields: [
        F.no, F.date,
        workPlace('Knitting', d => { for (const l of d.lines || []) l.lot = ''; }),
        { k: 'lotNo', label: 'Lot no', type: 'calc', list: true, value: d => (d.id && d.lotNo) || S.mainLot(d.lines) || 'from the yarn lot',
          help: 'Same as the main yarn lot (the yarn line with the most kg)' },
        { k: 'machine', label: 'Machine', type: 'ref', ref: 'machines', filter: m => m.type === 'Knitting', list: true },
        processField('Knitting'),
        { k: 'shift', label: 'Shift', type: 'select', options: ['Day', 'Night', 'General'], def: 'Day' },
        { k: 'operator', label: 'Operator', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Yarn consumed (from the yarn issued to this agency)', cols: [C.item(['Yarn']), C.lotFrom(d => d.location, 'Yarn lot'), C.qty('Qty (kg)'), C.unit], totals: ['qty'] } },
      { title: 'Grey fabric output, wastage & job charges', fields: outputFields('Knitting', ['Grey Fabric'], [
        { k: '_avgRoll', label: 'Average roll weight (kg)', type: 'calc', fmt: 'qty', value: d => S.num(d.rolls) ? S.num(d.outQty) / S.num(d.rolls) : '' },
        { k: '_yarnLeft', label: 'Yarn still at the agency after this (kg)', type: 'calc', fmt: 'qty',
          value: (d, _, ctx) => d.location && ctx && ctx.stockRows ? Math.max(0, ctx.stockRows().filter(r => r.loc === d.location && (itemOf(r.item) || {}).category === 'Yarn').reduce((t, r) => t + r.qty, 0) - sumQty(d.lines)) : '' },
        { k: 'gsm', label: 'GSM', type: 'number' }, { k: 'dia', label: 'Dia', type: 'text' },
        { k: 'outLoc', label: 'Grey fabric sent to', type: 'ref', ref: 'locations', req: true, w: 2, legacy: 'KNIT',
          filter: (l, d) => l.id === d.location || l.id === 'STORE' || doesWork(l, 'Dyeing'),
          help: 'The dyeing agency it goes to. Or keep it at the knitting agency (send it later with Send Grey for Dyeing).' }]) },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'lotNo', 'location', { k: '_in', label: 'Yarn kg', fmt: 'qty', value: d => sumQty(d.lines) }, { k: 'outQty', label: 'Grey kg', fmt: 'qty' }, { k: 'rolls', label: 'Rolls', fmt: 'int' }, { k: 'wastageQty', label: 'Wastage kg', fmt: 'qty' },
      { k: 'outLoc', label: 'Grey sent to' }],
  },
  dyeing: {
    title: 'Dyeing / Coloring', singular: 'Dyeing Entry', col: 'dyeing', printTitle: 'DYEING BATCH CARD',
    fixed: { chemLoc: 'STORE' },
    note: 'Record the dyed fabric a dyeing agency delivers. It takes the grey lot sent to that agency and keeps its lot number. Add dyes & chemicals only if you supply them from the Main Store. The job charges go to the agency\'s account.',
    onNew: async doc => { const p = Cache.list('processes').find(x => x.stage === 'Dyeing'); if (p) { doc.process = p.id; doc.labourRate = S.num(p.labourRate); } },
    recalc: productionRecalc('Dyeing'),
    layout: [
      { fields: [
        F.no, F.date,
        Object.assign(workPlace('Dyeing', d => { d.lotNo = ''; if (!d.outLoc || d.outLoc === d._autoOut) d.outLoc = d._autoOut = doesWork(byId('locations', d.location), 'Finishing') ? d.location : ''; }), { legacy: 'DYE' }),
        { k: 'inItem', label: 'Grey fabric', type: 'ref', ref: 'items', req: true, w: 2, filter: i => i.category === 'Grey Fabric' },
        { k: 'lotNo', label: 'Lot no', type: 'lot', loc: d => d.location || 'DYE', itemKey: 'inItem', req: true, list: true,
          onChange: (d, ctx) => { const a = ctx.available(d.location || 'DYE', d.inItem, d.lotNo); if (a > 0) d.inQty = a; fillInRolls(d, ctx); } },
        { k: 'inQty', label: 'Input qty (kg)', type: 'number', req: true, fmt: 'qty', onChange: fillInRolls },
        { k: 'machine', label: 'Machine', type: 'ref', ref: 'machines', filter: m => m.type === 'Dyeing' },
        processField('Dyeing'),
        { k: 'color', label: 'Color', type: 'text', list: true },
        { k: 'shade', label: 'Shade / %', type: 'text' },
        bomField('Dyeing'),
      ] },
      { grid: { k: 'lines', title: 'Dyes & chemicals we supply (from Main Store; leave empty if the agency uses its own)', cols: [C.item(['Dyes & Chemicals']), C.lotFrom(d => d.chemLoc || 'STORE', 'Batch'), C.qty('Qty'), C.unit], onEdit: d => { d._bomAuto = false; } } },
      { title: 'Colored fabric output, wastage & job charges', fields: outputFields('Dyeing', ['Colored Fabric'], [
        { k: 'outLoc', label: 'Dyed fabric sent to', type: 'ref', ref: 'locations', req: true, w: 2, legacy: 'DYE',
          filter: (l, d) => l.id === d.location || l.id === 'STORE' || doesWork(l, 'Finishing'),
          help: 'The finishing agency it goes to, or this same agency when it also finishes' }]) },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'lotNo', 'location', 'color', { k: 'inQty', label: 'Grey kg', fmt: 'qty' }, { k: 'outQty', label: 'Dyed kg', fmt: 'qty' }, { k: 'wastageQty', label: 'Wastage kg', fmt: 'qty' }, { k: 'outLoc', label: 'Sent to' }],
  },
  finishing: {
    title: 'Finishing & Packing', singular: 'Finishing Entry', col: 'finishing', printTitle: 'FINISHING & PACKING SLIP',
    fixed: { packLoc: 'STORE' },
    note: 'Record the finished, packed rolls an agency delivers to the Finished Goods Store. It takes the dyed lot sent to that agency and keeps its lot number. Add packing material only if you supply it. The job charges go to the agency\'s account.',
    onNew: async doc => { const p = Cache.list('processes').find(x => x.stage === 'Finishing'); if (p) { doc.process = p.id; doc.labourRate = S.num(p.labourRate); } },
    recalc: productionRecalc('Finishing'),
    layout: [
      { fields: [
        F.no, F.date,
        Object.assign(workPlace('Finishing', d => { d.lotNo = ''; }), { legacy: 'DYE' }),
        { k: 'inItem', label: 'Colored fabric', type: 'ref', ref: 'items', req: true, w: 2, filter: i => i.category === 'Colored Fabric' },
        { k: 'lotNo', label: 'Lot no', type: 'lot', loc: d => d.location || 'DYE', itemKey: 'inItem', req: true, list: true,
          onChange: (d, ctx) => { const a = ctx.available(d.location || 'DYE', d.inItem, d.lotNo); if (a > 0) d.inQty = a; fillInRolls(d, ctx); } },
        { k: 'inQty', label: 'Input qty (kg)', type: 'number', req: true, fmt: 'qty', onChange: fillInRolls },
        processField('Finishing'),
        { k: 'finishType', label: 'Finish', type: 'select', options: ['Compacting', 'Stentering', 'Open width', 'Tubular', 'Raising', 'Other'] },
        bomField('Finishing'),
      ] },
      { grid: { k: 'lines', title: 'Packing material we supply (from Main Store; leave empty if the agency packs with its own)', cols: [C.item(['Packing Material', 'Others']), C.lotFrom(d => d.packLoc || 'STORE', 'Batch'), C.qty(), C.unit], onEdit: d => { d._bomAuto = false; } } },
      { title: 'Finished goods output (roll / kg), wastage & job charges', fields: outputFields('Finishing', ['Finished Goods'], [{ k: 'meters', label: 'Meters', type: 'number', fmt: 'qty' }, { k: 'quality', label: 'Quality / grade', type: 'select', options: ['A', 'B', 'Seconds'], def: 'A' },
        { k: 'outLoc', label: 'Finished rolls go to', type: 'ref', ref: 'locations', req: true, w: 2, def: 'FG', legacy: 'FG', filter: isGodown, help: 'The Finished Goods Store or another godown' },
        { k: '_avgRoll', label: 'Average roll weight (kg)', type: 'calc', fmt: 'qty', value: d => S.num(d.rolls) ? S.num(d.outQty) / S.num(d.rolls) : '' }]) },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'lotNo', 'location', { k: 'outItem', label: 'Item' }, { k: 'inQty', label: 'In kg', fmt: 'qty' }, { k: 'outQty', label: 'FG kg', fmt: 'qty' }, { k: 'rolls', label: 'Rolls', fmt: 'int' }, { k: 'wastageQty', label: 'Wastage kg', fmt: 'qty' }, { k: 'outLoc', label: 'Godown' }],
  },
  jobStatus: {
    title: 'Processing Status Updates', singular: 'Status Update', col: 'jobStatus', stock: true,
    note: 'Record where a lot stands at a dyeing or finishing agency. The status moves by itself when the fabric is sent, dyed and received; use this for the steps in between. The Processing Status page shows every lot with its latest status.',
    layout: [{ fields: [
      F.no, F.date,
      { k: 'location', label: 'Agency', type: 'ref', ref: 'locations', req: true, w: 2, list: true, filter: l => doesWork(l, 'Dyeing') || doesWork(l, 'Finishing'), onChange: d => { d.lot = ''; } },
      { k: 'lot', label: 'Lot', type: 'select', req: true, list: true,
        options: (d, ctx) => {
          const rows = ctx && ctx.stockRows ? ctx.stockRows().filter(r => r.loc === d.location && r.lot && r.qty > 0.0005 && fabricCat(r.item)) : [];
          const o = rows.map(r => [r.lot, r.lot + ' · ' + ((itemOf(r.item) || {}).name || '') + ' · ' + U.qty(r.qty) + ' kg']);
          if (d.lot && !o.some(x => x[0] === d.lot)) o.unshift([d.lot, d.lot]);
          return o;
        } },
      { k: 'status', label: 'Status', type: 'select', req: true, list: true, options: S.JOB_STATUSES },
      { k: 'remarks', label: 'Remarks', type: 'textarea', w: 4, list: true },
    ] }],
  },

  /* ===== Expenses ===== */
  overheads: {
    title: 'Expenses', singular: 'Expense', col: 'overheads', printTitle: 'EXPENSE VOUCHER',
    note: 'Every expense: transport, rent, repairs, office, phone, miscellaneous. Tick "Add to production cost" for factory expenses: they are spread over the kg finished in that month and added to each lot\'s cost. Electricity bills have their own screen.',
    layout: [{ fields: [
      F.no, F.date,
      { k: 'category', label: 'Expense head', type: 'select', req: true, w: 2, list: true,
        options: d => S.EXPENSE_CATEGORIES.concat(d && d.category && !S.EXPENSE_CATEGORIES.includes(d.category) ? [d.category] : []),
        onChange: d => { d.toCost = S.COST_CATEGORIES.includes(d.category); } },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      { k: 'paidTo', label: 'Paid to', type: 'text', list: true }, F.modeBank, F.bank(), F.refNo,
      { k: 'toCost', label: 'Add to production cost (overhead)', type: 'check', w: 2, list: true },
      F.cleared, F.chequeCleared, F.chequeNote, F.remarks,
    ] }],
    listFilter: { k: 'category', options: S.OVERHEAD_CATEGORIES },
  },
  banks: {
    title: 'Bank & Cash Accounts', singular: 'Account', col: 'banks', master: true,
    note: 'Cash in Hand is built in. Add each bank account once. Receipts, payments, expenses, salaries, EMIs and bills name the account the money went through, and the Bank & Cash Book shows each balance.',
    layout: [{ fields: [
      { k: 'name', label: 'Account name', type: 'text', req: true, w: 2, list: true, placeholder: 'e.g. SBI Current A/c' },
      { k: 'type', label: 'Type', type: 'select', options: ['Bank', 'Cash'], def: 'Bank', req: true, list: true },
      { k: 'bankName', label: 'Bank', type: 'text', list: true },
      { k: 'accountNo', label: 'Account no', type: 'text', list: true },
      { k: 'ifsc', label: 'IFSC', type: 'text' },
      { k: 'branch', label: 'Branch', type: 'text', w: 2 },
      { k: 'openingBalance', label: 'Opening balance (₹)', type: 'number', fmt: 'money', help: 'Minus for an overdraft' },
      { k: 'openingDate', label: 'Balance as on', type: 'date' },
      F.remarks,
    ] }],
  },
  bankEntries: {
    title: 'Bank Entries', singular: 'Bank Entry', col: 'bankEntries', printTitle: 'BANK / CASH VOUCHER',
    note: 'Money moved between your own accounts (cash deposited, cash withdrawn, transfers), and bank charges or interest. Customer and supplier money goes in Receipts and Payments, expenses in Expenses.',
    layout: [{ fields: [
      F.no, F.date,
      { k: 'kind', label: 'Kind', type: 'select', options: BANK_KINDS, def: 'Cash deposit', req: true, w: 2, list: true,
        onChange: d => { if (d.kind === 'Cash deposit') d.fromBank = 'CASH'; if (d.kind === 'Cash withdrawal') d.toBank = 'CASH'; if (!FROM_KINDS.includes(d.kind) && d.kind !== 'Cash deposit') d.fromBank = ''; if (!TO_KINDS.includes(d.kind) && d.kind !== 'Cash withdrawal') d.toBank = ''; } },
      { k: 'fromBank', label: 'From account', type: 'ref', ref: 'banks', list: true, show: d => FROM_KINDS.includes(d.kind), filter: (b, d) => d.kind !== 'Cash withdrawal' || b.type === 'Bank' },
      { k: 'toBank', label: 'To account', type: 'ref', ref: 'banks', list: true, show: d => TO_KINDS.includes(d.kind), filter: (b, d) => d.kind !== 'Cash deposit' || b.type === 'Bank' },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      F.refNo, { k: 'clearedOn', label: 'Cleared in bank on', type: 'date', help: 'Date it shows in the bank statement' }, F.remarks,
    ] }],
    onNew: async doc => { doc.fromBank = 'CASH'; doc.toBank = mainBank(); },
  },
  loans: {
    title: 'Loans', singular: 'Loan', col: 'loans', master: true,
    note: 'Each loan or finance with its EMI. EMIs fall due every month on the day of the first EMI date; pay them in EMI Payments.',
    layout: [{ fields: [
      { k: 'name', label: 'Lender / loan name', type: 'text', req: true, w: 2, list: true, placeholder: 'e.g. HDFC Bank - Machinery Loan' },
      { k: 'loanNo', label: 'Loan account no', type: 'text', list: true },
      { k: 'amount', label: 'Loan amount (₹)', type: 'number', fmt: 'money', list: true },
      { k: 'rate', label: 'Interest rate (% a year)', type: 'number' },
      { k: 'emi', label: 'EMI amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      { k: 'tenure', label: 'Number of EMIs', type: 'number', fmt: 'int', list: true },
      { k: 'firstEmi', label: 'First EMI date', type: 'date', req: true, list: true, help: 'Later EMIs fall on the same day each month' },
      F.bank('Paid from (account)'),
      { k: 'status', label: 'Status', type: 'select', options: ['Active', 'Closed'], def: 'Active', list: true },
      F.remarks,
    ] }],
  },
  emiPayments: {
    title: 'EMI Payments', singular: 'EMI Payment', col: 'emiPayments', printTitle: 'EMI PAYMENT VOUCHER',
    layout: [{ fields: [
      F.no, F.date,
      { k: 'loan', label: 'Loan', type: 'ref', ref: 'loans', req: true, w: 2, list: true, filter: l => l.status !== 'Closed', onChange: d => { const l = byId('loans', d.loan); if (l) { d.amount = S.num(l.emi); if (l.bank) d.bank = l.bank; } } },
      { k: 'forMonth', label: 'EMI for month', type: 'month', def: () => U.today().slice(0, 7), list: true },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
      { k: 'principal', label: 'Principal part (₹)', type: 'number', fmt: 'money' }, { k: 'interest', label: 'Interest part (₹)', type: 'number', fmt: 'money' },
      F.modeBank, F.bank(), F.refNo, F.cleared, F.chequeCleared, F.chequeNote, F.remarks,
    ] }],
  },
  powerBills: {
    title: 'Electricity Bills', singular: 'Electricity Bill', col: 'powerBills', printTitle: 'ELECTRICITY BILL',
    note: 'Enter each bill when it comes, and the payment date when it is paid. The bill goes into production cost for its month: do not enter it again under Expenses.',
    layout: [
      { fields: [
        F.no, Object.assign({}, F.date, { label: 'Bill date' }),
        { k: 'provider', label: 'Electricity provider', type: 'text', list: true, def: () => (Cache.list('powerBills').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || {}).provider || '' },
        { k: 'consumerNo', label: 'Consumer no', type: 'text', list: true, def: () => (Cache.list('powerBills').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || {}).consumerNo || '' },
        { k: 'billMonth', label: 'Bill month', type: 'month', req: true, list: true, def: () => U.today().slice(0, 7) },
        { k: 'units', label: 'Units (kWh)', type: 'number' },
        { k: 'amount', label: 'Bill amount (₹)', type: 'number', req: true, fmt: 'money', list: true },
        { k: 'dueDate', label: 'Due date', type: 'date', list: true },
        { k: 'toCost', label: 'Add to production cost', type: 'check', def: true, w: 2 },
      ] },
      { title: 'Payment', fields: [
        { k: 'paidOn', label: 'Paid on', type: 'date', list: true, help: 'Leave blank until it is paid' },
        { k: 'paidAmount', label: 'Amount paid (₹)', type: 'number', fmt: 'money', help: 'Only if different from the bill' },
        F.modeBank, F.bank(), F.refNo, F.cleared, F.chequeCleared, F.chequeNote,
      ] },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'billMonth', 'provider', 'consumerNo', { k: 'amount', label: 'Amount', fmt: 'money' }, 'dueDate', 'paidOn',
      { k: '_st', label: 'Status', value: d => d.paidOn ? 'Paid' : !d.dueDate ? 'Unpaid' : d.dueDate < U.today() ? 'Overdue' : d.dueDate === U.today() ? 'Due today' : 'Due ' + U.fmtDate(d.dueDate) }],
  },

  /* ===== Staff & salary ===== */
  employees: {
    title: 'Staff', singular: 'Employee', col: 'employees', master: true,
    note: 'Everyone on the payroll. Salary details are seen only by logins allowed to see salaries.',
    layout: [
      { fields: [
        { k: 'name', label: 'Employee name', type: 'text', req: true, w: 2, list: true },
        { k: 'department', label: 'Department', type: 'select', options: S.DEPARTMENTS, list: true },
        { k: 'designation', label: 'Designation', type: 'text', list: true },
        { k: 'phone', label: 'Mobile', type: 'text', list: true },
        { k: 'joinDate', label: 'Joining date', type: 'date', list: true },
        { k: 'active', label: 'Working (untick when the person leaves)', type: 'check', def: true, w: 2, list: true },
        { k: 'address', label: 'Address', type: 'textarea', w: 4 },
      ] },
      { title: 'Salary', show: () => Perm.can('salary', 'view'), fields: [
        { k: 'basis', label: 'Paid', type: 'select', options: [['Monthly', 'Monthly salary'], ['Daily', 'Daily wage']], def: 'Monthly' },
        { k: 'salary', label: 'Salary a month / wage a day (₹)', type: 'number', fmt: 'money' },
        { k: 'bankAccount', label: 'Bank account (for salary transfer)', type: 'text', w: 2 },
      ] },
    ],
    listCols: () => ['name', 'department', 'designation', 'phone', 'joinDate', 'active'].concat(Perm.can('salary', 'view') ? [{ k: 'salary', label: 'Salary / wage', fmt: 'money' }] : []),
    listFilter: { k: 'department', options: S.DEPARTMENTS },
  },
  attendance: {
    title: 'Attendance', singular: 'Attendance', col: 'attendance', printTitle: 'ATTENDANCE SHEET',
    note: 'One entry a day. Everyone working is listed as Present: change only those absent, on half day, on leave or off. Days not marked count as worked for monthly staff.',
    onNew: async doc => {
      const staff = Cache.list('employees').filter(e => e.active !== false).sort((a, b) => (a.department || '').localeCompare(b.department || '') || a.name.localeCompare(b.name));
      doc.staff = staff.length ? staff.map(e => ({ employee: e.id, mark: 'P' })) : [{}];
    },
    layout: [
      { fields: [F.no, F.date, { k: '_count', label: 'Summary', type: 'calc', w: 2, value: d => S.ATTENDANCE.map(a => [a[1], (d.staff || []).filter(r => r.employee && (r.mark || 'P') === a[0]).length]).filter(x => x[1]).map(x => x[1] + ' ' + x[0].toLowerCase()).join(', ') }] },
      { grid: { k: 'staff', title: 'Staff', cols: [
        { k: 'employee', label: 'Employee', type: 'ref', ref: 'employees', req: true, wide: true },
        { k: '_dept', label: 'Department', type: 'calc', value: r => (byId('employees', r.employee) || {}).department || '' },
        { k: 'mark', label: 'Attendance', type: 'select', options: S.ATTENDANCE.map(a => [a[0], a[1]]) },
        { k: 'note', label: 'Note', type: 'text' }] } },
    ],
    listCols: ['no', 'date', { k: '_p', label: 'Present', fmt: 'int', value: d => (d.staff || []).filter(r => r.mark === 'P').length }, { k: '_h', label: 'Half day', fmt: 'int', value: d => (d.staff || []).filter(r => r.mark === 'H').length },
      { k: '_a', label: 'Absent', fmt: 'int', value: d => (d.staff || []).filter(r => r.mark === 'A').length }, { k: '_l', label: 'Leave / off', fmt: 'int', value: d => (d.staff || []).filter(r => r.mark === 'L' || r.mark === 'O').length }],
  },
  salary: {
    title: 'Salary & Advances', singular: 'Salary Payment', col: 'salary', printTitle: 'SALARY PAYMENT VOUCHER',
    note: 'Pay a month\'s salary (the form shows what is due from the attendance) or give an advance. Advances are recovered from later salaries in "Advance recovered".',
    info: async doc => {
      if (!doc.employee) return '';
      const r = await API.report('salaryDue', { employee: doc.employee, month: doc.month, id: doc.id || '' });
      if (doc.kind === 'Advance') return 'Advance outstanding: ₹ ' + U.money(r.advance);
      if (!doc.id && !S.num(doc.amount)) doc.amount = Math.max(0, S.r2(r.balance - S.num(doc.advanceDeducted)));
      return 'Due ₹ ' + U.money(r.due) + ' for ' + r.paidDays + ' of ' + r.days + ' days · still to pay ₹ ' + U.money(r.balance) + (r.advance ? ' · advance outstanding ₹ ' + U.money(r.advance) : '');
    },
    layout: [{ fields: [
      F.no, F.date,
      { k: 'employee', label: 'Employee', type: 'ref', ref: 'employees', req: true, w: 2, list: true, filter: e => e.active !== false, onChange: (d, ctx) => { d.amount = ''; ctx.loadInfo(); } },
      { k: 'kind', label: 'Payment', type: 'select', options: ['Salary', 'Advance'], def: 'Salary', req: true, list: true, onChange: (d, ctx) => { d.amount = ''; ctx.loadInfo(); } },
      { k: 'month', label: 'Salary for month', type: 'month', list: true, def: prevMonth, show: d => d.kind !== 'Advance', onChange: (d, ctx) => { d.amount = ''; ctx.loadInfo(); } },
      { k: '_info', label: 'Salary position', type: 'calc', w: 4, value: d => d._infoText || '' },
      { k: 'advanceDeducted', label: 'Advance recovered (₹)', type: 'number', fmt: 'money', show: d => d.kind !== 'Advance', help: 'Taken back from this salary' },
      { k: 'amount', label: 'Amount paid (₹)', type: 'number', req: true, fmt: 'money', list: true },
      F.modeBank, F.bank(), F.refNo, F.cleared, F.chequeCleared, F.chequeNote, F.remarks,
    ] }],
  },

  /* ===== Sales ===== */
  leads: {
    title: 'Leads & Follow-ups', singular: 'Lead', col: 'leads', printTitle: 'SALES LEAD',
    note: 'Every enquiry from a new or existing customer. Note each call or visit below with the next follow-up date: the latest one sets the lead\'s next follow-up, and the Follow-ups page lists what is due.',
    layout: [
      { fields: [
        F.no, F.date,
        { k: 'name', label: 'Customer / prospect name', type: 'text', req: true, w: 2, list: true },
        { k: 'party', label: 'Existing customer', type: 'ref', ref: 'parties', w: 2, filter: p => S.partyIs(p, 'Customer'), onChange: d => { const p = byId('parties', d.party); if (p) { d.name = p.name; d.phone = d.phone || p.phone || ''; d.city = d.city || p.city || ''; } } },
        { k: 'contactPerson', label: 'Contact person', type: 'text' }, { k: 'phone', label: 'Mobile', type: 'text', list: true }, { k: 'city', label: 'City', type: 'text', list: true },
        { k: 'source', label: 'Source', type: 'select', options: ['Walk-in', 'Phone call', 'WhatsApp', 'Reference', 'Existing customer', 'Exhibition', 'Online', 'Other'] },
        { k: 'requirement', label: 'Fabric / quality wanted', type: 'text', w: 2, list: true }, { k: 'color', label: 'Colour', type: 'text' }, { k: 'qty', label: 'Qty (kg)', type: 'number', fmt: 'qty' },
        { k: 'status', label: 'Stage', type: 'select', options: LEAD_STAGES, def: 'New', req: true, list: true },
        { k: 'assignedTo', label: 'Assigned to', type: 'text', list: true },
        { k: 'nextDate', label: 'Next follow-up', type: 'date', list: true },
      ] },
      { grid: { k: 'followUps', title: 'Follow-ups (calls, visits, messages)', cols: [{ k: 'date', label: 'Date', type: 'date' }, { k: 'mode', label: 'How', type: 'select', options: ['Call', 'Visit', 'WhatsApp', 'Email', 'Meeting'] },
        { k: 'notes', label: 'What was discussed', type: 'text', wide: true }, { k: 'nextDate', label: 'Next follow-up', type: 'date' }] } },
      { fields: [F.remarks] },
    ],
    onNew: async doc => { doc.followUps = [{ date: U.today() }]; },
    listFilter: { k: 'status', options: LEAD_STAGES },
  },
  quotations: {
    title: 'Quotations', singular: 'Quotation', col: 'quotations', printTitle: 'QUOTATION',
    note: 'Prices offered to a customer or a new prospect. When the order comes, choose the quotation on the sales order to copy its lines.',
    layout: [
      { fields: [F.no, F.date, F.party('Customer', { req: false, list: false, help: 'Or type a prospect\'s name below' }),
        { k: 'prospect', label: 'Prospect (not a customer yet)', type: 'text', w: 2 },
        { k: 'leadId', label: 'For lead', type: 'ref', ref: 'leads', filter: l => l.status !== 'Lost', onChange: d => { const l = byId('leads', d.leadId); if (l) { if (l.party) d.party = l.party; else d.prospect = l.name; } } },
        { k: 'validTill', label: 'Valid till', type: 'date', list: true },
        { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Accepted', 'Rejected', 'Expired'], def: 'Open', list: true }] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), colorCol, C.qty('Qty (kg)'), C.rolls, C.unit, C.rate, C.gst, C.amount], onEdit: (d, r) => estimateKg(r) } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'terms', label: 'Terms', type: 'textarea', w: 3 }] },
      { totals: true },
    ],
    needs: ['leads'],
    listCols: ['no', 'date', { k: '_to', label: 'Customer / prospect', value: d => partyName(d.party) || d.prospect || '' }, 'validTill', { k: 'total', label: 'Total', fmt: 'money' }, 'status'],
  },
  salesOrders: {
    title: 'Sales Orders', singular: 'Sales Order', col: 'salesOrders', printTitle: 'SALES ORDER', credit: true,
    layout: [
      { fields: [F.no, F.date, F.party('Customer', { list: true, onChange: (d, ctx) => ctx.loadBalance() }), { k: '_bal', label: 'Outstanding', type: 'calc', value: d => d._balText || '' },
        { k: 'quoteId', label: 'Against quotation', type: 'ref', ref: 'quotations', filter: (r, d) => r.status !== 'Rejected' && (!d.party || !r.party || r.party === d.party),
          onChange: d => { const qt = byId('quotations', d.quoteId); if (qt) { if (qt.party && !d.party) d.party = qt.party; d.lines = (qt.lines || []).map(l => ({ item: l.item, color: l.color, qty: l.qty, rolls: l.rolls, rate: l.rate, gst: l.gst })); if (qt.freight) d.freight = qt.freight; } } },
        { k: 'customerPo', label: 'Customer PO no', type: 'text' }, { k: 'deliveryDate', label: 'Delivery by', type: 'date' }, { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed', 'Cancelled'], def: 'Open', list: true }] },
      { grid: { k: 'lines', title: 'Items (type rolls only and the kg is estimated from the average roll weight)', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), colorCol, C.qty('Qty (kg)'), C.rolls, C.unit, C.rate, C.gst, C.amount], onEdit: (d, r) => estimateKg(r) } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'terms', label: 'Terms', type: 'textarea', w: 3 }] },
      { totals: true },
    ],
    listCols: ['no', 'date', 'party', 'customerPo', 'deliveryDate', { k: 'total', label: 'Total', fmt: 'money' }, 'status'],
  },
  deliveries: {
    title: 'Delivery Challans', singular: 'Delivery Challan', col: 'deliveries', printTitle: 'DELIVERY CHALLAN',
    note: 'Dispatches finished lots from a godown.',
    layout: [
      { fields: [
        F.no, F.date, F.party('Customer'),
        { k: 'location', label: 'From godown', type: 'ref', ref: 'locations', req: true, def: 'FG', legacy: 'FG', filter: isGodown, onChange: d => { for (const l of d.lines || []) { l.lot = ''; delete l.rollPick; } } },
        { k: 'soId', label: 'Against sales order', type: 'ref', ref: 'salesOrders', filter: (r, d) => r.party === d.party && r.status !== 'Cancelled',
          onChange: d => { const so = byId('salesOrders', d.soId); if (so) d.lines = pendingFrom(so, 'deliveries', 'soId', d.id).map(l => ({ item: l.item, lot: '', qty: l.qty, rolls: '', rate: l.rate })); } },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text', list: true },
        { k: 'transporter', label: 'Transporter', type: 'text' },
      ] },
      { grid: { k: 'lines', title: 'Goods dispatched', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), C.lotFrom(d => d.location || 'FG', 'Lot'), C.qty('Qty (kg)'), C.rollsOut(d => d.location || 'FG'), C.unit, C.rate, C.amount], totals: ['qty', 'rolls'],
        onEdit: (d, r, ctx) => { if (r) ctx.autoRolls(r, d.location || 'FG'); } } },
      { fields: [F.remarks] },
    ],
    listCols: ['no', 'date', 'party', { k: '_qty', label: 'Kg', fmt: 'qty', value: d => sumQty(d.lines) }, { k: '_rolls', label: 'Rolls', fmt: 'int', value: d => (d.lines || []).reduce((t, l) => t + S.num(l.rolls), 0) }, 'vehicleNo', { k: '_inv', label: 'Invoiced', value: d => { const i = Cache.list('invoices').find(x => x.challanId === d.id); return i ? i.no : '—'; } }],
    needs: ['invoices'],
  },
  invoices: {
    title: 'Sales Invoices', singular: 'Invoice', col: 'invoices', printTitle: 'TAX INVOICE', credit: true,
    note: 'Pick a delivery challan to bill it, or enter lots directly (stock then leaves the godown with the invoice). Part payments and credit sales show in the Payment column; record money received in Payment Receipts.',
    info: payInfo, listExtra: 'billStatus',
    layout: [
      { fields: [
        F.no, F.date, F.party('Customer', { onChange: (d, ctx) => ctx.loadBalance() }),
        { k: '_bal', label: 'Outstanding', type: 'calc', value: d => d._balText || '' },
        { k: '_info', label: 'Payment status', type: 'calc', w: 2, value: d => d._infoText || '', show: d => !!d.id },
        { k: 'challanId', label: 'Against challan', type: 'ref', ref: 'deliveries',
          filter: (r, d) => r.party === d.party && !Cache.list('invoices').some(i => i.challanId === r.id && i.id !== d.id),
          onChange: d => { const c = byId('deliveries', d.challanId); if (c) d.lines = c.lines.map(l => ({ item: l.item, lot: l.lot, qty: l.qty, rolls: l.rolls, rollPick: l.rollPick, rate: S.num(l.rate) || priceFor(d.party, l.item), gst: S.num((itemOf(l.item) || {}).gst) })); } },
        { k: 'location', label: 'From godown', type: 'ref', ref: 'locations', def: 'FG', legacy: 'FG', filter: isGodown, show: d => !d.challanId, onChange: d => { for (const l of d.lines || []) { l.lot = ''; delete l.rollPick; } } },
        { k: 'placeOfSupply', label: 'Place of supply', type: 'select', options: S.STATE_NAMES, help: 'Blank = customer\'s state. Decides CGST+SGST or IGST' },
        { k: 'vehicleNo', label: 'Vehicle no', type: 'text' },
        { k: 'dueDate', label: 'Due date', type: 'date' },
      ] },
      { grid: { k: 'lines', title: 'Items', cols: [C.item(['Finished Goods'], { onChange: fillSaleLine }), C.lotFrom(d => d.location || 'FG', 'Lot'), C.qty('Qty (kg)'), C.rollsOut(d => d.location || 'FG', d => !!d.challanId), C.unit, C.rate, C.gst, C.amount], totals: ['qty', 'rolls'],
        onEdit: (d, r, ctx) => { if (r && !d.challanId) ctx.autoRolls(r, d.location || 'FG'); } } },
      { fields: [{ k: 'freight', label: 'Freight (₹)', type: 'number', fmt: 'money' }, { k: 'otherCharges', label: 'Other charges (₹)', type: 'number', fmt: 'money' }, { k: 'discount', label: 'Discount (₹)', type: 'number', fmt: 'money' }, F.remarks] },
      { totals: true },
    ],
    listCols: ['no', 'date', 'party', { k: 'challanId', label: 'Challan' }, { k: 'taxable', label: 'Taxable', fmt: 'money' }, { k: 'tax', label: 'GST', fmt: 'money' }, { k: 'total', label: 'Total', fmt: 'money' },
      { k: '_due', label: 'Balance', fmt: 'money', value: d => (billOf(d) || {}).due }, { k: '_st', label: 'Payment', value: d => (billOf(d) || {}).status || '' }],
  },

  /* ===== Customers ===== */
  customers: {
    title: 'Customer Master', singular: 'Customer', col: 'parties', master: true, extends: 'parties',
    fixed: {}, where: p => S.partyIs(p, 'Customer'),
  },
  receipts: {
    title: 'Payment Receipts', singular: 'Receipt', col: 'receipts', printTitle: 'PAYMENT RECEIPT',
    note: 'Money received from a customer. Paid partly in cash and partly by bank (or cheque, UPI ...)? List each part in the table below; the amount adds up by itself. Whatever is not received stays outstanding as credit.',
    layout: [
      { fields: [
        F.no, F.date, F.party('Customer', { onChange: (d, ctx) => { payParty(d, true); ctx.loadBalance(); } }),
        { k: '_bal', label: 'Outstanding', type: 'calc', value: d => d._balText || '' },
        { k: 'amount', label: 'Amount received (₹)', type: 'number', req: true, fmt: 'money', list: true },
        { k: 'invoiceId', label: 'Against invoice (optional)', type: 'ref', ref: 'invoices', filter: (r, d) => r.party === d.party },
        ...payFields(true), F.cleared, F.chequeCleared, F.chequeNote, F.remarks,
      ] },
      partsGrid('Received in more than one way? List each part (the amount adds up by itself)', true),
    ],
    listCols: ['no', 'date', 'party', 'mode', 'bank', payDetailCol, { k: 'amount', label: 'Amount', fmt: 'money' }, { k: '_chq', label: 'Cheque', value: chequeState }],
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
SCHEMAS.customers.layout = SCHEMAS.parties.layout.filter(b => !b.agency).map(b => Object.assign({}, b, { fields: b.fields.map(f => f.k === 'type' ? Object.assign({}, f, { def: 'Customer' }) : f) }));

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
  { t: 'CRM', icon: 'users', kids: [['Customer Master', 'customers'], ['Leads & Follow-ups', 'leads'], ['Follow-ups Due', '#/report/followUps'], ['Customer Card', '#/report/customer'], ['Payment Receipts', 'receipts'], ['Customer Outstanding', '#/report/outstanding?type=receivable']] },
  { t: 'Masters', icon: 'db', kids: [['Items', 'items'], ['Parties', 'parties'], ['Units', 'units'], ['Locations & Godowns', 'locations'], ['Machines', 'machines'], ['Processes', 'processes'], ['BOM / Recipes', 'boms']] },
  { t: 'Purchase', icon: 'cart', kids: [['Purchase Orders', 'purchaseOrders'], ['Goods Receipt (GRN)', 'grn'], ['Purchase Bills', 'purchaseBills'], ['Supplier Payments', 'payments'], ['Pending POs', '#/report/poPending']] },
  { t: 'Inventory', icon: 'box', kids: [['Stock Summary', '#/report/stock'], ['Yarn Stock', '#/report/stockMovement?category=Yarn'], ['Godown Stock', '#/report/godownStock'], ['Stock Ledger', '#/report/stockLedger'], ['Yarn Issue to Knitting', 'yarnIssue'], ['Send Grey for Dyeing', 'greyTransfer'], ['Godown Transfer', 'godownTransfer'], ['All Transfers', 'transfers'], ['Opening / Adjustment', 'stockAdjust']] },
  { t: 'Production', icon: 'factory', kids: [['Knitting', 'knitting'], ['Dyeing / Coloring', 'dyeing'], ['Finishing & Packing', 'finishing'], ['Processing Status', '#/report/processStatus'], ['Status Updates', 'jobStatus'], ['Job Work Register', '#/report/jobWork'], ['Agency Summary', '#/report/agencies'], ['Production Report', '#/report/production'], ['Batch / Lot Tracking', '#/report/lots']] },
  { t: 'Wastage', icon: 'trash', kids: [['Wastage Report', '#/report/wastage']] },
  { t: 'Costing', icon: 'calc', kids: [['Lot Costing Sheet', '#/report/costing'], ['Item-wise Costing', '#/report/itemCosting'], ['Overhead Absorption', '#/report/overheads']] },
  { t: 'Sales', icon: 'tag', kids: [['Quotations', 'quotations'], ['Sales Orders', 'salesOrders'], ['Delivery Challans', 'deliveries'], ['Invoices', 'invoices'], ['Party Price List', 'priceList'], ['Pending Orders', '#/report/soPending']] },
  { t: 'Finance & Accounts', icon: 'rupee', kids: [['Customer Receipts', 'receipts'], ['Supplier Payments', 'payments'], ['Bank & Cash Book', '#/report/bankBook'], ['Bank Entries', 'bankEntries'], ['Bank Reconciliation', '#/report/bankReco'], ['Cheques Not Cashed', '#/report/cheques'], ['Bank & Cash Accounts', 'banks'],
    ['Expenses', 'overheads'], ['Expense Report', '#/report/expenses'], ['Electricity Bills', 'powerBills'], ['EMI Payments', 'emiPayments'], ['EMI & Loan Status', '#/report/loans'], ['Loans', 'loans'], ['Labour Payments', 'labourPayments'],
    ['Party Ledger', '#/report/partyLedger'], ['Receivables', '#/report/outstanding?type=receivable'], ['Payables', '#/report/outstanding?type=payable'], ['Labour Payable', '#/report/labourPayable']] },
  { t: 'Staff & Salary', icon: 'users', kids: [['Staff', 'employees'], ['Attendance', 'attendance'], ['Attendance Sheet', '#/report/attendanceReport'], ['Salary & Advances', 'salary'], ['Salary Register', '#/report/salaryRegister']] },
  { t: 'GST Reports', icon: 'calc', kids: [['GST Summary', '#/report/gst'], ['Sales Register', '#/report/salesRegister'], ['Purchase Register', '#/report/purchaseRegister'], ['GSTR-1 Data', '#/report/gstr1'], ['GSTR-3B Summary', '#/report/gstr3b'], ['Party GST Details', '#/report/partyGst']] },
  { t: 'Reports', icon: 'chart', href: '#/reports' },
  { t: 'Admin', icon: 'shield', kids: [['Users', 'users'], ['Roles & Permissions', 'roles'], ['Approvals', '#/approvals'], ['Activity Log', '#/report/activity'], ['Settings & Password', '#/settings']] },
];

/* ---------- reports ---------- */
const REPORTS = {
  stock: { title: 'Stock Summary', group: 'Inventory', filters: ['asOn', 'location', 'category', 'item', 'stockGroup', 'zero'] },
  stockLedger: { title: 'Stock Ledger', group: 'Inventory', filters: ['item', 'location', 'lot', 'from', 'to'] },
  stockMovement: { title: 'Stock Movement', group: 'Inventory', filters: ['from', 'to', 'category', 'item', 'zero'] },
  godownStock: { title: 'Godown Stock', group: 'Inventory', filters: ['asOn', 'godown', 'fgItem', 'stockGroup'] },
  negativeStock: { title: 'Stock Exceptions', group: 'Inventory', filters: [] },
  purchase: { title: 'Purchase Report', group: 'Purchase', filters: ['from', 'to', 'supplier', 'item'] },
  poPending: { title: 'Pending Purchase Orders', group: 'Purchase', filters: ['supplier', 'all'] },
  agencies: { title: 'Agency Summary', group: 'Production', filters: ['from', 'to'] },
  jobWork: { title: 'Job Work Register', group: 'Production', filters: ['from', 'to', 'agency', 'all'] },
  processStatus: { title: 'Processing Status', group: 'Production', filters: ['agency', 'from', 'to'] },
  production: { title: 'Production Report', group: 'Production', filters: ['from', 'to', 'stage', 'agency'] },
  lots: { title: 'Batch / Lot Tracking', group: 'Production', filters: ['lot'] },
  wastage: { title: 'Wastage Report', group: 'Production', filters: ['from', 'to', 'stage'] },
  costing: { title: 'Lot Costing Sheet', group: 'Costing', filters: ['from', 'to', 'fgItem'] },
  itemCosting: { title: 'Item-wise Costing', group: 'Costing', filters: ['from', 'to'] },
  overheads: { title: 'Overhead Absorption', group: 'Costing', filters: ['from', 'to'] },
  profitability: { title: 'Profitability Report', group: 'Costing', filters: ['from', 'to', 'customer', 'fgItem', 'groupBy'] },
  sales: { title: 'Sales Report', group: 'Sales', filters: ['from', 'to', 'customer', 'fgItem'] },
  soPending: { title: 'Pending Sales Orders', group: 'Sales', filters: ['customer', 'all'] },
  customer: { title: 'Customer Card', group: 'Sales', filters: ['customerPick'] },
  followUps: { title: 'Follow-ups', group: 'Sales', filters: ['to', 'all'] },
  outstanding: { title: 'Outstanding Report', group: 'Accounts', filters: ['type', 'asOn'] },
  partyLedger: { title: 'Party Ledger', group: 'Accounts', filters: ['party', 'from', 'to'] },
  bankBook: { title: 'Bank & Cash Book', group: 'Accounts', filters: ['account', 'from', 'to'] },
  bankReco: { title: 'Bank Reconciliation', group: 'Accounts', filters: ['bankAccount', 'asOn'] },
  cheques: { title: 'Cheques Not Yet Cashed', group: 'Accounts', filters: ['party', 'anyBank'] },
  expenses: { title: 'Expense Report', group: 'Accounts', filters: ['from', 'to', 'expCategory'] },
  powerBills: { title: 'Electricity Bills', group: 'Accounts', filters: ['from', 'to'] },
  loans: { title: 'EMI & Loan Status', group: 'Accounts', filters: [] },
  labourPayable: { title: 'Labour Payable', group: 'Accounts', filters: ['process', 'from', 'to'] },
  salaryRegister: { title: 'Salary Register', group: 'Staff & Salary', filters: ['month', 'department'] },
  attendanceReport: { title: 'Attendance Sheet', group: 'Staff & Salary', filters: ['month', 'department'] },
  gst: { title: 'GST Summary', group: 'GST', filters: ['from', 'to'] },
  salesRegister: { title: 'Sales Register', group: 'GST', filters: ['from', 'to', 'customer'] },
  purchaseRegister: { title: 'Purchase Register', group: 'GST', filters: ['from', 'to', 'supplier'] },
  gstr1: { title: 'GSTR-1 Data', group: 'GST', filters: ['from', 'to'] },
  gstr3b: { title: 'GSTR-3B Summary', group: 'GST', filters: ['from', 'to'] },
  partyGst: { title: 'Party GST Details', group: 'GST', filters: ['partyType'] },
  activity: { title: 'Activity Log', group: 'Admin', filters: ['from', 'to', 'userName', 'search'] },
};

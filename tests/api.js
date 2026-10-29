// API test: business rules, stock protection, costing maths and permissions.
//   node tests/api.js      (uses a throwaway database in the temp folder)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-api-'));
const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: DATA, PORT: '3999' }), stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);

const B = 'http://localhost:3999'; let T = '';
const call = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => null); return { s: r.status, j }; };
let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };

(async () => {
  await new Promise(r => setTimeout(r, 800));
  let r = await call('POST', '/api/login', { username: 'admin', password: 'wrong' }); ok(r.s === 401, 'bad login rejected');
  r = await call('POST', '/api/login', { username: 'admin', password: 'admin123' }); T = r.j.token; ok(!!T, 'login');
  r = await call('GET', '/api/items'); ok(r.s === 200 && r.j.length === 0, 'empty items');
  const html = await (await fetch(B + '/')).text(); ok(html.includes('Majumdaar'), 'index served');
  ok((await fetch(B + '/js/app.js')).status === 200, 'static js served');
  ok((await fetch(B + '/%2e%2e/server.js')).status !== 200, 'no path traversal');
  const units = (await call('GET', '/api/units')).j; const kg = units.find(u => u.code === 'Kg').id;
  const yarn = (await call('POST', '/api/items', { code: 'Y1', name: 'Yarn A', category: 'Yarn', unit: kg, gst: 5 })).j;
  r = await call('POST', '/api/items', { name: 'yarn a', category: 'Yarn', unit: kg }); ok(r.s === 400, 'duplicate item name rejected: ' + r.j.error);
  const grey = (await call('POST', '/api/items', { code: 'G1', name: 'Grey A', category: 'Grey Fabric', unit: kg, gst: 5 })).j;
  const col = (await call('POST', '/api/items', { name: 'Col A', category: 'Colored Fabric', unit: kg })).j;
  const fg = (await call('POST', '/api/items', { name: 'FG A', category: 'Finished Goods', unit: kg, gst: 5 })).j;
  const chem = (await call('POST', '/api/items', { name: 'Dye X', category: 'Dyes & Chemicals', unit: kg, gst: 18 })).j;
  const sup = (await call('POST', '/api/parties', { name: 'Sup', type: 'Supplier', state: 'West Bengal' })).j;
  const cus = (await call('POST', '/api/parties', { name: 'Cus', type: 'Customer', state: 'Odisha', creditLimit: 1000 })).j;
  const d = '2026-09-01';
  r = await call('POST', '/api/grn', { date: d, party: sup.id, location: 'STORE', lines: [{ item: yarn.id, lot: 'B1', qty: 100, rate: 200 }, { item: chem.id, qty: 10, rate: 500 }, { item: '', qty: 5 }] });
  ok(r.s === 201 && r.j.no === 'GRN-0001' && r.j.lines.length === 2 && r.j.total === 25000, 'GRN created ' + r.j.no + ' total ' + r.j.total);
  ok(r.j.lines[0].lot === 'L-0001' && !r.j.lines[1].lot, 'GRN gives the yarn lot number L-0001 (a typed B1 is not used); the chemical gets none: ' + JSON.stringify(r.j.lines.map(l => l.lot)));
  const grn = r.j;
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: yarn.id, lot: 'L-0001', qty: 150 }] }); ok(r.s === 400 && /raise a purchase order and receive it with a GRN/.test(r.j.error), 'over-issue rejected, with what to do: ' + r.j.error);
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: yarn.id, lot: 'L-0001', qty: 100 }] }); ok(r.s === 201, 'yarn issue');
  r = await call('POST', '/api/knitting', { date: d, lotNo: 'K-99', location: 'KNIT', lines: [{ item: yarn.id, lot: 'L-0001', qty: 100 }], outItem: grey.id, outQty: 95, rolls: 4, wastageQty: 5, labour: 950 });
  ok(r.s === 201 && r.j.lotNo === 'L-0001', 'knitting keeps the yarn lot number L-0001 (a typed K-99 is not used): ' + (r.j.lotNo || r.j.error));
  r = await call('GET', '/api/report/nextLot'); ok(r.j.lot === 'L-0002', 'next lot number is L-0002: ' + r.j.lot);
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Grey Transfer', fromLoc: 'KNIT', toLoc: 'DYE', lines: [{ item: grey.id, lot: 'L-0001', qty: 95, rolls: 4 }] }); ok(r.s === 201, 'grey transfer');
  r = await call('POST', '/api/dyeing', { date: d, lotNo: 'L-0001', inItem: grey.id, inQty: 95, chemLoc: 'STORE', lines: [{ item: chem.id, qty: 2 }], outItem: col.id, outLot: 'L-0001-R', outQty: 90, wastageQty: 5, labour: 1425, color: 'Red' });
  ok(r.s === 201 && !r.j.outLot, 'dyeing keeps lot L-0001 for the colored fabric (no new output lot) ' + ((r.j && (r.j.error || r.j.outLot)) || ''));
  r = await call('POST', '/api/overheads', { date: d, category: 'Maintenance', amount: 880 }); ok(r.s === 201, 'overhead');
  r = await call('POST', '/api/finishing', { date: d, lotNo: 'L-0001', inItem: col.id, inQty: 90, packLoc: 'STORE', lines: [], outItem: fg.id, outQty: 88, rolls: 4, meters: 350, wastageQty: 2, labour: 528 }); ok(r.s === 201, 'finishing ' + ((r.j && r.j.error) || ''));
  const cost = (await call('GET', '/api/report/costing')).j.rows[0];
  // yarn 20000 + dye 1000 + labour 950+1425+528 + overhead 880 = 24783
  ok(Math.abs(cost.total - 24783) < 0.05, 'lot total cost exact: ' + cost.total + ' perKg ' + cost.perKg + ' wastage ' + cost.wastage);
  r = await call('POST', '/api/invoices', { date: d, party: cus.id, lines: [{ item: fg.id, lot: 'L-0001', qty: 50, rate: 400, gst: 5 }] });
  ok(r.s === 201 && r.j.igst === 1000 && r.j.cgst === 0 && r.j.total === 21000, 'IGST invoice total ' + r.j.total);
  const inv = r.j;
  r = await call('POST', '/api/invoices', { date: d, party: cus.id, lines: [{ item: fg.id, lot: 'L-0001', qty: 50, rate: 400, gst: 5 }] }); ok(r.s === 400, 'oversell rejected: ' + r.j.error);
  r = await call('DELETE', '/api/grn/' + grn.id); ok(r.s === 400, 'delete GRN whose yarn was used rejected: ' + r.j.error);
  r = await call('DELETE', '/api/items/' + yarn.id); ok(r.s === 400, 'delete used item rejected: ' + r.j.error);
  r = await call('GET', '/api/report/profitability'); ok(Math.abs(r.j.rows[0].cost - 24783 / 88 * 50) < 0.05, 'profit cost ' + r.j.rows[0].cost + ' profit ' + r.j.rows[0].profit);
  await call('POST', '/api/receipts', { date: d, party: cus.id, amount: 5000 });
  r = await call('GET', '/api/report/outstanding?type=receivable'); ok(r.j.rows[0].balance === 16000 && r.j.rows[0].alert.includes('Over limit'), 'receivable 16000 over limit');
  r = await call('GET', '/api/report/lots'); { const l = r.j.rows[0]; ok(l.lot === 'L-0001' && l.supplier === 'Sup' && l.recdQty === 100 && l.yarnIn === 100 && l.status === 'Finished' && l.inStock === 38, 'lot L-0001 traced from GRN (Sup, 100 kg) to finished, 38 kg in stock: ' + JSON.stringify([l.lot, l.supplier, l.recdQty, l.status, l.inStock])); }
  r = await call('GET', '/api/report/stock?location=STORE'); ok(r.j.rows.length === 1 && r.j.rows[0].qty === 8, 'store chem left 8');
  r = await call('PUT', '/api/invoices/' + inv.id, Object.assign({}, inv, { lines: [{ item: fg.id, lot: 'L-0001', qty: 88, rate: 400, gst: 5 }] })); ok(r.s === 200 && r.j.no === inv.no, 'edit invoice keeps number');
  r = await call('GET', '/api/report/lots'); ok(r.j.rows[0].status === 'Sold out', 'lot sold out after edit');
  r = await call('GET', '/api/report/dashboard'); ok(r.s === 200, 'dashboard');
  for (const n of ['stock', 'stockLedger', 'negativeStock', 'purchase', 'poPending', 'production', 'lots', 'wastage', 'costing', 'itemCosting', 'overheads', 'profitability', 'sales', 'soPending', 'outstanding', 'partyLedger', 'gst', 'stockChoices', 'nextLot', 'partyBalance', 'labourPayable', 'labourBalance']) {
    const x = await call('GET', '/api/report/' + n + '?item=' + yarn.id + '&party=' + cus.id); ok(x.s === 200, 'report ' + n + (x.s !== 200 ? ' ' + x.j.error : ''));
  }
  await call('POST', '/api/users', { username: 'op', name: 'Op', role: 'operator', password: 'secret1', active: true });
  const tok = T; r = await call('POST', '/api/login', { username: 'op', password: 'secret1' }); T = r.j.token;
  r = await call('GET', '/api/users'); ok(r.s === 403, 'operator cannot list users');
  const rc = (await call('GET', '/api/receipts')).j[0]; r = await call('DELETE', '/api/receipts/' + rc.id); ok(r.s === 403, 'operator cannot delete a real receipt');
  r = await call('PUT', '/api/settings', { companyName: 'x' }); ok(r.s === 403, 'operator cannot change settings');
  T = tok; r = await call('POST', '/api/demo'); ok(r.s === 400, 'demo refused on non-empty db');
  r = await call('GET', '/api/users'); ok(r.j.every(u => !u.hash && !u.salt), 'password hashes never sent');
  // ---- knitting straight to the Color Factory ----
  const b2 = (await call('POST', '/api/grn', { date: d, party: sup.id, location: 'STORE', lines: [{ item: yarn.id, qty: 50, rate: 200 }] })).j.lines[0].lot;
  ok(b2 === 'L-0002', 'second GRN gives lot L-0002: ' + b2);
  r = await call('POST', '/api/knitting', { date: d, location: 'KNIT', outLoc: 'DYE', lines: [{ item: yarn.id, lot: b2, qty: 50 }], outItem: grey.id, outQty: 48 });
  ok(r.s === 400 && /Main Store has 50 kg: issue it to the Knitting Factory first/i.test(r.j.error), 'knitting before the yarn is issued says to issue it first: ' + r.j.error);
  await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: yarn.id, lot: b2, qty: 50 }] });
  r = await call('POST', '/api/knitting', { date: d, location: 'KNIT', outLoc: 'DYE', lines: [{ item: yarn.id, lot: b2, qty: 50 }], outItem: grey.id, outQty: 48, rolls: 2, wastageQty: 2 });
  ok(r.s === 201 && r.j.lotNo === b2, 'knitting entry sending grey fabric to the Color Factory, lot ' + r.j.lotNo);
  { const st = (await call('GET', '/api/report/stock')).j.rows.filter(x => x.lot === b2 && x.category === 'Grey Fabric');
    ok(st.length === 1 && st[0].location === 'Color Factory' && st[0].qty === 48, 'grey lot L-0002 is at the Color Factory with no transfer: ' + JSON.stringify(st.map(x => [x.location, x.qty]))); }
  r = await call('POST', '/api/dyeing', { date: d, lotNo: b2, inItem: grey.id, inQty: 48, chemLoc: 'STORE', lines: [], outItem: col.id, outQty: 46, wastageQty: 2 });
  ok(r.s === 201, 'dyeing picks up lot L-0002 directly');
  r = await call('POST', '/api/knitting', { date: d, location: 'KNIT', outLoc: 'FG', lines: [{ item: yarn.id, lot: 'L-0001', qty: 1 }], outItem: grey.id, outQty: 1 });
  ok(r.s === 400, 'grey fabric cannot be sent anywhere else: ' + (r.j && r.j.error));

  // ---- sign-in protection ----
  await call('POST', '/api/users', { username: 'locktest', name: 'Lock Test', role: 'store', password: 'right123', active: true });
  { const t0 = T; let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/api/login', { username: 'locktest', password: 'wrong' + i });
    ok(last.s === 401, 'wrong passwords are refused');
    r = await call('POST', '/api/login', { username: 'locktest', password: 'right123' });
    ok(r.s === 429 && /paused for 15 minutes/.test(r.j.error), 'after 5 wrong passwords even the right one is paused: ' + (r.j && r.j.error));
    r = await call('POST', '/api/login', { username: 'admin', password: 'admin123' });
    ok(r.s === 200, 'other users can still sign in');
    T = t0; }
  { const res = await fetch(B + '/'); ok(res.headers.get('x-frame-options') === 'DENY' && res.headers.get('x-content-type-options') === 'nosniff', 'security headers sent'); }

  // ---- GST rules ----
  r = await call('POST', '/api/parties', { name: 'Bad GSTIN Co', type: 'Customer', state: 'West Bengal', gstin: '21AAACB1234C1Z5' }); ok(r.s === 400 && /state code 19/.test(r.j.error), 'GSTIN with wrong state code rejected: ' + r.j.error);
  r = await call('POST', '/api/parties', { name: 'Bad GSTIN Co', type: 'Customer', state: 'West Bengal', gstin: '19ABC' }); ok(r.s === 400, 'malformed GSTIN rejected');
  r = await call('POST', '/api/parties', { name: 'Typo State Co', type: 'Customer', state: 'WB' }); ok(r.s === 400, 'state not in the list rejected');
  const wb = (await call('POST', '/api/parties', { name: 'WB Buyer', type: 'Customer', state: 'West Bengal', gstin: '19aaacw1234c1z5' })).j; ok(wb.gstin === '19AAACW1234C1Z5', 'GSTIN stored in capitals');
  const op1 = (await call('POST', '/api/stockAdjust', { date: d, location: 'FG', reason: 'Opening Stock', lines: [{ item: fg.id, lot: '', qty: 200, rate: 300 }] })).j.lines[0].lot;
  ok(op1 === 'L-0003', 'opening stock of finished goods gets the next lot number: ' + op1);
  r = await call('POST', '/api/invoices', { date: d, party: wb.id, freight: 1000, discount: 500, lines: [{ item: fg.id, lot: op1, qty: 100, rate: 400, gst: 5 }] });
  ok(r.j.taxable === 40500 && r.j.cgst === 1012.5 && r.j.sgst === 1012.5 && r.j.total === 42525, 'freight taxed and discount taken off before GST: taxable ' + r.j.taxable + ', total ' + r.j.total);
  r = await call('POST', '/api/invoices', { date: d, party: wb.id, placeOfSupply: 'Odisha', lines: [{ item: fg.id, lot: op1, qty: 10, rate: 400, gst: 5 }] });
  ok(r.j.igst === 200 && r.j.cgst === 0, 'place of supply in another state gives IGST');
  r = await call('PUT', '/api/settings', { gstin: '21ABCDE1234F1Z5' }); ok(r.s === 400, 'company GSTIN must match company state');

  // ---- finished goods kept roll by roll: 110 kg red = 20.2 + 50.3 + 39.5 ----
  const rd1 = (await call('POST', '/api/stockAdjust', { date: d, location: 'DYE', reason: 'Opening Stock', lines: [{ item: col.id, qty: 113, rate: 300 }] })).j.lines[0].lot;
  r = await call('POST', '/api/finishing', { date: d, lotNo: rd1, inItem: col.id, inQty: 113, packLoc: 'STORE', lines: [], outItem: fg.id, rollWeights: '20.2kg + 50.3, 39.5', wastageQty: 3 });
  ok(r.s === 201 && r.j.outQty === 110 && r.j.rolls === 3 && r.j.rollWeights === '20.2 + 50.3 + 39.5', 'finishing: roll weights make 110 kg in 3 rolls ' + JSON.stringify([r.j.outQty, r.j.rolls, r.j.rollWeights || r.j.error]));
  r = await call('POST', '/api/finishing', { date: d, lotNo: rd1, inItem: col.id, inQty: 1, packLoc: 'STORE', lines: [], outItem: fg.id, rollWeights: '20 + abc' });
  ok(r.s === 400 && /Roll weights/.test(r.j.error), 'roll weights that are not numbers are refused: ' + r.s + ' ' + (r.j && r.j.error));
  const rollRow = async q => (await call('GET', '/api/report/stock?location=FG' + (q || ''))).j.rows.find(x => x.lot === rd1);
  let st = await rollRow(); ok(st.qty === 110 && st.rolls === 3 && st.weights === '20.2 + 50.3 + 39.5', 'stock: 110 kg, 3 rolls (20.2 + 50.3 + 39.5)');
  r = await call('POST', '/api/deliveries', { date: d, party: cus.id, location: 'FG', lines: [{ item: fg.id, lot: rd1, qty: 23, rate: 400 }] });
  ok(r.s === 201, 'challan for 23 kg ' + ((r.j && r.j.error) || ''));
  st = await rollRow(); ok(st.qty === 87 && st.rolls === 2 && st.weights === '47.5 + 39.5', 'sold 23 kg: 87 kg left in 2 rolls (' + st.weights + ')');
  r = await call('POST', '/api/deliveries', { date: '2026-09-05', party: cus.id, location: 'FG', lines: [{ item: fg.id, lot: rd1, qty: 30, rate: 400, rollPick: [{ no: 3, kg: 39.5 }] }] });
  ok(r.s === 400 && /add up to 39.5 kg but the quantity is 30/.test(r.j.error), 'picked rolls must add up to the line kg: ' + r.j.error);
  r = await call('POST', '/api/deliveries', { date: '2026-09-05', party: cus.id, location: 'FG', lines: [{ item: fg.id, lot: rd1, qty: 39.5, rate: 400, rollPick: [{ no: 3, kg: 39.5 }] }] });
  ok(r.s === 201 && r.j.lines[0].qty === 39.5 && r.j.lines[0].rolls === 1, 'picking roll 3: 39.5 kg, 1 roll');
  st = await rollRow(); ok(st.qty === 47.5 && st.rolls === 1 && st.weights === '47.5', 'after picking roll 3: 47.5 kg in 1 roll');
  st = await rollRow('&asOn=2026-09-02'); ok(st.qty === 87 && st.weights === '47.5 + 39.5', 'stock as on an earlier date shows the rolls of that day');
  r = await call('POST', '/api/deliveries', { date: '2026-09-06', party: cus.id, location: 'FG', lines: [{ item: fg.id, lot: rd1, qty: 5, rate: 400, rollPick: [{ no: 1, kg: 5 }] }] });
  ok(r.s === 400 && new RegExp('Roll 1 of lot ' + rd1).test(r.j.error), 'a roll that was already sold cannot be picked: ' + r.j.error);
  r = await call('POST', '/api/deliveries', { date: '2026-09-06', party: cus.id, location: 'FG', lines: [{ item: fg.id, lot: rd1, qty: 50, rate: 400, rollPick: [{ no: 2, kg: 50 }] }] });
  ok(r.s === 400 && /has only 47.5 kg/.test(r.j.error), 'taking more than is left on a roll is refused: ' + r.j.error);
  r = await call('POST', '/api/stockAdjust', { date: d, location: 'DYE', reason: 'Physical Verification', lines: [{ item: col.id, lot: rd1, qty: 2, rate: 300 }, { item: col.id, lot: 'ZZ9', qty: 1, rate: 300 }, { item: chem.id, qty: 1, rate: 500 }] });
  ok(r.s === 201 && r.j.lines[0].lot === rd1 && r.j.lines[1].lot === 'L-0005' && !r.j.lines[2].lot, 'a + adjustment adds to an existing lot; a made-up lot gets a real number; chemicals none: ' + JSON.stringify(r.j.lines ? r.j.lines.map(l => l.lot) : r.j.error));
  const adj = r.j;
  r = await call('PUT', '/api/stockAdjust/' + adj.id, adj); ok(r.s === 200 && r.j.lines[1].lot === 'L-0005', 'editing keeps the lot numbers it gave: ' + JSON.stringify(r.j.lines ? r.j.lines.map(l => l.lot) : r.j.error));
  r = await call('POST', '/api/stockAdjust', { date: d, location: 'DYE', reason: 'Damage / Write-off', lines: [{ item: col.id, lot: rd1, qty: -2 }, { item: col.id, lot: 'L-0005', qty: -1 }] });
  ok(r.s === 201 && r.j.lines[0].lot === rd1, 'a - adjustment takes from the lot chosen ' + ((r.j && r.j.error) || ''));

  // ---- labour payable (L-0001 earned: knitting 950, dyeing 1425, finishing 528) ----
  r = await call('POST', '/api/labourPayments', { date: d, stage: 'Knitting', amount: 600, paidTo: 'Knitters', mode: 'Cash' });
  ok(r.s === 201 && r.j.no === 'LP-0001', 'labour payment saved ' + (r.j.no || r.j.error));
  r = await call('POST', '/api/labourPayments', { date: d, amount: 100 }); ok(r.s === 400, 'labour payment needs a process: ' + r.j.error);
  r = await call('GET', '/api/report/labourPayable');
  { const s = Object.fromEntries(r.j.tables[0].rows.map(x => [x.stage, x.closing]));
    ok(s['Knitting'] === 350 && s['Color (Dyeing)'] === 1425 && s['Finishing & Packing'] === 528, 'labour payable per process: ' + JSON.stringify(s));
    ok(r.j.cards[r.j.cards.length - 1].value === 2303, 'total labour payable ' + r.j.cards[r.j.cards.length - 1].value); }
  r = await call('GET', '/api/report/labourBalance?stage=Knitting'); ok(r.j.payable === 350, 'still payable shown on the payment form: ' + r.j.payable);
  r = await call('GET', '/api/report/labourPayable?stage=Dyeing&from=2026-09-02');
  ok(r.j.tables[0].rows.length === 1 && r.j.tables[0].rows[0].opening === 1425 && r.j.tables[1].rows[0].doc === 'Opening balance', 'process filter and opening balance');
  await call('PUT', '/api/settings', { labourFrom: '2026-09-02' });
  r = await call('GET', '/api/report/labourPayable'); ok(r.j.cards[r.j.cards.length - 1].value === 0, 'labour before the Settings start date counts as settled');
  await call('PUT', '/api/settings', { labourFrom: '' });
  { const res = await fetch(B + '/api/health'); ok(res.status === 200 && (await res.json()).ok === true, 'health check answers without signing in'); }
  { const a = await fetch(B + '/js/app.js'); await a.text(); const et = a.headers.get('etag');
    const c = await fetch(B + '/js/app.js', { headers: { 'If-None-Match': et } });
    ok(!!et && c.status === 304, 'unchanged files are not downloaded again (304)'); }

  // ---- department logins ----
  r = await call('GET', '/api/roles'); ok(r.j.length === 9 && r.j.some(x => x.id === 'knitting'), 'preset department roles exist: ' + r.j.map(x => x.name).join(', '));
  r = await call('POST', '/api/users', { username: 'knit1', name: 'Knit Sup', role: 'knitting', password: 'secret1', active: true }); ok(r.s === 201, 'create knitting user');
  r = await call('POST', '/api/users', { username: 'bad', role: 'nosuchrole', password: 'secret1' }); ok(r.s === 400, 'unknown role rejected');
  r = await call('POST', '/api/users', { username: ' spacey ', name: 'Spacey', role: 'knitting', password: 'secret1', active: true }); ok(r.s === 201 && r.j.username === 'spacey', 'username spaces trimmed on save');
  { const t0 = T; r = await call('POST', '/api/login', { username: 'Spacey', password: 'secret1' }); ok(r.s === 200, 'trimmed user can log in'); T = t0; }
  r = await call('DELETE', '/api/roles/knitting'); ok(r.s === 400, 'role in use cannot be deleted: ' + r.j.error);
  const admTok = T;
  r = await call('POST', '/api/login', { username: 'knit1', password: 'secret1' }); T = r.j.token;
  ok(r.j.perms.knitting === 'full' && !r.j.perms.invoices && r.j.user.roleName === 'Knitting Department', 'login returns department permissions');
  r = await call('GET', '/api/invoices'); ok(r.s === 200 && r.j.length === 0, 'knitting user sees no invoices');
  r = await call('GET', '/api/invoices/' + inv.id); ok(r.s === 403, 'knitting user cannot open an invoice by id');
  r = await call('POST', '/api/invoices', { date: d, party: cus.id, lines: [{ item: fg.id, lot: 'L-0001', qty: 1, rate: 1 }] }); ok(r.s === 403, 'knitting user cannot create invoice');
  r = await call('GET', '/api/report/sales'); ok(r.s === 403, 'knitting user cannot see sales report');
  r = await call('GET', '/api/report/dashboard'); ok(r.s === 403, 'knitting user cannot see MIS dashboard');
  r = await call('GET', '/api/report/production'); ok(r.s === 200, 'knitting user can see production report');
  r = await call('GET', '/api/report/labourPayable'); ok(r.s === 403, 'knitting user cannot see labour payable');
  r = await call('GET', '/api/labourPayments'); ok(r.s === 200 && r.j.length === 0, 'knitting user sees no labour payments');
  r = await call('POST', '/api/labourPayments', { date: d, stage: 'Knitting', amount: 1 }); ok(r.s === 403, 'knitting user cannot enter labour payments');
  r = await call('GET', '/api/items'); ok(r.s === 200 && r.j.length > 0, 'masters readable for dropdowns');
  r = await call('POST', '/api/items', { name: 'Hack', category: 'Yarn', unit: kg }); ok(r.s === 403, 'knitting user cannot add items');
  r = await call('GET', '/api/transfers'); ok(r.j.length === 1 && r.j[0].purpose === 'Grey Transfer', 'transfers list shows only grey transfers');
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: chem.id, qty: 1 }] }); ok(r.s === 403, 'knitting user cannot issue from store');
  r = await call('GET', '/api/knitting'); ok(r.s === 200 && r.j.length === 2, 'knitting user sees knitting entries (' + r.j.length + ')');
  r = await call('PUT', '/api/roles/knitting', { name: 'x' }); ok(r.s === 403, 'knitting user cannot edit roles');
  T = admTok;
  r = await call('PUT', '/api/roles/knitting', Object.assign({}, (await call('GET', '/api/roles/knitting')).j, { perms: { knitting: 'view' } })); ok(r.s === 200, 'admin edits role');
  T = (await call('POST', '/api/login', { username: 'knit1', password: 'secret1' })).j.token;
  r = await call('POST', '/api/knitting', { date: d, location: 'KNIT', lines: [{ item: yarn.id, lot: 'L-0001', qty: 1 }], outItem: grey.id, outQty: 1 }); ok(r.s === 403, 'role change applies immediately (now view only)');
  T = admTok;
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch(e => console.log('ERR', e)).finally(() => { srv.kill(); if (/Error/.test(log)) console.log('SERVER LOG:\n' + log); });

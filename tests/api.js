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
  ok(r.s === 400 && /Main Store has 50 kg: issue it to Knitting Factory first/i.test(r.j.error), 'knitting before the yarn is issued says to issue it first: ' + r.j.error);
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

  // ---- job-work agencies: knitting, dyeing and finishing done by outside agencies ----
  const knitCo = (await call('POST', '/api/parties', { name: 'Knit Co', type: 'Job Worker', state: 'West Bengal', doesKnitting: true, knitRate: 9 })).j;
  const dyeCo = (await call('POST', '/api/parties', { name: 'Dye Co', type: 'Job Worker', state: 'West Bengal', doesDyeing: true, dyeRate: 14, doesFinishing: true, finRate: 5 })).j;
  const finCo = (await call('POST', '/api/parties', { name: 'Fin Co', type: 'Supplier', state: 'West Bengal', doesFinishing: true })).j;
  let locs = (await call('GET', '/api/locations')).j;
  const at = p => (locs.find(l => l.party === p.id) || {}).id;
  const KA = at(knitCo), DA = at(dyeCo), FA = at(finCo);
  ok(KA && DA && FA && locs.find(l => l.id === KA).name === 'Knit Co', 'each agency gets a stock location named after it (also a supplier that ticks finishing)');
  const L = (await call('POST', '/api/grn', { date: d, party: sup.id, location: 'STORE', lines: [{ item: yarn.id, qty: 220, rate: 210 }] })).j.lines[0].lot;
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: KA, lines: [{ item: yarn.id, lot: L, qty: 220 }] }); ok(r.s === 201, 'yarn lot ' + L + ' issued to the knitting agency');
  r = await call('POST', '/api/knitting', { date: d, location: DA, outLoc: DA, lines: [{ item: yarn.id, lot: L, qty: 10 }], outItem: grey.id, outQty: 9 });
  ok(r.s === 400 && /does not do knitting/.test(r.j.error), 'an agency that does not knit cannot be chosen for knitting: ' + r.j.error);
  r = await call('POST', '/api/knitting', { date: d, location: KA, outLoc: DA, lines: [{ item: yarn.id, lot: L, qty: 200 }], outItem: grey.id, outQty: 190, rolls: 8, wastageQty: 10, labourRate: 9, labour: 1710 });
  ok(r.s === 201 && r.j.lotNo === L, 'knitting at the agency keeps lot ' + L + ' and sends the grey straight to the dyeing agency ' + (r.j.error || ''));
  { const st = (await call('GET', '/api/report/stock')).j.rows.filter(x => x.lot === L && x.category === 'Grey Fabric');
    ok(st.length === 1 && st[0].location === 'Dye Co' && st[0].qty === 190, 'the grey lot is at Dye Co: ' + JSON.stringify(st.map(x => [x.location, x.qty]))); }
  r = await call('POST', '/api/dyeing', { date: d, location: DA, outLoc: DA, lotNo: L, inItem: grey.id, inQty: 100, lines: [], outItem: col.id, outQty: 95, wastageQty: 5, labourRate: 14, labour: 1400, color: 'Navy' });
  ok(r.s === 201, 'dyeing at the agency takes the lot from there; it keeps the dyed fabric to finish ' + (r.j.error || ''));
  r = await call('POST', '/api/dyeing', { date: d, location: DA, outLoc: FA, lotNo: L, inItem: grey.id, inQty: 90, lines: [], outItem: col.id, outQty: 86, wastageQty: 4, labourRate: 14, labour: 1260, color: 'Navy' });
  ok(r.s === 201, 'second batch is sent on to the finishing agency ' + (r.j.error || ''));
  r = await call('POST', '/api/finishing', { date: d, location: FA, lotNo: L, inItem: col.id, inQty: 90, lines: [], outItem: fg.id, outQty: 88, wastageQty: 2, labour: 440 });
  ok(r.s === 400 && /Fin Co is short by 4/.test(r.j.error), 'finishing more than the agency holds is refused: ' + r.j.error);
  r = await call('POST', '/api/finishing', { date: d, location: FA, outLoc: KA, lotNo: L, inItem: col.id, inQty: 86, lines: [], outItem: fg.id, outQty: 84, wastageQty: 2 });
  ok(r.s === 400 && /Finished Goods Store/.test(r.j.error), 'finished goods cannot be sent elsewhere: ' + r.j.error);
  r = await call('POST', '/api/finishing', { date: d, location: FA, lotNo: L, inItem: col.id, inQty: 86, lines: [], outItem: fg.id, outQty: 84, wastageQty: 2, labourRate: 5, labour: 420 });
  ok(r.s === 201, 'finishing at the agency puts the rolls in the Finished Goods Store ' + (r.j.error || ''));
  { const st = (await call('GET', '/api/report/stock?location=FG')).j.rows.filter(x => x.lot === L);
    ok(st.length === 1 && st[0].qty === 84, 'lot ' + L + ' finished: 84 kg in the Finished Goods Store'); }
  // the knitter kept 20 kg of yarn; grey kept at the knitter is sent on with a grey transfer
  r = await call('POST', '/api/knitting', { date: d, location: KA, outLoc: KA, lines: [{ item: yarn.id, lot: L, qty: 20 }], outItem: grey.id, outQty: 19, wastageQty: 1, labour: 171 });
  ok(r.s === 201, 'knitting can keep the grey fabric at the knitting agency');
  r = await call('POST', '/api/dyeing', { date: d, location: DA, outLoc: DA, lotNo: L, inItem: grey.id, inQty: 19, lines: [], outItem: col.id, outQty: 18 });
  ok(r.s === 400 && /It is at Knit Co \(19 kg\): send it to Dye Co with Send Grey for Dyeing/i.test(r.j.error), 'dyeing grey that is still at the knitter says where it is and how to send it: ' + r.j.error);
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Grey Transfer', fromLoc: KA, toLoc: DA, lines: [{ item: grey.id, lot: L, qty: 19 }] }); ok(r.s === 201, 'grey sent from the knitting agency to the dyeing agency');
  // job charges: owed to each agency, paid in Supplier Payments, not in Labour Payable
  r = await call('GET', '/api/report/partyLedger?party=' + dyeCo.id);
  ok(r.j.rows.length === 2 && r.j.rows.every(x => /^Color \(Dyeing\) charges, lot L-\d+, \d+ kg$/.test(x.narration)) && r.j.rows[1].balance === 2660 && r.j.rows[1].drcr === 'Cr', 'dyeing charges are in the agency ledger: ' + JSON.stringify(r.j.rows.map(x => [x.narration, x.cr, x.balance])));
  r = await call('POST', '/api/payments', { date: d, party: dyeCo.id, amount: 2000, mode: 'Bank Transfer' }); ok(r.s === 201, 'the agency is paid in Supplier Payments');
  r = await call('GET', '/api/report/outstanding?type=payable');
  { const b = Object.fromEntries(r.j.rows.map(x => [x.party, x.balance])); ok(b['Dye Co'] === 660 && b['Knit Co'] === 1881 && b['Fin Co'] === 420, 'payables show what each agency is owed: ' + JSON.stringify(b)); }
  r = await call('GET', '/api/report/labourPayable'); ok(r.j.cards[r.j.cards.length - 1].value === 2303, 'agency work stays out of Labour Payable: ' + r.j.cards[r.j.cards.length - 1].value);
  r = await call('GET', '/api/report/agencies');
  { const a = Object.fromEntries(r.j.rows.map(x => [x.agency, x]));
    ok(a['Knit Co'] && a['Knit Co'].entries === 2 && a['Knit Co'].charges === 1881 && a['Knit Co'].payable === 1881 && a['Knit Co'].yarn === 0 && a['Knit Co'].grey === 0, 'agency summary: Knit Co knitted twice, holds nothing, is owed 1881: ' + JSON.stringify(a['Knit Co']));
    ok(a['Dye Co'] && a['Dye Co'].grey === 19 && a['Dye Co'].dyed === 95 && a['Dye Co'].payable === 660 && a['Dye Co'].work === 'Color (Dyeing), Finishing & Packing', 'agency summary: Dye Co holds 19 kg grey and 95 kg dyed, is owed 660: ' + JSON.stringify(a['Dye Co'])); }
  r = await call('GET', '/api/report/production?location=' + KA);
  ok(r.j.rows.length === 2 && r.j.rows[0].agency === 'Knit Co' && r.j.rows[0].sentTo === 'Dye Co', 'production report by agency, with where the output went');
  // renaming and deleting agencies
  r = await call('PUT', '/api/parties/' + knitCo.id, Object.assign({}, knitCo, { name: 'Knit Co Pvt' })); ok(r.s === 200, 'agency renamed');
  locs = (await call('GET', '/api/locations')).j; ok(locs.find(l => l.id === KA).name === 'Knit Co Pvt', 'its location is renamed with it');
  r = await call('DELETE', '/api/parties/' + knitCo.id); ok(r.s === 400 && /used in/.test(r.j.error), 'an agency that was sent material cannot be deleted: ' + r.j.error);
  r = await call('DELETE', '/api/locations/' + KA); ok(r.s === 400 && /agency/.test(r.j.error), 'an agency location cannot be deleted on its own: ' + r.j.error);
  const spare = (await call('POST', '/api/parties', { name: 'Spare Knitter', type: 'Job Worker', state: 'West Bengal' })).j;
  locs = (await call('GET', '/api/locations')).j; const SA = at(spare);
  r = await call('DELETE', '/api/parties/' + spare.id); ok(r.s === 200 && !(await call('GET', '/api/locations')).j.some(l => l.id === SA), 'an unused agency is deleted together with its location ' + ((r.j && r.j.error) || ''));

  // ---- bank & cash, split payments, bill status ----
  const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  const dayOff = n => { const x = new Date(); x.setDate(x.getDate() + n); return iso(x); };
  const TODAY = dayOff(0);
  const adminT = T;
  ok((await call('GET', '/api/banks')).j.some(b => b.id === 'CASH' && b.name === 'Cash in Hand'), 'Cash in Hand account is built in');
  const sbi = (await call('POST', '/api/banks', { name: 'SBI CA', type: 'Bank', openingBalance: 100000, openingDate: '2026-01-01' })).j;
  // cash already paid out by earlier tests (labour paid in cash goes to Cash in Hand by itself)
  const cash0 = ((await call('GET', '/api/report/bankBook')).j.rows.find(x => x.account === 'Cash in Hand') || {}).close;
  const wbg = (await call('POST', '/api/parties', { name: 'WB Garments', type: 'Customer', state: 'West Bengal', gstin: '19AAACW1234A1Z5', creditDays: 30 })).j;
  r = await call('POST', '/api/invoices', { date: TODAY, party: wbg.id, location: 'FG', lines: [{ item: fg.id, lot: L, qty: 40, rate: 2500, gst: 5 }] });
  ok(r.s === 201 && r.j.cgst === 2500 && r.j.sgst === 2500 && r.j.total === 105000, 'invoice ₹1,05,000 to a West Bengal customer (CGST + SGST) ' + (r.j.error || ''));
  const wbInv = r.j;
  r = await call('POST', '/api/receipts', { date: TODAY, party: wbg.id, invoiceId: wbInv.id, mode: 'Bank Transfer', parts: [{ mode: 'Cash', bank: 'CASH', amount: 20000 }, { mode: 'Bank Transfer', bank: sbi.id, amount: 30000, refNo: 'UTR1' }, { mode: 'UPI', amount: 0 }] });
  ok(r.s === 201 && r.j.amount === 50000 && r.j.mode === 'Split' && r.j.parts.length === 2, 'one receipt in two parts, cash ₹20,000 + bank ₹30,000 = ₹50,000 ' + (r.j.error || ''));
  let split = r.j;
  r = await call('GET', '/api/report/billStatus'); { const b = r.j.bills[wbInv.id]; ok(b && b.paid === 50000 && b.due === 55000 && b.status === 'Part paid', 'the invoice is part paid, ₹55,000 still on credit: ' + JSON.stringify(b)); }
  r = await call('GET', '/api/report/outstanding?type=receivable'); ok((r.j.rows.find(x => x.party === 'WB Garments') || {}).balance === 55000, 'customer outstanding ₹55,000');
  r = await call('POST', '/api/bankEntries', { date: TODAY, kind: 'Cash deposit', toBank: sbi.id, amount: 15000 }); ok(r.s === 201 && r.j.fromBank === 'CASH' && /^BNK-/.test(r.j.no), 'cash deposited into the bank ' + (r.j.error || ''));
  r = await call('POST', '/api/bankEntries', { date: TODAY, kind: 'Transfer', fromBank: sbi.id, toBank: sbi.id, amount: 5 }); ok(r.s === 400, 'a transfer to the same account is refused: ' + r.j.error);
  r = await call('GET', '/api/report/bankBook');
  { const a = Object.fromEntries(r.j.rows.map(x => [x.account, x.close])); ok(a['Cash in Hand'] === cash0 + 5000 && a['SBI CA'] === 145000 && 'Not assigned to an account' in a, 'bank & cash balances: cash +₹20,000 −₹15,000 deposited, SBI ₹1,45,000 (older entries with no account listed apart): ' + JSON.stringify(a)); }
  r = await call('GET', '/api/report/bankBook?account=' + sbi.id); ok(r.j.rows.length === 3 && r.j.rows[2].balance === 145000, 'SBI book: opening, receipt, deposit, balance ₹1,45,000');
  r = await call('GET', '/api/report/bankReco?account=' + sbi.id);
  ok(r.j.cards[0].value === 145000 && r.j.cards[1].value === 45000 && r.j.cards[3].value === 100000, 'reconciliation: books ₹1,45,000 − ₹45,000 not yet in the bank = ₹1,00,000 as per bank: ' + JSON.stringify(r.j.cards.map(c => c.value)));
  r = await call('PUT', '/api/receipts/' + split.id, Object.assign({}, split, { clearedOn: TODAY })); split = r.j;
  r = await call('GET', '/api/report/bankReco?account=' + sbi.id); ok(r.j.cards[1].value === 15000 && r.j.rows.length === 1, 'after the receipt clears only the deposit is pending: ' + r.j.cards[1].value);

  // ---- each way of paying keeps its details: cheque no., date and bank; UPI phone; UTR ----
  { const icici = (await call('POST', '/api/banks', { name: 'ICICI CA', type: 'Bank', bankName: 'ICICI Bank', branch: 'Park Street' })).j;
    const cust = (await call('POST', '/api/parties', { name: 'Cheque Payer', type: 'Customer', state: 'West Bengal', bankName: 'Axis Bank, Burrabazar', upi: 'payer@okaxis' })).j;
    const mill = (await call('POST', '/api/parties', { name: 'UPI Mill', type: 'Supplier', state: 'West Bengal' })).j;
    ok(cust.bankName === 'Axis Bank, Burrabazar' && cust.upi === 'payer@okaxis', 'the party master keeps their bank and UPI');
    r = await call('POST', '/api/receipts', { date: TODAY, party: cust.id, amount: 1000, mode: 'Cheque', bank: icici.id, refNo: ' 004512 ', chequeDate: '2026-11-05', payBank: 'Axis Bank, Burrabazar', upi: '98300 12345', transferType: 'NEFT' });
    ok(r.s === 201 && r.j.refNo === '004512' && r.j.chequeDate === '2026-11-05' && r.j.payBank === 'Axis Bank, Burrabazar' && !('upi' in r.j) && !('transferType' in r.j),
      'a cheque receipt keeps the cheque no., date and bank; a UPI phone left from another mode is dropped: ' + JSON.stringify([r.j.refNo, r.j.upi, r.j.transferType]));
    r = await call('POST', '/api/payments', { date: TODAY, party: mill.id, amount: 400, mode: 'UPI', bank: icici.id, upi: 'mill@okaxis', refNo: '412000000001', payBank: 'old', chequeDate: TODAY });
    ok(r.s === 201 && r.j.upi === 'mill@okaxis' && r.j.refNo === '412000000001' && !('payBank' in r.j) && !('chequeDate' in r.j), 'a UPI payment keeps the phone / UPI ID and transaction ID');
    r = await call('POST', '/api/payments', { date: TODAY, party: mill.id, amount: 600, mode: 'Bank Transfer', bank: icici.id, transferType: 'RTGS', refNo: 'ICICR52026110300001', payBank: 'HDFC Bank', accountNo: '5020001, IFSC HDFC0001234' });
    ok(r.s === 201 && r.j.transferType === 'RTGS' && r.j.accountNo === '5020001, IFSC HDFC0001234', 'a bank transfer keeps NEFT / RTGS / IMPS, UTR, their bank and account');
    r = await call('POST', '/api/receipts', { date: TODAY, party: cust.id, mode: 'Cheque', refNo: 'X', parts: [{ mode: 'Cash', bank: 'CASH', amount: 100, person: 'Ramu', chequeDate: TODAY }, { mode: 'Cheque', bank: icici.id, amount: 200, refNo: '778899', chequeDate: '2026-11-10', payBank: 'ICICI' }] });
    ok(r.s === 201 && r.j.mode === 'Split' && !('refNo' in r.j) && r.j.parts[0].person === 'Ramu' && !('chequeDate' in r.j.parts[0]) && r.j.parts[1].refNo === '778899' && r.j.parts[1].payBank === 'ICICI',
      'a receipt in parts: each part keeps its own details (cash: who took it; cheque: no., date, bank)');
    r = await call('POST', '/api/receipts', { date: TODAY, party: cust.id, mode: 'UPI', upi: 'payer@okaxis', parts: [{ mode: 'UPI', bank: icici.id, amount: 300, refNo: 'T9' }] });
    ok(r.s === 201 && r.j.mode === 'UPI' && r.j.upi === 'payer@okaxis' && r.j.refNo === 'T9' && r.j.parts[0].upi === 'payer@okaxis', 'a single part and the receipt carry the same details');
    r = await call('GET', '/api/report/partyLedger?party=' + cust.id);
    ok(!r.j.rows.some(x => /004512/.test(x.narration)) && r.j.rows.some(x => x.narration === 'Receipt (Split: Cash Ramu + Cheque 778899 dt 10-11-2026, ICICI), cheque of ₹ 200 not yet cashed' && x.cr === 100) && /cheques not cashed: no\. 004512 ₹ 1,000/.test(r.j.note),
      'the party ledger counts only the cash part of a split; the uncashed cheques are listed above it: ' + JSON.stringify(r.j.rows.map(x => x.narration)) + ' ' + r.j.note);
    r = await call('GET', '/api/report/bankBook?account=' + icici.id);
    ok(r.j.rows.some(x => x.text === 'Payment: UPI Mill (UPI: mill@okaxis, Txn 412000000001)') && r.j.rows.some(x => x.text === 'Payment: UPI Mill (Bank Transfer: RTGS ICICR52026110300001, HDFC Bank, A/c 5020001, IFSC HDFC0001234)'),
      'the bank book shows the UPI ID, UTR and bank: ' + JSON.stringify(r.j.rows.map(x => x.text)));
    r = await call('GET', '/api/report/customer?party=' + cust.id);
    { const t = r.j.tables.find(x => x.title === 'Payments received'), pr = r.j.tables.find(x => x.title === 'Profile');
      ok(t.rows.some(x => x.detail === '004512 dt 05-11-2026, Axis Bank, Burrabazar' && x.status === 'Not cashed') && pr.rows.some(x => x.k === 'UPI' && x.v === 'payer@okaxis'), 'the customer card lists each payment with its cheque / UPI details, cheque "Not cashed"'); }

    // ---- a cheque counts only once it is cashed ----
    const pb = async id => (await call('GET', '/api/report/partyBalance?party=' + id)).j;
    const icBal = async () => { const b = (await call('GET', '/api/report/bankBook')).j.rows.find(x => x.account === 'ICICI CA'); return b ? b.close : 0; };
    { const b = await pb(cust.id); ok(b.balance === -400 && b.pending === 1200, 'cheques not cashed do not count: the customer has paid ₹400 (cash + UPI), ₹1,200 in cheques waiting: ' + JSON.stringify(b)); }
    const chqMill = (await call('POST', '/api/parties', { name: 'Cheque Mill', type: 'Supplier', state: 'West Bengal' })).j;
    const bill = (await call('POST', '/api/purchaseBills', { date: TODAY, party: chqMill.id, billNo: 'CM/1', lines: [{ item: yarn.id, qty: 10, rate: 100, gst: 5 }] })).j;
    const ic0 = await icBal();
    r = await call('POST', '/api/payments', { date: dayOff(-3), party: chqMill.id, amount: 1050, mode: 'Cheque', bank: icici.id, refNo: '000111', chequeDate: dayOff(-3) }); let chqPay = r.j;
    ok(r.s === 201 && bill.total === 1050, 'a ₹1,050 bill paid by our cheque 000111 ' + (r.j.error || ''));
    r = await call('GET', '/api/report/billStatus'); ok(r.j.bills[bill.id].status === 'Unpaid', 'until the cheque is cashed the bill stays unpaid');
    r = await call('GET', '/api/report/outstanding?type=payable'); ok((r.j.rows.find(x => x.party === 'Cheque Mill') || {}).balance === 1050, 'and we still owe Cheque Mill ₹1,050');
    ok(await icBal() === ic0, 'and the bank balance is unchanged');
    r = await call('GET', '/api/report/cheques'); ok(r.j.rows.some(x => x.kind === 'Given' && x.chq === '000111' && x.amount === 1050 && x.days === 3) && r.j.rows.some(x => x.kind === 'Received' && x.chq === '004512'), 'Cheques Not Yet Cashed lists it (given, 3 days waiting) and the customer\'s cheque');
    r = await call('GET', '/api/report/dashboard'); ok(r.j.alerts.some(a => /cheques? given, not yet cashed/.test(a.text)) && r.j.alerts.some(a => /cheques? received, not yet cashed/.test(a.text)), 'the dashboard warns about cheques not yet cashed');
    r = await call('PUT', '/api/payments/' + chqPay.id, Object.assign({}, chqPay, { clearedOn: dayOff(-4) })); ok(r.s === 400 && /cannot be cashed before/.test(r.j.error), 'a cheque cannot be cashed before it was given: ' + r.j.error);
    r = await call('PUT', '/api/payments/' + chqPay.id, Object.assign({}, chqPay, { clearedOn: TODAY })); chqPay = r.j; ok(r.s === 200, 'cheque 000111 cashed today');
    r = await call('GET', '/api/report/billStatus'); ok(r.j.bills[bill.id].status === 'Paid', 'now the bill is paid');
    r = await call('GET', '/api/report/outstanding?type=payable'); ok(!(r.j.rows.find(x => x.party === 'Cheque Mill') || {}).balance, 'nothing owed to Cheque Mill');
    ok(await icBal() === ic0 - 1050, 'and ₹1,050 has left ICICI');
    r = await call('GET', '/api/report/partyLedger?party=' + chqMill.id); ok(r.j.rows.some(x => x.date === TODAY && x.dr === 1050 && /, cheque cashed /.test(x.narration)), 'the payment shows in the ledger on the day the cheque was cashed: ' + JSON.stringify(r.j.rows.map(x => [x.date, x.narration])));
    const coll0 = (await call('GET', '/api/report/dashboard')).j.now.collectedToday;
    const chqRec = (await call('GET', '/api/receipts')).j.find(x => x.refNo === '004512');
    r = await call('PUT', '/api/receipts/' + chqRec.id, Object.assign({}, chqRec, { date: dayOff(-1), clearedOn: TODAY })); ok(r.s === 200, 'the customer\'s cheque 004512 is cashed today');
    { const b = await pb(cust.id); ok(b.balance === -1400 && b.pending === 200, 'it counts now: ₹1,400 received, ₹200 cheque still waiting: ' + JSON.stringify(b)); }
    ok((await call('GET', '/api/report/dashboard')).j.now.collectedToday === Math.round((coll0 + 1000) * 100) / 100, 'collected today includes the cheque cashed today');
    r = await call('GET', '/api/report/cheques'); ok(!r.j.rows.some(x => x.chq === '000111' || x.chq === '004512') && r.j.rows.some(x => x.chq === '778899'), 'cashed cheques leave the list; the split\'s cheque is still there'); }

  // ---- expenses and electricity bills ----
  r = await call('POST', '/api/overheads', { date: '2026-09-02', category: 'Transport', amount: 700, mode: 'Cash' }); ok(r.s === 201 && r.j.toCost === false && /^EXP-/.test(r.j.no), 'transport is an expense but not production cost (' + r.j.no + ')');
  r = await call('POST', '/api/overheads', { date: '2026-09-02', category: 'Rent', amount: 1000, mode: 'Bank Transfer', bank: sbi.id }); ok(r.s === 201 && r.j.toCost === true, 'rent goes into production cost');
  r = await call('GET', '/api/report/overheads?from=2026-09-01&to=2026-09-30'); ok(r.j.rows[0].total === 1880, 'overheads absorbed in September: maintenance 880 + rent 1000, not transport: ' + r.j.rows[0].total);
  r = await call('GET', '/api/report/expenses?from=2026-09-01&to=2026-09-30'); ok(r.j.cards[0].value === 2580 && r.j.cards[1].value === 1880, 'expense report: ₹2,580 spent, ₹1,880 of it in production cost');
  r = await call('POST', '/api/powerBills', { date: TODAY, provider: 'CESC', billMonth: TODAY.slice(0, 7), amount: 5000, dueDate: dayOff(2), toCost: true }); ok(r.s === 201 && r.j.no === 'EB-0001', 'electricity bill entered ' + (r.j.error || ''));
  let eb = r.j;
  r = await call('GET', '/api/report/dashboard'); ok(r.j.alerts.some(a => /Electricity bill CESC/.test(a.text) && /Due in 2 days/.test(a.text)), 'dashboard alert: electricity bill due in 2 days');
  r = await call('PUT', '/api/powerBills/' + eb.id, Object.assign({}, eb, { paidOn: TODAY, mode: 'Bank Transfer', bank: sbi.id })); eb = r.j;
  r = await call('GET', '/api/report/powerBills'); ok(r.j.rows[0].status === '🟢 Paid', 'bill marked paid');
  r = await call('GET', '/api/report/bankBook?account=' + sbi.id); ok(r.j.rows[r.j.rows.length - 1].balance === 139000, 'paid from SBI: rent 1,000 and the bill 5,000 → ₹1,39,000');

  // ---- staff, attendance, salary and advances ----
  const emp = (await call('POST', '/api/employees', { name: 'Ramu', department: 'Godown', salary: 30000, basis: 'Monthly', joinDate: '2025-01-01', active: true })).j;
  r = await call('POST', '/api/attendance', { date: '2026-09-10', staff: [{ employee: emp.id, mark: 'A' }, { mark: 'P' }] }); ok(r.s === 201 && r.j.staff.length === 1, 'attendance for 10 Sep: absent');
  r = await call('POST', '/api/attendance', { date: '2026-09-10', staff: [{ employee: emp.id, mark: 'P' }] }); ok(r.s === 400, 'a day\'s attendance is entered once: ' + r.j.error);
  await call('POST', '/api/attendance', { date: '2026-09-11', staff: [{ employee: emp.id, mark: 'H' }] });
  r = await call('POST', '/api/salary', { date: '2026-09-15', employee: emp.id, kind: 'Advance', amount: 2000, mode: 'Cash' }); ok(r.s === 201, 'advance ₹2,000 given');
  r = await call('GET', '/api/report/salaryDue?employee=' + emp.id + '&month=2026-09'); ok(r.j.due === 28500 && r.j.paidDays === 28.5 && r.j.advance === 2000, 'September salary due ₹28,500 for 28.5 of 30 days, advance ₹2,000 to recover: ' + JSON.stringify(r.j));
  r = await call('POST', '/api/salary', { date: '2026-10-01', employee: emp.id, kind: 'Salary', amount: 26500, advanceDeducted: 2000, mode: 'Bank Transfer', bank: sbi.id }); ok(r.s === 400, 'salary needs the month it is for');
  r = await call('POST', '/api/salary', { date: '2026-10-01', employee: emp.id, kind: 'Salary', month: '2026-09', amount: 26500, advanceDeducted: 2000, mode: 'Bank Transfer', bank: sbi.id }); ok(r.s === 201, 'salary paid ₹26,500 after recovering the advance');
  r = await call('GET', '/api/report/salaryRegister?month=2026-09'); { const x = r.j.rows.find(y => y.name === 'Ramu'); ok(x && x.due === 28500 && x.paid === 26500 && x.deducted === 2000 && x.balance === 0 && x.advLeft === 0 && x.absent === 1 && x.half === 1, 'salary register: due 28,500 = paid 26,500 + advance 2,000, nothing left: ' + JSON.stringify(x)); }
  r = await call('GET', '/api/report/attendanceReport?month=2026-09'); ok(r.j.rows[0].d10 === 'A' && r.j.rows[0].d11 === 'H' && r.j.rows[0].A === 1, 'attendance sheet marks A on the 10th and H on the 11th');
  // a login that keeps the staff list but may not see salaries
  const sup1 = (await call('POST', '/api/roles', { name: 'Godown Supervisor', perms: { staff: 'edit' } })).j;
  await call('POST', '/api/users', { username: 'gs', name: 'GS', role: sup1.id, password: 'secret1', active: true });
  T = (await call('POST', '/api/login', { username: 'gs', password: 'secret1' })).j.token;
  r = await call('GET', '/api/employees'); ok(r.s === 200 && r.j.length === 1 && r.j[0].salary === undefined, 'staff list without salaries for a login not allowed to see them');
  r = await call('PUT', '/api/employees/' + emp.id, Object.assign({}, r.j[0], { phone: '98300 11111' })); ok(r.s === 200, 'that login can still update the phone number');
  r = await call('GET', '/api/salary'); ok(r.s === 200 && r.j.length === 0, 'and sees no salary payments');
  r = await call('GET', '/api/report/salaryRegister'); ok(r.s === 403, 'and no salary register');
  r = await call('GET', '/api/banks'); ok(r.j.length === 3 && r.j.every(b => b.openingBalance === undefined && !b.accountNo), 'bank accounts: names only, no balances');
  T = adminT;
  r = await call('GET', '/api/employees/' + emp.id); ok(r.j.salary === 30000 && r.j.phone === '98300 11111', 'the salary was kept when they saved');

  // ---- loans and EMIs ----
  const loan = (await call('POST', '/api/loans', { name: 'HDFC Machine Loan', amount: 500000, emi: 12000, tenure: 3, firstEmi: TODAY, bank: sbi.id })).j;
  r = await call('GET', '/api/report/loans'); ok(r.j.rows[0].status === '🔴 Due today', 'EMI due today: ' + r.j.rows[0].status);
  r = await call('GET', '/api/report/dashboard'); ok(r.j.alerts.some(a => /EMI HDFC Machine Loan: Due today/.test(a.text)), 'dashboard alert: EMI due today');
  r = await call('POST', '/api/emiPayments', { date: TODAY, loan: loan.id, amount: 12000, mode: 'Bank Transfer', bank: sbi.id }); ok(r.s === 201 && r.j.forMonth === TODAY.slice(0, 7), 'EMI paid');
  r = await call('GET', '/api/report/loans'); { const x = r.j.rows[0]; ok(x.status === '🟢 Paid this month' && x.count === 1 && x.left === 2 && x.toPay === 24000, 'loan: 1 EMI paid, 2 left (₹24,000), paid this month: ' + JSON.stringify([x.status, x.count, x.left, x.toPay])); }
  await call('POST', '/api/loans', { name: 'Bajaj Finance', emi: 3000, tenure: 12, firstEmi: dayOff(-10) });
  r = await call('GET', '/api/report/loans'); ok(r.j.rows.some(x => x.name === 'Bajaj Finance' && x.status === 'Overdue 10 days'), 'an unpaid EMI ten days old is overdue');

  // ---- leads, follow-ups and quotations ----
  r = await call('POST', '/api/leads', { date: TODAY, name: 'New Prospect', phone: '90000', status: 'Contacted', followUps: [{ date: TODAY, mode: 'Call', notes: 'asked for rates', nextDate: dayOff(-1) }, {}] });
  ok(r.s === 201 && r.j.nextDate === dayOff(-1) && r.j.followUps.length === 1, 'lead: its last follow-up sets the next follow-up date');
  const lead = r.j;
  r = await call('GET', '/api/report/followUps'); ok(r.j.cards[0].value === 1 && /Overdue 1 day/.test(r.j.rows[0].when), 'follow-ups: one overdue');
  r = await call('POST', '/api/quotations', { date: TODAY, lines: [{ item: fg.id, qty: 100, rate: 450, gst: 5 }] }); ok(r.s === 400, 'a quotation needs a customer or a prospect');
  r = await call('POST', '/api/quotations', { date: TODAY, prospect: 'New Prospect', leadId: lead.id, lines: [{ item: fg.id, color: 'Navy', qty: 100, rate: 450, gst: 5 }] }); ok(r.s === 201 && r.j.total === 47250 && /^QT-/.test(r.j.no), 'quotation for a prospect: ₹47,250 with GST');

  // ---- godowns ----
  const g2 = (await call('POST', '/api/locations', { name: 'Godown 2', type: 'Godown' })).j;
  r = await call('POST', '/api/transfers', { date: TODAY, purpose: 'Godown Transfer', fromLoc: 'FG', toLoc: 'STORE', lines: [{ item: fg.id, lot: L, qty: 5 }] }); ok(r.s === 400, 'a godown transfer only goes between godowns: ' + r.j.error);
  r = await call('POST', '/api/transfers', { date: TODAY, purpose: 'Godown Transfer', fromLoc: 'FG', toLoc: g2.id, person: 'Ramu', lines: [{ item: fg.id, lot: L, qty: 20 }] }); ok(r.s === 201, '20 kg moved to Godown 2 ' + (r.j.error || ''));
  r = await call('GET', '/api/report/godownStock'); { const x = r.j.rows.find(y => y.lot === L); ok(x && x.k_FG === 24 && x['k_' + g2.id] === 20 && x.kg === 44, 'godown stock: lot ' + L + ' 24 kg in the FG Store, 20 kg in Godown 2: ' + JSON.stringify(x)); }
  r = await call('POST', '/api/invoices', { date: TODAY, party: wbg.id, location: g2.id, lines: [{ item: fg.id, lot: L, qty: 25, rate: 2500, gst: 5 }] });
  ok(r.s === 400 && /Godown 2 is short by 5/.test(r.j.error) && /Godown Transfer/.test(r.j.error), 'selling more than the godown holds says where the rest is: ' + r.j.error);
  r = await call('POST', '/api/invoices', { date: TODAY, party: wbg.id, location: 'STORE', lines: [{ item: fg.id, lot: L, qty: 5, rate: 2500, gst: 5 }] }); ok(r.s === 400 && /godown/.test(r.j.error), 'goods are not sold from the Main Store');
  r = await call('POST', '/api/deliveries', { date: TODAY, party: wbg.id, location: g2.id, lines: [{ item: fg.id, lot: L, qty: 20, rate: 2500 }] }); ok(r.s === 201, 'challan from Godown 2 ' + (r.j.error || ''));

  // ---- lot number format, job work register and processing status ----
  r = await call('PUT', '/api/settings', { lotPattern: 'ABC' }); ok(r.s === 400, 'a lot format without # is refused');
  await call('PUT', '/api/settings', { lotPattern: 'MH-{YYYY}-###' });
  r = await call('POST', '/api/grn', { date: dayOff(-12), party: sup.id, location: 'STORE', lines: [{ item: yarn.id, qty: 50, rate: 200 }] });
  const L2 = r.j.lines[0].lot; ok(L2 === 'MH-' + dayOff(-12).slice(0, 4) + '-001', 'lot numbers in the new format: ' + L2);
  r = await call('POST', '/api/transfers', { date: dayOff(-10), purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: KA, expectedQty: 48, jobRate: 9, expectedDate: dayOff(-2), lines: [{ item: yarn.id, lot: L2, qty: 50 }] }); ok(r.s === 201, 'yarn issued with an expected date two days ago');
  r = await call('GET', '/api/report/jobWork'); { const x = r.j.rows.find(y => y.lot === L2); ok(x && x.pending === 50 && x.status === 'Overdue 2 days' && r.j.cards[2].value >= 1, 'job work register: 50 kg still at the knitter, overdue 2 days: ' + JSON.stringify(x && [x.pending, x.status])); }
  r = await call('GET', '/api/report/dashboard'); ok(r.j.alerts.some(a => /job work send.*past the expected date/.test(a.text)), 'dashboard alert: job work late');
  // ---- rolls are counted, not weighed: they go out at each lot's average ----
  { const s2 = (await call('GET', '/api/report/stock?location=' + DA)).j.rows.find(x => x.lot === L && x.category === 'Colored Fabric');
    ok(s2 && s2.qty === 95 && s2.rolls === 4, 'dyeing 100 of the 190 kg grey (8 rolls) gives dyed fabric with 4 rolls: ' + JSON.stringify(s2 && [s2.qty, s2.rolls])); }
  const fgAvg = (await call('POST', '/api/items', { name: 'FG Avg', category: 'Finished Goods', unit: kg, gst: 5 })).j;
  r = await call('POST', '/api/grn', { date: TODAY, party: sup.id, location: 'FG', lines: [{ item: fgAvg.id, qty: 1000, rolls: 300, rate: 400 }] }); const LA = r.j.lines[0].lot;
  const avgRow = async loc => (await call('GET', '/api/report/stock?location=' + loc)).j.rows.find(x => x.lot === LA) || {};
  r = await call('POST', '/api/invoices', { date: TODAY, party: wbg.id, location: 'FG', lines: [{ item: fgAvg.id, lot: LA, qty: 100, rate: 450, gst: 5 }] }); ok(r.s === 201, 'sold 100 kg of a lot received as 1000 kg in 300 rolls, rolls not typed');
  { const x = await avgRow('FG'); ok(x.qty === 900 && x.rolls === 270 && x.avg === 3.33, 'the sale took 30 rolls (the lot\'s average): 900 kg, 270 rolls left, 3.33 kg a roll: ' + JSON.stringify([x.qty, x.rolls, x.avg])); }
  r = await call('POST', '/api/transfers', { date: TODAY, purpose: 'Godown Transfer', fromLoc: 'FG', toLoc: g2.id, lines: [{ item: fgAvg.id, lot: LA, qty: 450 }] }); ok(r.s === 201, 'half the lot moved to Godown 2');
  { const a = await avgRow('FG'), b = await avgRow(g2.id); ok(a.rolls === 135 && b.qty === 450 && b.rolls === 135, 'the rolls went with the kg: 135 rolls in each godown: ' + JSON.stringify([a.rolls, b.qty, b.rolls])); }
  r = await call('POST', '/api/invoices', { date: TODAY, party: wbg.id, location: 'FG', lines: [{ item: fgAvg.id, lot: LA, qty: 449.9, rate: 450, gst: 5 }] });
  { const x = await avgRow('FG'); ok(r.s === 201 && x.qty === 0.1 && x.rolls === 0, 'selling all but 0.1 kg takes the remaining 135 rolls: ' + JSON.stringify([x.qty, x.rolls])); }
  r = await call('POST', '/api/invoices', { date: TODAY, party: wbg.id, location: g2.id, lines: [{ item: fgAvg.id, lot: LA, qty: 10, rolls: 5, rate: 450, gst: 5 }] });
  { const x = await avgRow(g2.id); ok(r.s === 201 && x.rolls === 130, 'a roll count typed on the line is kept: 5 rolls out, 130 left'); }
  r = await call('GET', '/api/settings'); ok(r.j.weighRolls === false && r.j.rollKg === 17, 'by default rolls are counted, not weighed (17 kg a roll where a lot has no average)');

  r = await call('GET', '/api/report/processStatus'); ok(r.j.rows.some(x => x.lot === L && x.agency === 'Dye Co' && /Material sent/.test(x.status)), 'processing status: grey lot at the dyeing agency is "material sent"');
  r = await call('POST', '/api/jobStatus', { date: TODAY, location: DA, lot: L, status: 'Colouring', remarks: 'in the machine' }); ok(r.s === 201, 'status update recorded');
  r = await call('GET', '/api/report/processStatus'); ok(r.j.rows.some(x => x.lot === L && x.agency === 'Dye Co' && /Colouring/.test(x.status)), 'processing status now shows colouring');

  // ---- GST returns ----
  r = await call('GET', '/api/report/gstr1?from=' + TODAY + '&to=' + TODAY); { const b = r.j.tables[0].rows.find(x => x.no === wbInv.no) || {}; ok(b.gstin === '19AAACW1234A1Z5' && b.taxable === 100000 && b.cgst === 2500 && b.sgst === 2500, 'GSTR-1 B2B: the WB Garments invoice, taxable ₹1,00,000, CGST + SGST ₹2,500 each'); }
  r = await call('GET', '/api/report/gstr1?from=2026-09-01&to=2026-09-30'); ok(r.j.tables[2].rows.length >= 1 && r.j.tables[2].rows.every(x => x.igst > 0), 'GSTR-1 B2C small: the Odisha sales (unregistered, inter-state) by place of supply');
  { const g = (await call('GET', '/api/report/gst?from=2026-09-01&to=2026-09-30')).j.rows[0], b = (await call('GET', '/api/report/gstr3b?from=2026-09-01&to=2026-09-30')).j.tables[0].rows[0];
    ok(b.igst === g.outIgst && b.taxable === g.outTaxable, 'GSTR-3B outward supplies agree with the GST summary: ' + b.igst); }
  r = await call('GET', '/api/report/salesRegister?from=' + TODAY + '&to=' + TODAY); ok(r.j.rows.some(x => x.party === 'WB Garments' && x.type === 'B2B'), 'sales register marks B2B sales');

  // ---- approvals and activity log ----
  await call('PUT', '/api/settings', { approveChanges: true });
  T = (await call('POST', '/api/login', { username: 'op', password: 'secret1' })).j.token;
  split = (await call('GET', '/api/receipts/' + split.id)).j;
  r = await call('PUT', '/api/receipts/' + split.id, Object.assign({}, split, { remarks: 'changed by op' })); ok(r.s === 202 && r.j.pending, 'a staff change to a saved receipt waits for approval');
  r = await call('GET', '/api/receipts/' + split.id); ok(!r.j.remarks, 'the receipt is unchanged until then');
  r = await call('PUT', '/api/receipts/' + split.id, Object.assign({}, split, { remarks: 'again' })); ok(r.s === 400, 'one request per entry at a time: ' + r.j.error);
  const mine = (await call('GET', '/api/approvals')).j; ok(mine.length === 1 && mine[0].by === 'op' && /remarks/.test(mine[0].summary), 'staff see their own request: ' + (mine[0] && mine[0].summary));
  r = await call('POST', '/api/approvals/' + mine[0].id + '/approve'); ok(r.s === 403, 'staff cannot approve');
  r = await call('POST', '/api/receipts', { date: TODAY, party: wbg.id, amount: 100, mode: 'Cash' }); const own = r.j;
  r = await call('PUT', '/api/receipts/' + own.id, Object.assign({}, own, { amount: 150 })); ok(r.s === 200 && r.j.amount === 150, 'staff can still correct their own entry the same day');
  T = adminT;
  r = await call('POST', '/api/approvals/' + mine[0].id + '/approve'); ok(r.s === 200, 'administrator approves');
  r = await call('GET', '/api/receipts/' + split.id); ok(r.j.remarks === 'changed by op' && r.j.updatedBy === 'op', 'the change is made, under the name of who asked');
  r = await call('GET', '/api/report/activity');
  { const acts = r.j.rows.map(x => x.user + ' ' + x.action); ok(['admin approved', 'op asked to edit', 'op signed in', 'admin created'].every(a => acts.includes(a)), 'activity log records sign-ins, requests, approvals and entries: ' + acts.slice(0, 6).join(', ')); }
  T = (await call('POST', '/api/login', { username: 'op', password: 'secret1' })).j.token;
  r = await call('GET', '/api/report/activity'); ok(r.s === 403, 'only the administrator sees the activity log');
  T = adminT;
  await call('PUT', '/api/settings', { approveChanges: false });
  for (const n of ['cheques', 'stockMovement', 'godownStock', 'jobWork', 'processStatus', 'customer', 'followUps', 'bankBook', 'bankReco', 'expenses', 'loans', 'powerBills', 'salaryRegister', 'attendanceReport', 'salesRegister', 'purchaseRegister', 'gstr1', 'gstr3b', 'partyGst']) {
    const x = await call('GET', '/api/report/' + n + '?party=' + wbg.id + '&account=' + sbi.id); ok(x.s === 200, 'report ' + n + (x.s !== 200 ? ' ' + x.j.error : ''));
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch(e => console.log('ERR', e)).finally(() => { srv.kill(); if (/Error/.test(log)) console.log('SERVER LOG:\n' + log); });

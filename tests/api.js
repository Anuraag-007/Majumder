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
  const grn = r.j;
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: yarn.id, lot: 'B1', qty: 150 }] }); ok(r.s === 400, 'over-issue rejected: ' + r.j.error);
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: yarn.id, lot: 'B1', qty: 100 }] }); ok(r.s === 201, 'yarn issue');
  r = await call('POST', '/api/knitting', { date: d, lotNo: 'L1', location: 'KNIT', lines: [{ item: yarn.id, lot: 'B1', qty: 100 }], outItem: grey.id, outQty: 95, rolls: 4, wastageQty: 5, labour: 950 }); ok(r.s === 201, 'knitting ' + ((r.j && r.j.error) || ''));
  r = await call('POST', '/api/knitting', { date: d, lotNo: 'l1', location: 'KNIT', lines: [{ item: yarn.id, lot: 'B1', qty: 1 }], outItem: grey.id, outQty: 1 }); ok(r.s === 400, 'duplicate lot rejected: ' + r.j.error);
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Grey Transfer', fromLoc: 'KNIT', toLoc: 'DYE', lines: [{ item: grey.id, lot: 'L1', qty: 95, rolls: 4 }] }); ok(r.s === 201, 'grey transfer');
  r = await call('POST', '/api/dyeing', { date: d, lotNo: 'L1', inItem: grey.id, inQty: 95, chemLoc: 'STORE', lines: [{ item: chem.id, qty: 2 }], outItem: col.id, outLot: 'L1', outQty: 90, wastageQty: 5, labour: 1425, color: 'Red' }); ok(r.s === 201, 'dyeing ' + ((r.j && r.j.error) || ''));
  r = await call('POST', '/api/overheads', { date: d, category: 'Maintenance', amount: 880 }); ok(r.s === 201, 'overhead');
  r = await call('POST', '/api/finishing', { date: d, lotNo: 'L1', inItem: col.id, inQty: 90, packLoc: 'STORE', lines: [], outItem: fg.id, outLot: 'L1', outQty: 88, rolls: 4, meters: 350, wastageQty: 2, labour: 528 }); ok(r.s === 201, 'finishing ' + ((r.j && r.j.error) || ''));
  const cost = (await call('GET', '/api/report/costing')).j.rows[0];
  // yarn 20000 + dye 1000 + labour 950+1425+528 + overhead 880 = 24783
  ok(Math.abs(cost.total - 24783) < 0.05, 'lot total cost exact: ' + cost.total + ' perKg ' + cost.perKg + ' wastage ' + cost.wastage);
  r = await call('POST', '/api/invoices', { date: d, party: cus.id, lines: [{ item: fg.id, lot: 'L1', qty: 50, rate: 400, gst: 5 }] });
  ok(r.s === 201 && r.j.igst === 1000 && r.j.cgst === 0 && r.j.total === 21000, 'IGST invoice total ' + r.j.total);
  const inv = r.j;
  r = await call('POST', '/api/invoices', { date: d, party: cus.id, lines: [{ item: fg.id, lot: 'L1', qty: 50, rate: 400, gst: 5 }] }); ok(r.s === 400, 'oversell rejected: ' + r.j.error);
  r = await call('DELETE', '/api/grn/' + grn.id); ok(r.s === 400, 'delete GRN whose yarn was used rejected: ' + r.j.error);
  r = await call('DELETE', '/api/items/' + yarn.id); ok(r.s === 400, 'delete used item rejected: ' + r.j.error);
  r = await call('GET', '/api/report/profitability'); ok(Math.abs(r.j.rows[0].cost - 24783 / 88 * 50) < 0.05, 'profit cost ' + r.j.rows[0].cost + ' profit ' + r.j.rows[0].profit);
  await call('POST', '/api/receipts', { date: d, party: cus.id, amount: 5000 });
  r = await call('GET', '/api/report/outstanding?type=receivable'); ok(r.j.rows[0].balance === 16000 && r.j.rows[0].alert.includes('Over limit'), 'receivable 16000 over limit');
  r = await call('GET', '/api/report/lots'); ok(r.j.rows[0].status === 'Finished' && r.j.rows[0].inStock === 38, 'lot trace status ' + r.j.rows[0].status + ' stock ' + r.j.rows[0].inStock);
  r = await call('GET', '/api/report/stock?location=STORE'); ok(r.j.rows.length === 1 && r.j.rows[0].qty === 8, 'store chem left 8');
  r = await call('PUT', '/api/invoices/' + inv.id, Object.assign({}, inv, { lines: [{ item: fg.id, lot: 'L1', qty: 88, rate: 400, gst: 5 }] })); ok(r.s === 200 && r.j.no === inv.no, 'edit invoice keeps number');
  r = await call('GET', '/api/report/lots'); ok(r.j.rows[0].status === 'Sold out', 'lot sold out after edit');
  r = await call('GET', '/api/report/dashboard'); ok(r.s === 200, 'dashboard');
  for (const n of ['stock', 'stockLedger', 'negativeStock', 'purchase', 'poPending', 'production', 'lots', 'wastage', 'costing', 'itemCosting', 'overheads', 'profitability', 'sales', 'soPending', 'outstanding', 'partyLedger', 'gst', 'stockChoices', 'nextLot', 'partyBalance']) {
    const x = await call('GET', '/api/report/' + n + '?item=' + yarn.id + '&party=' + cus.id); ok(x.s === 200, 'report ' + n + (x.s !== 200 ? ' ' + x.j.error : ''));
  }
  await call('POST', '/api/users', { username: 'op', name: 'Op', role: 'operator', password: 'secret1', active: true });
  const tok = T; r = await call('POST', '/api/login', { username: 'op', password: 'secret1' }); T = r.j.token;
  r = await call('GET', '/api/users'); ok(r.s === 403, 'operator cannot list users');
  const rc = (await call('GET', '/api/receipts')).j[0]; r = await call('DELETE', '/api/receipts/' + rc.id); ok(r.s === 403, 'operator cannot delete a real receipt');
  r = await call('PUT', '/api/settings', { companyName: 'x' }); ok(r.s === 403, 'operator cannot change settings');
  T = tok; r = await call('POST', '/api/demo'); ok(r.s === 400, 'demo refused on non-empty db');
  r = await call('GET', '/api/users'); ok(r.j.every(u => !u.hash && !u.salt), 'password hashes never sent');
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
  await call('POST', '/api/stockAdjust', { date: d, location: 'FG', reason: 'Opening Stock', lines: [{ item: fg.id, lot: 'OP1', qty: 200, rate: 300 }] });
  r = await call('POST', '/api/invoices', { date: d, party: wb.id, freight: 1000, discount: 500, lines: [{ item: fg.id, lot: 'OP1', qty: 100, rate: 400, gst: 5 }] });
  ok(r.j.taxable === 40500 && r.j.cgst === 1012.5 && r.j.sgst === 1012.5 && r.j.total === 42525, 'freight taxed and discount taken off before GST: taxable ' + r.j.taxable + ', total ' + r.j.total);
  r = await call('POST', '/api/invoices', { date: d, party: wb.id, placeOfSupply: 'Odisha', lines: [{ item: fg.id, lot: 'OP1', qty: 10, rate: 400, gst: 5 }] });
  ok(r.j.igst === 200 && r.j.cgst === 0, 'place of supply in another state gives IGST');
  r = await call('PUT', '/api/settings', { gstin: '21ABCDE1234F1Z5' }); ok(r.s === 400, 'company GSTIN must match company state');

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
  r = await call('POST', '/api/invoices', { date: d, party: cus.id, lines: [{ item: fg.id, lot: 'L1', qty: 1, rate: 1 }] }); ok(r.s === 403, 'knitting user cannot create invoice');
  r = await call('GET', '/api/report/sales'); ok(r.s === 403, 'knitting user cannot see sales report');
  r = await call('GET', '/api/report/dashboard'); ok(r.s === 403, 'knitting user cannot see MIS dashboard');
  r = await call('GET', '/api/report/production'); ok(r.s === 200, 'knitting user can see production report');
  r = await call('GET', '/api/items'); ok(r.s === 200 && r.j.length > 0, 'masters readable for dropdowns');
  r = await call('POST', '/api/items', { name: 'Hack', category: 'Yarn', unit: kg }); ok(r.s === 403, 'knitting user cannot add items');
  r = await call('GET', '/api/transfers'); ok(r.j.length === 1 && r.j[0].purpose === 'Grey Transfer', 'transfers list shows only grey transfers');
  r = await call('POST', '/api/transfers', { date: d, purpose: 'Yarn Issue', fromLoc: 'STORE', toLoc: 'KNIT', lines: [{ item: chem.id, qty: 1 }] }); ok(r.s === 403, 'knitting user cannot issue from store');
  r = await call('GET', '/api/knitting'); ok(r.s === 200 && r.j.length === 1, 'knitting user sees knitting entries');
  r = await call('PUT', '/api/roles/knitting', { name: 'x' }); ok(r.s === 403, 'knitting user cannot edit roles');
  T = admTok;
  r = await call('PUT', '/api/roles/knitting', Object.assign({}, (await call('GET', '/api/roles/knitting')).j, { perms: { knitting: 'view' } })); ok(r.s === 200, 'admin edits role');
  T = (await call('POST', '/api/login', { username: 'knit1', password: 'secret1' })).j.token;
  r = await call('POST', '/api/knitting', { date: d, lotNo: 'L9', location: 'KNIT', lines: [{ item: yarn.id, lot: 'B1', qty: 1 }], outItem: grey.id, outQty: 1 }); ok(r.s === 403, 'role change applies immediately (now view only)');
  T = admTok;
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch(e => console.log('ERR', e)).finally(() => { srv.kill(); if (/Error/.test(log)) console.log('SERVER LOG:\n' + log); });

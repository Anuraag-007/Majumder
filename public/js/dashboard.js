/* MIS dashboard: period filter, hero sales trend, stat tiles, production and money charts. */
'use strict';

const Dash = (() => {
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function presets() {
    const t = new Date(), y = t.getFullYear(), m = t.getMonth();
    const first = back => iso(new Date(y, m - back, 1));
    const fy = m >= 3 ? y : y - 1;
    return [
      { key: 'month', label: 'This month', from: first(0), to: iso(t) },
      { key: 'last', label: 'Last month', from: first(1), to: iso(new Date(y, m, 0)) },
      { key: '3m', label: '3 months', from: first(2), to: iso(t) },
      { key: '6m', label: '6 months', from: first(5), to: iso(t) },
      { key: 'fy', label: 'This FY', from: fy + '-04-01', to: iso(t) },
      { key: '12m', label: '12 months', from: first(11), to: iso(t) },
    ];
  }

  // Labels arrive as YYYY-MM (monthly) or YYYY-MM-DD (daily).
  const xFmt = (l, long) => {
    const p = l.split('-');
    if (p.length === 2) return MON[+p[1] - 1] + (long ? ' ' + p[0] : '');
    return (+p[2]) + ' ' + MON[+p[1] - 1] + (long ? ' ' + p[0] : '');
  };
  const dText = s => { const p = s.split('-'); return (+p[2]) + ' ' + MON[+p[1] - 1] + ' ' + p[0]; };
  const rangeText = (a, b) => dText(a) + ' – ' + dText(b);

  const short = v => {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e7) return s + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L';
    if (a >= 1e3) return s + (a / 1e3).toFixed(0) + 'K';
    return s + Math.round(a);
  };
  const rupee0 = v => '₹ ' + Math.round(+v || 0).toLocaleString('en-IN');
  const kg = v => U.qty(Math.round(+v || 0)) + ' kg';

  // Change vs previous period. goodUp: true (up is good), false (up is bad), null (neutral).
  function delta(cur, prev, goodUp, unit, prevActive) {
    if (unit === 'pts') {
      const dlt = +(cur - prev).toFixed(2);
      if (!prevActive) return h('span', { class: 'delta flat' }, cur ? 'new this period' : 'no activity');
      const cls = dlt === 0 || goodUp === null ? 'flat' : (dlt > 0) === goodUp ? 'good' : 'bad';
      return h('span', { class: 'delta ' + cls }, (dlt > 0 ? '▲ ' : dlt < 0 ? '▼ ' : '') + Math.abs(dlt).toFixed(2) + ' pts', h('small', null, ' vs prev'));
    }
    if (!prev) return h('span', { class: 'delta flat' }, cur ? 'new this period' : 'no activity');
    const pct = (cur - prev) / Math.abs(prev) * 100;
    const cls = Math.abs(pct) < 0.05 || goodUp === null ? 'flat' : (pct > 0) === goodUp ? 'good' : 'bad';
    return h('span', { class: 'delta ' + cls }, (pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '') + Math.abs(pct).toFixed(1) + '%', h('small', null, ' vs prev'));
  }

  // Sparkline drawn at the tile's real width once it is on screen (no stretching).
  function sparkBox(values) {
    const box = h('div', { class: 'stat-spark' });
    if (!values || values.length < 2) return box;
    const draw = () => { if (box.isConnected && box.clientWidth) box.replaceChildren(Charts.spark(values, null, box.clientWidth)); };
    requestAnimationFrame(draw);
    const ro = new ResizeObserver(U.debounce(() => { if (box.isConnected) draw(); else ro.disconnect(); }, 80));
    ro.observe(box);
    return box;
  }

  function stat(label, value, deltaEl, sub, sparkValues, href) {
    return h(href ? 'a' : 'div', { class: 'kpi stat', href },
      h('span', { class: 'kpi-label' }, label),
      h('span', { class: 'stat-value' }, value),
      sparkBox(sparkValues),
      h('div', { class: 'stat-foot' }, deltaEl, sub ? h('span', { class: 'kpi-sub' }, sub) : null));
  }

  function card(title, sub, body, cls, href) {
    return h('section', { class: 'card dcard ' + (cls || '') },
      h('div', { class: 'dcard-head' }, h('div', null, h('h3', null, title), sub ? h('p', { class: 'dsub' }, sub) : null), href ? h('a', { class: 'link-btn', href }, 'Open report →') : null),
      body);
  }

  function build(d) {
    const k = d.kpi, p = d.prev, t = d.trend;
    const periodTxt = rangeText(d.from, d.to);
    const prevTxt = 'Compared with ' + rangeText(d.prevFrom, d.prevTo);
    const S1 = 'var(--series-1)', S2 = 'var(--series-2)';
    // Sales happen on a few days only, so daily ranges show running totals (a smooth "so far" line).
    const cum = a => { let r = 0; return a.map(v => (r += v)); };
    const flowSeries = a => t.byDay ? cum(a) : a;
    const soFar = t.byDay ? ' (running total)' : '';

    const hero = card('Sales', periodTxt + ' · excluding GST', [
      h('div', { class: 'hero-row' },
        h('div', null,
          h('div', { class: 'hero-fig' }, rupee0(k.sales)),
          h('div', { class: 'hero-delta', title: prevTxt }, delta(k.sales, p.sales, true))),
        h('div', { class: 'hero-mini' },
          h('div', null, h('span', null, 'Gross profit'), h('b', null, rupee0(k.profit)), h('small', null, k.margin.toFixed(1) + '% margin')),
          h('div', null, h('span', null, 'Invoices'), h('b', null, String(k.invoices)), h('small', null, 'raised')),
          h('div', null, h('span', null, 'Collected'), h('b', null, rupee0(k.collections)), h('small', null, 'from customers')))),
      Charts.area({
        title: 'Sales and gross profit trend', xTitle: t.byDay ? 'Day' : 'Month', labels: t.labels, xFmt,
        series: [{ name: 'Sales' + soFar, values: flowSeries(t.sales), color: S1, area: true }, { name: 'Gross profit' + soFar, values: flowSeries(t.profit), color: S2 }],
        fmt: rupee0, axisFmt: short, fmtShort: v => '₹' + short(v), height: 260,
      }),
    ], 'hero-card', '#/report/sales?from=' + d.from + '&to=' + d.to);

    const ageParts = [
      { label: '0–30 days', value: d.age.b30, color: 'var(--ord-1)' },
      { label: '31–60 days', value: d.age.b60, color: 'var(--ord-2)' },
      { label: '61–90 days', value: d.age.b90, color: 'var(--ord-3)' },
      { label: 'Over 90 days', value: d.age.b90p, color: 'var(--ord-4)' },
    ];
    const cash = card('Money position', 'As on ' + dText(d.to), [
      h('div', { class: 'money-block' },
        h('span', { class: 'kpi-label' }, 'Receivables'),
        h('div', { class: 'money-fig' }, rupee0(k.receivable)),
        h('div', { title: prevTxt }, delta(k.receivable, p.receivable, false)),
        h('p', { class: 'dsub', style: { margin: '14px 0 8px' } }, 'How old the dues are'),
        Charts.stack({ title: 'Receivables by age', parts: ageParts, fmt: rupee0 })),
      h('div', { class: 'money-split' },
        h('a', { class: 'money-mini', href: '#/report/outstanding?type=payable' }, h('span', null, 'Payables'), h('b', null, rupee0(k.payable)), delta(k.payable, p.payable, false)),
        h('a', { class: 'money-mini', href: '#/report/soPending' }, h('span', null, 'Open sales orders'), h('b', null, String(k.pendingSO)), h('small', { class: 'muted' }, 'awaiting dispatch'))),
    ], 'cash-card', '#/report/outstanding?type=receivable');

    const lotsCost = d.lots.map(l => l.perKg);
    const tiles = h('div', { class: 'kpis stats6' },
      stat('Purchases', rupee0(k.purchases), delta(k.purchases, p.purchases, null), 'bills, ex-GST', flowSeries(t.purchases), '#/report/purchase?from=' + d.from + '&to=' + d.to),
      stat('Gross profit', rupee0(k.profit), delta(k.profit, p.profit, true), k.margin.toFixed(1) + '% margin', flowSeries(t.profit), '#/report/profitability?from=' + d.from + '&to=' + d.to),
      stat('Collections', rupee0(k.collections), delta(k.collections, p.collections, true), 'received', flowSeries(t.collections), '#/list/receipts'),
      stat('Finished', kg(k.fgKg), delta(k.fgKg, p.fgKg, true), 'knitted ' + kg(k.knitKg), flowSeries(t.fgKg), '#/report/production?from=' + d.from + '&to=' + d.to),
      stat('Cost per kg', k.avgCostKg ? '₹ ' + U.money(k.avgCostKg) : '—', delta(k.avgCostKg, p.avgCostKg, false), 'finished lots', lotsCost, '#/report/costing?from=' + d.from + '&to=' + d.to),
      stat('Wastage', k.wastPct.toFixed(2) + '%', delta(k.wastPct, p.wastPct, false, 'pts', p.knitKg > 0), 'of yarn knitted', null, '#/report/wastage?from=' + d.from + '&to=' + d.to));

    const stageIcons = ['yarn', 'yarn', 'roll', 'truck', 'drop', 'box'];
    const pipe = card('Material in process', 'Right now · kg and value at each stage', h('div', { class: 'pipeline' }, d.pipeline.map((pp, i) => [
      i ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, icon('chevron', 18)) : null,
      h('a', { class: 'stage s' + i, href: '#/report/stock?location=' + pp.loc },
        h('span', { class: 'stage-ic' }, icon(stageIcons[i], 20)),
        h('span', { class: 'stage-label' }, pp.label),
        h('span', { class: 'stage-qty' }, U.qty(pp.qty) + ' kg'),
        h('span', { class: 'stage-val' }, U.compact(pp.value))),
    ])));

    const y0 = d.flow[0].kg || 0;
    const flow = card('Production flow', 'Kg through each stage in the period', Charts.hbars({
      rows: d.flow.map((f, i) => ({ label: f.stage, value: f.kg, note: i && y0 ? (f.kg / y0 * 100).toFixed(1) + '% of yarn' : i ? '' : 'input' })),
      fmt: kg, empty: 'No production in this period.',
    }), '', '#/report/production?from=' + d.from + '&to=' + d.to);

    const sp = card('Sales vs purchases', (t.byDay ? 'Daily' : 'Monthly') + ' · ex-GST', Charts.columns({
      title: 'Sales and purchases by period', xTitle: t.byDay ? 'Day' : 'Month', labels: t.labels, xFmt,
      series: [{ name: 'Sales', values: t.sales, color: S1 }, { name: 'Purchases', values: t.purchases, color: S2 }],
      fmt: rupee0, axisFmt: short, height: 240,
    }));

    const cust = card('Top customers', 'Sales in the period', Charts.hbars({ rows: d.customers.map(c => ({ label: c.name, value: c.value })), fmt: v => '₹ ' + short(v), empty: 'No sales in this period.' }), '', '#/report/profitability?groupBy=party&from=' + d.from + '&to=' + d.to);

    const avg = d.lots.length ? d.lots.reduce((s, l) => s + l.perKg * l.kg, 0) / d.lots.reduce((s, l) => s + l.kg, 0) : 0;
    const cost = card('Cost per kg by lot', d.lots.length ? 'Latest ' + d.lots.length + ' lots · line = average ₹ ' + U.money(avg) + ' / kg' : 'Lots finished in the period', d.lots.length ? Charts.columns({
      title: 'Cost per kg of each finished lot', xTitle: 'Lot', labels: d.lots.map(l => l.lot), xFmt: l => l.replace(/^L-0*/, 'L'),
      series: [{ name: 'Cost / kg', values: d.lots.map(l => l.perKg), color: S1 }],
      fmt: v => '₹ ' + U.money(v), axisFmt: v => '₹' + Math.round(v), height: 220,
      refLine: { value: avg },
    }) : h('p', { class: 'muted cempty' }, 'No lots finished in this period.'), '', '#/report/costing?from=' + d.from + '&to=' + d.to);

    const stock = card('Stock value', 'By location, right now', Charts.hbars({ rows: d.stock.map(s => ({ label: s.name, value: s.value })), fmt: v => '₹ ' + short(v), empty: 'No stock.' }), '', '#/report/stock');

    const waste = card('Wastage by stage', 'Share of input lost in the period', Charts.hbars({
      rows: d.stageW.map(w => ({ label: w.stage, value: w.pct, note: kg(w.qty) + ' · ₹ ' + short(w.value) })),
      fmt: v => v.toFixed(2) + '%', empty: 'No production in this period.',
    }), '', '#/report/wastage?from=' + d.from + '&to=' + d.to);

    const items = card('Best-selling items', 'Sales value in the period', Charts.hbars({ rows: d.topItems.map(i => ({ label: i.name, value: i.value, note: kg(i.kg) })), fmt: v => '₹ ' + short(v), empty: 'No sales in this period.' }), '', '#/report/sales?from=' + d.from + '&to=' + d.to);

    const alerts = card('Re-order alerts', 'Items below their re-order level', d.low.length
      ? h('ul', { class: 'plain' }, d.low.map(l => h('li', null, h('span', { class: 'badge warn' }, 'Low'), ' ', l.item, h('span', { class: 'muted' }, ' — ' + U.qty(l.qty) + ' ' + l.unit + ' (re-order at ' + U.qty(l.reorder) + ')'))))
      : h('p', { class: 'muted' }, 'All items are above their re-order level.'));

    const recent = card('Recent activity', 'Latest entries by all departments', d.recent.length
      ? h('ul', { class: 'plain recent' }, d.recent.map(r => h('li', null, h('a', { href: '#/edit/' + r.col + '/' + r.id }, r.label + ' ' + (r.no || '')), h('span', { class: 'muted' }, ' · ' + U.fmtDate(r.date) + (r.party ? ' · ' + r.party : '') + (r.lot && !r.party ? ' · lot ' + r.lot : '') + (r.amount ? ' · ₹ ' + U.money(r.amount) : '')))))
      : h('p', { class: 'muted' }, 'Nothing entered yet.'));

    return [
      k.exceptions ? h('a', { class: 'banner warn', href: '#/report/negativeStock' }, icon('alert', 18), k.exceptions + ' stock exception(s): some entries consume more than is in stock. Review them.') : null,
      h('div', { class: 'dgrid' }, hero, cash),
      tiles,
      pipe,
      h('div', { class: 'dgrid g2' }, sp, flow),
      h('div', { class: 'dgrid g3' }, cust, cost, stock),
      h('div', { class: 'dgrid g3' }, waste, items, alerts),
      recent,
    ].filter(Boolean);
  }

  async function render(main, query) {
    if (!Perm.can('dashboard', 'view')) return renderDept(main, query);
    const ps = presets();
    let q = { from: query.from, to: query.to };
    if (!q.from || !q.to) { const def = ps.find(x => x.key === '6m'); q = { from: def.from, to: def.to, preset: def.key }; }
    else if (query.preset) q.preset = query.preset;
    const body = h('div', { class: 'dash-body' });
    const sub = h('p', { class: 'note' });

    const chips = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' });
    const fromIn = h('input', { type: 'date', 'aria-label': 'From date' });
    const toIn = h('input', { type: 'date', 'aria-label': 'To date' });
    const paint = () => {
      const hit = (ps.find(x => x.key === q.preset && x.from === q.from && x.to === q.to) || ps.find(x => x.from === q.from && x.to === q.to) || {}).key;
      chips.replaceChildren(...ps.map(x => h('button', { type: 'button', class: 'seg-btn' + (x.key === hit ? ' on' : ''), 'aria-pressed': String(x.key === hit), onclick: () => load({ from: x.from, to: x.to, preset: x.key }) }, x.label)));
      fromIn.value = q.from; toIn.value = q.to;
    };
    const load = async nq => {
      q = nq;
      paint();
      history.replaceState(null, '', '#/dashboard' + U.qs(q));
      body.classList.add('refetch');
      try {
        const d = await API.report('dashboard', { from: q.from, to: q.to });
        if (!d.trend || !d.from) throw new Error('The ERP server is still running an older version. Close the server window, start it again with start.bat, then press Ctrl + F5.');
        sub.textContent = rangeText(d.from, d.to) + ' · compared with the previous ' + d.days + ' days';
        body.replaceChildren(...build(d));
      } catch (e) { body.replaceChildren(h('div', { class: 'banner err' }, e.message)); }
      body.classList.remove('refetch');
    };
    fromIn.onchange = () => { if (fromIn.value && fromIn.value <= q.to) load({ from: fromIn.value, to: q.to }); };
    toIn.onchange = () => { if (toIn.value && toIn.value >= q.from) load({ from: q.from, to: toIn.value }); };

    const quick = [['GRN', 'grn'], ['Knitting', 'knitting'], ['Dyeing', 'dyeing'], ['Finishing', 'finishing'], ['Invoice', 'invoices'], ['Receipt', 'receipts']].filter(([, key]) => Perm.can(SCHEMAS[key].area, 'edit'));
    main.append(
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Business overview'), sub),
        h('div', { class: 'actions' }, quick.map(([l, key]) => h('a', { class: 'chip', href: '#/edit/' + key + '/new' }, icon('plus', 14), l)), FullScreen.button('', true))),
      h('div', { class: 'dfilters' }, chips, h('div', { class: 'drange' }, fromIn, h('span', { class: 'muted' }, 'to'), toIn)),
      body);
    await load(q);
  }

  /* ================= Department analytics (logins without the MIS dashboard) ================= */
  const UNIT_FMT = {
    kg: v => kg(v), int: v => U.int(v), pct: v => (+v || 0).toFixed(2) + '%', money: v => rupee0(v), qty: v => U.qty(v),
  };
  const BAR_FMT = { kg: v => kg(v), int: v => U.int(v), pct: v => (+v || 0).toFixed(2) + '%', money: v => '₹ ' + short(v), qty: v => U.qty(v) };

  function deptSection(s, d) {
    const cum = a => { let r = 0; return a.map(v => (r += v)); };
    const flow = a => d.byDay ? cum(a) : a;
    const tiles = h('div', { class: 'kpis dept-kpis' }, s.kpis.map(k => stat(
      k.label, UNIT_FMT[k.unit](k.value),
      k.prev === null ? h('span', { class: 'delta flat' }, 'right now') : delta(k.value, k.prev, k.good, k.unit === 'pct' ? 'pts' : undefined, k.prevActive),
      null, k.spark ? flow(k.spark) : null)));
    const cards = [];
    if (s.trend && s.trend.series.length) {
      const money = s.trend.unit === 'money';
      const suffix = d.byDay ? ' (running total)' : '';
      cards.push(card(s.trend.title, s.trend.sub + (d.byDay ? ' · running total' : ''), Charts.area({
        title: s.trend.title, xTitle: d.byDay ? 'Day' : 'Month', labels: d.labels, xFmt,
        series: s.trend.series.map((x, i) => ({ name: x.name + suffix, values: flow(x.values), color: i ? 'var(--series-2)' : 'var(--series-1)', area: i === 0 })),
        fmt: money ? rupee0 : v => U.qty(Math.round(v)) + ' kg', axisFmt: short, fmtShort: money ? v => '₹' + short(v) : v => short(v) + ' kg', height: 240,
      }), 'dept-trend'));
    }
    for (const b of s.bars) cards.push(card(b.title, b.sub, Charts.hbars({ rows: b.rows, fmt: BAR_FMT[b.unit], empty: 'Nothing to show.' })));
    const table = s.table ? card(s.table.title, null, s.table.rows.length ? reportTable(s.table) : h('p', { class: 'muted cempty' }, 'Nothing here right now.'), '', s.table.link) : null;
    const first = cards.slice(0, 2), rest = cards.slice(2);
    // A lone leftover chart sits beside the table; otherwise the table gets its own full-width row.
    const pairTable = table && rest.length === 1;
    const row2 = pairTable ? rest.concat([table]) : rest;
    return h('section', { class: 'dept-section' },
      h('div', { class: 'dept-head' }, h('h2', null, icon(s.icon, 20), s.title), h('a', { class: 'link-btn', href: s.link }, 'Open ' + s.title.toLowerCase() + ' →')),
      tiles,
      first.length ? h('div', { class: first.length === 2 ? 'dgrid' : 'dgrid g1' }, first) : null,
      row2.length ? h('div', { class: 'dgrid ' + (row2.length >= 3 ? 'g3' : row2.length === 2 ? 'g2' : 'g1') }, row2) : null,
      table && !pairTable ? h('div', { class: 'dgrid g1' }, table) : null);
  }

  async function renderDept(main, query) {
    const ps = presets();
    let q = { from: query.from, to: query.to, preset: query.preset };
    if (!q.from || !q.to) { const def = ps.find(x => x.key === 'month'); q = { from: def.from, to: def.to, preset: def.key }; }
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const sub = h('p', { class: 'note' });
    const body = h('div', { class: 'dash-body' });
    const chips = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' });
    const fromIn = h('input', { type: 'date', 'aria-label': 'From date' });
    const toIn = h('input', { type: 'date', 'aria-label': 'To date' });
    const paint = () => {
      const hit = (ps.find(x => x.key === q.preset && x.from === q.from && x.to === q.to) || ps.find(x => x.from === q.from && x.to === q.to) || {}).key;
      chips.replaceChildren(...ps.map(x => h('button', { type: 'button', class: 'seg-btn' + (x.key === hit ? ' on' : ''), 'aria-pressed': String(x.key === hit), onclick: () => load({ from: x.from, to: x.to, preset: x.key }) }, x.label)));
      fromIn.value = q.from; toIn.value = q.to;
    };
    const links = h('div', null, h('h2', { class: 'dept-links-title' }, 'Your screens'), homeLinks());
    const load = async nq => {
      q = nq; paint();
      history.replaceState(null, '', '#/dashboard' + U.qs(q));
      body.classList.add('refetch');
      try {
        const d = await API.report('deptDashboard', { from: q.from, to: q.to });
        if (!d.sections) throw new Error('The ERP server is still running an older version. Close the server window, start it again with start.bat, then press Ctrl + F5.');
        sub.textContent = (API.user.roleName || '') + (API.user.department ? ' · ' + API.user.department : '') + ' · ' + rangeText(d.from, d.to);
        body.replaceChildren(...d.sections.map(s => deptSection(s, d)), links);
      } catch (e) { body.replaceChildren(h('div', { class: 'banner err' }, e.message), links); }
      body.classList.remove('refetch');
    };
    fromIn.onchange = () => { if (fromIn.value && fromIn.value <= q.to) load({ from: fromIn.value, to: q.to }); };
    toIn.onchange = () => { if (toIn.value && toIn.value >= q.from) load({ from: q.from, to: toIn.value }); };
    main.append(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, greet + ', ' + (API.user.name || API.user.username)), sub), h('div', { class: 'actions' }, FullScreen.button('', true))),
      h('div', { class: 'dfilters' }, chips, h('div', { class: 'drange' }, fromIn, h('span', { class: 'muted' }, 'to'), toIn)),
      body);
    await load(q);
  }

  return { render };
})();

const renderDashboard = (main, query) => Dash.render(main, query || {});

/*
 * Small SVG / HTML chart kit for the dashboard.
 *   Charts.area    - trend lines with a soft wash, crosshair + tooltip for every series
 *   Charts.columns - grouped columns (one tooltip per period), optional reference line
 *   Charts.hbars   - labelled horizontal bars (values printed at the tip)
 *   Charts.stack   - one 100% stacked bar with a value legend (for ordered buckets)
 *   Charts.spark   - tiny trend line for stat tiles
 * Colours come from CSS variables so both themes work without redrawing.
 */
'use strict';

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;

  function sv(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined) continue;
      if (k === 'fill' || k === 'stroke' || k === 'opacity' || k === 'stop-color') e.style.setProperty(k, v);
      else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function yScale(values) {
    const hi = Math.max(0, ...values), lo = Math.min(0, ...values);
    const step = niceStep((hi - lo) / 4 || 1);
    const top = Math.ceil(hi / step) * step || step;
    const bottom = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = bottom; v <= top + step / 1e6; v += step) ticks.push(+v.toFixed(6));
    return { top, bottom, ticks };
  }
  const every = (n, max) => Math.max(1, Math.ceil(n / max));

  // Tooltip: values lead, series names follow, each keyed with a short stroke of its colour.
  function tooltip(wrap) {
    const el = h('div', { class: 'ctip', role: 'status' });
    wrap.appendChild(el);
    return {
      show(xPx, title, rows) {
        el.replaceChildren(h('div', { class: 'ctip-title' }, title), ...rows.map(r =>
          h('div', { class: 'ctip-row' }, h('i', { class: 'ctip-key', style: { background: r.color } }), h('b', null, r.value), h('span', null, r.label))));
        el.style.display = 'block';
        const w = wrap.clientWidth, tw = el.offsetWidth;
        el.style.left = Math.min(Math.max(xPx - tw / 2, 4), w - tw - 4) + 'px';
      },
      hide() { el.style.display = 'none'; },
    };
  }

  // Shared frame: optional legend, "Show table" toggle, plot area that redraws on resize.
  function frame(opts, draw) {
    const wrap = h('div', { class: 'cframe' });
    const plot = h('div', { class: 'cplot', tabindex: 0, role: 'img', 'aria-label': opts.title || 'Chart' });
    const legend = opts.series && opts.series.length > 1
      ? h('div', { class: 'clegend' }, opts.series.map(s => h('span', null, h('i', { class: opts.kind === 'line' ? 'lkey line' : 'lkey', style: { background: s.color } }), s.name)))
      : h('span');
    const table = h('div', { class: 'table-wrap ctable', hidden: true }, h('table', { class: 'data compact' },
      h('thead', null, h('tr', null, h('th', null, opts.xTitle || ''), opts.series.map(s => h('th', { class: 'num' }, s.name)))),
      h('tbody', null, opts.labels.map((l, i) => h('tr', null, h('td', null, opts.xFmt ? opts.xFmt(l, true) : l), opts.series.map(s => h('td', { class: 'num' }, opts.fmt(s.values[i]))))))));
    const toggle = h('button', { class: 'link-btn', type: 'button', onclick: () => { table.hidden = !table.hidden; plot.hidden = !table.hidden; toggle.textContent = table.hidden ? 'Show table' : 'Show chart'; } }, 'Show table');
    wrap.append(h('div', { class: 'ctop' }, legend, toggle), plot, table);
    const redraw = () => { if (!plot.hidden) draw(plot, wrap, Math.max(260, plot.clientWidth || 600)); };
    requestAnimationFrame(redraw);
    const ro = new ResizeObserver(U.debounce(() => { if (wrap.isConnected) redraw(); else ro.disconnect(); }, 80));
    ro.observe(wrap);
    return wrap;
  }

  function axes(svg, sc, y, L, W, R, fmtTick) {
    for (const v of sc.ticks) {
      sv('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'c-axis' : 'c-grid' }, svg);
      sv('text', { x: L - 10, y: y(v) + 4, 'text-anchor': 'end', class: 'c-tick' }, svg, fmtTick(v));
    }
  }

  /* ---------------- area / line ---------------- */
  function area(opts) {
    opts.kind = 'line';
    return frame(opts, (plot, wrap, W) => {
      const H = opts.height || 250, n = opts.labels.length;
      const all = opts.series.flatMap(s => s.values);
      const sc = yScale(all);
      const tickTxt = opts.axisFmt || opts.fmt;
      const L = 14 + Math.max(...sc.ticks.map(v => tickTxt(v).length)) * 6.6, R = 18, T = 14, B = 28;
      const x = i => n === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (n - 1);
      const y = v => T + (H - T - B) * (sc.top - v) / (sc.top - sc.bottom || 1);
      const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'csvg' });
      axes(svg, sc, y, L, W, R, tickTxt);
      const k = every(n, Math.max(3, Math.floor(W / 90)));
      opts.labels.forEach((l, i) => { if (i % k === 0 || i === n - 1) sv('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle', class: 'c-tick' }, svg, opts.xFmt ? opts.xFmt(l) : l); });

      opts.series.forEach((s, si) => {
        const pts = s.values.map((v, i) => [x(i), y(v)]);
        const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
        if (s.area) {
          const gid = 'cg' + (++uid);
          const g = sv('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, sv('defs', {}, svg));
          sv('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.24 }, g);
          sv('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.02 }, g);
          sv('path', { d: d + 'L' + pts[n - 1][0] + ',' + y(Math.max(0, sc.bottom)) + 'L' + pts[0][0] + ',' + y(Math.max(0, sc.bottom)) + 'Z', fill: 'url(#' + gid + ')' }, svg);
        }
        sv('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
        const last = pts[n - 1];
        sv('circle', { cx: last[0], cy: last[1], r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
        if (si === 0 && opts.endLabel !== false) sv('text', { x: last[0] - 8, y: last[1] - 10, 'text-anchor': 'end', class: 'c-end' }, svg, opts.fmtShort ? opts.fmtShort(s.values[n - 1]) : opts.fmt(s.values[n - 1]));
      });

      // crosshair + tooltip (pointer and arrow keys)
      const hover = sv('g', { class: 'c-hover', visibility: 'hidden' }, svg);
      const vline = sv('line', { y1: T, y2: H - B, class: 'c-cross' }, hover);
      const dots = opts.series.map(s => sv('circle', { r: 4.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, hover));
      const tip = tooltip(wrap);
      let cur = -1;
      const show = i => {
        cur = i;
        hover.setAttribute('visibility', 'visible');
        vline.setAttribute('x1', x(i)); vline.setAttribute('x2', x(i));
        dots.forEach((dt, si) => { dt.setAttribute('cx', x(i)); dt.setAttribute('cy', y(opts.series[si].values[i])); });
        tip.show(x(i) / W * plot.clientWidth, opts.xFmt ? opts.xFmt(opts.labels[i], true) : opts.labels[i], opts.series.map(s => ({ color: s.color, label: s.name, value: opts.fmt(s.values[i]) })));
      };
      const hide = () => { cur = -1; hover.setAttribute('visibility', 'hidden'); tip.hide(); };
      const hit = sv('rect', { x: L, y: T, width: Math.max(1, W - L - R), height: H - T - B, fill: 'transparent', class: 'c-hit' }, svg);
      hit.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); const px = (e.clientX - r.left) * W / r.width; show(Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : (px - L) / ((W - L - R) / (n - 1)))))); });
      hit.addEventListener('pointerleave', hide);
      plot.onkeydown = e => { if (e.key === 'ArrowRight') { show(Math.min(n - 1, cur + 1)); e.preventDefault(); } if (e.key === 'ArrowLeft') { show(Math.max(0, cur < 0 ? n - 1 : cur - 1)); e.preventDefault(); } if (e.key === 'Escape') hide(); };
      plot.onblur = hide;
      plot.replaceChildren(svg);
    });
  }

  /* ---------------- grouped columns ---------------- */
  function columns(opts) {
    return frame(opts, (plot, wrap, W) => {
      const H = opts.height || 250, n = opts.labels.length, m = opts.series.length;
      const sc = yScale(opts.series.flatMap(s => s.values).concat(opts.refLine ? [opts.refLine.value] : []));
      const tickTxt = opts.axisFmt || opts.fmt;
      const L = 14 + Math.max(...sc.ticks.map(v => tickTxt(v).length)) * 6.6, R = 10, T = 14, B = 28;
      const y = v => T + (H - T - B) * (sc.top - v) / (sc.top - sc.bottom || 1);
      const band = (W - L - R) / n, gap = 2;
      const bw = Math.max(2, Math.min(24, (band * 0.72 - gap * (m - 1)) / m));
      const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'csvg' });
      axes(svg, sc, y, L, W, R, tickTxt);
      const k = every(n, Math.max(3, Math.floor(W / 70)));
      const tip = tooltip(wrap);
      const groups = [];
      opts.labels.forEach((l, i) => {
        const cx = L + band * i + band / 2;
        if (i % k === 0) sv('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'c-tick' }, svg, opts.xFmt ? opts.xFmt(l) : l);
        const g = sv('g', { class: 'c-col' }, svg);
        const x0 = cx - (bw * m + gap * (m - 1)) / 2;
        opts.series.forEach((s, si) => {
          const v = s.values[i] || 0; if (!v) return;
          const bx = x0 + si * (bw + gap), y0 = y(0), yv = y(v), r = Math.min(4, bw / 2, Math.abs(y0 - yv));
          const d = v > 0
            ? 'M' + bx + ',' + y0 + 'V' + (yv + r) + 'Q' + bx + ',' + yv + ' ' + (bx + r) + ',' + yv + 'H' + (bx + bw - r) + 'Q' + (bx + bw) + ',' + yv + ' ' + (bx + bw) + ',' + (yv + r) + 'V' + y0 + 'Z'
            : 'M' + bx + ',' + y0 + 'V' + (yv - r) + 'Q' + bx + ',' + yv + ' ' + (bx + r) + ',' + yv + 'H' + (bx + bw - r) + 'Q' + (bx + bw) + ',' + yv + ' ' + (bx + bw) + ',' + (yv - r) + 'V' + y0 + 'Z';
          sv('path', { d, fill: s.color }, g);
        });
        const hit = sv('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent', class: 'c-hit' }, svg);
        const on = () => { groups.forEach(x => x.classList.toggle('dim', x !== g)); tip.show(cx / W * plot.clientWidth, opts.xFmt ? opts.xFmt(l, true) : l, opts.series.map(s => ({ color: s.color, label: s.name, value: opts.fmt(s.values[i]) }))); };
        const off = () => { groups.forEach(x => x.classList.remove('dim')); tip.hide(); };
        hit.addEventListener('pointerenter', on); hit.addEventListener('pointerleave', off);
        groups.push(g);
      });
      if (opts.refLine) {
        const ry = y(opts.refLine.value);
        sv('line', { x1: L, x2: W - R, y1: ry, y2: ry, class: 'c-ref' }, svg);
        if (opts.refLine.label) sv('text', { x: W - R, y: ry - 6, 'text-anchor': 'end', class: 'c-end' }, svg, opts.refLine.label);
      }
      plot.replaceChildren(svg);
    });
  }

  /* ---------------- horizontal bars (HTML) ---------------- */
  function hbars(opts) {
    const max = Math.max(1e-9, ...opts.rows.map(r => Math.abs(r.value)));
    if (!opts.rows.length || opts.rows.every(r => !r.value)) return h('p', { class: 'muted cempty' }, opts.empty || 'No data for this period.');
    return h('div', { class: 'hbars' }, opts.rows.map(r => h('div', { class: 'hbar', title: r.label + ': ' + opts.fmt(r.value) },
      h('div', { class: 'hbar-label' }, r.label, r.note ? h('small', null, r.note) : null),
      h('div', { class: 'hbar-track' },
        h('div', { class: 'hbar-fill', style: { width: Math.max(0.6, Math.abs(r.value) / max * 100) + '%', background: r.color || opts.color || 'var(--series-1)' } }),
        h('span', { class: 'hbar-val' }, opts.fmt(r.value))))));
  }

  /* ---------------- single 100% stacked bar (HTML) ---------------- */
  function stack(opts) {
    const total = opts.parts.reduce((s, p) => s + Math.max(0, p.value), 0);
    const bar = h('div', { class: 'stackbar', role: 'img', 'aria-label': opts.title || 'Breakdown' },
      total ? opts.parts.filter(p => p.value > 0).map(p => h('div', { class: 'stackseg', title: p.label + ': ' + opts.fmt(p.value), style: { flexGrow: p.value, background: p.color } })) : h('div', { class: 'stackseg empty' }));
    const legend = h('div', { class: 'stacklegend' }, opts.parts.map(p => h('div', { class: 'stackleg' },
      h('i', { class: 'lkey', style: { background: p.color } }),
      h('span', null, p.label),
      h('b', null, opts.fmt(p.value)),
      h('small', null, total ? Math.round(p.value / total * 100) + '%' : '—'))));
    return h('div', { class: 'stackwrap' }, bar, legend);
  }

  /* ---------------- sparkline ---------------- */
  function spark(values, color, width) {
    const W = Math.max(40, Math.round(width || 120)), H = 30, n = values.length;
    const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'spark', 'aria-hidden': 'true' });
    if (n < 2) return svg;
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const x = i => 3 + i * (W - 8) / (n - 1), y = v => H - 5 - (v - lo) / span * (H - 10);
    const d = values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    sv('path', { d, fill: 'none', stroke: 'var(--spark)', 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    sv('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3.2, fill: color || 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 1.5 }, svg);
    return svg;
  }

  return { area, columns, hbars, stack, spark };
})();

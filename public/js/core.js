/* Core browser utilities: DOM builder, API client, record cache, formatting, dialogs. */
'use strict';

/* ---------- DOM ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = c => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

/* ---------- formatting ---------- */
const U = {
  num: Shared.num,
  today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  monthStart() { return U.today().slice(0, 8) + '01'; },
  fmtDate(s) { if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s || ''; const [y, m, d] = s.slice(0, 10).split('-'); return d + '-' + m + '-' + y; },
  money(n) { return (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  rupee(n) { return '₹ ' + U.money(n); },
  compact(n) {
    n = +n || 0; const a = Math.abs(n);
    if (a >= 1e7) return '₹ ' + (n / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return '₹ ' + (n / 1e5).toFixed(2) + ' L';
    return '₹ ' + Math.round(n).toLocaleString('en-IN');
  },
  qty(n) { return (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 }); },
  int(n) { return Math.round(+n || 0).toLocaleString('en-IN'); },
  pct(n) { return (+n || 0).toFixed(2) + '%'; },
  fmt(type, v) {
    if (v === '' || v === null || v === undefined) return '';
    switch (type) {
      case 'money': return U.money(v);
      case 'qty': return U.qty(v);
      case 'int': return U.int(v);
      case 'pct': return U.pct(v);
      case 'date': return U.fmtDate(v);
      default: return String(v);
    }
  },
  debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
  parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
  },
  qs(obj) { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj || {})) if (v !== '' && v !== undefined && v !== null && v !== false) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; },
  download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
  },
};

/* ---------- sign-in storage ---------- */
// Each browser tab keeps its OWN sign-in (sessionStorage). Shared storage (localStorage) let an admin
// signing in on one tab silently turn every other tab into admin on its next reload.
const SESSION_KEYS = ['erp_token', 'erp_user', 'erp_perms', 'erp_admin'];
const Sess = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode: sign-in lasts until reload */ } },
  clear() { for (const k of SESSION_KEYS) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } } },
};
// Remove any sign-in left in shared storage by older versions so it can never be picked up again.
try { for (const k of SESSION_KEYS) localStorage.removeItem(k); } catch (e) { /* ignore */ }

/* ---------- API ---------- */
const API = {
  token: Sess.get('erp_token') || '',
  user: JSON.parse(Sess.get('erp_user') || 'null'),
  perms: JSON.parse(Sess.get('erp_perms') || '{}'),
  isAdmin: Sess.get('erp_admin') === '1',
  fresh: false,
  onAuthLost: null,
  async call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, API.token ? { Authorization: 'Bearer ' + API.token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401 && url !== '/api/login') { API.setSession('', null); if (API.onAuthLost) API.onAuthLost(); }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  },
  get: url => API.call('GET', url),
  post: (url, b) => API.call('POST', url, b),
  put: (url, b) => API.call('PUT', url, b),
  del: url => API.call('DELETE', url),
  setSession(token, user, perms, isAdmin) {
    API.token = token; API.user = user; API.perms = perms || {}; API.isAdmin = !!isAdmin;
    if (token) {
      Sess.set('erp_token', token); Sess.set('erp_user', JSON.stringify(user));
      Sess.set('erp_perms', JSON.stringify(API.perms)); Sess.set('erp_admin', API.isAdmin ? '1' : '0');
    } else Sess.clear();
  },
  report: (name, q) => API.get('/api/report/' + name + U.qs(q)),
};

/* ---------- record cache (masters + documents) ---------- */
const Cache = {
  data: {},
  settings: null,
  async get(col) {
    // A department login may not see every collection; treat that as an empty list.
    if (!this.data[col]) { try { this.data[col] = await API.get('/api/' + col); } catch (e) { if (!API.token) throw e; this.data[col] = []; } }
    return this.data[col];
  },
  async load(cols) { await Promise.all([...new Set(cols)].map(c => this.get(c))); },
  async getSettings(force) { if (!this.settings || force) this.settings = await API.get('/api/settings'); return this.settings; },
  invalidate(col) { if (col) delete this.data[col]; else this.data = {}; },
  list(col) { return this.data[col] || []; },
  byId(col, id) { return (this.data[col] || []).find(r => r.id === id); },
};

/* ---------- permissions (the server enforces the same rules) ---------- */
const Perm = {
  can(area, level) {
    if (API.isAdmin) return true;
    if (!area) return true;
    if (area === 'admin') return false;
    return Shared.levelAtLeast(API.perms[area], level || 'view');
  },
  report(name) { return Perm.can(Shared.REPORT_AREA[name], 'view'); },
  // Can the user open a nav target ("schemaKey", "#/report/x", "#/settings")?
  target(t) {
    if (!t.startsWith('#')) { const s = SCHEMAS[t]; return !!s && Perm.can(s.area, 'view'); }
    const m = /^#\/report\/([^?]+)/.exec(t);
    if (m) return Perm.report(m[1]);
    if (t === '#/reports') return Object.keys(REPORTS).some(Perm.report);
    return true;
  },
};

/* ---------- dialogs & toasts ---------- */
function toast(msg, type) {
  const el = h('div', { class: 'toast ' + (type || 'ok'), role: type === 'err' ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), type === 'err' ? 6000 : 3000);
  setTimeout(() => el.remove(), type === 'err' ? 6500 : 3500);
}

function modal(title, body, buttons) {
  return new Promise(resolve => {
    const close = v => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const back = h('div', { class: 'modal-back', onclick: e => { if (e.target === back) close(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', null, title),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-actions' }, (buttons || [{ label: 'OK', value: true, primary: true }]).map(b =>
          h('button', { class: 'btn ' + (b.primary ? 'primary' : b.danger ? 'danger' : ''), onclick: () => close(b.value) }, b.label)))));
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    const f = back.querySelector('.modal-actions .primary, .modal-actions .danger');
    if (f) f.focus();
  });
}
const confirmBox = (msg, okLabel, danger) => modal('Please confirm', h('p', null, msg), [{ label: 'Cancel', value: false }, { label: okLabel || 'OK', value: true, primary: !danger, danger: !!danger }]);

/* ---------- theme (dark by default, remembered per browser) ---------- */
const Theme = {
  current() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; },
  toggle() {
    const next = Theme.current() === 'dark' ? 'light' : 'dark';
    if (next === 'light') document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('erp_theme', next); } catch (e) { /* ignore */ }
  },
  button(extraClass) {
    const moon = icon('moon'); moon.classList.add('ic-moon');
    const sun = icon('sun'); sun.classList.add('ic-sun');
    return h('button', { class: 'icon-btn theme-toggle ' + (extraClass || ''), type: 'button', title: 'Switch light / dark', 'aria-label': 'Switch between light and dark theme', onclick: Theme.toggle }, moon, sun);
  },
};

/* ---------- full screen (Esc returns to normal - the browser handles that key) ---------- */
const FullScreen = {
  supported: () => !!document.documentElement.requestFullscreen,
  on: () => !!document.fullscreenElement,
  enter() {
    if (!FullScreen.supported() || FullScreen.on()) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => toast('Full screen. Press Esc to return to normal view.'))
      .catch(() => { /* browser refused (no click yet) - the button still works */ });
  },
  exit() { if (FullScreen.on()) document.exitFullscreen().catch(() => {}); },
  toggle() { FullScreen.on() ? FullScreen.exit() : FullScreen.enter(); },
  // Button that shows expand / shrink depending on the current state.
  button(extraClass, withLabel) {
    const b = h('button', { class: (withLabel ? 'chip fs-chip ' : 'icon-btn ') + (extraClass || ''), type: 'button', onclick: FullScreen.toggle });
    const paint = () => {
      const on = FullScreen.on();
      b.title = on ? 'Exit full screen (Esc)' : 'Full screen';
      b.setAttribute('aria-label', b.title);
      b.replaceChildren(icon(on ? 'shrink' : 'expand', withLabel ? 14 : 18), withLabel ? (on ? 'Exit full screen' : 'Full screen') : '');
    };
    paint();
    document.addEventListener('fullscreenchange', () => { if (b.isConnected) paint(); });
    return FullScreen.supported() ? b : null;
  },
};

/* ---------- icons (simple stroke icons) ---------- */
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  cart: 'M3 4h2l2.4 11h10.2L20 7H6.2M9 20a1 1 0 1 0 0-.01M17 20a1 1 0 1 0 0-.01',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9',
  factory: 'M3 21V10l6 3.5V10l6 3.5V6h2l1 1.5h1l1-1.5h1V21zM7 17h2M12 17h2M17 17h1',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  calc: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM8 8h.01',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.15a3.5 3.5 0 0 1 0 6.7',
  rupee: 'M6 4h12M6 9h12M13.5 20 7 13h2.5a4.5 4.5 0 0 0 0-9',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6zM9 12l2 2 4-4',
  plus: 'M12 5v14M5 12h14',
  print: 'M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  down: 'M12 4v12m0 0-5-5m5 5 5-5M5 20h14',
  x: 'M6 6l12 12M18 6 6 18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  back: 'M15 18l-6-6 6-6',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10',
  chevron: 'M9 6l6 6-6 6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  truck: 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a1.5 1.5 0 1 0 0-.01M17 19a1.5 1.5 0 1 0 0-.01',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  roll: 'M4 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0M7 4h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7M7 10v8a3 3 0 0 0 0 0',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  yarn: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5 8c4 1 10 1 14 0M4 13c5 1 11 1 16 0M7 18.5c3 .7 7 .7 10 0',
};
function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size || 18); svg.setAttribute('height', size || 18);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.box);
  svg.appendChild(p);
  return svg;
}

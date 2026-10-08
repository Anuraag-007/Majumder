/* App shell: login, sidebar, router. */
'use strict';

const app = document.getElementById('app');
let mainEl = null, navEl = null, routeSeq = 0;

function renderLogin(message) {
  mainEl = null;
  const f = { username: '', password: '' };
  const err = h('p', { class: 'login-err', role: 'alert' }, message || '');
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');
  app.replaceChildren(Theme.button('login-theme'), h('div', { class: 'login' },
    h('form', { class: 'login-card', onsubmit: async e => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        FullScreen.enter(); // signing in is a click, so the browser allows full screen now
        const r = await API.post('/api/login', f);
        API.setSession(r.token, r.user, r.perms, r.isAdmin);
        API.fresh = true;
        Cache.invalidate();
        if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
        route();
      } catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; }
    } },
    h('div', { class: 'brand big' }, h('span', { class: 'logo' }, 'MH'), h('div', null, h('b', null, 'Majumdaar Hosiery'), h('small', null, 'ERP'))),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Username'), h('input', { autocomplete: 'username', required: true, oninput: e => { f.username = e.target.value; } })),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Password'), h('input', { type: 'password', autocomplete: 'current-password', required: true, oninput: e => { f.password = e.target.value; } })),
    err, btn,
    h('p', { class: 'muted small' }, 'First time? Sign in with admin / admin123 and change the password in Settings.'))));
  const u = app.querySelector('input'); if (u) u.focus();
}

function navTarget(t) { return t.startsWith('#') ? t : '#/list/' + t; }

function buildShell() {
  navEl = h('nav', { class: 'nav', 'aria-label': 'Modules' });
  const openKey = 'erp_nav_open';
  let open = {};
  try { open = JSON.parse(localStorage.getItem(openKey) || '{}'); } catch (e) { open = {}; }
  for (const g of NAV) {
    if (g.href === '#/reports' && !Perm.target('#/reports')) continue;
    if (g.href) { navEl.appendChild(h('a', { class: 'nav-top', href: g.href, 'data-match': g.href }, icon(g.icon), h('span', null, g.href === '#/dashboard' && !Perm.can('dashboard') ? 'Home' : g.t))); continue; }
    if (g.kids && !g.kids.some(([, t]) => Perm.target(t))) continue;
    const kids = g.kids.filter(([, t]) => Perm.target(t));
    const list = h('div', { class: 'nav-kids' }, kids.map(([label, t]) => h('a', { href: navTarget(t), 'data-match': navTarget(t) }, label)));
    const grp = h('div', { class: 'nav-group' + (open[g.t] ? ' open' : '') },
      h('button', { class: 'nav-top', 'aria-expanded': String(!!open[g.t]), onclick: e => {
        grp.classList.toggle('open'); open[g.t] = grp.classList.contains('open'); e.currentTarget.setAttribute('aria-expanded', String(open[g.t]));
        try { localStorage.setItem(openKey, JSON.stringify(open)); } catch (x) { /* ignore */ }
      } }, icon(g.icon), h('span', null, g.t), h('span', { class: 'caret' }, icon('chevron', 14))),
      list);
    navEl.appendChild(grp);
  }
  mainEl = h('main', { id: 'main', tabindex: -1 });
  const side = h('aside', { class: 'side' },
    h('a', { class: 'brand', href: '#/dashboard' }, h('span', { class: 'logo' }, 'MH'), h('div', null, h('b', null, 'Majumdaar Hosiery'), h('small', null, 'ERP'))),
    navEl,
    h('div', { class: 'side-foot' },
      h('div', { class: 'who' }, h('b', null, API.user.name || API.user.username), h('small', null, API.user.roleName || API.user.role)),
      h('div', { class: 'foot-btns' },
        FullScreen.button('light'),
        Theme.button('light'),
        h('button', { class: 'icon-btn light', title: 'Sign out', 'aria-label': 'Sign out', onclick: async () => { try { await API.post('/api/logout'); } catch (e) { /* ignore */ } API.setSession('', null); renderLogin(); } }, icon('logout')))));
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
    h('b', null, 'Majumdaar Hosiery ERP'));
  app.replaceChildren(h('div', { class: 'shell' }, side, h('div', { class: 'content' }, top, mainEl)), h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }));
}

function highlightNav() {
  const hash = location.hash || '#/dashboard';
  const path = hash.split('?')[0];
  const { parts } = U.parseHash();
  let best = null;
  for (const a of navEl.querySelectorAll('a[data-match]')) {
    const m = a.dataset.match;
    let score = 0;
    if (m === hash) score = 3;
    else if (m.split('?')[0] === path) score = 2;
    else if (parts[0] === 'edit' && m === '#/list/' + parts[1]) score = 2;
    a.classList.remove('active');
    if (score && (!best || score > best.score)) best = { a, score };
  }
  if (!best) return '';
  {
    best.a.classList.add('active');
    const grp = best.a.closest('.nav-group');
    if (grp && !grp.classList.contains('open')) { grp.classList.add('open'); grp.querySelector('.nav-top').setAttribute('aria-expanded', 'true'); }
  }
  // The colour of the active menu box (same rotation as the CSS nth-child rules), as a theme-aware variable.
  const kids = best.a.closest('.nav-kids');
  if (kids) return 'var(--edge-' + (([...kids.children].indexOf(best.a) + 1) % 7 + 1) + ')';
  const top = best.a.closest('.nav > *');
  return 'var(--edge-' + ([...navEl.children].indexOf(top) % 7 + 1) + ')';
}

async function route() {
  if (!API.token || !API.user) return renderLogin();
  if (!API.fresh) { // pick up role changes made by the admin since the last visit
    try { const me = await API.get('/api/me'); API.setSession(API.token, me.user, me.perms, me.isAdmin); API.fresh = true; mainEl = null; }
    catch (e) { return; }
  }
  if (!mainEl || !mainEl.isConnected) buildShell();
  document.body.classList.remove('nav-open');
  const seq = ++routeSeq;
  const { parts, query } = U.parseHash();
  const view = h('div', { class: 'view' }, h('p', { class: 'muted loading' }, 'Loading…'));
  mainEl.replaceChildren(view);
  mainEl.scrollTop = 0;
  const edge = highlightNav();
  // Screens opened from the menu take the colour of their menu box; the dashboard keeps its mixed colours.
  const themed = !!edge && ['list', 'edit', 'report', 'settings'].includes(parts[0]);
  mainEl.classList.toggle('themed', themed);
  if (themed) mainEl.style.setProperty('--page-edge', edge); else mainEl.style.removeProperty('--page-edge');
  const target = h('div');
  // Pages pass optional sections as null; the native append would print "null".
  target.append = (...kids) => Element.prototype.append.apply(target, kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  try {
    switch (parts[0] || 'dashboard') {
      case 'dashboard': await renderDashboard(target, query); break;
      case 'list': await renderList(target, parts[1], query); break;
      case 'edit': await renderForm(target, parts[1], parts[2] || 'new'); break;
      case 'report': await renderReport(target, parts[1], query); break;
      case 'reports': renderReportsHub(target); break;
      case 'settings': await renderSettings(target); break;
      default: renderNotFound(target);
    }
  } catch (e) {
    if (!API.token) return;
    target.replaceChildren(h('div', { class: 'banner err' }, e.message));
  }
  if (seq !== routeSeq) return; // a newer navigation took over
  view.replaceChildren(...target.childNodes);
  if (parts[0] === 'edit' && parts[2] === 'new') { const f = view.querySelector('.form input:not([type=checkbox]), .form select, .form textarea'); if (f) f.focus(); }
  document.title = ((view.querySelector('h1') || {}).textContent || 'ERP') + ' · Majumdaar Hosiery';
}

API.onAuthLost = () => renderLogin('Your session has ended. Please sign in again.');
window.addEventListener('hashchange', route);
if (!location.hash) history.replaceState(null, '', '#/dashboard');
route();

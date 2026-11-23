/*
 * Remote Support (consent-based): a support staff member sees a user's ERP screen and, only while the
 * user allows it, clicks, scrolls and types on it — all inside the browser, nothing to install.
 *
 *   - The user who needs help ("Get help") shares their ERP browser tab and, if they want, their
 *     microphone. The picture and voice go straight to the agent over WebRTC. A bar stays across the
 *     top of their screen for the whole session (even if they move to another page) with the one thing
 *     that matters — Stop — plus the control switch. Control is OFF until they turn it on, and turning
 *     it off, or Stop, takes effect at once.
 *   - The support staff member ("Give help", shown only with the Remote support permission) types the
 *     one-time code the user reads out, watches, talks back, and — once allowed — works in their ERP.
 *
 * Only the small set-up and action messages pass through the server's /ws/support relay; the screen and
 * voice do not. Coordinates travel as fractions (0..1) of the shared tab, so they land in the right
 * place whatever each screen's size or zoom.
 */
'use strict';

const RemoteSupport = (() => {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/support';
  const iceServers = () => { try { const s = (Cache.settings || {}).rtcIce; if (Array.isArray(s) && s.length) return s; } catch (e) { /* default */ } return ICE; };
  const isField = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  // Apply one agent action to this page. `move` only positions the pointer; everything else needs st.allow().
  // `st` carries the host's cursor, the last-focused field, consent, and a callback when focus lands on a box.
  function applyAction(m, st) {
    if (m.t === 'move') { if (st.cursor) { st.cursor.style.left = (m.x * innerWidth) + 'px'; st.cursor.style.top = (m.y * innerHeight) + 'px'; st.cursor.classList.toggle('act', st.allow()); } return; }
    if (!st.allow()) return;
    const x = Math.round((m.x || 0) * innerWidth), y = Math.round((m.y || 0) * innerHeight);
    if (m.t === 'scroll') {
      let el = document.elementFromPoint(x, y);
      while (el && el !== document.body && el !== document.documentElement) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1) break; el = el.parentElement; }
      if (el && el !== document.body && el !== document.documentElement) { el.scrollTop += m.dy || 0; el.scrollLeft += m.dx || 0; } else window.scrollBy(m.dx || 0, m.dy || 0);
      return;
    }
    if (m.t === 'text') { const t = isField(st.getLF()) ? st.getLF() : (isField(document.activeElement) ? document.activeElement : null); if (t) { t.value = m.value; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); } return; }
    if (m.t === 'key') { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, code: m.code || '', bubbles: true, cancelable: true })); t.dispatchEvent(new KeyboardEvent('keyup', { key: m.key, bubbles: true })); return; }
    if (m.t === 'click' || m.t === 'dblclick') {
      const el = document.elementFromPoint(x, y);
      if (!el) return;
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
      el.dispatchEvent(new MouseEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
      if (el.focus) try { el.focus(); } catch (e) { /* ignore */ }
      el.dispatchEvent(new MouseEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o));
      if (m.t === 'dblclick') el.dispatchEvent(new MouseEvent('dblclick', o));
      const f = isField(document.activeElement) ? document.activeElement : null; st.setLF(f);
      st.onFocus(!!f, f ? (f.value || '') : '');
    }
  }

  function connect(onMsg, onClose) {
    const ws = new WebSocket(wsUrl());
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m, ws); });
    ws.addEventListener('close', () => onClose && onClose());
    ws.addEventListener('error', () => onClose && onClose());
    ws.send_ = obj => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (x) { /* ignore */ } };
    return ws;
  }

  /* ============================ the user who needs help ============================ */
  // One host session at a time, so a persistent top bar can always reach it.
  let host = null;

  async function startHost(onState) {
    // getDisplayMedia must run straight from the click; the caller already did so and passed the stream.
    let display, mic = null, pc = null, ws = null, cursor = null, closed = false;
    const allow = { on: false };
    let lastField = null;
    const audioEls = [];

    try { display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true }); }
    catch (e) { toast('Sharing was not allowed. Click "Start sharing" and allow sharing this ERP tab.', 'err'); return false; }

    const bar = buildBar();
    document.body.appendChild(bar.el);
    document.body.classList.add('rs-sharing');
    cursor = h('div', { class: 'rs-cursor', 'aria-hidden': 'true' });
    document.body.appendChild(cursor);

    const surf = (display.getVideoTracks()[0].getSettings() || {}).displaySurface;
    if (surf && surf !== 'browser') { toast('For your privacy only this ERP website can be shared, not your whole screen or other apps. Click "Start sharing" again and share just this tab.', 'err'); cleanup(); return false; }
    display.getVideoTracks()[0].addEventListener('ended', cleanup); // the browser's own "Stop sharing"

    function cleanup() {
      if (closed) return; closed = true;
      try { ws && ws.send_({ t: 'end' }); ws && ws.close(); } catch (e) { /* ignore */ }
      try { pc && pc.close(); } catch (e) { /* ignore */ }
      for (const s of [display, mic]) if (s) s.getTracks().forEach(t => t.stop());
      if (cursor) cursor.remove();
      audioEls.forEach(a => a.remove());
      bar.el.remove();
      document.body.classList.remove('rs-sharing');
      host = null;
      onState('stopped');
    }

    // What applyAction needs: the pointer, the last-focused box, the consent flag, and a way to tell the agent.
    const st = { cursor, allow: () => allow.on, getLF: () => lastField, setLF: el => { lastField = el; }, onFocus: (on, value) => ws && ws.send_({ t: 'focus', on, value }) };

    ws = connect((m) => {
      if (m.t === 'ready') { bar.setCode(m.code); onState('ready'); return; }
      if (m.t === 'peer-joined') { bar.setAgent(m.who && m.who.name); startOffer(); return; }
      if (m.t === 'peer-left') { bar.setAgent(null); allow.on = false; bar.setAllow(false); return; }
      if (m.t === 'ended' || m.t === 'bye') { toast(m.reason || 'The support session ended.'); cleanup(); return; }
      if (m.t === 'sdp' && pc) { pc.setRemoteDescription(m.sdp).catch(() => {}); return; }
      if (m.t === 'ice' && pc) { pc.addIceCandidate(m.candidate).catch(() => {}); return; }
      applyAction(m, st);
    }, cleanup);
    ws.addEventListener('open', () => ws.send_({ t: 'auth', token: API.token, role: 'host' }));

    async function startOffer() {
      pc = new RTCPeerConnection({ iceServers: iceServers() });
      pc.onicecandidate = e => { if (e.candidate) ws.send_({ t: 'ice', candidate: e.candidate }); };
      pc.ontrack = e => { const a = h('audio', { autoplay: true }); a.srcObject = e.streams[0]; document.body.appendChild(a); audioEls.push(a); };
      display.getTracks().forEach(t => pc.addTrack(t, display));
      if (mic) mic.getTracks().forEach(t => pc.addTrack(t, mic));
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer); ws.send_({ t: 'sdp', sdp: pc.localDescription });
    }

    // The bar's buttons drive this session.
    bar.onStop = cleanup;
    bar.onAllow = on => { allow.on = on; ws && ws.send_({ t: 'control', on }); };
    bar.onMic = async () => {
      if (!mic) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); if (pc) { mic.getTracks().forEach(t => pc.addTrack(t, mic)); startOffer(); } return true; } catch (e) { toast('Microphone was not allowed.', 'err'); return false; } }
      mic.getTracks().forEach(t => t.stop()); mic = null; return false;
    };

    host = { stop: cleanup };
    onState('started');
    return true;
  }

  // The top bar shown to the user for the whole session.
  function buildBar() {
    const msg = h('span', { class: 'rs-bar-msg' }, 'Preparing to share this ERP tab…');
    const code = h('b', { class: 'rs-bar-code' });
    const allowBox = h('input', { type: 'checkbox' });
    const allow = h('label', { class: 'rs-bar-allow' }, allowBox, ' Allow support to control my screen');
    const micBtn = h('button', { class: 'btn small' }, 'Mic off');
    const stopBtn = h('button', { class: 'btn small danger' }, 'Stop sharing');
    const warnEl = h('span', { class: 'rs-bar-warn', hidden: true });
    const el = h('div', { class: 'rs-bar', role: 'status' }, h('span', { class: 'rs-dot' }), msg, code, warnEl, allow, micBtn, stopBtn);
    const api = { el, onStop: null, onAllow: null, onMic: null };
    stopBtn.onclick = () => api.onStop && api.onStop();
    allowBox.onchange = () => api.onAllow && api.onAllow(allowBox.checked);
    micBtn.onclick = async () => { const on = api.onMic && await api.onMic(); micBtn.textContent = on ? 'Mic on' : 'Mic off'; micBtn.classList.toggle('on', !!on); };
    api.setCode = c => { msg.textContent = 'You are sharing your ERP screen. Read this code to support:'; code.textContent = c; };
    api.setAgent = name => { if (name) { msg.textContent = name + ' is viewing this ERP tab.'; code.textContent = ''; } else { msg.textContent = 'Support left. Stop when you are done, or wait for them to re-join.'; } };
    api.setAllow = on => { allowBox.checked = on; };
    api.warn = t => { warnEl.hidden = false; warnEl.textContent = t; };
    return api;
  }

  /* ============================ the support staff member ============================ */

  async function startAgent(ui, code) {
    let pc = null, ws = null, mic = null, controlOn = false, closed = false;
    const video = ui.video;
    const norm = e => { const r = video.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    const sendCtl = o => { if (controlOn) ws.send_(o); };

    function cleanup() {
      if (closed) return; closed = true;
      try { ws && ws.send_({ t: 'end' }); ws && ws.close(); } catch (e) { /* ignore */ }
      try { pc && pc.close(); } catch (e) { /* ignore */ }
      if (mic) mic.getTracks().forEach(t => t.stop());
      ui.onStopped();
    }

    ws = connect((m) => {
      if (m.t === 'joined') { ui.setHost(m.host && m.host.name); setupPeer(); return; }
      if (m.t === 'control') { controlOn = m.on; ui.setControl(m.on); return; }
      if (m.t === 'focus') { ui.setFocus(m.on, m.value); return; }
      if (m.t === 'peer-left' || m.t === 'ended' || m.t === 'bye') { ui.note(m.reason || 'The session ended.'); cleanup(); return; }
      if (m.t === 'sdp' && pc) { handleOffer(m.sdp); return; }
      if (m.t === 'ice' && pc) { pc.addIceCandidate(m.candidate).catch(() => {}); return; }
    }, cleanup);
    ws.addEventListener('open', () => ws.send_({ t: 'auth', token: API.token, role: 'agent', code }));

    async function setupPeer() {
      pc = new RTCPeerConnection({ iceServers: iceServers() });
      pc.onicecandidate = e => { if (e.candidate) ws.send_({ t: 'ice', candidate: e.candidate }); };
      pc.ontrack = e => { if (e.track.kind === 'video') video.srcObject = e.streams[0]; else { const a = h('audio', { autoplay: true }); a.srcObject = e.streams[0]; ui.panel.appendChild(a); } };
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getTracks().forEach(t => pc.addTrack(t, mic)); } catch (e) { /* watch & type without a mic */ }
    }
    async function handleOffer(sdp) { await pc.setRemoteDescription(sdp); const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); ws.send_({ t: 'sdp', sdp: pc.localDescription }); }

    let lastMove = 0;
    video.addEventListener('mousemove', e => { const now = Date.now(); if (now - lastMove < 40) return; lastMove = now; ws.send_(Object.assign({ t: 'move' }, norm(e))); });
    video.addEventListener('click', e => sendCtl(Object.assign({ t: 'click' }, norm(e))));
    video.addEventListener('dblclick', e => sendCtl(Object.assign({ t: 'dblclick' }, norm(e))));
    video.addEventListener('wheel', e => { e.preventDefault(); sendCtl({ t: 'scroll', dx: e.deltaX, dy: e.deltaY }); }, { passive: false });

    return { typeText: v => sendCtl({ t: 'text', value: v }), sendKey: k => sendCtl({ t: 'key', key: k }), stop: cleanup };
  }

  /* ============================ the page ============================ */

  function renderSupport(target) {
    target.append(pageHead('Remote Support', 'See and, with the other person\'s permission, help on their ERP screen — nothing to install. The picture and voice go straight between the two browsers.', []));
    target.append(h('div', { class: 'rs-grid' }, hostCard(), Perm.can('support') ? agentCard() : helperNote()));
  }

  function helperNote() {
    return h('section', { class: 'card rs-card' }, h('h3', null, 'Give help'),
      h('p', { class: 'muted' }, 'Only staff with the "Remote support" permission can view and control another user\'s screen. Ask the administrator to turn it on for your login (Admin → Roles & Permissions → Remote support).'));
  }

  function hostCard() {
    const card = h('section', { class: 'card rs-card' });
    const status = h('p', { class: 'muted' }, 'Share only this ERP tab so a support colleague can see it and, if you allow, help on it. They cannot see your desktop or any other app or tab — only this website. You stay in control: a bar at the top lets you stop, or switch control off, at any time.');
    const startBtn = h('button', { class: 'btn primary' }, icon('screen', 16), 'Start sharing');
    const onState = s => {
      if (s === 'started') { startBtn.hidden = true; status.textContent = 'Starting… allow sharing this tab in the browser box (only this ERP tab is offered).'; }
      if (s === 'ready') status.textContent = 'Sharing is active — use the bar across the top of the screen. Read the code there to your colleague.';
      if (s === 'stopped') { startBtn.hidden = false; status.textContent = 'Sharing stopped. Click "Start sharing" to begin again.'; }
    };
    startBtn.onclick = async () => { if (host) { toast('You are already sharing — use the bar at the top.'); return; } startBtn.hidden = true; const ok = await startHost(onState); if (!ok) startBtn.hidden = false; };
    card.append(h('h3', null, 'Get help'), status, h('div', { class: 'rs-btns' }, startBtn));
    return card;
  }

  function agentCard() {
    const card = h('section', { class: 'card rs-card' });
    let session = null;
    const codeInp = h('input', { type: 'text', placeholder: '6-character code', maxlength: 6, 'aria-label': 'Session code', class: 'rs-codein', autocomplete: 'off', spellcheck: false });
    const joinBtn = h('button', { class: 'btn primary' }, 'Connect');
    const status = h('p', { class: 'muted' }, 'Enter the code the user reads out to you, then help them on their screen.');
    const stage = h('div', { class: 'rs-stage', hidden: true });
    const video = h('video', { class: 'rs-video', autoplay: true, playsinline: true, muted: true });
    const ctlBadge = h('span', { class: 'badge warn' }, 'Control not allowed yet');
    const typeBox = h('input', { type: 'text', class: 'rs-type', placeholder: 'Click a box on the screen, then type here', hidden: true, 'aria-label': 'Type into the focused box' });
    const stopBtn = h('button', { class: 'btn small danger' }, 'Disconnect');
    stage.append(h('div', { class: 'rs-stagehead' }, ctlBadge, typeBox, stopBtn), h('div', { class: 'rs-videowrap' }, video));

    const ui = {
      video, panel: card,
      setHost: name => { status.textContent = (name || 'The user') + '\'s screen — connecting the picture…'; stage.hidden = false; codeInp.disabled = joinBtn.disabled = true; },
      setControl: on => { ctlBadge.textContent = on ? 'Control active — click, scroll and type on the screen' : 'Control not allowed yet (ask the user to tick "Allow support to control my screen")'; ctlBadge.className = 'badge ' + (on ? 'ok' : 'warn'); typeBox.hidden = !on; if (!on) typeBox.value = ''; },
      setFocus: (on, value) => { if (!on) { typeBox.value = ''; return; } typeBox.value = value || ''; typeBox.focus(); typeBox.select(); },
      note: msg => toast(msg),
      onStopped: () => { session = null; stage.hidden = true; codeInp.disabled = joinBtn.disabled = false; status.textContent = 'Enter the code the user reads out to you, then help them on their screen.'; },
    };

    joinBtn.onclick = async () => {
      const code = codeInp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
      if (code.length !== 6) { toast('Enter the 6-character code.', 'err'); return; }
      session = await startAgent(ui, code);
    };
    codeInp.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
    stopBtn.onclick = () => session && session.stop();
    typeBox.addEventListener('input', () => session && session.typeText(typeBox.value));
    typeBox.addEventListener('keydown', e => { if (!session) return; if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); session.sendKey(e.key); } });

    card.append(h('h3', null, 'Give help'), status, h('div', { class: 'rs-btns' }, codeInp, joinBtn), stage);
    return card;
  }

  // Exposed for the automated browser test: apply a control action to this page (no consent gate, no cursor).
  let _tlf = null;
  const _apply = m => applyAction(m, { cursor: null, allow: () => true, getLF: () => _tlf, setLF: el => { _tlf = el; }, onFocus: () => {} });

  return { render: renderSupport, _apply };
})();

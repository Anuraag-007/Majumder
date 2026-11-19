'use strict';
/*
 * Remote support relay: a tiny, dependency-free WebSocket server (RFC 6455) that passes messages
 * between exactly two people — the user who needs help (the "host", who shares their ERP screen) and
 * a support staff member (the "agent", who watches and, only with the host's consent, controls it).
 *
 * The server never sees the screen: the picture and the voice go straight between the two browsers
 * over WebRTC. This relay only carries the small set-up messages (the WebRTC offer / answer and ICE),
 * the agent's pointer / key actions, and the host's consent. It also enforces the rules that keep it
 * a *support* tool and not hidden access:
 *   - both sides must be signed-in ERP users (they send their session token in the first message);
 *   - the agent must have the "Remote support" permission (or be the administrator);
 *   - a session is reached only by the one-time code the host reads out, and holds at most one agent;
 *   - the agent's control actions are dropped unless the host has turned control on (double-checked
 *     here, not only in the host's browser).
 */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 512 * 1024;      // a WebRTC offer is a few KB; cap well above it
const AUTH_GRACE_MS = 8000;          // close a socket that does not identify itself in time
const CODE_CHARS = 'ACDEFGHJKMNPQRSTUVWXYZ2345679'; // no easily-confused letters/digits
// The agent's actions that move or change the host's page: relayed only while the host allows control.
const CONTROL_MSGS = new Set(['move', 'click', 'dblclick', 'scroll', 'key', 'text']);

const wsAccept = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

function frame(data) {
  const body = Buffer.from(data);
  const len = body.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, body]);
}

function attach(server, opts) {
  const { userByToken, canSupport, onEvent, path = '/ws/support' } = opts;
  const rooms = new Map(); // code -> { code, host, agent, hostUser, createdAt, controlOn }
  const log = (kind, user, info) => { try { onEvent && onEvent(kind, user, info); } catch (e) { /* logging must never break a call */ } };

  const newCode = () => {
    let c;
    do { c = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(c));
    return c;
  };

  // A thin wrapper around the raw TCP socket: send JSON, close, and parse incoming frames.
  function wrap(socket) {
    const ws = { socket, buf: Buffer.alloc(0), msg: [], msgLen: 0, alive: true, onJson: null, onClose: null };
    ws.send = obj => { if (ws.alive) try { socket.write(frame(JSON.stringify(obj))); } catch (e) { /* peer gone */ } };
    ws.close = (reason) => {
      if (!ws.alive) return;
      ws.alive = false;
      if (reason) try { socket.write(frame(JSON.stringify({ t: 'bye', reason }))); } catch (e) { /* ignore */ }
      try { socket.end(Buffer.from([0x88, 0x00])); } catch (e) { /* ignore */ }
      try { socket.destroy(); } catch (e) { /* ignore */ }
      if (ws.onClose) { const f = ws.onClose; ws.onClose = null; f(); }
    };
    socket.on('data', chunk => read(ws, chunk));
    socket.on('close', () => { ws.alive = false; if (ws.onClose) { const f = ws.onClose; ws.onClose = null; f(); } });
    socket.on('error', () => ws.close());
    return ws;
  }

  function read(ws, chunk) {
    ws.buf = ws.buf.length ? Buffer.concat([ws.buf, chunk]) : chunk;
    while (ws.alive) {
      const b = ws.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MESSAGE) return ws.close();
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      ws.buf = b.subarray(off + len);
      if (opcode === 0x8) return ws.close();                               // close
      if (opcode === 0x9) { try { ws.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch (e) { /* ignore */ } continue; } // ping -> pong
      if (opcode === 0xa) continue;                                        // pong
      if (opcode === 0x1 || opcode === 0x0) {                              // text / continuation
        ws.msgLen += payload.length;
        if (ws.msgLen > MAX_MESSAGE) return ws.close();
        ws.msg.push(payload);
        if (fin) { const full = Buffer.concat(ws.msg).toString('utf8'); ws.msg = []; ws.msgLen = 0; let j; try { j = JSON.parse(full); } catch (e) { return; } if (ws.onJson) ws.onJson(j); }
      }
    }
  }

  const peerOf = (room, ws) => (room.host === ws ? room.agent : room.host);

  function leave(room, ws) {
    if (!room) return;
    const other = peerOf(room, ws);
    if (ws === room.host) { // the host left: the session is over
      if (other) other.send({ t: 'ended', reason: 'The other side closed the session.' });
      rooms.delete(room.code);
    } else if (ws === room.agent) { // the agent left: the host can wait for another
      room.agent = null; room.controlOn = false;
      if (other) other.send({ t: 'peer-left', role: 'agent' });
    }
  }

  function begin(ws, info) {
    const user = userByToken(info.token);
    if (!user) return ws.close('Please sign in to the ERP again.');
    const who = { id: user.id, name: user.name || user.username };

    if (info.role === 'host') {
      const code = newCode();
      const room = { code, host: ws, agent: null, hostUser: who, createdAt: Date.now(), controlOn: false };
      rooms.set(code, room);
      ws.room = room; ws.role = 'host';
      ws.send({ t: 'ready', code, you: who });
      log('start', user, { code });
      ws.onClose = () => leave(room, ws);
      ws.onJson = m => hostMessage(room, ws, m);
      return;
    }

    if (info.role === 'agent') {
      if (!canSupport(user)) return ws.close('Your login is not allowed to give remote support.');
      const room = rooms.get(String(info.code || '').toUpperCase().trim());
      if (!room || !room.host) return ws.close('No active support session has that code.');
      if (room.agent) return ws.close('Someone is already helping in this session.');
      room.agent = ws; ws.room = room; ws.role = 'agent'; room.controlOn = false;
      ws.send({ t: 'joined', host: room.hostUser, control: false });
      room.host.send({ t: 'peer-joined', role: 'agent', who });
      log('join', user, { code: room.code, host: room.hostUser.name });
      ws.onClose = () => leave(room, ws);
      ws.onJson = m => agentMessage(room, ws, m);
      return;
    }
    ws.close('Unknown role.');
  }

  // The host controls consent and relays WebRTC set-up to the agent.
  function hostMessage(room, ws, m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'control') { // the host turned control on or off
      room.controlOn = !!m.on;
      if (room.agent) room.agent.send({ t: 'control', on: room.controlOn });
      return;
    }
    if (m.t === 'end') return ws.close();
    if (room.agent) room.agent.send(m); // signaling (offer/answer/ice), cursor-position echoes, etc.
  }

  // The agent may send signaling freely, but page-changing actions pass only while control is on.
  function agentMessage(room, ws, m) {
    if (!m || typeof m.t !== 'string') return;
    if (CONTROL_MSGS.has(m.t) && m.t !== 'move' && !room.controlOn) return; // dropped: no consent
    if (m.t === 'end') return ws.close();
    if (room.host) room.host.send(m);
  }

  server.on('upgrade', (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return socket.destroy(); }
    if (url.pathname !== path) { try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); } catch (e) { /* ignore */ } return socket.destroy(); }
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ } return socket.destroy(); }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    socket.setNoDelay(true);
    const ws = wrap(socket);
    // The first message must identify the user and role; otherwise the socket is dropped.
    const timer = setTimeout(() => ws.close('No sign-in received.'), AUTH_GRACE_MS);
    ws.onJson = m => { if (!m || m.t !== 'auth') return; clearTimeout(timer); ws.onJson = null; begin(ws, m); };
    ws.onClose = () => clearTimeout(timer);
  });

  // Drop sockets that have gone silent (closed laptops, lost Wi-Fi) so rooms do not pile up.
  const ping = setInterval(() => {
    for (const room of rooms.values()) for (const ws of [room.host, room.agent]) if (ws && ws.alive) { try { ws.socket.write(Buffer.from([0x89, 0x00])); } catch (e) { ws.close(); } }
  }, 30000);
  ping.unref && ping.unref();

  return { rooms };
}

module.exports = { attach };

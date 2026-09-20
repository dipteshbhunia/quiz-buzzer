'use strict';

/**
 * Quiz Buzzer server
 * ------------------
 * - The organizer ("host") logs in with HOST_PASSWORD and gets a 4-letter room code.
 * - Players join that room from their phones with a Player ID.
 * - The SERVER decides who buzzed first (order of arrival at the server), so a
 *   player's own phone clock can never be used to cheat.
 * - Presses made while the buzzers are locked ("early" / false start) are never
 *   counted. They are only logged so the organizer can see them.
 *
 * All state is held in memory: run ONE instance of this server.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ---------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT, 10) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const HOST_PASSWORD = process.env.HOST_PASSWORD || (IS_PROD ? '' : 'admin');
const MAX_PLAYERS_PER_ROOM = parseInt(process.env.MAX_PLAYERS, 10) || 300;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 200;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // idle rooms are removed after 12 h

if (!HOST_PASSWORD) {
  console.error('FATAL: set the HOST_PASSWORD environment variable before starting in production.');
  process.exit(1);
}
if (!process.env.HOST_PASSWORD) {
  console.warn('WARNING: HOST_PASSWORD not set, using the insecure development default "admin".');
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'"
  );
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// QR code (SVG) that opens the player page with the room code pre-filled.
app.get('/qr.svg', async (req, res) => {
  const code = String(req.query.room || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return res.status(400).end();
  const url = `${req.protocol}://${req.get('host')}/play?room=${code}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) {
    res.status(500).end();
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0, etag: true }));

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 4000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e4,
});

// ---------------------------------------------------------------- helpers
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

const makeToken = () => crypto.randomBytes(16).toString('hex');
const nowMs = () => Number(process.hrtime.bigint()) / 1e6; // monotonic, high resolution

function newRoomCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cleanName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function limiter(max, perMs) {
  let tokens = max;
  let last = Date.now();
  return () => {
    const n = Date.now();
    tokens = Math.min(max, tokens + ((n - last) / perMs) * max);
    last = n;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// crude brute-force guard on host login (per IP)
const loginFails = new Map();
function loginAllowed(ip) {
  const rec = loginFails.get(ip);
  return !rec || rec.until < Date.now() || rec.count < 8;
}
function loginFailed(ip) {
  const rec = loginFails.get(ip);
  if (!rec || rec.until < Date.now()) loginFails.set(ip, { count: 1, until: Date.now() + 10 * 60 * 1000 });
  else rec.count += 1;
}

function clientIp(socket) {
  const xf = socket.handshake.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : socket.handshake.address) || 'unknown';
}

// ---------------------------------------------------------------- room model
/**
 * state:
 *   'locked' - buzzers closed. Any press is an EARLY press and never counts.
 *   'open'   - organizer said go. Waiting for the first buzz.
 *   'buzzed' - someone buzzed. buzzes[0] is the winner, the rest queue behind.
 */
function createRoom() {
  const room = {
    code: newRoomCode(),
    hostToken: makeToken(),
    state: 'locked',
    round: 0,
    players: new Map(), // key (lower-case id) -> player
    buzzes: [], // [{key, name, delta}]  delta = ms behind the first buzz
    early: [], // [{key, name}]          false starts, NOT counted
    blocked: new Set(), // keys that cannot buzz this question
    firstAt: 0,
    settings: { lockoutEarly: false },
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function hostView(room) {
  const players = [...room.players.values()]
    .map((p) => ({ key: p.key, name: p.name, score: p.score, connected: p.connected }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    code: room.code,
    state: room.state,
    round: room.round,
    settings: room.settings,
    players,
    online: players.filter((p) => p.connected).length,
    buzzes: room.buzzes.map((b) => ({ key: b.key, name: b.name, delta: Math.round(b.delta * 10) / 10 })),
    early: room.early.map((e) => ({ key: e.key, name: e.name })),
    blocked: [...room.blocked],
  };
}

function playerView(room, p) {
  const idx = room.buzzes.findIndex((b) => b.key === p.key);
  const winner = room.buzzes[0];
  return {
    code: room.code,
    name: p.name,
    score: p.score,
    state: room.state,
    round: room.round,
    winner: winner ? winner.name : null,
    winnerIsMe: !!winner && winner.key === p.key,
    position: idx >= 0 ? idx + 1 : null,
    early: room.early.some((e) => e.key === p.key),
    lockedOut: room.blocked.has(p.key),
  };
}

const emitHost = (room) => io.to('host:' + room.code).emit('host:state', hostView(room));
const emitPlayer = (room, p) => {
  if (p.connected) io.to(p.socketId).emit('player:state', playerView(room, p));
};
function emitAll(room) {
  emitHost(room);
  for (const p of room.players.values()) emitPlayer(room, p);
}
const touch = (room) => (room.lastActive = Date.now());

// Remove a player and repair the queue if they were in it.
function removePlayer(room, key) {
  if (!room.players.delete(key)) return;
  const wasLeader = room.buzzes[0] && room.buzzes[0].key === key;
  room.buzzes = room.buzzes.filter((b) => b.key !== key);
  room.early = room.early.filter((e) => e.key !== key);
  room.blocked.delete(key);
  if (wasLeader) {
    if (room.buzzes.length) {
      const base = room.buzzes[0].delta;
      room.buzzes.forEach((b) => (b.delta = Math.max(0, b.delta - base)));
    } else if (room.state === 'buzzed') {
      room.state = 'open';
      room.firstAt = 0;
    }
  }
  touch(room);
  emitAll(room);
}

// ---------------------------------------------------------------- sockets
io.on('connection', (socket) => {
  const ctx = { role: null, code: null, key: null };
  const allow = limiter(20, 1000); // max ~20 events / second / socket
  const ack = (fn) => (typeof fn === 'function' ? fn : () => {});

  const hostRoom = () => {
    if (ctx.role !== 'host') return null;
    const r = rooms.get(ctx.code);
    return r || null;
  };

  // ---------- host
  socket.on('host:create', (data, cb) => {
    cb = ack(cb);
    const ip = clientIp(socket);
    if (!loginAllowed(ip)) return cb({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
    if (!data || !safeEqual(data.password || '', HOST_PASSWORD)) {
      loginFailed(ip);
      return cb({ ok: false, error: 'Wrong password.' });
    }
    if (rooms.size >= MAX_ROOMS) return cb({ ok: false, error: 'Server is full. Try again later.' });
    const room = createRoom();
    ctx.role = 'host';
    ctx.code = room.code;
    socket.join('host:' + room.code);
    cb({ ok: true, code: room.code, hostToken: room.hostToken, state: hostView(room) });
  });

  socket.on('host:resume', (data, cb) => {
    cb = ack(cb);
    const room = data && rooms.get(String(data.code || '').toUpperCase());
    if (!room || !safeEqual(data.hostToken || '', room.hostToken)) return cb({ ok: false });
    ctx.role = 'host';
    ctx.code = room.code;
    socket.join('host:' + room.code);
    touch(room);
    cb({ ok: true, code: room.code, state: hostView(room) });
  });

  // Organizer says "press now". Only possible from the locked state.
  socket.on('host:open', () => {
    const room = hostRoom();
    if (!room || !allow() || room.state !== 'locked') return;
    room.state = 'open';
    room.round += 1;
    room.buzzes = [];
    room.firstAt = 0;
    touch(room);
    emitAll(room);
  });

  // New question: close buzzers and clear everything for this question.
  socket.on('host:reset', () => {
    const room = hostRoom();
    if (!room || !allow()) return;
    room.state = 'locked';
    room.buzzes = [];
    room.early = [];
    room.blocked = new Set();
    room.firstAt = 0;
    touch(room);
    emitAll(room);
  });

  // Winner answered wrongly: they are out for this question, next in line
  // takes over. If nobody is queued, buzzers re-open for everyone else.
  socket.on('host:wrong', () => {
    const room = hostRoom();
    if (!room || !allow() || room.state !== 'buzzed' || !room.buzzes.length) return;
    const gone = room.buzzes.shift();
    room.blocked.add(gone.key);
    if (room.buzzes.length === 0) {
      room.state = 'open';
      room.firstAt = 0;
    } else {
      // re-base deltas on the new leader
      const base = room.buzzes[0].delta;
      room.buzzes.forEach((b) => (b.delta = Math.max(0, b.delta - base)));
    }
    touch(room);
    emitAll(room);
  });

  socket.on('host:score', (data) => {
    const room = hostRoom();
    if (!room || !allow() || !data) return;
    const p = room.players.get(String(data.key));
    const delta = Number(data.delta);
    if (!p || !Number.isFinite(delta) || Math.abs(delta) > 100) return;
    p.score += Math.trunc(delta);
    touch(room);
    emitHost(room);
    emitPlayer(room, p);
  });

  socket.on('host:settings', (data) => {
    const room = hostRoom();
    if (!room || !allow() || !data) return;
    if (typeof data.lockoutEarly === 'boolean') room.settings.lockoutEarly = data.lockoutEarly;
    touch(room);
    emitHost(room);
  });

  socket.on('host:kick', (data) => {
    const room = hostRoom();
    if (!room || !allow() || !data) return;
    const key = String(data.key);
    const p = room.players.get(key);
    if (!p) return;
    if (p.connected) io.to(p.socketId).emit('player:kicked');
    removePlayer(room, key);
  });

  socket.on('host:end', () => {
    const room = hostRoom();
    if (!room) return;
    io.to('players:' + room.code).emit('room:closed');
    io.to('host:' + room.code).emit('room:closed');
    rooms.delete(room.code);
  });

  // ---------- player
  socket.on('player:join', (data, cb) => {
    cb = ack(cb);
    if (!allow()) return cb({ ok: false, error: 'Slow down.' });
    data = data || {};
    const code = String(data.code || '').toUpperCase().trim();
    const name = cleanName(data.name);
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.', fatal: true });
    if (!name) return cb({ ok: false, error: 'Enter your Player ID.' });

    const key = name.toLowerCase();
    let p = room.players.get(key);
    if (p) {
      if (!data.token || !safeEqual(data.token, p.token)) {
        return cb({
          ok: false,
          error: p.connected
            ? 'That Player ID is already in use. Pick another.'
            : 'That Player ID is taken. If it is yours, ask the organizer to remove it first.',
        });
      }
      p.socketId = socket.id;
      p.connected = true;
    } else {
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) return cb({ ok: false, error: 'This room is full.' });
      p = { key, name, token: makeToken(), socketId: socket.id, connected: true, score: 0 };
      room.players.set(key, p);
    }

    ctx.role = 'player';
    ctx.code = code;
    ctx.key = key;
    socket.join('players:' + code);
    touch(room);
    cb({ ok: true, token: p.token, name: p.name, state: playerView(room, p) });
    emitHost(room);
  });

  socket.on('player:buzz', () => {
    const t = nowMs(); // timestamp FIRST, before any other work
    if (ctx.role !== 'player' || !allow()) return;
    const room = rooms.get(ctx.code);
    const p = room && room.players.get(ctx.key);
    if (!p) return;
    touch(room);

    // 1) Buzzers not opened yet -> early press. NEVER counted.
    if (room.state === 'locked') {
      if (!room.early.some((e) => e.key === p.key)) {
        room.early.push({ key: p.key, name: p.name });
        if (room.settings.lockoutEarly) room.blocked.add(p.key);
        emitHost(room);
        emitPlayer(room, p);
      }
      return socket.emit('buzz:result', { status: 'early', lockedOut: room.blocked.has(p.key) });
    }

    // 2) Not allowed to buzz this question.
    if (room.blocked.has(p.key)) return socket.emit('buzz:result', { status: 'blocked' });

    // 3) Already buzzed this question.
    const existing = room.buzzes.findIndex((b) => b.key === p.key);
    if (existing >= 0) return socket.emit('buzz:result', { status: 'duplicate', position: existing + 1 });

    // 4) Valid buzz. First one to reach the server wins (Node handles events one at a time).
    if (room.buzzes.length === 0) room.firstAt = t;
    room.buzzes.push({ key: p.key, name: p.name, delta: t - room.firstAt });
    const position = room.buzzes.length;
    socket.emit('buzz:result', { status: 'accepted', position, first: position === 1 });

    if (position === 1) {
      room.state = 'buzzed';
      emitAll(room); // everybody learns who is first
    } else {
      emitHost(room);
      emitPlayer(room, p);
    }
  });

  socket.on('player:leave', () => {
    if (ctx.role !== 'player') return;
    const room = rooms.get(ctx.code);
    const p = room && room.players.get(ctx.key);
    if (p && p.socketId === socket.id) removePlayer(room, ctx.key);
    ctx.role = null;
  });

  socket.on('disconnect', () => {
    if (ctx.role !== 'player') return;
    const room = rooms.get(ctx.code);
    const p = room && room.players.get(ctx.key);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      emitHost(room);
    }
  });
});

// ---------------------------------------------------------------- housekeeping
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) if (room.lastActive < cutoff) rooms.delete(code);
  const now = Date.now();
  for (const [ip, rec] of loginFails) if (rec.until < now) loginFails.delete(ip);
}, 30 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Quiz Buzzer running on http://localhost:${PORT}`));

function shutdown() {
  console.log('Shutting down...');
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const WORLD = require('./public/world.js');
const { createGuestbookStore } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const GUESTBOOK_LIMIT = 500;

// 한 줄 텍스트: 제어문자 제거, 공백 정리, 글자 수(이모지 포함) 제한
function cleanText(value, max) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, max).join('').trim();
}

// 여러 줄 텍스트: 줄바꿈은 유지
function cleanMultiline(value, max) {
  const s = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(s).slice(0, max).join('').trim();
}

const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const BIRTHDAY_NAME = cleanText(process.env.BIRTHDAY_NAME, 20) || '주인공';

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });

const players = new Map();
const store = createGuestbookStore({ limit: GUESTBOOK_LIMIT });
let guestbook = []; // 최신 글이 앞

const publicPlayer = (p) => ({ id: p.id, name: p.name, hue: p.hue, x: p.x, y: p.y, dx: p.dx, dy: p.dy, m: p.m });

function spawnPoint() {
  for (let i = 0; i < 40; i++) {
    const x = WORLD.spawn.x + (Math.random() - 0.5) * 300;
    const y = WORLD.spawn.y + (Math.random() - 0.5) * 90;
    if (!WORLD.collides(x, y)) return { x: Math.round(x), y: Math.round(y) };
  }
  return { ...WORLD.spawn };
}

io.on('connection', (socket) => {
  socket.emit('hello', { birthdayName: BIRTHDAY_NAME, online: players.size });

  let player = null;
  const last = { chat: 0, firework: 0, guestbook: 0 };

  socket.on('join', (data) => {
    if (player) return;
    const d = data && typeof data === 'object' ? data : {};
    if (players.size >= MAX_PLAYERS) return socket.emit('full', { max: MAX_PLAYERS });

    const name = cleanText(d.name, 12) || `손님${Math.floor(Math.random() * 900 + 100)}`;
    const hue = Math.round(num(d.hue, 0, 359, Math.random() * 360));
    let pos = spawnPoint();
    const x = num(d.x, 0, WORLD.w, NaN);
    const y = num(d.y, 0, WORLD.h, NaN);
    if (Number.isFinite(x) && Number.isFinite(y) && !WORLD.collides(x, y)) pos = { x, y };

    player = { id: socket.id, name, hue, x: pos.x, y: pos.y, dx: 0, dy: 1, m: 0 };
    players.set(socket.id, player);

    socket.emit('welcome', {
      id: socket.id,
      birthdayName: BIRTHDAY_NAME,
      players: [...players.values()].map(publicPlayer),
      guestbook,
    });
    socket.broadcast.emit('joined', publicPlayer(player));
    io.emit('online', players.size);
  });

  socket.on('move', (d) => {
    if (!player || !d || typeof d !== 'object') return;
    player.x = Math.round(num(d.x, 0, WORLD.w, player.x));
    player.y = Math.round(num(d.y, 0, WORLD.h, player.y));
    player.dx = num(d.dx, -1, 1, 0);
    player.dy = num(d.dy, -1, 1, 0);
    player.m = d.m ? 1 : 0;
    socket.broadcast.emit('moved', publicPlayer(player));
  });

  socket.on('chat', (d) => {
    if (!player) return;
    const now = Date.now();
    if (now - last.chat < 600) return;
    const text = cleanText(d && d.text, 60);
    if (!text) return;
    last.chat = now;
    io.emit('chat', { id: player.id, name: player.name, hue: player.hue, text });
  });

  socket.on('firework', (d) => {
    if (!player) return;
    const i = Number(d && d.launcher);
    const L = WORLD.launchers[i];
    if (!L) return;
    if (Math.hypot(player.x - L.x, player.y - L.y) > WORLD.fireworkRange + 40) return;
    const now = Date.now();
    if (now - last.firework < 1500) return;
    last.firework = now;
    io.emit('firework', { launcher: i, seed: crypto.randomInt(1, 2 ** 31 - 1), id: player.id, name: player.name });
  });

  socket.on('guestbook:add', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!player) return reply({ ok: false, error: '먼저 파티에 참가해 주세요.' });
    const now = Date.now();
    if (now - last.guestbook < 8000) return reply({ ok: false, error: '조금만 기다렸다가 다시 남겨주세요.' });
    const text = cleanMultiline(d && d.text, 300);
    if (!text) return reply({ ok: false, error: '메시지를 입력해 주세요.' });
    last.guestbook = now;

    const entry = { id: crypto.randomUUID(), name: player.name, hue: player.hue, text, ts: now };
    guestbook.unshift(entry);
    if (guestbook.length > GUESTBOOK_LIMIT) guestbook.length = GUESTBOOK_LIMIT;
    io.emit('guestbook:new', entry);
    reply({ ok: true });
    try {
      await store.add(entry, guestbook);
    } catch (err) {
      console.error('[guestbook] 저장 실패:', err.message);
    }
  });

  socket.on('disconnect', () => {
    if (!player) return;
    players.delete(player.id);
    io.emit('left', player.id);
    io.emit('online', players.size);
    player = null;
  });
});

(async () => {
  try {
    guestbook = (await store.load()).slice(0, GUESTBOOK_LIMIT);
    console.log(`[guestbook] ${store.name}에서 ${guestbook.length}개 불러옴`);
  } catch (err) {
    console.error('[guestbook] 불러오기 실패:', err.message);
  }
  server.listen(PORT, () => console.log(`🎂 생일 파티 서버: http://localhost:${PORT}  (주인공: ${BIRTHDAY_NAME})`));
})();

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

// 기본값은 환경 변수, 관리자 페이지에서 바꾸면 저장소에 저장된 값이 우선
const DEFAULT_BIRTHDAY_NAME = cleanText(process.env.BIRTHDAY_NAME, 20) || '주인공';
let birthdayName = DEFAULT_BIRTHDAY_NAME;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');

// 관리자 비밀번호 비교 (길이와 상관없이 일정한 시간)
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const checkAdminKey = (key) => ADMIN_KEY !== '' && crypto.timingSafeEqual(sha256(key), sha256(ADMIN_KEY));

// IP별 비밀번호 실패 횟수 제한: 5번 틀리면 1분 잠금
const adminFails = new Map();
function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || socket.handshake.address;
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
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
  socket.emit('hello', { birthdayName, online: players.size });

  let player = null;
  let isAdmin = false;
  const last = { chat: 0, firework: 0, guestbook: 0 };

  socket.on('admin:login', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!ADMIN_KEY) return reply({ ok: false, error: '관리자 기능이 꺼져 있어요. (ADMIN_KEY 미설정)' });
    const ip = clientIp(socket);
    const now = Date.now();
    const rec = adminFails.get(ip) || { count: 0, until: 0 };
    if (rec.until > now) {
      return reply({ ok: false, error: `너무 많이 틀렸어요. ${Math.ceil((rec.until - now) / 1000)}초 후에 다시 시도해 주세요.` });
    }
    if (!checkAdminKey(String((d && d.key) || ''))) {
      rec.count += 1;
      if (rec.count >= 5) { rec.count = 0; rec.until = now + 60_000; }
      adminFails.set(ip, rec);
      return reply({ ok: false, error: '비밀번호가 틀렸어요.' });
    }
    adminFails.delete(ip);
    isAdmin = true;
    // Upstash 화면에서 직접 고친 내용이 있을 수 있으니 저장소에서 다시 읽어 모두에게 동기화
    try {
      guestbook = (await store.load()).slice(0, GUESTBOOK_LIMIT);
      io.emit('guestbook:all', guestbook);
    } catch (err) {
      console.error('[guestbook] 다시 불러오기 실패:', err.message);
    }
    reply({ ok: true, guestbook, birthdayName });
  });

  socket.on('admin:setName', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdmin) return reply({ ok: false, error: '관리자만 바꿀 수 있어요.' });
    const name = cleanText(d && d.name, 20);
    if (!name) return reply({ ok: false, error: '이름을 입력해 주세요.' });
    try {
      await store.setSetting('birthdayName', name);
    } catch (err) {
      console.error('[settings] 저장 실패:', err.message);
      return reply({ ok: false, error: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    birthdayName = name;
    io.emit('config', { birthdayName });
    console.log(`[settings] 주인공 이름 변경: ${name}`);
    reply({ ok: true, birthdayName });
  });

  socket.on('admin:logout', () => { isAdmin = false; });

  socket.on('guestbook:delete', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdmin) return reply({ ok: false, error: '관리자만 삭제할 수 있어요.' });
    const id = String((d && d.id) || '');
    const idx = guestbook.findIndex((e) => e.id === id);
    if (idx !== -1) guestbook.splice(idx, 1);
    try {
      await store.remove(id, guestbook);
    } catch (err) {
      console.error('[guestbook] 삭제 실패:', err.message);
      return reply({ ok: false, error: '저장소에서 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    io.emit('guestbook:deleted', id);
    console.log(`[guestbook] 관리자 삭제: ${id}`);
    reply({ ok: true });
  });

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
      birthdayName,
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
  try {
    const saved = cleanText(await store.getSetting('birthdayName'), 20);
    if (saved) birthdayName = saved;
  } catch (err) {
    console.error('[settings] 불러오기 실패:', err.message);
  }
  server.listen(PORT, () => console.log(`🎂 생일 파티 서버: http://localhost:${PORT}  (주인공: ${birthdayName})`));
})();

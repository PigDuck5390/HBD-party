'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const WORLD = require('./public/world.js');
const { createGuestbookStore } = require('./storage');
const { createFilter, normalizeWord } = require('./filter');
const { makeZip } = require('./zip');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const GUESTBOOK_LIMIT = 500;
const MAX_GIFTS = Number(process.env.MAX_GIFTS) || 30;
const MAX_GIFT_BYTES = 700 * 1024; // 브라우저에서 줄여서 보내므로 보통 100~400KB
const GIFT_COLORS = [
  ['#ff8fab', '#ffffff'], ['#7ad3f7', '#ff6fa3'], ['#ffd166', '#6c63ff'], ['#b39ddb', '#ffd166'],
  ['#8bd3a5', '#ff6fa3'], ['#ffb38a', '#7a5cff'], ['#ff6f91', '#ffe066'], ['#6c9bff', '#ffffff'],
];

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

// 파티 설정: 기본값은 환경 변수, 관리자 페이지에서 바꾸면 저장소에 저장된 값이 우선
// - birthdayName: 주인공 이름 (예전 이름 그대로 사용 — 저장된 데이터와 호환)
// - partyType: 파티 종류 (생일, 입사, 졸업 …) → "OO의 입사 파티"
// - bannerText: 벽에 걸린 플랜카드 문구
let birthdayName = cleanText(process.env.BIRTHDAY_NAME, 20) || '주인공';
let partyType = cleanText(process.env.PARTY_TYPE, 10) || '생일';
let bannerText = cleanText(process.env.BANNER_TEXT, 24) || 'HAPPY BIRTHDAY';
const partyConfig = () => ({ birthdayName, partyType, bannerText });
const partyTitle = () => `${birthdayName}의 ${partyType} 파티`;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');

// 관리자 비밀번호 비교 (길이와 상관없이 일정한 시간)
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const checkAdminKey = (key) => ADMIN_KEY !== '' && crypto.timingSafeEqual(sha256(key), sha256(ADMIN_KEY));

// IP별 비밀번호 실패 횟수 제한: 5번 틀리면 1분 잠금
const adminFails = new Map();
function ipFrom(headers, address) {
  const fwd = headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || address;
}
const clientIp = (socket) => ipFrom(socket.handshake.headers, socket.handshake.address);

// 관리자 비밀번호 확인 (소켓 로그인과 백업/복원 API에서 함께 사용)
function verifyAdmin(ip, key) {
  if (!ADMIN_KEY) return { ok: false, status: 503, error: '관리자 기능이 꺼져 있어요. (ADMIN_KEY 미설정)' };
  const now = Date.now();
  const rec = adminFails.get(ip) || { count: 0, until: 0 };
  if (rec.until > now) {
    return { ok: false, status: 429, error: `너무 많이 틀렸어요. ${Math.ceil((rec.until - now) / 1000)}초 후에 다시 시도해 주세요.` };
  }
  if (!checkAdminKey(String(key || ''))) {
    rec.count += 1;
    if (rec.count >= 5) { rec.count = 0; rec.until = now + 60_000; }
    adminFails.set(ip, rec);
    return { ok: false, status: 401, error: '비밀번호가 틀렸어요.' };
  }
  adminFails.delete(ip);
  return { ok: true };
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// 선물 사진: id마다 내용이 바뀌지 않으므로 오래 캐시
const gifts = new Map(); // id -> { meta, buf }
app.get('/gift/:id.jpg', (req, res) => {
  const g = gifts.get(req.params.id);
  if (!g) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/jpeg').send(g.buf);
});

// ---------- 관리자 백업/복원 API (헤더 x-admin-key로 인증) ----------
function adminAuth(req, res, next) {
  let key = '';
  try { key = decodeURIComponent(String(req.get('x-admin-key') || '')); } catch { /* 잘못된 값 */ }
  const auth = verifyAdmin(ipFrom(req.headers, req.socket.remoteAddress), key);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  res.set('Cache-Control', 'no-store');
  next();
}

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};
const koTime = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
// 윈도우 메모장에서도 한글이 안 깨지도록 BOM + CRLF 사용
const BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);
const TAB = String.fromCharCode(9);
const toCrlf = (s) => s.split(String.fromCharCode(10)).join(CRLF);

// 전체 백업: 다른 서버에도 그대로 복원할 수 있는 JSON (사진 포함)
app.get('/admin/api/backup', adminAuth, (_req, res) => {
  const backup = {
    app: 'hbd-party',
    version: 1,
    exportedAt: Date.now(),
    ...partyConfig(),
    bannedWords: filter.words,
    guestbook,
    gifts: [...gifts.values()].map((g) => ({ ...g.meta, img: g.buf.toString('base64') })),
  };
  res.set('Content-Disposition', `attachment; filename="hbd-backup-${stamp(Date.now())}.json"`);
  res.type('application/json').send(JSON.stringify(backup));
});

// 추억 보관용: 사진(JPG)과 방명록(TXT)을 묶은 ZIP. 압축 프로그램마다 한글 파일 이름이 깨질 수 있어 이름은 영문/숫자만 사용
app.get('/admin/api/keepsake', adminAuth, (_req, res) => {
  const files = [];
  const photoLines = [];
  [...gifts.values()]
    .map((g) => g.meta)
    .sort((a, b) => a.ts - b.ts)
    .forEach((m, i) => {
      const file = `${String(i + 1).padStart(2, '0')}-${stamp(m.ts)}.jpg`;
      files.push({ name: `photos/${file}`, data: gifts.get(m.id).buf });
      photoLines.push([file, `${m.name}님의 선물`, koTime(m.ts)].join(TAB));
    });
  if (photoLines.length) {
    files.push({ name: 'photos/list.txt', data: Buffer.from(BOM + photoLines.join(CRLF) + CRLF, 'utf8') });
  }
  const entries = [...guestbook]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => `[${koTime(e.ts)}] ${e.name}${CRLF}${toCrlf(e.text)}${CRLF}`);
  const header = `🎉 ${partyTitle()} 방명록 (${guestbook.length}개)${CRLF}${CRLF}`;
  files.push({ name: 'guestbook.txt', data: Buffer.from(BOM + header + entries.join(CRLF), 'utf8') });
  res.set('Content-Disposition', `attachment; filename="hbd-keepsake-${stamp(Date.now())}.zip"`);
  res.type('application/zip').send(makeZip(files));
});

// 복원: 백업 JSON을 지금 데이터에 합침 (이미 있는 글/선물은 건너뜀). 주인공 이름·금지어는 백업 값으로 바뀜
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const MAX_TS = 8.64e15;
app.post('/admin/api/restore', adminAuth, express.json({ limit: '60mb' }), async (req, res) => {
  const b = req.body;
  if (!b || b.app !== 'hbd-party' || !Array.isArray(b.guestbook) || !Array.isArray(b.gifts)) {
    return res.status(400).json({ ok: false, error: '파티 백업 파일이 아니에요.' });
  }
  const result = { guestbook: 0, gifts: 0, skippedGifts: 0 };
  try {
    // 방명록
    const have = new Set(guestbook.map((e) => e.id));
    for (const e of b.guestbook) {
      if (!e || !isId(e.id) || have.has(e.id)) continue;
      const text = cleanMultiline(e.text, 300);
      if (!text) continue;
      guestbook.push({
        id: e.id,
        name: cleanText(e.name, 12) || '손님',
        hue: Math.round(num(e.hue, 0, 359, 0)),
        text,
        ts: num(e.ts, 0, MAX_TS, Date.now()),
      });
      have.add(e.id);
      result.guestbook += 1;
    }
    guestbook.sort((x, y) => y.ts - x.ts);
    if (guestbook.length > GUESTBOOK_LIMIT) guestbook.length = GUESTBOOK_LIMIT;
    if (result.guestbook) await store.replaceGuestbook(guestbook);

    // 선물
    const incoming = b.gifts
      .filter((g) => g && isId(g.id) && !gifts.has(g.id))
      .sort((x, y) => num(x.ts, 0, MAX_TS, 0) - num(y.ts, 0, MAX_TS, 0));
    for (const g of incoming) {
      const buf = typeof g.img === 'string' ? Buffer.from(g.img, 'base64') : null;
      if (!buf || buf.length < 100 || buf.length > MAX_GIFT_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) continue;
      if (gifts.size >= MAX_GIFTS) { result.skippedGifts += 1; continue; }
      const meta = {
        id: g.id,
        name: cleanText(g.name, 12) || '손님',
        hue: Math.round(num(g.hue, 0, 359, 0)),
        x: Math.round(num(g.x, 0, WORLD.w, WORLD.spawn.x)),
        y: Math.round(num(g.y, WORLD.wallH + 20, WORLD.h - 8, WORLD.spawn.y)),
        c: isColor(g.c) ? g.c : GIFT_COLORS[0][0],
        r: isColor(g.r) ? g.r : GIFT_COLORS[0][1],
        ts: num(g.ts, 0, MAX_TS, Date.now()),
      };
      await store.addGift({ ...meta, img: buf.toString('base64') });
      gifts.set(meta.id, { meta, buf });
      result.gifts += 1;
    }

    // 설정
    const name = cleanText(b.birthdayName, 20);
    if (name) {
      await store.setSetting('birthdayName', name);
      birthdayName = name;
    }
    const type = cleanText(b.partyType, 10);
    if (type) {
      await store.setSetting('partyType', type);
      partyType = type;
    }
    const banner = cleanText(b.bannerText, 24);
    if (banner) {
      await store.setSetting('bannerText', banner);
      bannerText = banner;
    }
    if (Array.isArray(b.bannedWords)) {
      filter.set(b.bannedWords.map(String));
      await store.setSetting('bannedWords', JSON.stringify(filter.words));
    }
  } catch (err) {
    console.error('[restore] 실패:', err.message);
    return res.status(500).json({ ok: false, error: `복원 중 오류가 났어요: ${err.message}`, result });
  }

  io.emit('config', partyConfig());
  io.emit('guestbook:all', guestbook);
  io.emit('gifts:all', giftList());
  io.to('admins').emit('admin:bannedWords', filter.words);
  console.log(`[restore] 방명록 ${result.guestbook}개, 선물 ${result.gifts}개 복원 (자리 부족으로 건너뛴 선물 ${result.skippedGifts}개)`);
  res.json({ ok: true, result });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1_200_000 });

const players = new Map();
const filter = createFilter(); // 저장된 금지어가 있으면 시작할 때 덮어씀
const store = createGuestbookStore({ limit: GUESTBOOK_LIMIT });
let guestbook = []; // 최신 글이 앞

const publicPlayer = (p) => ({ id: p.id, name: p.name, hue: p.hue, x: p.x, y: p.y, dx: p.dx, dy: p.dy, m: p.m });

const giftList = () => [...gifts.values()].map((g) => g.meta);

// 플레이어 발밑 근처에서 비어 있는 자리 찾기
function giftSpot(px, py) {
  const free = (x, y) =>
    !WORLD.collides(x, y) &&
    [...gifts.values()].every((g) => Math.hypot(g.meta.x - x, g.meta.y - y) > 46);
  if (free(px, py + 34)) return { x: Math.round(px), y: Math.round(py + 34) };
  for (let r = 40; r <= 320; r += 30) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + r;
      const x = px + Math.cos(a) * r;
      const y = py + 30 + Math.sin(a) * r * 0.7;
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
}

function spawnPoint() {
  for (let i = 0; i < 40; i++) {
    const x = WORLD.spawn.x + (Math.random() - 0.5) * 300;
    const y = WORLD.spawn.y + (Math.random() - 0.5) * 90;
    if (!WORLD.collides(x, y)) return { x: Math.round(x), y: Math.round(y) };
  }
  return { ...WORLD.spawn };
}

io.on('connection', (socket) => {
  socket.emit('hello', { ...partyConfig(), online: players.size, gifts: giftList() });

  let player = null;
  let isAdmin = false;
  const last = { chat: 0, firework: 0, guestbook: 0, gift: 0 };

  socket.on('admin:login', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const auth = verifyAdmin(clientIp(socket), d && d.key);
    if (!auth.ok) return reply({ ok: false, error: auth.error });
    isAdmin = true;
    socket.join('admins');
    // Upstash 화면에서 직접 고친 내용이 있을 수 있으니 저장소에서 다시 읽어 모두에게 동기화
    try {
      guestbook = (await store.load()).slice(0, GUESTBOOK_LIMIT);
      io.emit('guestbook:all', guestbook);
    } catch (err) {
      console.error('[guestbook] 다시 불러오기 실패:', err.message);
    }
    reply({ ok: true, guestbook, ...partyConfig(), gifts: giftList(), bannedWords: filter.words });
  });

  // 파티 설정 (주인공 이름, 파티 종류, 플랜카드 문구)
  socket.on('admin:setParty', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdmin) return reply({ ok: false, error: '관리자만 바꿀 수 있어요.' });
    const name = cleanText(d && d.name, 20);
    const type = cleanText(d && d.partyType, 10);
    const banner = cleanText(d && d.bannerText, 24);
    if (!name) return reply({ ok: false, error: '주인공 이름을 입력해 주세요.' });
    if (!type) return reply({ ok: false, error: '파티 종류를 입력해 주세요.' });
    if (!banner) return reply({ ok: false, error: '플랜카드 문구를 입력해 주세요.' });
    try {
      await store.setSetting('birthdayName', name);
      await store.setSetting('partyType', type);
      await store.setSetting('bannerText', banner);
    } catch (err) {
      console.error('[settings] 저장 실패:', err.message);
      return reply({ ok: false, error: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    birthdayName = name;
    partyType = type;
    bannerText = banner;
    io.emit('config', partyConfig());
    console.log(`[settings] 파티 설정 변경: ${partyTitle()} / 플랜카드 "${bannerText}"`);
    reply({ ok: true, ...partyConfig() });
  });

  // 새 파티 시작: 방명록·선물 전부 삭제 (파티 설정·금지어는 유지)
  // 실수 방지를 위해 로그인 상태여도 비밀번호를 한 번 더 확인 (틀리면 로그인 실패 횟수에 포함)
  socket.on('admin:reset', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdmin) return reply({ ok: false, error: '관리자만 초기화할 수 있어요.' });
    const auth = verifyAdmin(clientIp(socket), d && d.key);
    if (!auth.ok) return reply({ ok: false, error: auth.error });

    const removed = { guestbook: guestbook.length, gifts: gifts.size };
    try {
      await store.replaceGuestbook([]);
      for (const id of [...gifts.keys()]) {
        await store.removeGift(id);
        gifts.delete(id);
      }
    } catch (err) {
      console.error('[reset] 실패:', err.message);
      // 일부만 지워졌을 수 있으니 저장소 기준으로 다시 맞춤
      try { guestbook = (await store.load()).slice(0, GUESTBOOK_LIMIT); } catch { /* 무시 */ }
      io.emit('guestbook:all', guestbook);
      io.emit('gifts:all', giftList());
      return reply({ ok: false, error: `초기화 중 오류가 났어요: ${err.message}` });
    }
    guestbook = [];
    io.emit('guestbook:all', guestbook);
    io.emit('gifts:all', giftList());
    console.log(`[reset] 새 파티 시작: 방명록 ${removed.guestbook}개, 선물 ${removed.gifts}개 삭제`);
    reply({ ok: true, removed });
  });

  socket.on('admin:logout', () => {
    isAdmin = false;
    socket.leave('admins');
  });

  // 금지어 추가/삭제: words는 문자열 배열(쉼표로 여러 개 입력 가능)
  socket.on('admin:banned', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdmin) return reply({ ok: false, error: '관리자만 바꿀 수 있어요.' });
    const words = (Array.isArray(d && d.words) ? d.words : []).slice(0, 50).map((w) => normalizeWord(String(w).slice(0, 40)));
    let next = filter.words;
    if (d && d.action === 'add') next = next.concat(words.filter(Boolean));
    else if (d && d.action === 'remove') next = next.filter((w) => !words.includes(w));
    else return reply({ ok: false, error: '잘못된 요청이에요.' });
    const before = filter.words;
    filter.set(next);
    try {
      await store.setSetting('bannedWords', JSON.stringify(filter.words));
    } catch (err) {
      filter.set(before);
      console.error('[filter] 저장 실패:', err.message);
      return reply({ ok: false, error: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    io.to('admins').emit('admin:bannedWords', filter.words);
    reply({ ok: true, bannedWords: filter.words });
  });

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

  socket.on('gift:delete', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdmin) return reply({ ok: false, error: '관리자만 삭제할 수 있어요.' });
    const id = String((d && d.id) || '');
    try {
      await store.removeGift(id);
    } catch (err) {
      console.error('[gift] 삭제 실패:', err.message);
      return reply({ ok: false, error: '저장소에서 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    gifts.delete(id);
    io.emit('gift:removed', id);
    console.log(`[gift] 관리자 삭제: ${id}`);
    reply({ ok: true });
  });

  socket.on('gift:drop', async (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!player) return reply({ ok: false, error: '먼저 파티에 참가해 주세요.' });
    const now = Date.now();
    if (now - last.gift < 15000) return reply({ ok: false, error: '선물은 15초에 한 번만 놓을 수 있어요.' });
    const buf = d && d.image;
    if (!Buffer.isBuffer(buf) || buf.length < 100) return reply({ ok: false, error: '사진을 읽지 못했어요.' });
    if (buf.length > MAX_GIFT_BYTES) return reply({ ok: false, error: '사진이 너무 커요.' });
    // 브라우저에서 JPEG로 다시 만들어 보내므로 JPEG만 받음
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return reply({ ok: false, error: '지원하지 않는 사진 형식이에요.' });
    if (gifts.size >= MAX_GIFTS) return reply({ ok: false, error: `선물상자가 꽉 찼어요 (최대 ${MAX_GIFTS}개).` });
    const spot = giftSpot(player.x, player.y);
    if (!spot) return reply({ ok: false, error: '근처에 선물을 놓을 자리가 없어요. 조금 이동해 보세요.' });
    last.gift = now;

    const [c, r] = GIFT_COLORS[crypto.randomInt(GIFT_COLORS.length)];
    const meta = { id: crypto.randomUUID(), name: player.name, hue: player.hue, x: spot.x, y: spot.y, c, r, ts: now };
    try {
      await store.addGift({ ...meta, img: buf.toString('base64') });
    } catch (err) {
      console.error('[gift] 저장 실패:', err.message);
      return reply({ ok: false, error: '선물을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    gifts.set(meta.id, { meta, buf });
    io.emit('gift:new', { ...meta, by: socket.id });
    console.log(`[gift] ${player.name}님이 선물 놓음 (${Math.round(buf.length / 1024)}KB)`);
    reply({ ok: true });
  });

  socket.on('join', (data) => {
    if (player) return;
    const d = data && typeof data === 'object' ? data : {};
    if (players.size >= MAX_PLAYERS) return socket.emit('full', { max: MAX_PLAYERS });

    const name = cleanText(d.name, 12) || `손님${Math.floor(Math.random() * 900 + 100)}`;
    if (filter.has(name)) return socket.emit('joinRejected', { error: '이름에 사용할 수 없는 단어가 들어 있어요.' });
    const hue = Math.round(num(d.hue, 0, 359, Math.random() * 360));
    let pos = spawnPoint();
    const x = num(d.x, 0, WORLD.w, NaN);
    const y = num(d.y, 0, WORLD.h, NaN);
    if (Number.isFinite(x) && Number.isFinite(y) && !WORLD.collides(x, y)) pos = { x, y };

    player = { id: socket.id, name, hue, x: pos.x, y: pos.y, dx: 0, dy: 1, m: 0 };
    players.set(socket.id, player);

    socket.emit('welcome', {
      id: socket.id,
      ...partyConfig(),
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
    const text = filter.mask(cleanText(d && d.text, 60));
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
    const text = filter.mask(cleanMultiline(d && d.text, 300));
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
    for (const g of await store.loadGifts()) {
      if (!g || !g.id || !g.img) continue;
      const { img, ...meta } = g;
      gifts.set(meta.id, { meta, buf: Buffer.from(img, 'base64') });
    }
    console.log(`[gift] 선물 ${gifts.size}개 불러옴`);
  } catch (err) {
    console.error('[gift] 불러오기 실패:', err.message);
  }
  try {
    const saved = await store.getSetting('bannedWords');
    if (saved) filter.set(JSON.parse(saved));
    console.log(`[filter] 금지어 ${filter.words.length}개`);
  } catch (err) {
    console.error('[filter] 불러오기 실패:', err.message);
  }
  try {
    birthdayName = cleanText(await store.getSetting('birthdayName'), 20) || birthdayName;
    partyType = cleanText(await store.getSetting('partyType'), 10) || partyType;
    bannerText = cleanText(await store.getSetting('bannerText'), 24) || bannerText;
  } catch (err) {
    console.error('[settings] 불러오기 실패:', err.message);
  }
  server.listen(PORT, () => console.log(`🎉 파티 서버: http://localhost:${PORT}  (${partyTitle()})`));
})();

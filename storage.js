'use strict';
// 저장소 (방명록·선물·설정)
// - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 이 있으면 Upstash Redis(무료)에 영구 저장
// - 없으면 data/ 폴더의 파일에 저장 (무료 호스팅에서는 재시작 시 사라질 수 있음)
// - DATA_PREFIX(기본 hbd)로 키 이름 앞부분을 바꾸면, Upstash 하나를 여러 서버가 데이터 섞이지 않게 나눠 쓸 수 있음
const fs = require('fs');
const path = require('path');

function dataPrefix() {
  const p = String(process.env.DATA_PREFIX || 'hbd').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return p || 'hbd';
}

function upstashStore(url, token, limit, prefix) {
  const KEY = `${prefix}:guestbook`;
  const GIFTS_KEY = `${prefix}:gifts`;
  const giftKey = (id) => `${prefix}:gift:${id}`;
  const settingKey = (name) => `${prefix}:setting:${name}`;

  async function cmd(args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status} ${await res.text()}`);
    return (await res.json()).result;
  }
  return {
    name: `Upstash Redis(${prefix})`,
    async load() {
      const rows = (await cmd(['LRANGE', KEY, '0', String(limit - 1)])) || [];
      return rows
        .map((row) => {
          try { return JSON.parse(row); } catch { return null; }
        })
        .filter(Boolean);
    },
    async add(entry) {
      await cmd(['LPUSH', KEY, JSON.stringify(entry)]);
      await cmd(['LTRIM', KEY, '0', String(limit - 1)]);
    },
    // 저장된 원본 문자열을 id로 찾아서 지움
    async remove(id) {
      const rows = (await cmd(['LRANGE', KEY, '0', '-1'])) || [];
      for (const row of rows) {
        let parsed = null;
        try { parsed = JSON.parse(row); } catch { /* 무시 */ }
        if (parsed && parsed.id === id) await cmd(['LREM', KEY, '0', row]);
      }
    },
    // 방명록 전체를 통째로 바꿈 (복원용). all은 최신 글이 앞
    async replaceGuestbook(all) {
      await cmd(['DEL', KEY]);
      for (let i = 0; i < all.length; i += 50) {
        await cmd(['RPUSH', KEY, ...all.slice(i, i + 50).map((e) => JSON.stringify(e))]);
      }
    },
    async getSetting(name) {
      return cmd(['GET', settingKey(name)]);
    },
    async setSetting(name, value) {
      await cmd(['SET', settingKey(name), String(value)]);
    },
    // 선물: 목록(<prefix>:gifts)에는 id만, 본문은 <prefix>:gift:<id>에 { ...정보, img: base64 }
    async loadGifts() {
      const ids = (await cmd(['LRANGE', GIFTS_KEY, '0', '-1'])) || [];
      const gifts = [];
      for (const id of ids) {
        const raw = await cmd(['GET', giftKey(id)]);
        try { if (raw) gifts.push(JSON.parse(raw)); } catch { /* 무시 */ }
      }
      return gifts;
    },
    async addGift(gift) {
      await cmd(['SET', giftKey(gift.id), JSON.stringify(gift)]);
      await cmd(['RPUSH', GIFTS_KEY, gift.id]);
    },
    async removeGift(id) {
      await cmd(['DEL', giftKey(id)]);
      await cmd(['LREM', GIFTS_KEY, '0', id]);
    },
  };
}

function fileStore(file) {
  const settingsFile = path.join(path.dirname(file), 'settings.json');
  const giftDir = path.join(path.dirname(file), 'gifts');
  const giftFile = (id) => path.join(giftDir, `${String(id).replace(/[^\w-]/g, '')}.json`);
  const readSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch { return {}; }
  };
  const writeGuestbook = (all) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all));
  };
  return {
    name: `파일(${path.relative(process.cwd(), file)})`,
    async load() {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    },
    async add(_entry, all) { writeGuestbook(all); },
    async remove(_id, all) { writeGuestbook(all); },
    async replaceGuestbook(all) { writeGuestbook(all); },
    async getSetting(name) {
      const v = readSettings()[name];
      return v == null ? null : String(v);
    },
    async setSetting(name, value) {
      const all = readSettings();
      all[name] = String(value);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(all));
    },
    async loadGifts() {
      let names = [];
      try { names = fs.readdirSync(giftDir).filter((n) => n.endsWith('.json')); } catch { return []; }
      const gifts = [];
      for (const n of names) {
        try { gifts.push(JSON.parse(fs.readFileSync(path.join(giftDir, n), 'utf8'))); } catch { /* 무시 */ }
      }
      return gifts.sort((a, b) => a.ts - b.ts);
    },
    async addGift(gift) {
      fs.mkdirSync(giftDir, { recursive: true });
      fs.writeFileSync(giftFile(gift.id), JSON.stringify(gift));
    },
    async removeGift(id) {
      try { fs.unlinkSync(giftFile(id)); } catch { /* 이미 없음 */ }
    },
  };
}

function createGuestbookStore({ limit }) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prefix = dataPrefix();
  if (url && token) return upstashStore(url.replace(/\/+$/, ''), token, limit, prefix);
  const defaultFile = prefix === 'hbd'
    ? path.join(__dirname, 'data', 'guestbook.json')
    : path.join(__dirname, 'data', prefix, 'guestbook.json');
  return fileStore(process.env.GUESTBOOK_FILE || defaultFile);
}

module.exports = { createGuestbookStore };

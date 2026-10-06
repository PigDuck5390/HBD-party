'use strict';
// 방명록 저장소
// - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 이 있으면 Upstash Redis(무료)에 영구 저장
// - 없으면 data/guestbook.json 파일에 저장 (무료 호스팅에서는 재시작 시 사라질 수 있음)
const fs = require('fs');
const path = require('path');

const KEY = 'hbd:guestbook';

function upstashStore(url, token, limit) {
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
    name: 'Upstash Redis',
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
  };
}

function fileStore(file) {
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
    async add(_entry, all) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
    },
  };
}

function createGuestbookStore({ limit }) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashStore(url.replace(/\/+$/, ''), token, limit);
  return fileStore(process.env.GUESTBOOK_FILE || path.join(__dirname, 'data', 'guestbook.json'));
}

module.exports = { createGuestbookStore };

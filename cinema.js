'use strict';
// 파티 시네마: 유튜브 영상 대기열과 재생 동기화
// - 서버는 "지금 영상이 언제 시작됐는지(startedAt)"만 기억하고, 각 브라우저가 그 시간에 맞춰 재생함
// - YOUTUBE_API_KEY가 있으면 검색 가능, 없으면 링크 붙여넣기만 가능
const crypto = require('crypto');

const QUEUE_MAX = 20;
const PER_USER_MAX = 3;
const LEAD_MS = 1500; // 다들 불러올 시간을 조금 줌
const SEARCH_CACHE_MS = 6 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// 유튜브 링크에서 영상 ID와 시작 시간(초) 꺼내기
function parseYouTube(input) {
  const text = String(input || '').trim();
  if (ID_RE.test(text)) return { id: text, start: 0 };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      if (m) id = m[2];
    }
  }
  if (!id || !ID_RE.test(id)) return null;
  // t=90, t=1m30s, start=90
  const t = url.searchParams.get('t') || url.searchParams.get('start') || '';
  let start = 0;
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  if (t && hms) start = (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  return { id, start: Math.min(start, 12 * 3600) };
}

// ISO 8601 길이(PT1H2M3S) → 초. 라이브 등 길이를 모르면 null
function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s || ''));
  if (!m) return null;
  const sec = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  return sec > 0 ? sec : null;
}

function createCinema({ io, filter, cleanText }) {
  const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim();
  console.log(`[cinema] 유튜브 검색 ${apiKey ? '켜짐' : '꺼짐 (YOUTUBE_API_KEY 없음 → 링크 붙여넣기만 가능)'}`);
  const tv = { current: null, queue: [], locked: false };
  let timer = null;
  const searchCache = new Map(); // 검색어 -> { at, results }
  const meta = new Map(); // 영상 ID -> { title, channel, duration } (검색 결과에서 얻은 정보 재사용)
  let quotaBlockedUntil = 0;

  const fetchJson = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };

  // YouTube Data API 오류 구분: 한도 초과면 1시간 쉬고, 키 설정 문제면 이유를 서버 로그에 남김
  const QUOTA_REASONS = ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'];
  function apiFailure(where, status, body) {
    const err = (body && body.error) || {};
    const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || '';
    console.error(`[cinema] YouTube API ${where} 실패: ${status} ${reason} - ${err.message || ''}`);
    if (QUOTA_REASONS.includes(reason)) {
      quotaBlockedUntil = Date.now() + 60 * 60 * 1000;
      return '오늘 검색 한도를 다 썼어요. 유튜브 링크를 붙여 넣어 주세요.';
    }
    if (status === 400 || status === 403) {
      return '검색 설정(API 키)에 문제가 있어요. 링크를 붙여 넣어 주세요. (관리자: Render 로그 확인)';
    }
    return '검색에 실패했어요. 잠시 후 다시 시도해 주세요.';
  }

  const publicItem = (it) => it && {
    uid: it.uid, id: it.id, title: it.title, channel: it.channel, duration: it.duration,
    by: it.by, hue: it.hue, startedAt: it.startedAt,
  };
  const state = () => ({
    current: publicItem(tv.current),
    queue: tv.queue.map(publicItem),
    locked: tv.locked,
    searchEnabled: !!apiKey,
    serverNow: Date.now(),
  });
  const broadcast = () => io.emit('tv:state', state());
  const notice = (text) => io.emit('tv:notice', text);
  const elapsed = () => (tv.current ? (Date.now() - tv.current.startedAt) / 1000 : 0);

  function playNext() {
    clearTimeout(timer);
    timer = null;
    tv.current = tv.queue.shift() || null;
    if (tv.current) {
      const start = tv.current.start || 0;
      tv.current.startedAt = Date.now() + LEAD_MS - start * 1000;
      // 길이를 알면 끝날 때 서버가 다음 영상으로 넘김 (모르면 브라우저가 "끝났어요"를 알려줌)
      if (tv.current.duration) {
        const remain = Math.max(5, tv.current.duration - start);
        timer = setTimeout(playNext, remain * 1000 + LEAD_MS + 3000);
      }
    }
    broadcast();
  }

  // 영상 정보 가져오기: API 키가 있으면 Data API, 없으면 oEmbed(키 불필요)
  async function lookup(id) {
    if (meta.has(id)) return { ok: true, ...meta.get(id) };
    if (apiKey && Date.now() > quotaBlockedUntil) {
      try {
        const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${encodeURIComponent(apiKey)}`;
        const { status, body } = await fetchJson(u);
        if (status === 200) {
          const v = body.items && body.items[0];
          if (!v) return { ok: false, error: '영상을 찾을 수 없어요.' };
          if (v.status && v.status.embeddable === false) return { ok: false, error: '이 영상은 다른 사이트에서 재생할 수 없게 막혀 있어요.' };
          const info = { title: v.snippet.title, channel: v.snippet.channelTitle, duration: isoDuration(v.contentDetails.duration) };
          meta.set(id, info);
          return { ok: true, ...info };
        }
        apiFailure('영상 정보', status, body);
      } catch { /* 아래 oEmbed로 */ }
    }
    try {
      const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
      const { status, body } = await fetchJson(u);
      if (status === 401 || status === 403) return { ok: false, error: '이 영상은 다른 사이트에서 재생할 수 없게 막혀 있어요.' };
      if (status === 404 || status === 400) return { ok: false, error: '영상을 찾을 수 없어요. 링크를 확인해 주세요.' };
      if (status === 200) return { ok: true, title: body.title, channel: body.author_name, duration: null };
    } catch { /* 정보 없이 진행 */ }
    return { ok: true, title: '유튜브 영상', channel: '', duration: null };
  }

  async function search(q) {
    if (!apiKey) return { ok: false, error: '검색 기능이 꺼져 있어요. 유튜브 링크를 붙여 넣어 주세요.' };
    const key = q.toLowerCase();
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return { ok: true, results: cached.results };
    if (Date.now() < quotaBlockedUntil) return { ok: false, error: '오늘 검색 한도를 다 썼어요. 유튜브 링크를 붙여 넣어 주세요.' };
    try {
      const su = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&safeSearch=moderate&regionCode=KR&relevanceLanguage=ko&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`;
      const s = await fetchJson(su);
      if (s.status !== 200) return { ok: false, error: apiFailure('검색', s.status, s.body) };
      const ids = (s.body.items || []).map((it) => it.id && it.id.videoId).filter((id) => ID_RE.test(id || ''));
      let durations = {};
      if (ids.length) {
        const vu = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`;
        const v = await fetchJson(vu);
        if (v.status === 200) for (const it of v.body.items || []) durations[it.id] = isoDuration(it.contentDetails.duration);
      }
      const results = (s.body.items || [])
        .filter((it) => it.id && ID_RE.test(it.id.videoId || ''))
        .map((it) => ({
          id: it.id.videoId,
          title: filter.mask(decodeEntities(it.snippet.title)),
          channel: decodeEntities(it.snippet.channelTitle),
          duration: durations[it.id.videoId] || null,
        }));
      for (const r of results) meta.set(r.id, { title: r.title, channel: r.channel, duration: r.duration });
      if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(key, { at: Date.now(), results });
      return { ok: true, results };
    } catch {
      return { ok: false, error: '검색에 실패했어요. 잠시 후 다시 시도해 주세요.' };
    }
  }

  // 소켓 하나에 시네마 이벤트 연결. who()는 { player, isAdmin }을 돌려줌
  function attach(socket, who) {
    const last = { add: 0, search: 0, report: 0 };

    socket.on('tv:search', async (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { player, isAdmin } = who();
      if (!player && !isAdmin) return reply({ ok: false, error: '먼저 파티에 참가해 주세요.' });
      const now = Date.now();
      if (now - last.search < 2500) return reply({ ok: false, error: '조금만 천천히 검색해 주세요.' });
      const q = cleanText(d && d.q, 60);
      if (!q) return reply({ ok: false, error: '검색어를 입력해 주세요.' });
      if (filter.has(q)) return reply({ ok: false, error: '검색할 수 없는 단어가 들어 있어요.' });
      last.search = now;
      reply(await search(q));
    });

    socket.on('tv:add', async (d, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { player, isAdmin } = who();
      if (!player && !isAdmin) return reply({ ok: false, error: '먼저 파티에 참가해 주세요.' });
      if (tv.locked && !isAdmin) return reply({ ok: false, error: '지금은 관리자만 영상을 틀 수 있어요.' });
      const now = Date.now();
      if (!isAdmin && now - last.add < 4000) return reply({ ok: false, error: '조금만 기다렸다가 신청해 주세요.' });
      const parsed = d && d.videoId ? (ID_RE.test(String(d.videoId)) ? { id: String(d.videoId), start: 0 } : null) : parseYouTube(d && d.url);
      if (!parsed) return reply({ ok: false, error: '유튜브 링크를 알아볼 수 없어요.' });
      const sid = socket.id;
      if (!isAdmin) {
        const mine = tv.queue.filter((it) => it.sid === sid).length;
        if (mine >= PER_USER_MAX) return reply({ ok: false, error: `대기열에는 한 사람당 ${PER_USER_MAX}개까지 넣을 수 있어요.` });
      }
      if (tv.queue.length >= QUEUE_MAX) return reply({ ok: false, error: '대기열이 꽉 찼어요. 조금 뒤에 신청해 주세요.' });
      last.add = now;
      const info = await lookup(parsed.id);
      if (!info.ok) return reply(info);
      const item = {
        uid: crypto.randomUUID(),
        id: parsed.id,
        start: parsed.start,
        title: filter.mask(cleanText(info.title, 100) || '유튜브 영상'),
        channel: cleanText(info.channel, 60),
        duration: info.duration,
        by: player ? player.name : '관리자',
        hue: player ? player.hue : 330,
        sid,
        startedAt: 0,
      };
      tv.queue.push(item);
      if (!tv.current) playNext();
      else broadcast();
      notice(`🎬 ${item.by}님이 "${item.title}"을(를) 신청했어요`);
      reply({ ok: true, queued: tv.current && tv.current.uid !== item.uid });
    });

    // 브라우저가 알려주는 "영상 끝남" / "재생 불가" (길이를 모르는 영상, 퍼가기 금지 영상 처리용)
    socket.on('tv:ended', (d) => {
      const c = tv.current;
      if (!c || !d || d.uid !== c.uid) return;
      const minEl = c.duration ? c.duration - 8 : 10;
      if (elapsed() >= minEl) playNext();
    });
    socket.on('tv:error', (d) => {
      const c = tv.current;
      if (!c || !d || d.uid !== c.uid) return;
      const now = Date.now();
      if (now - last.report < 3000 || elapsed() > 40) return;
      last.report = now;
      notice(`⚠️ "${c.title}"은(는) 재생할 수 없는 영상이라 건너뛰었어요`);
      playNext();
    });
  }

  // 관리자 조작
  function admin(action, uid) {
    if (action === 'skip') playNext();
    else if (action === 'stop') {
      tv.queue = [];
      clearTimeout(timer);
      tv.current = null;
      broadcast();
    } else if (action === 'clear') {
      tv.queue = [];
      broadcast();
    } else if (action === 'remove') {
      tv.queue = tv.queue.filter((it) => it.uid !== uid);
      broadcast();
    } else if (action === 'lock' || action === 'unlock') {
      tv.locked = action === 'lock';
      broadcast();
      notice(tv.locked ? '🔒 이제 관리자만 영상을 틀 수 있어요' : '🔓 이제 누구나 영상을 신청할 수 있어요');
    } else return false;
    return true;
  }

  // 새 파티 시작(초기화) 때: 영상 끄고 대기열 비움 (잠금 설정은 유지)
  function reset() {
    admin('stop');
  }

  return { state, attach, admin, reset };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

module.exports = { createCinema, parseYouTube, isoDuration };

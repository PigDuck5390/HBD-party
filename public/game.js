(() => {
  'use strict';

  const W = window.WORLD;
  const TAU = Math.PI * 2;
  const FONT = '"Jua", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const PALETTE = ['#ff6fa3', '#ffd166', '#7ad3f7', '#b39ddb', '#8bd3a5', '#ffb38a'];

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const socket = io();

  // ---------- 유틸 ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now() / 1000;
  const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function oval(c, x, y, rx, ry, fill) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, TAU);
    if (fill) { c.fillStyle = fill; c.fill(); }
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  };

  // ---------- 상태 ----------
  const players = new Map();
  let myId = null;
  let me = null;
  let joined = false;
  let birthdayName = '주인공';
  let myHue = Math.floor(Math.random() * 360);
  let nearLauncher = -1;
  let guestbook = [];
  let muted = store.get('hbd:muted') === '1';
  const fx = { rockets: [], particles: [], flashes: [], dim: 0 };
  const launcherKick = W.launchers.map(() => 0);

  function addPlayer(p) {
    const old = players.get(p.id);
    const obj = {
      id: p.id, name: p.name, hue: p.hue,
      x: p.x, y: p.y, tx: p.x, ty: p.y,
      dx: p.dx || 0, dy: p.dy == null ? 1 : p.dy,
      moving: !!p.m, walk: 0, seed: Math.random() * 10,
      bubble: old ? old.bubble : null, born: now(),
    };
    players.set(p.id, obj);
    return obj;
  }

  // ---------- 화면 크기 / 카메라 ----------
  let vw = 0, vh = 0, dpr = 1, scale = 1;
  const cam = { x: W.w / 2, y: W.h / 2 };
  function resize() {
    vw = Math.max(1, window.innerWidth);
    vh = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    const fit = Math.min(vw / W.w, vh / W.h);
    scale = Math.max(fit, Math.min(1, Math.min(vw, vh) / 620));
    updateCamera(0, true);
  }
  function updateCamera(dt, snap) {
    let tx = me ? me.x : W.w / 2;
    let ty = me ? me.y - 40 : W.h / 2;
    ty -= fx.dim * 220; // 폭죽이 터질 때는 하늘 쪽을 더 보여주기
    const hw = vw / scale / 2;
    const hh = vh / scale / 2;
    tx = W.w <= hw * 2 ? W.w / 2 : clamp(tx, hw, W.w - hw);
    ty = W.h <= hh * 2 ? W.h / 2 : clamp(ty, hh, W.h - hh);
    const k = snap ? 1 : Math.min(1, dt * 6);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
  }
  window.addEventListener('resize', resize);

  // ---------- 입력 ----------
  const keys = new Set();
  const dpadVec = { x: 0, y: 0 };
  const MOVE_KEYS = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'];
  const isTyping = () => {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  };
  const modalOpen = () => !$('gbModal').hidden;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeChat(); closeGuestbook(); return; }
    if (isTyping() || !joined || modalOpen()) return;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.includes(k)) { keys.add(k); e.preventDefault(); }
    else if (e.key === 'Enter') { openChat(); e.preventDefault(); }
    else if (k === ' ' || k === 'f') { tryFirework(); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  const dpad = $('dpad');
  const dirEls = {
    up: dpad.querySelector('.up'), down: dpad.querySelector('.down'),
    left: dpad.querySelector('.left'), right: dpad.querySelector('.right'),
  };
  let dpadPointer = null;
  function setDpad(x, y) {
    dpadVec.x = x;
    dpadVec.y = y;
    dirEls.left.classList.toggle('on', x < 0);
    dirEls.right.classList.toggle('on', x > 0);
    dirEls.up.classList.toggle('on', y < 0);
    dirEls.down.classList.toggle('on', y > 0);
  }
  function dpadFromEvent(e) {
    const r = dpad.getBoundingClientRect();
    const vx = e.clientX - (r.left + r.width / 2);
    const vy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(vx, vy);
    if (len < 12) return setDpad(0, 0);
    // 8방향: 축과 67.5° 이내면 해당 방향 포함
    const th = 0.38 * len;
    setDpad(vx > th ? 1 : vx < -th ? -1 : 0, vy > th ? 1 : vy < -th ? -1 : 0);
  }
  dpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dpadPointer = e.pointerId;
    try { dpad.setPointerCapture(e.pointerId); } catch { /* 일부 브라우저 */ }
    dpadFromEvent(e);
  });
  dpad.addEventListener('pointermove', (e) => { if (e.pointerId === dpadPointer) dpadFromEvent(e); });
  const dpadEnd = (e) => { if (e.pointerId === dpadPointer) { dpadPointer = null; setDpad(0, 0); } };
  dpad.addEventListener('pointerup', dpadEnd);
  dpad.addEventListener('pointercancel', dpadEnd);
  dpad.addEventListener('lostpointercapture', dpadEnd);
  dpad.addEventListener('contextmenu', (e) => e.preventDefault());

  function inputVec() {
    let x = dpadVec.x, y = dpadVec.y;
    if (!isTyping() && !modalOpen()) {
      if (keys.has('arrowleft') || keys.has('a')) x -= 1;
      if (keys.has('arrowright') || keys.has('d')) x += 1;
      if (keys.has('arrowup') || keys.has('w')) y -= 1;
      if (keys.has('arrowdown') || keys.has('s')) y += 1;
    }
    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  // ---------- 사운드 ----------
  let actx = null;
  let noiseBuf = null;
  function ensureAudio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  function sfx(kind, vol = 1) {
    if (!actx || muted || vol <= 0.02) return;
    const t0 = actx.currentTime;
    if (kind === 'launch') {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(420, t0);
      o.frequency.exponentialRampToValueAtTime(1500, t0 + 0.7);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.035 * vol, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);
      o.connect(g).connect(actx.destination);
      o.start(t0);
      o.stop(t0 + 0.8);
    } else {
      if (!noiseBuf) {
        noiseBuf = actx.createBuffer(1, Math.floor(actx.sampleRate * 1.2), actx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const s = actx.createBufferSource();
      s.buffer = noiseBuf;
      const f = actx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(1400, t0);
      f.frequency.exponentialRampToValueAtTime(180, t0 + 1);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.32 * vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
      s.connect(f).connect(g).connect(actx.destination);
      s.start(t0);
      s.stop(t0 + 1.2);
    }
  }
  // 내 캐릭터와 멀리 있는 폭죽은 작게
  const volumeAt = (x, y) => (me ? clamp(1.2 - Math.hypot(me.x - x, me.y - y) / 1000, 0.25, 1) : 0.6);

  // ---------- 정적 배경 데이터 ----------
  const confetti = (() => {
    const r = mulberry32(7);
    const arr = [];
    for (let i = 0; i < 170; i++) {
      arr.push({
        x: r() * W.w,
        y: W.wallH + 14 + r() * (W.h - W.wallH - 24),
        a: r() * Math.PI,
        c: PALETTE[Math.floor(r() * PALETTE.length)],
        w: 4 + r() * 5,
      });
    }
    return arr;
  })();

  const CAKE_TIERS = [
    { rx: 150, ry: 50, h: 80, side: '#ff9ebd', dark: '#e46f98', frost: '#fff6fa' },
    { rx: 108, ry: 36, h: 64, side: '#c9b8ff', dark: '#9f8ae6', frost: '#ffffff' },
    { rx: 68, ry: 23, h: 50, side: '#9fe3c5', dark: '#6cc39f', frost: '#fffdf6' },
  ];
  (() => {
    let base = W.cake.y - 4;
    CAKE_TIERS.forEach((tier, ti) => {
      tier.base = base;
      tier.top = base - tier.h;
      base = tier.top;
      const r = mulberry32(100 + ti);
      tier.sprinkles = [];
      for (let i = 0; i < 26; i++) {
        const u = (r() * 2 - 1) * 0.88;
        const v = 0.25 + r() * 0.6;
        if (ti === 0 && Math.abs(u) < 0.62) continue; // 이름 자리 비우기
        tier.sprinkles.push({ u, v, a: r() * Math.PI, c: PALETTE[Math.floor(r() * PALETTE.length)] });
      }
    });
  })();
  const CANDLES = [
    { u: 0, v: -0.6, c: '#ff8fab' },
    { u: -0.52, v: -0.3, c: '#7ad3f7' },
    { u: 0.52, v: -0.3, c: '#ffd166' },
    { u: -0.3, v: 0.35, c: '#b39ddb' },
    { u: 0.3, v: 0.35, c: '#8bd3a5' },
  ];

  // ---------- 그리기: 바닥 / 벽 ----------
  function drawFloor(t) {
    const tile = 60;
    for (let y = W.wallH, j = 0; y < W.h; y += tile, j++) {
      for (let x = 0, i = 0; x < W.w; x += tile, i++) {
        ctx.fillStyle = (i + j) % 2 ? '#fff3e6' : '#ffeedd';
        ctx.fillRect(x, y, tile + 0.5, tile + 0.5);
      }
    }
    // 러그
    const c = W.cake;
    oval(ctx, c.x, c.y + 40, 380, 205, '#ffe1ec');
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#ffb8d0';
    ctx.stroke();
    ctx.setLineDash([16, 12]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    oval(ctx, c.x, c.y + 40, 356, 186);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const p of confetti) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(-p.w / 2, -1.5, p.w, 3);
      ctx.restore();
    }

    // 폭죽 근처 표시
    W.launchers.forEach((L, i) => {
      const active = i === nearLauncher;
      ctx.save();
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = -t * 30;
      ctx.lineWidth = active ? 4 : 2;
      ctx.strokeStyle = active ? 'rgba(255,170,40,0.95)' : 'rgba(255,140,180,0.45)';
      oval(ctx, L.x, L.y, W.fireworkRange, W.fireworkRange * 0.42);
      ctx.stroke();
      if (active) {
        ctx.fillStyle = `rgba(255,210,90,${0.18 + Math.sin(t * 6) * 0.08})`;
        ctx.fill();
      }
      ctx.restore();
    });
  }

  function drawWall(t) {
    const h = W.wallH;
    ctx.fillStyle = '#ffc6d7';
    ctx.fillRect(0, 0, W.w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let x = 0; x < W.w; x += 44) ctx.fillRect(x, 0, 22, h);
    ctx.fillStyle = '#ec97b5';
    ctx.fillRect(0, h - 14, W.w, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(0, h - 14, W.w, 3);

    // 가랜드
    const swags = [[0, W.w / 2], [W.w / 2, W.w]];
    swags.forEach(([x0, x1], si) => {
      const yAt = (u) => 14 + 4 * 26 * u * (1 - u);
      ctx.strokeStyle = '#a0607e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const u = k / 30;
        const x = lerp(x0, x1, u);
        if (k === 0) ctx.moveTo(x, yAt(u)); else ctx.lineTo(x, yAt(u));
      }
      ctx.stroke();
      const n = 16;
      for (let k = 1; k < n; k++) {
        const u = k / n;
        const x = lerp(x0, x1, u);
        const y = yAt(u);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 1.8 + k + si * 3) * 0.08);
        ctx.beginPath();
        ctx.moveTo(-12, 0);
        ctx.lineTo(12, 0);
        ctx.lineTo(0, 24);
        ctx.closePath();
        ctx.fillStyle = PALETTE[(k + si * 2) % PALETTE.length];
        ctx.fill();
        ctx.restore();
      }
    });

    ctx.font = `50px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#e05a8a';
    ctx.strokeText('HAPPY BIRTHDAY', W.w / 2, 104);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('HAPPY BIRTHDAY', W.w / 2, 104);
  }

  // ---------- 그리기: 케이크 ----------
  function drawTier(tier, cx) {
    const { rx, ry, h, base, top } = tier;
    const g = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
    g.addColorStop(0, tier.dark);
    g.addColorStop(0.35, tier.side);
    g.addColorStop(0.62, tier.side);
    g.addColorStop(1, tier.dark);
    ctx.beginPath();
    ctx.moveTo(cx - rx, top);
    ctx.lineTo(cx - rx, base);
    ctx.ellipse(cx, base, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(cx + rx, top);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    for (const s of tier.sprinkles) {
      const x = cx + s.u * rx;
      const y = top + ry * Math.sqrt(1 - s.u * s.u) + s.v * h;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(s.a);
      ctx.fillStyle = s.c;
      rrect(ctx, -4, -1.5, 8, 3, 1.5);
      ctx.fill();
      ctx.restore();
    }

    // 아래 크림 장식
    const n = Math.round(rx / 8);
    for (let i = 0; i <= n; i++) {
      const a = (Math.PI * i) / n;
      oval(ctx, cx + Math.cos(a) * rx, base + Math.sin(a) * ry - 2, 6, 5.5, tier.frost);
    }

    // 윗면 + 흘러내린 크림
    ctx.beginPath();
    ctx.ellipse(cx, top + 3, rx, ry, 0, 0, Math.PI);
    ctx.lineWidth = 8;
    ctx.strokeStyle = tier.frost;
    ctx.stroke();
    const dn = Math.round(rx / 13);
    ctx.fillStyle = tier.frost;
    for (let i = 0; i < dn; i++) {
      const a = (Math.PI * (i + 0.5)) / dn;
      const px = cx + Math.cos(a) * rx;
      const py = top + Math.sin(a) * ry;
      const w = Math.max(6, ((2 * rx) / dn) * 0.7 * Math.sin(a));
      const len = 8 + ((i * 7 + rx) % 5) * 4.5;
      rrect(ctx, px - w / 2, py - 2, w, len, w / 2);
      ctx.fill();
    }
    oval(ctx, cx, top, rx, ry, tier.frost);
    ctx.strokeStyle = 'rgba(160,100,140,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawRing(tierA, tierB, cx, drawItem, count, front) {
    const rr = (tierA.rx + tierB.rx) / 2;
    const ry = (tierA.ry + tierB.ry) / 2;
    for (let i = 0; i < count; i++) {
      const a = (TAU * (i + 0.5)) / count;
      if ((Math.sin(a) > 0) !== front) continue;
      drawItem(cx + Math.cos(a) * rr, tierA.top + Math.sin(a) * ry);
    }
  }
  function strawberry(x, y) {
    oval(ctx, x, y - 1, 10, 5, '#ffffff');
    ctx.beginPath();
    ctx.moveTo(x - 8, y - 12);
    ctx.quadraticCurveTo(x - 9, y + 2, x, y + 3);
    ctx.quadraticCurveTo(x + 9, y + 2, x + 8, y - 12);
    ctx.quadraticCurveTo(x, y - 17, x - 8, y - 12);
    ctx.fillStyle = '#ff4d6d';
    ctx.fill();
    ctx.fillStyle = '#ffe9a8';
    for (const [sx, sy] of [[-3, -8], [3, -8], [0, -4], [-4, -2], [4, -2]]) oval(ctx, x + sx, y + sy, 0.9, 1.2, '#ffe9a8');
    ctx.fillStyle = '#3cb371';
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 13);
    ctx.lineTo(x, y - 17);
    ctx.lineTo(x + 7, y - 13);
    ctx.lineTo(x, y - 11);
    ctx.closePath();
    ctx.fill();
  }
  function dollop(x, y) {
    oval(ctx, x, y - 3, 9, 6, '#ffffff');
    oval(ctx, x, y - 8, 6, 4.5, '#ffffff');
    oval(ctx, x, y - 11, 2.5, 2.5, '#ff8fab');
  }

  function candlePos(i) {
    const top = CAKE_TIERS[2];
    const c = CANDLES[i];
    return { x: W.cake.x + c.u * top.rx, y: top.top + c.v * top.ry };
  }
  function drawCandleFlame(x, y, t, i, glow) {
    const fy = y - 34;
    const flick = 1 + 0.12 * Math.sin(t * 18 + i * 2) + 0.06 * Math.sin(t * 31 + i);
    const gr = ctx.createRadialGradient(x, fy - 4, 1, x, fy - 4, 26 * glow);
    gr.addColorStop(0, 'rgba(255,214,120,0.55)');
    gr.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(x - 30 * glow, fy - 34 * glow, 60 * glow, 60 * glow);
    const fh = 13 * flick;
    const sway = Math.sin(t * 7 + i) * 1.5;
    ctx.beginPath();
    ctx.moveTo(x + sway, fy - fh);
    ctx.quadraticCurveTo(x + 6, fy - 3, x, fy + 1);
    ctx.quadraticCurveTo(x - 6, fy - 3, x + sway, fy - fh);
    ctx.fillStyle = '#ffb703';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + sway * 0.6, fy - fh * 0.6);
    ctx.quadraticCurveTo(x + 3, fy - 2, x, fy);
    ctx.quadraticCurveTo(x - 3, fy - 2, x + sway * 0.6, fy - fh * 0.6);
    ctx.fillStyle = '#fff3b0';
    ctx.fill();
  }
  function drawCandles(t) {
    CANDLES.forEach((c, i) => {
      const { x, y } = candlePos(i);
      ctx.save();
      rrect(ctx, x - 3.5, y - 30, 7, 31, 2);
      ctx.fillStyle = c.c;
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 4 - k * 8);
        ctx.lineTo(x + 5, y - 10 - k * 8);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = '#4a3a44';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 30);
      ctx.lineTo(x, y - 34);
      ctx.stroke();
      drawCandleFlame(x, y, t, i, 1);
    });
  }

  function drawCake(t) {
    const cx = W.cake.x;
    const cy = W.cake.y;
    oval(ctx, cx + 8, cy + 14, 188, 62, 'rgba(90,30,70,0.15)');
    oval(ctx, cx, cy + 6, 178, 60, '#e4daee');
    oval(ctx, cx, cy, 178, 58, '#ffffff');
    ctx.strokeStyle = '#eadff2';
    ctx.lineWidth = 2;
    ctx.stroke();

    const [t0, t1, t2] = CAKE_TIERS;
    drawTier(t0, cx);
    // 이름
    ctx.font = `25px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#d9487a';
    const label = `♥ ${birthdayName} ♥`;
    ctx.strokeText(label, cx, t0.top + t0.ry + t0.h / 2 + 2, 200);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, cx, t0.top + t0.ry + t0.h / 2 + 2, 200);

    drawRing(t0, t1, cx, strawberry, 12, false);
    drawTier(t1, cx);
    drawRing(t0, t1, cx, strawberry, 12, true);
    drawRing(t1, t2, cx, dollop, 9, false);
    drawTier(t2, cx);
    drawRing(t1, t2, cx, dollop, 9, true);
    drawCandles(t);
  }

  // ---------- 그리기: 소품 ----------
  function drawLauncher(L, i, t) {
    const k = launcherKick[i];
    const { x, y } = L;
    const colA = i === 0 ? '#ff4d6d' : '#4d8bff';
    oval(ctx, x + 3, y + 2, 32, 11, 'rgba(90,30,70,0.18)');
    // 나무 받침
    ctx.fillStyle = '#9a6544';
    rrect(ctx, x - 28, y - 22, 56, 24, 5);
    ctx.fill();
    ctx.fillStyle = '#c18559';
    rrect(ctx, x - 28, y - 30, 56, 12, 5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x - 22, y - 12, 44, 3);

    // 통
    const th = 48 - k * 10;
    const tw = 15;
    const by = y - 24;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - tw, by - th);
    ctx.lineTo(x - tw, by);
    ctx.ellipse(x, by, tw, 5, 0, Math.PI, 0, true);
    ctx.lineTo(x + tw, by - th);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = colA;
    ctx.lineWidth = 6;
    for (let s = -2; s < 6; s++) {
      ctx.beginPath();
      ctx.moveTo(x - tw - 4, by - s * 12);
      ctx.lineTo(x + tw + 4, by - s * 12 - 12);
      ctx.stroke();
    }
    const sh = ctx.createLinearGradient(x - tw, 0, x + tw, 0);
    sh.addColorStop(0, 'rgba(0,0,0,0.18)');
    sh.addColorStop(0.4, 'rgba(255,255,255,0.15)');
    sh.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = sh;
    ctx.fillRect(x - tw, by - th - 6, tw * 2, th + 12);
    ctx.restore();
    oval(ctx, x, by - th, tw, 5, '#ffe066');
    oval(ctx, x, by - th, tw - 4, 3, '#3a2a44');

    // 별 장식
    ctx.fillStyle = '#ffe066';
    star(x, by - th / 2, 6, 2.6);

    // 심지 불꽃
    if (i === nearLauncher) {
      for (let s = 0; s < 3; s++) {
        const a = t * 9 + s * 2.1;
        oval(ctx, x + Math.cos(a) * 6, by - th - 8 + Math.sin(a * 1.3) * 4, 2, 2, '#ffd166');
      }
    }
  }
  function star(x, y, R, r) {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const rad = k % 2 ? r : R;
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawGift(g) {
    const s = 34;
    const { x, y } = g;
    oval(ctx, x + 3, y + 1, 24, 8, 'rgba(90,30,70,0.15)');
    ctx.fillStyle = g.c;
    ctx.fillRect(x - s / 2, y - s, s, s);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(x + s / 2 - 8, y - s, 8, s);
    ctx.fillStyle = g.c;
    ctx.fillRect(x - s / 2 - 2, y - s - 10, s + 4, 11);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x - s / 2 - 2, y - s - 10, s + 4, 11);
    ctx.fillStyle = g.r;
    ctx.fillRect(x - 4, y - s - 10, 8, s + 10);
    oval(ctx, x - 8, y - s - 14, 8, 5, g.r);
    oval(ctx, x + 8, y - s - 14, 8, 5, g.r);
    oval(ctx, x, y - s - 12, 4, 4, g.r);
  }

  function drawBalloons(b, t, bi) {
    const { x, y } = b;
    oval(ctx, x, y, 14, 5, 'rgba(90,30,70,0.15)');
    ctx.fillStyle = '#c9a0dc';
    rrect(ctx, x - 7, y - 10, 14, 10, 3);
    ctx.fill();
    for (let j = 0; j < 4; j++) {
      const color = PALETTE[(j + bi) % PALETTE.length];
      const bx = x + (j - 1.5) * 22 + Math.sin(t * 1.3 + j + bi) * 4;
      const by = y - 105 - (j % 2) * 28 + Math.sin(t * 1.7 + j * 2 + bi) * 4;
      ctx.strokeStyle = 'rgba(120,80,110,0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y - 10);
      ctx.quadraticCurveTo(lerp(x, bx, 0.3) + 8, lerp(y, by, 0.5), bx, by + 22);
      ctx.stroke();
      oval(ctx, bx, by, 17, 21, color);
      oval(ctx, bx - 6, by - 7, 4, 7, 'rgba(255,255,255,0.5)');
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(bx, by + 19);
      ctx.lineTo(bx - 4, by + 25);
      ctx.lineTo(bx + 4, by + 25);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---------- 그리기: 캐릭터 ----------
  function drawCharacter(c, x, y, hue, o) {
    const t = o.t || 0;
    const seed = o.seed || 0;
    const walk = o.walk || 0;
    const moving = !!o.moving;
    const dx = o.dx || 0;
    const dy = o.dy == null ? 1 : o.dy;
    const bob = moving ? Math.abs(Math.sin(walk)) * 5 : 0;
    const sq = moving ? Math.sin(walk * 2) * 0.05 : Math.sin(t * 2.4 + seed) * 0.03;

    c.save();
    c.translate(x, y);
    c.scale(o.scale || 1, o.scale || 1);

    oval(c, 0, 0, 17 - bob * 0.5, 6, 'rgba(70,30,70,0.18)');
    const f = moving ? Math.sin(walk) * 4 : 0;
    oval(c, -8, -3 - Math.max(0, f), 6, 4, hsl(hue, 45, 42));
    oval(c, 8, -3 - Math.max(0, -f), 6, 4, hsl(hue, 45, 42));

    c.translate(0, -bob);
    const R = 20;
    const cy = -23;
    const rx = R * (1 + sq);
    const ry = R * (1 - sq);
    const g = c.createRadialGradient(-6, cy - 8, 3, 0, cy, R * 1.25);
    g.addColorStop(0, hsl(hue, 90, 82));
    g.addColorStop(1, hsl(hue, 72, 60));
    c.beginPath();
    c.ellipse(0, cy + (R - ry), rx, ry, 0, 0, TAU);
    c.fillStyle = g;
    c.fill();
    c.lineWidth = 2.5;
    c.strokeStyle = hsl(hue, 55, 38);
    c.stroke();

    const back = dy < -0.3 && Math.abs(dx) < 0.75;
    if (!back) {
      const ex = dx * 6;
      const ey = cy - 2 + dy * 2;
      const blink = (t + seed * 1.37) % 3.7 < 0.12;
      for (const sx of [-7, 7]) {
        if (blink) {
          c.strokeStyle = '#3a2a44';
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(ex + sx - 3, ey);
          c.lineTo(ex + sx + 3, ey);
          c.stroke();
        } else {
          oval(c, ex + sx, ey, 4.5, 5.5, '#ffffff');
          oval(c, ex + sx + dx * 1.5, ey + 0.8 + dy * 0.8, 2.7, 3.3, '#2d1f36');
          oval(c, ex + sx + dx * 1.5 + 1, ey - 0.8, 1, 1, '#ffffff');
        }
      }
      oval(c, ex - 12, ey + 6, 4, 2.6, 'rgba(255,110,150,0.45)');
      oval(c, ex + 12, ey + 6, 4, 2.6, 'rgba(255,110,150,0.45)');
      c.strokeStyle = '#3a2a44';
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.beginPath();
      c.arc(ex, ey + 5, 3.5, 0.15 * Math.PI, 0.85 * Math.PI);
      c.stroke();
    } else {
      oval(c, 0, cy + 6, 9, 5, hsl(hue, 80, 75, 0.7));
    }

    // 고깔모자
    const hatHue = hue + 150;
    c.save();
    c.translate(0, cy - ry + 4 + (R - ry));
    c.rotate(-0.18 + (moving ? Math.sin(walk) * 0.07 : 0));
    const hh = 26;
    const hw = 11;
    c.beginPath();
    c.moveTo(-hw, 0);
    c.lineTo(hw, 0);
    c.lineTo(0, -hh);
    c.closePath();
    c.fillStyle = hsl(hatHue, 80, 66);
    c.fill();
    c.save();
    c.clip();
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 3;
    for (const yy of [-4, -12, -20]) {
      c.beginPath();
      c.moveTo(-hw, yy + 3);
      c.lineTo(hw, yy - 3);
      c.stroke();
    }
    c.restore();
    c.lineWidth = 1.8;
    c.strokeStyle = hsl(hatHue, 55, 40);
    c.lineJoin = 'round';
    c.stroke();
    oval(c, 0, -hh, 4.5, 4.5, '#ffe066');
    c.restore();

    c.restore();
  }

  function drawPlayer(p, t) {
    drawCharacter(ctx, p.x, p.y, p.hue, {
      t, seed: p.seed, walk: p.walk, moving: p.moving, dx: p.dx, dy: p.dy,
    });
  }

  function drawNameTag(p, t) {
    const isMe = p === me;
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(p.name).width + 16;
    const y = p.y - 84;
    rrect(ctx, p.x - w / 2, y - 11, w, 22, 11);
    ctx.fillStyle = isMe ? hsl(p.hue, 65, 42, 0.95) : 'rgba(50,28,62,0.62)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(p.name, p.x, y + 1);
    if (isMe && t - p.born < 8) {
      const b = Math.sin(t * 6) * 3;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.moveTo(p.x - 7, y - 24 + b);
      ctx.lineTo(p.x + 7, y - 24 + b);
      ctx.lineTo(p.x, y - 15 + b);
      ctx.closePath();
      ctx.fill();
    }
  }

  function wrapText(text, maxW) {
    const lines = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) {
        const sp = line.lastIndexOf(' ');
        if (sp > 0 && ch !== ' ') {
          lines.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          lines.push(line);
          line = ch === ' ' ? '' : ch;
        }
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    if (lines.length > 4) {
      lines.length = 4;
      lines[3] = lines[3].slice(0, -1) + '\u2026';
    }
    return lines;
  }

  function drawBubble(p, t) {
    const b = p.bubble;
    if (!b) return;
    if (t > b.until) { p.bubble = null; return; }
    const age = t - b.born;
    const alpha = Math.min(1, (b.until - t) / 0.5);
    const pop = age < 0.18 ? 0.7 + (age / 0.18) * 0.3 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `15px ${FONT}`;
    if (!b.lines) b.lines = wrapText(b.text, 170);
    const lineH = 19;
    const maxW = Math.max(...b.lines.map((l) => ctx.measureText(l).width));
    const bw = maxW + 22;
    const bh = b.lines.length * lineH + 12;
    const baseY = p.y - 100;
    ctx.translate(p.x, baseY);
    ctx.scale(pop, pop);
    rrect(ctx, -bw / 2, -bh - 8, bw, bh, 12);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hsl(p.hue, 50, 45);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-7, -9.5);
    ctx.lineTo(0, 0);
    ctx.lineTo(7, -9.5);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(-6, -11, 12, 3);
    ctx.fillStyle = '#3a2a44';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    b.lines.forEach((l, i) => ctx.fillText(l, 0, -bh - 8 + 6 + lineH / 2 + i * lineH + 1));
    ctx.restore();
  }

  function drawLauncherHint(t) {
    if (nearLauncher < 0) return;
    const L = W.launchers[nearLauncher];
    const text = '🎆 폭죽 버튼을 눌러보세요!';
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 20;
    const y = L.y - 108 + Math.sin(t * 4) * 3;
    rrect(ctx, L.x - w / 2, y - 13, w, 26, 13);
    ctx.fillStyle = 'rgba(255,170,40,0.95)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, L.x, y + 1);
  }

  // ---------- 폭죽 ----------
  function launchFirework(i, seed) {
    const L = W.launchers[i];
    if (!L) return;
    const r = mulberry32(seed);
    for (let k = 0; k < 3; k++) {
      fx.rockets.push({
        i, delay: k * 0.45, t: 0, dur: 0.8 + r() * 0.25, launched: false,
        sx: L.x, sy: L.y - 80, x: L.x, y: L.y - 80,
        tx: L.x + (r() - 0.5) * 240, ty: L.y - 230 - r() * 110,
        hue: Math.floor(r() * 360), heart: k === 1, r,
      });
    }
  }
  function explode(ro) {
    const r = ro.r;
    sfx('boom', volumeAt(ro.x, ro.y));
    fx.flashes.push({ x: ro.x, y: ro.y, life: 0.35, max: 0.35, hue: ro.hue });
    const n = 80;
    for (let i = 0; i < n; i++) {
      let vx, vy, color;
      if (ro.heart) {
        const a = (i / n) * TAU;
        const hx = 16 * Math.sin(a) ** 3;
        const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
        vx = hx * 11;
        vy = hy * 11;
        color = hsl(335 + r() * 25, 100, 66);
      } else {
        const a = (i / n) * TAU + r() * 0.08;
        const s = 150 + r() * 130;
        vx = Math.cos(a) * s;
        vy = Math.sin(a) * s;
        color = hsl(ro.hue + r() * 50 - 25, 100, 64);
      }
      const life = 1.2 + r() * 0.6;
      fx.particles.push({ x: ro.x, y: ro.y, vx, vy, life, max: life, color, size: 2.6 });
    }
    for (let i = 0; i < 24; i++) {
      const a = r() * TAU;
      const s = 40 + r() * 160;
      const life = 0.8 + r() * 0.9;
      fx.particles.push({ x: ro.x, y: ro.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color: '#fffbe0', size: 1.6, twinkle: true });
    }
  }
  function updateFx(dt) {
    for (let i = 0; i < launcherKick.length; i++) launcherKick[i] = Math.max(0, launcherKick[i] - dt * 3);
    for (let k = fx.rockets.length - 1; k >= 0; k--) {
      const ro = fx.rockets[k];
      if (ro.delay > 0) { ro.delay -= dt; continue; }
      if (!ro.launched) {
        ro.launched = true;
        launcherKick[ro.i] = 1;
        sfx('launch', volumeAt(ro.sx, ro.sy));
      }
      ro.t += dt;
      const u = Math.min(1, ro.t / ro.dur);
      const e = 1 - (1 - u) * (1 - u);
      ro.x = lerp(ro.sx, ro.tx, e);
      ro.y = lerp(ro.sy, ro.ty, e);
      fx.particles.push({ x: ro.x, y: ro.y, vx: (Math.random() - 0.5) * 30, vy: 40, life: 0.45, max: 0.45, color: '#ffd38a', size: 2 });
      if (u >= 1) {
        explode(ro);
        fx.rockets.splice(k, 1);
      }
    }
    const drag = Math.max(0, 1 - 1.6 * dt);
    for (let k = fx.particles.length - 1; k >= 0; k--) {
      const p = fx.particles[k];
      p.vx *= drag;
      p.vy = p.vy * drag + 70 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) fx.particles.splice(k, 1);
    }
    for (let k = fx.flashes.length - 1; k >= 0; k--) {
      fx.flashes[k].life -= dt;
      if (fx.flashes[k].life <= 0) fx.flashes.splice(k, 1);
    }
    const target = fx.rockets.length || fx.particles.length > 40 ? 0.5 : 0;
    fx.dim += (target - fx.dim) * Math.min(1, dt * (target ? 4 : 1.5));
  }
  function drawFx(t) {
    if (fx.dim > 0.01) {
      ctx.fillStyle = `rgba(22,10,45,${fx.dim})`;
      ctx.fillRect(-2000, -2000, W.w + 4000, W.h + 4000);
      // 어두워져도 촛불은 빛나게
      ctx.save();
      ctx.globalAlpha = Math.min(1, fx.dim * 2);
      CANDLES.forEach((_, i) => {
        const { x, y } = candlePos(i);
        drawCandleFlame(x, y, t, i, 1.4);
      });
      ctx.restore();
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of fx.flashes) {
      const a = f.life / f.max;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 140);
      g.addColorStop(0, hsl(f.hue, 100, 80, 0.55 * a));
      g.addColorStop(1, hsl(f.hue, 100, 60, 0));
      ctx.fillStyle = g;
      ctx.fillRect(f.x - 140, f.y - 140, 280, 280);
    }
    for (const ro of fx.rockets) {
      if (ro.delay > 0) continue;
      oval(ctx, ro.x, ro.y, 3.5, 3.5, '#fff6d0');
    }
    for (const p of fx.particles) {
      let a = p.life / p.max;
      if (p.twinkle) a *= 0.5 + 0.5 * Math.sin(t * 40 + p.x);
      ctx.globalAlpha = Math.max(0, a);
      oval(ctx, p.x, p.y, p.size, p.size, p.color);
    }
    ctx.restore();
  }

  // ---------- 업데이트 ----------
  let lastSent = 0;
  let sentKey = '';
  function sendMove(t) {
    const key = `${Math.round(me.x)},${Math.round(me.y)},${me.moving ? 1 : 0}`;
    if (key === sentKey || t - lastSent < 0.06) return;
    lastSent = t;
    sentKey = key;
    socket.emit('move', {
      x: Math.round(me.x), y: Math.round(me.y),
      dx: Math.round(me.dx * 100) / 100, dy: Math.round(me.dy * 100) / 100,
      m: me.moving ? 1 : 0,
    });
  }

  function update(dt, t) {
    if (me && joined) {
      const v = inputVec();
      const moving = v.x !== 0 || v.y !== 0;
      if (moving) {
        const sp = W.speed * dt;
        const stuck = W.collides(me.x, me.y);
        const nx = me.x + v.x * sp;
        if (stuck || !W.collides(nx, me.y)) me.x = nx;
        const ny = me.y + v.y * sp;
        if (stuck || !W.collides(me.x, ny)) me.y = ny;
        me.x = clamp(me.x, W.playerR, W.w - W.playerR);
        me.y = clamp(me.y, W.wallH + 20, W.h - 8);
        me.dx = v.x;
        me.dy = v.y;
        me.walk += dt * 13;
      }
      me.moving = moving;
      sendMove(t);

      let near = -1;
      W.launchers.forEach((L, i) => {
        if (Math.hypot(me.x - L.x, me.y - L.y) < W.fireworkRange) near = i;
      });
      if (near !== nearLauncher) {
        nearLauncher = near;
        $('btnFirework').classList.toggle('ready', near >= 0);
      }
    }

    for (const p of players.values()) {
      if (p === me) continue;
      const d = Math.hypot(p.tx - p.x, p.ty - p.y);
      if (d > 300) { p.x = p.tx; p.y = p.ty; }
      else {
        const k = Math.min(1, dt * 12);
        p.x += (p.tx - p.x) * k;
        p.y += (p.ty - p.y) * k;
      }
      if (p.moving || d > 2) p.walk += dt * 13;
    }

    updateFx(dt);
    updateCamera(dt, false);
  }

  // ---------- 렌더 ----------
  function render(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#3a2550');
    bg.addColorStop(1, '#22162f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const s = dpr * scale;
    ctx.setTransform(s, 0, 0, s, dpr * (vw / 2 - cam.x * scale), dpr * (vh / 2 - cam.y * scale));

    drawFloor(t);
    drawWall(t);

    const ents = [];
    ents.push({ y: W.cake.y + W.cake.ry, d: () => drawCake(t) });
    W.launchers.forEach((L, i) => ents.push({ y: L.y, d: () => drawLauncher(L, i, t) }));
    W.gifts.forEach((g) => ents.push({ y: g.y, d: () => drawGift(g) }));
    W.balloons.forEach((b, i) => ents.push({ y: b.y, d: () => drawBalloons(b, t, i) }));
    for (const p of players.values()) ents.push({ y: p.y + (p === me ? 0.01 : 0), d: () => drawPlayer(p, t) });
    ents.sort((a, b) => a.y - b.y);
    for (const e of ents) e.d();

    drawFx(t);

    const list = [...players.values()].sort((a, b) => (a === me) - (b === me) || a.y - b.y);
    for (const p of list) drawNameTag(p, t);
    drawLauncherHint(t);
    for (const p of list) drawBubble(p, t);
  }

  // 참가 화면 미리보기
  const preview = $('preview');
  const pctx = preview.getContext('2d');
  function renderPreview(t) {
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 160, h = 150;
    if (preview.width !== w * pr) { preview.width = w * pr; preview.height = h * pr; }
    pctx.setTransform(pr, 0, 0, pr, 0, 0);
    pctx.clearRect(0, 0, w, h);
    drawCharacter(pctx, w / 2, h - 12, myHue, {
      t, seed: 1, scale: 2.2, moving: true, walk: t * 5, dx: Math.sin(t * 0.8) * 0.6, dy: 1,
    });
  }

  let lastT = now();
  function frame() {
    const t = now();
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    // 창 크기/배율 변화 감지 (resize 이벤트가 누락되는 환경 대비)
    if (window.innerWidth !== vw || window.innerHeight !== vh || Math.min(window.devicePixelRatio || 1, 2) !== dpr) resize();
    update(dt, t);
    render(t);
    if (!$('join').hidden) renderPreview(t);
    requestAnimationFrame(frame);
  }

  // ---------- UI ----------
  function toast(text, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  function logLine(name, hue, text, sys) {
    const box = $('chatLog');
    const el = document.createElement('div');
    el.className = 'line' + (sys ? ' sys' : '');
    if (name) {
      el.style.setProperty('--h', hue);
      const b = document.createElement('b');
      b.textContent = name + ' ';
      el.appendChild(b);
    }
    el.appendChild(document.createTextNode(text));
    box.appendChild(el);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 700);
    }, 15000);
  }

  function setBirthdayName(name) {
    birthdayName = name;
    document.querySelectorAll('.bd-name').forEach((el) => (el.textContent = name));
    document.title = `${name}의 생일 파티 🎂`;
  }

  // 채팅
  const chatBar = $('chatBar');
  const chatInput = $('chatInput');
  function openChat() {
    if (!joined) return;
    chatBar.hidden = false;
    setDpad(0, 0);
    keys.clear();
    chatInput.focus();
  }
  function closeChat() {
    chatBar.hidden = true;
    chatInput.blur();
  }
  $('btnChat').addEventListener('click', () => (chatBar.hidden ? openChat() : closeChat()));
  $('chatClose').addEventListener('click', closeChat);
  chatBar.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) socket.emit('chat', { text });
    chatInput.value = '';
    closeChat();
  });

  // 폭죽
  let lastFireworkReq = 0;
  function tryFirework() {
    if (!joined) return;
    ensureAudio();
    if (nearLauncher < 0) {
      toast('케이크 양옆의 폭죽 앞으로 가까이 가보세요! 🎆');
      return;
    }
    const t = now();
    if (t - lastFireworkReq < 1.5) return;
    lastFireworkReq = t;
    socket.emit('firework', { launcher: nearLauncher });
  }
  $('btnFirework').addEventListener('click', tryFirework);

  // 소리
  function syncSoundBtn() {
    $('btnSound').querySelector('span').textContent = muted ? '🔇' : '🔊';
  }
  $('btnSound').addEventListener('click', () => {
    muted = !muted;
    store.set('hbd:muted', muted ? '1' : '0');
    ensureAudio();
    syncSoundBtn();
    toast(muted ? '소리를 껐어요' : '소리를 켰어요', 1200);
  });
  syncSoundBtn();

  // 방명록
  const gbModal = $('gbModal');
  const gbList = $('gbList');
  const gbText = $('gbText');
  const badge = $('btnGuestbook').querySelector('.badge');
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  function gbItem(e, isNew) {
    const li = document.createElement('li');
    li.className = 'gb-item' + (isNew ? ' new' : '');
    li.style.setProperty('--h', e.hue);
    const head = document.createElement('div');
    head.className = 'head';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('strong');
    name.textContent = e.name;
    const time = document.createElement('time');
    time.textContent = fmtTime(e.ts);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'gb-del';
    del.textContent = '🗑';
    del.title = '삭제';
    head.append(dot, name, time, del);
    li.dataset.id = e.id;
    const p = document.createElement('p');
    p.textContent = e.text;
    li.append(head, p);
    return li;
  }
  function renderGuestbook() {
    gbList.textContent = '';
    if (!guestbook.length) {
      const li = document.createElement('li');
      li.className = 'gb-empty';
      li.textContent = '아직 메시지가 없어요. 첫 축하 메시지를 남겨주세요! 🎉';
      gbList.appendChild(li);
    } else {
      for (const e of guestbook) gbList.appendChild(gbItem(e));
    }
    $('gbTotal').textContent = guestbook.length ? `${guestbook.length}개` : '';
  }
  function openGuestbook() {
    closeChat();
    setDpad(0, 0);
    keys.clear();
    gbModal.hidden = false;
    badge.hidden = true;
  }
  function closeGuestbook() {
    gbModal.hidden = true;
    gbText.blur();
  }
  $('btnGuestbook').addEventListener('click', openGuestbook);
  $('gbClose').addEventListener('click', closeGuestbook);
  gbModal.addEventListener('click', (e) => { if (e.target === gbModal) closeGuestbook(); });
  gbText.addEventListener('input', () => {
    $('gbCount').textContent = `${Array.from(gbText.value).length} / 300`;
  });
  $('gbForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = gbText.value.trim();
    if (!text) { gbText.focus(); return; }
    const btn = e.submitter || $('gbForm').querySelector('button');
    btn.disabled = true;
    socket.timeout(8000).emit('guestbook:add', { text }, (err, res) => {
      btn.disabled = false;
      if (err) return toast('전송에 실패했어요. 다시 시도해 주세요.');
      if (!res || !res.ok) return toast((res && res.error) || '전송에 실패했어요.');
      gbText.value = '';
      $('gbCount').textContent = '0 / 300';
      gbList.scrollTop = 0;
      toast('방명록을 남겼어요! 💌');
    });
  });

  // 관리자 (비밀번호는 저장하지 않고 이 페이지가 열려 있는 동안만 메모리에 보관)
  const adminBtn = $('adminBtn');
  const adminForm = $('adminForm');
  const adminKeyInput = $('adminKey');
  let adminKey = null;
  function setAdmin(on) {
    gbModal.classList.toggle('admin', on);
    adminBtn.classList.toggle('on', on);
    adminBtn.textContent = on ? '🔓 관리자 모드' : '🔒 관리자';
  }
  function adminLogin(key, quiet) {
    socket.timeout(8000).emit('admin:login', { key }, (err, res) => {
      if (err || !res || !res.ok) {
        if (!quiet) toast((res && res.error) || '로그인에 실패했어요.');
        adminKey = null;
        setAdmin(false);
        return;
      }
      adminKey = key;
      setAdmin(true);
      adminForm.hidden = true;
      adminKeyInput.value = '';
      if (!quiet) toast('관리자 모드: 🗑 버튼으로 글을 지울 수 있어요');
    });
  }
  adminBtn.addEventListener('click', () => {
    if (adminKey) {
      adminKey = null;
      setAdmin(false);
      socket.emit('admin:logout');
      toast('관리자 모드를 껐어요', 1500);
      return;
    }
    adminForm.hidden = !adminForm.hidden;
    if (!adminForm.hidden) adminKeyInput.focus();
  });
  adminForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = adminKeyInput.value;
    if (key) adminLogin(key, false);
  });
  gbList.addEventListener('click', (e) => {
    const btn = e.target.closest('.gb-del');
    if (!btn || !adminKey) return;
    const li = btn.closest('.gb-item');
    const entry = guestbook.find((g) => g.id === li.dataset.id);
    const preview = entry ? `${entry.name}: ${entry.text.slice(0, 40)}` : '';
    if (!window.confirm(`이 글을 삭제할까요?\n\n${preview}`)) return;
    btn.disabled = true;
    socket.timeout(8000).emit('guestbook:delete', { id: li.dataset.id }, (err, res) => {
      btn.disabled = false;
      if (err) return toast('삭제에 실패했어요. 다시 시도해 주세요.');
      if (!res || !res.ok) return toast((res && res.error) || '삭제에 실패했어요.');
      toast('삭제했어요', 1500);
    });
  });

  // 참가
  const joinScreen = $('join');
  const joinBtn = $('joinBtn');
  const nameInput = $('nameInput');
  const joinStatus = $('joinStatus');
  nameInput.value = store.get('hbd:name') || '';
  $('reroll').addEventListener('click', () => {
    myHue = (myHue + 60 + Math.floor(Math.random() * 240)) % 360;
  });
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.classList.remove('shake');
      void nameInput.offsetWidth;
      nameInput.classList.add('shake');
      nameInput.focus();
      return;
    }
    if (!socket.connected) return;
    store.set('hbd:name', name);
    ensureAudio();
    joinBtn.disabled = true;
    joinStatus.textContent = '입장하는 중\u2026';
    socket.emit('join', { name, hue: myHue });
  });

  // ---------- 소켓 ----------
  socket.on('connect', () => {
    if (joined && me) {
      socket.emit('join', { name: me.name, hue: me.hue, x: me.x, y: me.y });
    }
    if (adminKey) adminLogin(adminKey, true); // 재연결되면 관리자 모드 유지
  });
  socket.on('hello', (d) => {
    setBirthdayName(d.birthdayName);
    adminBtn.hidden = !d.adminEnabled;
    if (!joined) {
      joinBtn.disabled = false;
      joinStatus.textContent = d.online ? `지금 ${d.online}명이 파티 중이에요! 🎈` : '첫 번째 손님이 되어주세요! 🎈';
    }
  });
  socket.on('full', (d) => {
    joinBtn.disabled = false;
    joinStatus.textContent = `파티장이 꽉 찼어요 (최대 ${d.max}명). 잠시 후 다시 시도해 주세요.`;
  });
  socket.on('welcome', (d) => {
    const first = !joined;
    myId = d.id;
    setBirthdayName(d.birthdayName);
    players.clear();
    for (const p of d.players) addPlayer(p);
    me = players.get(myId);
    joined = true;
    sentKey = '';
    $('online').textContent = d.players.length;
    guestbook = d.guestbook || [];
    renderGuestbook();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    joinScreen.hidden = true;
    $('hud').hidden = false;
    updateCamera(0, true);
    if (first) {
      logLine('', 0, `🎉 ${birthdayName}의 생일 파티에 오신 걸 환영해요!`, true);
      toast('방향키로 움직이고, 폭죽 앞에서 🎆 버튼을 눌러보세요!', 4000);
    }
  });
  socket.on('joined', (p) => {
    addPlayer(p);
    logLine('', 0, `${p.name}님이 들어왔어요 👋`, true);
  });
  socket.on('left', (id) => {
    const p = players.get(id);
    if (!p) return;
    players.delete(id);
    logLine('', 0, `${p.name}님이 나갔어요`, true);
  });
  socket.on('online', (n) => ($('online').textContent = n));
  socket.on('moved', (d) => {
    const p = players.get(d.id);
    if (!p || p === me) return;
    p.tx = d.x;
    p.ty = d.y;
    p.dx = d.dx;
    p.dy = d.dy;
    p.moving = !!d.m;
  });
  socket.on('chat', (d) => {
    const p = players.get(d.id);
    const t = now();
    if (p) p.bubble = { text: d.text, born: t, until: t + 6 };
    logLine(d.name, d.hue, d.text);
  });
  socket.on('firework', (d) => {
    launchFirework(d.launcher, d.seed);
    if (d.id === myId) return;
    toast(`${d.name}님이 폭죽을 터뜨렸어요! 🎆`, 2000);
  });
  socket.on('guestbook:new', (e) => {
    guestbook.unshift(e);
    if (guestbook.length === 1) renderGuestbook();
    else {
      gbList.prepend(gbItem(e, true));
      $('gbTotal').textContent = `${guestbook.length}개`;
    }
    if (gbModal.hidden) {
      badge.hidden = false;
      if (e.name !== (me && me.name)) toast(`📜 ${e.name}님이 방명록을 남겼어요`, 2200);
    }
  });
  socket.on('guestbook:deleted', (id) => {
    guestbook = guestbook.filter((e) => e.id !== id);
    const li = [...gbList.children].find((el) => el.dataset.id === id);
    if (!li) return;
    li.classList.add('removing');
    setTimeout(() => {
      if (guestbook.length) {
        li.remove();
        $('gbTotal').textContent = `${guestbook.length}개`;
      } else {
        renderGuestbook();
      }
    }, 250);
  });
  socket.on('guestbook:all', (list) => {
    guestbook = Array.isArray(list) ? list : [];
    renderGuestbook();
  });
  socket.on('disconnect', () => {
    if (joined) toast('연결이 끊겼어요. 다시 연결하는 중\u2026', 3000);
  });

  // 시작
  if (document.fonts && document.fonts.load) document.fonts.load(`20px ${FONT}`).catch(() => {});
  resize();
  requestAnimationFrame(frame);
})();

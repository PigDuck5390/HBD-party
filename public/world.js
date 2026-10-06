// 맵 레이아웃 - 서버(Node)와 브라우저가 함께 사용합니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WORLD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const world = {
    w: 1400,
    h: 900,
    wallH: 130,
    playerR: 16,
    speed: 210,
    fireworkRange: 95,
    spawn: { x: 700, y: 720 },
    cake: { x: 700, y: 470, rx: 165, ry: 58 },
    launchers: [
      { x: 440, y: 500 },
      { x: 960, y: 500 },
    ],
    gifts: [
      { x: 200, y: 250, c: '#7ad3f7', r: '#ff6fa3' },
      { x: 248, y: 285, c: '#ffd166', r: '#6c63ff' },
      { x: 1190, y: 250, c: '#b39ddb', r: '#ffd166' },
      { x: 1235, y: 292, c: '#ff8fab', r: '#ffffff' },
      { x: 1120, y: 820, c: '#8bd3a5', r: '#ff6fa3' },
      { x: 290, y: 830, c: '#ffb38a', r: '#7a5cff' },
    ],
    balloons: [
      { x: 90, y: 240 },
      { x: 1310, y: 240 },
      { x: 90, y: 860 },
      { x: 1310, y: 860 },
    ],
  };

  world.obstacles = [
    ...world.launchers.map((l) => ({ x: l.x, y: l.y, r: 26 })),
    ...world.gifts.map((g) => ({ x: g.x, y: g.y - 6, r: 20 })),
  ];

  // (x, y)는 캐릭터의 발 위치
  world.collides = function (x, y) {
    const r = world.playerR;
    if (x < r || x > world.w - r || y < world.wallH + 20 || y > world.h - 8) return true;
    const c = world.cake;
    const ex = (x - c.x) / (c.rx + r);
    const ey = (y - c.y) / (c.ry + r);
    if (ex * ex + ey * ey < 1) return true;
    for (const o of world.obstacles) {
      if (Math.hypot(x - o.x, y - o.y) < o.r + r) return true;
    }
    return false;
  };

  return world;
});

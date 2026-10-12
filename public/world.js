// 맵 레이아웃 - 서버(Node)와 브라우저가 함께 사용합니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WORLD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const world = {
    w: 2020, // 파티룸(0~1400) + 시네마 홀(1432~1900) + 오른쪽 여백(카메라가 스크린을 가운데 둘 수 있도록)
    h: 900,
    wallH: 130,
    room: { w: 1400 }, // 파티룸 폭: 벽 장식·플랜카드·색종이는 이 안에만
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
    // 시네마 홀
    cinema: {
      x0: 1432, // 이 x보다 오른쪽이면 시네마 안 (소리가 들림)
      x1: 1900,
      door: { y0: 470, y1: 690 },
      screen: { x: 1466, y: 46, w: 400, h: 225 },
      stage: { x: 1450, y: 276, w: 432, h: 34 },
      rows: [420, 500, 580, 660],
      blocks: [{ x: 1470, n: 5 }, { x: 1692, n: 5 }],
      seatW: 34,
      aisle: { x: 1640, w: 52 },
      popcorn: { x: 1490, y: 800 },
      projector: { x: 1666, y: 850 },
    },
  };

  const C = world.cinema;
  // 사각형 장애물
  world.rects = [
    // 파티룸과 시네마 사이 벽 (문 부분만 뚫림)
    { x: 1400, y: 0, w: C.x0 - 1400, h: C.door.y0 },
    { x: 1400, y: C.door.y1, w: C.x0 - 1400, h: world.h - C.door.y1 },
    // 시네마 오른쪽 끝 벽 (그 뒤는 화면 여백)
    { x: C.x1, y: 0, w: world.w - C.x1, h: world.h },
    // 무대
    { x: C.stage.x, y: 0, w: C.stage.w, h: C.stage.y + C.stage.h },
    // 좌석 줄
    ...C.rows.flatMap((ry) => C.blocks.map((b) => ({ x: b.x, y: ry - 24, w: b.n * C.seatW, h: 28 }))),
  ];

  world.obstacles = [
    ...world.launchers.map((l) => ({ x: l.x, y: l.y, r: 26 })),
    ...world.gifts.map((g) => ({ x: g.x, y: g.y - 6, r: 20 })),
    { x: C.popcorn.x, y: C.popcorn.y, r: 24 },
    { x: C.projector.x, y: C.projector.y, r: 22 },
  ];

  world.inCinema = (x) => x > C.x0;

  // (x, y)는 캐릭터의 발 위치
  world.collides = function (x, y) {
    const r = world.playerR;
    if (x < r || x > world.w - r || y < world.wallH + 20 || y > world.h - 8) return true;
    const c = world.cake;
    const ex = (x - c.x) / (c.rx + r);
    const ey = (y - c.y) / (c.ry + r);
    if (ex * ex + ey * ey < 1) return true;
    for (const q of world.rects) {
      if (x > q.x - r && x < q.x + q.w + r && y > q.y && y < q.y + q.h) return true;
    }
    for (const o of world.obstacles) {
      if (Math.hypot(x - o.x, y - o.y) < o.r + r) return true;
    }
    return false;
  };

  return world;
});

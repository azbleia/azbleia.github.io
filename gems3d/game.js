// Gem Swap 3D — a match-three board of faceted gems as a glasses-free 3D scene.
//
// Built on @displayxr/inline3d like the SDK's samples/hello-cube: one inline-3D session, one
// woven canvas, the three.js scene rendered once per eye into the halves the XRDisplayLayer
// reports. Any other browser gets a single mono camera.
//
// Depth layout (+z is toward the viewer, z = 0 is the glass):
//   * gems sit on the zero-disparity plane; a selected gem lifts out of the glass;
//   * the checkerboard sits just behind them;
//   * matched gems pop toward the viewer and burst into sparks; scores float up and out.
// The canvas fills the window, so the HUD is voxel text in the scene's side columns.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createInline3D } from '@displayxr/inline3d';
import { EdgeFeather } from '@displayxr/inline3d/three';

// ---- tuning (metres, seconds) — composed for a 12 cm-tall virtual display --------------------
const VDH = 0.12;
const N = 8;                                   // board is N x N
const CELL = 0.0132;
const GEM_R = 0.0062;
const SWAP_T = 0.18, CLEAR_T = 0.28, FALL_G = 70, HINT_AFTER = 7;
const LIFT = 0.008;                            // how far a selected gem rises out of the glass

const canvas = document.getElementById('game');

// ---- renderer (same contract as hello-cube) -------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = null;
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xe8ecff, 0x2a2040, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(0.3, 0.8, 1.0);
scene.add(key);

// ---- gem types -------------------------------------------------------------------------------
function latheGem(sides, phi) {
  const pts = [[0.001, -0.62], [0.98, 0.02], [1, 0.1], [0.62, 0.34], [0.001, 0.34]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, sides, phi);
  g.rotateX(Math.PI / 2);                      // lathe axis (+y) -> +z, table facing the viewer
  return g;
}
const GEMS = [
  { name: 'red', color: 0xff3048, geo: latheGem(4, Math.PI / 4).scale(GEM_R * 0.95, GEM_R * 0.95, GEM_R) },
  { name: 'orange', color: 0xff8a1c, geo: latheGem(6, 0).scale(GEM_R, GEM_R, GEM_R) },
  { name: 'yellow', color: 0xffd531, geo: new THREE.OctahedronGeometry(1).scale(GEM_R * 0.78, GEM_R * 1.05, GEM_R * 0.6) },
  { name: 'green', color: 0x2fdc6a, geo: latheGem(8, Math.PI / 8).scale(GEM_R * 0.95, GEM_R * 0.95, GEM_R) },
  { name: 'blue', color: 0x3a9bff, geo: new THREE.DodecahedronGeometry(1).scale(GEM_R * 0.92, GEM_R * 0.92, GEM_R * 0.8) },
  { name: 'purple', color: 0xc04dff, geo: latheGem(3, Math.PI).scale(GEM_R * 1.08, GEM_R * 1.08, GEM_R) },
  { name: 'white', color: 0xeef1ff, geo: new THREE.IcosahedronGeometry(1, 1).scale(GEM_R * 0.86, GEM_R * 0.86, GEM_R * 0.86) },
];
function gemMaterial(color, emissive = 0) {
  return new THREE.MeshStandardMaterial({
    color, metalness: 0.25, roughness: 0.1, flatShading: true, envMapIntensity: 1.5,
    emissive: new THREE.Color(color), emissiveIntensity: emissive,
  });
}
const GEM_MATS = GEMS.map((g) => gemMaterial(g.color, 0.08));
const hyperGeo = new THREE.BoxGeometry(GEM_R * 1.3, GEM_R * 1.3, GEM_R * 1.3);

// ---- board coordinates -----------------------------------------------------------------------
const wx = (c) => (c - (N - 1) / 2) * CELL;
const wy = (r) => (r - (N - 1) / 2) * CELL;
const root = new THREE.Group();               // everything but lights; scaled for narrow windows
scene.add(root);

// checkerboard + frame
{
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL * 0.98, CELL * 0.98, CELL * 0.2),
    new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 }), N * N);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const i = r * N + c;
    m.makeTranslation(wx(c), wy(r), -CELL * 0.62);
    tiles.setMatrixAt(i, m);
    tiles.setColorAt(i, col.setHex((r + c) % 2 ? 0x1b1934 : 0x252246));
  }
  root.add(tiles);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b5a2e, roughness: 0.3, metalness: 0.9 });
  const L = N * CELL, T = CELL * 0.22, D = CELL * 0.5;
  for (const [x, y, w, h] of [[0, L / 2 + T / 2, L + 2 * T, T], [0, -L / 2 - T / 2, L + 2 * T, T], [-L / 2 - T / 2, 0, T, L], [L / 2 + T / 2, 0, T, L]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, D), frameMat);
    b.position.set(x, y, -CELL * 0.45);
    root.add(b);
  }
}

// ---- gems ------------------------------------------------------------------------------------
// A gem: { type (0..6, -1 = hypercube), special: null | 'flame' | 'hyper', mesh, gx, gy (current
// position in cell units), c, r (target cell), vy, phase, clearing }
let grid = [];                                 // grid[r][c] -> gem | null
const gemsGroup = new THREE.Group();
root.add(gemsGroup);

function makeGem(type, c, r, special = null) {
  let mesh;
  if (special === 'hyper') {
    mesh = new THREE.Mesh(hyperGeo, new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.15, emissiveIntensity: 0.7 }));
  } else if (special === 'flame') {
    mesh = new THREE.Mesh(GEMS[type].geo, gemMaterial(GEMS[type].color, 0.4));
  } else {
    mesh = new THREE.Mesh(GEMS[type].geo, GEM_MATS[type]);
  }
  gemsGroup.add(mesh);
  return { type: special === 'hyper' ? -1 : type, special, mesh, gx: c, gy: r, c, r, vy: 0, phase: Math.random() * 6.28, clearing: 0 };
}
function removeGem(g) {
  gemsGroup.remove(g.mesh);
  if (g.special) g.mesh.material.dispose();
}

const randType = () => Math.floor(Math.random() * GEMS.length);
const typeAt = (r, c) => (r >= 0 && r < N && c >= 0 && c < N && grid[r][c] ? grid[r][c].type : -2);

function fillBoard() {
  for (const row of grid) for (const g of row) if (g) removeGem(g);
  do {
    grid = Array.from({ length: N }, () => Array(N).fill(null));
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      let t;
      do { t = randType(); } while ((typeAt(r, c - 1) === t && typeAt(r, c - 2) === t) || (typeAt(r - 1, c) === t && typeAt(r - 2, c) === t));
      grid[r][c] = makeGem(t, c, r);
      grid[r][c].gy = r + N + Math.random() * 2 + c * 0.15;     // drop in from above
    }
  } while (!findMove());
}

// ---- matching --------------------------------------------------------------------------------
const key2 = (r, c) => r * N + c;
function findRuns() {
  const runs = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N;) {
    const t = typeAt(r, c); let e = c + 1;
    while (t >= 0 && typeAt(r, e) === t) e++;
    if (t >= 0 && e - c >= 3) runs.push({ t, cells: Array.from({ length: e - c }, (_, i) => [r, c + i]) });
    c = e;
  }
  for (let c = 0; c < N; c++) for (let r = 0; r < N;) {
    const t = typeAt(r, c); let e = r + 1;
    while (t >= 0 && typeAt(e, c) === t) e++;
    if (t >= 0 && e - r >= 3) runs.push({ t, cells: Array.from({ length: e - r }, (_, i) => [r + i, c]) });
    r = e;
  }
  return runs;
}
function findMove() {
  if (grid.some((row) => row.some((g) => g && g.special === 'hyper'))) return { a: null };
  const swap = (r1, c1, r2, c2) => { const t = grid[r1][c1]; grid[r1][c1] = grid[r2][c2]; grid[r2][c2] = t; };
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0]]) {
      const r2 = r + dr, c2 = c + dc;
      if (r2 >= N || c2 >= N) continue;
      swap(r, c, r2, c2);
      const ok = findRuns().length > 0;
      swap(r, c, r2, c2);
      if (ok) return { a: [r, c], b: [r2, c2] };
    }
  }
  return null;
}

// Work out what a set of runs clears and which specials it creates. `prefer` is the set of
// cells the player just swapped (specials are born where the player moved).
function resolveRuns(runs, prefer = []) {
  const clear = new Set(), specials = [];
  const count = new Map();
  for (const run of runs) for (const [r, c] of run.cells) { clear.add(key2(r, c)); count.set(key2(r, c), (count.get(key2(r, c)) || 0) + 1); }
  const born = new Set();
  const pick = (cells) => {
    const p = cells.find(([r, c]) => prefer.some(([pr, pc]) => pr === r && pc === c));
    return p || cells[Math.floor(cells.length / 2)];
  };
  for (const run of runs) {
    if (run.cells.length >= 5) {
      const [r, c] = pick(run.cells);
      if (!born.has(key2(r, c))) { born.add(key2(r, c)); specials.push({ r, c, t: run.t, kind: 'hyper' }); }
    }
  }
  for (const [k, n] of count) {                // L / T intersections
    if (n > 1 && !born.has(k)) { born.add(k); specials.push({ r: Math.floor(k / N), c: k % N, t: typeAt(Math.floor(k / N), k % N), kind: 'flame' }); }
  }
  for (const run of runs) {
    if (run.cells.length === 4 && !run.cells.some(([r, c]) => born.has(key2(r, c)))) {
      const [r, c] = pick(run.cells);
      born.add(key2(r, c)); specials.push({ r, c, t: run.t, kind: 'flame' });
    }
  }
  for (const k of born) clear.delete(k);
  return { clear, specials };
}
// Flames in the clear set blow up their 3x3; hypercubes caught in a blast take a whole colour.
function detonate(clear) {
  const done = new Set(); let fired = 0;
  let again = true;
  while (again) {
    again = false;
    for (const k of [...clear]) {
      if (done.has(k)) continue;
      const g = grid[Math.floor(k / N)][k % N];
      if (!g || (g.special !== 'flame' && g.special !== 'hyper')) continue;
      done.add(k); fired++; again = true;
      const r = Math.floor(k / N), c = k % N;
      if (g.special === 'flame') {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (typeAt(r + dr, c + dc) !== -2) clear.add(key2(r + dr, c + dc));
        flash(wx(c), wy(r), 0xff8a1c);
      } else {
        const t = randType();
        for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++) if (typeAt(rr, cc) === t) clear.add(key2(rr, cc));
      }
    }
  }
  return fired;
}

// ---- game state --------------------------------------------------------------------------------
const S = {
  phase: 'ready',                              // ready | idle | swap | swapBack | clear | fall | shuffle
  t: 0, a: null, b: null, cascade: 0,
  score: 0, best: 0, level: 1, levelPts: 0,
  selected: null, idleT: 0, hint: null,
};
try { S.best = Number(localStorage.getItem('gems3d-best')) || 0; } catch { /* storage unavailable */ }
const levelNeed = (lvl) => 600 + lvl * 400;

function start() {
  S.score = 0; S.level = 1; S.levelPts = 0; S.cascade = 0; S.selected = null; S.hint = null;
  fillBoard();
  S.phase = 'fall';
  showBanner(null);
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
}

function trySwap(a, b) {
  const ga = grid[a[0]][a[1]], gb = grid[b[0]][b[1]];
  if (!ga || !gb) return;
  S.selected = null; S.hint = null; S.idleT = 0;
  grid[a[0]][a[1]] = gb; grid[b[0]][b[1]] = ga;
  ga.r = b[0]; ga.c = b[1]; gb.r = a[0]; gb.c = a[1];
  S.a = a; S.b = b; S.t = 0; S.phase = 'swap';
}

function afterSwap() {
  const ga = grid[S.b[0]][S.b[1]], gb = grid[S.a[0]][S.a[1]];
  // hypercube swaps: clear every gem of the other one's colour (two cubes: the whole board)
  if (ga.special === 'hyper' || gb.special === 'hyper') {
    const clear = new Set();
    const other = ga.special === 'hyper' ? gb : ga;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const g = grid[r][c];
      if (g === ga || g === gb || other.special === 'hyper' || g.type === other.type) clear.add(key2(r, c));
    }
    for (const g of [ga, gb]) if (g.special === 'hyper') g.special = 'spent';   // already fired
    S.cascade = 1;
    beginClear({ clear, specials: [] }, 150);
    return;
  }
  const runs = findRuns();
  if (!runs.length) { S.t = 0; S.phase = 'swapBack'; return; }
  S.cascade = 1;
  beginClear(resolveRuns(runs, [S.a, S.b]));
}

function beginClear({ clear, specials }, bonus = 0) {
  const fired = detonate(clear);
  let sx = 0, sy = 0, n = 0;
  for (const k of clear) {
    const g = grid[Math.floor(k / N)][k % N];
    if (!g) continue;
    g.clearing = 1e-6;
    sx += g.gx; sy += g.gy; n++;
  }
  // turn the birth cells into their specials right away (they stay on the board)
  for (const s of specials) {
    const old = grid[s.r][s.c];
    if (!old) continue;
    const g = makeGem(s.t, s.c, s.r, s.kind);
    g.gx = old.gx; g.gy = old.gy;
    removeGem(old);
    grid[s.r][s.c] = g;
    flash(wx(s.c), wy(s.r), s.kind === 'hyper' ? 0xffffff : 0xff8a1c);
  }
  const pts = (n * 10 + fired * 50 + specials.length * 30 + bonus) * S.cascade;
  addScore(pts);
  if (n) floatText(String(pts), wx(sx / n), wy(sy / n));
  const WORDS = [null, null, 'GOOD', 'GREAT', 'AWESOME', 'EXCELLENT'];
  if (S.cascade >= 2) showBanner(wordBanner(WORDS[Math.min(5, S.cascade)]), 0.9);
  S.t = 0; S.phase = 'clear';
}

function finishClear() {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const g = grid[r][c];
    if (g && g.clearing) { burst(g); removeGem(g); grid[r][c] = null; }
  }
  // collapse columns and drop new gems in from above
  for (let c = 0; c < N; c++) {
    let w = 0;
    for (let r = 0; r < N; r++) {
      const g = grid[r][c];
      if (!g) continue;
      if (r !== w) { grid[w][c] = g; grid[r][c] = null; g.r = w; }
      w++;
    }
    for (let r = w, k = 0; r < N; r++, k++) {
      const g = makeGem(randType(), c, r);
      g.gy = N + k + 0.3;
      grid[r][c] = g;
    }
  }
  S.phase = 'fall';
}

function afterFall() {
  const runs = findRuns();
  if (runs.length) { S.cascade++; beginClear(resolveRuns(runs)); return; }
  S.cascade = 0; S.idleT = 0; S.phase = 'idle';
  if (!findMove()) {
    showBanner(bannerShuffle, 1.4);
    S.phase = 'shuffle'; S.t = 0;
  }
}

function shuffleBoard() {
  const specials = [];
  for (const row of grid) for (const g of row) if (g.special) specials.push(g.special);
  fillBoard();
}

function addScore(pts) {
  S.score += pts;
  S.levelPts += pts;
  if (S.score > S.best) { S.best = S.score; try { localStorage.setItem('gems3d-best', String(S.best)); } catch { /* ignore */ } }
  while (S.levelPts >= levelNeed(S.level)) {
    S.levelPts -= levelNeed(S.level);
    S.level++;
    setLabel(levelBannerNum, String(S.level));
    showBanner(bannerLevel, 1.6);
  }
}

// ---- input ---------------------------------------------------------------------------------------
let fit = 1;
function pointerCell(e) {
  const rect = canvas.getBoundingClientRect();
  const u = (e.clientX - rect.left) / rect.width, v = (e.clientY - rect.top) / rect.height;
  const halfW = (VDH / 2) * (rect.width / rect.height);
  const x = (u * 2 - 1) * halfW / fit, y = (1 - v * 2) * (VDH / 2) / fit;
  return [Math.floor(y / CELL + N / 2), Math.floor(x / CELL + N / 2)];
}
const inBoard = ([r, c]) => r >= 0 && r < N && c >= 0 && c < N;
const adjacent = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

let drag = null;
addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (S.phase === 'ready') { start(); return; }
  const cell = pointerCell(e);
  if (S.phase !== 'idle' || !inBoard(cell)) { S.selected = null; return; }
  if (S.selected && adjacent(S.selected, cell)) { trySwap(S.selected, cell); return; }
  S.selected = (S.selected && S.selected[0] === cell[0] && S.selected[1] === cell[1]) ? null : cell;
  drag = { cell, x: e.clientX, y: e.clientY };
});
addEventListener('pointermove', (e) => {
  if (!drag || S.phase !== 'idle') return;
  const px = canvas.clientHeight * (CELL / VDH) * fit * 0.4;   // 40% of a cell, in CSS pixels
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < px) return;
  const [r, c] = drag.cell;
  const to = Math.abs(dx) > Math.abs(dy) ? [r, c + Math.sign(dx)] : [r - Math.sign(dy), c];
  drag = null;
  if (inBoard(to)) trySwap([r, c], to);
});
addEventListener('pointerup', () => { drag = null; });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
  if (e.code === 'KeyH' && S.phase === 'idle') S.idleT = HINT_AFTER;
  if ((e.code === 'Enter' || e.code === 'Space') && S.phase === 'ready') start();
});

// ---- sparks ------------------------------------------------------------------------------------
const MAX_SPARKS = 900;
const sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1),
  new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.2, flatShading: true, emissive: 0xffffff, emissiveIntensity: 0.25 }), MAX_SPARKS);
sparks.frustumCulled = false;
for (let i = 0; i < MAX_SPARKS; i++) sparks.setColorAt(i, new THREE.Color(0xffffff));
root.add(sparks);
const sparkList = [];
function spawnSpark(x, y, z, hex, speed = 1) {
  if (sparkList.length >= MAX_SPARKS) sparkList.shift();
  const a = Math.random() * Math.PI * 2, s = (0.02 + Math.random() * 0.05) * speed;
  sparkList.push({
    p: new THREE.Vector3(x, y, z),
    v: new THREE.Vector3(Math.cos(a) * s, Math.sin(a) * s + 0.01, 0.02 + Math.random() * 0.05 * speed),
    rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0),
    life: 0, max: 0.5 + Math.random() * 0.4, size: GEM_R * (0.12 + Math.random() * 0.18), hex,
  });
}
function burst(g) {
  const hex = g.type < 0 ? 0xffffff : GEMS[g.type].color;      // hypercubes (live or spent) burst white
  for (let i = 0; i < 14; i++) spawnSpark(wx(g.gx), wy(g.gy), g.mesh.position.z, hex);
}
function flash(x, y, hex) { for (let i = 0; i < 22; i++) spawnSpark(x, y, 0.004, hex, 1.6); }

// ---- voxel text ----------------------------------------------------------------------------------
const FONT = {
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'], B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', '#    ', '#    ', ' ####'], D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'], F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ### '], H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '#####'], L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'], N: ['#   #', '##  #', '# # #', '#  ##', '#   #', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '], P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'], S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '], U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '], W: ['#   #', '#   #', '#   #', '# # #', '# # #', '## ##', '#   #'],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'], Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  '+': ['     ', '  #  ', '  #  ', '#####', '  #  ', '  #  ', '     '],
  0: [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '], 1: ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'], 3: ['#### ', '    #', '    #', ' ### ', '    #', '    #', '#### '],
  4: ['#   #', '#   #', '#   #', '#####', '    #', '    #', '    #'], 5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  6: [' ### ', '#    ', '#    ', '#### ', '#   #', '#   #', ' ### '], 7: ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  8: [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '], 9: [' ### ', '#   #', '#   #', ' ####', '    #', '    #', ' ### '],
};
const LETTER_COLORS = GEMS.map((g) => g.color);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const textMat = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.3 });
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _c = new THREE.Color();

function voxelText(lines, vox, depth, { colorful = true, hex = 0xd8dcf5 } = {}) {
  const cells = [];
  const H = lines.length * 8 - 1;
  let letter = 0;
  lines.forEach((str, li) => {
    const rowW = str.length * 6 - 1;
    [...str].forEach((ch, ci) => {
      const glyph = FONT[ch];
      if (!glyph) return;
      const color = colorful ? LETTER_COLORS[letter++ % LETTER_COLORS.length] : hex;
      glyph.forEach((row, gy) => [...row].forEach((px, gx) => {
        if (px === '#') cells.push({ x: ci * 6 + gx - rowW / 2, y: li * 8 + gy, color });
      }));
    });
  });
  const mesh = new THREE.InstancedMesh(unitBox, textMat, Math.max(1, cells.length));
  mesh.count = cells.length;
  mesh.frustumCulled = false;
  cells.forEach(({ x, y, color }, i) => {
    _m.compose(_p.set((x + 0.5) * vox, (H / 2 - y - 0.5) * vox, 0), _q.identity(), _s.set(vox * 0.96, vox * 0.96, depth));
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, _c.setHex(color));
  });
  const g = new THREE.Group(); g.add(mesh);
  return g;
}
function disposeText(g) { g.traverse((o) => o.isInstancedMesh && o.dispose()); }

function makeLabel(str, vox, depth, hex, parent = root) {
  const g = new THREE.Group();
  g.userData = { str: null, vox, depth, hex, pop: 0 };
  setLabel(g, str);
  g.userData.pop = 0;
  parent.add(g);
  return g;
}
function setLabel(g, str) {
  const u = g.userData;
  if (u.str === str) return;
  u.str = str;
  for (const old of [...g.children]) { g.remove(old); disposeText(old); }
  g.add(voxelText([str], u.vox, u.depth, { colorful: false, hex: u.hex }));
  u.pop = 1;
}

// floating score numbers
const floaters = [];
function floatText(str, x, y) {
  const g = voxelText(['+' + str], 0.0011, 0.002, { colorful: false, hex: 0xffffff });
  g.position.set(x, y, 0.006);
  root.add(g);
  floaters.push({ g, t: 0 });
}

// ---- HUD columns ---------------------------------------------------------------------------------
const DIM = 0x9aa0c8, BRIGHT = 0xffffff;
const hud3d = {
  scoreL: makeLabel('SCORE', 0.00105, 0.0015, DIM),
  score: makeLabel('0', 0.0012, 0.0026, BRIGHT),
  levelL: makeLabel('LEVEL', 0.00105, 0.0015, DIM),
  level: makeLabel('1', 0.0014, 0.003, GEMS[2].color),
  bestL: makeLabel('BEST', 0.00105, 0.0015, DIM),
  best: makeLabel('0', 0.0012, 0.0026, BRIGHT),
};
const BAR_W = 0.036, BAR_H = 0.0032;
const barBack = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, BAR_H, 0.002), new THREE.MeshStandardMaterial({ color: 0x24223f, roughness: 0.6 }));
const barFill = new THREE.Mesh(new THREE.BoxGeometry(1, BAR_H * 0.8, 0.003).translate(0.5, 0, 0),
  new THREE.MeshStandardMaterial({ color: GEMS[3].color, emissive: GEMS[3].color, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.3 }));
root.add(barBack, barFill);
const BOARD_HALF = N / 2 * CELL + CELL * 0.22;
const LAYOUT_HALF_W = BOARD_HALF + 0.03 + 0.026;
let sideX = BOARD_HALF + 0.03;
function layoutSide(halfW) {
  sideX = Math.max(BOARD_HALF + 0.024, Math.min(BOARD_HALF + 0.034, halfW - 0.026));
  const L = -sideX, R = sideX;
  hud3d.scoreL.position.set(L, 0.03, 0);
  hud3d.score.position.set(L, 0.019, 0);
  hud3d.levelL.position.set(L, -0.004, 0);
  hud3d.level.position.set(L, -0.016, 0);
  barBack.position.set(L, -0.029, 0);
  barFill.position.set(L - BAR_W / 2 + BAR_W * 0.05, -0.029, 0.0006);
  hud3d.bestL.position.set(R, 0.03, 0);
  hud3d.best.position.set(R, 0.019, 0);
}
function updateHud(dt) {
  setLabel(hud3d.score, String(S.score));
  setLabel(hud3d.level, String(S.level));
  setLabel(hud3d.best, String(S.best));
  for (const g of Object.values(hud3d)) {
    const u = g.userData;
    u.pop = Math.max(0, u.pop - dt * 3);
    g.scale.setScalar(1 + u.pop * 0.25);
  }
  const f = Math.min(1, S.levelPts / levelNeed(S.level));
  barFill.scale.set(Math.max(0.0001, (BAR_W * 0.9) * f), 1, 1);
}

// ---- banners -------------------------------------------------------------------------------------
const bannerStart = voxelText(['GEM SWAP', '3D'], 0.0022, 0.006);
const startTap = voxelText(['TAP TO PLAY'], 0.0013, 0.003, { colorful: false, hex: BRIGHT });
startTap.position.y = -0.03;
const startHow = voxelText(['SWAP GEMS TO MATCH 3'], 0.0008, 0.0015, { colorful: false, hex: DIM });
startHow.position.y = -0.041;
bannerStart.add(startTap, startHow);
const bannerShuffle = voxelText(['NO MOVES', 'SHUFFLE'], 0.0024, 0.006);
const bannerLevel = voxelText(['LEVEL'], 0.003, 0.007);
const levelBannerNum = makeLabel('2', 0.0045, 0.009, GEMS[2].color, bannerLevel);
levelBannerNum.position.y = -0.03;
const wordBanners = {};
function wordBanner(word) {
  if (!wordBanners[word]) { const b = voxelText([word], 0.0026, 0.006); b.visible = false; root.add(b); wordBanners[word] = b; }
  return wordBanners[word];
}
const BANNERS = [bannerStart, bannerShuffle, bannerLevel];
for (const b of BANNERS) { b.visible = false; root.add(b); }
let banner = null, bannerT = 0, bannerLife = Infinity;
function showBanner(b, life = Infinity) {
  if (banner) banner.visible = false;
  banner = b; bannerT = 0; bannerLife = life;
  if (b) b.visible = true;
}
function updateBanner(dt) {
  if (!banner) return;
  bannerT += dt;
  if (bannerT > bannerLife) { banner.visible = false; banner = null; return; }
  const p = Math.min(1, bannerT / 0.4);
  let s = p < 1 ? 1 + Math.sin(p * Math.PI) * 0.2 - (1 - p) * 0.6 : 1;
  if (bannerLife !== Infinity) s *= Math.min(1, (bannerLife - bannerT) / 0.25);
  banner.scale.setScalar(Math.max(0.02, s));
  banner.rotation.y = Math.sin(bannerT * 1.1) * 0.2;
  banner.rotation.x = Math.sin(bannerT * 0.8) * 0.06;
  banner.position.set(0, 0.008 + Math.sin(bannerT * 1.6) * 0.0015, 0.02);
}

// ---- per-frame update ----------------------------------------------------------------------------
let clock = 0;
const ease = (t) => t * t * (3 - 2 * t);

function update(dt) {
  clock += dt;
  S.t += dt;

  if (S.phase === 'swap' || S.phase === 'swapBack') {
    // The grid is already swapped: g1 came from a (now at b), g2 came from b (now at a).
    const k = ease(Math.min(1, S.t / SWAP_T));
    const u = S.phase === 'swap' ? k : 1 - k;
    const g1 = grid[S.b[0]][S.b[1]], g2 = grid[S.a[0]][S.a[1]];
    g1.gx = S.a[1] + (S.b[1] - S.a[1]) * u; g1.gy = S.a[0] + (S.b[0] - S.a[0]) * u;
    g2.gx = S.b[1] + (S.a[1] - S.b[1]) * u; g2.gy = S.b[0] + (S.a[0] - S.b[0]) * u;
    if (S.t >= SWAP_T) {
      if (S.phase === 'swap') afterSwap();
      else {                                   // un-swap the grid and return to idle
        const a = S.a, b = S.b;
        const g1 = grid[a[0]][a[1]], g2 = grid[b[0]][b[1]];
        grid[a[0]][a[1]] = g2; grid[b[0]][b[1]] = g1;
        g1.r = b[0]; g1.c = b[1]; g2.r = a[0]; g2.c = a[1];
        S.phase = 'idle';
      }
    }
  } else if (S.phase === 'clear') {
    if (S.t >= CLEAR_T) finishClear();
  } else if (S.phase === 'fall') {
    let moving = false;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const g = grid[r][c];
      if (!g) continue;
      g.gx = g.c;
      if (g.gy > g.r || g.vy !== 0) {
        g.vy -= FALL_G * dt;
        g.gy += g.vy * dt;
        if (g.gy <= g.r) {
          g.gy = g.r;
          g.vy = g.vy < -6 ? -g.vy * 0.18 : 0;   // small bounce on landing
        }
        moving = true;
      }
    }
    if (!moving) afterFall();
  } else if (S.phase === 'shuffle') {
    if (S.t >= 0.6) { shuffleBoard(); S.phase = 'fall'; }
  } else if (S.phase === 'idle') {
    S.idleT += dt;
    if (S.idleT >= HINT_AFTER && !S.hint) S.hint = findMove();
  }

  // gem transforms
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const g = grid[r]?.[c];
    if (!g) continue;
    const m = g.mesh;
    let z = 0, s = 1;
    const sel = S.selected && S.selected[0] === r && S.selected[1] === c && S.phase === 'idle';
    const hinted = S.hint && S.hint.a && ((S.hint.a[0] === r && S.hint.a[1] === c) || (S.hint.b[0] === r && S.hint.b[1] === c));
    if (g.clearing) {
      const k = Math.min(1, S.t / CLEAR_T);
      z = 0.012 * k;
      s = k < 0.35 ? 1 + k * 0.9 : Math.max(0.01, 1.3 * (1 - (k - 0.35) / 0.65));
    } else if (sel) {
      z = LIFT; s = 1.12;
    } else if (hinted) {
      const w = 0.5 + 0.5 * Math.sin(clock * 6);
      z = LIFT * 0.6 * w; s = 1 + 0.1 * w;
    }
    m.position.set(wx(g.gx), wy(g.gy), z);
    m.visible = g.gy < N + 0.1;
    m.scale.setScalar(s);
    const spin = sel ? clock * 3 : Math.sin(clock * 0.8 + g.phase) * 0.35;
    m.rotation.set(Math.sin(clock * 0.6 + g.phase) * 0.12, spin, 0);
    if (g.special === 'flame') {
      m.material.emissive.setHex(0xff6a00);
      m.material.emissiveIntensity = 0.45 + 0.35 * Math.sin(clock * 7 + g.phase);
    } else if (g.special === 'hyper') {
      m.rotation.set(clock * 1.3, clock * 1.7, clock * 0.9);
      const col = _c.setHSL((clock * 0.25 + g.phase) % 1, 0.9, 0.6);
      m.material.color.copy(col); m.material.emissive.copy(col);
    }
  }

  // sparks
  for (let i = sparkList.length - 1; i >= 0; i--) {
    const q = sparkList[i];
    q.life += dt;
    if (q.life > q.max) { sparkList.splice(i, 1); continue; }
    q.v.y -= 0.12 * dt;
    q.p.addScaledVector(q.v, dt);
    q.rot.x += dt * 5; q.rot.y += dt * 4;
  }
  sparkList.forEach((q, i) => {
    const k = 1 - q.life / q.max;
    _q.setFromEuler(q.rot);
    _m.compose(q.p, _q, _s.setScalar(q.size * (0.3 + 0.7 * k)));
    sparks.setMatrixAt(i, _m);
    sparks.setColorAt(i, _c.setHex(q.hex));
  });
  sparks.count = sparkList.length;
  sparks.instanceMatrix.needsUpdate = true;
  if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;

  // floating score numbers
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.t += dt;
    f.g.position.y += dt * 0.012;
    f.g.position.z += dt * 0.02;
    f.g.scale.setScalar(Math.min(1, f.t * 6) * (f.t > 0.7 ? Math.max(0.01, 1 - (f.t - 0.7) / 0.3) : 1));
    if (f.t > 1) { root.remove(f.g); disposeText(f.g); floaters.splice(i, 1); }
  }

  updateBanner(dt);
  updateHud(dt);
}

// ---- layout & rendering --------------------------------------------------------------------------
const monoCam = new THREE.PerspectiveCamera(30, 1.6, 0.005, 10);
monoCam.position.set(0, 0, (VDH / 2) / Math.tan(THREE.MathUtils.degToRad(15)));
monoCam.lookAt(0, 0, 0);

let sbsMode = false;
function sizeToCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 960, ch = canvas.clientHeight || 600;
  renderer.setSize(Math.round(cw * dpr) * (sbsMode ? 2 : 1), Math.round(ch * dpr), false);
  monoCam.aspect = cw / ch;
  monoCam.updateProjectionMatrix();
  const halfW = (VDH / 2) * (cw / ch);
  fit = Math.min(1, halfW / LAYOUT_HALF_W);
  root.scale.setScalar(fit);
  layoutSide(halfW / fit);
}
new ResizeObserver(sizeToCanvas).observe(canvas);
sizeToCanvas();

let last = 0;
function tick() {
  const now = performance.now();
  let dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
  last = now;
  while (dt > 0) { const step = Math.min(1 / 90, dt); update(step); dt -= step; }
}

const eyeCam = new THREE.PerspectiveCamera();
eyeCam.matrixAutoUpdate = false;
function setCameraFromView(view) {
  eyeCam.projectionMatrix.fromArray(view.projectionMatrix);
  eyeCam.projectionMatrixInverse.copy(eyeCam.projectionMatrix).invert();
  eyeCam.matrix.fromArray(view.transform.matrix);
  eyeCam.matrixWorld.copy(eyeCam.matrix);
  eyeCam.matrixWorldInverse.copy(eyeCam.matrixWorld).invert();
}
const feather = new EdgeFeather(THREE, { px: 26 });
const _size = new THREE.Vector2();

function onXRFrame(views, layer) {
  tick();
  renderer.getSize(_size);
  renderer.clear();
  renderer.setScissorTest(true);
  for (const view of views) {
    const vp = layer.getViewport(view) || fallbackHalf(view, views, _size);
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    setCameraFromView(view);
    renderer.render(scene, eyeCam);
    feather.render(renderer, vp);
  }
  renderer.setScissorTest(false);
}
function fallbackHalf(view, views, size) {
  const i = views.indexOf(view), half = size.x / 2;
  return { x: i === 0 ? 0 : half, y: 0, width: half, height: size.y };
}
function onMonoFrame() {
  requestAnimationFrame(onMonoFrame);
  tick();
  renderer.getSize(_size);
  renderer.clear();
  renderer.setViewport(0, 0, _size.x, _size.y);
  renderer.render(scene, monoCam);
}

// ---- boot ----------------------------------------------------------------------------------------
fillBoard();
for (const row of grid) for (const g of row) g.gy = g.r;       // attract screen: board at rest
showBanner(bannerStart);
update(0);
if (new URLSearchParams(location.search).has('debug')) window.gems = { S, get grid() { return grid; }, start, makeGem, removeGem, findMove, trySwap };

(async () => {
  const wall = await createInline3D({ lazy: false });
  if (wall.supported) {
    wall.addScene(canvas, onXRFrame, { virtualDisplayHeight: VDH });
    sbsMode = true;
    sizeToCanvas();
    console.log('[gems3d] inline-3D active: weaving glasses-free 3D');
  } else {
    document.title = 'Gem Swap 3D (2D preview)';
    console.log('[gems3d] 2D preview: open in the DisplayXR Browser on a 3D display for glasses-free 3D');
    requestAnimationFrame(onMonoFrame);
  }
})();

// Tetris 3D — falling blocks as a glasses-free 3D scene.
//
// Built on @displayxr/inline3d like the SDK's samples/hello-cube: one inline-3D session, one
// woven canvas, the three.js scene rendered once per eye into the halves the XRDisplayLayer
// reports. Any other browser gets a single mono camera.
//
// Depth layout (+z is toward the viewer, z = 0 is the glass):
//   * the well's blocks straddle the zero-disparity plane, so play stays crisp;
//   * a grid panel sits just behind them as a depth reference;
//   * cleared lines burst out toward the viewer; hard drops knock the well back into the screen;
//   * GAME OVER / PAUSED float a little in front of the glass.
// The canvas fills the window, so the HUD (score, level, lines, best) is voxel text in the
// scene's side columns rather than DOM over the woven canvas.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createInline3D } from '@displayxr/inline3d';
import { EdgeFeather } from '@displayxr/inline3d/three';

// ---- tuning (metres, seconds) — composed for a 12 cm-tall virtual display --------------------
const VDH = 0.12;
const CELL = 0.0055;                          // the well is ~95% of the display's height
const BOARD_YOFF = -0.0015;                   // leave the spawn row visible under the top edge
const COLS = 10, ROWS = 20, HIDDEN = 4;       // HIDDEN rows above the visible well for spawning
const DAS = 0.17, ARR = 0.05, SOFT_INTERVAL = 0.035;
const LOCK_DELAY = 0.5, LOCK_RESETS = 15, CLEAR_FLASH = 0.18;
const LINE_SCORES = [0, 100, 300, 500, 800];

const $ = (id) => document.getElementById(id);
const canvas = $('game');

// ---- renderer (same contract as hello-cube) -------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = null;
scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2440, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(0.4, 0.9, 0.8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fb4ff, 0.8);
rim.position.set(-0.6, -0.2, 0.5);
scene.add(rim);

// ---- pieces: shapes, SRS rotation states and kicks -------------------------------------------
const COLORS = { I: 0x2fd4e8, O: 0xf7d038, T: 0xa45ae6, S: 0x4cd964, Z: 0xf0524f, J: 0x3b7bf2, L: 0xf5953a };
const GREY = 0x4a4f66;
const SHAPES = {                              // [x, y] in the piece box, y down, rotation 0
  I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  O: { n: 3, cells: [[1, 0], [2, 0], [1, 1], [2, 1]], fixed: true },
  S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
};
const STATES = {};
for (const [t, s] of Object.entries(SHAPES)) {
  STATES[t] = [s.cells];
  for (let r = 1; r < 4; r++) {
    STATES[t].push(s.fixed ? s.cells : STATES[t][r - 1].map(([x, y]) => [s.n - 1 - y, x]));
  }
}
// SRS kick offsets, [dx, dy] with +y up.
const KICKS = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],     '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],    '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICKS_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],   '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],   '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],   '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],   '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// ---- game state ------------------------------------------------------------------------------
const G = {
  board: [], queue: [], cur: null, hold: null, holdUsed: false,
  score: 0, lines: 0, level: 1, best: 0,
  state: 'ready',                             // ready | playing | clearing | paused | over
  gravT: 0, lockT: 0, lockResets: 0, lowestY: 0,
  clearRows: [], clearT: 0, overT: 0,
};
const input = { left: false, right: false, soft: false, dir: 0, dasT: 0, arrT: 0 };
try { G.best = Number(localStorage.getItem('tetris3d-best')) || 0; } catch { /* storage unavailable */ }

const emptyRow = () => Array(COLS).fill(null);
const gravityInterval = (lvl) => Math.pow(Math.max(0.05, 0.8 - (lvl - 1) * 0.007), lvl - 1);

function refillQueue() {
  while (G.queue.length < 7) {
    const bag = Object.keys(SHAPES);
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    G.queue.push(...bag);
  }
}

function cellsOf(t, rot, px, py) { return STATES[t][rot].map(([x, y]) => [px + x, py - y]); }
function fits(t, rot, px, py) {
  for (const [c, r] of cellsOf(t, rot, px, py)) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS + HIDDEN || G.board[r][c]) return false;
  }
  return true;
}
const grounded = () => !fits(G.cur.t, G.cur.rot, G.cur.px, G.cur.py - 1);

function spawn(t) {
  G.cur = { t, rot: 0, px: 3, py: ROWS + 1 };
  G.gravT = 0; G.lockT = 0; G.lockResets = 0; G.lowestY = G.cur.py;
  if (!fits(t, 0, 3, G.cur.py)) { gameOver(); return; }
  if (fits(t, 0, 3, G.cur.py - 1)) G.cur.py--;        // guideline: drop one row on entry
}
function spawnNext() { refillQueue(); spawn(G.queue.shift()); }

function onMoved() {
  if (grounded() && G.lockResets < LOCK_RESETS) { G.lockT = 0; G.lockResets++; }
}
function move(dx) {
  const p = G.cur;
  if (!fits(p.t, p.rot, p.px + dx, p.py)) return false;
  p.px += dx; onMoved(); return true;
}
function rotate(dir) {
  const p = G.cur;
  if (SHAPES[p.t].fixed) return;
  const to = (p.rot + dir + 4) % 4;
  for (const [kx, ky] of (p.t === 'I' ? KICKS_I : KICKS)[`${p.rot}${to}`]) {
    if (fits(p.t, to, p.px + kx, p.py + ky)) { p.rot = to; p.px += kx; p.py += ky; onMoved(); return; }
  }
}
function stepDown() {
  const p = G.cur;
  if (!fits(p.t, p.rot, p.px, p.py - 1)) return false;
  p.py--;
  if (p.py < G.lowestY) { G.lowestY = p.py; G.lockResets = 0; G.lockT = 0; }
  return true;
}
function ghostY() {
  const p = G.cur; let y = p.py;
  while (fits(p.t, p.rot, p.px, y - 1)) y--;
  return y;
}
function hardDrop() {
  const y = ghostY();
  G.score += 2 * (G.cur.py - y);
  G.cur.py = y;
  wellKick = -0.006;
  lockPiece();
}
function holdPiece() {
  if (G.holdUsed) return;
  const t = G.cur.t;
  if (G.hold) spawn(G.hold); else spawnNext();
  G.hold = t;
  G.holdUsed = true;
}

function lockPiece() {
  const cells = cellsOf(G.cur.t, G.cur.rot, G.cur.px, G.cur.py);
  for (const [c, r] of cells) G.board[r][c] = G.cur.t;
  G.holdUsed = false;
  if (cells.every(([, r]) => r >= ROWS)) { G.cur = null; gameOver(); return; }   // lock out
  G.cur = null;
  const full = [];
  for (let r = 0; r < ROWS + HIDDEN; r++) if (G.board[r].every(Boolean)) full.push(r);
  if (full.length) {
    G.clearRows = full; G.clearT = 0; G.state = 'clearing';
    G.score += LINE_SCORES[full.length] * G.level;
    G.lines += full.length;
    G.level = 1 + Math.floor(G.lines / 10);
  } else {
    spawnNext();
  }
}
function finishClear() {
  for (const r of G.clearRows) {
    for (let c = 0; c < COLS; c++) burst(c, r, G.board[r][c]);
  }
  G.board = G.board.filter((_, r) => !G.clearRows.includes(r));
  while (G.board.length < ROWS + HIDDEN) G.board.push(emptyRow());
  G.clearRows = [];
  G.state = 'playing';
  spawnNext();
}

function start() {
  G.board = Array.from({ length: ROWS + HIDDEN }, emptyRow);
  G.queue = []; G.hold = null; G.holdUsed = false;
  G.score = 0; G.lines = 0; G.level = 1;
  G.state = 'playing';
  particles.length = 0;
  showBanner(null);
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  spawnNext();
}
function gameOver() {
  G.state = 'over'; G.overT = 0;
  if (G.score > G.best) {
    G.best = G.score;
    try { localStorage.setItem('tetris3d-best', String(G.best)); } catch { /* ignore */ }
  }
  showBanner(bannerOver);
}
function setPaused(on) {
  if (on && G.state === 'playing') { G.state = 'paused'; showBanner(bannerPaused); }
  else if (!on && G.state === 'paused') { G.state = 'playing'; showBanner(null); }
}

// ---- input -----------------------------------------------------------------------------------
const PLAY = () => G.state === 'playing';
addEventListener('keydown', (e) => {
  const k = e.code;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (k === 'KeyF') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); return; }
  if (G.state === 'ready' || G.state === 'over') {
    if (!e.repeat && (k === 'Enter' || k === 'Space' || k === 'KeyR')) start();
    return;
  }
  if (k === 'KeyP' || k === 'Escape') { if (!e.repeat) setPaused(G.state === 'playing'); return; }
  if (e.repeat && k !== 'ArrowDown') return;       // DAS is ours, not the OS key repeat
  if (k === 'ArrowLeft') { input.left = true; input.dir = -1; input.dasT = 0; input.arrT = 0; if (PLAY()) move(-1); }
  else if (k === 'ArrowRight') { input.right = true; input.dir = 1; input.dasT = 0; input.arrT = 0; if (PLAY()) move(1); }
  else if (k === 'ArrowDown') input.soft = true;
  else if (!PLAY()) return;
  else if (k === 'ArrowUp' || k === 'KeyX') rotate(1);
  else if (k === 'KeyZ' || k === 'ControlLeft' || k === 'ControlRight') rotate(-1);
  else if (k === 'Space') hardDrop();
  else if (k === 'KeyC' || k === 'ShiftLeft' || k === 'ShiftRight') holdPiece();
});
addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft') { input.left = false; input.dir = input.right ? 1 : 0; input.dasT = 0; }
  if (e.code === 'ArrowRight') { input.right = false; input.dir = input.left ? -1 : 0; input.dasT = 0; }
  if (e.code === 'ArrowDown') input.soft = false;
});
addEventListener('blur', () => { Object.assign(input, { left: false, right: false, soft: false, dir: 0 }); setPaused(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });

// Touch / mouse: tap rotates, horizontal drag moves a cell per step, a fast flick down hard-drops.
let gesture = null;
addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (G.state === 'ready' || G.state === 'over') { start(); return; }
  if (G.state === 'paused') { setPaused(false); return; }
  gesture = { x0: e.clientX, y0: e.clientY, x: e.clientX, t0: performance.now(), moved: false, dropped: false };
});
addEventListener('pointermove', (e) => {
  if (!gesture || !PLAY()) return;
  const step = Math.max(18, canvas.clientHeight / 26);
  while (e.clientX - gesture.x > step) { move(1); gesture.x += step; gesture.moved = true; }
  while (gesture.x - e.clientX > step) { move(-1); gesture.x -= step; gesture.moved = true; }
  const dy = e.clientY - gesture.y0, dt = performance.now() - gesture.t0;
  if (!gesture.dropped && dy > step * 3 && dy / Math.max(1, dt) > 0.6) { hardDrop(); gesture.dropped = true; gesture.moved = true; }
});
addEventListener('pointerup', (e) => {
  if (!gesture) return;
  const tap = !gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) < 10 && performance.now() - gesture.t0 < 300;
  if (tap && PLAY()) rotate(1);
  gesture = null;
});

// ---- scene: the well ---------------------------------------------------------------------------
const cellX = (c) => (c - (COLS - 1) / 2) * CELL;
const cellY = (r) => (r - (ROWS - 1) / 2) * CELL + BOARD_YOFF;
let wellKick = 0;                              // z offset after a hard drop, decays to 0

const well = new THREE.Group();
scene.add(well);
const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3f5c, roughness: 0.4, metalness: 0.6 });
const wallH = ROWS * CELL + CELL * 0.6;
for (const side of [-1, 1]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.35, wallH, CELL * 1.25), frameMat);
  wall.position.set(side * (COLS / 2 * CELL + CELL * 0.26), BOARD_YOFF - CELL * 0.3, 0);
  well.add(wall);
}
const floor = new THREE.Mesh(new THREE.BoxGeometry(COLS * CELL + CELL * 0.87, CELL * 0.35, CELL * 1.25), frameMat);
floor.position.set(0, cellY(0) - CELL * 0.68, 0);
well.add(floor);
const back = new THREE.Mesh(
  new THREE.PlaneGeometry(COLS * CELL, ROWS * CELL),
  new THREE.MeshStandardMaterial({ color: 0x141733, roughness: 1 }),
);
back.position.set(0, BOARD_YOFF, -CELL * 0.64);
well.add(back);
{
  const pts = [];
  const z = -CELL * 0.62, x0 = cellX(0) - CELL / 2, y0 = cellY(0) - CELL / 2;
  for (let c = 0; c <= COLS; c++) pts.push(x0 + c * CELL, y0, z, x0 + c * CELL, y0 + ROWS * CELL, z);
  for (let r = 0; r <= ROWS; r++) pts.push(x0, y0 + r * CELL, z, x0 + COLS * CELL, y0 + r * CELL, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  well.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2a3163 })));
}

// ---- instanced blocks ---------------------------------------------------------------------------
const blockGeo = new RoundedBoxGeometry(CELL * 0.94, CELL * 0.94, CELL * 0.94, 2, CELL * 0.14);
const blockMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.08 });
const MAX_SOLIDS = COLS * (ROWS + HIDDEN) + 4 + 4 * 4;
const solids = new THREE.InstancedMesh(blockGeo, blockMat, MAX_SOLIDS);
const ghost = new THREE.InstancedMesh(blockGeo,
  new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.5 }), 4);
const MAX_PARTICLES = COLS * 4;
const sparks = new THREE.InstancedMesh(blockGeo, new THREE.MeshStandardMaterial({ roughness: 0.3 }), MAX_PARTICLES);
for (const m of [solids, ghost, sparks]) {
  m.frustumCulled = false;
  for (let i = 0; i < m.count; i++) m.setColorAt(i, new THREE.Color(0xffffff));
  scene.add(m);
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const _c = new THREE.Color(), _w = new THREE.Color(0xffffff), _e = new THREE.Euler(), _v = new THREE.Vector3();
const IDENT = new THREE.Quaternion();
function put(mesh, i, x, y, z, scale, hex, quat = IDENT, whiten = 0) {
  _p.set(x, y, z); _s.setScalar(scale);
  _m.compose(_p, quat, _s);
  mesh.setMatrixAt(i, _m);
  _c.setHex(hex);
  if (whiten) _c.lerp(_w, whiten);
  mesh.setColorAt(i, _c);
}

// ---- line-clear bursts -----------------------------------------------------------------------------
const particles = [];
function burst(c, r, t) {
  if (particles.length >= MAX_PARTICLES) particles.shift();
  particles.push({
    p: new THREE.Vector3(cellX(c), cellY(r), 0),
    v: new THREE.Vector3((Math.random() - 0.5) * 0.08, 0.02 + Math.random() * 0.06, 0.03 + Math.random() * 0.05),
    spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
    rot: new THREE.Euler(), life: 0, hex: COLORS[t] ?? GREY,
  });
}

// ---- voxel text (labels and banners) ---------------------------------------------------------------
const FONT = {
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ### '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #', '#   #', '#   #'],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', '#    ', '#    ', ' ####'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '#####'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '## ##', '#   #'],
  0: [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  1: ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  3: ['#### ', '    #', '    #', ' ### ', '    #', '    #', '#### '],
  4: ['#   #', '#   #', '#   #', '#####', '    #', '    #', '    #'],
  5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  6: [' ### ', '#    ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  7: ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  8: [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  9: [' ### ', '#   #', '#   #', ' ####', '    #', '    #', ' ### '],
};
const LETTER_COLORS = [COLORS.Z, COLORS.L, COLORS.O, COLORS.S, COLORS.I, COLORS.J, COLORS.T];
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const textMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 });

// lines: array of strings; returns a Group centred on its middle.
function voxelText(lines, vox, depth, { colorful = true, hex = 0xb8bee0 } = {}) {
  const cells = [];
  const H = lines.length * 8 - 1;
  let W = 0, letter = 0;
  lines.forEach((str, li) => {
    const rowW = str.length * 6 - 1;
    W = Math.max(W, rowW);
    [...str].forEach((ch, ci) => {
      const glyph = FONT[ch];
      if (glyph) {
        const color = colorful ? LETTER_COLORS[letter++ % LETTER_COLORS.length] : hex;
        glyph.forEach((row, gy) => [...row].forEach((px, gx) => {
          if (px === '#') cells.push({ x: ci * 6 + gx - rowW / 2, y: li * 8 + gy, color });
        }));
      }
    });
  });
  const mesh = new THREE.InstancedMesh(unitBox, textMat, cells.length);
  mesh.frustumCulled = false;
  cells.forEach(({ x, y, color }, i) => {
    _m.compose(_p.set((x + 0.5) * vox, (H / 2 - y - 0.5) * vox, 0), IDENT, _s.set(vox * 0.96, vox * 0.96, depth));
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, _c.setHex(color));
  });
  const g = new THREE.Group(); g.add(mesh);
  g.userData.width = W * vox;
  return g;
}

// A voxel label whose text can change (score digits etc.); rebuilt only when the string changes.
function makeLabel(str, vox, depth, hex, popOnChange = false) {
  const g = new THREE.Group();
  g.userData = { str: null, vox, depth, hex, popOnChange, pop: 0 };
  setLabel(g, str);
  g.userData.pop = 0;
  scene.add(g);
  return g;
}
function setLabel(g, str) {
  const u = g.userData;
  if (u.str === str) return;
  u.str = str;
  for (const old of [...g.children]) { g.remove(old); old.children.forEach((m) => m.dispose?.()); }
  g.add(voxelText([str], u.vox, u.depth, { colorful: false, hex: u.hex }));
  if (u.popOnChange) u.pop = 1;
}

// ---- side columns: HOLD + stats on the left, NEXT + best on the right ----------------------------
const DIM = 0x9aa0c8, BRIGHT = 0xffffff;
const LBL = 0.00105, VAL = 0.0011;
const hud3d = {
  hold: makeLabel('HOLD', LBL, 0.0015, DIM),
  next: makeLabel('NEXT', LBL, 0.0015, DIM),
  scoreL: makeLabel('SCORE', LBL, 0.0015, DIM),
  score: makeLabel('0', VAL, 0.0024, BRIGHT),
  levelL: makeLabel('LEVEL', LBL, 0.0015, DIM),
  level: makeLabel('1', VAL, 0.0024, COLORS.O, true),
  linesL: makeLabel('LINES', LBL, 0.0015, DIM),
  lines: makeLabel('0', VAL, 0.0024, COLORS.I, true),
  bestL: makeLabel('BEST', LBL, 0.0015, DIM),
  best: makeLabel('0', VAL, 0.0024, BRIGHT),
};
let sideX = COLS / 2 * CELL + 0.04;
const colTop = cellY(ROWS - 1) + CELL * 0.3;
function layoutSide(halfW) {
  const inner = COLS / 2 * CELL + 0.022, outer = COLS / 2 * CELL + 0.042;
  sideX = Math.max(inner, Math.min(outer, halfW - 0.026));
  const L = -sideX, R = sideX;
  hud3d.hold.position.set(L, colTop, 0);
  hud3d.scoreL.position.set(L, colTop - 0.036, 0);
  hud3d.score.position.set(L, colTop - 0.047, 0);
  hud3d.levelL.position.set(L, colTop - 0.064, 0);
  hud3d.level.position.set(L, colTop - 0.075, 0);
  hud3d.linesL.position.set(L, colTop - 0.092, 0);
  hud3d.lines.position.set(L, colTop - 0.103, 0);
  hud3d.next.position.set(R, colTop, 0);
  hud3d.bestL.position.set(R, colTop - 0.078, 0);
  hud3d.best.position.set(R, colTop - 0.089, 0);
}
function updateHud(dt) {
  setLabel(hud3d.score, String(G.score));
  setLabel(hud3d.level, String(G.level));
  setLabel(hud3d.lines, String(G.lines));
  setLabel(hud3d.best, String(Math.max(G.best, G.score)));
  for (const g of Object.values(hud3d)) {
    const u = g.userData;
    if (u.pop > 0) u.pop = Math.max(0, u.pop - dt * 3);
    g.scale.setScalar(1 + u.pop * 0.35);
  }
}

// ---- banners -------------------------------------------------------------------------------------
const bannerStart = voxelText(['TAP TO', 'START'], 0.0024, 0.007);
const startSub = voxelText(['ARROWS MOVE', 'UP ROTATE', 'SPACE DROP', 'C HOLD', 'P PAUSE'], 0.00085, 0.0015, { colorful: false, hex: DIM });
startSub.position.y = -0.042;
bannerStart.add(startSub);
const bannerOver = voxelText(['GAME', 'OVER'], 0.0034, 0.009);
const overSub = voxelText(['TAP TO PLAY'], 0.0012, 0.003, { colorful: false, hex: BRIGHT });
overSub.position.y = -0.035;
bannerOver.add(overSub);
const bannerPaused = voxelText(['PAUSED'], 0.0022, 0.007);
const pausedSub = voxelText(['P TO RESUME'], 0.0011, 0.0025, { colorful: false, hex: BRIGHT });
pausedSub.position.y = -0.016;
bannerPaused.add(pausedSub);
const BANNERS = [bannerStart, bannerOver, bannerPaused];
for (const b of BANNERS) { b.visible = false; scene.add(b); }
let banner = null, bannerT = 0;
function showBanner(b) {
  for (const x of BANNERS) x.visible = x === b;
  banner = b; bannerT = 0;
}
function updateBanner(dt) {
  if (!banner) return;
  bannerT += dt;
  const p = Math.min(1, bannerT / 0.45);
  const pop = p < 1 ? 1 + Math.sin(p * Math.PI) * 0.2 - (1 - p) * 0.6 : 1;
  banner.scale.setScalar(Math.max(0.05, pop));
  banner.rotation.y = Math.sin(bannerT * 1.1) * 0.2;
  banner.rotation.x = Math.sin(bannerT * 0.8) * 0.06;
  banner.position.set(0, 0.004 + Math.sin(bannerT * 1.6) * 0.0015, 0.018);
}

// ---- per-frame update ---------------------------------------------------------------------------
let clock = 0;
function update(dt) {
  clock += dt;
  if (G.state === 'playing' && G.cur) {
    if (input.dir) {
      input.dasT += dt;
      if (input.dasT >= DAS) {
        input.arrT += dt;
        while (input.arrT >= ARR) { input.arrT -= ARR; if (!move(input.dir)) break; }
      }
    }
    const interval = input.soft ? Math.min(SOFT_INTERVAL, gravityInterval(G.level)) : gravityInterval(G.level);
    G.gravT += dt;
    while (G.gravT >= interval && G.cur) {
      G.gravT -= interval;
      if (stepDown()) { if (input.soft) G.score += 1; } else { G.gravT = 0; break; }
    }
    if (G.cur && grounded()) {
      G.lockT += dt;
      if (G.lockT >= LOCK_DELAY) lockPiece();
    }
  } else if (G.state === 'clearing') {
    G.clearT += dt;
    if (G.clearT >= CLEAR_FLASH) finishClear();
  } else if (G.state === 'over') {
    G.overT += dt;
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life += dt;
    if (q.life > 0.9) { particles.splice(i, 1); continue; }
    q.v.y -= 0.22 * dt;
    q.p.addScaledVector(q.v, dt);
    q.rot.x += q.spin.x * dt; q.rot.y += q.spin.y * dt; q.rot.z += q.spin.z * dt;
  }
  wellKick += (0 - wellKick) * Math.min(1, dt * 10);
  updateBanner(dt);
  updateHud(dt);
  draw();
}

function draw() {
  const zk = wellKick;
  well.position.z = zk;
  let n = 0;

  // locked cells (grey out from the bottom up on game over; flash rows being cleared)
  const greyRows = G.state === 'over' ? G.overT * 30 : -1;
  const flash = G.state === 'clearing' ? Math.min(1, G.clearT / (CLEAR_FLASH * 0.6)) : 0;
  for (let r = 0; r < G.board.length; r++) {
    const clearing = flash && G.clearRows.includes(r);
    for (let c = 0; c < COLS; c++) {
      const t = G.board[r]?.[c];
      if (!t) continue;
      const hex = r < greyRows ? GREY : COLORS[t];
      put(solids, n++, cellX(c), cellY(r), zk, clearing ? 1 + flash * 0.12 : 1, hex, IDENT, clearing ? flash * 0.85 : 0);
    }
  }

  // active piece + ghost
  let g = 0;
  if (G.cur && (G.state === 'playing' || G.state === 'paused')) {
    const p = G.cur;
    for (const [c, r] of cellsOf(p.t, p.rot, p.px, p.py)) put(solids, n++, cellX(c), cellY(r), zk, 1, COLORS[p.t]);
    const gy = ghostY();
    if (gy !== p.py) for (const [c, r] of cellsOf(p.t, p.rot, p.px, gy)) put(ghost, g++, cellX(c), cellY(r), zk, 0.98, COLORS[p.t]);
  }
  ghost.count = g;

  // hold (left) and the next three (right), turning slowly
  const preview = (t, cx, cy, scale, phase) => {
    const cells = STATES[t][0];
    const xs = cells.map(([x]) => x), ys = cells.map(([, y]) => y);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
    _e.set(0.35 + Math.sin(clock * 0.7 + phase) * 0.12, Math.sin(clock * 0.9 + phase) * 0.6, 0);
    _q.setFromEuler(_e);
    const dim = t === G.hold && G.holdUsed ? 0.45 : 0;
    for (const [x, y] of cells) {
      _v.set((x - mx) * CELL * scale, -(y - my) * CELL * scale, 0).applyQuaternion(_q);
      _p.set(cx + _v.x, cy + _v.y, _v.z);
      _s.setScalar(scale);
      _m.compose(_p, _q, _s);
      solids.setMatrixAt(n, _m);
      solids.setColorAt(n, _c.setHex(COLORS[t]).lerp(_c.clone().setHex(0x202433), dim));
      n++;
    }
  };
  const topY = colTop - 0.017;
  const NEXT_Y = [topY, colTop - 0.038, colTop - 0.056];
  if (G.hold) preview(G.hold, -sideX, topY, 1.15, 0);
  if (G.state !== 'ready') G.queue.slice(0, 3).forEach((t, i) => preview(t, sideX, NEXT_Y[i], i === 0 ? 1.15 : 0.85, i + 1));
  else preview('T', sideX, topY, 1.15, 1);
  solids.count = n;

  // bursts
  let s = 0;
  for (const q of particles) {
    const k = 1 - q.life / 0.9;
    _q.setFromEuler(q.rot);
    put(sparks, s++, q.p.x, q.p.y, q.p.z + zk, 0.3 + 0.7 * k, q.hex, _q, (1 - k) * 0.3);
  }
  sparks.count = s;

  for (const m of [solids, ghost, sparks]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

// ---- layout & rendering ------------------------------------------------------------------------
// Everything but the lights lives under one root, so a narrow window can scale it uniformly.
const LAYOUT_HALF_W = COLS / 2 * CELL + 0.042 + 0.026;
const root = new THREE.Group();
for (const o of [...scene.children]) if (!o.isLight) root.add(o);
scene.add(root);

const monoCam = new THREE.PerspectiveCamera(30, 1.6, 0.005, 10);
monoCam.position.set(0, 0, (VDH / 2) / Math.tan(THREE.MathUtils.degToRad(15)));
monoCam.lookAt(0, 0, 0);

let sbsMode = false;
function sizeToCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 960, ch = canvas.clientHeight || 600;
  const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  monoCam.aspect = cw / ch;
  monoCam.updateProjectionMatrix();
  // Narrower than the layout needs (e.g. a squarish window)? Shrink the whole scene to fit.
  const halfW = (VDH / 2) * (cw / ch);
  const fit = Math.min(1, halfW / LAYOUT_HALF_W);
  root.scale.setScalar(fit);
  layoutSide(halfW / fit);
}
new ResizeObserver(sizeToCanvas).observe(canvas);
sizeToCanvas();

let last = 0;
function tick() {
  const now = performance.now();
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  update(dt);
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

// ---- boot ------------------------------------------------------------------------------------
G.board = Array.from({ length: ROWS + HIDDEN }, emptyRow);
showBanner(bannerStart);
update(0);
if (new URLSearchParams(location.search).has('debug')) window.tetris = { G, start, spawn };

(async () => {
  const wall = await createInline3D({ lazy: false });
  if (wall.supported) {
    wall.addScene(canvas, onXRFrame, { virtualDisplayHeight: VDH });
    sbsMode = true;
    sizeToCanvas();
    console.log('[tetris3d] inline-3D active: weaving glasses-free 3D');
  } else {
    document.title = 'Tetris 3D (2D preview)';
    console.log('[tetris3d] 2D preview: open in the DisplayXR Browser on a 3D display for glasses-free 3D');
    requestAnimationFrame(onMonoFrame);
  }
})();

// Dino Run 3D — the offline-dino runner as a glasses-free 3D voxel scene.
//
// Built on @displayxr/inline3d the same way as the SDK's samples/hello-cube: one inline-3D
// session, one woven canvas, and a three.js scene rendered once per eye into the side-by-side
// halves the XRDisplayLayer reports. In any other browser it falls back to a single mono camera.
//
// Depth layout (+z is toward the viewer, z = 0 is the glass):
//   * the play lane (dino, cacti, pterodactyls) sits ON the zero-disparity plane, so the thing
//     you are reacting to is always crisp;
//   * the ground strip runs from slightly in front of the glass to well behind it, with pebbles
//     scattered through that depth for motion parallax;
//   * clouds float further back.
// The HUD is ordinary DOM above and below the canvas, never over it (no 2D-over-3D conflict).

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EdgeFeather } from '@displayxr/inline3d/three';

// ---- tuning: metres and seconds, composed for a 12 cm-tall virtual display ------------------
const VDH = 0.12;                    // virtualDisplayHeight handed to addScene
const VOX = 0.0018;                  // one sprite pixel
const LANE_DEPTH = VOX * 6;          // voxel thickness of lane sprites
const GROUND_Y = -0.038;
const SPEED0 = 0.24, SPEED_MAX = 0.52, ACCEL = 0.003;
const JUMP_V = 0.41, GRAVITY = 1.47, DROP_GRAVITY = 4.4, JUMP_CUT_V = 0.2, MIN_JUMP_H = 0.012;
const POINTS_PER_M = 36.7;
const NIGHT_EVERY = 700;

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const hiEl = document.getElementById('hi');
const curEl = document.getElementById('cur');
const msgEl = document.getElementById('msg');

// ---- renderer (same contract as hello-cube) -------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);           // getViewport() is in backing-store pixels
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = null;             // transparent, so EdgeFeather can dissolve the edges
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.35, 0.8, 0.6);
scene.add(sun);

// ---- palette: day and night, lerped --------------------------------------------------------
const PALETTE = {
  day:   { fg: 0x535353, eye: 0xf7f7f7, ground: 0xe7e7e7, cloud: 0xdadada },
  night: { fg: 0xd2d2d2, eye: 0x202124, ground: 0x2c2d31, cloud: 0x46484e },
};
const mats = {
  fg: new THREE.MeshLambertMaterial(),
  eye: new THREE.MeshBasicMaterial(),
  ground: new THREE.MeshBasicMaterial(),
  cloud: new THREE.MeshLambertMaterial(),
};
const _cA = new THREE.Color(), _cB = new THREE.Color();
function applyPalette(t) {
  for (const k of Object.keys(mats)) {
    mats[k].color.copy(_cA.setHex(PALETTE.day[k])).lerp(_cB.setHex(PALETTE.night[k]), t);
  }
}

// ---- voxel sprites ------------------------------------------------------------------------
// '#' = body voxel (also the collision mask), 'o' = eye voxel (drawn, never collides).
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();

function buildSprite(rows, { depth = LANE_DEPTH, bodyMat = mats.fg, scale = 1 } = {}) {
  const H = rows.length, W = Math.max(...rows.map((r) => r.length));
  const body = [], eye = [], cells = new Set();
  rows.forEach((row, r) => {
    const y = H - 1 - r;
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '#') { body.push([c, y]); cells.add(c + ',' + y); }
      else if (row[c] === 'o') eye.push([c, y]);
    }
  });
  const v = VOX * scale;
  const group = new THREE.Group();
  const add = (list, mat, d) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(unitBox, mat, list.length);
    list.forEach(([c, y], i) => {
      _m.makeScale(v, v, d);
      _m.setPosition((c - W / 2 + 0.5) * v, (y + 0.5) * v, 0);
      mesh.setMatrixAt(i, _m);
    });
    mesh.frustumCulled = false;       // instances live far from the unit box's bounds
    group.add(mesh);
  };
  add(body, bodyMat, depth);
  add(eye, mats.eye, depth * 1.04);
  return { group, W, H, v, body, cells, width: W * v, height: H * v };
}

function disposeSprite(s) {
  s.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
}

// Pixel-exact overlap of two sprites placed at (centre x, bottom y).
function spritesHit(a, ax, ay, b, bx, by) {
  const aL = ax - a.width / 2, bL = bx - b.width / 2;
  if (aL + a.width <= bL || bL + b.width <= aL || ay + a.height <= by || by + b.height <= ay) return false;
  for (const [c, y] of a.body) {
    const wx = aL + (c + 0.5) * a.v, wy = ay + (y + 0.5) * a.v;
    const bc = Math.floor((wx - bL) / b.v), br = Math.floor((wy - by) / b.v);
    if (b.cells.has(bc + ',' + br)) return true;
  }
  return false;
}

// ---- the dino --------------------------------------------------------------------------------
const DINO_TOP = [
  '            ########  ',
  '           ##o#######',
  '           ##########',
  '           ##########',
  '           #####     ',
  '           ########  ',
  '#         #####      ',
  '#        #######     ',
  '##      ##########   ',
  '###    ########  #   ',
  '############         ',
  ' ##########          ',
  '  #########          ',
  '   #######           ',
];
const DINO_DEAD_TOP = DINO_TOP.map((r, i) =>
  i === 1 ? '           #oo#######' : i === 2 ? '           #oo#######' : i === 4 ? '           ######    ' : r);
const LEGS = {
  stand: ['    ##  ##', '    #    #', '    ##   ##'],
  run1:  ['    ##  ##', '    #    ##', '    ##'],
  run2:  ['    ##  ##', '    ##   #', '         ##'],
};
const DUCK_TOP = [
  '                  ########   ',
  '###  ############ ##o######  ',
  '############################ ',
  ' ##########################  ',
  '  ##############   #####     ',
  '   ###########      #        ',
  '    ########                 ',
];
const DUCK_LEGS = {
  a: ['    ##  ##', '    #    ##'],
  b: ['    ##  ##', '    ##   #'],
};

const dinoFrames = {
  stand: buildSprite([...DINO_TOP, ...LEGS.stand]),
  run1: buildSprite([...DINO_TOP, ...LEGS.run1]),
  run2: buildSprite([...DINO_TOP, ...LEGS.run2]),
  duck1: buildSprite([...DUCK_TOP, ...DUCK_LEGS.a]),
  duck2: buildSprite([...DUCK_TOP, ...DUCK_LEGS.b]),
  dead: buildSprite([...DINO_DEAD_TOP, ...LEGS.stand]),
};
const dinoGroup = new THREE.Group();
for (const f of Object.values(dinoFrames)) { f.group.visible = false; dinoGroup.add(f.group); }
scene.add(dinoGroup);

const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 24),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }),
);
shadow.rotation.x = -Math.PI / 2;
scene.add(shadow);

// ---- obstacles -------------------------------------------------------------------------------
function cactusRows(h, trunk) {
  const W = trunk + 4;
  const grid = Array.from({ length: h }, () => Array(W).fill(' '));
  const set = (c, y) => { if (y >= 0 && y < h && c >= 0 && c < W) grid[h - 1 - y][c] = '#'; };
  for (let y = 0; y < h; y++) {
    for (let c = 2; c < 2 + trunk; c++) {
      if (y === h - 1 && trunk > 2 && (c === 2 || c === 1 + trunk)) continue;   // rounded top
      set(c, y);
    }
  }
  for (const left of [true, false]) {
    if (Math.random() < 0.2) continue;
    const at = Math.floor(h * (0.3 + Math.random() * 0.25));
    const len = Math.min(3 + Math.floor(Math.random() * 3), h - 3 - at);
    const xj = left ? 1 : W - 2, xc = left ? 0 : W - 1;
    set(xj, at); set(xj, at + 1);
    for (let y = at; y <= at + len; y++) set(xc, y);
  }
  return grid.map((r) => r.join(''));
}

const BIRD_UP = [
  '       ##         ',
  '       ###        ',
  '       ####       ',
  '   #   #####      ',
  '  ##   ######     ',
  ' ###o##########   ',
  '##################',
  '      ########### ',
  '       ########   ',
  '                  ',
  '                  ',
];
const BIRD_DOWN = [
  '                  ',
  '                  ',
  '                  ',
  '   #              ',
  '  ##              ',
  ' ###o##########   ',
  '##################',
  '      ########### ',
  '       #######    ',
  '       #####      ',
  '      ####        ',
];
// Bottom of the bird above the ground: jump over it / duck under it / run under it.
const BIRD_HEIGHTS = [0.004, 0.021, 0.04];

const obstacles = [];

function spawnObstacle(x0, speed) {
  if (speed > 0.33 && Math.random() < 0.25) {
    const a = buildSprite(BIRD_UP), b = buildSprite(BIRD_DOWN);
    b.group.visible = false;
    const g = new THREE.Group(); g.add(a.group, b.group); scene.add(g);
    const y = GROUND_Y + BIRD_HEIGHTS[Math.floor(Math.random() * BIRD_HEIGHTS.length)];
    obstacles.push({ kind: 'bird', frames: [a, b], sprite: a, group: g, x: x0 + a.width / 2, y, t: 0 });
    return a.width;
  }
  const large = speed > 0.27 && Math.random() < 0.5;
  const count = 1 + Math.floor(Math.random() * (speed > 0.3 ? 3 : 2));
  let x = x0;
  for (let i = 0; i < count; i++) {
    const s = large
      ? buildSprite(cactusRows(15 + Math.floor(Math.random() * 4), 3))
      : buildSprite(cactusRows(10 + Math.floor(Math.random() * 4), 2));
    scene.add(s.group);
    obstacles.push({ kind: 'cactus', frames: [s], sprite: s, group: s.group, x: x + s.width / 2, y: GROUND_Y, t: 0 });
    x += s.width + VOX;
  }
  return x - x0;
}

function clearObstacles() {
  for (const o of obstacles) { scene.remove(o.group); o.frames.forEach(disposeSprite); }
  obstacles.length = 0;
}

// ---- ground, pebbles, clouds -----------------------------------------------------------------
const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mats.ground);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.set(0, GROUND_Y - 0.0002, -0.018);
scene.add(groundPlane);

const horizon = new THREE.Mesh(unitBox, mats.fg);
horizon.position.set(0, GROUND_Y + VOX * 0.35, 0);
scene.add(horizon);

const PEBBLES = 120;
const pebbleMesh = new THREE.InstancedMesh(unitBox, mats.fg, PEBBLES);
pebbleMesh.frustumCulled = false;
scene.add(pebbleMesh);
const pebbles = [];

const CLOUD = [
  '      ######      ',
  '    ##########    ',
  '  ##############  ',
  ' ################ ',
  '##################',
];
const clouds = [];
for (let i = 0; i < 5; i++) {
  const s = buildSprite(CLOUD, { bodyMat: mats.cloud, scale: 2.2, depth: VOX * 2.2 * 3 });
  scene.add(s.group);
  clouds.push({ s, x: 0, y: 0, z: 0 });
}

// ---- GAME OVER: big voxel letters, just in front of the glass ---------------------------------
const FONT = {
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ### '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  ' ': ['   ', '   ', '   ', '   ', '   ', '   ', '   '],
};
function textRows(str) {
  return Array.from({ length: 7 }, (_, r) => [...str].map((ch) => FONT[ch][r]).join(' '));
}
const gameOverText = buildSprite(textRows('GAME OVER'), { depth: VOX * 3.5 });
const gameOverGroup = new THREE.Group();
gameOverText.group.position.y = -gameOverText.height / 2;     // pivot on the text's centre
gameOverGroup.add(gameOverText.group);
gameOverGroup.visible = false;
scene.add(gameOverGroup);
const GAME_OVER_Z = 0.012;           // ~1 cm out of the glass: pops, stays comfortable
let gameOverT = 0;

function updateGameOverText(dt) {
  if (!gameOverGroup.visible) return;
  gameOverT += dt;
  const fit = Math.min(0.21, 2 * halfW * 0.6) / gameOverText.width;
  // pop in with a little overshoot, then settle
  const p = Math.min(1, gameOverT / 0.45);
  const pop = p < 1 ? 1 + Math.sin(p * Math.PI) * 0.18 - (1 - p) * 0.6 : 1;
  gameOverGroup.scale.setScalar(fit * Math.max(0.05, pop));
  // slow sway so the letters' depth reads
  gameOverGroup.rotation.y = Math.sin(gameOverT * 1.1) * 0.18;
  gameOverGroup.rotation.x = Math.sin(gameOverT * 0.8) * 0.06;
  gameOverGroup.position.set(0, 0.016 + Math.sin(gameOverT * 1.6) * 0.002, GAME_OVER_Z);
}

// ---- layout ----------------------------------------------------------------------------------
let halfW = VDH * 1.5;               // half the virtual display's width at z = 0
const monoCam = new THREE.PerspectiveCamera(30, 3, 0.005, 10);
monoCam.position.set(0, 0, (VDH / 2) / Math.tan(THREE.MathUtils.degToRad(15)));
monoCam.lookAt(0, 0, 0);

const dinoX = () => -halfW + 0.06;
const spawnX = () => halfW + 0.07;
const cloudBound = (z) => (halfW + 0.12) * (1 + -z / 0.25);

function resetPebble(p, anywhere) {
  p.x = anywhere ? (Math.random() * 2 - 1) * (halfW + 0.08) : halfW + 0.08 + Math.random() * 0.04;
  p.z = -0.06 + Math.random() * 0.084;
  p.s = VOX * (0.6 + Math.random() * 1.2);
}
function resetCloud(c, anywhere) {
  c.z = -0.1 - Math.random() * 0.12;
  const b = cloudBound(c.z);
  c.x = anywhere ? (Math.random() * 2 - 1) * b : b + Math.random() * 0.1;
  c.y = 0.025 + Math.random() * 0.045;   // behind the glass they project lower, so lift them
}

function layoutWorld(first) {
  const L = 2 * halfW + 0.3;
  groundPlane.scale.set(L, 0.086, 1);
  horizon.scale.set(L, VOX * 0.7, LANE_DEPTH);
  if (first) {
    for (let i = 0; i < PEBBLES; i++) { const p = {}; resetPebble(p, true); pebbles.push(p); }
    for (const c of clouds) resetCloud(c, true);
  }
}

let sbsMode = false;
function sizeToCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 900, ch = canvas.clientHeight || 300;
  const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  monoCam.aspect = cw / ch;
  monoCam.updateProjectionMatrix();
  halfW = (VDH / 2) * (cw / ch);
  layoutWorld(pebbles.length === 0);
}
new ResizeObserver(sizeToCanvas).observe(canvas);
sizeToCanvas();

// ---- game state ------------------------------------------------------------------------------
const game = {
  state: 'ready',                    // ready | running | over
  speed: SPEED0, score: 0, hi: 0, nextMilestone: 100,
  gap: 0.25, overAt: 0,
  night: 0, nightTarget: 0,
};
const dino = { y: 0, vy: 0, airborne: false, runT: 0 };
const input = { jump: false, down: false };

try { game.hi = Number(localStorage.getItem('dino3d-hi')) || 0; } catch { /* storage unavailable */ }

const pad = (n) => String(Math.floor(n)).padStart(5, '0');
function updateHud() {
  hiEl.textContent = 'HI ' + pad(game.hi);
  curEl.textContent = pad(game.score);
}

function startJump() {
  if (dino.airborne) return;
  dino.vy = JUMP_V;
  dino.airborne = true;
}

function restart() {
  clearObstacles();
  Object.assign(game, { state: 'running', speed: SPEED0, score: 0, nextMilestone: 100, gap: 0.25, nightTarget: 0 });
  Object.assign(dino, { y: 0, vy: 0, airborne: false, runT: 0 });
  msgEl.textContent = '';
  gameOverGroup.visible = false;
  updateHud();
}

function gameOver(now) {
  if (game.state !== 'running') return;
  game.state = 'over';
  gameOverGroup.visible = true;
  gameOverT = 0;
  game.overAt = now;
  if (game.score > game.hi) {
    game.hi = Math.floor(game.score);
    try { localStorage.setItem('dino3d-hi', String(game.hi)); } catch { /* ignore */ }
  }
  msgEl.textContent = 'SPACE OR TAP TO RESTART';
  updateHud();
}

function pressJump() {
  input.jump = true;
  const now = performance.now();
  if (game.state === 'ready') { restart(); startJump(); }
  else if (game.state === 'over') { if (now - game.overAt > 400) { restart(); startJump(); } }
  else startJump();
}

addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    if (!e.repeat) pressJump();
  } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    e.preventDefault();
    input.down = true;
  } else if (e.code === 'KeyF') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') input.jump = false;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') input.down = false;
});
addEventListener('pointerdown', (e) => { if (e.button === 0) pressJump(); });
addEventListener('pointerup', () => { input.jump = false; });
addEventListener('blur', () => { input.jump = false; input.down = false; });

// ---- simulation --------------------------------------------------------------------------------
function currentDinoFrame() {
  if (game.state === 'over') return dinoFrames.dead;
  if (game.state !== 'running' || dino.airborne) return dinoFrames.stand;
  const alt = Math.floor(dino.runT / 0.1) % 2 === 0;
  if (input.down) return alt ? dinoFrames.duck1 : dinoFrames.duck2;
  return alt ? dinoFrames.run1 : dinoFrames.run2;
}

function update(dt, now) {
  const running = game.state === 'running';
  const speed = running ? game.speed : 0;

  if (running) {
    game.speed = Math.min(SPEED_MAX, game.speed + ACCEL * dt);
    game.score += game.speed * dt * POINTS_PER_M;
    if (game.score >= game.nextMilestone) {
      game.nextMilestone += 100;
      curEl.classList.remove('blink'); void curEl.offsetWidth; curEl.classList.add('blink');
    }
    game.nightTarget = Math.floor(game.score / NIGHT_EVERY) % 2;
    updateHud();

    // dino physics
    dino.runT += dt;
    if (dino.airborne) {
      if (!input.jump && dino.vy > JUMP_CUT_V && dino.y > MIN_JUMP_H) dino.vy = JUMP_CUT_V;
      dino.vy -= (input.down ? DROP_GRAVITY : GRAVITY) * dt;
      dino.y += dino.vy * dt;
      if (dino.y <= 0) { dino.y = 0; dino.vy = 0; dino.airborne = false; }
    }

    // spawning
    game.gap -= speed * dt;
    if (game.gap <= 0) {
      const w = spawnObstacle(spawnX(), game.speed);
      game.gap = w + (0.1 + game.speed * 0.45) * (1 + Math.random() * 0.7);
    }
  }

  // obstacles
  const frame = currentDinoFrame();
  const dx = dinoX(), dy = GROUND_Y + dino.y;
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    if (running) o.x -= speed * dt * (o.kind === 'bird' ? 1.12 : 1);
    if (o.kind === 'bird') {
      o.t += dt;
      const f = Math.floor(o.t / 0.16) % 2;
      o.frames[0].group.visible = f === 0;
      o.frames[1].group.visible = f === 1;
      o.sprite = o.frames[f];
    }
    o.group.position.set(o.x, o.y, 0);
    if (o.x + o.sprite.width / 2 < -halfW - 0.08) {
      scene.remove(o.group); o.frames.forEach(disposeSprite); obstacles.splice(i, 1);
      continue;
    }
    if (running && spritesHit(frame, dx, dy, o.sprite, o.x, o.y)) gameOver(now);
  }

  // dino pose
  const shown = currentDinoFrame();
  for (const f of Object.values(dinoFrames)) f.group.visible = f === shown;
  dinoGroup.position.set(dx, dy, 0);
  const lift = Math.min(1, dino.y / 0.07);
  const sw = (shown.width * 0.5) * (1 - lift * 0.35);
  shadow.scale.set(sw, LANE_DEPTH * 0.9 * (1 - lift * 0.35), 1);
  shadow.position.set(dx + VOX, GROUND_Y + 0.0004, 0);
  shadow.material.opacity = 0.16 * (1 - lift * 0.6);

  // pebbles
  for (let i = 0; i < PEBBLES; i++) {
    const p = pebbles[i];
    p.x -= speed * dt;
    if (p.x < -halfW - 0.08) resetPebble(p, false);
    _m.makeScale(p.s * 1.6, p.s * 0.6, p.s);
    _m.setPosition(p.x, GROUND_Y + p.s * 0.3, p.z);
    pebbleMesh.setMatrixAt(i, _m);
  }
  pebbleMesh.instanceMatrix.needsUpdate = true;

  // clouds drift slowly even before the run starts
  for (const c of clouds) {
    c.x -= (speed * 0.25 + 0.006) * dt;
    if (c.x < -cloudBound(c.z)) resetCloud(c, false);
    c.s.group.position.set(c.x, c.y, c.z);
  }

  updateGameOverText(dt);

  // day / night
  const k = Math.min(1, dt / 0.6);
  game.night += (game.nightTarget - game.night) * k * 3;
  applyPalette(game.night);
  document.body.classList.toggle('night', game.nightTarget === 1);
}

// Fixed sub-steps keep game speed and collisions right at any frame rate; a long stall
// (tab hidden) is capped so the dino doesn't teleport through a cactus.
let last = 0;
function tick() {
  const now = performance.now();
  let dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
  last = now;
  if (dt === 0) { update(0, now); return; }
  while (dt > 0) {
    const step = Math.min(1 / 120, dt);
    update(step, now);
    dt -= step;
  }
}

// ---- rendering -------------------------------------------------------------------------------
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
applyPalette(0);
updateHud();
update(0, performance.now());

(async () => {
  const wall = await createInline3D({ lazy: false });
  if (wall.supported) {
    wall.addScene(canvas, onXRFrame, { virtualDisplayHeight: VDH });
    sbsMode = true;
    sizeToCanvas();
    statusEl.textContent = 'GLASSES-FREE 3D ON · MOVE YOUR HEAD';
  } else {
    statusEl.textContent = '2D PREVIEW · OPEN IN THE DISPLAYXR BROWSER FOR 3D';
    requestAnimationFrame(onMonoFrame);
  }
})();

// Backing-store sizing shared by the arcade pages (the SDK's display-modes sample, plus a GPU cap).
//
// While woven the canvas is DOUBLE-WIDTH in device px (left eye | right eye). A full-window canvas
// on a tablet asks for more than the GPU allows: 2560 CSS-wide panel × dpr × 2 is 5000+ px, and
// Chrome on Android caps WebGL at 4096 on many Adreno GPUs. The browser then clamps the drawing
// buffer SILENTLY, while canvas.width (which getViewport() splits in half) keeps the requested
// size, so each eye's viewport runs off the real buffer and the picture comes out zoomed and
// off-centre. On a 4K Windows panel the cap is 16384, which is why it only broke on tablets.
//
// So: honour the runtime's recommended view scale (advisory; only the page can act on it), and
// shrink uniformly until the whole buffer fits the GPU's limits.

let viewScale = { x: 1, y: 1 };

/** Read the panel's recommended per-view scale, where the browser exposes it. */
export async function readViewScale(wall) {
  try {
    const info = typeof wall.getDisplayInfo === 'function' ? await wall.getDisplayInfo() : null;
    if (info) viewScale = { x: info.recommendedViewScaleX || 1, y: info.recommendedViewScaleY || 1 };
  } catch {
    // Older browsers have no display-mode API: full resolution, capped below.
  }
  return viewScale;
}

/** Size `renderer`'s backing store for `canvas`; `sbs` doubles the width for the two eyes. */
export function sizeBackingStore(renderer, canvas, cw, ch, sbs) {
  const dpr = window.devicePixelRatio || 1;
  const cols = sbs ? 2 : 1;
  let w = Math.max(1, Math.round(cw * dpr * viewScale.x));
  let h = Math.max(1, Math.round(ch * dpr * viewScale.y));
  const gl = renderer.getContext();
  const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const maxW = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), dims[0]);
  const maxH = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), dims[1]);
  const k = Math.min(1, maxW / (w * cols), maxH / h);
  w = Math.floor(w * k);
  h = Math.floor(h * k);
  renderer.setSize(w * cols, h, false);
  // The browser can still hand back a smaller buffer (memory pressure). Match canvas.width to what
  // it really allocated, keeping the aspect, so getViewport() splits the buffer that exists.
  const got = Math.min(gl.drawingBufferWidth / (w * cols), gl.drawingBufferHeight / h);
  if (got < 0.999) {
    w = Math.floor(w * got);
    h = Math.floor(h * got);
    renderer.setSize(w * cols, h, false);
  }
  return { width: w * cols, height: h };
}

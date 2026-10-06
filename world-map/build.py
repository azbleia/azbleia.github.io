"""Turn a single relief-map photo into a displaced 3D mesh (.glb).

Pipeline:
  1. Monocular depth with Depth Anything V2 (Large), run at high resolution.
  2. Remove the global tilt/perspective the model hallucinates, using the ocean as a flat reference.
  3. Blend with a colour-based land mask so continents sit on a clean raised plateau,
     while keeping the model's fine carved detail.
  4. Bake a normal map (depth + image high-pass for wood grain).
  5. Build a grid mesh, displace it, export GLB with PBR material.

Usage: .venv/bin/python build.py [source.jpg] [--grid 1200]
"""
import argparse
from pathlib import Path

import cv2
import numpy as np
import torch
import trimesh
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

ap = argparse.ArgumentParser()
ap.add_argument("src", nargs="?", default="source.jpg")
ap.add_argument("--out", default="out")
ap.add_argument("--grid", type=int, default=1200, help="mesh vertices along the long edge")
ap.add_argument("--relief", type=float, default=0.035, help="max relief height as fraction of width")
ap.add_argument("--model", default="depth-anything/Depth-Anything-V2-Large-hf")
args = ap.parse_args()

out = Path(args.out)
out.mkdir(exist_ok=True)
img = Image.open(args.src).convert("RGB")
W, H = img.size
rgb = np.asarray(img).astype(np.float32) / 255.0

# ---------------------------------------------------------------- 1. depth
dev = "cuda" if torch.cuda.is_available() else "cpu"
proc = AutoImageProcessor.from_pretrained(args.model)
model = AutoModelForDepthEstimation.from_pretrained(args.model).to(dev).eval()


def run_depth(pil, long_side):
    # Input sides must be multiples of 14 (ViT patch size).
    s = long_side / max(pil.size)
    w = int(round(pil.size[0] * s / 14) * 14)
    h = int(round(pil.size[1] * s / 14) * 14)
    inp = proc(images=pil, return_tensors="pt", size={"height": h, "width": w},
               keep_aspect_ratio=False, do_resize=True)
    with torch.no_grad():
        d = model(pixel_values=inp.pixel_values.to(dev)).predicted_depth
    d = torch.nn.functional.interpolate(d[None], size=(H, W), mode="bicubic", align_corners=False)
    return d[0, 0].float().cpu().numpy()


# Low-res pass gets coherent global shape, high-res pass gets fine detail; combine.
d_lo = run_depth(img, 518)
d_hi = run_depth(img, 1540)
norm = lambda a: (a - np.percentile(a, 1)) / (np.percentile(a, 99) - np.percentile(a, 1) + 1e-8)
d_lo, d_hi = norm(d_lo), norm(d_hi)
big = lambda a, s: cv2.GaussianBlur(a, (0, 0), s)
depth = big(d_lo, 12) + (d_hi - big(d_hi, 12))  # low freq from lo, high freq from hi
del model
torch.cuda.empty_cache()

# ---------------------------------------------------------------- 2. land mask
# Land is warm beige (R > B), ocean is teal (B,G > R). Use a brightness-normalised
# hue test so deeply shadowed carving still counts as land.
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
warm = (r - b) / (r + g + b + 1e-3)
mask = (warm > 0.02).astype(np.uint8)
mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))


def drop_small(m, min_area):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    return keep[lab].astype(np.uint8)


mask = drop_small(mask, 40)                 # specks in the ocean texture
mask = 1 - drop_small(1 - mask, 150)        # pinholes in land (keeps real lakes/bays)
mask = mask.astype(np.float32)

# ---------------------------------------------------------------- 3. de-tilt
# Fit a smooth surface to the ocean depth and subtract it, so the sea is flat.
ocean = mask < 0.5
ocean_e = cv2.erode(ocean.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
xn, yn = xx / W - 0.5, yy / H - 0.5
A = np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn], -1)
sel = ocean_e[::4, ::4]
coef, *_ = np.linalg.lstsq(A[::4, ::4][sel], depth[::4, ::4][sel], rcond=None)
depth = depth - A @ coef

# ---------------------------------------------------------------- 4. compose height
# Plateau: soft-edged land mask (carved edges have a slight bevel).
dist = cv2.distanceTransform((mask > 0.5).astype(np.uint8), cv2.DIST_L2, 5)
plateau = np.clip(dist / 6.0, 0, 1) ** 0.6
plateau = big(plateau, 1.0)

# Land detail: model depth relative to its local mean, only on land.
land_detail = depth - big(depth, 40)
land_detail = land_detail / (np.percentile(np.abs(land_detail[mask > 0.5]), 98) + 1e-8)
land_detail = np.clip(land_detail, -1.5, 1.5)
# Broad terrain (mountain ranges etc.) from the model, within land.
land_broad = big(depth, 40)
lb = land_broad[mask > 0.5]
land_broad = np.clip((land_broad - np.percentile(lb, 2)) / (np.percentile(lb, 98) - np.percentile(lb, 2) + 1e-8), 0, 1)

# Ocean: gentle swells from the model, heavily damped.
ocean_detail = depth - big(depth, 3)
ocean_detail /= (np.percentile(np.abs(ocean_detail[ocean]), 98) + 1e-8)

height = (
    0.55 * plateau
    + plateau * (0.30 * land_broad + 0.15 * land_detail)
    + (1 - plateau) * 0.04 * np.clip(ocean_detail, -1.5, 1.5)
)
height = big(height, 0.7)
height = (height - height.min()) / (height.max() - height.min())

cv2.imwrite(str(out / "height16.png"), (height * 65535).astype(np.uint16))
cv2.imwrite(str(out / "height_preview.png"), (height * 255).astype(np.uint8))
cv2.imwrite(str(out / "mask.png"), (mask * 255).astype(np.uint8))

# ---------------------------------------------------------------- 5. normal map
# Fine surface normal: height gradient + image luminance high-pass (wood grain / sea texture).
lum = cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
grain = lum - big(lum, 2.0)
hn = height * 6.0 + grain * 0.6
gx = cv2.Sobel(hn, cv2.CV_32F, 1, 0, ksize=3)
gy = cv2.Sobel(hn, cv2.CV_32F, 0, 1, ksize=3)
nrm = np.stack([-gx, gy, np.ones_like(gx)], -1)  # +Y up in tangent space (OpenGL/glTF)
nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
cv2.imwrite(str(out / "normal.png"), cv2.cvtColor(((nrm * 0.5 + 0.5) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))

# Roughness: land slightly smoother (sanded wood), ocean matte.
rough = 0.62 + 0.25 * (1 - plateau) - 0.08 * np.clip(grain * 8, -1, 1)
rough = np.clip(rough, 0, 1)
orm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1)  # glTF: R=AO G=rough B=metal
Image.fromarray((orm * 255).astype(np.uint8)).save(out / "orm.png")

# ---------------------------------------------------------------- 6. mesh
gw = args.grid
gh = int(round(gw * H / W))
width = 1.0  # metres; viewer scales it
hgt_m = width * H / W
hs = cv2.resize(height, (gw, gh), interpolation=cv2.INTER_AREA)
u = np.linspace(0, 1, gw, dtype=np.float32)
v = np.linspace(0, 1, gh, dtype=np.float32)
U, V = np.meshgrid(u, v)
verts = np.stack([(U - 0.5) * width, (0.5 - V) * hgt_m, hs * args.relief * width], -1).reshape(-1, 3)
uv = np.stack([U, 1 - V], -1).reshape(-1, 2)
idx = np.arange(gw * gh).reshape(gh, gw)
a, b_, c, d = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
faces = np.concatenate([np.stack([a, c, b_], -1).reshape(-1, 3),
                        np.stack([b_, c, d], -1).reshape(-1, 3)])

mat = trimesh.visual.material.PBRMaterial(
    baseColorTexture=img,
    normalTexture=Image.open(out / "normal.png"),
    metallicRoughnessTexture=Image.open(out / "orm.png"),
    metallicFactor=0.0,
    roughnessFactor=1.0,
)
mesh = trimesh.Trimesh(verts, faces, visual=trimesh.visual.TextureVisuals(uv=uv, material=mat), process=False)
mesh.export(out / "relief.glb")
print(f"mesh: {len(verts):,} verts, {len(faces):,} tris -> {out/'relief.glb'}")

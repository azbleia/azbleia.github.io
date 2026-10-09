# World Map (glasses-free 3D)

A single photo of a carved relief world map turned into a 3D mesh and shown on a DisplayXR
3D display through the `@displayxr/inline3d` SDK. Falls back to a flat view in other browsers.

- `build.py`: depth (Depth Anything V2) → height/normal/roughness maps → `out/relief.glb`
- `index.html`: three.js viewer; 2D/3D toggle (bottom right, or **T**: 2D flattens to one fixed viewpoint with the lens left on), depth **−/=**, light **L**

Cursor (3D display only; the OS pointer is replaced by a 3D cursor that sits on whatever is under it):
- default: an arrow; `?cursor=sdk`: the DisplayXR SDK `DepthCursor` crosshair (depth-cursor branch build)
- **C** switches placement: *world-fixed* (a point in the scene in front of the pointer, with real motion parallax) or *head-locked* (on the line from the eyes through the pointer, so it always covers it, with no parallax); `&anchor=head` starts head-locked
- `?tune` shows a *Button depth* slider (0–3×, default 0.6×) for the in-scene 2D/3D buttons; `?uidepth=` sets it directly
- `&margin=0.003` sets the SDK cursor's float above the surface; `&debug` logs stereo/cursor state to the server

World map photo by [Vecteezy](https://www.vecteezy.com/photo/71161499-detailed-world-map-is-shown-with-beige-continents-and-a-turquoise-sea-background).

# World map relief (glasses-free 3D)

A single photo of a carved relief world map turned into a 3D mesh and shown on a DisplayXR
3D display through the `@displayxr/inline3d` SDK. Falls back to a flat view in other browsers.

- `build.py`: depth (Depth Anything V2) → height/normal/roughness maps → `out/relief.glb`
- `index.html`: three.js viewer; 2D/3D toggle (bottom right, or **T**: 2D flattens to one fixed viewpoint with the lens left on), depth **−/=**, light **L**

World map photo by [Vecteezy](https://www.vecteezy.com/photo/71161499-detailed-world-map-is-shown-with-beige-continents-and-a-turquoise-sea-background).

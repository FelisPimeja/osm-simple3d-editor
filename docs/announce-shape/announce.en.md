# OSM Simple 3D: you can now reshape buildings right in 3D

Hey everyone! I've added a new tool to [OSM Simple 3D](https://felispimeja.github.io/osm-simple3d-editor/), my browser-based 3D building editor for OSM. It's called **Shape (V)**. With it you can change a building's footprint and roof right in the 3D view, without switching to a flat map.

![GIF 1](shape-1.gif)

## How it works

- **Move vertices.** Grab a corner and drag it. It only moves sideways, so walls stay straight, and the roof rebuilds as you go. It snaps to the usual stuff: building axes, side extensions, nearby corners and midpoints. Want an exact distance? Type a number and hit Enter.
- **Add and remove vertices.** Click a side to add a vertex, and drag it out if needed. Del removes a vertex. Drop a vertex onto its neighbour and they merge. Shift+click or Shift+box lets you grab several vertices at once.
- **Neighbours.** Press D to choose whether shared corners drag the neighbouring building along or get detached from it.
- **Roof and walls.** Pull the teal handles to make the roof taller or flatter, all the way down to zero and back up. Pull the purple ones to raise or lower the walls, and the roof rides along. While you drag, the editor shows which tags will change, such as `roof:height: 3 → 4.5`.

![GIF 2](shape-2.gif)

## Small bonus

- Push (P) now highlights the face you're about to move, and it snaps to the building's own points too.
- The selected part now gets a blue outline in the normal view, not just in wireframe.

## Give it a spin

Open the [editor](https://felispimeja.github.io/osm-simple3d-editor/), pick a building and press V. I'd love to hear what you think, especially anything that feels clunky or confusing. Leave a comment here or open a [GitHub issue](https://github.com/FelisPimeja/osm-simple3d-editor/issues). Next up: cutting courtyards into buildings and merging parts back together.

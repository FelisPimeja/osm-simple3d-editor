# OSM Simple 3D: building passages and first windows

Hey everyone! Two new things: building passages that you can draw and edit, and an early, experimental take on windows.

![Screenshot 1](passage-1.png)

## Building passages

Ways tagged `tunnel=building_passage` now cut a real opening through the building — side walls and a ceiling included — instead of the road just disappearing into the wall.

- **Size from tags.** The opening is as wide as `width` (or `est_width`, `maxwidth`, or the `lanes` count). Without any of those, the width depends on the way type: a footway gets a narrow opening, a service road a wider one. The height comes from `maxheight`, or the top of the first level if it's missing.
- **Railways too.** A `railway=*` passage gets the structure gauge and is drawn with ballast and two rails.
- **Select and edit.** Click the opening or its floor to select the way. The passage card shows `highway`, `width` and `maxheight`, with defaults greyed out so you can see what the editor assumed. Drag the width handles across the passage to change `width`, or reshape the way with Shape (V) — the cut follows as you drag.
- **Draw new ones.** There's a new **Passage** tool: in building mode, and in the wall/stairs group on floor plans. Draw a line through the building, and it's cut right away. A new passage gets only `tunnel=building_passage`; what kind of way it is (`highway=*`, `railway=*`) is up to you.

![Screenshot 2](passage-2.png)

## Windows (experimental)

Windows are behind two test options in the settings, both off by default. You can turn them on independently.

- **Windows from tags.** Nodes on the building outline tagged `window=*` get a window recess on their level. Size comes from `window:width`, `window:height` and `window:breast`; without them the editor falls back to the OSM2World defaults. `window=yes` on an entrance node is treated as a glazed door, not a window.
- **Generated windows.** Buildings with `building:levels` and no mapped windows get rows of windows on every level, evenly spaced along each wall. Entrances, passages, blind walls touching other buildings, glass facades and utility buildings are skipped, and so is anything tagged `window=no`.

![Screenshot 3](windows-1.png)

Both are still rough. Generated windows are a visual hint, not data: they don't touch your tags and aren't a guess at what's really there.

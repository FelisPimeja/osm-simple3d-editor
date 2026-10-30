# OSM Simple 3D: courtyards, merging parts and apse roofs

Hi everyone! A new batch of updates for [OSM Simple 3D](https://felispimeja.github.io/osm-simple3d-editor/), my browser-based 3D building editor for OSM. As promised last time: you can now cut courtyards into buildings and merge parts back together. There's also a new roof shape.

## Inner rings in Split (K)

Split now cuts more than straight lines. Click inside the face instead of on an edge, place the points and click the first one again. That cuts a closed ring out of the part, and a new part appears inside it. Delete the new part (Del) and you get a courtyard. Push it up (P) and you get a tower or an atrium. The ring may also touch the outline at a single point: just bring the cut back to where it started.

The editor takes care of the tagging: a plain way becomes a multipolygon, and the new part joins the building relation. The building outline (`outline`) can be split too, but only to cut rings out of it. Splitting the outline into two pieces is still blocked.

![GIF: cutting a courtyard](rings-1.gif)

## New tool: Merge (J)

Shift+click two or more touching parts and press J. They become one part. The biggest part keeps its id and history, and the rest are deleted. If the merged shape has a hole, you get a multipolygon with a courtyard. Ways shared with neighbouring parts stay in place: they get split where needed, so the neighbours stay connected. Only parts with the same volume tags can be merged (heights, levels, roof). Otherwise it's unclear which values to keep, and the editor tells you which tags differ.

![GIF: merging parts](merge-1.gif)

## New roof shape: `apse_gabled`

[`roof:shape=apse_gabled`](https://wiki.openstreetmap.org/wiki/Tag:roof:shape%3Dapse_gabled) is the half-cone roof over the apse at the end of a church. The flat gable sits on the longest side of the outline, and the slopes run down to the curved part. If the editor guesses the side wrong, set `roof:direction` to the direction the cone slopes down, the same as for a skillion roof.

![Screenshot: apse](apse-1.png)

## Small bonuses

- Push (P) is smarter with courtyards. Push the side of a notch into the opposite wall and it closes into a courtyard. Push two courtyards together and they merge into one.
- Building outlines without `building:part` now get a light highlight when selected and can be picked by clicking inside them. Add `building:part` to an outline and it gets drawn as a volume.
- Level fields in Properties now have ±1 arrows.

## Give it a spin

Open the [editor](https://felispimeja.github.io/osm-simple3d-editor/), double-click a building and try K and J. Let me know what feels clunky or confusing. Leave a comment here or open a [GitHub issue](https://github.com/FelisPimeja/osm-simple3d-editor/issues).

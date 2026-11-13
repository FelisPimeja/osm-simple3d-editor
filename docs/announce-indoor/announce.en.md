Another batch of updates, this time mostly about context: seeing a building together with its neighbours, and indoor spaces that have no building around them.

### Surroundings in building mode

@aighes asked earlier about large complexes like Frankfurt Airport T3, where several separate buildings are connected and you can walk from one into the next. Building mode can now show the surroundings.

Neighbouring buildings appear as grey transparent volumes, which is handy for checking heights and where buildings meet. Toggle them with **Shift+N** or with the **Show surroundings / Hide surroundings** button in the Properties panel when nothing is selected. Neighbours are on by default, and the editor remembers your choice. Click a neighbour to select the whole building, double-click to open it.

On a floor plan, neighbours follow the same rules as the building itself, just paler. Their floor is cut at the same height, walls come only from their indoor objects, and their lower floors show as dashed outlines. Double-clicking a neighbour opens it at the same floor, so you can walk from one building into the next.
![surroundings|690x490, 75%](upload://surroundings.gif)

### Floor plans show only indoor data

Floor plans no longer build solid outer walls from the Simple 3D building shell. The shell's section at the floor height is now only a dashed line for orientation. Solid walls and fills come from indoor objects alone. This removes the confusion about where a wall comes from. It also makes gaps in the indoor mapping obvious: if an exterior wall is missing from the plan, it is missing in the data.
![indoor_only|690x490, 75%](upload://indoor_only.png)

### Indoor without a building

Metro vestibules, pedestrian underpasses and platforms often have indoor mapping but no building around them. On the map they now show as a dashed outline with a plan badge. Click the badge to open the complex as a regular floor plan. Objects are grouped into complexes by how they connect (shared walls, doors, stairs and escalators between levels). An area also belongs to a building only if most of it lies inside, so a platform that just touches a station building no longer gets pulled into its plan.
![metro_vestibule|690x490, 75%](upload://vestibule.gif)

Large stations got much faster too: switching floors at Kazansky station used to freeze for several seconds and is now instant.

### Lower floors and level outlines

* **Lower floors are now dashed boxes** instead of full plans with room lids. Each one comes from the floor's `indoor=level` outline, or from all of its rooms merged if there is no level outline. The current floor is much easier to read this way.
* **You can cut out or add several shapes to a level outline at once.** Overlapping inner rings merge.
* **New walls and columns default to one object on several levels** (`level=0;1;2`) instead of a copy per level.

### Inner rings everywhere (I)

Inner rings are no longer limited to Offset. In building mode and on floor plans, press **I** with a part or polygon selected and draw the ring with any shape tool (polygon, rectangle, circle or n-gon). A tool's current modes (number of sides, tracing, inner ring) now sit together in one **tool options** panel.
![inner_ring|690x490, 75%](upload://inner_ring.gif)

### Entrances on the facade

The **Point tool (X)** places entrances right on the facade in building mode. Facade entrances and floor-plan doors stay in sync: move one and the other follows. Garage doors now default to 2.5 m wide, and changing the entrance type recuts the wall opening.

### Other improvements

* **Layers panel:** you can rename your own underlays, lock them and drag them to reorder. There's also a **"None"** basemap, and one basemap choice now applies to map, building and floor modes.
* **Floor numbering setting:** count floors from 1 (street level is the 1st floor, as in Russia, the US or Canada) or from 0. In English, level 0 is now called "Ground floor".
* **Snapping:** to intersections of part edges without a shared vertex. Offset also snaps to other objects.
* **Push/Pull** on the top or bottom of one of several selected objects moves all of them, and it never writes fractional `building:levels` or `building:min_level`.
* **Fit outline to footprint** keeps the footprint's inner rings and the outline's own volume. A new validator warning flags an outline lower than its tallest part, with a fix.
* **Copy/paste** keeps holes in building parts.
* **Upload** no longer opens an empty changeset when nothing differs from the server.

### UI polish by @CommanderStorm

Big thanks to @CommanderStorm for a series of UI improvements:

* The main settings panel is reorganised by task (data source, appearance, map data, sync, experimental), with clearer labels such as **Refresh data**.
* SVG icons instead of Unicode glyphs, and a calmer validation list.
* A cleaner object header: title, link and version badge, without the cryptic height summary.
* Secondary grey text (units, shortcuts, ids, hints) now meets WCAG AA contrast.
* The "inherited" badge no longer overlaps the dropdown arrow, and colour swatches have a single frame instead of two.
* The building-mode panel uses the same header as other objects, and its hints are a list instead of one long sentence.

As always, examples that render incorrectly are very welcome. Please include a link copied from the editor's address bar and a screenshot of the problem or the expected result.

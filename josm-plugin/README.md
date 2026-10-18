# simple3d — JOSM plugin for the Simple3D building editor

[Русский](README.ru.md)

A bridge between [JOSM](https://josm.openstreetmap.de/) and the
[OSM Simple3D editor](https://felispimeja.github.io/osm-simple3d-editor/), a browser editor for 3D buildings
([Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings)) and indoor plans.
Work in JOSM as usual and edit heights, roofs, building parts and floors in 3D on the same data:

- **One dataset.** The editor shows the active JOSM data layer, including unsaved edits, and picks up changes
  made in JOSM within a second.
- **Edits go straight into JOSM.** Every change made in 3D becomes a JOSM command named after the edit
  (“3D: …”). It appears in JOSM's history, and JOSM uploads it to OSM together with your other edits.
- **Shared undo.** Ctrl+Z in the editor or in JOSM undoes the last command, wherever it was made.
- **Shared selection.** Select a building in JOSM and it is selected in 3D, and the other way round.
- **No extra login.** The editor shows your JOSM user; uploading to OSM happens in JOSM.

## Installation

**From JOSM:** Preferences → Plugins → find `simple3d` → tick it → OK, then restart JOSM
(if it is not in the list, click *Download list* first).

**Manually:** download [simple3d.jar](https://github.com/FelisPimeja/osm-simple3d-editor/releases/latest/download/simple3d.jar)
into the JOSM plugins folder and enable it in Preferences → Plugins:

| System | Folder |
|---|---|
| macOS | `~/Library/JOSM/plugins/` |
| Linux | `~/.local/share/JOSM/plugins/` |
| Windows | `%APPDATA%\JOSM\plugins\` |

Requires JOSM 19613 or newer.

## Usage

Download some data in JOSM and choose **View → Open in 3D editor (Simple3D)** (Ctrl+Alt+Shift+3).
The editor opens at the current map view in its own app window — no tabs or address bar, on the right half of
the screen JOSM is on. This needs a Chromium-based browser (Chrome, Edge, Chromium, Brave or Vivaldi);
without one, the editor opens in your default browser.

The page is served by the plugin itself at `http://127.0.0.1:8112/editor/` (a copy of the editor website), so it
works in every browser, Safari included. The plugin listens on `127.0.0.1` only and answers only the editor's
pages, so other websites cannot read or change your JOSM data.

Without the plugin the editor can still read the JOSM layer through Remote Control, but read-only: edits do not
return to JOSM, and there is no shared undo or selection.

## Settings

Advanced preferences in JOSM (Preferences → Advanced):

| Key | Default | Meaning |
|---|---|---|
| `simple3d.port` | `8112` | Local port of the plugin |
| `simple3d.url` | the editor website | Where the editor page comes from |
| `simple3d.browser` | `app` | `app` — app window in a Chromium browser, `default` — default browser, or a path to a Chromium browser executable |
| `simple3d.proxy` | `true` | Open the editor through the plugin; `false` opens the website directly (Chrome, Firefox) |
| `simple3d.origins` | empty | Extra websites (origins, comma-separated) allowed to talk to the plugin |

## Feedback

Bugs and ideas: [GitHub issues](https://github.com/FelisPimeja/osm-simple3d-editor/issues).
How the plugin works, its protocol and releases: [DEVELOPMENT.md](DEVELOPMENT.md) (in Russian).

# OSM Simple 3D Editor — plugin format

This document describes how plugins for [OSM Simple 3D Editor](https://github.com/FelisPimeja/osm-simple3d-editor) are built. It is meant for people and for AI agents: everything needed to write a valid plugin is on this page.

Plugin API version: **1**.

## Kinds of plugins

| Kind | Contents | Where it lives | Who can add it |
|---|---|---|---|
| Custom | JSON manifest, optionally plus a code module next to it | Any public GitHub repository or any https URL | Any user, by link (Settings → Personal settings → Plugins… → Custom) |
| Official | JSON manifest, optionally plus a code module | `src/plugins/catalog.json` in the editor repository | Accepted by pull request after review |

Only the official list is reviewed and shown in the plugins menu. Anything added by link is unreviewed. A custom plugin may still run code (see [Code in custom plugins](#code-in-custom-plugins)): this lets authors develop and test a plugin before it is accepted. The OSM access token is stored in the page, so such code has full access to the user's OSM account. Before adding a custom plugin with code, the editor shows a clear warning and asks the user to confirm.

Plugins are enabled only on the OpenStreetMap server (not on OpenHistoricalMap or OpenGeofiction).

## Manifest

A plugin is a JSON object:

```json
{
  "id": "my-region-imagery",
  "apiVersion": 1,
  "version": "1.0.0",
  "name": "My Region Orthophoto",
  "description": "Orthophoto of My Region, 2024, 10 cm. Permitted for tracing in OSM.",
  "homepage": "https://wiki.openstreetmap.org/wiki/My_Region_Orthophoto",
  "imagery": [
    {
      "id": "ortho2024",
      "name": "My Region Orthophoto 2024",
      "tiles": ["https://tiles.example.org/ortho2024/{z}/{x}/{y}.jpg"],
      "tileSize": 256,
      "maxzoom": 20,
      "attribution": { "text": "© My Region Mapping Agency", "url": "https://example.org/" }
    }
  ]
}
```

### Top-level fields

| Field | Required | Rules |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9_-]{0,39}$`, unique among plugins. |
| `apiVersion` | yes | Must be `1`. A plugin with another value is rejected. |
| `name` | yes | Shown in the plugin list. Up to 80 characters. |
| `version` | no | Free text up to 20 characters, e.g. `1.0.0`. |
| `description` | no | Up to 300 characters. Write it in English. |
| `homepage` | no | `https://` URL, shown as a link. |
| `imagery` | see below | Array of imagery layers (up to 20). |
| `module` | no | Code module: for official plugins see [Code modules](#code-modules), for custom ones [Code in custom plugins](#code-in-custom-plugins). |

A plugin must contain at least one imagery layer or a `module`.

### Imagery layer fields

Each layer appears as a radio button in the "Map layers" menu, after the built-in imagery.

| Field | Required | Rules |
|---|---|---|
| `id` | yes | Same pattern as the plugin `id`, unique within the plugin. |
| `name` | yes | Shown in the layers menu. Up to 80 characters. |
| `tiles` | yes | 1–4 `https://` URL templates. Each must contain `{z}`, `{x}` and `{y}` (XYZ), or `{quadkey}`, or `{bbox-epsg-3857}` (WMS GetMap in EPSG:3857). Non-https templates are dropped. |
| `tileSize` | no | `256` (default) or `512`. |
| `maxzoom` | no | Last zoom with real tiles, 1–24, default 19. Deeper zooms are upscaled. |
| `attribution` | yes | Plain string, or `{ "text": "...", "url": "https://..." }`. HTML is not allowed: it is shown as text. |
| `viewOnly` | no | `true` if the licence does not allow tracing for OSM. The menu then shows "(view only)". |

A WMS layer example:

```json
{
  "id": "cadastre",
  "name": "Cadastre (WMS)",
  "tiles": ["https://wms.example.org/service?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=parcels&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true"],
  "attribution": "© Example Cadastre"
}
```

### Licensing

Add only imagery that you may use. Imagery for tracing must be permitted for OSM: an entry in the [editor-layer-index](https://github.com/osmlab/editor-layer-index) with `permission_osm: explicit`, or written permission from the owner documented on the OSM wiki. Anything else needs `"viewOnly": true`. The tile server must allow cross-origin requests (CORS) from browsers.

## Publishing a custom plugin

1. Create a public GitHub repository.
2. Put the manifest at its root as `simple3d-plugin.json`.
3. Create a tag, e.g. `v1.0.0`.
4. In the editor: Personal settings → Plugins… → Custom, enter `user/repo@v1.0.0` (or `https://github.com/user/repo`, or `https://github.com/user/repo/tree/v1.0.0`).

The editor loads the manifest through jsDelivr: `https://cdn.jsdelivr.net/gh/user/repo@v1.0.0/simple3d-plugin.json`. Pin a tag: a link without one follows the default branch, and jsDelivr caches it for up to a week.

Any https link to a `.json` manifest also works if the server sends CORS headers.

The list of enabled plugins (official ids and custom links) is saved in the user's OSM profile and restored on other devices.

## Adding a plugin to the official list

1. Fork [FelisPimeja/osm-simple3d-editor](https://github.com/FelisPimeja/osm-simple3d-editor).
2. Append the manifest object to the `plugins` array in `src/plugins/catalog.json`.
3. For imagery, put a link proving the OSM permission (wiki page or editor-layer-index entry) in `homepage` or in the pull request description.
4. Check locally: `npm install`, `npm run dev`, then enable the plugin in Personal settings → Plugins… and look at the layer. `npx tsc --noEmit` must pass.
5. Open a pull request titled `Plugin: <name>` that says what the plugin adds, the area it covers, and the licence.

Invalid catalog entries are skipped, with a warning in the browser console.

## Code modules

An official plugin may set `module`, in one of two forms:

- **External module (preferred):** `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<full 40-character commit SHA>/<file>.js`. The code lives in its own repository. Content at a full commit SHA never changes, so users run exactly the reviewed commit. To release a new version, push it to the plugin repository and open a pull request that updates the SHA in `catalog.json`. Example: [osm-simple3d-yandex-panoramas](https://github.com/FelisPimeja/osm-simple3d-yandex-panoramas).
- **Bundled module:** a name, `"module": "<name>"`, for `src/plugins/<name>.ts` in the editor repository.

Either way, the module is a plain ES module loaded when the plugin is enabled:

```js
export function activate(api) {
  // ...
  return () => { /* optional cleanup when the plugin is disabled */ };
}
```

`PluginApi` (version 1):

| Member | Purpose |
|---|---|
| `apiVersion` | `1` |
| `lang` | UI language: `'ru'` or `'en'`. Plugins keep their own strings. |
| `tr(text, params?)` | Translate an editor UI string (Russian source strings, see `src/i18n`). |
| `registerPhotoService(service, label, title)` | Add a street-level photo layer based on vector tiles of points to "Photos and panoramas". `service` implements `PhotoService` from `src/view/street-photos.ts`; see `src/view/panoramax.ts`. |
| `addPhotoToggle(id, label, title, onChange)` | Add a checkbox to "Photos and panoramas" for a service the plugin shows by its own means. The state is remembered; `onChange(true)` is also called on start if the box was ticked. Returns `{ set(on) }`. |
| `onMapClick(cb)` | `cb([lng, lat], { onObject, zoom })` on a map click outside tools. Return `true` if the plugin handled the click. `zoom` is the current MapLibre camera zoom (useful for hitting raster overlay symbols). `onObject` is true when the click hits a building or another editor object; leave those clicks to selection unless the user clicked an overlay symbol over it. |
| `openPanel(title)` | A floating window like the photo viewer. Returns `{ body, setTitle(t), close(), onClose(cb) }`; put your content into `body`. |
| `setViewCone({ lngLat, azimuth, fov? })` | Show the viewing direction on the map (azimuth in degrees from north). Call with no argument to remove it. |
| `addRasterOverlay({ attribution, minzoom?, maxzoom, loadTile })` | Add a raster coverage overlay. `loadTile(z, x, y, signal)` returns a PNG/JPEG `ArrayBuffer` in Web Mercator (256 px). Returns `{ setVisible(on) }`; initially hidden, restored after style changes, removed when the plugin is disabled. Requests are aborted through `signal`. |
| `addPointOverlay({ attribution, iconSvg, minzoom?, loadPoints, onClick })` | Add upright point symbols from GeoJSON. `loadPoints([west, south, east, north], zoom, signal)` returns a FeatureCollection; point properties include `id` and optional `height` (metres above ground). `onClick(id)` runs when the rendered icon is clicked, before building selection. Returns `{ setVisible(on) }`; requests cancel when the view changes or the layer is disabled. Restored after style changes and removed with the plugin. |
| `markUsed('street' \| 'imagery', name)` | Record a source for the changeset: `source=streetlevel imagery` or `imagery_used`. Call it when the user actually sees the content. |

Everything a plugin registered (imagery, photo layers, toggles, click handlers, windows, the cone) is removed automatically when the plugin is disabled.

## Code in custom plugins

A custom plugin may set `"module": "plugin.js"`: a path next to the manifest (letters, digits, `-`, `_`, `/`, ending in `.js` or `.mjs`). It is loaded from the same place as the manifest: for a GitHub link, the same repository and ref, `https://cdn.jsdelivr.net/gh/owner/repo@ref/plugin.js`; for an https link to a manifest, the same directory. Code from anywhere else is ignored. The module uses the same `activate(api)` interface as official modules.

- Before adding such a plugin, the editor warns that it is unreviewed and gets full access to the user's OSM account, and adds it only if the user confirms. The list marks it "runs code · full access".
- Any ref works, including a branch (`owner/repo@main`), which is convenient while developing. jsDelivr caches branches for up to 7 days; to pick up a new push at once, open `https://purge.jsdelivr.net/gh/owner/repo@main/plugin.js` and `.../simple3d-plugin.json`, then re-add the plugin. Tags avoid the cache problem.
- When the plugin is ready, propose it for the official list (see [Adding a plugin to the official list](#adding-a-plugin-to-the-official-list)) with the module pinned to a commit SHA.

## Source of truth

- Manifest validation: `parseManifest` in [`src/plugins.ts`](../src/plugins.ts).
- Official list: [`src/plugins/catalog.json`](../src/plugins/catalog.json).

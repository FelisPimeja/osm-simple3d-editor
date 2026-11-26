# OSM Simple 3D Editor — plugin format

This document describes how plugins for [OSM Simple 3D Editor](https://github.com/FelisPimeja/osm-simple3d-editor) are built. It is meant for people and for AI agents: everything needed to write a valid plugin is on this page.

Plugin API version: **1**.

## Kinds of plugins

| Kind | Contents | Where it lives | Who can add it |
|---|---|---|---|
| Custom | JSON manifest only (data, no code) | Any public GitHub repository or any https URL | Any user, by link (Settings → Personal settings → Plugins… → Custom) |
| Official | JSON manifest, optionally plus a code module | `src/plugins/catalog.json` in the editor repository | Accepted by pull request after review |

Custom plugins cannot run code. The OSM access token is stored in the page, so third-party code could edit OSM on the user's behalf. That is why code is accepted only in official plugins, after review.

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
| `module` | official only | Name of a code module, see [Code modules](#code-modules-official-only). Ignored in custom plugins. |

A plugin must contain at least one imagery layer, or (if official) a `module`.

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

## Code modules (official only)

An official plugin may set `"module": "<name>"`. It then needs `src/plugins/<name>.ts`, bundled with the editor and loaded on demand when the plugin is enabled:

```ts
import type { PluginApi } from '../plugins';

export function activate(api: PluginApi): void | (() => void) {
  api.registerPhotoService(service, 'Label', api.tr('Tooltip'));
  // Optionally return a function that cleans up when the plugin is disabled.
}
```

`PluginApi` (version 1):

| Member | Purpose |
|---|---|
| `apiVersion` | `1` |
| `tr(text, params?)` | Translate a UI string (Russian source strings, see `src/i18n`). |
| `registerPhotoService(service, label, title)` | Add a street-level photo layer to the "Photos and panoramas" group. `service` implements `PhotoService` from `src/view/street-photos.ts`; see `src/view/panoramax.ts` for a complete example. |

Things the editor registered for a plugin (imagery, photo layers) are removed automatically when the plugin is disabled.

## Source of truth

- Manifest validation: `parseManifest` in [`src/plugins.ts`](../src/plugins.ts).
- Official list: [`src/plugins/catalog.json`](../src/plugins/catalog.json).

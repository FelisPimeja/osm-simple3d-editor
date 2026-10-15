# OSM Simple 3D Editor

**English** · [Русский](README.ru.md)

A browser-based 3D building editor for OpenStreetMap, following the [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings) tagging scheme.
It also works with OpenHistoricalMap and OpenGeofiction.

OpenGeofiction's API may return 403 to Chrome, Safari, or Edge requests from this editor. Its server currently exempts IPs recognized as having edited OGF; if access is refused, try Firefox or contact the OGF administrators. The editor shows the server's response when this happens.

Open the editor: https://felispimeja.github.io/osm-simple3d-editor/

## Features

- 3D view of buildings and building parts on a MapLibre map, with roofs (flat, pyramidal, gabled, hipped and more).
- Tag panel for `height`, `min_height`, `building:levels`, `building:min_level`, `roof:*` and colours, with undo/redo and a before/after diff.
- Single-building mode: open one building in its own scene and edit its parts.
- Geometry tools: draw polygons, split, extrude and move, with SketchUp-like snapping and guides.
- `type=building` relations: create them and manage their members.
- Validator with automatic fixes, and a changeset comment generator.
- Basemaps: satellite imagery and OSM GPS traces, with imagery offset and opacity.
- Upload via OAuth 2.0 directly to the OSM API, no backend required. Data can also be read from a locally running JOSM.

## Interface languages

Russian and English. The language is chosen in the settings panel; on first launch it follows the browser and system language
(Russian for `ru`, English otherwise).

UI strings are written in Russian in the code via `tr('…')` / `trn(n, '…')` (see `src/i18n/index.ts`) and serve as
translation keys. Dictionaries are flat JSON files in `src/i18n/locales/`: `ru.json` is generated from the code
with `npm run i18n:extract`, while `en.json` contains the English text. `npm run i18n:check` verifies that the English text is
complete, has no extra strings, and that `{…}` placeholders match. Strings with a number contain plural forms separated by `|`
(Russian: forms for 1, 2, 5; English: forms for 1 and other).

The Transifex project configured in [`.tx/config`](.tx/config) uses English as its source language and Russian, German, and French as target languages. Russian phrases remain the JSON keys; their English values in `en.json` are the Transifex source text. [`.tx/config`](.tx/config) maps the `Editor interface` resource to these files. Install the [Transifex CLI](https://developers.transifex.com/docs/cli) and load `TX_TOKEN` from the ignored `.env.local` into your shell (`set -a; . ./.env.local; set +a`). After changing UI strings, run `npm run i18n:extract`, add the English text for any new keys to `en.json`, and check with `npm run i18n:check`. Then run `tx push -s` to upload English source text and `tx push -t -l ru` to upload the generated Russian translations. To review community translations, run `tx pull -t -l de,fr`, inspect the changed JSON files, and run `npm run i18n:check`. Never commit the token. To offer German or French in the app, also add the downloaded dictionary to `src/i18n/index.ts` and update its language list and locale handling.

## Development

```sh
npm install
npm run dev     # local dev server (Vite)
npm run build   # type check and production build
```

## License

The code is distributed under the [ISC](LICENSE) license. Map data is licensed by the respective projects
(ODbL for OpenStreetMap and OpenHistoricalMap, its own license for OpenGeofiction).

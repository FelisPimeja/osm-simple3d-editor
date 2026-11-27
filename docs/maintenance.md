# Maintenance: refreshing bundled external data

Some data from outside projects is bundled into the repository as generated files. Nothing updates them
automatically: run the matching command from time to time, review the diff, and commit the result.

| Data | Source | Command | Output |
|---|---|---|---|
| Imagery catalog | [editor-layer-index](https://github.com/osmlab/editor-layer-index) | `npm run imagery:catalog` | `public/imagery-catalog.json` |
| iD tagging schema (field labels, presets, deprecated tags, tag suggestions) | [`@openstreetmap/id-tagging-schema`](https://github.com/openstreetmap/id-tagging-schema) | `npm update @openstreetmap/id-tagging-schema && npm run presets:extract` | `src/osm/id-*.json` |
| 3dmr model transforms | [3dmr.eu](https://3dmr.eu) nightly dump | `npm run 3dmr:snapshot` | `src/render/3dmr-transforms.json` |

## Imagery catalog

`scripts/imagery-catalog.mjs` downloads editor-layer-index and keeps aerial imagery that:

- may be traced for OSM (`permission_osm` is `explicit` or `implicit`);
- is served over https in Web Mercator (WMS only with EPSG:3857);
- is detailed enough for buildings (`max_zoom` 16 or more; EOX cloudless is excluded);
- actually works in a browser: one tile inside the coverage is requested with an `Origin` header, and layers
  without CORS or with a dead server are dropped.

Coverage polygons are simplified to about 200 m. The script prints how many layers were kept and why the
others were rejected (`-v` lists them). `--no-check` skips the tile requests.

Layers that fail only temporarily (timeouts) drop out of the catalog until the next run, so compare the count
with the previous one before committing. The editor loads the catalog lazily and shows a layer in the layers
menu only while the map centre is inside its coverage (`src/view/imagery-catalog.ts`).

## iD tagging schema

`scripts/presets-extract.mjs` takes a small part of the iD schema with translations: field and value labels for
the tag form, presets for object names, deprecated-tag replacements for the validator, and keys and values for
tag suggestions. Bump the package version first; the script reads it from `node_modules`.

## 3dmr transforms

`scripts/3dmr-snapshot.mjs` reads rotation, scale and offset of older 3dmr models from the nightly archive with
HTTP Range requests (only `info.json` is fetched, not the whole archive).

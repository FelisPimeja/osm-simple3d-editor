#!/usr/bin/env node
/**
 * Каталог подложек из editor-layer-index (osmlab): только снимки, которые разрешено обводить для OSM
 * (permission_osm explicit или implicit), по https, в Web Mercator, с зумом от 16 (подробные — для зданий). Покрытие упрощено — меню слоёв показывает
 * подложку, только когда вид карты в её покрытии (src/view/imagery-catalog.ts).
 *
 *   node scripts/imagery-catalog.mjs            — собрать public/imagery-catalog.json
 *   node scripts/imagery-catalog.mjs --no-check — без проверки тайлов (CORS)
 *
 * Проверка тайлов: запрос одного тайла внутри покрытия с заголовком Origin; без Access-Control-Allow-Origin
 * браузер тайл не покажет — такие подложки не берём.
 */
import { writeFileSync } from 'node:fs';

const ELI = 'https://osmlab.github.io/editor-layer-index/imagery.geojson';
const OUT = new URL('../public/imagery-catalog.json', import.meta.url);
const CHECK = !process.argv.includes('--no-check');
const ORIGIN = 'https://felispimeja.github.io';
/** Свои подложки ядра (src/view/basemaps.ts) и подложки с ключом — не дублируем. */
const SKIP_ID = /^(EsriWorldImagery|EsriWorldImageryClarity|Mapbox|Bing)/i;
/** Спутник ~10 м (Sentinel-2, EOX cloudless): здания по нему не обвести, а строк в меню — по году на весь мир. */
const COARSE_ID = /^EOXAT\d{4}CLOUDLESS$/;
/** Меньший последний зум — снимки не для зданий (Landsat, Sentinel, ASTER). */
const MIN_MAX_ZOOM = 16;
/** Допуск упрощения покрытия, градусы (~200 м). */
const TOLERANCE = 0.002;

const round = (v) => Math.round(v * 1e4) / 1e4;

function simplify(ring, tol) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    let best = -1, far = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      const d = l ? Math.abs((px - ax) * dy - (py - ay) * dx) / l : Math.hypot(px - ax, py - ay);
      if (d > far) { far = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = ring.filter((_, i) => keep[i]).map(([x, y]) => [round(x), round(y)]);
  return out.length >= 4 ? out : ring.map(([x, y]) => [round(x), round(y)]);
}

/** Шаблон ELI → шаблоны MapLibre (до 4 адресов) и схема; undefined — не подходит. */
function convert(p) {
  let url = p.url;
  if (!url.startsWith('https://')) return;
  let scheme;
  if (p.type === 'wms') {
    if (!(p.available_projections ?? []).includes('EPSG:3857')) return;
    url = url.replace(/\{proj\}/g, 'EPSG:3857').replace(/\{bbox\}/g, '{bbox-epsg-3857}')
      .replace(/\{width\}/g, '256').replace(/\{height\}/g, '256').replace(/\{wkid\}/g, '3857');
  } else {
    url = url.replace(/\{zoom\}/g, '{z}');
    if (url.includes('{-y}')) { scheme = 'tms'; url = url.replace(/\{-y\}/g, '{y}'); }
  }
  let tiles = [url];
  const sw = url.match(/\{switch:([^}]+)\}/);
  if (sw) tiles = sw[1].split(',').slice(0, 4).map((s) => url.replace(sw[0], s.trim()));
  // Остальные подстановки ELI (ключи, даты) не поддерживаем
  const unknown = tiles[0].replace(/\{(z|x|y|quadkey|bbox-epsg-3857)\}/g, '').match(/\{[^}]*\}/);
  if (unknown) return;
  if (p.type !== 'wms' && !/\{z\}/.test(tiles[0]) && !/\{quadkey\}/.test(tiles[0])) return;
  return { tiles, scheme };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function attribution(p) {
  const a = p.attribution ?? {};
  const text = esc(a.text || p.name);
  return a.url?.startsWith('https://') || a.url?.startsWith('http://') ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${text}</a>` : text;
}

function polygons(g) {
  if (!g) return;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((poly) => poly.map((ring) => simplify(ring, TOLERANCE)));
}

const bboxOf = (polys) => {
  let w = 180, s = 90, e = -180, n = -90;
  for (const poly of polys) for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [round(w), round(s), round(e), round(n)];
};

/** Точка внутри покрытия (для пробного тайла): середина bbox, если внутри, иначе вершина внешнего кольца. */
function probePoint(polys) {
  const inRing = ([x, y], r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const [w, s, e, n] = bboxOf(polys), mid = [(w + e) / 2, (s + n) / 2];
  if (polys.some((p) => inRing(mid, p[0]))) return mid;
  const r = polys[0][0];
  return [(r[0][0] + r[Math.floor(r.length / 2)][0]) / 2, (r[0][1] + r[Math.floor(r.length / 2)][1]) / 2];
}

function tileFor(im, [lon, lat], z) {
  const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  const ty = im.scheme === 'tms' ? n - 1 - y : y;
  const R = 6378137 * Math.PI, size = 2 * R / n;
  const bbox = [-R + x * size, R - (y + 1) * size, -R + (x + 1) * size, R - y * size].join(',');
  let q = '';
  for (let i = z; i > 0; i--) { const m = 1 << (i - 1); q += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0); }
  return im.tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', ty).replace('{quadkey}', q).replace('{bbox-epsg-3857}', bbox);
}

async function check(im, polys) {
  const z = Math.max(im.minzoom ?? 0, Math.min(im.maxzoom, 15));
  const url = tileFor(im, polys ? probePoint(polys) : [0, 0], z);
  try {
    const r = await fetch(url, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(15000) });
    const acao = r.headers.get('access-control-allow-origin');
    await r.arrayBuffer().catch(() => {});
    if (!acao || (acao !== '*' && acao !== ORIGIN)) return `no CORS (${r.status})`;
    if (r.status >= 500) return `HTTP ${r.status}`;
    return '';
  } catch (e) { return `fetch: ${e.cause?.code ?? e.name}`; }
}

const eli = await (await fetch(ELI)).json();
const out = [], rejected = {};
const reject = (why, id) => (rejected[why] ??= []).push(id);
for (const f of eli.features) {
  const p = f.properties;
  if (p.category !== 'photo' || p.overlay || !['tms', 'wms'].includes(p.type)) continue;
  if (!['explicit', 'implicit'].includes(p.permission_osm)) continue;
  if (SKIP_ID.test(p.id)) continue;
  if (COARSE_ID.test(p.id) || (p.max_zoom ?? 19) < MIN_MAX_ZOOM) { reject('coarse', p.id); continue; }
  const conv = convert(p);
  if (!conv) { reject('url', p.id); continue; }
  const polys = polygons(f.geometry);
  const zoom = p.max_zoom ?? 19;
  out.push({
    id: `eli:${p.id}`, name: p.name, tiles: conv.tiles, ...(conv.scheme && { scheme: conv.scheme }),
    tileSize: 256, ...(p.min_zoom && { minzoom: p.min_zoom }), maxzoom: Math.max(1, Math.min(24, zoom)),
    attribution: attribution(p), ...(p.best && { best: true }), ...(p.country_code && { country: p.country_code }),
    ...(p.start_date && { date: String(p.end_date ?? p.start_date) }),
    ...(polys?.length && { bbox: bboxOf(polys), coverage: polys }),
  });
}

if (CHECK) {
  const bad = new Set();
  let i = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (i < out.length) {
      const im = out[i++];
      const why = await check(im, im.coverage);
      if (why) { bad.add(im.id); reject(why.replace(/\(.*\)/, '').trim(), `${im.id.slice(4)} ${why}`); }
    }
  }));
  for (let k = out.length - 1; k >= 0; k--) if (bad.has(out[k].id)) out.splice(k, 1);
}

out.sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '') || a.name.localeCompare(b.name));
writeFileSync(OUT, JSON.stringify({ source: ELI, generated: new Date().toISOString().slice(0, 10), imagery: out }));
console.log(`imagery: ${out.length}`);
for (const [why, ids] of Object.entries(rejected)) console.log(`rejected ${why}: ${ids.length}${process.argv.includes('-v') ? '\n  ' + ids.join('\n  ') : ''}`);

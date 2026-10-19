// Значки форм крыши для списка «Форма крыши» (ROOF_ICONS в src/edit/tag-form.ts).
// Модель из building-geometry, ортопроекция как у рисунков Simple 3D Buildings в вики, заливка по освещению
// (fill-opacity), криволинейные поверхности — тонкой сеткой (class="c").
//
//   node scripts/roof-icons.mjs                 — все формы из SHAPES, JSON в stdout
//   node scripts/roof-icons.mjs gabled_row      — только перечисленные
//   node scripts/roof-icons.mjs --write [формы] — записать (заменить или добавить) в tag-form.ts
//   node scripts/roof-icons.mjs --html [формы]  — страница сравнения со значками из tag-form.ts (public/zz-icons.html)
import { readFileSync, writeFileSync } from 'node:fs';
import polygonClipping from 'polygon-clipping';
import { createServer } from 'vite';

const L = 20, W = 10;
const rect = [[0, 0], [L, 0], [L, W], [0, W]];
const circle = Array.from({ length: 24 }, (_, i) => [L / 2 + 6 * Math.cos(i / 24 * 2 * Math.PI), W / 2 + 6 * Math.sin(i / 24 * 2 * Math.PI)]);
/** Форма → высота крыши (стены 5 м), контур, криволинейная ли поверхность. */
const SHAPES = {
  side_hipped: [5.5, rect], 'side_half-hipped': [5.5, rect], 'hipped-and-gabled': [5.5, rect], bellcast_gable: [5.5, rect],
  crosspitched: [5.5, [[3, 0], [17, 0], [17, W], [3, W]]], sawtooth: [2.2, rect], butterfly: [1.6, rect],
  cone: [9, circle, true], saltbox: [5.5, rect],
  gabled_row: [3, rect], double_saltbox: [5.5, rect], quadruple_saltbox: [5.5, rect],
};

const ex = [14.4 / L, -4.2 / L], ey = [-5.6 / W, -4.2 / W], ez = [0, -0.92];
const view = [-0.778, -1, 0.634];
const light = { c0: 0.387, cx: -0.163, cy: -0.283, cz: 0.363 };
const proj = (p) => [p[0] * ex[0] + p[1] * ey[0] + p[2] * ez[0], p[0] * ex[1] + p[1] * ey[1] + p[2] * ez[1]];

function icon(buildTriangles, computeHeights, shape, rh, ring, curved = false) {
  const tags = { 'roof:shape': shape, height: String(5 + rh), 'roof:height': String(rh) };
  const t = buildTriangles([{ outer: ring, inners: [] }], computeHeights(tags), tags);
  if (t.roofApproximated || t.pending) throw new Error(`${shape}: крыша не построилась`);
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const groups = new Map();
  const add = (arr, c) => {
    for (let i = 0; i < arr.length; i += 9) {
      const pts = [[arr[i], arr[i + 1], arr[i + 2]], [arr[i + 3], arr[i + 4], arr[i + 5]], [arr[i + 6], arr[i + 7], arr[i + 8]]];
      const u = pts[1].map((v, k) => v - pts[0][k]), w = pts[2].map((v, k) => v - pts[0][k]);
      let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(...n); if (len < 1e-9) continue;
      n = n.map((v) => v / len);
      const ce = pts.reduce((s, p) => s.map((v, k) => v + p[k] / 3), [0, 0, 0]);
      // Наружу: у скатов — вверх, у стен — от центра
      const out = Math.abs(n[2]) > 0.05 ? n[2] : n[0] * (ce[0] - cx) + n[1] * (ce[1] - cy);
      if (out < 0) n = n.map((v) => -v);
      if (n[0] * view[0] + n[1] * view[1] + n[2] * view[2] <= 1e-6) continue; // задняя грань
      const d = n[0] * pts[0][0] + n[1] * pts[0][1] + n[2] * pts[0][2];
      // Треугольники одной плоскости — одним path; у криволинейных — каждый отдельно
      const key = n.map((v) => v.toFixed(2)).join() + '|' + d.toFixed(1) + (c ? `|${i}` : '');
      const g = groups.get(key) ?? groups.set(key, { n, tris: [], depth: 0, cnt: 0, c }).get(key);
      g.tris.push(pts); g.depth += ce[0] * view[0] + ce[1] * view[1] + ce[2] * view[2]; g.cnt++;
    }
  };
  add(t.walls, curved); add(t.roof, curved);
  // Дальние грани раньше ближних
  const list = [...groups.values()].sort((a, b) => a.depth / a.cnt - b.depth / b.cnt);
  const all = list.flatMap((g) => g.tris.flat().map(proj));
  const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
  const s = Math.min(20 / (maxX - minX), 17 / (maxY - minY));
  const ox = 11 - (minX + maxX) / 2 * s, oy = 9.5 - (minY + maxY) / 2 * s;
  const out = [];
  for (const g of list) {
    const b = light.c0 + light.cx * g.n[0] + light.cy * g.n[1] + light.cz * g.n[2];
    const op = Math.max(0.1, Math.min(0.6, 1 - b));
    const polys = g.tris.map((tr) => [tr.map(proj).map(([x, y]) => [ox + x * s, oy + y * s])]);
    let merged;
    try { merged = polygonClipping.union(polys[0], ...polys.slice(1)); } catch { merged = polys.map((p) => [[...p[0], p[0][0]]]); }
    const d = merged.map((poly) => poly.map((r) => 'M' + r.slice(0, -1).map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z').join('')).join('');
    out.push(`<path d="${d}" fill-opacity="${op.toFixed(2)}"${g.c ? ' class="c"' : ''}/>`);
  }
  return out.join('');
}

const args = process.argv.slice(2);
const write = args.includes('--write'), html = args.includes('--html');
const names = args.filter((a) => !a.startsWith('--'));
for (const n of names) if (!SHAPES[n]) throw new Error(`нет параметров для формы ${n} — добавьте в SHAPES`);

// straight-skeleton (WASM) ждёт браузерные self/window
globalThis.self = globalThis;
globalThis.window = globalThis;
const vite = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
let res;
try {
  await (await vite.ssrLoadModule('/src/render/skeleton.ts')).skeletonReady;
  const { buildTriangles } = await vite.ssrLoadModule('/src/render/building-geometry.ts');
  const { computeHeights } = await vite.ssrLoadModule('/src/osm/heights.ts');
  res = Object.fromEntries((names.length ? names : Object.keys(SHAPES)).map((k) => [k, icon(buildTriangles, computeHeights, k, ...SHAPES[k])]));
} finally {
  await vite.close();
}

const FORM = new URL('../src/edit/tag-form.ts', import.meta.url);
if (write) {
  let s = readFileSync(FORM, 'utf8');
  for (const [k, v] of Object.entries(res)) {
    const line = `  '${k}': roofIcon('${v}'),`;
    const re = new RegExp(`^  '${k.replace(/[-]/g, '\\-')}': roofIcon\\('.*'\\),$`, 'm');
    if (re.test(s)) s = s.replace(re, () => line);
    else {
      const anchor = '\n};\n\n/** Поля формы';
      if (!s.includes(anchor)) throw new Error('не найден конец ROOF_ICONS в tag-form.ts');
      s = s.replace(anchor, () => `\n${line}${anchor}`);
    }
  }
  writeFileSync(FORM, s);
  console.log(`tag-form.ts: ${Object.keys(res).join(', ')}`);
} else if (html) {
  const old = Object.fromEntries([...readFileSync(FORM, 'utf8').matchAll(/^  '([a-z_-]+)': roofIcon\('(.*)'\),$/gm)].map((m) => [m[1], m[2]]));
  let h = '<html><body style="background:#fff;font:12px sans-serif"><style>svg{width:88px;height:76px;color:#374151} path{fill:currentColor;stroke:currentColor;stroke-width:.7;stroke-linejoin:round} path.c{stroke-width:.2;stroke-opacity:.35}</style>';
  for (const [k, v] of [...Object.entries(old), ...Object.entries(res).map(([k, v]) => [`${k} (новый)`, v])]) {
    h += `<div style="display:inline-block;text-align:center;margin:6px"><svg viewBox="0 0 22 19">${v}</svg><br>${k}</div>`;
  }
  writeFileSync(new URL('../public/zz-icons.html', import.meta.url), h);
  console.log('public/zz-icons.html');
} else console.log(JSON.stringify(res, null, 1));

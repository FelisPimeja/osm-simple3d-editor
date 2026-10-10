import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import { pointInRing, pointOnSurface, type BuildingGroup, type Feature3D, type LonLat, type Polygon } from '../osm/model';
import { computeHeights, parseLength, roofShapeOf } from '../osm/heights';
import { ROOF_SHAPES } from './tag-form';

/**
 * Проверка здания по схеме Simple 3D: теги объёма (числа, противоречия высот и этажей), геометрия
 * (вырожденные и самопересекающиеся контуры) и состав здания (части за контуром, покрытие контура частями,
 * части, занимающие один объём). Чистые функции: вход — объекты здания, выход — список проблем.
 */
export type IssueLevel = 'error' | 'warning';

export interface Issue {
  /** Объект с проблемой (для перехода к нему). */
  key: string;
  level: IssueLevel;
  /** Вид проверки — для группировки и подсказок. */
  code: string;
  text: string;
  /** Второй объект (пересечение объёмов). */
  other?: string;
  /** Однозначное исправление: новые значения тегов объекта key (undefined — удалить тег). */
  fix?: Fix;
}

export interface Fix {
  /** Что сделает кнопка — для подсказки. */
  label: string;
  tags: Record<string, string | undefined>;
}

/** Высота этажа, ниже и выше которой этажность и высота противоречат друг другу, м. */
const MIN_LEVEL_HEIGHT = 1.5;
const MAX_LEVEL_HEIGHT = 10;
/** Площадь, меньше которой контур вырожден, м² (кресты и шпили бывают по 0.1–0.5 м² — это нормально). */
const MIN_AREA = 0.01;
/** Части за контуром: допуск по площади, м² и доля части (погрешности обрисовки). */
const OUTSIDE_AREA = 1;
const OUTSIDE_SHARE = 0.03;
/**
 * Дубликат объёма: две части совпадают в плане (общая площадь — от этой доли каждой) и по высоте (общий
 * интервал — от этой доли большего). Просто пересечения не ищем: башня с min_height=0 внутри основания —
 * обычная практика обрисовки, это не ошибка.
 */
const DUPLICATE_SHARE = 0.8;
/** Части покрывают контур меньше чем наполовину — рендеры (и наш) рисуют контур сам по себе. */
const PARTS_COVERAGE = 0.5;

const KNOWN_ROOFS = new Set(ROOF_SHAPES);
const LENGTH_TAGS = ['height', 'min_height', 'roof:height'];
const COUNT_TAGS = ['building:levels', 'building:min_level', 'roof:levels'];

/**
 * Ошибочные ключи из разделов «Possible tagging mistakes» вики (Key:building:levels, roof:shape, building:colour,
 * building:material, roof:material, building:part…) → правильный ключ.
 */
const WRONG_KEYS: Record<string, string> = {
  'building:level': 'building:levels', levels: 'building:levels', 'building:height': 'height', 'building:min_height': 'min_height',
  'building:roof:shape': 'roof:shape', roof: 'roof:shape', 'roof:type': 'roof:shape', roof_shape: 'roof:shape',
  'building:facade:colour': 'building:colour', 'building:facade:color': 'building:colour', 'building:color': 'building:colour',
  'building:roof:colour': 'roof:colour', 'building:roof:color': 'roof:colour', 'roof:color': 'roof:colour',
  'building:lateral:material': 'building:material', 'building:facade:material': 'building:material', 'facade:material': 'building:material',
  'building:roof': 'roof:material', 'building:roof:material': 'roof:material',
  buildingpart: 'building:part', building_part: 'building:part', 'roof:level': 'roof:levels', 'building:min_levels': 'building:min_level',
};
/** Значения roof:shape из «Values with problems» без однозначной замены (у остальных — ROOF_SYNONYMS в heights). */
const ROOF_UNCLEAR: Record<string, string> = { gabled_row: 'неясное значение — возможно, sawtooth или ряд gabled-частей' };
/** gabled_height_moved в вики — документированное значение, хотя рисуем его как saltbox. */
const ROOF_DOCUMENTED = new Set(['gabled_height_moved']);
const COMPASS = /^(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)$/;
const COMPASS_WORDS: Record<string, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };
const COLOUR_KEYS = ['building:colour', 'roof:colour'];

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** Почему длина не разобралась: подсказка по типичным ошибкам из Key:height. */
function lengthHint(v: string): string {
  if (/^\s*-?\d+,\d+/.test(v)) return 'десятичный разделитель — точка: 0.8, а не 0,8';
  if (/[;]/.test(v)) return 'нужно одно значение, без «;»';
  if (/^\s*\d+(\.\d+)?\s*-\s*\d/.test(v)) return 'диапазон не допускается: низ — в min_height, верх — в height';
  if (/^[<>~]/.test(v.trim())) return 'оценку пишут в est_height, здесь — только число';
  return 'ожидаются метры: 12, 12.5, «12 m», 40 ft, 7\'4"';
}

/** Проблемы тегов одного объекта. */
export function validateTags(key: string, t: Record<string, string>): Issue[] {
  const out: Issue[] = [];
  const add = (level: IssueLevel, code: string, text: string, fix?: Fix) => out.push({ key, level, code, text, ...(fix ? { fix } : {}) });
  const set = (tags: Record<string, string | undefined>): Fix => ({
    label: Object.entries(tags).map(([k, v]) => (v === undefined ? `удалить ${k}` : `${k}=${v}`)).join(', '), tags,
  });
  for (const [wrong, right] of Object.entries(WRONG_KEYS)) {
    if (t[wrong] === undefined) continue;
    // roof=* бывает и самостоятельным тегом (roof=yes у навесов) — только когда roof:shape не задан
    if (wrong === 'roof' && (t['roof:shape'] !== undefined || /^(yes|no)$/.test(t.roof))) continue;
    add('warning', 'key', `${wrong}=${t[wrong]} — ошибочный ключ, правильно ${right}${t[right] !== undefined ? ` (уже задан: ${t[right]})` : ''}.`,
      t[right] === undefined ? { label: `переименовать в ${right}`, tags: { [wrong]: undefined, [right]: t[wrong] } } : undefined);
  }
  if (t.building === 'part') add('warning', 'key', 'building=part — ошибка: части размечают building:part=yes.',
    t['building:part'] === undefined ? set({ building: undefined, 'building:part': 'yes' }) : undefined);
  if (t['building:part'] !== undefined && /^\d+$/.test(t['building:part'])) add('warning', 'key', `building:part=${t['building:part']} — число вместо вида части (yes, roof, column…).`);
  for (const k of LENGTH_TAGS) {
    const v = t[k];
    if (v === undefined) continue;
    const n = parseLength(v);
    if (n === undefined) {
      // Запятая вместо точки — заменить, если после этого число разбирается
      const dot = /^\s*-?\d+,\d+/.test(v) && !/[;]/.test(v) ? v.replace(',', '.').trim() : undefined;
      add('error', 'number', `${k}=${v} — не число: ${lengthHint(v)}.`, dot && parseLength(dot) !== undefined ? set({ [k]: dot }) : undefined);
    }
    else if (n < 0) add('error', 'number', `${k}=${v} — отрицательное значение.`);
    else if (/^\s*\d+(\.\d+)?(m|ft)$/.test(v)) add('warning', 'number', `${k}=${v} — единицу пишут через пробел («${v.replace(/(m|ft)$/, ' $1')}») или вовсе без «m».`,
      set({ [k]: v.trim().replace(/\s*m$/, '').replace(/\s*ft$/, ' ft') }));
    else if (k === 'height' && n === 0) add('warning', 'number', 'height=0 — у здания нулевая высота.');
  }
  for (const k of COUNT_TAGS) {
    if (t[k] === undefined) continue;
    const n = Number(t[k]);
    if (!Number.isFinite(n)) {
      add('error', 'number', `${k}=${t[k]} — не число${k === 'roof:levels' && /flat/i.test(t[k]) ? ' (форма крыши — roof:shape=flat)' : ''}.`);
    } else if (n < 0) add('error', 'number', `${k}=${t[k]} — отрицательное значение (подземные этажи — building:levels:underground).`);
    else if (!Number.isInteger(n)) add('error', 'number', `${k}=${t[k]} — этажи считают целыми; дробную высоту задают через ${k === 'building:min_level' ? 'min_height' : k === 'roof:levels' ? 'roof:height' : 'height'}.`);
  }
  if (t['building:min_level'] !== undefined && Number(t['building:min_level']) === 0) add('warning', 'levels', 'building:min_level=0 — лишний тег: часть и так начинается с земли.', set({ 'building:min_level': undefined }));
  if (t['building:min_level'] !== undefined && t['building:levels'] === undefined) add('warning', 'levels', 'building:min_level без building:levels — число этажей части не определено.');
  if (Number(t['building:levels']) === 0 && !(Number(t['building:levels:underground']) > 0)) add('warning', 'levels', 'building:levels=0 — у здания нет надземных этажей (подземное — с building:levels:underground).');
  const height = parseLength(t.height), min = parseLength(t.min_height), roof = parseLength(t['roof:height']);
  const before = out.length;
  if (height !== undefined && min !== undefined && min >= height) {
    add('error', 'heights', `min_height (${fmt(min)} м) не меньше height (${fmt(height)} м) — объём вывернут. height отсчитывают от земли до верха, а не от min_height.`);
  } else if (height !== undefined && roof !== undefined && roofShapeOf(t) !== 'flat' && roof > height - (min ?? 0) + 0.01) {
    add('warning', 'heights', `roof:height (${fmt(roof)} м) больше высоты объёма (${fmt(height - (min ?? 0))} м) — крыша обрезана.`);
  }
  const levels = Number(t['building:levels']), minLevel = Number(t['building:min_level']);
  if (t['building:levels'] !== undefined && t['building:min_level'] !== undefined && Number.isFinite(levels) && Number.isFinite(minLevel) && levels <= minLevel) {
    add('error', 'levels', `building:levels (${t['building:levels']}) не больше building:min_level (${t['building:min_level']}) — `
      + 'building:levels считает этажи от земли, включая пропущенные снизу.');
  } else if (out.length === before && height !== undefined && t['building:levels'] !== undefined && Number.isFinite(levels) && levels > (Number(minLevel) || 0)) {
    const h = computeHeights(t);
    const step = (h.wallTop - h.min) / (levels - (Number(minLevel) || 0));
    if (step < MIN_LEVEL_HEIGHT || step > MAX_LEVEL_HEIGHT) {
      add('warning', 'levels', `building:levels=${t['building:levels']} при высоте стен ${fmt(h.wallTop - h.min)} м — этаж выходит ${fmt(step)} м.`);
    }
  }
  const raw = t['roof:shape'], shape = raw?.trim().toLowerCase();
  if (shape !== undefined) {
    const main = roofShapeOf(t);
    if (/^\d+(\.\d+)?$/.test(shape)) add('warning', 'roof', `roof:shape=${raw} — число вместо формы; число этажей в крыше — roof:levels.`);
    else if (ROOF_UNCLEAR[shape]) add('warning', 'roof', `roof:shape=${raw} — ${ROOF_UNCLEAR[shape]}.`);
    else if (!KNOWN_ROOFS.has(main)) add('warning', 'roof', `roof:shape=${raw} — неизвестная форма крыши (рисуется плоской).`);
    else if (shape !== main && !ROOF_DOCUMENTED.has(shape)) add('warning', 'roof', `roof:shape=${raw} — значение с проблемами, основное — ${main}.`, set({ 'roof:shape': main }));
    else if (raw !== shape) add('warning', 'roof', `roof:shape=${raw} — значения пишут строчными: ${shape}.`, set({ 'roof:shape': shape }));
  }
  if (t['roof:levels'] !== undefined && Number(t['roof:levels']) > 0 && t['roof:shape'] !== undefined && roofShapeOf(t) === 'flat') {
    add('warning', 'roof', `roof:levels=${t['roof:levels']} при roof:shape=flat — в плоской крыше нет этажей.`);
  }
  const orient = t['roof:orientation'];
  if (orient !== undefined && orient !== 'along' && orient !== 'across') {
    const o = orient.trim().toLowerCase(), word = COMPASS_WORDS[o];
    const hint = o === 'accross' ? 'правильно across' : word ? `сторону света пишут в roof:direction=${word}` : 'допустимо along или across';
    const fix = o === 'accross' || o === 'across' || o === 'along' ? set({ 'roof:orientation': o.replace('accross', 'across') })
      : word && t['roof:direction'] === undefined ? set({ 'roof:orientation': undefined, 'roof:direction': word }) : undefined;
    add('warning', 'roof', `roof:orientation=${orient} — ${hint}.`, fix);
  }
  const dir = t['roof:direction'];
  if (dir !== undefined) {
    const deg = Number(dir);
    if (dir === 'along' || dir === 'across') add('warning', 'roof', `roof:direction=${dir} — это значение roof:orientation.`,
      orient === undefined ? set({ 'roof:direction': undefined, 'roof:orientation': dir }) : undefined);
    else if (COMPASS_WORDS[dir.toLowerCase()]) add('warning', 'roof', `roof:direction=${dir} — пишут буквой: ${COMPASS_WORDS[dir.toLowerCase()]}.`, set({ 'roof:direction': COMPASS_WORDS[dir.toLowerCase()] }));
    else if (COMPASS.test(dir.toUpperCase()) && !COMPASS.test(dir)) add('warning', 'roof', `roof:direction=${dir} — стороны света пишут заглавными: ${dir.toUpperCase()}.`, set({ 'roof:direction': dir.toUpperCase() }));
    else if (!COMPASS.test(dir) && !(dir.trim() !== '' && Number.isFinite(deg) && deg >= 0 && deg <= 360)) add('warning', 'roof', `roof:direction=${dir} — ожидаются градусы 0–360 или N, NE, SSW…`);
  }
  if (orient !== undefined && dir !== undefined) add('warning', 'roof', 'Заданы и roof:orientation, и roof:direction — это альтернативы, оставьте одно.');
  const angle = t['roof:angle'];
  if (angle !== undefined) {
    const a = Number(angle);
    if (!Number.isFinite(a) || a < 0 || a > 90) add('warning', 'roof', `roof:angle=${angle} — ожидается угол в градусах 0–90.`);
  }
  for (const k of COLOUR_KEYS) {
    const v = t[k];
    if (v === undefined) continue;
    if (v.startsWith('#') && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) add('warning', 'colour', `${k}=${v} — неверный hex-цвет (нужно #RGB или #RRGGBB).`);
    else if (/^gray$/i.test(v)) add('warning', 'colour', `${k}=${v} — в OSM британское написание: grey.`, set({ [k]: 'grey' }));
  }
  return out;
}

/** Локальная проекция в метры вокруг точки (для площадей и пересечений в пределах здания). */
function projector(origin: LonLat): (c: LonLat) => [number, number] {
  const kx = Math.cos((origin[1] * Math.PI) / 180) * 111320, ky = 110540;
  return ([x, y]) => [(x - origin[0]) * kx, (y - origin[1]) * ky];
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a) / 2;
}

const closed = (r: [number, number][]) => [...r, r[0]];

function toMulti(polys: Polygon[], p: (c: LonLat) => [number, number]): MultiPolygon {
  return polys.map((q) => [closed(q.outer.map(p)), ...q.inners.map((r) => closed(r.map(p)))]);
}

function multiArea(m: MultiPolygon): number {
  return m.reduce((s, poly) => s + poly.reduce((t, r, i) => t + (i ? -1 : 1) * ringArea(r.slice(0, -1) as [number, number][]), 0), 0);
}

/** Пересекаются ли отрезки ab и cd во внутренних точках. */
function crosses(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Самопересечение кольца (несмежные стороны пересекаются); до 2000 вершин — дальше не проверяем. */
function selfIntersects(r: [number, number][]): boolean {
  const n = r.length;
  if (n < 4 || n > 2000) return false;
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(a, b, r[j], r[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Проблемы геометрии одного объекта. */
export function validateGeometry(f: Feature3D): Issue[] {
  if (!f.polygons.length) return [];
  const p = projector(f.polygons[0].outer[0]);
  const out: Issue[] = [];
  for (const poly of f.polygons) {
    for (const [i, ring] of [poly.outer, ...poly.inners].entries()) {
      const r = ring.map(p);
      const distinct = new Set(r.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)).size;
      const what = i ? 'Внутреннее кольцо' : 'Контур';
      if (distinct >= 3 && selfIntersects(r)) {
        out.push({ key: f.key, level: 'error', code: 'self', text: `${what} самопересекается — объём строится неверно.` });
      } else if (distinct < 3 || ringArea(r) < MIN_AREA) {
        out.push({ key: f.key, level: 'error', code: 'degenerate', text: `${what} вырожден (разных точек: ${distinct}, площадь ${fmt(ringArea(r))} м²).` });
      }
    }
  }
  return out;
}

/** Проверка здания целиком: каждый объект и отношения между ними. */
export function validateBuilding(g: BuildingGroup, features: Feature3D[]): Issue[] {
  const role = new Map(g.members.map((k, i) => [k, g.roles[i]]));
  const out: Issue[] = [];
  for (const f of features) out.push(...validateTags(f.key, f.tags), ...validateGeometry(f));
  const withGeom = features.filter((f) => f.polygons.length);
  if (!withGeom.length) return out;
  const p = projector(withGeom[0].polygons[0].outer[0]);
  const outline = withGeom.find((f) => role.get(f.key) === 'outline');
  const parts = withGeom.filter((f) => role.get(f.key) === 'part');
  // Геометрию с ошибками в булевы операции не пускаем — polygon-clipping на них падает или врёт
  const broken = new Set(out.filter((i) => i.code === 'degenerate' || i.code === 'self').map((i) => i.key));
  const geom = new Map<string, MultiPolygon>();
  const multi = (f: Feature3D) => geom.get(f.key) ?? geom.set(f.key, toMulti(f.polygons, p)).get(f.key)!;
  const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

  // Отношение type=building: ровно один контур (outline), члены — с building / building:part (вики Relation:building)
  if (g.type === 'relation' && g.id !== 0) {
    const outlines = g.members.filter((k, i) => g.roles[i] === 'outline');
    if (!outlines.length) out.push({ key: g.key, level: 'warning', code: 'relation', text: 'В отношении здания нет члена с ролью outline — контура здания.' });
    else if (outlines.length > 1) out.push({ key: g.key, level: 'error', code: 'relation', text: `В отношении здания ${outlines.length} контура (роль outline) — должен быть один.` });
    for (const f of features) {
      const r = role.get(f.key);
      if (r === 'outline' && f.tags.building === undefined) out.push({ key: f.key, level: 'warning', code: 'relation', text: 'Контур здания (роль outline) без тега building.', fix: { label: 'building=yes', tags: { building: 'yes' } } });
      if (r === 'part' && f.tags['building:part'] === undefined) out.push({ key: f.key, level: 'warning', code: 'relation', text: 'Часть здания (роль part) без тега building:part.', fix: { label: 'building:part=yes', tags: { 'building:part': 'yes' } } });
      if (r !== undefined && !['outline', 'part', 'ridge', 'edge'].includes(r)) out.push({ key: f.key, level: 'warning', code: 'relation', text: `Роль «${r || 'пусто'}» в отношении здания — ожидаются outline или part.` });
    }
  }

  if (outline && !broken.has(outline.key)) {
    const o = multi(outline);
    const outlineArea = multiArea(o);
    const inOutline = (c: LonLat) => outline.polygons.some((q) => pointInRing(c, q.outer) && !q.inners.some((h) => pointInRing(c, h)));
    for (const f of parts) {
      if (broken.has(f.key)) continue;
      // Все вершины внутри — вычитание не нужно (вогнутый контур мог бы обмануть, но такие части видно и глазом)
      if (f.polygons.every((q) => q.outer.every(inOutline))) continue;
      const a = multiArea(multi(f));
      const rest = safe(() => multiArea(polygonClipping.difference(multi(f), o)));
      if (rest !== undefined && rest > OUTSIDE_AREA && rest > a * OUTSIDE_SHARE) {
        out.push({ key: f.key, level: 'warning', code: 'outside', text: `Часть выходит за контур здания на ${fmt(rest)} м² — контур должен охватывать все части.` });
      }
    }
    // Покрытие — как в рендере (markOutlinesWithParts): сумма площадей частей, чья точка внутри контура
    // и которые начинаются ниже его верха (надстройки поверх контура не в счёт)
    const top = computeHeights(outline.tags).top;
    let covered = 0;
    for (const f of parts) {
      if (computeHeights(f.tags).min >= top - 1) continue;
      for (const q of f.polygons) if (inOutline(pointOnSurface(q))) covered += multiArea(toMulti([q], p));
    }
    if (parts.length && outlineArea > 0 && covered < outlineArea * PARTS_COVERAGE) {
      out.push({ key: outline.key, level: 'warning', code: 'coverage', text: `Части покрывают ${Math.floor((covered / outlineArea) * 100)}% контура — `
        + 'меньше половины: контур рисуется отдельным объёмом вместе с частями. Обрисуйте частями всё здание или уберите лишнее.' });
    }
    // Высота контура — максимум по частям (Key:building:part)
    const oh = parseLength(outline.tags.height);
    if (oh !== undefined) {
      for (const f of parts) {
        const ph = parseLength(f.tags.height);
        if (ph !== undefined && ph > oh + 0.5) out.push({ key: f.key, level: 'warning', code: 'above', text: `height (${fmt(ph)} м) больше, чем у контура (${fmt(oh)} м): на контуре указывают максимальную высоту здания.` });
      }
    }
    // Этажность контура — максимум по частям
    const ol = Number(outline.tags['building:levels']);
    if (Number.isFinite(ol)) {
      for (const f of parts) {
        const l = Number(f.tags['building:levels']);
        if (Number.isFinite(l) && l > ol) out.push({ key: f.key, level: 'warning', code: 'above', text: `building:levels (${l}) больше, чем у контура (${ol}): на контуре указывают максимальную этажность здания.` });
      }
    }
  }

  // Две части в одном объёме: почти совпадают в плане и по высоте (копия, наложенная поверх)
  const boxes = parts.filter((f) => !broken.has(f.key)).map((f) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const poly of multi(f)) for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const h = computeHeights(f.tags);
    return { f, w, s, e, n, min: h.min, top: h.top, area: multiArea(multi(f)) };
  });
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (a.e <= b.w || b.e <= a.w || a.n <= b.s || b.n <= a.s) continue;
      const dz = Math.min(a.top, b.top) - Math.max(a.min, b.min);
      if (dz < 0.5 || dz < Math.max(a.top - a.min, b.top - b.min) * DUPLICATE_SHARE) continue;
      const x = safe(() => multiArea(polygonClipping.intersection(multi(a.f), multi(b.f))));
      if (x === undefined || x < a.area * DUPLICATE_SHARE || x < b.area * DUPLICATE_SHARE) continue;
      out.push({ key: a.f.key, other: b.f.key, level: 'warning', code: 'overlap',
        text: `Почти совпадает с ${b.f.key} (${fmt(x)} м² в плане, высоты ${fmt(Math.max(a.min, b.min))}–${fmt(Math.min(a.top, b.top))} м) — похоже на дубликат части.` });
    }
  }
  return out;
}

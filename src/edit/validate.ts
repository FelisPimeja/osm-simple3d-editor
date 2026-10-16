import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import { parseLevels, pointInRing, type BuildingGroup, type Feature3D, type IndoorFeature, type LonLat, type Polygon } from '../osm/model';
import { computeHeights, parseLength, roofShapeOf } from '../osm/heights';
import { ROOF_SHAPES } from './tag-form';
import { tr, trn } from '../i18n';
import { floatingParts } from '../osm/floating';

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
  /** Исключить объект из указанного отношения type=building. */
  removeFromGroup?: string;
}

/** Высота этажа, ниже и выше которой этажность и высота противоречат друг другу, м. */
const MIN_LEVEL_HEIGHT = 1.5;
const MAX_LEVEL_HEIGHT = 10;
/** Площадь, меньше которой контур вырожден, м² (детали крестов бывают и по 0.005 м² — это нормально). */
const MIN_AREA = 0.0001;
/**
 * Средняя ширина контура (2·площадь/периметр), ниже которой он — «щель» нулевой ширины, м. Не доля от периметра:
 * длинные узкие, но настоящие контуры (ограда в толщину стенки, relation/3023352) иначе выходили вырожденными.
 */
const MIN_WIDTH = 0.05;
/** Части за контуром: допуск по площади, м² и доля части (погрешности обрисовки). */
const OUTSIDE_AREA = 1;
const OUTSIDE_SHARE = 0.03;
/** Разрыв между отдельными корпусами, после которого предлагаем проверить принадлежность, м. */
const REMOTE_PART_GAP = 20;
/**
 * Дубликат объёма: две части совпадают по высоте (общий интервал — от этой доли большего) и в плане (DUPLICATE_PLAN). Просто пересечения не ищем: башня с min_height=0 внутри основания —
 * обычная практика обрисовки, это не ошибка.
 */
const DUPLICATE_SHARE = 0.98;
/** …а в плане — от этой доли каждой: схожие, но разные ярусы не считаем дублями. */
const DUPLICATE_PLAN = 0.99;

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
  'building:max_level': 'max_level',
};
/** Значения roof:shape из «Values with problems» без однозначной замены (у остальных — ROOF_SYNONYMS в heights). */
const ROOF_UNCLEAR: Record<string, string> = { gabled_row: tr('неясное значение — возможно, sawtooth или ряд gabled-частей') };
/** gabled_height_moved в вики — документированное значение, хотя рисуем его как saltbox. */
const ROOF_DOCUMENTED = new Set(['gabled_height_moved']);
const COMPASS = /^(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)$/;
const COMPASS_WORDS: Record<string, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };
const COLOUR_KEYS = ['building:colour', 'roof:colour'];

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** Почему длина не разобралась: подсказка по типичным ошибкам из Key:height. */
function lengthHint(v: string): string {
  if (/^\s*-?\d+,\d+/.test(v)) return tr('десятичный разделитель — точка: 0.8, а не 0,8');
  if (/[;]/.test(v)) return tr('нужно одно значение, без «;»');
  if (/^\s*\d+(\.\d+)?\s*-\s*\d/.test(v)) return tr('диапазон не допускается: низ — в min_height, верх — в height');
  if (/^[<>~]/.test(v.trim())) return tr('оценку пишут в est_height, здесь — только число');
  return tr('ожидаются метры: 12, 12.5, «12 m», 40 ft, 7\'4"');
}

/** Проблемы тегов одного объекта. */
export function validateTags(key: string, t: Record<string, string>): Issue[] {
  const out: Issue[] = [];
  const add = (level: IssueLevel, code: string, text: string, fix?: Fix) => out.push({ key, level, code, text, ...(fix ? { fix } : {}) });
  const set = (tags: Record<string, string | undefined>): Fix => ({
    label: Object.entries(tags).map(([k, v]) => (v === undefined ? tr('удалить {tag}', { tag: k }) : `${k}=${v}`)).join(', '), tags,
  });
  for (const [wrong, right] of Object.entries(WRONG_KEYS)) {
    if (t[wrong] === undefined) continue;
    // roof=* бывает и самостоятельным тегом (roof=yes у навесов) — только когда roof:shape не задан
    if (wrong === 'roof' && (t['roof:shape'] !== undefined || /^(yes|no)$/.test(t.roof))) continue;
    const tag = `${wrong}=${t[wrong]}`;
    add('warning', 'key', t[right] !== undefined
      ? tr('{tag} — ошибочный ключ, правильно {key} (уже задан: {value}).', { tag, key: right, value: t[right] })
      : tr('{tag} — ошибочный ключ, правильно {key}.', { tag, key: right }),
    t[right] === undefined ? { label: tr('переименовать в {key}', { key: right }), tags: { [wrong]: undefined, [right]: t[wrong] } } : undefined);
  }
  if (t.building === 'part') add('warning', 'key', tr('building=part — ошибка: части размечают building:part=yes.'),
    t['building:part'] === undefined ? set({ building: undefined, 'building:part': 'yes' }) : undefined);
  if (t.building === 'entrance') add('warning', 'key', tr('building=entrance — вход обозначают узлом entrance=* на контуре здания.'));
  if (t['building:part'] !== undefined && /^\d+$/.test(t['building:part'])) add('warning', 'key', tr('{tag} — число вместо вида части (yes, roof, column…).', { tag: `building:part=${t['building:part']}` }));
  if (t.building !== undefined || t['building:part'] !== undefined) {
    for (const tag of ['min_level', 'max_level'] as const) if (t[tag] !== undefined && !Number.isFinite(Number(t[tag])))
      add('error', 'indoor-level', tr('{tag}={value} — номер этажа должен быть числом.', { tag, value: t[tag] }));
    const minIndoor = Number(t.min_level), maxIndoor = Number(t.max_level);
    if (t.min_level !== undefined && t.max_level !== undefined && Number.isFinite(minIndoor) && Number.isFinite(maxIndoor) && minIndoor > maxIndoor)
      add('error', 'indoor-level', tr('min_level={min} выше max_level={max} — проверьте границы этажей здания.', { min: t.min_level, max: t.max_level }));
  }
  for (const k of LENGTH_TAGS) {
    const v = t[k];
    if (v === undefined) continue;
    const n = parseLength(v);
    if (n === undefined) {
      // Запятая вместо точки — заменить, если после этого число разбирается
      const dot = /^\s*-?\d+,\d+/.test(v) && !/[;]/.test(v) ? v.replace(',', '.').trim() : undefined;
      add('error', 'number', tr('{tag} — не число: {hint}.', { tag: `${k}=${v}`, hint: lengthHint(v) }), dot && parseLength(dot) !== undefined ? set({ [k]: dot }) : undefined);
    }
    else if (n < 0) add('error', 'number', tr('{tag} — отрицательное значение.', { tag: `${k}=${v}` }));
    else if (/^\s*\d+(\.\d+)?(m|ft)$/.test(v)) add('warning', 'number', tr('{tag} — единицу пишут через пробел («{example}») или вовсе без «m».', { tag: `${k}=${v}`, example: v.replace(/(m|ft)$/, ' $1') }),
      set({ [k]: v.trim().replace(/\s*m$/, '').replace(/\s*ft$/, ' ft') }));
    else if (k === 'height' && n === 0) add('warning', 'number', tr('height=0 — у здания нулевая высота.'));
  }
  for (const k of COUNT_TAGS) {
    if (t[k] === undefined) continue;
    const n = Number(t[k]);
    if (!Number.isFinite(n)) {
      add('error', 'number', k === 'roof:levels' && /flat/i.test(t[k])
        ? tr('{tag} — не число (форма крыши — roof:shape=flat).', { tag: `${k}=${t[k]}` })
        : tr('{tag} — не число.', { tag: `${k}=${t[k]}` }));
    } else if (n < 0) add('error', 'number', tr('{tag} — отрицательное значение (подземные этажи — building:levels:underground).', { tag: `${k}=${t[k]}` }));
    else if (!Number.isInteger(n)) add('error', 'number', tr('{tag} — этажи считают целыми; дробную высоту задают через {key}.',
      { tag: `${k}=${t[k]}`, key: k === 'building:min_level' ? 'min_height' : k === 'roof:levels' ? 'roof:height' : 'height' }));
  }
  if (t['building:min_level'] !== undefined && Number(t['building:min_level']) === 0) add('warning', 'levels', tr('building:min_level=0 — лишний тег: часть и так начинается с земли.'), set({ 'building:min_level': undefined }));
  if (t['building:min_level'] !== undefined && t['building:levels'] === undefined) add('warning', 'levels', tr('building:min_level без building:levels — число этажей части не определено.'));
  if (Number(t['building:levels']) === 0 && !(Number(t['building:levels:underground']) > 0)) add('warning', 'levels', tr('building:levels=0 — у здания нет надземных этажей (подземное — с building:levels:underground).'));
  const height = parseLength(t.height), min = parseLength(t.min_height), roof = parseLength(t['roof:height']);
  const before = out.length;
  if (height !== undefined && min !== undefined && min >= height) {
    add('error', 'heights', tr('min_height ({min} м) не меньше height ({height} м) — объём вывернут. height отсчитывают от земли до верха, а не от min_height.', { min: fmt(min), height: fmt(height) }));
  } else if (height !== undefined && roof !== undefined && roofShapeOf(t) !== 'flat' && roof > height - (min ?? 0) + 0.01) {
    add('warning', 'heights', tr('roof:height ({roof} м) больше высоты объёма ({height} м) — крыша обрезана.', { roof: fmt(roof), height: fmt(height - (min ?? 0)) }));
  }
  const levels = Number(t['building:levels']), minLevel = Number(t['building:min_level']);
  if (t['building:levels'] !== undefined && t['building:min_level'] !== undefined && Number.isFinite(levels) && Number.isFinite(minLevel) && levels <= minLevel) {
    add('error', 'levels', tr('building:levels ({levels}) не больше building:min_level ({min}) — '
      + 'building:levels считает этажи от земли, включая пропущенные снизу.', { levels: t['building:levels'], min: t['building:min_level'] }));
  } else if (out.length === before && height !== undefined && t['building:levels'] !== undefined && Number.isFinite(levels) && levels > (Number(minLevel) || 0)) {
    const h = computeHeights(t);
    const step = (h.wallTop - h.min) / (levels - (Number(minLevel) || 0));
    if (step < MIN_LEVEL_HEIGHT || step > MAX_LEVEL_HEIGHT) {
      add('warning', 'levels', tr('building:levels={levels} при высоте стен {walls} м — этаж выходит {step} м.', { levels: t['building:levels'], walls: fmt(h.wallTop - h.min), step: fmt(step) }));
    }
  }
  const raw = t['roof:shape'], shape = raw?.trim().toLowerCase();
  if (shape !== undefined) {
    const main = roofShapeOf(t);
    if (/^\d+(\.\d+)?$/.test(shape)) add('warning', 'roof', tr('roof:shape={value} — число вместо формы; число этажей в крыше — roof:levels.', { value: raw! }));
    else if (shape === 'many') add('warning', 'roof', tr('roof:shape=many описывает несколько форм крыши; задайте формы на отдельных частях и удалите этот ключ.'), set({ 'roof:shape': undefined }));
    else if (ROOF_UNCLEAR[shape]) add('warning', 'roof', tr('roof:shape={value} — {hint}.', { value: raw!, hint: ROOF_UNCLEAR[shape] }));
    else if (!KNOWN_ROOFS.has(main)) add('warning', 'roof', tr('roof:shape={value} — неизвестная форма крыши (рисуется плоской).', { value: raw! }));
    else if (shape !== main && !ROOF_DOCUMENTED.has(shape)) add('warning', 'roof', tr('roof:shape={value} — значение с проблемами, основное — {main}.', { value: raw!, main }), set({ 'roof:shape': main }));
    else if (raw !== shape) add('warning', 'roof', tr('roof:shape={value} — значения пишут строчными: {lower}.', { value: raw!, lower: shape }), set({ 'roof:shape': shape }));
  }
  // roofShapeOf also maps many/mixed to flat for rendering; that fallback says nothing about roof levels.
  if (Number(t['roof:levels']) > 0 && shape === 'flat') {
    add('warning', 'roof', tr('roof:levels={levels} при roof:shape=flat — в плоской крыше нет этажей.', { levels: t['roof:levels'] }));
  }
  const orient = t['roof:orientation'];
  if (orient !== undefined && orient !== 'along' && orient !== 'across') {
    const o = orient.trim().toLowerCase(), word = COMPASS_WORDS[o];
    const hint = o === 'accross' ? tr('правильно across') : word ? tr('сторону света пишут в roof:direction={dir}', { dir: word }) : tr('допустимо along или across');
    const fix = o === 'accross' || o === 'across' || o === 'along' ? set({ 'roof:orientation': o.replace('accross', 'across') })
      : word && t['roof:direction'] === undefined ? set({ 'roof:orientation': undefined, 'roof:direction': word }) : undefined;
    add('warning', 'roof', tr('roof:orientation={value} — {hint}.', { value: orient, hint }), fix);
  }
  const dir = t['roof:direction'];
  if (dir !== undefined) {
    const deg = Number(dir);
    if (dir === 'along' || dir === 'across') add('warning', 'roof', tr('roof:direction={value} — это значение roof:orientation.', { value: dir }),
      orient === undefined ? set({ 'roof:direction': undefined, 'roof:orientation': dir }) : undefined);
    else if (COMPASS_WORDS[dir.toLowerCase()]) add('warning', 'roof', tr('roof:direction={value} — пишут буквой: {letter}.', { value: dir, letter: COMPASS_WORDS[dir.toLowerCase()] }), set({ 'roof:direction': COMPASS_WORDS[dir.toLowerCase()] }));
    else if (COMPASS.test(dir.toUpperCase()) && !COMPASS.test(dir)) add('warning', 'roof', tr('roof:direction={value} — стороны света пишут заглавными: {upper}.', { value: dir, upper: dir.toUpperCase() }), set({ 'roof:direction': dir.toUpperCase() }));
    else if (!COMPASS.test(dir) && !(dir.trim() !== '' && Number.isFinite(deg) && deg >= 0 && deg <= 360)) add('warning', 'roof', tr('roof:direction={value} — ожидаются градусы 0–360 или N, NE, SSW…', { value: dir }));
  }
  if (orient !== undefined && dir !== undefined) add('warning', 'roof', tr('Заданы и roof:orientation, и roof:direction — это альтернативы, оставьте одно.'));
  const angle = t['roof:angle'];
  if (angle !== undefined) {
    const a = Number(angle);
    if (!Number.isFinite(a) || a < 0 || a > 90) add('warning', 'roof', tr('roof:angle={value} — ожидается угол в градусах 0–90.', { value: angle }));
  }
  for (const k of COLOUR_KEYS) {
    const v = t[k];
    if (v === undefined) continue;
    if (v.startsWith('#') && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) add('warning', 'colour', tr('{tag} — неверный hex-цвет (нужно #RGB или #RRGGBB).', { tag: `${k}=${v}` }));
    else if (/^gray$/i.test(v)) add('warning', 'colour', tr('{tag} — в OSM британское написание: grey.', { tag: `${k}=${v}` }), set({ [k]: 'grey' }));
  }
  return out;
}

/** Ошибки Simple Indoor Tagging и страниц его ключей. Проверяем только загруженные indoor-объекты. */
export function validateIndoor(f: Pick<IndoorFeature, 'key' | 'tags'>, interiorDoor = false): Issue[] {
  if (f.key.endsWith('#poi')) return []; // значок уже представлен площадным объектом
  const { key, tags: t } = f;
  const out: Issue[] = [];
  const add = (level: IssueLevel, code: string, text: string, fix?: Fix) => out.push({ key, level, code, text, ...(fix ? { fix } : {}) });
  const space = ['room', 'area', 'corridor', 'wall', 'level', 'column'].includes(t.indoor);

  if (t.inside !== undefined) add('warning', 'indoor-key', tr('inside=* — неустоявшийся ключ; проверьте, нужен ли здесь indoor=*.'));
  if (t.indoor === 'highway' || t.indoor === 'stairs') add('warning', 'indoor-key',
    tr('indoor={value} — тип объекта указывают отдельным тегом; для общего признака используют indoor=yes.', { value: t.indoor }));
  if (space && t.level === undefined) add('error', 'indoor-level', tr('У indoor-объекта нет level=* — этаж обязателен для поэтажного плана.'));
  if (t.room !== undefined && t.indoor !== 'room' && t.indoor !== 'area') add('warning', 'indoor-room',
    tr('room=* описывает назначение помещения; проверьте indoor=room или indoor=area.'));
  if (t['building:part'] !== undefined && space) add('warning', 'indoor-key',
    tr('building:part=* описывает объём здания, а не помещение indoor=*.'));
  if (t.entrance === 'yes' && (t.indoor === 'door' || interiorDoor)) add('warning', 'indoor-door',
    tr('Внутренняя дверь: entrance=yes обозначает вход в здание; используйте indoor=door и door=*.'),
    { label: t.door === undefined ? tr('удалить entrance, добавить door=yes') : tr('удалить entrance'),
      tags: { entrance: undefined, indoor: 'door', ...(t.door === undefined ? { door: 'yes' } : {}) } });
  if (t.indoor === 'door' && t.door === undefined && t.entrance !== 'yes') add('warning', 'indoor-door',
    tr('Для внутренней двери indoor=door укажите также door=* (door=no для открытого прохода).'));
  if (t.door === 'loadingdock') add('warning', 'indoor-door', tr('door=loadingdock — погрузочную платформу обозначают amenity=loading_dock.'));
  if (t.entrance === 'gate') add('warning', 'indoor-door', tr('entrance=gate — для ворот проверьте barrier=gate.'));
  if (t['addr:entrance'] === 'yes') add('warning', 'indoor-door', tr('addr:entrance=yes — вход обозначают тегом entrance=*.'));

  for (const tag of ['level', 'repeat_on'] as const) {
    const value = t[tag];
    if (value === undefined) continue;
    const parts = value.split(';').map((s) => s.trim());
    if (parts.some((part) => !/^-?\d+(?:\.\d+)?(?:\s*-\s*-?\d+(?:\.\d+)?)?$/.test(part)) || !parseLevels(value).length)
      add('error', 'indoor-level', tr('{tag}={value} — нужны номера этажей через «;» или диапазон, например -1;0;1 либо -1-1.', { tag, value }));
  }
  if (t.repeat_on !== undefined && t.level === undefined) add('warning', 'indoor-level',
    tr('repeat_on=* задаёт повторения; исходный этаж укажите в level=*.'));
  if (t.repeat_on !== undefined && t.level !== undefined) {
    const base = new Set(parseLevels(t.level));
    if (parseLevels(t.repeat_on).some((n) => base.has(n))) add('warning', 'indoor-level',
      tr('repeat_on=* повторяет этаж из level=* — исходный этаж в список повторений не включают.'));
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

function perimeter(r: [number, number][]): number {
  let l = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) l += Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]);
  return l;
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
      if (distinct >= 3 && selfIntersects(r)) {
        const text = i ? tr('Внутреннее кольцо самопересекается — объём строится неверно.') : tr('Контур самопересекается — объём строится неверно.');
        out.push({ key: f.key, level: 'error', code: 'self', text });
      } else if (distinct < 3 || ringArea(r) < MIN_AREA || 2 * ringArea(r) < MIN_WIDTH * perimeter(r)) {
        const params = { points: distinct, area: fmt(ringArea(r)) };
        const text = i ? tr('Внутреннее кольцо вырождено (разных точек: {points}, площадь {area} м²).', params)
          : tr('Контур вырожден (разных точек: {points}, площадь {area} м²).', params);
        out.push({ key: f.key, level: 'error', code: 'degenerate', text });
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
    if (!outlines.length) out.push({ key: g.key, level: 'warning', code: 'relation', text: tr('В отношении здания нет члена с ролью outline — контура здания.') });
    else if (outlines.length > 1) out.push({ key: g.key, level: 'error', code: 'relation', text: trn(outlines.length, 'В отношении здания {n} контур (роль outline) — должен быть один.|В отношении здания {n} контура (роль outline) — должен быть один.|В отношении здания {n} контуров (роль outline) — должен быть один.') });
    for (const f of features) {
      const r = role.get(f.key);
      if (r === 'outline' && f.tags.building === undefined) out.push({ key: f.key, level: 'warning', code: 'relation', text: tr('Контур здания (роль outline) без тега building.'), fix: { label: 'building=yes', tags: { building: 'yes' } } });
      if (r === 'part' && f.tags['building:part'] === undefined) out.push({ key: f.key, level: 'warning', code: 'relation', text: tr('Часть здания (роль part) без тега building:part.'), fix: { label: 'building:part=yes', tags: { 'building:part': 'yes' } } });
      if (r !== undefined && !['outline', 'part', 'ridge', 'edge'].includes(r)) out.push({ key: f.key, level: 'warning', code: 'relation', text: r ? tr('Роль «{role}» в отношении здания — ожидаются outline или part.', { role: r }) : tr('Роль «пусто» в отношении здания — ожидаются outline или part.') });
    }
  }

  // Ищем корпуса, удалённые от основного скопления частей. Сравниваем именно части:
  // общий outline может охватывать ошибочно добавленный далёкий объект и скрыть разрыв.
  const solidParts = parts.filter((f) => !broken.has(f.key) && f.polygons.length);
  if (g.type === 'relation' && solidParts.length > 1) {
    const boxes = solidParts.map((f) => {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const poly of f.polygons) for (const c of poly.outer) {
        const [x, y] = p(c);
        w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y);
      }
      return { w, s, e, n, area: multiArea(multi(f)) };
    });
    const gap = (a: typeof boxes[number], b: typeof boxes[number]) =>
      Math.hypot(Math.max(0, a.w - b.e, b.w - a.e), Math.max(0, a.s - b.n, b.s - a.n));
    const seen = new Set<number>();
    const clusters: number[][] = [];
    for (let i = 0; i < solidParts.length; i++) {
      if (seen.has(i)) continue;
      const cluster = [i];
      seen.add(i);
      for (let j = 0; j < cluster.length; j++) for (let k = 0; k < solidParts.length; k++) {
        if (!seen.has(k) && gap(boxes[cluster[j]], boxes[k]) <= REMOTE_PART_GAP) { seen.add(k); cluster.push(k); }
      }
      clusters.push(cluster);
    }
    if (clusters.length > 1) {
      const main = clusters.reduce((best, cluster) => cluster.reduce((sum, i) => sum + boxes[i].area, 0) > best.reduce((sum, i) => sum + boxes[i].area, 0) ? cluster : best);
      for (const cluster of clusters) {
        if (cluster === main) continue;
        for (const i of cluster) {
          const f = solidParts[i];
          const distance = Math.min(...main.map((j) => gap(boxes[i], boxes[j])));
          const standalone = !g.members.some((key, j) => key === f.key && g.roles[j] === 'outline');
          out.push({ key: f.key, level: 'warning', code: 'remote-part',
            text: tr('Часть находится отдельно от основного объёма здания (не менее {distance} м). Проверьте, относится ли она к этому зданию.', { distance: fmt(distance) }),
            ...(standalone ? { fix: { label: tr('Исключить из отношения и сделать отдельным зданием'),
              tags: { 'building:part': undefined, building: f.tags.building ?? f.tags['building:part'] ?? 'yes' }, removeFromGroup: g.key } } : {}) });
        }
      }
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
        out.push({ key: f.key, level: 'warning', code: 'outside', text: tr('Часть выходит за контур здания на {area} м² — контур должен охватывать все части.', { area: fmt(rest) }) });
      }
    }
    // Проверяем геометрический пробел между частями у основания, без достраивания объёма по высоте контура.
    const outlineHeights = computeHeights(outline.tags);
    const baseParts = parts.filter((f) => !broken.has(f.key) && computeHeights(f.tags).min <= outlineHeights.min + 0.5
      && computeHeights(f.tags).min < outlineHeights.top - 1);
    if (baseParts.length && outlineArea > 0) {
      const missing = safe(() => multiArea(polygonClipping.difference(o, polygonClipping.union(multi(baseParts[0]), ...baseParts.slice(1).map(multi)))));
      if (missing !== undefined && missing > 1 && missing > outlineArea * 0.001) {
        out.push({ key: outline.key, level: 'warning', code: 'coverage', text: tr('Части не покрывают {pct}% контура — этот участок показан плоским. Добавьте недостающую часть или проверьте роли в отношении.',
          { pct: Math.round((missing / outlineArea) * 100) }) });
      }
    }
    // Высота контура — максимум по частям (Key:building:part)
    const oh = parseLength(outline.tags.height);
    if (oh !== undefined) {
      for (const f of parts) {
        const ph = parseLength(f.tags.height);
        if (ph !== undefined && ph > oh + 0.5) out.push({ key: f.key, level: 'warning', code: 'above', text: tr('height ({part} м) больше, чем у контура ({outline} м): на контуре указывают максимальную высоту здания.', { part: fmt(ph), outline: fmt(oh) }) });
      }
    }
    // Этажность контура — максимум по частям
    const ol = Number(outline.tags['building:levels']);
    if (Number.isFinite(ol)) {
      for (const f of parts) {
        const l = Number(f.tags['building:levels']);
        if (Number.isFinite(l) && l > ol) out.push({ key: f.key, level: 'warning', code: 'above', text: tr('building:levels ({part}) больше, чем у контура ({outline}): на контуре указывают максимальную этажность здания.', { part: l, outline: ol }) });
      }
    }
  }

  // Висящая часть: без min_height внутри части, начинающейся выше земли, — столб от земли сквозь неё
  for (const [key, fl] of floatingParts(parts.filter((f) => !broken.has(f.key)))) {
    out.push({ key, other: fl.on, level: 'warning', code: 'floating',
      text: tr('Часть без min_height вложена в приподнятые части (низ с {min} м). Проверьте, должна ли она доходить до земли.',
        { min: fmt(fl.lift) }) });
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
      if (Math.abs(a.min - b.min) > 0.1 || Math.abs(a.top - b.top) > 0.1) continue;
      const dz = Math.min(a.top, b.top) - Math.max(a.min, b.min);
      if (dz < 0.5 || dz < Math.max(a.top - a.min, b.top - b.min) * DUPLICATE_SHARE) continue;
      const x = safe(() => multiArea(polygonClipping.intersection(multi(a.f), multi(b.f))));
      if (x === undefined || x < a.area * DUPLICATE_PLAN || x < b.area * DUPLICATE_PLAN) continue;
      out.push({ key: a.f.key, other: b.f.key, level: 'warning', code: 'overlap',
        text: tr('Почти совпадает с {other} ({area} м² в плане, высоты {from}–{to} м) — похоже на дубликат части.',
          { other: b.f.key, area: fmt(x), from: fmt(Math.max(a.min, b.min)), to: fmt(Math.min(a.top, b.top)) }) });
    }
  }
  return out;
}

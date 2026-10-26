/**
 * Подписи полей и значений из схемы тегов iD (@openstreetmap/id-tagging-schema) — общие термины и переводы
 * с iD, Rapid и др. Выжимка — src/osm/id-schema.json (npm run presets:extract). Формам формат iD не нужен:
 * они спрашивают только здесь; свои подписи форм главнее (переопределяют iD), чего нет нигде — сырое значение.
 */
import schema from './id-schema.json';
import { lang } from '../i18n';

interface SchemaField {
  id: string;
  type: string;
  options?: string[];
  label: Partial<Record<string, string>>;
  placeholder?: Partial<Record<string, string>>;
  values: Partial<Record<string, Record<string, string>>>;
}

const FIELDS = schema.fields as Record<string, SchemaField>;
/** Свой язык, иначе английский iD (у поля без перевода). */
const pick = <T>(m: Partial<Record<string, T>> | undefined): T | undefined => m?.[lang] ?? m?.en;

/** Название поля по ключу OSM. */
export const idFieldLabel = (key: string): string | undefined => pick(FIELDS[key]?.label);

/** Варианты значений поля из iD (если у поля есть список). */
export const idOptions = (key: string): string[] | undefined => FIELDS[key]?.options;

/** Known OSM keys for free-form tag suggestions. */
export const idTagKeys = (): string[] => Object.keys(FIELDS).sort();

/** Подписи значений из iD, поверх — свои (own). */
export function valueLabels(key: string, own?: Record<string, string>): Record<string, string> {
  const f = FIELDS[key];
  // Только свой язык: английские подписи в русском списке хуже сырых значений
  return { ...(f?.values[lang] ?? {}), ...(own ?? {}) };
}

/** Версия схемы iD (для «О программе» и отладки). */
export const idSchemaVersion: string = schema.version;

/** Геометрия объекта, как её различает iD: от неё зависит, какие пресеты подходят. */
export type PresetGeometry = 'point' | 'vertex' | 'line' | 'area' | 'relation';

interface Preset {
  id: string;
  tags: Record<string, string>;
  geometry: PresetGeometry[];
  score?: number;
  addTags?: Record<string, string>;
  hidden?: boolean;
  name: Partial<Record<string, string>>;
}

/** Пресеты — 300 КБ: грузятся отдельно, при первом обращении; до загрузки названий нет. */
let presets: Preset[] | undefined;
let loading: Promise<void> | undefined;
const loaded = new Set<() => void>();

/** Загрузить пресеты (один раз); onLoad — перерисовать то, что показали без них. */
export function loadPresets(onLoad?: () => void): void {
  if (presets) return;
  if (onLoad) loaded.add(onLoad);
  loading ??= import('./id-presets.json').then((m) => {
    presets = (m.default as unknown as { presets: Preset[] }).presets;
    for (const f of loaded) f();
    loaded.clear();
  }).catch(() => { loading = undefined; });
}

/** Вес совпадения пресета с тегами по правилам iD (presetIndex.match); -1 — не подходит. */
function matchScore(p: Preset, tags: Record<string, string>): number {
  const base = p.score ?? 1;
  let score = 0;
  for (const [k, v] of Object.entries(p.tags)) {
    if (tags[k] === v) score += base;
    else if (v === '*' && tags[k] !== undefined) score += base / 2;
    else return -1;
  }
  for (const [k, v] of Object.entries(p.addTags ?? {})) if (!(k in p.tags) && tags[k] === v) score += base;
  return p.hidden ? score * 0.999 : score;
}

export interface PresetMatch { id: string; name: string; tags: Record<string, string> }

/** Лучший пресет iD для тегов и геометрии; нет подходящего или пресеты ещё не загружены — undefined. */
export function matchPreset(tags: Record<string, string>, geometry: PresetGeometry): PresetMatch | undefined {
  if (!presets) return undefined;
  let best: Preset | undefined, bestScore = 0;
  for (const p of presets) {
    if (!p.geometry.includes(geometry)) continue;
    const s = matchScore(p, tags);
    if (s > bestScore) { best = p; bestScore = s; }
  }
  const name = best && (best.name[lang] ?? best.name.en);
  return best && name ? { id: best.id, name, tags: best.tags } : undefined;
}

/** Замена устаревших тегов (deprecated.json iD): old — что искать ('*' — любое значение), replace — на что ($1 — старое значение). */
// validate.ts принимает тот же вид: { old, replace }
export interface Deprecation { old: Record<string, string>; replace?: Record<string, string> }
let deprecated: Deprecation[] | undefined;

/** Загрузить список устаревших тегов (один раз). */
export function loadDeprecated(onLoad?: () => void): void {
  if (deprecated) return;
  import('./id-deprecated.json').then((m) => { deprecated = m.default as unknown as Deprecation[]; onLoad?.(); }).catch(() => {});
}

/** Устаревшие теги объекта: список iD (пока не загружен — пусто). */
export const deprecations = (): readonly Deprecation[] => deprecated ?? [];

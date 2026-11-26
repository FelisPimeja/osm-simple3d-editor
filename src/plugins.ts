/**
 * Плагины: функциональность вне ядра, подключаемая пользователем (вкладка «Плагины» панели настроек).
 *
 * Плагин описывается манифестом JSON (PluginManifest). Источники:
 * - официальный список — src/plugins/catalog.json (проверен, собирается вместе с редактором);
 * - свой — по ссылке на GitHub-репозиторий (манифест simple3d-plugin.json в корне, загрузка через jsDelivr:
 *   raw.githubusercontent отдаёт text/plain) или прямой https-ссылке на .json.
 *
 * Безопасность: токен OSM лежит в localStorage, поэтому чужой код в странице мог бы править от имени пользователя.
 * Свои плагины — только данные (снимки), без кода; поля проверяются, атрибуция — текстом и https-ссылкой.
 * Код (поле module) — только у плагинов официального списка: модуль src/plugins/<module>.ts из сборки.
 *
 * Включённые плагины с манифестами — в localStorage (подключаются сразу при загрузке, до построения меню),
 * их список (id официальных и ссылки своих) — в профиле (настройка simple3d:plugins, см. src/settings.ts).
 */
import catalogJson from './plugins/catalog.json';
import { registerImagery, unregisterImagery, type Imagery } from './view/basemaps';
import type { PhotoService } from './view/street-photos';
import { tr } from './i18n';

/** Версия API редактора для плагинов: плагин с другой не подключается. */
export const PLUGIN_API = 1;

export interface PluginImagery {
  id: string;
  name: string;
  /** Шаблоны тайлов XYZ ({z}/{x}/{y}), {quadkey} или WMS ({bbox-epsg-3857}); только https. */
  tiles: string[];
  tileSize?: 256 | 512;
  maxzoom?: number;
  attribution: string | { text: string; url?: string };
  /** Лицензия не разрешает обводку для OSM — только просмотр. */
  viewOnly?: boolean;
}

export interface PluginManifest {
  id: string;
  apiVersion: number;
  version?: string;
  name: string;
  description?: string;
  homepage?: string;
  imagery?: PluginImagery[];
  /** Модуль с кодом (только официальный список): src/plugins/<module>.ts, экспорт activate(api). */
  module?: string;
}

/** API для модулей плагинов (официальный список). */
export interface PluginApi {
  apiVersion: number;
  tr: typeof tr;
  /** Сервис уличных фото: слой в группе «Фото и панорамы». */
  registerPhotoService(s: PhotoService, label: string, title: string): void;
}

/** Что редактор делает с содержимым плагинов (задаёт main.ts после построения меню). */
export interface PluginHost {
  addImagery(im: Imagery): void;
  removeImagery(id: string): void;
  addPhotoService(s: PhotoService, label: string, title: string): void;
  removePhotoService(id: string): void;
}

/** Подключённый плагин: источник — 'catalog' или ссылка, которую ввёл пользователь. */
export interface PluginEntry { source: 'catalog' | string; manifest: PluginManifest }

const STORE_KEY = 'osm3d.plugins';
const MANIFEST_FILE = 'simple3d-plugin.json';
const MODULES = import.meta.glob<{ activate(api: PluginApi): void | (() => void) }>('./plugins/*.ts');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isHttps = (u: unknown): u is string => { try { return typeof u === 'string' && new URL(u).protocol === 'https:'; } catch { return false; } };
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Проверить манифест (данные со стороны): лишнее отбросить, ошибку — понятным текстом. */
export function parseManifest(raw: unknown, fromCatalog = false): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error(tr('Манифест плагина — не объект JSON'));
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : undefined;
  if (!id) throw new Error(tr('В манифесте нет id (латиница, цифры, - и _, до 40 знаков)'));
  if (m.apiVersion !== PLUGIN_API) throw new Error(tr('Плагин для другой версии API редактора ({v}, нужна {need})', { v: String(m.apiVersion), need: PLUGIN_API }));
  const name = str(m.name, 80);
  if (!name) throw new Error(tr('В манифесте нет названия (name)'));
  const imagery: PluginImagery[] = [];
  for (const r of Array.isArray(m.imagery) ? m.imagery.slice(0, 20) : []) {
    const i = r as Record<string, unknown>;
    const iid = typeof i.id === 'string' && ID.test(i.id) ? i.id : undefined;
    const iname = str(i.name, 80);
    const tiles = (Array.isArray(i.tiles) ? i.tiles : []).filter((t): t is string => isHttps(t)
      && (/\{z\}/.test(t) && /\{x\}/.test(t) && /\{y\}/.test(t) || /\{quadkey\}|\{bbox-epsg-3857\}/.test(t))).slice(0, 4);
    if (!iid || !iname || !tiles.length) throw new Error(tr('Снимок плагина без id, названия или https-адреса тайлов'));
    const a = i.attribution as PluginImagery['attribution'] | undefined;
    const text = str(typeof a === 'object' && a ? a.text : a, 200);
    if (!text) throw new Error(tr('У снимка «{name}» нет атрибуции', { name: iname }));
    const url = typeof a === 'object' && a && isHttps(a.url) ? a.url : undefined;
    imagery.push({
      id: iid, name: iname, tiles,
      tileSize: i.tileSize === 512 ? 512 : 256,
      maxzoom: typeof i.maxzoom === 'number' ? Math.max(1, Math.min(24, Math.round(i.maxzoom))) : 19,
      attribution: url ? { text, url } : text,
      viewOnly: i.viewOnly === true,
    });
  }
  const module = fromCatalog && typeof m.module === 'string' && ID.test(m.module) ? m.module : undefined;
  if (!imagery.length && !module) throw new Error(tr('В плагине нечего подключать'));
  return {
    id, apiVersion: PLUGIN_API, name, imagery, module,
    version: str(m.version, 20), description: str(m.description, 300),
    homepage: isHttps(m.homepage) ? m.homepage : undefined,
  };
}

/** Официальный список плагинов. */
export const CATALOG: PluginManifest[] = (catalogJson.plugins as unknown[]).flatMap((p) => {
  try { return [parseManifest(p, true)]; } catch (err) { console.warn('plugins/catalog.json:', err); return []; }
});

/**
 * Ссылка пользователя → адрес манифеста: github.com/owner/repo[/tree/ref], owner/repo[@ref] — через jsDelivr;
 * https-ссылка на .json — как есть.
 */
export function manifestUrl(input: string): string {
  const s = input.trim();
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.\/-]+?))?\/?$/.exec(s)
    ?? /^([\w.-]+)\/([\w.-]+?)(?:@([\w.\/-]+))?$/.exec(s);
  if (gh) return `https://cdn.jsdelivr.net/gh/${gh[1]}/${gh[2]}${gh[3] ? `@${gh[3]}` : ''}/${MANIFEST_FILE}`;
  if (isHttps(s) && /\.json(\?.*)?$/i.test(s)) return s;
  throw new Error(tr('Нужна ссылка на репозиторий GitHub (github.com/автор/репо или автор/репо@тег) или https-ссылка на манифест .json'));
}

async function fetchManifest(input: string): Promise<PluginManifest> {
  const url = manifestUrl(input);
  let res: Response;
  try { res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch { throw new Error(tr('Не удалось загрузить {url}', { url })); }
  if (!res.ok) throw new Error(tr('Не удалось загрузить {url}: {status}', { url, status: res.status }));
  let json: unknown;
  try { json = await res.json(); } catch { throw new Error(tr('{url} — не JSON', { url })); }
  return parseManifest(json);
}

// --- Подключённые ---

let entries: PluginEntry[] = [];
try {
  const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as PluginEntry[];
  for (const e of Array.isArray(raw) ? raw : []) {
    try {
      // Официальные — по текущему списку (манифест мог обновиться), свои — проверить заново
      const manifest = e.source === 'catalog' ? CATALOG.find((c) => c.id === e.manifest?.id) : parseManifest(e.manifest);
      if (manifest && !entries.some((x) => x.manifest.id === manifest.id)) entries.push({ source: e.source, manifest });
    } catch { /* сломанная запись — пропустить */ }
  }
} catch { /* без хранилища */ }

function store() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(entries)); } catch { /* до перезагрузки */ }
}

export const pluginEntries = (): readonly PluginEntry[] => entries;

const imageryOf = (m: PluginManifest): Imagery[] => (m.imagery ?? []).map((i) => ({
  id: `plugin-${m.id}-${i.id}`, name: i.name, tiles: i.tiles, tileSize: i.tileSize ?? 256, maxzoom: i.maxzoom ?? 19,
  attribution: typeof i.attribution === 'string' ? esc(i.attribution)
    : i.attribution.url ? `<a href="${esc(i.attribution.url)}" target="_blank" rel="noopener noreferrer">${esc(i.attribution.text)}</a>` : esc(i.attribution.text),
  plugin: m.id, viewOnly: i.viewOnly,
}));

// Снимки — в общий список сразу: сохранённая подложка из плагина узнаётся при загрузке
for (const e of entries) for (const im of imageryOf(e.manifest)) registerImagery(im);

let host: PluginHost | undefined;
/** Что подключил модуль плагина (снять при отключении). */
const active = new Map<string, { photos: string[]; dispose?: () => void }>();

async function activate(m: PluginManifest) {
  if (!host || active.has(m.id)) return;
  const state: { photos: string[]; dispose?: () => void } = { photos: [] };
  active.set(m.id, state);
  for (const im of imageryOf(m)) { registerImagery(im); host.addImagery(im); }
  const load = m.module && MODULES[`./plugins/${m.module}.ts`];
  if (!load) return;
  try {
    const mod = await load();
    if (active.get(m.id) !== state) return; // отключили, пока грузился
    const h = host;
    const dispose = mod.activate({
      apiVersion: PLUGIN_API, tr,
      registerPhotoService: (s, label, title) => { state.photos.push(s.id); h.addPhotoService(s, label, title); },
    });
    if (dispose) state.dispose = dispose;
  } catch (err) {
    console.warn(`plugin ${m.id}:`, err);
  }
}

function deactivate(m: PluginManifest) {
  const state = active.get(m.id);
  active.delete(m.id);
  for (const im of imageryOf(m)) { host?.removeImagery(im.id); unregisterImagery(im.id); }
  if (!state) return;
  for (const id of state.photos) host?.removePhotoService(id);
  try { state.dispose?.(); } catch (err) { console.warn(`plugin ${m.id}:`, err); }
}

/** Редактор готов принимать содержимое плагинов: подключить сохранённые. */
export function setPluginHost(h: PluginHost) {
  host = h;
  for (const e of entries) void activate(e.manifest);
}

let onChange: () => void = () => {};
/** Список подключённых изменился (записать в профиль). */
export function onPluginsChange(cb: () => void) { onChange = cb; }

function add(e: PluginEntry) {
  const old = entries.find((x) => x.manifest.id === e.manifest.id);
  if (old) remove(old.manifest.id, false);
  entries.push(e);
  store();
  void activate(e.manifest);
}

function remove(id: string, save = true) {
  const e = entries.find((x) => x.manifest.id === id);
  if (!e) return;
  entries = entries.filter((x) => x !== e);
  deactivate(e.manifest);
  if (save) store();
}

export function enableCatalog(id: string, on: boolean) {
  const m = CATALOG.find((c) => c.id === id);
  if (!m) return;
  if (on) add({ source: 'catalog', manifest: m }); else remove(id);
  onChange();
}

/** Свой плагин по ссылке; ошибка — исключением с понятным текстом. */
export async function addCustom(input: string): Promise<PluginManifest> {
  const manifest = await fetchManifest(input);
  if (CATALOG.some((c) => c.id === manifest.id)) throw new Error(tr('Плагин «{name}» есть в официальном списке — включите его там', { name: manifest.name }));
  add({ source: input.trim(), manifest });
  onChange();
  return manifest;
}

export function removePlugin(id: string) {
  remove(id);
  onChange();
}

/** Для профиля: id официальных и ссылки своих через пробел, до 255 знаков (не влезшие — только в этом браузере). */
export function pluginsSetting(): string | undefined {
  let out = '';
  for (const e of entries) {
    const v = e.source === 'catalog' ? e.manifest.id : e.source;
    if (/\s/.test(v)) continue;
    if ((out ? out.length + 1 : 0) + v.length > 255) continue;
    out += (out ? ' ' : '') + v;
  }
  return out || undefined;
}

/** Список из профиля: подключить недостающие, снять лишние. Свои грузятся заново (асинхронно). */
export function applyPluginsSetting(v: string | undefined): boolean {
  const want = new Set((v ?? '').split(/\s+/).filter(Boolean));
  const have = new Set(entries.map((e) => (e.source === 'catalog' ? e.manifest.id : e.source)));
  if (want.size === have.size && [...want].every((x) => have.has(x))) return false;
  for (const e of [...entries]) if (!want.has(e.source === 'catalog' ? e.manifest.id : e.source)) remove(e.manifest.id);
  for (const w of want) {
    if (have.has(w)) continue;
    const m = CATALOG.find((c) => c.id === w);
    if (m) add({ source: 'catalog', manifest: m });
    else void fetchManifest(w).then((manifest) => add({ source: w, manifest })).catch((err) => console.warn('plugin', w, err));
  }
  store();
  return true;
}

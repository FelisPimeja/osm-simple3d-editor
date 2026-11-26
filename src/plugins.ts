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
import { lang, tr } from './i18n';
import { Marker } from 'maplibre-gl';
import { openPanel } from './view/plugin-panel';

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
  /**
   * Модуль с кодом (только официальный список), экспорт activate(api): имя модуля сборки src/plugins/<module>.ts
   * или внешний — https://cdn.jsdelivr.net/gh/<автор>/<репо>@<полный SHA коммита>/<файл>.js (коммит не меняется:
   * подключается ровно проверенный код).
   */
  module?: string;
}

/** Плавающее окно плагина (как окно уличных фото). */
export interface PluginPanel {
  body: HTMLElement;
  setTitle(title: string): void;
  close(): void;
  /** Окно закрыли (крестиком или плагин). */
  onClose(cb: () => void): void;
}

export type MapClick = (lngLat: [number, number], info: { onObject: boolean }) => boolean | void;

/** Конус направления взгляда на карте: точка, азимут (° от севера), раствор (°). */
export interface ViewCone { lngLat: [number, number]; azimuth: number; fov?: number }

/** API для модулей плагинов (официальный список). */
export interface PluginApi {
  apiVersion: number;
  tr: typeof tr;
  /** Язык интерфейса ('ru', 'en'). */
  lang: string;
  /** Сервис уличных фото: слой в группе «Фото и панорамы». */
  registerPhotoService(s: PhotoService, label: string, title: string): void;
  /**
   * Своя галка в группе «Фото и панорамы» (для сервисов, показываемых своими средствами, без тайлов точек).
   * Состояние запоминается; onChange вызывается и сразу, если галка была включена. set — переключить из плагина.
   */
  addPhotoToggle(id: string, label: string, title: string, onChange: (on: boolean) => void): { set(on: boolean): void };
  /**
   * Клик по карте (вне инструментов): true — плагин обработал клик, выбор объекта не нужен.
   * onObject — под курсором здание или другой объект редактора (обычно такой клик стоит оставить выбору).
   */
  onMapClick(cb: MapClick): void;
  openPanel(title: string): PluginPanel;
  /** Конус взгляда на карте; undefined — убрать. */
  setViewCone(cone?: ViewCone): void;
  /** Источник правок для changeset: снимки (imagery_used) или уличные фото (source=streetlevel imagery). */
  markUsed(kind: 'imagery' | 'street', name: string): void;
}

/** Что редактор делает с содержимым плагинов (задаёт main.ts после построения меню). */
export interface PluginHost {
  map: import('maplibre-gl').Map;
  addPhotoToggle(id: string, label: string, title: string, on: boolean, onChange: (on: boolean) => void): (on: boolean) => void;
  removePhotoToggle(id: string): void;
  markUsed(kind: 'imagery' | 'street', name: string): void;
  addImagery(im: Imagery): void;
  removeImagery(id: string): void;
  addPhotoService(s: PhotoService, label: string, title: string): void;
  removePhotoService(id: string): void;
}

/** Подключённый плагин: источник — 'catalog' или ссылка, которую ввёл пользователь. */
export interface PluginEntry { source: 'catalog' | string; manifest: PluginManifest }

const STORE_KEY = 'osm3d.plugins';
const MANIFEST_FILE = 'simple3d-plugin.json';
type PluginModule = { activate(api: PluginApi): void | (() => void) };
const MODULES = import.meta.glob<PluginModule>('./plugins/*.ts');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isHttps = (u: unknown): u is string => { try { return typeof u === 'string' && new URL(u).protocol === 'https:'; } catch { return false; } };
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Внешний модуль официального плагина: jsDelivr, закреплённый полным SHA коммита. */
const EXTERNAL_MODULE = /^https:\/\/cdn\.jsdelivr\.net\/gh\/[\w.-]+\/[\w.-]+@[0-9a-f]{40}\/[\w./-]+\.m?js$/;
/** Путь модуля внутри репозитория доверенного плагина. */
const RELATIVE_MODULE = /^[\w-]+(\/[\w-]+)*\.m?js$/;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Проверить манифест (данные со стороны): лишнее отбросить, ошибку — понятным текстом. */
export function parseManifest(raw: unknown, fromCatalog = false, trustedBase?: string): PluginManifest {
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
  const mod = typeof m.module === 'string' ? m.module.trim() : '';
  // Доверенный репозиторий: модуль только из того же репо и ref, что и манифест (относительный путь или уже разрешённый)
  const module = fromCatalog ? (ID.test(mod) || EXTERNAL_MODULE.test(mod) ? mod : undefined)
    : trustedBase && RELATIVE_MODULE.test(mod) ? trustedBase + mod
      : trustedBase && mod.startsWith(trustedBase) && RELATIVE_MODULE.test(mod.slice(trustedBase.length)) ? mod
        : undefined;
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

/** Доверенные репозитории (owner/repo): свои плагины оттуда могут выполнять код. Меняется только PR-ом в редактор. */
export const TRUSTED: string[] = ((catalogJson as { trusted?: unknown }).trusted as unknown[] ?? [])
  .filter((t): t is string => typeof t === 'string' && /^[\w.-]+\/[\w.-]+$/.test(t)).map((t) => t.toLowerCase());

function ghRepo(s: string): { owner: string; repo: string; ref?: string } | undefined {
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.\/-]+?))?\/?$/.exec(s)
    ?? /^https:\/\/(?:github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|raw)|raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+))\/([\w.-]+)\/simple3d-plugin\.json$/.exec(s)?.filter(Boolean)
    ?? /^([\w.-]+)\/([\w.-]+?)(?:@([\w.\/-]+))?$/.exec(s);
  return gh ? { owner: gh[1], repo: gh[2], ref: gh[3] } : undefined;
}

/** Базовый адрес jsDelivr для кода доверенного плагина; undefined — репо не доверенный. */
export function trustedBase(input: string): string | undefined {
  const g = ghRepo(input.trim());
  if (!g || !TRUSTED.includes(`${g.owner}/${g.repo}`.toLowerCase())) return undefined;
  return `https://cdn.jsdelivr.net/gh/${g.owner}/${g.repo}${g.ref ? `@${g.ref}` : ''}/`;
}

/**
 * Ссылка пользователя → адрес манифеста: github.com/owner/repo[/tree/ref], owner/repo[@ref] — через jsDelivr;
 * https-ссылка на .json — как есть.
 */
export function manifestUrl(input: string): string {
  const s = input.trim();
  const gh = ghRepo(s);
  if (gh) return `https://cdn.jsdelivr.net/gh/${gh.owner}/${gh.repo}${gh.ref ? `@${gh.ref}` : ''}/${MANIFEST_FILE}`;
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
  return parseManifest(json, false, trustedBase(input));
}

/** Репозиторий без версии: jsDelivr берёт последний тег; если тегов нет — ветка main. Возвращает и итоговую ссылку. */
async function fetchWithFallback(input: string): Promise<{ manifest: PluginManifest; source: string }> {
  const s = input.trim();
  try { return { manifest: await fetchManifest(s), source: s }; } catch (err) {
    const g = ghRepo(s);
    if (!g || g.ref) throw err;
    const alt = `${g.owner}/${g.repo}@main`;
    try { return { manifest: await fetchManifest(alt), source: alt }; } catch { throw err; }
  }
}

// --- Подключённые ---

let entries: PluginEntry[] = [];
try {
  const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as PluginEntry[];
  for (const e of Array.isArray(raw) ? raw : []) {
    try {
      // Официальные — по текущему списку (манифест мог обновиться), свои — проверить заново
      const manifest = e.source === 'catalog' ? CATALOG.find((c) => c.id === e.manifest?.id) : parseManifest(e.manifest, false, trustedBase(e.source));
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
const active = new Map<string, Active>();

type Active = { photos: string[]; toggles: string[]; clicks: MapClick[]; panels: PluginPanel[]; cone?: Marker; dispose?: () => void };
const clickHandlers = (): MapClick[] => [...active.values()].flatMap((a) => a.clicks);

/** Клик по карте — плагинам (main.ts, до выбора объекта); true — обработан. */
export function pluginMapClick(lngLat: [number, number], onObject: boolean): boolean {
  for (const cb of clickHandlers()) {
    try { if (cb(lngLat, { onObject })) return true; } catch (err) { console.warn('plugin click:', err); }
  }
  return false;
}

const toggleKey = (id: string) => `osm3d.plugin-toggle.${id}`;

function coneEl(fov: number): HTMLElement {
  const el = document.createElement('div');
  const r = 34, a = (fov / 2) * Math.PI / 180;
  const x = r * Math.sin(a), y = r * Math.cos(a);
  el.innerHTML = `<svg width="${2 * r}" height="${2 * r}" viewBox="${-r} ${-r} ${2 * r} ${2 * r}" style="display:block;pointer-events:none">
    <path d="M0 0 L${-x} ${-y} A${r} ${r} 0 0 1 ${x} ${-y} Z" fill="rgba(220,38,38,.3)" stroke="#dc2626" stroke-width="1.5"/>
    <circle r="5" fill="#dc2626" stroke="#fff" stroke-width="2"/></svg>`;
  return el;
}

async function activate(m: PluginManifest) {
  if (!host || active.has(m.id)) return;
  const state: Active = { photos: [], toggles: [], clicks: [], panels: [] };
  active.set(m.id, state);
  for (const im of imageryOf(m)) { registerImagery(im); host.addImagery(im); }
  const load = !m.module ? undefined
    : /^https:\/\//.test(m.module) ? () => import(/* @vite-ignore */ m.module!) as Promise<PluginModule>
      : MODULES[`./plugins/${m.module}.ts`];
  if (!load) return;
  try {
    const mod = await load();
    if (active.get(m.id) !== state) return; // отключили, пока грузился
    const h = host;
    const api: PluginApi = {
      apiVersion: PLUGIN_API, tr, lang,
      registerPhotoService: (s, label, title) => { state.photos.push(s.id); h.addPhotoService(s, label, title); },
      addPhotoToggle: (id, label, title, onChange) => {
        const full = `plugin-${m.id}-${id}`;
        let on = false;
        try { on = localStorage.getItem(toggleKey(full)) === '1'; } catch { /* без хранилища */ }
        const change = (v: boolean) => {
          try { if (v) localStorage.setItem(toggleKey(full), '1'); else localStorage.removeItem(toggleKey(full)); } catch { /* до перезагрузки */ }
          try { onChange(v); } catch (err) { console.warn(`plugin ${m.id}:`, err); }
        };
        const set = h.addPhotoToggle(full, label, title, on, change);
        state.toggles.push(full);
        if (on) queueMicrotask(() => change(true));
        return { set: (v: boolean) => { set(v); change(v); } };
      },
      onMapClick: (cb) => { state.clicks.push(cb); },
      openPanel: (title) => { const p = openPanel(title, h.map); state.panels.push(p); p.onClose(() => { state.panels = state.panels.filter((x) => x !== p); }); return p; },
      setViewCone: (cone) => {
        state.cone?.remove();
        state.cone = undefined;
        if (!cone) return;
        state.cone = new Marker({ element: coneEl(cone.fov ?? 70), rotation: cone.azimuth, rotationAlignment: 'map', pitchAlignment: 'map' })
          .setLngLat(cone.lngLat).addTo(h.map);
      },
      markUsed: (kind, name) => h.markUsed(kind, name),
    };
    const dispose = mod.activate(api);
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
  for (const id of state.toggles) host?.removePhotoToggle(id);
  for (const p of [...state.panels]) p.close();
  state.cone?.remove();
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
  const { manifest, source } = await fetchWithFallback(input);
  if (CATALOG.some((c) => c.id === manifest.id)) throw new Error(tr('Плагин «{name}» есть в официальном списке — включите его там', { name: manifest.name }));
  add({ source, manifest });
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

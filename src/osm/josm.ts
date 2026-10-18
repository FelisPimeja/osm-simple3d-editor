import type { Bbox, OsmElement, OsmMember } from './api';
import { tr } from '../i18n';

/**
 * Данные из JOSM через его Remote Control: GET /export отдаёт активный слой в .osm (вместе с несохранёнными
 * правками и новыми объектами с отрицательными id). Нужен JOSM 19439 (25.08) или новее, включённый Remote Control
 * и разрешение «Export data from JOSM» (по умолчанию выключено). Ответы JOSM — с Access-Control-Allow-Origin: *;
 * http://127.0.0.1 браузеры считают надёжным источником, со страницы по https запрос не блокируется
 * (Chrome 142+ один раз спрашивает разрешение на доступ к локальной сети).
 */
export const JOSM_URL = 'http://127.0.0.1:8111';
/**
 * Плагин simple3d для JOSM (josm-plugin/): свой сервер на 127.0.0.1:8112 — отдаёт слой без настроек Remote Control,
 * сообщает об изменениях сразу (долгий опрос) и принимает правки редактора через подмножество OSM API 0.6:
 * они становятся одной командой JOSM (отменяется Ctrl+Z в JOSM).
 */
// Страницу отдал сам плагин (http://127.0.0.1:порт/editor/ — так работает и Safari) — он по тому же адресу
export const PLUGIN_URL = location.hostname === '127.0.0.1' && location.pathname.startsWith('/editor/') ? location.origin : 'http://127.0.0.1:8112';
/** Плагин отвечает: правки уходят в JOSM, слой читается через него. */
let plugin = false;
/** Ревизия слоя у плагина (растёт при каждом изменении данных в JOSM). */
let pluginRev: string | undefined;
export const josmPlugin = () => plugin;
/** Адрес API 0.6 плагина — для отправки правок в JOSM (undefined — плагина нет). */
export const josmApi = () => (plugin ? `${PLUGIN_URL}/api/0.6` : undefined);
/** Отмена (redo — повтор) последней команды в JOSM. */
export async function josmUndo(redo = false) {
  if (plugin) await fetch(`${PLUGIN_URL}/simple3d/${redo ? 'redo' : 'undo'}`, { method: 'POST' });
}
/** Первая стабильная версия JOSM с командой /export (r19425). */
const MIN_VERSION = 19439;

/** Источник данных из адреса: ?source=josm. */
export const josmMode = new URLSearchParams(location.search).get('source') === 'josm';

/** Включить или выключить источник JOSM в адресе (replaceState, без перезагрузки). */
export function writeJosmParam(on: boolean) {
  const url = new URL(location.href);
  if (on) url.searchParams.set('source', 'josm'); else url.searchParams.delete('source');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

/** areas — области загрузки слоя (<bounds> из JOSM): тайловые здания скрываются только внутри них. */
export interface JosmLayer { elements: OsmElement[]; bbox?: Bbox; areas: Bbox[]; fetchedAt: number; changed: JosmChange[] }

/** Объект слоя с неотправленной правкой (что JOSM отправит в OSM): new — создан, modify — изменён, delete — удалён. */
export interface JosmChange { key: string; kind: 'new' | 'modify' | 'delete'; tags: Record<string, string> }

/** Состояние плагина: история команд JOSM (общая с правками из 3D), пользователь и сервер JOSM. */
export interface JosmStatus {
  rev: number; layer: boolean; layerName?: string; api?: string; user?: string;
  undo: number; redo: number; undoName?: string; redoName?: string;
}
let status: JosmStatus | undefined;
export const josmStatus = () => status;

/** Перечитать состояние плагина (после изменения слоя: undo/redo в JOSM всегда меняют данные). */
export async function refreshJosmStatus(): Promise<JosmStatus | undefined> {
  if (!plugin) return;
  try { status = await fetch(`${PLUGIN_URL}/simple3d/status`).then((r) => r.json() as Promise<JosmStatus>); } catch { /* следующий раз */ }
  return status;
}

/**
 * Выделение в JOSM: f вызывается с ключами type/id при каждом изменении (долгий опрос плагина).
 * Пустой список — в JOSM ничего не выделено.
 */
export function watchJosmSelection(f: (keys: string[]) => void) {
  let rev: number | undefined;
  const loop = async () => {
    try {
      const res = await fetch(`${PLUGIN_URL}/simple3d/selection${rev ? `?since=${rev}` : ''}`);
      if (res.status === 200) {
        const s = (await res.json()) as { rev: number; keys: string[] };
        rev = s.rev;
        f(s.keys);
      }
      setTimeout(loop, 0);
    } catch { setTimeout(loop, 2000); }
  };
  void loop();
}

/** Выделить в JOSM (пустой список — снять выделение). */
export async function sendJosmSelection(keys: string[]) {
  if (plugin) await fetch(`${PLUGIN_URL}/simple3d/selection`, { method: 'POST', body: keys.join(',') });
}

let layer: Promise<JosmLayer> | undefined;
/** Ответ /export последней загрузки — чтобы опрос перерисовывал только изменившийся слой. */
let lastXml: string | undefined;

/** Слой JOSM: запрашивается один раз (дальше его обновляет опрос, pollJosmLayer). */
export function josmLayer(): Promise<JosmLayer> {
  if (!layer) {
    layer = loadLayer();
    layer.catch(() => { layer = undefined; }); // после ошибки следующий вызов спросит JOSM снова
  }
  return layer;
}

async function loadLayer(): Promise<JosmLayer> {
  plugin = await fetch(`${PLUGIN_URL}/simple3d/status`).then((r) => r.ok).catch(() => false);
  if (plugin) {
    const xml = await exportXml();
    if (!xml.trim()) throw new Error(tr('В JOSM нет активного слоя данных OSM. Откройте или выберите слой данных.'));
    return toLayer(xml);
  }
  const version = await josmGet('/version').then((r) => r.json() as Promise<{ version?: number }>);
  if (version.version && version.version < MIN_VERSION) {
    throw new Error(tr('JOSM {v} не умеет отдавать данные — нужна версия {min} (25.08) или новее.', { v: version.version, min: MIN_VERSION }));
  }
  const xml = await exportXml();
  if (!xml.trim()) {
    throw new Error(tr('JOSM ничего не отдал: активный слой не слой данных OSM или идёт отправка. Выберите слой данных в JOSM и обновите.'));
  }
  return toLayer(xml);
}

const exportXml = () => (plugin ? pluginExport() : josmGet('/export').then((r) => r.text()));

/** Слой от плагина; since — ждать изменения после этой ревизии (до 25 с; не дождались — пустая строка). */
async function pluginExport(since?: string): Promise<string> {
  const res = await fetch(`${PLUGIN_URL}/simple3d/export${since ? `?since=${since}` : ''}`);
  if (res.status === 204) return '';
  if (!res.ok) throw new Error(tr('JOSM ответил {status} на {path}', { status: res.status, path: '/simple3d/export' }));
  pluginRev = res.headers.get('X-Simple3D-Rev') ?? undefined;
  return res.text();
}

function toLayer(xml: string): JosmLayer {
  const changed: JosmChange[] = [];
  const elements = parseOsmXml(xml, changed);
  lastXml = xml;
  return { elements, bbox: elementsBbox(elements), areas: parseBounds(xml), fetchedAt: Date.now(), changed };
}

/**
 * Проверка изменений: слой JOSM, если он изменился с прошлой загрузки, иначе undefined. До первой удачной
 * загрузки, во время отправки из JOSM (пустой ответ) и при ошибках — undefined: опрос не должен шуметь.
 */
export async function pollJosmLayer(): Promise<JosmLayer | undefined> {
  if (lastXml === undefined) return;
  const xml = await (plugin ? pluginExport(pluginRev) : exportXml()).catch(() => '');
  if (!xml.trim() || xml === lastXml) return;
  const next = toLayer(xml);
  layer = Promise.resolve(next);
  return next;
}

async function josmGet(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(JOSM_URL + path);
  } catch {
    throw new Error(tr('JOSM не отвечает на localhost:8111: запустите JOSM и включите Remote Control (Настройки → Remote Control). '
      + 'Если браузер спросил о доступе к локальной сети — разрешите.'));
  }
  if (res.status === 403) {
    throw new Error(tr('JOSM запретил экспорт: включите «Export data from JOSM» в Настройках → Remote Control.'));
  }
  if (!res.ok) throw new Error(tr('JOSM ответил {status} на {path}', { status: res.status, path }));
  return res;
}

/** .osm XML → элементы в форме ответа API (JSON). Удалённые в JOSM (action="delete", visible="false") пропускаются. */
export function parseOsmXml(xml: string, changed?: JosmChange[]): OsmElement[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(tr('JOSM отдал не .osm (ошибка разбора XML)'));
  const out: OsmElement[] = [];
  const movedNodes = new Set<number>();
  for (const el of doc.documentElement.children) {
    const deleted = el.getAttribute('action') === 'delete' || el.getAttribute('visible') === 'false';
    const id = Number(el.getAttribute('id'));
    const version = Number(el.getAttribute('version') ?? 0);
    const tags: Record<string, string> = {};
    for (const t of el.getElementsByTagName('tag')) tags[t.getAttribute('k')!] = t.getAttribute('v') ?? '';
    if (changed && el.tagName !== 'bounds') {
      const kind = id < 0 ? (deleted ? undefined : 'new') : deleted ? 'delete' : el.getAttribute('action') === 'modify' ? 'modify' : undefined;
      // Вершины без тегов в список не идут: их правка — правка пути (сдвинули контур)
      if (kind && el.tagName === 'node' && !Object.keys(tags).length) movedNodes.add(id);
      else if (kind) changed.push({ key: `${el.tagName}/${id}`, kind, tags });
    }
    if (deleted) continue;
    const withTags = Object.keys(tags).length ? { tags } : {};
    if (el.tagName === 'node') {
      out.push({ type: 'node', id, lat: Number(el.getAttribute('lat')), lon: Number(el.getAttribute('lon')), ...withTags });
    } else if (el.tagName === 'way') {
      const nodes = [...el.getElementsByTagName('nd')].map((n) => Number(n.getAttribute('ref')));
      out.push({ type: 'way', id, version, nodes, ...withTags });
    } else if (el.tagName === 'relation') {
      const members = [...el.getElementsByTagName('member')].map((m) => ({
        type: m.getAttribute('type') as OsmMember['type'], ref: Number(m.getAttribute('ref')), role: m.getAttribute('role') ?? '',
      }));
      out.push({ type: 'relation', id, version, members, ...withTags });
    }
  }
  if (changed && movedNodes.size) {
    const have = new Set(changed.map((c) => c.key));
    for (const el of out) {
      if (el.type !== 'way' || have.has(`way/${el.id}`) || !el.nodes.some((n) => movedNodes.has(n))) continue;
      changed.push({ key: `way/${el.id}`, kind: 'modify', tags: el.tags ?? {} });
    }
  }
  return out;
}

/** Области загрузки: JOSM пишет <bounds> на каждую скачанную область слоя. */
function parseBounds(xml: string): Bbox[] {
  const out: Bbox[] = [];
  for (const m of xml.matchAll(/<bounds\b[^>]*>/g)) {
    const a = (k: string) => Number(new RegExp(`${k}=['"]([^'"]+)`).exec(m[0])?.[1]);
    const b: Bbox = [a('minlon'), a('minlat'), a('maxlon'), a('maxlat')];
    if (b.every(Number.isFinite)) out.push(b);
  }
  return out;
}

function elementsBbox(elements: OsmElement[]): Bbox | undefined {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const el of elements) {
    if (el.type !== 'node') continue;
    w = Math.min(w, el.lon); e = Math.max(e, el.lon);
    s = Math.min(s, el.lat); n = Math.max(n, el.lat);
  }
  return w <= e ? [w, s, e, n] : undefined;
}

/** Самый маленький id в слое — временные id редактора должны начинаться ниже, чтобы не совпасть с новыми объектами JOSM. */
export function minElementId(elements: OsmElement[]): number {
  return elements.reduce((m, el) => Math.min(m, el.id), 0);
}

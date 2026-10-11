/**
 * Настройки пользователя (окно «Настройки пользователя»). Хранятся в localStorage; после входа синхронизируются
 * с настройками профиля на сервере (API 0.6 /user/preferences, ключи с префиксом simple3d:) — у каждого сервера
 * (OSM, OHM, OGF) свой профиль. Чтение — право read_prefs, запись — write_prefs.
 *
 * Кто главнее: если в этом браузере настройку меняли после последней синхронизации с сервером — браузер
 * (значение уходит в профиль), иначе — профиль (значение приходит в браузер).
 */
import { isLang, lang, storedLang, storeLang, type Lang } from './i18n';
import { canWritePrefs, getToken } from './osm/auth';
import { apiFetch, server, type OsmServer } from './osm/servers';

const PREFIX = 'simple3d:';
/** Когда настройки последний раз меняли в этом браузере (мс). */
const CHANGED_KEY = 'osm3d.prefs.changed';
/** Когда последний раз сверялись с профилем на сервере (мс). */
const syncedKey = (s: OsmServer) => `osm3d.prefs.synced.${s.id}`;

/** Что изменилось после применения значения из профиля. */
export type Applied = 'same' | 'live' | 'reload';

export interface Setting {
  /** Ключ в профиле без префикса (simple3d:<key>); значение — до 255 символов. */
  key: string;
  /** Значение для профиля; undefined — в профиле этой настройки быть не должно (не выбирали или выключено). */
  local(): string | undefined;
  /** Принять значение из профиля (undefined — в профиле его нет). */
  apply(v: string | undefined): Applied;
  /** Нет в профиле, а здесь выбрано — занести (язык, выбранный до появления синхронизации). */
  seed?: boolean;
}

const SETTINGS: Setting[] = [
  {
    key: 'locale',
    local: () => storedLang(),
    apply: (v) => {
      if (!isLang(v)) return 'same';
      storeLang(v);
      return v === lang ? 'same' : 'reload';
    },
    seed: true,
  },
];

/** Добавить настройку (из main.ts — у кого её состояние). */
export function registerSetting(st: Setting) {
  SETTINGS.push(st);
}

function num(key: string): number {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}
function stamp(key: string) {
  try { localStorage.setItem(key, String(Date.now())); } catch { /* без хранилища */ }
}

async function api(s: OsmServer, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await apiFetch(`${s.api}/user/preferences${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${getToken(s)}` },
  });
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  return res;
}

async function readProfile(s: OsmServer): Promise<Record<string, string>> {
  const { preferences } = (await (await api(s, '.json')).json()) as { preferences: Record<string, string> };
  return preferences ?? {};
}

async function writeProfile(s: OsmServer, key: string, value: string | undefined) {
  const path = `/${encodeURIComponent(PREFIX + key)}`;
  if (value !== undefined) {
    await api(s, path, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: value });
    return;
  }
  try { await api(s, path, { method: 'DELETE' }); } catch (err) {
    if (!String(err).includes('404')) throw err; // и так нет
  }
}

/** Привести профиль к настройкам этого браузера: записать отличающиеся, удалить лишние. */
async function push(s: OsmServer, profile: Record<string, string>) {
  for (const st of SETTINGS) {
    const v = st.local();
    if (v !== profile[PREFIX + st.key]) await writeProfile(s, st.key, v);
  }
  stamp(syncedKey(s));
}

export type SyncStatus = 'local' | 'synced' | 'readonly';

/** Где сейчас хранятся настройки: только в браузере, в профиле или профиль только читается (нет write_prefs). */
export function syncStatus(s: OsmServer = server()): SyncStatus {
  if (!getToken(s)) return 'local';
  return canWritePrefs(s) ? 'synced' : 'readonly';
}

/**
 * Сверить настройки с профилем (после входа и при загрузке страницы с сохранённым токеном).
 * true — пришло значение, которое применится только перезагрузкой страницы (язык, сглаживание).
 */
export async function syncPrefs(s: OsmServer = server()): Promise<boolean> {
  if (!getToken(s)) return false;
  const profile = await readProfile(s);
  const writable = canWritePrefs(s);
  // Здесь меняли после последней сверки — главный браузер
  if (num(CHANGED_KEY) > num(syncedKey(s))) {
    if (writable) await push(s, profile);
    return false;
  }
  let reload = false;
  for (const st of SETTINGS) {
    const v = profile[PREFIX + st.key];
    if (v === undefined && st.seed && st.local() !== undefined) continue; // занесём ниже
    if (st.apply(v) === 'reload') reload = true;
  }
  if (writable && SETTINGS.some((st) => st.seed && profile[PREFIX + st.key] === undefined && st.local() !== undefined)) await push(s, profile);
  else stamp(syncedKey(s));
  return reload;
}

/**
 * Настройку изменили здесь (новое значение уже в local()). Записывает в профиль, если можно;
 * false — записать не удалось (запишется при следующей сверке).
 */
export async function saveSetting(key: string, s: OsmServer = server()): Promise<boolean> {
  stamp(CHANGED_KEY);
  const status = syncStatus(s);
  if (status !== 'synced') return status === 'local';
  const st = SETTINGS.find((x) => x.key === key)!;
  try {
    await writeProfile(s, key, st.local());
    stamp(syncedKey(s));
    return true;
  } catch (err) {
    console.warn('OSM preferences:', err);
    return false;
  }
}

/** Пользователь сменил язык (применится перезагрузкой). */
export function saveLang(l: Lang, s: OsmServer = server()): Promise<boolean> {
  storeLang(l);
  return saveSetting('locale', s);
}

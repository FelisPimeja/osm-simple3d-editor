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
import { server, type OsmServer } from './osm/servers';

const PREFIX = 'simple3d:';
/** Когда настройки последний раз меняли в этом браузере (мс). */
const CHANGED_KEY = 'osm3d.prefs.changed';
/** Когда последний раз сверялись с профилем на сервере (мс). */
const syncedKey = (s: OsmServer) => `osm3d.prefs.synced.${s.id}`;

interface Setting {
  key: string;
  /** Явно выбранное значение в этом браузере (undefined — не выбирали, действует умолчание). */
  local(): string | undefined;
  /** Принять значение из профиля; false — значение не подходит. */
  apply(v: string): boolean;
}

const SETTINGS: Setting[] = [
  {
    key: 'locale',
    local: () => storedLang(),
    apply: (v) => { if (!isLang(v)) return false; storeLang(v); return true; },
  },
];

function num(key: string): number {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}
function stamp(key: string) {
  try { localStorage.setItem(key, String(Date.now())); } catch { /* без хранилища */ }
}

async function api(s: OsmServer, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${s.api}/user/preferences${path}`, {
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

async function writeProfile(s: OsmServer, key: string, value: string) {
  await api(s, `/${encodeURIComponent(PREFIX + key)}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: value });
}

/** Отправить в профиль все явно выбранные настройки. */
async function push(s: OsmServer) {
  for (const st of SETTINGS) {
    const v = st.local();
    if (v !== undefined) await writeProfile(s, st.key, v);
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
 * Возвращает язык из профиля, если он отличается от текущего (применится перезагрузкой).
 */
export async function syncPrefs(s: OsmServer = server()): Promise<Lang | undefined> {
  if (!getToken(s)) return;
  const localNewer = num(CHANGED_KEY) > num(syncedKey(s));
  if (localNewer && canWritePrefs(s)) { await push(s); return; }
  const profile = await readProfile(s);
  const missing: Setting[] = [];
  for (const st of SETTINGS) {
    const v = profile[PREFIX + st.key];
    if (v === undefined) missing.push(st);
    else if (!localNewer) st.apply(v);
  }
  // В профиле ещё нет выбранного здесь значения — заносим
  if (canWritePrefs(s) && missing.some((st) => st.local() !== undefined)) await push(s);
  else if (!localNewer) stamp(syncedKey(s));
  const l = storedLang();
  return l && l !== lang ? l : undefined;
}

/**
 * Пользователь сменил язык. Запоминает в браузере и, если можно, в профиле;
 * false — в профиль записать не удалось (запишется при следующей синхронизации).
 */
export async function saveLang(l: Lang, s: OsmServer = server()): Promise<boolean> {
  storeLang(l);
  stamp(CHANGED_KEY);
  if (syncStatus(s) !== 'synced') return syncStatus(s) === 'local';
  try {
    await writeProfile(s, 'locale', l);
    stamp(syncedKey(s));
    return true;
  } catch (err) {
    console.warn('OSM preferences:', err);
    return false;
  }
}

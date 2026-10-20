/**
 * Последние использованные цвета (до 12) — для окна выбора цвета в свойствах. Хранятся в IndexedDB (своя база,
 * как у камеры): в памяти — сразу, в базу — в фоне; без IndexedDB — только до перезагрузки.
 */
const MAX = 12;
const DB = 'osm-simple3d-colours';
const STORE = 'colours';

let list: string[] = [];

async function database(): Promise<IDBDatabase | undefined> {
  if (!('indexedDB' in globalThis)) return;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** Загрузить сохранённые (один раз при старте). */
export async function loadRecentColours(): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).get('recent');
      request.onsuccess = () => {
        const v: unknown = request.result;
        // Записали, пока грузилось, — свежие впереди
        if (Array.isArray(v)) list = [...new Set([...list, ...v.filter((c): c is string => typeof c === 'string')])].slice(0, MAX);
        db.close(); resolve();
      };
      request.onerror = () => { db.close(); resolve(); };
    } catch { db.close(); resolve(); }
  });
}

async function save() {
  const db = await database();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(list, 'recent');
    tx.oncomplete = tx.onerror = tx.onabort = () => db.close();
  } catch { db.close(); }
}

/** Последние цвета, свежие первыми. */
export const recentColours = (): readonly string[] => list;

/** Цвет использовали (поле в свойствах или заливка): в начало списка. */
export function recordColour(colour: string | undefined) {
  const c = colour?.trim();
  if (!c) return;
  const key = c.toLowerCase();
  if (list[0]?.toLowerCase() === key) return;
  list = [c, ...list.filter((x) => x.toLowerCase() !== key)].slice(0, MAX);
  void save();
}

/** Последняя камера карты. Отдельная база не зависит от версии кеша тайлов. */
export interface SavedCamera { center: [number, number]; zoom: number; bearing: number; pitch: number }

function valid(v: unknown): v is SavedCamera {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<SavedCamera>;
  return Array.isArray(c.center) && c.center.length === 2 && c.center.every(Number.isFinite)
    && c.center[1] >= -90 && c.center[1] <= 90
    && [c.zoom, c.bearing, c.pitch].every((n) => typeof n === 'number' && Number.isFinite(n))
    && c.zoom! >= -2 && c.zoom! <= 24 && c.pitch! >= 0 && c.pitch! <= 175;
}

async function database(): Promise<IDBDatabase | undefined> {
  if (!('indexedDB' in globalThis)) return;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('osm-simple3d-camera', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('camera');
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

export async function loadCamera(): Promise<SavedCamera | undefined> {
  const db = await database();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const request = db.transaction('camera').objectStore('camera').get('last');
      request.onsuccess = () => { db.close(); resolve(valid(request.result) ? request.result : undefined); };
      request.onerror = () => { db.close(); resolve(undefined); };
    } catch { db.close(); resolve(undefined); }
  });
}

export async function saveCamera(camera: SavedCamera): Promise<void> {
  const db = await database();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('camera', 'readwrite');
      tx.objectStore('camera').put(camera, 'last');
      tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
    } catch { db.close(); resolve(); }
  });
}

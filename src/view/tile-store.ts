import type { Feature3D } from '../osm/model';

const DB_NAME = 'osm-simple3d';
const STORE = 'overpass-tiles';
/** Версия формата записи: при изменении Feature3D старые записи игнорируются. */
const FORMAT = 2;
/** Сколько тайлов хранить; при превышении удаляются самые старые. */
const MAX_TILES = 300;

interface TileRecord { key: string; format: number; fetchedAt: number; features: Feature3D[] }

export interface StoredTile { features: Feature3D[]; fetchedAt: number }

/**
 * Постоянный кеш тайлов Overpass в IndexedDB.
 * Любая ошибка (приватный режим, квота, заблокированное хранилище) не ломает работу —
 * просто считаем, что кеша нет.
 */
export class TileStore {
  private db?: Promise<IDBDatabase | undefined>;

  private open(): Promise<IDBDatabase | undefined> {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('fetchedAt', 'fetchedAt');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { console.warn('IndexedDB недоступна:', req.error); resolve(undefined); };
        req.onblocked = () => resolve(undefined);
      } catch (err) {
        console.warn('IndexedDB недоступна:', err);
        resolve(undefined);
      }
    });
    return this.db;
  }

  async get(key: string): Promise<StoredTile | undefined> {
    const rec = await this.request<TileRecord | undefined>('readonly', (s) => s.get(key));
    return rec?.format === FORMAT ? { features: rec.features, fetchedAt: rec.fetchedAt } : undefined;
  }

  async put(key: string, features: Feature3D[], fetchedAt: number) {
    const rec: TileRecord = { key, format: FORMAT, fetchedAt, features };
    const ok = await this.request('readwrite', (s) => s.put(rec));
    if (ok === undefined) {
      // Скорее всего, квота: освобождаем половину и пробуем ещё раз
      await this.evict(Math.floor(MAX_TILES / 2));
      await this.request('readwrite', (s) => s.put(rec));
    }
    await this.evict(MAX_TILES);
  }

  async count(): Promise<number> {
    return (await this.request<number>('readonly', (s) => s.count())) ?? 0;
  }

  async clear() {
    await this.request('readwrite', (s) => s.clear());
  }

  /** Оставляет не больше keep самых свежих тайлов. */
  private async evict(keep: number) {
    const total = await this.count();
    if (total <= keep) return;
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        let toDelete = total - keep;
        const cursor = tx.objectStore(STORE).index('fetchedAt').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || toDelete-- <= 0) return;
          c.delete();
          c.continue();
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /** Выполняет запрос; undefined при любой ошибке. */
  private async request<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let result: T | undefined;
        req.onsuccess = () => { result = req.result as T; };
        tx.oncomplete = () => resolve(mode === 'readwrite' ? (result ?? (true as T)) : result);
        tx.onerror = tx.onabort = () => { console.warn('IndexedDB:', tx.error); resolve(undefined); };
      } catch (err) {
        console.warn('IndexedDB:', err);
        resolve(undefined);
      }
    });
  }
}

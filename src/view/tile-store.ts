import type { BuildingGroup, Feature3D, IndoorFeature } from '../osm/model';

const STORE = 'overpass-tiles';
/** Версия формата записи: при изменении Feature3D старые записи игнорируются. */
// 5 — части отношений терялись при разборе (голая копия пути затирала теги): старые тайлы перезапрашиваем
// 6 — добавлены indoor-объекты (поэтажные планы); записи формата 5 читаются без них и обновляются в фоне
// 7 — догрузка indoor-мультиполигонов на границе тайла; записи 6 показываются и обновляются в фоне
const FORMAT = 7;
/** Роль члена, которая неизвестна (кеш старого формата): при отправке сверяемся с сервером только по type/ref. */
export const UNKNOWN_ROLE = '?';
/** Сколько тайлов хранить; при превышении удаляются самые старые. */
const MAX_TILES = 300;

interface TileRecord { key: string; format: number; fetchedAt: number; features: Feature3D[]; groups: BuildingGroup[]; indoor?: IndoorFeature[]; via?: TileVia }

/** Откуда пришли данные тайла: OSM API (overpass — старые записи кеша, когда данные брались из Overpass). */
export type TileVia = 'overpass' | 'api';

export interface StoredTile { features: Feature3D[]; groups: BuildingGroup[]; indoor: IndoorFeature[]; fetchedAt: number; via?: TileVia }

/**
 * Постоянный кеш тайлов (данные OSM API) в IndexedDB.
 * Любая ошибка (приватный режим, квота, заблокированное хранилище) не ломает работу —
 * просто считаем, что кеша нет.
 */
export class TileStore {
  private db?: Promise<IDBDatabase | undefined>;

  /** dbName — своя база на каждый сервер (боевой, тестовый). */
  constructor(private readonly dbName = 'osm-simple3d') {}

  private open(): Promise<IDBDatabase | undefined> {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, 1);
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
    if (rec?.format === FORMAT) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], fetchedAt: rec.fetchedAt, via: rec.via };
    if (rec?.format === 6) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], fetchedAt: 0, via: rec.via };
    if (rec?.format === 5) return { features: rec.features, groups: rec.groups, indoor: [], fetchedAt: 0, via: rec.via };
    // Формат 3 — группы без ролей: читаем (роли неизвестны) и считаем тайл устаревшим, чтобы он обновился в фоне
    if (rec?.format === 3) {
      const groups = rec.groups.map((g) => ({ ...g, roles: g.roles ?? g.members.map(() => UNKNOWN_ROLE) }));
      return { features: rec.features, groups, indoor: [], fetchedAt: 0 };
    }
    return undefined;
  }

  async put(key: string, { features, groups, indoor, fetchedAt, via }: StoredTile) {
    const rec: TileRecord = { key, format: FORMAT, fetchedAt, features, groups, indoor, via };
    const ok = await this.request('readwrite', (s) => s.put(rec));
    if (ok === undefined) {
      // Скорее всего, квота: освобождаем половину и пробуем ещё раз
      await this.evict(Math.floor(MAX_TILES / 2));
      await this.request('readwrite', (s) => s.put(rec));
    }
    await this.evict(MAX_TILES);
  }

  /** Ключи всех сохранённых тайлов (формат записи не проверяется — при чтении устаревшая запись просто не найдётся). */
  async keys(): Promise<string[]> {
    return ((await this.request<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? []).map(String);
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

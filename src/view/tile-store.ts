import { recordMs } from '../perf';
import type { BuildingGroup, Feature3D, IndoorFeature } from '../osm/model';
import type { TreeData } from '../osm/trees';
import type { RoadWay } from '../osm/roads';

const STORE = 'overpass-tiles';
/** Версия формата записи: при изменении Feature3D старые записи игнорируются. */
// 5 — части отношений терялись при разборе (голая копия пути затирала теги): старые тайлы перезапрашиваем
// 6 — добавлены indoor-объекты (поэтажные планы); записи формата 5 читаются без них и обновляются в фоне
// 7 — догрузка indoor-мультиполигонов на границе тайла; записи 6 показываются и обновляются в фоне
// 8 — деревья и леса (trees); записи 7 показываются без деревьев и обновляются в фоне
// 9 — дороги для мостов и развязок (roads); записи 8 показываются без дорог и обновляются в фоне
// 10 — дороги в Overpass-запросе только при включённых мостах/тоннелях; без них roads не записываются (перекачка при включении)
// 11 — у отдельных деревьев сохраняются id и теги для выбора; старые тайлы обновляются в фоне
// 12 — у лесов и рядов деревьев сохраняются start_date/end_date (фильтр по дате OHM)
// 13 — входы (entrance=*) на контурах зданий; записи 12 показываются без них и обновляются в фоне
const FORMAT = 13;
/** Роль члена, которая неизвестна (кеш старого формата): при отправке сверяемся с сервером только по type/ref. */
export const UNKNOWN_ROLE = '?';
/** Сколько тайлов хранить; при превышении удаляются самые старые. */
const MAX_TILES = 300;

interface TileRecord { key: string; format: number; fetchedAt: number; features: Feature3D[]; groups: BuildingGroup[]; indoor?: IndoorFeature[]; trees?: TreeData; roads?: RoadWay[]; via?: TileVia }

/** Откуда пришли данные тайла: OSM API (overpass — старые записи кеша, когда данные брались из Overpass). */
export type TileVia = 'overpass' | 'api';

/** roads — нет у записей до формата 9. */
export interface StoredTile { features: Feature3D[]; groups: BuildingGroup[]; indoor: IndoorFeature[]; trees?: TreeData; roads?: RoadWay[]; fetchedAt: number; via?: TileVia }

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
      const t = performance.now();
      try {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('fetchedAt', 'fetchedAt');
        };
        req.onsuccess = () => { recordMs('тайлы: открытие IndexedDB', performance.now() - t); resolve(req.result); };
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
    const rec = await this.request<TileRecord | undefined>('readonly', (s) => s.get(key), 'тайлы: запрос к IndexedDB');
    if (rec?.format === FORMAT) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], trees: rec.trees, roads: rec.roads, fetchedAt: rec.fetchedAt, via: rec.via };
    if (rec?.format === 12) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], trees: rec.trees, roads: rec.roads, fetchedAt: 0, via: rec.via };
    if (rec?.format === 11) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], trees: rec.trees, roads: rec.roads, fetchedAt: 0, via: rec.via };
    if (rec?.format === 10) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], trees: rec.trees, roads: rec.roads, fetchedAt: 0, via: rec.via };
    if (rec?.format === 8 || rec?.format === 9) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], trees: rec.trees, fetchedAt: 0, via: rec.via };
    if (rec?.format === 7) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], fetchedAt: 0, via: rec.via };
    if (rec?.format === 6) return { features: rec.features, groups: rec.groups, indoor: rec.indoor ?? [], fetchedAt: 0, via: rec.via };
    if (rec?.format === 5) return { features: rec.features, groups: rec.groups, indoor: [], fetchedAt: 0, via: rec.via };
    // Формат 3 — группы без ролей: читаем (роли неизвестны) и считаем тайл устаревшим, чтобы он обновился в фоне
    if (rec?.format === 3) {
      const groups = rec.groups.map((g) => ({ ...g, roles: g.roles ?? g.members.map(() => UNKNOWN_ROLE) }));
      return { features: rec.features, groups, indoor: [], fetchedAt: 0 };
    }
    return undefined;
  }

  async put(key: string, { features, groups, indoor, trees, roads, fetchedAt, via }: StoredTile) {
    const rec: TileRecord = { key, format: FORMAT, fetchedAt, features, groups, indoor, trees, roads, via };
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
  /** label — замер самого запроса (от транзакции до ответа базы, без ожидания основного потока после него). */
  private async request<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, label?: string): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const t = performance.now();
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let result: T | undefined;
        req.onsuccess = () => { result = req.result as T; if (label) recordMs(label, performance.now() - t); };
        tx.oncomplete = () => resolve(mode === 'readwrite' ? (result ?? (true as T)) : result);
        tx.onerror = tx.onabort = () => { console.warn('IndexedDB:', tx.error); resolve(undefined); };
      } catch (err) {
        console.warn('IndexedDB:', err);
        resolve(undefined);
      }
    });
  }
}

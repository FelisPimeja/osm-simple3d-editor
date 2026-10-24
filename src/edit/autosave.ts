/**
 * Автосохранение правок в IndexedDB: у каждой вкладки своя запись (id вкладки — в sessionStorage, переживает
 * перезагрузку). После перезагрузки вкладка берёт свою запись; запись закрытой вкладки (её «пульс» в localStorage
 * давно не обновлялся) можно подобрать в новой. Любая ошибка хранилища не мешает работе — просто без автосохранения.
 */
const DB = 'osm-simple3d-edits';
const STORE = 'sessions';
const TAB_KEY = 'osm3d.tab-id';
const PULSE_PREFIX = 'osm3d.tab-alive.';
const PULSE_MS = 5000;
/** Вкладка без пульса дольше этого — закрыта, её правки ничьи. */
const STALE_MS = 20000;
const SAVE_DELAY_MS = 1000;

export interface SavedEdits<T> { id: string; server: string; savedAt: number; count: number; data: T }

function tabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) { id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; sessionStorage.setItem(TAB_KEY, id); }
    return id;
  } catch { return 'default'; }
}

let dbp: Promise<IDBDatabase | undefined> | undefined;
function open(): Promise<IDBDatabase | undefined> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
  return dbp;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      let out: T | undefined;
      req.onsuccess = () => { out = req.result as T; };
      tx.oncomplete = () => resolve(out ?? (true as T));
      tx.onerror = tx.onabort = () => { console.warn('Автосохранение правок:', tx.error); resolve(undefined); };
    } catch (err) { console.warn('Автосохранение правок:', err); resolve(undefined); }
  });
}

export class Autosave<T> {
  readonly id = tabId();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => { count: number; data: T } | undefined;

  /** server — id сервера: правки другого сервера не восстанавливаются. */
  constructor(private readonly server: () => string) {
    const pulse = () => { try { localStorage.setItem(PULSE_PREFIX + this.id, String(Date.now())); } catch { /* без хранилища */ } };
    pulse();
    setInterval(pulse, PULSE_MS);
    // Уходим со страницы — записать сразу, не дожидаясь таймера
    addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
  }

  /** Запланировать запись (схлопывается с частыми правками). snapshot: undefined или count = 0 — правок нет, запись стирается. */
  schedule(snapshot: () => { count: number; data: T } | undefined) {
    this.pending = snapshot;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    const take = this.pending;
    this.pending = undefined;
    if (!take) return;
    let s: { count: number; data: T } | undefined;
    try { s = take(); } catch (err) { console.warn('Автосохранение правок:', err); return; }
    if (!s?.count) { void run('readwrite', (st) => st.delete(this.id)); return; }
    const rec: SavedEdits<T> = { id: this.id, server: this.server(), savedAt: Date.now(), count: s.count, data: s.data };
    void run('readwrite', (st) => st.put(rec));
  }

  /** Своя запись (перезагрузка вкладки) — для того же сервера. */
  async own(): Promise<SavedEdits<T> | undefined> {
    const rec = await run<SavedEdits<T>>('readonly', (s) => s.get(this.id));
    return rec && typeof rec === 'object' && rec.server === this.server() ? rec : undefined;
  }

  /** Записи закрытых вкладок того же сервера, свежие первыми. */
  async orphans(): Promise<SavedEdits<T>[]> {
    const all = (await run<SavedEdits<T>[]>('readonly', (s) => s.getAll())) ?? [];
    const now = Date.now();
    const alive = (id: string) => { try { return now - Number(localStorage.getItem(PULSE_PREFIX + id) ?? 0) < STALE_MS; } catch { return false; } };
    return (Array.isArray(all) ? all : []).filter((r) => r.id !== this.id && r.server === this.server() && !alive(r.id))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Подобрать запись закрытой вкладки: она становится своей. */
  async adopt(rec: SavedEdits<T>) {
    await run('readwrite', (s) => s.delete(rec.id));
    try { localStorage.removeItem(PULSE_PREFIX + rec.id); } catch { /* без хранилища */ }
    await run('readwrite', (s) => s.put({ ...rec, id: this.id }));
  }

  async discard(id: string) {
    await run('readwrite', (s) => s.delete(id));
    try { localStorage.removeItem(PULSE_PREFIX + id); } catch { /* без хранилища */ }
  }
}

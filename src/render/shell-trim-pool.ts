/**
 * Обрезка граней оболочки здания (trimTriangles) в пуле воркеров: на сотнях частей (собор, комплекс) это
 * десятки секунд работы, в главном потоке — фризы и низкий FPS. Объёмы соседей уходят в воркер один раз
 * и дальше передаются по номеру. Без Worker (тесты в Node) — trimSync в вызывающем потоке.
 */
import type { LocalPolygon } from './building-geometry';
import { trimTriangles, type PreparedSolid } from './shell-trim';

export interface TrimJob {
  positions: Float32Array; wallVertices: number; floorVertices: number;
  polys: LocalPolygon[]; glassWalls: boolean; glassRoof: boolean; thin: boolean;
  deps: PreparedSolid[];
}
export interface TrimResult { walls: Float32Array; roof: Float32Array; cut: Float32Array }

/** Сообщение воркеру: новые объёмы (номер → объём) и задание с номерами соседей. */
export interface TrimMessage {
  id: number; solids: [number, PreparedSolid][]; clear?: boolean;
  job: Omit<TrimJob, 'deps'> & { deps: number[] };
}

export function trimSync(j: Omit<TrimJob, 'deps'>, deps: PreparedSolid[]): TrimResult {
  const n = j.positions.length / 3, end = n - j.floorVertices;
  return {
    walls: Float32Array.from(trimTriangles(j.positions, 0, j.wallVertices, j.polys, j.glassWalls, deps, j.thin)),
    roof: Float32Array.from(trimTriangles(j.positions, j.wallVertices, end, j.polys, j.glassRoof, deps, j.thin)),
    // Перекрытия внутри непрозрачного соседа — тоже внутренние грани
    cut: Float32Array.from(trimTriangles(j.positions, end, n, j.polys, false, deps, true)),
  };
}

/** Сколько объёмов держит воркер, прежде чем начать заново (здания меняются — старые не нужны). */
const MAX_SOLIDS = 20000;

interface Slot { worker: Worker; known: Set<number>; busy: number }
let slots: Slot[] | undefined;
let nextId = 1;
const solidIds = new WeakMap<PreparedSolid, number>();
const waiting = new Map<number, { resolve: (r: TrimResult) => void; reject: (e: unknown) => void }>();

function pool(): Slot[] | undefined {
  if (slots) return slots.length ? slots : undefined;
  slots = [];
  if (typeof Worker === 'undefined') return;
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    try {
      const worker = new Worker(new URL('./shell-trim-worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, known: new Set(), busy: 0 };
      worker.onmessage = (e: MessageEvent<{ id: number; result?: TrimResult; error?: string }>) => {
        slot.busy--;
        const w = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        if (e.data.result) w?.resolve(e.data.result); else w?.reject(new Error(e.data.error));
      };
      slots.push(slot);
    } catch { /* воркеры недоступны — обрезка в главном потоке */ }
  }
  return slots.length ? slots : undefined;
}

/** Есть ли воркеры: иначе обрезка — trimSync по порциям в главном потоке. */
export function trimWorkersAvailable(): boolean {
  return !!pool();
}

export function trimInWorker(job: TrimJob): Promise<TrimResult> {
  const slot = pool()!.reduce((a, b) => (b.busy < a.busy ? b : a));
  if (slot.known.size > MAX_SOLIDS) slot.known.clear();
  const clear = slot.known.size === 0;
  const solids: [number, PreparedSolid][] = [];
  const deps = job.deps.map((s) => {
    let id = solidIds.get(s);
    if (id === undefined) solidIds.set(s, id = nextId++);
    if (!slot.known.has(id)) { slot.known.add(id); solids.push([id, s]); }
    return id;
  });
  const id = nextId++;
  slot.busy++;
  const msg: TrimMessage = { id, solids, clear, job: { ...job, deps } };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    slot.worker.postMessage(msg);
  });
}

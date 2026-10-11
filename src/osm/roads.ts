import type { OsmElement, OsmNode, OsmWay } from './api';
import type { LonLat } from './model';

/**
 * Дороги для объёмных мостов, тоннелей и развязок (эксперимент). Рисуем не все дороги, а только «неплоские»:
 * мосты, тоннели, пути с layer ≠ 0 — и их подходы (пандусы), по которым высота спускается к земле.
 */
export interface RoadWay {
  id: number;
  tags: Record<string, string>;
  /** id узлов (параллельно coords): по ним пути связываются в сеть. */
  nodes: number[];
  coords: LonLat[];
}

/** Как далеко по сети от моста или тоннеля брать подходы, м: на этом расстоянии пандус точно сходит к земле. */
export const ROAD_REACH_M = 500;

/** Пути highway, которые не рисуем: площади, проекты, разобранные. */
const SKIP_HIGHWAY = new Set(['proposed', 'construction', 'abandoned', 'razed', 'disused', 'platform', 'bus_stop', 'elevator', 'corridor']);
/** Тоннели «на уровне земли»: проезд под зданием, крытая улица — для высоты это обычная дорога. */
const GROUND_TUNNELS = new Set(['no', 'building_passage', 'covered']);

export function isRoadTags(tags?: Record<string, string>): boolean {
  const h = tags?.highway;
  return !!h && !SKIP_HIGHWAY.has(h) && tags.area !== 'yes';
}

export function isBridge(tags: Record<string, string>): boolean {
  return !!tags.bridge && tags.bridge !== 'no';
}

export function isTunnel(tags: Record<string, string>): boolean {
  return !!tags.tunnel && !GROUND_TUNNELS.has(tags.tunnel);
}

/** Уровень пути: layer, а без него мост — 1, тоннель — -1, остальное — 0. */
export function roadLevel(tags: Record<string, string>): number {
  const l = Number.parseFloat(tags.layer ?? '');
  if (Number.isFinite(l)) return Math.max(-5, Math.min(5, Math.round(l)));
  if (isBridge(tags)) return 1;
  if (isTunnel(tags)) return -1;
  return 0;
}

/** Путь сам по себе не на земле: его высота задана тегами, а не подходами. */
export function isElevated(tags: Record<string, string>): boolean {
  return roadLevel(tags) !== 0 || isBridge(tags) || isTunnel(tags);
}

/**
 * Из ответа /map — неплоские дороги и всё, что связано с ними по сети не дальше ROAD_REACH_M
 * (остальные дороги не нужны: на них высота уже 0).
 */
export function parseRoads(elements: OsmElement[]): RoadWay[] {
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way' && isRoadTags(e.tags)) ways.push(e);
  }
  // Сеть: узел → пути через него
  const byNode = new Map<number, number[]>();
  ways.forEach((w, i) => { for (const n of w.nodes) { const l = byNode.get(n); if (l) l.push(i); else byNode.set(n, [i]); } });
  const pos = (id: number): LonLat | undefined => { const n = nodes.get(id); return n && [n.lon, n.lat]; };

  // Дейкстра от узлов неплоских путей по всей сети дорог, с отсечкой по расстоянию
  const dist = new Map<number, number>();
  const heap = new MinHeap();
  for (const w of ways) {
    if (!isElevated(w.tags!)) continue;
    for (const n of w.nodes) if (!dist.has(n) && nodes.has(n)) { dist.set(n, 0); heap.push(n, 0); }
  }
  if (!dist.size) return [];
  while (heap.size) {
    const [n, d] = heap.pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    const p = pos(n)!;
    for (const wi of byNode.get(n) ?? []) {
      const ns = ways[wi].nodes;
      for (let k = 0; k < ns.length; k++) {
        if (ns[k] !== n) continue;
        for (const j of [k - 1, k + 1]) {
          const m = ns[j];
          const q = m === undefined ? undefined : pos(m);
          if (!q) continue;
          const nd = d + metres(p, q);
          if (nd > ROAD_REACH_M || nd >= (dist.get(m) ?? Infinity)) continue;
          dist.set(m, nd);
          heap.push(m, nd);
        }
      }
    }
  }

  const out: RoadWay[] = [];
  for (const w of ways) {
    if (!w.nodes.some((n) => dist.has(n))) continue;
    const coords: LonLat[] = [], ids: number[] = [];
    for (const n of w.nodes) { const p = pos(n); if (p) { coords.push(p); ids.push(n); } }
    if (coords.length >= 2) out.push({ id: w.id, tags: w.tags!, nodes: ids, coords });
  }
  return out;
}

/** Расстояние между точками, м (локально плоское приближение). */
export function metres([x1, y1]: LonLat, [x2, y2]: LonLat): number {
  const k = Math.cos(((y1 + y2) / 2) * Math.PI / 180);
  return Math.hypot((x2 - x1) * k, y2 - y1) * 111_320;
}

/** Двоичная куча (id, приоритет) для Дейкстры. */
export class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    let i = this.ids.length;
    this.ids.push(id); this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.ids[0], this.keys[0]];
    const id = this.ids.pop()!, key = this.keys.pop()!;
    const n = this.ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = key;
        if (l < n && this.keys[l] < mk) { m = l; mk = this.keys[l]; }
        if (r < n && this.keys[r] < mk) { m = r; mk = this.keys[r]; }
        if (m === i) break;
        this.ids[i] = this.ids[m]; this.keys[i] = this.keys[m];
        i = m;
      }
      this.ids[i] = id; this.keys[i] = key;
    }
    return top;
  }
}

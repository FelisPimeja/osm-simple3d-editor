/**
 * Правка топологии контуров без нахлёстов: новые узлы на общих сторонах вставляются во все пути с этой
 * стороной, а пути мультиполигона, которые лишь частью остаются в его новом кольце, разрезаются —
 * себе берём нужные куски, остальные остаются соседям (при отправке — во все отношения исходного пути).
 */

/** Новый узел id на стороне u–v (в любом направлении). */
export interface Insert { id: number; u: number; v: number }

/** Список узлов с вставленными узлами на сторонах (как есть: у замкнутого пути первый = последний). */
export function insertInLine(ids: number[], ins: Insert[]): number[] | undefined {
  if (!ins.length || ids.length < 2) return;
  const out = [ids[0]];
  let changed = false;
  for (let j = 1; j < ids.length; j++) {
    const a = ids[j - 1], b = ids[j];
    for (const n of ins) {
      if ((n.u === a && n.v === b) || (n.u === b && n.v === a)) { out.push(n.id); changed = true; }
    }
    out.push(b);
  }
  return changed ? out : undefined;
}

/** То же для кольца без повторённой замыкающей точки (контур полигона) — с координатами. */
export function insertInRing<C>(ids: number[], coords: C[], ins: Insert[], at: (id: number) => C): { ids: number[]; coords: C[] } | undefined {
  const closed = insertInLine([...ids, ids[0]], ins);
  if (!closed) return;
  const out = closed.slice(0, -1);
  const pos = new Map(ids.map((id, i) => [id, coords[i]] as const));
  return { ids: out, coords: out.map((id) => pos.get(id) ?? at(id)) };
}

export interface RingWay { id: number; role: string; nodes: number[]; tags?: Record<string, string> }

export interface Restructured {
  /** Пути кольца после правки (по порядку исходных, новые — в конце). */
  members: { id: number; role: string }[];
  /** Существующие пути, у которых меняется список узлов (оставшийся за ними кусок). */
  lines: Map<number, number[]>;
  /** Новые пути: куски разрезанных (splitFrom) и новые стороны кольца. */
  created: { id: number; nodes: number[]; splitFrom?: number; tags?: Record<string, string> }[];
  /** Исходный путь → его новые куски (в отношениях соседей встают рядом с ним). */
  pieces: Map<number, number[]>;
}

const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Пути кольца мультиполигона под новое кольцо ring (узлы по порядку, без повтора первого).
 * Путь целиком на кольце — остаётся; целиком вне — уходит из кольца (остаётся соседям); частично —
 * режется по границам, наши куски — в кольцо (первый сохраняет id пути). Стороны кольца, которых нет
 * ни в одном пути, — новые пути (по одному на непрерывный участок).
 */
export function restructureRing(ways: RingWay[], ring: number[], role: string, alloc: () => number): Restructured {
  const n = ring.length;
  const edges = new Set<string>();
  for (let i = 0; i < n; i++) edges.add(edgeKey(ring[i], ring[(i + 1) % n]));
  const covered = new Set<string>();
  const res: Restructured = { members: [], lines: new Map(), created: [], pieces: new Map() };
  const cover = (nodes: number[]) => { for (let j = 1; j < nodes.length; j++) covered.add(edgeKey(nodes[j - 1], nodes[j])); };

  for (const w of ways) {
    const nodes = w.nodes;
    const flags = nodes.slice(1).map((b, j) => edges.has(edgeKey(nodes[j], b)));
    if (!flags.length || flags.every((f) => !f)) continue; // не на кольце — соседям
    if (flags.every(Boolean)) { cover(nodes); res.members.push({ id: w.id, role: w.role || role }); continue; }
    // Замкнутый путь — начинаем с границы, чтобы куски не рвались на стыке начала и конца
    let list = nodes, fl = flags;
    if (nodes[0] === nodes[nodes.length - 1]) {
      const s = flags.findIndex((f, j) => f !== flags[(j - 1 + flags.length) % flags.length]);
      const c = nodes.slice(0, -1);
      list = [...c.slice(s), ...c.slice(0, s), c[s]];
      fl = [...flags.slice(s), ...flags.slice(0, s)];
    }
    const pieces: { nodes: number[]; on: boolean }[] = [];
    for (let j = 0; j < fl.length; j++) {
      const last = pieces[pieces.length - 1];
      if (last && last.on === fl[j]) last.nodes.push(list[j + 1]);
      else pieces.push({ nodes: [list[j], list[j + 1]], on: fl[j] });
    }
    const keepAt = pieces.findIndex((p) => p.on);
    const ids: number[] = [];
    pieces.forEach((p, i) => {
      if (i === keepAt) { res.lines.set(w.id, p.nodes); res.members.push({ id: w.id, role: w.role || role }); cover(p.nodes); return; }
      const id = alloc();
      ids.push(id);
      res.created.push({ id, nodes: p.nodes, splitFrom: w.id, ...(w.tags && Object.keys(w.tags).length ? { tags: { ...w.tags } } : {}) });
      if (p.on) { res.members.push({ id, role: w.role || role }); cover(p.nodes); }
    });
    res.pieces.set(w.id, ids);
  }

  // Непокрытые стороны — новые пути по непрерывным участкам
  const free = ring.map((a, i) => !covered.has(edgeKey(a, ring[(i + 1) % n])));
  if (free.every(Boolean)) {
    const id = alloc();
    res.created.push({ id, nodes: [...ring, ring[0]] });
    res.members.push({ id, role });
  } else {
    for (let i = 0; i < n; i++) {
      if (!free[i] || free[(i - 1 + n) % n]) continue; // начало участка
      const nodes = [ring[i]];
      for (let j = i; free[j % n]; j++) nodes.push(ring[(j + 1) % n]);
      const id = alloc();
      res.created.push({ id, nodes });
      res.members.push({ id, role });
    }
  }
  return res;
}

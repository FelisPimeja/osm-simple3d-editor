/**
 * Предиктив подъездов многоквартирного дома: по соседним входам того же контура с заданными ref и addr:flats
 * предлагает номер и диапазон квартир ещё не заполненного входа. Входы идут по порядку узлов контура (по кругу);
 * направление нумерации — по двум известным, при одном известном — к ближайшему по контуру.
 */

/** Кандидат в подъезды: вход жилой лестницы, а не служебный/гаражный. */
export function isStairEntrance(t: Record<string, string>): boolean {
  return !!(t.ref || t['addr:flats']) || ['staircase', 'main', 'yes', 'home'].includes(t.entrance ?? '');
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v) : undefined);
/** Один диапазон «a-b» (или одна квартира). */
function range(v: string | undefined): [number, number] | undefined {
  const m = v?.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/) ?? v?.trim().match(/^(\d+)$/);
  if (!m) return;
  const a = Number(m[1]), b = Number(m[2] ?? m[1]);
  return b >= a ? [a, b] : undefined;
}

/**
 * ring — id входов-подъездов по порядку обхода контура; tags — их текущие теги; target — вход, для которого предлагаем.
 * Возвращает подсказки для пустых ref и addr:flats.
 */
export function predictEntrance(ring: number[], tags: (id: number) => Record<string, string>, target: number): { ref?: string; flats?: string } {
  const n = ring.length, i = ring.indexOf(target);
  if (i < 0 || n < 2) return {};
  const own = tags(target);
  // Номер задан не числом (1а, А…) — ни номер, ни квартиры не угадываем
  if (own.ref?.trim() && num(own.ref) === undefined) return {};
  const known = ring.map((id, j) => ({ j, ref: num(tags(id).ref), flats: range(tags(id)['addr:flats']) })).filter((k) => k.j !== i && k.ref !== undefined);
  if (!known.length) return {};
  // Смещение по контуру от j к i (по кругу), со знаком: кратчайшее
  const off = (j: number) => { let d = ((i - j) % n + n) % n; if (d > n / 2) d -= n; return d; };
  // Направление: возрастают ли номера по обходу (по паре известных, ближайших друг к другу)
  let dir = 0;
  if (known.length >= 2) {
    const [a, b] = known;
    let d = ((b.j - a.j) % n + n) % n; if (d > n / 2) d -= n;
    if (d) dir = Math.sign((b.ref! - a.ref!) / d);
  }
  // Опорный — ближайший известный по контуру
  const base = known.reduce((p, k) => (Math.abs(off(k.j)) < Math.abs(off(p.j)) ? k : p));
  const k = off(base.j);
  let ref = num(own.ref);
  const out: { ref?: string; flats?: string } = {};
  if (ref === undefined) {
    const step = dir ? dir * k : Math.abs(k); // одно известное — нумерация от него вверх
    if (base.ref! + step < 1) return {};
    ref = base.ref! + step;
    if (!known.some((x) => x.ref === ref)) out.ref = String(ref);
    else return {};
  }
  if (!own['addr:flats']) {
    // Квартиры: подъезды одного размера — сдвиг диапазона ближайшего по номеру известного с квартирами
    const withFlats = known.filter((x) => x.flats);
    if (withFlats.length) {
      const near = withFlats.reduce((p, x) => (Math.abs(x.ref! - ref!) < Math.abs(p.ref! - ref!) ? x : p));
      const [a, b] = near.flats!, len = b - a + 1, dr = ref - near.ref!;
      const from = a + dr * len;
      if (from >= 1 && dr !== 0) out.flats = `${from}-${from + len - 1}`;
    }
  }
  return out;
}

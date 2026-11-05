import polygonClipping, { type MultiPolygon } from 'polygon-clipping';

/** Пустоты задаются многоуровневыми помещениями; отсутствие разметки не означает второй свет. */
type Pt = [number, number];

export interface LevelPlan {
  /** Контур этажа: следы объектов здания, которые есть на этом этаже (или полигоны indoor=level). */
  floor: MultiPolygon;
  /** Всё размеченное на этаже: помещения, коридоры, зоны, колонны и стены. */
  mapped: MultiPolygon;
  /** Явные многоуровневые помещения без пола на этом этаже. */
  explicitVoids?: MultiPolygon;
  /** Сплошной пол по контурам этажа (indoor=level, без внутренних колец). */
  solid?: MultiPolygon;
  /** Потолки одноэтажных пространств этажа ниже: комнаты всюду, площадки и коридоры — вне явных проёмов. */
  caps?: MultiPolygon;
}

export interface LevelVoid {
  /** Пустота на этом этаже. */
  polygon: MultiPolygon;
  /** Этажи ниже, видимые сквозь неё: от ближнего к самому нижнему (на нём — пол). */
  through: number[];
}

const ringArea = (r: Pt[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };
export const multiArea = (m: MultiPolygon) => m.reduce((s, poly) => s + ringArea(poly[0] as Pt[]) - poly.slice(1).reduce((t, r) => t + ringArea(r as Pt[]), 0), 0);

function safe(fn: () => MultiPolygon): MultiPolygon {
  try { return fn(); } catch { return []; }
}

const open = (r: Pt[]): Pt[] => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
/** Only explicitly mapped multilevel spaces create voids. */
export function findVoids(n: number, plans: Map<number, LevelPlan>): LevelVoid[] {
  const plan = plans.get(n);
  if (!plan?.floor.length || !plan.explicitVoids?.length) return [];
  const lower = [...plans.keys()].filter(k => k < n).sort((a,b) => b-a);
  if (!lower.length) return [];
  // Помещение этажа ниже под проёмом — с потолком (магазин в атриуме, community.openstreetmap.org/t/148767/116);
  // открытое — многоуровневое (level=0;1), его проём уже в explicitVoids
  const voids = plan.caps?.length ? safe(() => polygonClipping.difference(plan.explicitVoids!, plan.caps!)) : plan.explicitVoids;
  return voids.filter(poly => multiArea([poly]) > 1e-6).map(poly => {
    const through: number[] = [], area = multiArea([poly]);
    for (const k of lower) {
      through.push(k);
      const lp = plans.get(k)!;
      const cover = lp.solid?.length ? safe(() => polygonClipping.union(lp.mapped, lp.solid!)) : lp.mapped;
      if (multiArea(safe(() => polygonClipping.intersection([poly], cover))) >= area * .999) break;
    }
    return {polygon:[poly], through};
  });
}

/** Потолки помещений этажа ниже под этажом n (в проёмах и вне его контура) — там перекрытие этажа n есть. */
export function voidCaps(n: number, plans: Map<number, LevelPlan>): MultiPolygon {
  return (plans.get(n)?.caps ?? []).filter((poly) => multiArea([poly]) > 1e-6);
}

/** Объект здания для контура этажа: полигоны (в метрах) и высоты низа и верха стен. */
export interface PlanPart { polygons: Pt[][][]; min: number; wallTop: number }
/** Indoor-объект в метрах. */
export interface PlanIndoor { kind: string; polygons: Pt[][][]; levels: number[]; line?: boolean; /** Этажи, где у объекта пол (floorLevels). */ floors?: number[] }

const unionOf = (polys: Pt[][][]): MultiPolygon => (polys.length ? safe(() => polygonClipping.union(polys[0] as never, ...(polys.slice(1) as never[]))) : []);

/** Планы этажей для поиска пустот. levels — этажи панели (номер, пол и потолок, м). */
export function buildPlans(levels: { n: number; floor: number; ceil: number }[], parts: PlanPart[], indoor: PlanIndoor[]): Map<number, LevelPlan> {
  const plans = new Map<number, LevelPlan>();
  for (const l of levels) {
    const prev = Math.max(...levels.filter((x) => x.n < l.n).map((x) => x.n));
    const topped = (kinds: string[]) => Number.isFinite(prev) ? indoor.filter((f) => !f.line && kinds.includes(f.kind) && f.levels.length && Math.max(...f.levels) === prev)
      .flatMap((f) => f.polygons.map((p) => p.map(open))) : [];
    // Комната закрыта и под проёмом; площадка и коридор — только вне явных проёмов (пол атриума под кольцом этажа выше
    // открыт), а где этажа выше просто нет в разметке — закрыты: неразмеченное — не второй свет
    const capPolys = topped(['room']), openPolys = topped(['area', 'corridor']);
    // …только под объёмом здания выше пола этажа (зал под навесом — тоже): у крыши низкого крыла потолок не нужен
    const abovePolys = parts.filter((p) => p.wallTop > l.floor + 0.5).flatMap((p) => p.polygons.map((q) => q.map(open)));
    let capsCache: MultiPolygon | undefined;
    const capsOf = (voids: MultiPolygon) => (capsCache ??= (() => {
      if (!abovePolys.length || !(capPolys.length || openPolys.length)) return [];
      const areas = openPolys.length ? (voids.length ? safe(() => polygonClipping.difference(unionOf(openPolys), voids)) : unionOf(openPolys)) : [];
      const all = capPolys.length ? (areas.length ? safe(() => polygonClipping.union(unionOf(capPolys), areas)) : unionOf(capPolys)) : areas;
      return all.length ? safe(() => polygonClipping.intersection(all, unionOf(abovePolys))) : [];
    })());
    const onLevel = indoor.filter((f) => !f.line && f.levels.includes(l.n));
    const levelPolys = onLevel.filter((f) => f.kind === 'level').flatMap((f) => f.polygons.map((p) => p.map(open)));
    const partPolys = parts.filter((p) => p.min <= l.floor + 0.5 && p.wallTop > l.floor + 0.01).flatMap((p) => p.polygons.map((q) => q.map(open)));
    // Разметка пола нужна лишь для перекрытия явных многоуровневых пустот. Неразмеченные участки остаются полом.
    const mappedPolys = onLevel.filter((f) => f.kind !== 'level' && (f.floors ?? [Math.min(...f.levels)]).includes(l.n)).flatMap((f) => f.polygons.map((p) => p.map(open)));
    // Объединения дорогие (сотни помещений этажа): mapped нужен лишь этажам под проёмом, контур — этажу с проёмом
    let mappedCache: MultiPolygon | undefined;
    const mappedOf = () => (mappedCache ??= unionOf(mappedPolys));
    const spaces = indoor.filter(f => !f.line && ['room','area','corridor'].includes(f.kind)
      && f.levels.length > 1 && l.n > Math.min(...f.levels) && l.n <= Math.max(...f.levels)
      && !(f.floors ?? [Math.min(...f.levels)]).includes(l.n))
      .flatMap(f => f.polygons.map(p => p.map(open)));
    // Внутренние кольца контура этажа (indoor=level) — проёмы в перекрытии, как многоуровневые помещения
    const levelHoles = levelPolys.flatMap((p) => p.slice(1).map((r) => [r]));
    let solidCache: MultiPolygon | undefined;
    const solidOf = () => (solidCache ??= levelPolys.length ? unionOf(levelPolys) : []);
    if (!spaces.length) {
      const holes = levelHoles.length ? unionOf(levelHoles) : [];
      plans.set(l.n, { floor: holes.length ? solidOf() : [], get mapped() { return mappedOf(); }, explicitVoids: holes, get solid() { return solidOf(); }, get caps() { return capsOf(holes); } });
      continue;
    }
    const mapped = mappedOf();
    let floor = unionOf(levelPolys.length ? levelPolys : partPolys);
    // Части не дают контур этажа (подземные этажи — части от земли, неточные высоты этажей): весь след здания
    // и всё, что обведено разметкой (дыры размеченного — тоже этаж): под землёй этаж часто шире следа здания
    if (!levelPolys.length && multiArea(floor) < 0.5 * multiArea(mapped)) {
      const outlines = mappedPolys.map((p) => [p[0]]);
      floor = unionOf([...parts.flatMap((p) => p.polygons.map((q) => q.map(open))), ...outlines]);
    }
    // Пол этажа над пустотой: размеченное с полом здесь. Площадка (indoor=area), целиком содержащая пустоту, —
    // зона-контейнер (неразмеченная площадь вокруг лестницы), не пол над ней; частичная (галерея) — пол
    const floored = onLevel.filter((f) => f.kind !== 'level' && (f.floors ?? [Math.min(...f.levels)]).includes(l.n));
    const contains = (outer: Pt[][][], inner: Pt[][]) => { const a = multiArea([inner as never]); return a > 1e-6 && multiArea(safe(() => polygonClipping.intersection(outer as never, [inner] as never))) >= a * .999; };
    // Габариты: пустоту закрывает только пол, задевающий её (на этаже сотни помещений — объединять все дорого)
    const boxOf = (polys: Pt[][][]) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of polys) for (const [x, y] of p[0] ?? []) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return [x0, y0, x1, y1]; };
    const flooredBoxes = floored.map((f) => boxOf(f.polygons));
    const open1 = spaces.map(space => {
      const [sx0, sy0, sx1, sy1] = boxOf([space]);
      const blockers = floored.filter((f, i) => { const [x0, y0, x1, y1] = flooredBoxes[i]; return x0 <= sx1 && x1 >= sx0 && y0 <= sy1 && y1 >= sy0; })
        .filter(f => !(f.kind === 'area' && contains(f.polygons.map(p => p.map(open)), space))).flatMap(f => f.polygons.map(p => p.map(open)));
      return safe(() => polygonClipping.intersection(floor, polygonClipping.difference([space] as never, unionOf(blockers))));
    }).filter(m => m.length);
    const all = [...open1, ...levelHoles.map((h) => [h] as MultiPolygon)];
    const explicitVoids = all.length ? safe(() => polygonClipping.union(all[0], ...all.slice(1))) : [];
    plans.set(l.n, { floor, mapped, explicitVoids, get solid() { return solidOf(); }, get caps() { return capsOf(explicitVoids); } });
  }
  return plans;
}

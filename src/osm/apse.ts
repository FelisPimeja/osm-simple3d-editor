import type { Polygon } from './model';
import { roofShapeOf } from './heights';

/**
 * roof:direction апсиды (apse_gabled) без тега — как её строит рендер: плоский торец над самой длинной
 * стороной, скат — от него внутрь контура. Градусы от севера по часовой; undefined — не апсида на одном кольце.
 */
export function apseDirection(tags: Record<string, string>, polygons: Polygon[] | undefined): string | undefined {
  if (roofShapeOf(tags) !== 'apse_gabled' || polygons?.length !== 1 || polygons[0].inners.length) return;
  const ll = polygons[0].outer;
  if (ll.length < 3) return;
  // Локальная равнопромежуточная проекция: x — восток, y — север (для угла хватает)
  const k = Math.cos((ll[0][1] * Math.PI) / 180);
  const ring = ll.map(([lon, lat]) => [lon * k, lat] as const);
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; area += a[0] * b[1] - b[0] * a[1]; }
  let best = 0, dx = 0, dy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; dx = b[0] - a[0]; dy = b[1] - a[1]; }
  }
  if (!best) return;
  // Внутренняя нормаль самой длинной стороны: у кольца против часовой — слева от направления обхода
  const [nx, ny] = area >= 0 ? [-dy, dx] : [dy, -dx];
  const deg = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
  return String(Math.round(deg) % 360);
}

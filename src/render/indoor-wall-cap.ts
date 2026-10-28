type Pt = [number, number];
/** A closed line wall is rendered with a solid cut cap, just like a polygon wall. */
export function closedWallCap(points: Pt[]): Pt[] | undefined {
  if (points.length < 4) return;
  const first = points[0], last = points[points.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-3) return points.slice(0, -1);
}

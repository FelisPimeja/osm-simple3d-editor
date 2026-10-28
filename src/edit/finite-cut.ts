import polygonClipping from 'polygon-clipping';
type Pt = [number, number];
type Poly = Pt[][];
const EPS = 1e-6;
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const edges = (p: Poly) => p.flatMap(r => r.slice(0, -1).map((a, i) => [a, r[i + 1]] as [Pt, Pt]));
/** Undo seams produced by the infinite clipping half-plane outside the drawn cut.
 * Endpoints inside the face may reach the first boundary, but never a later arm of the face. */
export function finiteCutPieces(pieces: Poly[], path: Pt[], face: Poly, extendEnds = true): Poly[] {
  const insideRing = (p: Pt, r: Pt[]) => {
    let yes = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) yes = !yes;
    }
    return yes;
  };
  const extend = (p: Pt, prev: Pt): Pt => {
    if (!insideRing(p, face[0]) || face.slice(1).some(r => insideRing(p, r))) return p;
    const d = sub(p, prev);
    let reach = Infinity;
    for (const [a,b] of edges(face)) {
      const v = sub(b,a), den = cross(d,v);
      if (Math.abs(den) < EPS) continue;
      const t = cross(sub(a,p),v)/den, u = cross(sub(a,p),d)/den;
      if (t >= -EPS && u >= -EPS && u <= 1+EPS) reach = Math.min(reach, Math.max(0,t));
    }
    return Number.isFinite(reach) ? [p[0]+d[0]*reach,p[1]+d[1]*reach] : p;
  };
  const finite = extendEnds ? [extend(path[0],path[1]), ...path.slice(1,-1), extend(path.at(-1)!,path.at(-2)!)] : path;
  const covered = (p: Pt) => finite.slice(0,-1).some((a,i) => {
    const d = sub(finite[i+1],a), v = sub(p,a), len = Math.hypot(...d);
    if (len < EPS) return false;
    const t = (v[0]*d[0]+v[1]*d[1])/(len*len);
    return t >= -EPS && t <= 1+EPS && Math.abs(cross(d,v))/len < EPS;
  });
  const artificialSeam = (a: Poly,b: Poly) => edges(a).some(([p,q]) => {
    const d = sub(q,p), len = Math.hypot(...d);
    if (len < EPS) return false;
    return edges(b).some(([u,v]) => {
      if (Math.abs(cross(d,sub(u,p)))/len > EPS || Math.abs(cross(d,sub(v,p)))/len > EPS) return false;
      const at = (r: Pt) => ((r[0]-p[0])*d[0]+(r[1]-p[1])*d[1])/(len*len);
      const lo = Math.max(0,Math.min(at(u),at(v))), hi = Math.min(1,Math.max(at(u),at(v)));
      if ((hi-lo)*len < EPS) return false;
      return [0.01,0.5,0.99].some(f => { const t=lo+(hi-lo)*f; return !covered([p[0]+d[0]*t,p[1]+d[1]*t]); });
    });
  });
  const groups = pieces.map((_,i)=>i);
  const root = (i:number):number => groups[i] === i ? i : (groups[i] = root(groups[i]));
  for (let i=0;i<pieces.length;i++) for (let j=0;j<i;j++) if (artificialSeam(pieces[i],pieces[j])) groups[root(i)] = root(j);
  const out: Poly[] = [];
  for (let i=0;i<pieces.length;i++) if (root(i)===i) {
    const group=pieces.filter((_,j)=>root(j)===i);
    out.push(...(group.length===1 ? group : polygonClipping.union(group[0],...group.slice(1))));
  }
  return out;
}

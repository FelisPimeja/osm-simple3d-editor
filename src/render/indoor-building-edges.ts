/** Hide building edges covered by actual indoor wall faces (including lintels).
 * The indoor layer supplies its own corners and jambs. Keep all uncovered heights.
 */
export function trimIndoorBuildingEdges(edges: Float32Array, walls: ArrayLike<number>): Float32Array {
  if (!walls.length) return edges;
  const cell = 4, eps = 0.02;
  const grid = new Map<string, number[]>();
  for (let i = 0; i + 8 < walls.length; i += 9) {
    const xs = [walls[i], walls[i+3], walls[i+6]], ys = [walls[i+1], walls[i+4], walls[i+7]];
    for (let x = Math.floor((Math.min(...xs)-eps)/cell); x <= Math.floor((Math.max(...xs)+eps)/cell); x++)
      for (let y = Math.floor((Math.min(...ys)-eps)/cell); y <= Math.floor((Math.max(...ys)+eps)/cell); y++) {
        const key = `${x},${y}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
      }
  }
  const out: number[] = [];
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const [x,y,z,X,Y,Z] = Array.from(edges.subarray(i,i+6));
    let spans: [number, number][] = [[0, 1]];
    const candidates = new Set<number>();
    for (let cx=Math.floor(Math.min(x,X)/cell);cx<=Math.floor(Math.max(x,X)/cell);cx++)
      for(let cy=Math.floor(Math.min(y,Y)/cell);cy<=Math.floor(Math.max(y,Y)/cell);cy++)
        for(const t of grid.get(`${cx},${cy}`) ?? []) candidates.add(t);
    for (const t of candidates) {
      const p = [0,3,6].map(j => [walls[t+j],walls[t+j+1],walls[t+j+2]]);
      const a = p[0];
      const b = p.reduce((best,v) => Math.hypot(v[0]-a[0],v[1]-a[1]) > Math.hypot(best[0]-a[0],best[1]-a[1]) ? v : best, a);
      const len = Math.hypot(b[0]-a[0],b[1]-a[1]);
      if (len < 1e-6) continue;
      const dx = (b[0]-a[0])/len, dy = (b[1]-a[1])/len;
      if (Math.abs((x-a[0])*dy-(y-a[1])*dx)>eps || Math.abs((X-a[0])*dy-(Y-a[1])*dx)>eps) continue;
      const tri=p.map(v=>[(v[0]-a[0])*dx+(v[1]-a[1])*dy,v[2]]);
      const u=(x-a[0])*dx+(y-a[1])*dy, U=(X-a[0])*dx+(Y-a[1])*dy;
      const cross=(ax:number,ay:number,bx:number,by:number)=>ax*by-ay*bx;
      const area=cross(tri[1][0]-tri[0][0],tri[1][1]-tri[0][1],tri[2][0]-tri[0][0],tri[2][1]-tri[0][1]);
      if(Math.abs(area)<1e-9) continue;
      const sign=Math.sign(area);
      let lo=0,hi=1;
      for(let j=0;j<3;j++) {
        const v=tri[j],w=tri[(j+1)%3];
        const c=sign*cross(w[0]-v[0],w[1]-v[1],u-v[0],z-v[1]);
        const d=sign*cross(w[0]-v[0],w[1]-v[1],U-u,Z-z);
        if(Math.abs(d)<1e-10) { if(c < -1e-6) {hi=-1;break;} }
        else if(d>0) lo=Math.max(lo,-c/d);
        else hi=Math.min(hi,-c/d);
      }
      if(hi<=lo) continue;
      spans=spans.flatMap(([a,b]): [number,number][] => {
        if (hi<=a || lo>=b) return [[a,b]];
        const rest: [number,number][]=[];
        if (lo>a) rest.push([a,lo]);
        if (hi<b) rest.push([hi,b]);
        return rest;
      });
      if (!spans.length) break;
    }
    for (const [a,b] of spans) if ((b-a)*Math.hypot(X-x,Y-y,Z-z)>1e-5)
      out.push(x+(X-x)*a,y+(Y-y)*a,z+(Z-z)*a,x+(X-x)*b,y+(Y-y)*b,z+(Z-z)*b);
  }
  return new Float32Array(out);
}

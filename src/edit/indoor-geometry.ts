import type { IndoorFeature, LonLat, Polygon } from '../osm/model';
import type { ObjectEdit } from './session';

export interface IndoorVertex { key: string; poly: number; ring: number; i: number }
export type IndoorOperation = { type: 'move'; vertices: IndoorVertex[]; delta: LonLat }
  | { type: 'insert'; vertex: IndoorVertex; at: LonLat; fraction: number }
  | { type: 'remove'; vertices: IndoorVertex[] };
const rings = (f: IndoorFeature) => f.polygons.flatMap((p, poly) => [
  { poly, ring: 0, coords: p.outer, ids: p.outerIds },
  ...p.inners.map((coords, i) => ({ poly, ring: i + 1, coords, ids: p.innerIds?.[i] })),
]);
const overlaps = (a: IndoorFeature,b: IndoorFeature) => a.levels.some(n => b.levels.includes(n));
const same = (a: LonLat,b: LonLat) => Math.abs(a[0]-b[0])<1e-10 && Math.abs(a[1]-b[1])<1e-10;
function validateRing(coords: LonLat[], open: boolean) {
  const n = coords.length, count = open ? n-1 : n;
  const cross = (a:LonLat,b:LonLat,c:LonLat) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for (let i=0;i<count;i++) for (let j=i+2;j<count;j++) {
    if (!open && i===0 && j===count-1) continue;
    const a=coords[i], b=coords[(i+1)%n], c=coords[j], d=coords[(j+1)%n];
    if (cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) throw new Error('Контур не должен пересекать сам себя.');
  }
  if (!open) {
    const origin=coords[0];
    const area=coords.reduce((sum,a,i)=>{const b=coords[(i+1)%n];return sum+(a[0]-origin[0])*(b[1]-origin[1])-(b[0]-origin[0])*(a[1]-origin[1]);},0);
    if (Math.abs(area)<1e-18) throw new Error('Контур не должен вырождаться в линию.');
  }
}
/** Geometric edits retain tags and levels; open walls are never closed into polygons. */
export function editIndoorGeometry(all: IndoorFeature[], op: IndoorOperation, glue: boolean, freshId: ()=>number, relationTopology = false): ObjectEdit[] {
  const vertices = op.type === 'insert' ? [op.vertex] : op.vertices;
  const selected = new Set(vertices.map(v=>v.key));
  const owners = all.filter(f=>selected.has(f.key));
  if (!owners.length) return [];
  const active = all.filter(f=>owners.some(o=>overlaps(o,f)));
  const moves = new Map<number,LonLat>(), removed = new Set<number>();
  let insertion: {id:number;u:number;v:number;at:LonLat}|undefined;
  for (const v of vertices) {
    const f=all.find(f=>f.key===v.key), r=f&&rings(f).find(r=>r.poly===v.poly&&r.ring===v.ring);
    if (!f || !r?.ids || r.ids.length!==r.coords.length || r.ids[v.i]===undefined) throw new Error('Не хватает данных узлов indoor-объекта. Перезагрузите здание.');
    if (!relationTopology && f.key.startsWith('relation/') && (op.type!=='move' || !glue)) throw new Error('Для мультиполигона доступно перемещение вершин с соседями; изменение состава узлов пока не поддерживается.');
    if (op.type==='move') moves.set(r.ids[v.i],[r.coords[v.i][0]+op.delta[0],r.coords[v.i][1]+op.delta[1]]);
    if (op.type==='remove') removed.add(r.ids[v.i]);
    if (op.type==='insert') {
      const next=v.i+1;
      if (f.line && next===r.ids.length) throw new Error('У открытой стены нет замыкающего ребра.');
      insertion={id:freshId(),u:r.ids[v.i],v:r.ids[next%r.ids.length],at:op.at};
    }
  }
  // A door on a changed side follows the side, even when it is not one of its ends.
  if (op.type==='move') for (const f of owners) for (const r of rings(f)) {
    for (let i=0;i<r.coords.length-(f.line?1:0);i++) {
      const j=(i+1)%r.coords.length,a=r.coords[i],b=r.coords[j];
      const ma=r.ids&&moves.get(r.ids[i]),mb=r.ids&&moves.get(r.ids[j]);
      if (!ma&&!mb) continue;
      for (const door of active.filter(d=>d.point&&d.key.startsWith('node/')&&(d.tags.door||d.tags.entrance||d.tags.indoor==='door'))) {
        const p=door.point!,dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;
        if (!len) continue;
        const t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/len;
        if (t<0||t>1||Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)>1e-8) continue;
        const aa=ma??a,bb=mb??b;
        moves.set(Number(door.key.split('/')[1]),[aa[0]+t*(bb[0]-aa[0]),aa[1]+t*(bb[1]-aa[1])]);
      }
    }
  }
  const otherFloors = all.filter(f=>!active.includes(f));
  const protectedNodes = new Set(otherFloors.flatMap(f=>rings(f).flatMap(r=>r.ids??[])));
  const detached = new Map<number,number>();
  const edits: ObjectEdit[]=[];
  for (const f of active) {
    if (!glue&&!selected.has(f.key)&&!f.point) continue;
    if (f.point) {
      const id=Number(f.key.split('/')[1]), at=moves.get(id);
      if (at && !same(at,f.point) && protectedNodes.has(id)) throw new Error('Общие узлы используются на другом этаже. Сначала разделите геометрию этажей.');
      const staysWithNeighbour = !glue && active.some(g=>!selected.has(g.key)&&!g.point&&rings(g).some(r=>r.ids?.includes(id)));
      if (at && !staysWithNeighbour) edits.push({key:f.key,polygons:[{outer:[at],outerIds:[id],inners:[],innerIds:[]}]});
      continue;
    }
    let changed=false;
    const output=rings(f).map(r=>{
      if (!r.ids) return {...r};
      const coords:LonLat[]=[],ids:number[]=[];
      r.ids.forEach((id,i)=>{
        const affect=glue||selected.has(f.key);
        if (removed.has(id)&&affect) {changed=true;return;}
        let at=affect?moves.get(id):undefined, nextId=id;
        if (at && !same(at,r.coords[i])) {
          if (protectedNodes.has(id) || (!glue && active.some(g=>!selected.has(g.key)&&rings(g).some(q=>q.ids?.includes(id))))) {
            if (!detached.has(id)) detached.set(id,freshId());
            nextId=detached.get(id)!;
          }
        }
        coords.push(at??r.coords[i]);ids.push(nextId);
        if (at&&!same(at,r.coords[i])) changed=true;
        const j=(i+1)%r.ids!.length;
        if (insertion && (!f.line||i+1<r.ids!.length) && (glue||selected.has(f.key))
            && ((id===insertion.u&&r.ids![j]===insertion.v)||(id===insertion.v&&r.ids![j]===insertion.u))) {
          coords.push(insertion.at);ids.push(insertion.id);changed=true;
        }
      });
      const closedLine = !!f.line && r.ids.length > 2 && r.ids[0] === r.ids[r.ids.length-1];
      if (closedLine && ids.length && ids[0] !== ids[ids.length-1]) { ids.push(ids[0]); coords.push(coords[0]); }
      if (changed&&coords.length<(closedLine?4:f.line?2:3)) throw new Error('После изменения останется слишком мало узлов.');
      return {...r,coords,ids};
    });
    if (!changed) continue;
    for (const r of output) {
      const closed = !!f.line && !!r.ids && r.ids.length > 2 && r.ids[0] === r.ids[r.ids.length-1];
      validateRing(closed ? r.coords.slice(0,-1) : r.coords, !!f.line && !closed);
    }
    const polygons:Polygon[]=f.polygons.map((p,poly)=>{
      const rr=output.filter(r=>r.poly===poly);
      return {...p,outer:rr[0].coords,outerIds:rr[0].ids,inners:rr.slice(1).map(r=>r.coords),innerIds:rr.slice(1).map(r=>r.ids!)};
    });
    edits.push(f.line ? {key:f.key,line:{coords:polygons[0].outer,ids:polygons[0].outerIds!}} : {key:f.key,polygons});
  }
  return edits;
}

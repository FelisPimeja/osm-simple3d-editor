import pc, {type MultiPolygon} from 'polygon-clipping';
import {pointInRing, pointOnSurface, isOutlinePart, type Feature3D, type Polygon} from '../osm/model';
import {computeHeights} from '../osm/heights';

/** Render-only footprint: retain OSM geometry and node IDs for selection and editing. */
/** Остаток уже этой средней ширины (2·площадь/периметр), м, — щель оцифровки. */
const SLIVER_WIDTH=0.15;

export function outlineRemainders(features: Feature3D[]): Map<string, Polygon[]> {
  const result=new Map<string,Polygon[]>();
  const clip=(ps:Polygon[]):MultiPolygon=>ps.map(p=>[p.outer,...p.inners].map(r=>[...r,r[0]]));
  // Высоты и точки частей — один раз на тайл, а не для каждого здания заново (в центре города — тысячи частей)
  const parts=features.filter(f=>f.kind==='part').map(f=>({f,h:computeHeights(f.tags),centres:f.polygons.map(pointOnSurface)}))
    .filter(p=>p.h.source!=='default');
  for(const f of features){
    if(f.kind!=='building'||f.hasParts||isOutlinePart(f.tags))continue;
    const h=computeHeights(f.tags);
    let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;
    for(const o of f.polygons)for(const [x,y] of o.outer){if(x<w)w=x;if(x>e)e=x;if(y<s)s=y;if(y>n)n=y;}
    const cutters=parts.filter(p=>p.h.min<=h.min+.5&&p.h.min<h.top-1&&p.centres.some(c=>
      c[0]>=w&&c[0]<=e&&c[1]>=s&&c[1]<=n&&f.polygons.some(o=>pointInRing(c,o.outer)&&!o.inners.some(r=>pointInRing(c,r)))))
      .flatMap(p=>clip(p.f.polygons));
    if(!cutters.length)continue;
    try{
      const rest=pc.difference(clip(f.polygons),...cutters);
      // Щели между контуром и частями (неточная оцифровка, сантиметры) — не остаток: иначе стена на всю высоту здания
      const kx=Math.cos((s+n)/2*Math.PI/180)*111320,ky=111320;
      const wide=(poly:[number,number][][])=>{
        let a=0,per=0;
        poly.forEach((r,ri)=>{let ra=0;for(let i=0;i+1<r.length;i++){const [x1,y1]=r[i],[x2,y2]=r[i+1];ra+=(x1*kx)*(y2*ky)-(x2*kx)*(y1*ky);per+=Math.hypot((x2-x1)*kx,(y2-y1)*ky);}a+=ri?-Math.abs(ra)/2:Math.abs(ra)/2;});
        return per>0&&2*a/per>=SLIVER_WIDTH;
      };
      result.set(f.key,rest.filter(wide).map(([outer,...holes])=>({outer:outer.slice(0,-1),inners:holes.map(r=>r.slice(0,-1))})));
    }catch(err){console.warn('[outline-remainder]',f.key,err);}
  }
  return result;
}

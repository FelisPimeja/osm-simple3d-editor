import * as THREE from 'three';
/** Current-level edges only; lower-level plans retain visible edges, without x-ray clutter. */
export function wireframeEdges(roots: THREE.Object3D[], floor = -Infinity): Float32Array {
 const out:number[]=[];
 for(const root of roots)root.traverseVisible(o=>{
  for(let p:THREE.Object3D|null=o;p;p=p.parent)if(p.userData.indoorBelow)return;
  const g=(o as THREE.LineSegments).geometry;if(!g)return;
  const a=g.getAttribute('instanceStart'),b=g.getAttribute('instanceEnd'),p=g.getAttribute('position');
  const add=(a:THREE.Vector3,b:THREE.Vector3)=>{
   if(Math.max(a.z,b.z)<floor-1e-3)return;
   if(Math.min(a.z,b.z)<floor){const t=(floor-a.z)/(b.z-a.z),q=a.clone().lerp(b,t);if(a.z<floor)a=q;else b=q;}
   out.push(a.x,a.y,a.z,b.x,b.y,b.z);
  };
  if(a&&b)for(let i=0;i<a.count;i++)add(new THREE.Vector3().fromBufferAttribute(a,i),new THREE.Vector3().fromBufferAttribute(b,i));
  else if(o instanceof THREE.LineSegments&&p)for(let i=0;i+1<p.count;i+=2)add(new THREE.Vector3().fromBufferAttribute(p,i),new THREE.Vector3().fromBufferAttribute(p,i+1));
 });
 return new Float32Array(out);
}

import * as THREE from 'three';
interface Node { box: THREE.Box3; triangles?: number[]; children?: Node[] }
const cache = new WeakMap<Float32Array, Node>();
/** Immutable triangle buffers share a spatial index across cursor movements. */
export function occludedByTriangles(positions: Float32Array, ray: THREE.Ray, distance: number, cut = Infinity): boolean {
  let tree = cache.get(positions);
  if (!tree) {
    const bounds = new Map<number, THREE.Box3>();
    const point = new THREE.Vector3();
    for (let i=0;i+8<positions.length;i+=9) {
      const box = new THREE.Box3();
      for (let j=0;j<9;j+=3) box.expandByPoint(point.fromArray(positions,i+j));
      bounds.set(i,box);
    }
    const build = (ids: number[]): Node => {
      const box = new THREE.Box3();
      for (const i of ids) box.union(bounds.get(i)!);
      if(ids.length<=16) return {box,triangles:ids};
      const size=box.getSize(new THREE.Vector3());
      const axis=size.x>=size.y && size.x>=size.z?'x':size.y>=size.z?'y':'z';
      ids.sort((a,b)=>{const A=bounds.get(a)!,B=bounds.get(b)!;return A.min[axis]+A.max[axis]-B.min[axis]-B.max[axis];});
      const mid=Math.floor(ids.length/2);
      return {box,children:[build(ids.slice(0,mid)),build(ids.slice(mid))]};
    };
    tree=build([...bounds.keys()]);cache.set(positions,tree);
  }
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),hit=new THREE.Vector3();
  const visit=(node:Node):boolean=> {
    if(node.box.min.z>cut || !ray.intersectsBox(node.box)) return false;
    if(node.children) return node.children.some(visit);
    for(const i of node.triangles!) {
      a.fromArray(positions,i);b.fromArray(positions,i+3);c.fromArray(positions,i+6);
      if(ray.intersectTriangle(a,b,c,false,hit) && hit.z<=cut && ray.origin.distanceTo(hit)<distance) return true;
    }
    return false;
  };
  return visit(tree);
}

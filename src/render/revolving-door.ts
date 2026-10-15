import * as THREE from 'three';
import { parseLength } from '../osm/heights';

/** Diameter is the drum diameter, not the clear passage width (`width`). */
export function revolvingDoorDiameter(tags?: Record<string, string>): number | undefined {
  if (tags?.door !== 'revolving') return;
  const diameter = parseLength(tags.diameter);
  return diameter !== undefined && Number.isFinite(diameter) && diameter > 0 ? diameter : 2.4;
}

const FRAME = new THREE.MeshLambertMaterial({ color: 0x647580, side: THREE.DoubleSide });
const GLASS = new THREE.MeshBasicMaterial({ color: 0x9fcbd5, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
const SELECTED = new THREE.MeshBasicMaterial({ color: 0x2563eb, side: THREE.DoubleSide });

/** Static four-wing drum, with opposite entrances along the local Y axis. Z is up. */
export function revolvingDoorModel(diameter: number, height: number, selected = false): THREE.Group {
  const root = new THREE.Group();
  root.name = 'revolving-door';
  const radius = diameter / 2, thickness = Math.min(0.035, radius * 0.04);
  const frame = selected ? SELECTED : FRAME;
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = z;
    root.add(mesh);
    return mesh;
  };
  // Curved side screens leave two 90° entrances. CylinderGeometry is Y-up.
  for (const start of [Math.PI / 4, Math.PI * 5 / 4]) {
    const screen = add(new THREE.CylinderGeometry(radius, radius, height, 24, 1, true, start, Math.PI / 2), GLASS, height / 2);
    screen.rotation.x = Math.PI / 2;
    for (const z of [0.05, height]) {
      add(new THREE.TorusGeometry(radius, thickness, 6, 24, Math.PI / 2), frame, z).rotation.z = start - Math.PI / 2;
    }
    for (const angle of [start, start + Math.PI / 2]) {
      const post = add(new THREE.BoxGeometry(thickness * 2, thickness * 2, height), frame, height / 2);
      post.position.x = radius * Math.sin(angle);
      post.position.y = radius * Math.cos(angle);
    }
  }
  add(new THREE.BoxGeometry(thickness * 3, thickness * 3, height), frame, height / 2);
  for (let i = 0; i < 4; i++) {
    const wing = new THREE.Group();
    wing.rotation.z = Math.PI / 4 + i * Math.PI / 2;
    const pane = new THREE.Mesh(new THREE.BoxGeometry(radius, thickness, height - 0.1), GLASS);
    pane.position.set(radius / 2, 0, height / 2);
    wing.add(pane);
    for (const z of [0.05, height]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(radius, thickness * 2, thickness * 2), frame);
      rail.position.set(radius / 2, 0, z);
      wing.add(rail);
    }
    root.add(wing);
  }
  // MapLibre supplies a custom projection; use the same policy as other indoor meshes.
  root.traverse(object => { object.frustumCulled = false; });
  return root;
}

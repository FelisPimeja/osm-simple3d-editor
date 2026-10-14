import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

let vite, BuildingsLayer;
before(async () => {
  globalThis.window = {};
  vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  ({ BuildingsLayer } = await vite.ssrLoadModule('/src/render/buildings-layer.ts'));
});
after(async () => { delete globalThis.window; await vite?.close(); });

function fixture(pale = false) {
  const layer = new BuildingsLayer('test');
  const ll = (x, y) => [37 + x / (111320 * Math.cos(55 * Math.PI / 180)), 55 + y / 111320];
  layer.setFocus([{ key: 'way/1', type: 'way', id: 1, version: 1, kind: 'part', hasParts: false,
    tags: { 'building:part': 'yes', height: '9' }, polygons: [{ outer: [ll(0, 0), ll(12, 0), ll(12, 8), ll(0, 8)], inners: [] }] }]);
  layer.map = { getCanvas: () => ({ width: 800, height: 600, clientWidth: 800 }), triggerRepaint() {} };
  const escalator = { key: 'way/12345', line: [ll(2, 4), ll(10, 4)], bottom: 0, top: 3, width: 1.2, incline: 'up', pale };
  layer.setLevel({ floor: 0, cut: 6, items: [], escalators: [escalator] });
  const model = layer.escalatorObjects.get(escalator.key);
  const meshes = model.children.filter((o) => o.userData.escalatorMaterial);
  return { layer, model, meshes, escalator };
}

test('all escalator surfaces and both handrails select together and restore their original materials', () => {
  for (const pale of [false, true]) {
    const { layer, meshes, escalator } = fixture(pale);
    assert.equal(meshes.length, 6);
    const base = meshes.map((o) => o.material);
    layer.setIndoorSelection([escalator.key]);
    meshes.forEach((o, i) => {
      assert.notEqual(o.material, base[i]);
      assert.equal(o.material.color.getHex(), 0x97beff);
      if (o.isLine2) assert.equal(o.material.isLineMaterial, true);
    });
    layer.setIndoorSelection([]);
    meshes.forEach((o, i) => assert.equal(o.material, base[i]));
  }
});

test('clicking the generated step surface returns the axis way key', () => {
  const { layer, meshes, escalator } = fixture();
  const treads = meshes.find((o) => !o.isLine2);
  const p = treads.geometry.getAttribute('position');
  const centre = new THREE.Vector3().fromBufferAttribute(p, 6).add(new THREE.Vector3().fromBufferAttribute(p, 7)).add(new THREE.Vector3().fromBufferAttribute(p, 8)).multiplyScalar(1 / 3);
  layer.focusRay = () => new THREE.Ray(centre.clone().add(new THREE.Vector3(0, 0, 5)), new THREE.Vector3(0, 0, -1));
  assert.equal(layer.pickEscalator([0, 0]).key, escalator.key);
  layer.focusRay = () => new THREE.Ray(new THREE.Vector3(100, 100, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(layer.pickEscalator([0, 0]), undefined);
});

test('an opaque floor in front of the escalator prevents selection through it', () => {
  const { layer, meshes } = fixture();
  const treads = meshes.find((o) => !o.isLine2);
  const p = treads.geometry.getAttribute('position');
  const centre = new THREE.Vector3().fromBufferAttribute(p, 6).add(new THREE.Vector3().fromBufferAttribute(p, 7)).add(new THREE.Vector3().fromBufferAttribute(p, 8)).multiplyScalar(1 / 3);
  layer.focusRay = () => new THREE.Ray(centre.clone().add(new THREE.Vector3(0, 0, 5)), new THREE.Vector3(0, 0, -1));
  const z = centre.z + 1, x = centre.x, y = centre.y;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([x - 2, y - 2, z, x + 2, y - 2, z, x + 2, y + 2, z,
    x - 2, y - 2, z, x + 2, y + 2, z, x - 2, y + 2, z], 3));
  layer.indoorObj.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
  assert.equal(layer.pickEscalator([0, 0]), undefined);
});

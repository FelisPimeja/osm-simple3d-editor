import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

class Element {
  style = {}; children = []; listeners = new Map(); hidden = false;
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  append(child) { this.children.push(child); }
  remove() {}
  setPointerCapture() {}
  emit(type, x, y) { this.listeners.get(type)?.({ clientX: x, clientY: y, pointerId: 1, target: { closest: () => false }, preventDefault() {} }); }
  getBoundingClientRect() {
    const left = parseFloat(this.style.left ?? '100'), top = parseFloat(this.style.top ?? '100');
    const width = parseFloat(this.style.width ?? '520'), height = parseFloat(this.style.height ?? '360');
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

test('shared photo layout resizes all edges, retains plugin geometry and clamps it to the viewport', async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
  const globals = ['document', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener'];
  const saved = Object.fromEntries(globals.map(key => [key, globalThis[key]]));
  const windowListeners = new Map();
  Object.assign(globalThis, { innerWidth: 1200, innerHeight: 900,
    document: { createElement: () => new Element(), getElementById: () => null, querySelectorAll: () => [] },
    addEventListener: (type, fn) => windowListeners.set(type, fn), removeEventListener: type => windowListeners.delete(type) });
  try {
    const { PhotoPanelLayout } = await vite.ssrLoadModule('/src/view/photo-panel-layout.ts');
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const el = new Element(), head = new Element();
      const layout = new PhotoPanelLayout(el, head);
      const handle = el.children.find(child => child.className.endsWith(`rs-${edge}`));
      handle.emit('pointerdown', 0, 0); handle.emit('pointermove', 20, 30); handle.emit('pointerup', 20, 30);
      const r = el.getBoundingClientRect();
      assert.equal(r.left, edge.includes('w') ? 120 : 100);
      assert.equal(r.right, edge.includes('e') ? 640 : 620);
      assert.equal(r.top, edge.includes('n') ? 130 : 100);
      assert.equal(r.bottom, edge.includes('s') ? 490 : 460);
      layout.dispose();
    }
    const first = new Element(), head = new Element();
    const layout = new PhotoPanelLayout(first, head, 'yandex');
    head.emit('pointerdown', 100, 100); head.emit('pointermove', 250, 200); head.emit('pointercancel', 250, 200);
    const edge = first.children.find(child => child.className.endsWith('rs-se'));
    edge.emit('pointerdown', 0, 0); edge.emit('pointermove', 80, 40); edge.emit('pointerup', 80, 40);
    const expected = first.getBoundingClientRect();
    layout.dispose();
    assert.equal(windowListeners.size, 0);
    const reopened = new Element(), restored = new PhotoPanelLayout(reopened, new Element(), 'yandex');
    assert.deepEqual(reopened.getBoundingClientRect(), expected);
    globalThis.innerWidth = 500; globalThis.innerHeight = 400;
    restored.place();
    assert.deepEqual(reopened.getBoundingClientRect(), { left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 });
    restored.dispose();
  } finally {
    for (const key of globals) if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key];
    await vite.close();
  }
});

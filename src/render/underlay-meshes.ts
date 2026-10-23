/**
 * Подложки пользователя в сцене three: прямоугольник с картинкой на месте подложки. Глубину не пишут.
 * На земле — рисуются до зданий, как снимок: видны сквозь прозрачные здания и в режиме контуров, здания их закрывают.
 * Подложка этажа — после зданий, чуть выше пола, с проверкой глубины: поверх заливки помещений (план виден сквозь
 * то, что по нему нарисовано), но за стенами, которые ближе к камере.
 * Стоящая (фасад, разрез) — тоже после зданий с проверкой глубины, но придвинута к камере (polygonOffset): видна
 * и тогда, когда совпадает со стеной.
 */
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { decodeImage, isVertical, type Underlay } from '../view/underlays';

/** Горизонтальная подложка на земле — чуть ниже своей отметки: не спорит по глубине с полом и сеткой. */
const FLAT_OFFSET = -0.03;
/** Подложка этажа — чуть выше пола (поверх заливки помещений). */
const FLOOR_OFFSET = 0.03;

/** Большая сторона текстуры и число пикселей — не больше (оригинал хранится целиком). */
const MAX_SIDE = 8192;
const MAX_PIXELS = 24e6;

const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
/** Рисуется после зданий (с проверкой глубины): подложка этажа и стоящая. */
const over = (u: Underlay) => u.level !== undefined || isVertical(u);

interface Entry {
  u: Underlay;
  scene: THREE.Scene;
  camera: THREE.Camera;
  model: THREE.Matrix4;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Картинка подложки (blob) — текстура пересобирается, только если она сменилась. */
  blob?: Blob;
}

export class UnderlayMeshes {
  private readonly entries = new Map<string, Entry>();
  private renderer?: THREE.WebGLRenderer;

  constructor(private readonly repaint: () => void) {}

  attach(renderer: THREE.WebGLRenderer) { this.renderer = renderer; }

  /** Подложки, которые сейчас показывать (порядок — снизу вверх); пусто — ничего. */
  set(list: Underlay[]) {
    const ids = new Set(list.map((u) => u.id));
    for (const [id, e] of this.entries) if (!ids.has(id)) { this.dispose(e); this.entries.delete(id); }
    for (const u of list) {
      let e = this.entries.get(u.id);
      if (!e) {
        const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, visible: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        const scene = new THREE.Scene();
        scene.add(mesh);
        e = { u, scene, camera: new THREE.Camera(), model: new THREE.Matrix4(), mesh };
        this.entries.set(u.id, e);
      }
      e.u = u;
      this.place(e);
      if (e.blob !== u.blob) { e.blob = u.blob; void this.load(e, u.blob); }
    }
    // Порядок отрисовки — порядок списка
    const order = new Map(list.map((u, i) => [u.id, i]));
    const sorted = [...this.entries].sort(([a], [b]) => order.get(a)! - order.get(b)!);
    this.entries.clear();
    for (const [id, e] of sorted) this.entries.set(id, e);
    this.repaint();
  }

  private place(e: Entry) {
    const { u, mesh } = e;
    const c = MercatorCoordinate.fromLngLat({ lng: u.center[0], lat: u.center[1] }, 0);
    const s = c.meterInMercatorCoordinateUnits();
    // Локальная система в метрах: x — восток, y — север, z — вверх (как у групп зданий)
    e.model.makeTranslation(c.x, c.y, 0).scale(new THREE.Vector3(s, -s, s));
    const vertical = isVertical(u);
    mesh.position.set(0, 0, u.elevation + (vertical ? 0 : u.level === undefined ? FLAT_OFFSET : FLOOR_OFFSET));
    // R_z(rotation)·R_x(tilt)·R_z(spin)
    mesh.quaternion.setFromAxisAngle(Z, u.rotation).multiply(q.setFromAxisAngle(X, u.tilt)).multiply(q2.setFromAxisAngle(Z, u.spin ?? 0));
    mesh.material.depthTest = over(u);
    mesh.material.polygonOffset = vertical;
    mesh.material.polygonOffsetFactor = mesh.material.polygonOffsetUnits = vertical ? -4 : 0;
    mesh.scale.set(u.width * u.scale * (u.mirror ? -1 : 1), u.height * u.scale, 1);
    mesh.material.opacity = u.opacity;
    mesh.visible = u.visible;
  }

  private async load(e: Entry, blob: Blob) {
    let bitmap: ImageBitmap;
    try {
      const img = await decodeImage(blob);
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const max = Math.min(MAX_SIDE, this.renderer?.capabilities.maxTextureSize ?? 4096);
      const k = Math.min(1, max / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
      // ImageBitmap three не переворачивает (flipY) — переворачиваем при декодировании
      bitmap = await createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high', imageOrientation: 'flipY' });
    } catch (err) {
      console.warn('[underlay] картинка не открылась', err);
      return;
    }
    if (e.blob !== blob || this.entries.get(e.u.id) !== e) { bitmap.close(); return; }
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    texture.needsUpdate = true;
    const m = e.mesh.material;
    m.map?.dispose();
    m.map = texture;
    m.visible = true;
    m.needsUpdate = true;
    this.repaint();
  }

  private dispose(e: Entry) {
    const m = e.mesh.material;
    (m.map?.image as ImageBitmap | undefined)?.close?.();
    m.map?.dispose();
    m.dispose();
    e.mesh.geometry.dispose();
  }

  get size() { return this.entries.size; }

  /**
   * Нарисовать подложки (main — матрица проекции MapLibre, как у групп зданий): pass 'under' — лежащие на земле
   * (до зданий), 'over' — этажей и стоящие (после зданий).
   */
  render(main: THREE.Matrix4, pass: 'under' | 'over') {
    const renderer = this.renderer;
    if (!renderer) return;
    for (const e of this.entries.values()) {
      if (!e.mesh.visible || !e.mesh.material.visible || over(e.u) !== (pass === 'over')) continue;
      e.camera.projectionMatrix.copy(main).multiply(e.model);
      renderer.resetState();
      renderer.render(e.scene, e.camera);
    }
  }
}

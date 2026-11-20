import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import mlcontour from 'maplibre-contour';

/** Тайл высот maplibre-contour: ширина, высота и отметки по строкам. */
type DemTile = { width: number; height: number; data: Float32Array };
export interface DemTiles { getDemTile(z: number, x: number, y: number): Promise<DemTile> }

/** Шаг горизонталей по зуму карты: [основной, утолщённый], м (как у 2D-слоя). */
export type ContourThresholds = Record<number, [number, number]>;

const EXTENT = 4096;
/** Сколько тайлов высот держать собранными и сколько брать в кадр. */
const KEEP = 60;
const IN_VIEW = 30;
/** Подтяжка глубины к камере (в NDC): сетка рельефа MapLibre грубее тайла высот — на обрыве линия иначе уходит под неё. */
const DEPTH_PULL = 0.0008;

interface TileLines { key: string; z: number; x: number; y: number; model: THREE.Matrix4; group: THREE.Group; used: number }

/**
 * Горизонтали 3D-линиями (рельеф, эксперимент): изолинии считаются из тех же тайлов высот (maplibre-contour,
 * generateIsolines) и рисуются на своей высоте линией постоянной экранной толщины. Натянутые на рельеф текстурой
 * (2D-слой MapLibre) на обрывах растягивались в широкие размытые полосы.
 */
export class ContoursLayer implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map?: MlMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly tiles = new Map<string, TileLines>();
  private readonly loading = new Set<string>();
  private enabled = false;
  private readonly minor: LineMaterial;
  private readonly major: LineMaterial;
  private readonly onMove = () => this.update();

  constructor(readonly id: string, private readonly dem: DemTiles, private readonly thresholds: ContourThresholds, private readonly maxZoom: number) {
    const mat = (width: number, opacity: number) => new LineMaterial({ color: 0x9a6b3f, linewidth: width, worldUnits: false, transparent: true, opacity, depthWrite: false });
    this.minor = mat(1, 0.55);
    this.major = mat(1.6, 0.85);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    map.on('moveend', this.onMove);
    this.update();
  }

  onRemove() {
    this.map?.off('moveend', this.onMove);
    this.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.clear();
    else this.update();
    this.map?.triggerRepaint();
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.enabled || !this.renderer || !this.map || !this.tiles.size) return;
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    const e = main.elements;
    for (let c = 0; c < 4; c++) e[c * 4 + 2] -= DEPTH_PULL * e[c * 4 + 3];
    const canvas = this.map.getCanvas(), dpr = window.devicePixelRatio || 1;
    for (const m of [this.minor, this.major]) m.resolution.set(canvas.width, canvas.height);
    this.minor.linewidth = 1 * dpr;
    this.major.linewidth = 1.6 * dpr;
    const want = this.wanted();
    this.renderer.resetState();
    for (const key of want) {
      const t = this.tiles.get(key);
      if (!t) continue;
      this.camera.projectionMatrix = main.clone().multiply(t.model);
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      this.renderer.render(t.group, this.camera);
    }
  }

  /** Шаг [основной, утолщённый] для зума карты. */
  private step(zoom: number): [number, number] | undefined {
    let best: [number, number] | undefined;
    for (const [z, v] of Object.entries(this.thresholds)) if (Number(z) <= zoom) best = v;
    return best;
  }

  /** Зум тайлов высот для кадра: не мельче данных и не крупнее maxZoom. */
  private demZoom(): number {
    return Math.max(8, Math.min(this.maxZoom, Math.floor(this.map!.getZoom())));
  }

  /** Ключи тайлов кадра (ближние к центру — первыми). */
  private wanted(): string[] {
    const map = this.map!;
    const st = this.step(map.getZoom());
    if (!st) return [];
    const z = this.demZoom(), n = 2 ** z;
    const b = map.getBounds();
    const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
    const x0 = tx(b.getWest()), x1 = tx(b.getEast()), y0 = Math.max(0, ty(b.getNorth())), y1 = Math.min(n - 1, ty(b.getSouth()));
    const c = map.getCenter(), cx = tx(c.lng), cy = ty(c.lat);
    const out: { key: string; d: number }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ key: `${z}/${x}/${y}/${st[0]}/${st[1]}`, d: Math.hypot(x - cx, y - cy) });
    return out.sort((a, b) => a.d - b.d).slice(0, IN_VIEW).map((o) => o.key);
  }

  private update() {
    if (!this.enabled || !this.map) return;
    const want = this.wanted();
    for (const key of want) if (!this.tiles.has(key) && !this.loading.has(key)) void this.load(key);
    // Лишние — по давности
    const now = performance.now();
    for (const key of want) { const t = this.tiles.get(key); if (t) t.used = now; }
    if (this.tiles.size > KEEP) {
      for (const t of [...this.tiles.values()].sort((a, b) => a.used - b.used).slice(0, this.tiles.size - KEEP)) this.drop(t.key);
    }
  }

  private async load(key: string) {
    this.loading.add(key);
    try {
      const [z, x, y, minor, majorStep] = key.split('/').map(Number);
      const n = 2 ** z;
      // Тайл с 8 соседями — без разрывов линий на стыках (как в самой maplibre-contour)
      const near: Promise<InstanceType<typeof mlcontour.HeightTile> | undefined>[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = (((x + dx) % n) + n) % n;
        near.push(yy < 0 || yy >= n ? Promise.resolve(undefined) : this.dem.getDemTile(z, xx, yy).then((t) => mlcontour.HeightTile.fromRawDem(t)).catch(() => undefined));
      }
      const combined = mlcontour.HeightTile.combineNeighbors(await Promise.all(near));
      if (!combined || !this.enabled) return;
      const tile = combined.materialize(2).averagePixelCentersToGrid().materialize(1);
      const lines = mlcontour.generateIsolines(minor, tile, EXTENT, 1);
      // Локальные метры от северо-западного угла тайла: x — восток, y — север, z — отметка
      const ox = x / n, oy = y / n;
      const m = new MercatorCoordinate(ox + 0.5 / n, oy + 0.5 / n, 0).meterInMercatorCoordinateUnits();
      const k = 1 / n / EXTENT / m;
      const seg = { minor: [] as number[], major: [] as number[] };
      for (const [eleStr, list] of Object.entries(lines)) {
        const ele = Number(eleStr), out = ele % majorStep === 0 ? seg.major : seg.minor;
        for (const l of list) for (let i = 0; i + 3 < l.length; i += 2) out.push(l[i] * k, -l[i + 1] * k, ele, l[i + 2] * k, -l[i + 3] * k, ele);
      }
      const group = new THREE.Group();
      for (const [pos, mat] of [[seg.minor, this.minor], [seg.major, this.major]] as const) {
        if (!pos.length) continue;
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        const line = new LineSegments2(geo, mat);
        line.frustumCulled = false;
        group.add(line);
      }
      const model = new THREE.Matrix4().makeTranslation(ox, oy, 0).scale(new THREE.Vector3(m, -m, m));
      this.drop(key);
      this.tiles.set(key, { key, z, x, y, model, group, used: performance.now() });
      this.map?.triggerRepaint();
    } finally {
      this.loading.delete(key);
    }
  }

  private drop(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (const o of t.group.children) (o as LineSegments2).geometry.dispose();
    this.tiles.delete(key);
  }

  private clear() {
    for (const key of [...this.tiles.keys()]) this.drop(key);
  }
}

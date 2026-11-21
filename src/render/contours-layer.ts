import * as THREE from 'three';
import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { ContourJob, ContourResult } from './contours-worker';

/** Шаг горизонталей по зуму карты: [основной, утолщённый], м (как у 2D-слоя). */
export type ContourThresholds = Record<number, [number, number]>;

/** Сколько тайлов держать собранными, сколько брать в кадр и сколько считать одновременно. */
const KEEP = 60;
const IN_VIEW = 30;
const PARALLEL = 4;
/**
 * Подтяжка к камере, экранные пиксели: сетка рельефа MapLibre грубее тайла высот — на обрыве линия уходила бы под
 * неё. В пикселях (а не постоянной глубиной): при отдалении линии за хребтом не выходят вперёд.
 */
const PULL_PX = 3;
/**
 * …но не меньше этого, м, на z17 (вдвое больше на каждый уровень отдаления): сетка рельефа MapLibre расходится с
 * точными отметками на метры, а при отдалении она грубее — без этого линии вдали рвутся в пунктир.
 */
const PULL_M = 4;

/** Трансформ камеры MapLibre (в 6.x — у map._camera; публичного доступа к положению камеры нет). */
function mapTransform(map: MlMap): { fov?: number; getCameraLngLat?(): { lng: number; lat: number } } | undefined {
  const m = map as unknown as { _camera?: { transform?: object }; transform?: object };
  return (m._camera?.transform ?? m.transform) as ReturnType<typeof mapTransform>;
}

/** Пересекаются ли тайлы (ключи z/x/y/…) разных зумов. */
function overlaps(a: string, b: string): boolean {
  const [za, xa, ya] = a.split('/').map(Number), [zb, xb, yb] = b.split('/').map(Number);
  const z = Math.min(za, zb);
  return xa >> (za - z) === xb >> (zb - z) && ya >> (za - z) === yb >> (zb - z);
}

interface TileLines { key: string; model: THREE.Matrix4; group: THREE.Group; used: number }

/** Положение камеры в координатах модели по матрице модель→клип: точка, где x, y и w клипа равны нулю. */
function cameraEye(m: THREE.Matrix4, out: THREE.Vector3): THREE.Vector3 {
  const e = m.elements;
  const row = (r: number) => [e[r], e[4 + r], e[8 + r], e[12 + r]];
  const [x, y, w] = [row(0), row(1), row(3)];
  const a = new THREE.Matrix3().set(x[0], x[1], x[2], y[0], y[1], y[2], w[0], w[1], w[2]);
  if (Math.abs(a.determinant()) < 1e-30) return out;
  return out.set(-x[3], -y[3], -w[3]).applyMatrix3(a.invert());
}

/**
 * Линии с подтяжкой к камере на долю расстояния до неё (eye, pull — uniforms). masked — с маской подписей: атрибут
 * instanceLabel (точка подписи, радиус в экранных px), фрагменты ближе радиуса к её проекции отбрасываются — разрыв
 * всегда по размеру подписи, при любом зуме.
 */
function pulledMaterial(colour: number, opacity: number, uniforms: Uniforms, masked = false) {
  const m = new LineMaterial({ color: colour, linewidth: 1, worldUnits: false, transparent: true, opacity, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.eye = uniforms.eye;
    shader.uniforms.pull = uniforms.pull;
    shader.uniforms.pullM = uniforms.pullM;
    shader.uniforms.dpr = uniforms.dpr;
    // Доля пути к камере: pull (экранные пиксели) или pullM метров — что больше; локальные единицы — метры
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform vec3 eye;\nuniform float pull;\nuniform float pullM;\nvec3 pulled( vec3 p ) { vec3 d = eye - p; return p + d * min( 0.5, max( pull, pullM / max( length( d ), 1.0 ) ) ); }\nvoid main() {')
      .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );', 'vec4 start = modelViewMatrix * vec4( pulled( instanceStart ), 1.0 );')
      .replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );', 'vec4 end = modelViewMatrix * vec4( pulled( instanceEnd ), 1.0 );');
    if (!masked) return;
    shader.vertexShader = shader.vertexShader
      .replace('uniform vec3 eye;', 'attribute vec4 instanceLabel;\nuniform float dpr;\nvarying vec2 vLabelPx;\nvarying float vLabelR;\nuniform vec3 eye;')
      .replace('vec4 start = modelViewMatrix', 'vLabelR = 0.0;\n\t\t\tif ( instanceLabel.w > 0.0 ) { vec4 lc = projectionMatrix * modelViewMatrix * vec4( pulled( instanceLabel.xyz ), 1.0 ); if ( lc.w > 0.0 ) { vLabelPx = ( lc.xy / lc.w * 0.5 + 0.5 ) * resolution; vLabelR = instanceLabel.w * dpr; } }\n\t\t\tvec4 start = modelViewMatrix');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying vec2 vLabelPx;\nvarying float vLabelR;\nvoid main() {\n\tif ( vLabelR > 0.0 && distance( gl_FragCoord.xy, vLabelPx ) < vLabelR ) discard;');
  };
  m.customProgramCacheKey = () => (masked ? 'contour-pull-masked' : 'contour-pull');
  return m;
}

type Uniforms = { eye: { value: THREE.Vector3 }; pull: { value: number }; pullM: { value: number }; dpr: { value: number }; resolution: { value: THREE.Vector2 } };

/** Подпись: шрифт и цвет — как у прежних подписей MapLibre (10 px). */
const LABEL_FONT_PX = 10;
const LABEL_COLOUR = '#7a5230';
const labelText = (ele: number) => `${ele.toLocaleString('en-US')} м`;

/**
 * Подписи тайла квадами в той же сцене, что и линии: точка — на точной отметке (подписи MapLibre ставятся на его
 * рельеф и висят над линией), размер — постоянный на экране, текст повёрнут вдоль линии на экране и не вверх ногами;
 * склон закрывает по глубине. labels — по 4 числа: x, y, отметка, направление линии (градусы в локальных осях).
 */
function labelMesh(labels: Float64Array, uniforms: Uniforms): THREE.Mesh | undefined {
  const count = labels.length / 4;
  if (!count) return;
  // Атлас: по строке на каждый текст тайла (отметок в тайле немного)
  const scale = 3, rowH = Math.ceil(LABEL_FONT_PX * 1.4) * scale;
  const texts = [...new Set(Array.from({ length: count }, (_, i) => labelText(labels[i * 4 + 2])))];
  const canvas = document.createElement('canvas');
  const ctx0 = canvas.getContext('2d')!;
  const font = `${LABEL_FONT_PX * scale}px "Noto Sans", "Helvetica Neue", Arial, sans-serif`;
  ctx0.font = font;
  const widths = texts.map((t) => Math.ceil(ctx0.measureText(t).width) + 2 * scale);
  canvas.width = Math.max(...widths);
  canvas.height = rowH * texts.length;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = LABEL_COLOUR;
  ctx.textBaseline = 'middle';
  texts.forEach((t, i) => ctx.fillText(t, scale, rowH * (i + 0.5)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const anchor = new Float32Array(count * 4 * 3), dir = new Float32Array(count * 4 * 3), corner = new Float32Array(count * 4 * 2);
  const uv = new Float32Array(count * 4 * 2), size = new Float32Array(count * 4 * 2), index: number[] = [];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < count; i++) {
    const x = labels[i * 4], y = labels[i * 4 + 1], ele = labels[i * 4 + 2], a = (labels[i * 4 + 3] * Math.PI) / 180;
    const row = texts.indexOf(labelText(ele)), w = widths[row];
    const u0 = 0, u1 = w / canvas.width, v1 = 1 - (row * rowH) / canvas.height, v0 = 1 - ((row + 1) * rowH) / canvas.height;
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      anchor.set([x, y, ele], v * 3);
      dir.set([Math.cos(a) * 10, Math.sin(a) * 10, 0], v * 3);
      corner.set(corners[c], v * 2);
      uv.set([corners[c][0] < 0 ? u0 : u1, corners[c][1] < 0 ? v0 : v1], v * 2);
      size.set([w / scale, rowH / scale], v * 2);
    }
    index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(anchor, 3));
  geo.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
  geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('sizePx', new THREE.BufferAttribute(size, 2));
  geo.setIndex(index);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, map: { value: tex } },
    transparent: true, depthWrite: false,
    vertexShader: `
      attribute vec3 dir; attribute vec2 corner; attribute vec2 sizePx;
      uniform vec3 eye; uniform float pull; uniform float pullM; uniform float dpr; uniform vec2 resolution;
      varying vec2 vUv;
      // Сильнее линий (на ~полподписи): плоский квад на крутом склоне иначе срезается рельефом выше точки
      vec3 pulled( vec3 p ) { vec3 d = eye - p; return p + d * min( 0.5, max( pull * 6.0, pullM * 2.0 / max( length( d ), 1.0 ) ) ); }
      void main() {
        vec4 a = projectionMatrix * modelViewMatrix * vec4( pulled( position ), 1.0 );
        vec4 b = projectionMatrix * modelViewMatrix * vec4( pulled( position + dir ), 1.0 );
        vec2 sa = a.xy / a.w * resolution * 0.5, sb = b.xy / b.w * resolution * 0.5;
        vec2 d = sb - sa;
        d = length( d ) > 1e-6 ? normalize( d ) : vec2( 1.0, 0.0 );
        if ( d.x < 0.0 ) d = -d; // не вверх ногами
        vec2 n = vec2( -d.y, d.x );
        vec2 off = ( d * corner.x * sizePx.x + n * corner.y * sizePx.y ) * 0.5 * dpr;
        gl_Position = a;
        gl_Position.xy += off / ( resolution * 0.5 ) * a.w;
        vUv = uv;
      }`,
    fragmentShader: `
      uniform sampler2D map; varying vec2 vUv;
      void main() { vec4 c = texture2D( map, vUv ); if ( c.a < 0.02 ) discard; gl_FragColor = c; }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.userData.own = true;
  return mesh;
}

let worker: Worker | undefined;
let nextJob = 1;
const jobs = new Map<number, (r: ContourResult) => void>();
function contourJob(job: Omit<ContourJob, 'id'>): Promise<ContourResult> {
  if (!worker) {
    worker = new Worker(new URL('./contours-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<ContourResult>) => { jobs.get(ev.data.id)?.(ev.data); jobs.delete(ev.data.id); };
  }
  const id = nextJob++;
  return new Promise((resolve) => { jobs.set(id, resolve); worker!.postMessage({ ...job, id }); });
}

/**
 * Горизонтали 3D-линиями (рельеф, эксперимент): изолинии считаются в воркере из тех же тайлов высот
 * (maplibre-contour) и рисуются на своей высоте линией постоянной экранной толщины. Натянутые на рельеф текстурой
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
  private readonly uniforms = { eye: { value: new THREE.Vector3() }, pull: { value: 0 }, pullM: { value: PULL_M }, dpr: { value: 1 }, resolution: { value: new THREE.Vector2(1, 1) } };
  private readonly minor = pulledMaterial(0x9a6b3f, 0.55, this.uniforms);
  private readonly major = pulledMaterial(0x9a6b3f, 0.85, this.uniforms, true);
  /** Что нарисовано в прошлый раз: пока новые тайлы не готовы, на их месте остаются старые (без моргания). */
  private drawn: string[] = [];
  private readonly onMove = () => this.update();

  constructor(readonly id: string, private readonly thresholds: ContourThresholds, private readonly maxZoom: number) {}

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
    const canvas = this.map.getCanvas(), dpr = window.devicePixelRatio || 1;
    for (const m of [this.minor, this.major]) m.resolution.set(canvas.width, canvas.height);
    this.minor.linewidth = 1 * dpr;
    this.major.linewidth = 1.6 * dpr;
    this.uniforms.dpr.value = dpr;
    this.uniforms.resolution.value.set(canvas.width, canvas.height);
    // Доля расстояния до камеры, равная PULL_PX пикселям экрана (вертикальный угол обзора MapLibre)
    const fov = mapTransform(this.map)?.fov ?? 36.87;
    this.uniforms.pull.value = (PULL_PX * 2 * Math.tan((fov * Math.PI) / 360)) / canvas.clientHeight;
    this.uniforms.pullM.value = PULL_M * 2 ** Math.max(0, 17 - this.map.getZoom());
    this.renderer.resetState();
    for (const key of this.drawList(this.wanted())) {
      const t = this.tiles.get(key);
      if (!t) continue;
      const pm = main.clone().multiply(t.model);
      this.camera.projectionMatrix = pm;
      this.camera.projectionMatrixInverse.copy(pm).invert();
      cameraEye(pm, this.uniforms.eye.value);
      this.renderer.render(t.group, this.camera);
    }
  }

  /** Шаг [основной, утолщённый] для зума карты. */
  private step(zoom: number): [number, number] | undefined {
    let best: [number, number] | undefined;
    for (const [z, v] of Object.entries(this.thresholds)) if (Number(z) <= zoom) best = v;
    return best;
  }

  /** Ключи тайлов кадра (ближние к центру — первыми): z/x/y/шаг/утолщённый шаг. */
  private wanted(): string[] {
    const map = this.map!;
    const st = this.step(map.getZoom());
    if (!st) return [];
    // Тайлы высот на зум ниже карты: пиксель высот ≈ 2 экранных — для линий достаточно, тайлов и отрезков вчетверо меньше
    const z = Math.max(8, Math.min(this.maxZoom, Math.floor(map.getZoom()) - 1)), n = 2 ** z;
    const b = map.getBounds();
    const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
    const x0 = tx(b.getWest()), x1 = tx(b.getEast()), y0 = Math.max(0, ty(b.getNorth())), y1 = Math.min(n - 1, ty(b.getSouth()));
    // Ближние к камере — первыми (при наклоне центр карты далеко впереди, а передний план важнее)
    const c = mapTransform(map)?.getCameraLngLat?.() ?? map.getCenter(), cx = tx(c.lng) + 0.5, cy = ty(c.lat) + 0.5;
    const out: { key: string; d: number }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ key: `${z}/${x}/${y}/${st[0]}/${st[1]}`, d: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
    return out.sort((a, b) => a.d - b.d).slice(0, IN_VIEW).map((o) => o.key);
  }

  private update() {
    if (!this.enabled || !this.map) return;
    const want = this.wanted();
    const now = performance.now();
    for (const key of [...want, ...this.drawn]) { const t = this.tiles.get(key); if (t) t.used = now; }
    // Не больше PARALLEL заданий: воркер не копит очередь из тайлов, мимо которых уже прокрутили
    for (const key of want) {
      if (this.loading.size >= PARALLEL) break;
      if (!this.tiles.has(key) && !this.loading.has(key)) void this.load(key);
    }
    if (this.tiles.size > KEEP) {
      for (const t of [...this.tiles.values()].sort((a, b) => a.used - b.used).slice(0, this.tiles.size - KEEP)) this.drop(t.key);
    }
  }

  /**
   * Что рисовать: готовые тайлы кадра, а там, где новые ещё считаются, — прежние (зум, шаг поменялись). Прежний
   * тайл остаётся целиком, пока не готовы все новые под ним; новые под ним до того не рисуются (без двойных линий).
   */
  private drawList(want: string[]): string[] {
    const wanted = new Set(want);
    const missing = want.filter((k) => !this.tiles.has(k));
    const kept = missing.length ? this.drawn.filter((k) => !wanted.has(k) && this.tiles.has(k) && missing.some((m) => overlaps(k, m))) : [];
    const list = [...want.filter((k) => this.tiles.has(k) && !kept.some((o) => overlaps(k, o))), ...kept];
    this.drawn = list;
    return list;
  }

  private async load(key: string) {
    this.loading.add(key);
    try {
      const [z, x, y, minor, major] = key.split('/').map(Number);
      const res = await contourJob({ z, x, y, minor, major });
      if (!this.enabled) return;
      const group = new THREE.Group();
      for (const [pos, mat] of [[res.minor, this.minor], [res.major, this.major]] as const) {
        if (!pos.length) continue;
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        if (mat === this.major) geo.setAttribute('instanceLabel', new THREE.InstancedBufferAttribute(res.majorMask, 4));
        const line = new LineSegments2(geo, mat);
        line.frustumCulled = false;
        group.add(line);
      }
      const labels = labelMesh(res.labels, this.uniforms);
      if (labels) group.add(labels);
      const n = 2 ** z, m = res.metre;
      const model = new THREE.Matrix4().makeTranslation(x / n, y / n, 0).scale(new THREE.Vector3(m, -m, m));
      this.drop(key);
      this.tiles.set(key, { key, model, group, used: performance.now() });
      this.map?.triggerRepaint();
    } finally {
      this.loading.delete(key);
      this.update(); // следующие тайлы кадра
    }
  }

  private drop(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (const o of t.group.children) {
      const mesh = o as THREE.Mesh;
      mesh.geometry.dispose();
      if (mesh.userData.own) { const mat = mesh.material as THREE.ShaderMaterial; mat.uniforms.map.value.dispose(); mat.dispose(); }
    }
    this.tiles.delete(key);
  }

  private clear() {
    for (const key of [...this.tiles.keys()]) this.drop(key);
  }
}

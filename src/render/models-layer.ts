import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MercatorCoordinate, type Map as MlMap } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import type { ShadeCasters } from './ground-shade';
import SNAPSHOT from './3dmr-transforms.json';

/** Репозиторий 3D-моделей OSM: .glb по id (и ревизии), описание модели (CORS открыт). */
export const DMR = 'https://3dmr.eu';
const API = `${DMR}/api/model/`;
/** Сколько моделей грузить одновременно. */
const PARALLEL = 3;

/** Объект с тегом 3dmr=<id>: куда ставить модель. */
/** hides — объекты, которых заменяет модель: сам объект и части здания внутри его контура. */
/** extent — размер контура в плане (диагональ рамки, м): по нему узнаём модели не в метрах. */
export interface ModelPlacement { key: string; id: number; at: LonLat; z: number; rotation: number; hides: string[]; extent?: number }

/** Единицы, в которых модели бывают по ошибке (SketchUp → obj2gltf — дюймы): во сколько раз они мельче метра. */
const UNITS = [1000, 100, 1 / 0.0254, 1 / 0.3048];
/**
 * Насколько размер модели может отличаться от контура при угаданных единицах: в модели бывает окружение
 * (площадка, деревья), и рамка шире контура — допуск в разы, ближайшая по логарифму единица.
 */
const UNIT_TOLERANCE = 2;
/** Модель до стольких раз больше контура — считаем метрами: подиум, крыльцо, навесы, площадка шире контура (Петронас — ×1,55). */
const METRES_UP_TO = 2.5;
/** Модель во столько раз больше контура без подходящей единицы — подогнать под контур. */
const FIT_ABOVE = 10;
/** Модель во столько раз меньше контура — значит, единицы условные (фотограмметрия в «единичном кубе»): подогнать под контур. */
const FIT_BELOW = 1 / 20;

/**
 * Масштаб модели размером model (м, как в файле) на контур размером outline: 1 — если похоже на метры;
 * мм/см/дюймы/футы — ближайшие с допуском; ни то ни другое — подогнать под контур.
 */
export function unitScale(model: number, outline: number | undefined): number {
  if (!outline || !model) return 1;
  const r = model / outline;
  if (r >= FIT_BELOW && r < METRES_UP_TO) return 1;
  if (r < FIT_BELOW) return 1 / r;
  const best = UNITS.map((c) => ({ c, d: Math.abs(Math.log(r / c)) })).sort((a, b) => a.d - b.d)[0];
  if (best.d < Math.log(UNIT_TOLERANCE)) return 1 / best.c;
  return r > FIT_ABOVE ? 1 / r : 1;
}

/** id модели из тега 3dmr (бывает «12» или «12;34» — берём первый). */
export function modelIdOf(tags: Record<string, string>): number | undefined {
  const id = Number((tags['3dmr'] ?? '').split(';')[0].trim());
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Описание модели из /api/info: revision — последняя ревизия. */
export interface ModelInfo { id: number; revision: number; title: string; author: string; license: number; date: string; desc: string;
  tags?: Record<string, string>; categories?: string[]; lat?: number | null; lon?: number | null;
  /** Пока /api/info их не отдаёт; когда начнёт — берём отсюда, а не из снимка. */
  rotation?: number | null; scale?: number | null; translation?: (number | null)[] | null }

/**
 * Трансформация модели из базы 3dmr (задаётся при загрузке): смещение в координатах файла (x — X, y — Z файла,
 * z — вверх), затем масштаб, затем поворот по часовой (сверху). Новые ревизии получают её вшитой в .glb
 * (узел «3DMR transform»), у старых она только в базе — см. scripts/3dmr-snapshot.mjs.
 */
export interface ModelTransform { rotation: number; scale: number; translation: [number, number, number]; source: 'api' | 'snapshot' }
const SNAPSHOT_BY_ID = SNAPSHOT as Record<string, { revision: number; rotation: number; scale: number; translation: number[] }>;

/** Трансформация ревизии rev модели id, если она не вшита в файл: из API, иначе из снимка (только той же ревизии). */
function transformOf(id: number, rev: number, info: ModelInfo | undefined): ModelTransform | undefined {
  if (info && (info.rotation != null || info.scale != null || info.translation?.some((v) => v != null))) {
    if (rev !== info.revision) return; // API знает только последнюю ревизию
    const t = info.translation ?? [];
    return { rotation: info.rotation ?? 0, scale: info.scale ?? 1, translation: [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0], source: 'api' };
  }
  const s = SNAPSHOT_BY_ID[id];
  if (!s || s.revision !== rev) return;
  return { rotation: s.rotation, scale: s.scale, translation: [s.translation[0] ?? 0, s.translation[1] ?? 0, s.translation[2] ?? 0], source: 'snapshot' };
}
/** Лицензии 3dmr по номеру. */
export const LICENSES = ['CC0 1.0', 'CC BY 4.0'];

/** Что известно о загруженном файле модели: размеры (м, как в файле), треугольники, байты. */
/** box — рамка в плане (м, как в файле, x — восток, y — север; со смещением 3dmr, до масштаба и поворота). */
export interface ModelStats { size: [number, number, number]; triangles: number; bytes?: number; transform?: ModelTransform; box: [number, number, number, number] }

/**
 * Модели из 3dmr.eu вместо процедурной геометрии объектов с тегом 3dmr. Модель в метрах, ось Y вверх,
 * -Z на север, начало координат — точка привязки; ставится в центр контура на его min_height, поворот — тег direction.
 * Рисует слой зданий в своём проходе (drawExtra) — общая глубина со зданиями.
 */
export class ModelsLayer {
  private map?: MlMap;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  /** Meshopt — сжатие геометрии (EXT_meshopt_compression): без декодера такие модели не грузятся. */
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  /** Загруженные (или не загрузившиеся — null) модели по ref: «id» — последняя ревизия, «id/rev» — выбранная. */
  private readonly models = new Map<string, THREE.Object3D | null>();
  /** Размер модели в плане (диагональ рамки) по ref. */
  private readonly sizes = new Map<string, number>();
  private readonly stats = new Map<string, ModelStats>();
  /** Выбранная пользователем ревизия модели (только показ, в OSM не пишется). */
  private readonly revisions = new Map<number, number>();
  private readonly infos = new Map<number, Promise<ModelInfo | undefined>>();
  private readonly queue: string[] = [];
  private loading = 0;
  private placements: ModelPlacement[] = [];
  private enabled = false;
  private selected?: string;
  /** Загружаемые сейчас файлы: байты пришли / всего (0 — сервер не сказал). */
  private readonly progressMap = new Map<string, { loaded: number; total: number }>();
  /** Загрузка моделей продвинулась, началась или закончилась — для индикатора. */
  onProgress?: () => void;
  /** Файл модели загрузился (или не загрузился): стал известен её отпечаток. */
  onLoaded?: () => void;
  /** Модель объекта появилась (или пропала) — перерисовать его процедурную геометрию. */
  onShown?: (keys: string[]) => void;
  hidden: () => boolean = () => false;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(0.5, -0.7, 1);
    this.scene.add(sun);
  }

  attach(map: MlMap) { this.map = map; }

  get isEnabled() { return this.enabled; }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    const keys = [...this.hiddenKeys()];
    if (!on) { this.placements = []; this.rebuild(); }
    if (keys.length) this.onShown?.(keys);
    this.map?.triggerRepaint();
  }

  private ref(id: number): string {
    const rev = this.revisions.get(id);
    return rev === undefined ? String(id) : `${id}/${rev}`;
  }

  private loaded(p: ModelPlacement) { return this.models.get(this.ref(p.id)); }

  /** Модель объекта показана — его собственную геометрию не рисовать. */
  shows(key: string): boolean {
    return this.enabled && this.placements.some((p) => p.hides.includes(key) && !!this.loaded(p));
  }

  /** Модель, стоящая вместо объекта (сам объект или часть внутри его контура). */
  placementOf(key: string): ModelPlacement | undefined {
    return this.placements.find((p) => p.key === key) ?? this.placements.find((p) => p.hides.includes(key));
  }

  /** Описание модели (кешируется; undefined — сервер не ответил). */
  info(id: number): Promise<ModelInfo | undefined> {
    let p = this.infos.get(id);
    if (!p) {
      p = fetch(`${DMR}/api/info/${id}`).then((r) => (r.ok ? r.json() as Promise<ModelInfo> : undefined)).catch(() => undefined);
      this.infos.set(id, p);
    }
    return p;
  }

  /** Файл показанной ревизии модели объекта key и поправка единиц для него (1 — метры). */
  statsOf(key: string): (ModelStats & { scale: number }) | undefined {
    const p = this.placementOf(key);
    const st = p && this.stats.get(this.ref(p.id));
    return p && st ? { ...st, scale: this.scaleOf(p) } : undefined;
  }

  /** Что грузится сейчас (для индикатора): файлы с прогрессом и сколько ждут очереди. */
  progress(): { files: { ref: string; loaded: number; total: number }[]; queued: number } {
    return { files: [...this.progressMap].map(([ref, p]) => ({ ref, ...p })), queued: this.queue.length };
  }

  /** Масштаб модели: заданный в 3dmr (не 1), иначе по эвристике единиц. */
  private scaleOf(p: ModelPlacement): number {
    const tr = this.stats.get(this.ref(p.id))?.transform;
    return tr && tr.scale !== 1 ? tr.scale : unitScale(this.sizes.get(this.ref(p.id)) ?? 0, p.extent);
  }

  /**
   * Отпечаток модели в плане (углы рамки, lon/lat) для размещения p — по уже загруженному файлу;
   * undefined — модель ещё не загружена.
   */
  footprint(p: ModelPlacement): LonLat[] | undefined {
    const st = this.stats.get(this.ref(p.id));
    if (!st || !this.loaded(p)) return;
    const k = st.transform && st.transform.scale !== 1 ? st.transform.scale : unitScale(this.sizes.get(this.ref(p.id)) ?? 0, p.extent);
    const a = (-(p.rotation + (st.transform?.rotation ?? 0)) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const [x0, y0, x1, y1] = st.box;
    const mx = 111320 * Math.cos((p.at[1] * Math.PI) / 180), my = 110540;
    return ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]).map(([x, y]): LonLat => {
      const e = (x * cos - y * sin) * k, n = (x * sin + y * cos) * k;
      return [p.at[0] + e / mx, p.at[1] + n / my];
    });
  }

  /** Показанная ревизия модели; undefined — последняя. */
  revisionOf(id: number): number | undefined { return this.revisions.get(id); }

  /** Показывать ревизию rev модели id (undefined — последнюю). */
  setRevision(id: number, rev: number | undefined) {
    const before = this.hiddenKeys();
    if (rev === undefined) this.revisions.delete(id); else this.revisions.set(id, rev);
    this.setPlacements(this.placements);
    const after = this.hiddenKeys();
    const changed = [...before].filter((k) => !after.has(k)).concat([...after].filter((k) => !before.has(k)));
    if (changed.length) this.onShown?.(changed);
  }

  setPlacements(list: ModelPlacement[]) {
    const before = this.hiddenKeys();
    this.placements = this.enabled ? list : [];
    for (const p of this.placements) { const r = this.ref(p.id); if (!this.models.has(r) && !this.progressMap.has(r) && !this.queue.includes(r)) this.queue.push(r); }
    this.pump();
    this.rebuild();
    // Скрытое поменялось без загрузки (модель уже в памяти, объект выпал из данных или вернулся) — перерисовать
    const after = this.hiddenKeys();
    const changed = [...before].filter((k) => !after.has(k)).concat([...after].filter((k) => !before.has(k)));
    if (changed.length) this.onShown?.(changed);
  }

  /** Объекты, вместо которых сейчас стоят модели (для фильтра тайлов карты). */
  replacedKeys(): string[] { return this.enabled ? [...this.hiddenKeys()] : []; }

  /** Объекты, вместо которых сейчас стоят модели. */
  private hiddenKeys(): Set<string> {
    return new Set(this.placements.filter((p) => this.loaded(p)).flatMap((p) => p.hides));
  }

  private pump() {
    while (this.loading < PARALLEL && this.queue.length) {
      const ref = this.queue.shift()!;
      this.loading++;
      this.progressMap.set(ref, { loaded: 0, total: 0 });
      this.onProgress?.();
      const [idPart, revPart] = ref.split('/'), id = Number(idPart);
      Promise.all([
        this.loader.loadAsync(API + ref, (e) => { this.progressMap.set(ref, { loaded: e.loaded, total: e.lengthComputable ? e.total : 0 }); this.onProgress?.(); }),
        this.info(id),
      ]).then(([gltf, info]) => {
        // Трансформация 3dmr уже в файле (новые ревизии) — второй раз не применять
        const baked = (gltf.parser.json.nodes as { name?: string }[] | undefined)?.some((n) => n.name === '3DMR transform');
        const rev = revPart ? Number(revPart) : info?.revision;
        const transform = baked || rev === undefined ? undefined : transformOf(id, rev, info);
        const root = new THREE.Group();
        const up = new THREE.Group();
        up.rotation.x = Math.PI / 2; // Y вверх → Z вверх, -Z (север) → +Y
        const offset = new THREE.Group();
        if (transform) { const [tx, ty, tz] = transform.translation; offset.position.set(tx, tz, ty); }
        offset.add(gltf.scene);
        up.add(offset);
        root.add(up);
        // Матрица слоя — проекция MapLibre со сжатой глубиной: отсечение three по ней прячет модели целиком
        root.traverse((o) => { o.frustumCulled = false; });
        const box = new THREE.Box3().setFromObject(root);
        this.sizes.set(ref, Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y));
        let triangles = 0;
        root.traverse((o) => {
          const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : undefined;
          if (g) triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
        });
        const st: ModelStats = { size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z], triangles, transform, box: [box.min.x, box.min.y, box.max.x, box.max.y] };
        this.stats.set(ref, st);
        // Размер файла — отдельным HEAD (Content-Length открыт для CORS)
        void fetch(API + ref, { method: 'HEAD' }).then((r) => { const n = Number(r.headers.get('content-length')); if (n) st.bytes = n; }).catch(() => {});
        this.models.set(ref, root);
      }).catch((err) => {
        console.warn(`3dmr: модель ${ref} не загрузилась`, err);
        this.models.set(ref, null);
      }).finally(() => {
        this.loading--;
        this.progressMap.delete(ref);
        this.onProgress?.();
        const keys = this.placements.filter((p) => this.ref(p.id) === ref).flatMap((p) => p.hides);
        this.rebuild();
        if (keys.length && this.models.get(ref)) this.onShown?.(keys);
        this.onLoaded?.();
        this.pump();
      });
    }
  }

  /** Матрица MapLibre без сжатия глубины (последний кадр) — для клика и глубины. */
  private plain?: THREE.Matrix4;

  /**
   * У каждой модели своя локальная система (метры, x — восток, y — север, z — вверх) с началом в её точке:
   * общая система с началом в одной из моделей теряет точность float32 на моделях за сотни километров от неё
   * (после перелёта с обзорного зума) — глубина рябит.
   */
  private rebuild() {
    for (const c of [...this.scene.children]) if (c.userData.placed) this.scene.remove(c);
    for (const p of this.placements) {
      const model = this.loaded(p);
      if (!model) continue;
      const c = MercatorCoordinate.fromLngLat({ lng: p.at[0], lat: p.at[1] }, 0);
      const m = c.meterInMercatorCoordinateUnits();
      const inst = model.clone();
      const st = this.stats.get(this.ref(p.id)), tr = st?.transform;
      // direction объекта и поворот из 3dmr — оба по часовой от севера
      inst.rotation.z = (-(p.rotation + (tr?.rotation ?? 0)) * Math.PI) / 180;
      const k = this.scaleOf(p);
      if (k !== 1) inst.scale.setScalar(k);
      // Начало координат файла — уровень земли (на min_height объекта), как задумал автор модели
      inst.position.set(0, 0, p.z);
      inst.userData.placed = true;
      inst.userData.key = p.key;
      inst.userData.world = new THREE.Matrix4().makeTranslation(c.x, c.y, 0).scale(new THREE.Vector3(m, -m, m));
      if (p.key === this.selected) this.tint(inst);
      this.scene.add(inst);
    }
    this.map?.triggerRepaint();
  }

  /** Подсветка выбранной модели — как у выделенных зданий. */
  private tint(inst: THREE.Object3D) {
    inst.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const tinted = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.emissive) { c.emissive = new THREE.Color('#97beff'); c.emissiveIntensity = 0.45; }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tinted) : tinted(mesh.material);
    });
  }

  /** Выделить модель объекта key (undefined — снять). */
  select(key: string | undefined) {
    if (key === this.selected) return;
    this.selected = key;
    this.rebuild();
  }

  private placed(): THREE.Object3D[] { return this.scene.children.filter((c) => c.userData.placed); }

  /** Модель под курсором: объект, вместо которого она стоит, и глубина попадания в clip space. */
  pick(px: number, py: number): { key: string; depth: number } | undefined {
    if (!this.enabled || !this.map || !this.plain || this.hidden()) return;
    const canvas = this.map.getCanvas();
    const x = (px / canvas.clientWidth) * 2 - 1, y = 1 - (py / canvas.clientHeight) * 2;
    let best: { key: string; depth: number } | undefined;
    for (const inst of this.placed()) {
      const m = this.plain.clone().multiply(inst.userData.world as THREE.Matrix4), inv = m.clone().invert();
      const near = new THREE.Vector3(x, y, -1).applyMatrix4(inv), far = new THREE.Vector3(x, y, 1).applyMatrix4(inv);
      const hit = new THREE.Raycaster(near, far.sub(near).normalize()).intersectObject(inst, true)[0];
      if (!hit) continue;
      const depth = hit.point.clone().applyMatrix4(m).z;
      if (!best || depth < best.depth) best = { key: inst.userData.key as string, depth };
    }
    return best;
  }

  /** Глубина точки (lngLat, высота над землёй) в clip space той же камеры, что у pick. */
  depthOf(lngLat: { lng: number; lat: number }, altitude: number): number {
    const c = MercatorCoordinate.fromLngLat(lngLat, 0);
    return new THREE.Vector3(c.x, c.y, altitude * c.meterInMercatorCoordinateUnits()).applyMatrix4(this.plain ?? new THREE.Matrix4()).z;
  }

  /** Тень на земле: каждая размещённая модель — в своей локальной системе. */
  shadowCasters(): ShadeCasters[] {
    if (!this.enabled || this.hidden()) return [];
    return this.placed().map((inst) => ({ objects: [inst], model: inst.userData.world as THREE.Matrix4 }));
  }

  draw(renderer: THREE.WebGLRenderer, main: THREE.Matrix4, plain?: THREE.Matrix4): number {
    const placed = this.placed();
    if (!this.enabled || !placed.length || this.hidden()) return 0;
    // plain (матрица MapLibre без сжатия глубины) бывает ещё не известна в первом кадре
    if (plain) this.plain = plain.clone();
    // Каждая модель — своей матрицей (своя локальная система); остальные на это время скрыты
    let triangles = 0;
    for (const inst of placed) {
      for (const o of placed) o.visible = o === inst;
      this.camera.projectionMatrix = main.clone().multiply(inst.userData.world as THREE.Matrix4);
      renderer.render(this.scene, this.camera);
      triangles += renderer.info.render.triangles;
    }
    for (const o of placed) o.visible = true;
    return triangles;
  }
}

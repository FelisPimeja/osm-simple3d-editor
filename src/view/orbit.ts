import { MercatorCoordinate, type LngLat, type Map as MlMap } from 'maplibre-gl';

/** Точка, вокруг которой вращаем: координаты и высота над землёй, м. */
export interface Pivot {
  lngLat: LngLat; altitude: number;
  /** Где точка на экране (px), если не под курсором — для маркера. */
  point?: [number, number];
}

/**
 * Градусов на пиксель движения мыши — как у стандартного вращения MapLibre
 * (generateMouseRotationHandler / generateMousePitchHandler), чтобы при переключении режима
 * управление не менялось: вправо — по часовой, вниз — наклон уменьшается (вид сверху).
 */
const BEARING_PER_PX = 0.8;
const PITCH_PER_PX = -0.5;
const MIN_PITCH = 0;
/** Зум колесом — с той же скоростью, что у scrollZoom MapLibre: уровней зума на пиксель прокрутки (колесо и трекпад). */
const WHEEL_ZOOM_RATE = 1 / 450, TRACKPAD_ZOOM_RATE = 1 / 100;
/** Ближе этого к точке под курсором колесом не подходим, м. */
const MIN_ZOOM_DISTANCE = 0.5;

/**
 * Вращение камеры как в SketchUp: вокруг точки под курсором, а не вокруг центра карты.
 * Камера поворачивается жёстко (и положение, и направление взгляда) вокруг оси через точку —
 * поэтому сама точка остаётся на том же месте экрана.
 *
 * Жесты: средняя или правая кнопка мыши, либо Ctrl + левая. Стандартное вращение MapLibre отключено,
 * перемещение левой кнопкой остаётся.
 */
export class CursorOrbit {
  private drag?: { pivot: Pivot; x: number; y: number; x0: number; y0: number; pointerId: number };
  /** Последний жест вращения сдвинул мышь — следующий click не клик. */
  private rotated = false;
  private readonly marker: HTMLDivElement;

  constructor(private readonly map: MlMap, private readonly pickPivot: (x: number, y: number) => Pivot,
    /** Точка объекта под курсором для зума колесом; undefined — обычный зум MapLibre (к земле). */
    private readonly pickZoom?: (x: number, y: number) => Pivot | undefined) {
    this.marker = document.createElement('div');
    this.marker.className = 'orbit-pivot';
    this.marker.hidden = true;
    map.getContainer().appendChild(this.marker);

    const canvas = map.getCanvasContainer();
    canvas.addEventListener('pointerdown', this.onDown, { capture: true });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    // Ctrl+ЛКМ: после вращения браузер всё равно шлёт click, а MapLibre (без mousedown — его гасит preventDefault)
    // сверяет его со старой точкой нажатия и может принять за клик — выделение сбрасывалось
    canvas.addEventListener('click', (e) => { if (this.rotated) { this.rotated = false; e.stopPropagation(); } }, { capture: true });
    map.dragRotate.disable();
    this.updateMaxPitch();
  }

  /** Наклон за горизонт — камера уходит под землю (режим здания: добраться до нижних граней). */
  private underground = false;

  setUnderground(on: boolean) {
    this.underground = on;
    // Взгляд снизу вверх (наклон > 90°): центр карты должен быть выше камеры, а не на земле
    this.map.setCenterClampedToGround(!on);
    if (!on && this.map.getPitch() > 85) this.map.setPitch(85);
    if (!on) this.map.setCenterElevation(0);
    this.updateMaxPitch();
  }

  private updateMaxPitch() {
    // Для свободного облёта нужен наклон почти до горизонта (по умолчанию в MapLibre 60°);
    // в режиме здания — и под землю (MapLibre допускает до 180°, выше 90° — экспериментально)
    this.map.setMaxPitch(this.underground ? 175 : 85);
  }

  private onDown = (e: PointerEvent) => {
    this.rotated = false;
    if (e.pointerType === 'touch') return;
    const orbit = e.button === 1 || e.button === 2 || (e.button === 0 && e.ctrlKey);
    if (!orbit) return;
    // Не даём MapLibre начать своё перемещение или вращение
    e.preventDefault();
    e.stopPropagation();
    const rect = this.map.getCanvas().getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const pivot = this.pickPivot(x, y);
    this.drag = { pivot, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId };
    const [mx, my] = pivot.point ?? [x, y];
    this.marker.style.left = `${mx}px`;
    this.marker.style.top = `${my}px`;
    this.marker.hidden = false;
    // Чтобы получать движение и отпускание кнопки даже за пределами карты
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* не критично */ }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.rotate(this.drag.pivot, dx * BEARING_PER_PX, dy * PITCH_PER_PX);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.rotated = Math.hypot(e.clientX - this.drag.x0, e.clientY - this.drag.y0) > 4;
    this.drag = undefined;
    this.marker.hidden = true;
  };

  /**
   * Зум колесом к точке объекта под курсором (как в SketchUp): камера едет по прямой к этой точке (или от неё),
   * точка остаётся под курсором. MapLibre зумит к земле под курсором — к крыше на высоте так не подойти: камера
   * опускается ниже неё раньше, чем приближается.
   */
  private onWheel = (e: WheelEvent) => {
    if (!this.pickZoom || this.drag) return;
    const rect = this.map.getCanvas().getBoundingClientRect();
    const target = this.pickZoom(e.clientX - rect.left, e.clientY - rect.top);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
    // Как у MapLibre: щелчок колеса — крупный шаг (кратен 4.000244140625), трекпад и пинч — мелкие частые
    const rate = px % 4.000244140625 === 0 || Math.abs(px) >= 50 ? WHEEL_ZOOM_RATE : TRACKPAD_ZOOM_RATE;
    const k = Math.pow(2, px * rate);
    const cam = this.cameraOffset(target);
    if (!cam) return;
    const { ox, oy, oz, p, s } = cam;
    const dist = Math.hypot(ox, oy, oz);
    const minAlt = this.underground ? 0.3 : 1;
    const at = (f: number) => {
      const altitude = target.altitude + oz * f;
      if (altitude < minAlt) return;
      const camLngLat = new MercatorCoordinate(p.x + ox * f * s, p.y - oy * f * s, 0).toLngLat();
      const opts = this.map.calculateCameraOptionsFromCameraLngLatAltRotation(camLngLat, altitude, this.map.getBearing(), this.map.getPitch());
      // Дальше предела зума MapLibre камера встала бы не туда (зум обрезается)
      return opts.zoom !== undefined && opts.zoom > this.map.getMaxZoom() ? undefined : opts;
    };
    let f = Math.max(k, MIN_ZOOM_DISTANCE / Math.max(dist, 1e-6));
    let opts = at(f);
    // Слишком близко (предел зума, земля) — подходим, сколько можно: подбор шага делением пополам
    if (!opts && f < 1) {
      let lo = f, hi = 1;
      for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (at(mid)) hi = mid; else lo = mid; }
      f = hi;
      opts = f < 0.999 ? at(f) : undefined;
    }
    if (opts) this.map.jumpTo(opts);
  };

  /** Камера относительно точки t (метры: x — восток, y — север, z — вверх) и масштаб меркатора у t. */
  private cameraOffset(t: Pivot) {
    const p = MercatorCoordinate.fromLngLat(t.lngLat, 0);
    const s = p.meterInMercatorCoordinateUnits();
    type CameraTransform = { getCameraLngLat(): LngLat; getCameraAltitude(): number };
    const m = this.map as unknown as { _camera?: { transform?: CameraTransform }; transform?: CameraTransform };
    const tr = m._camera?.transform ?? m.transform;
    if (!tr) return;
    const cam = MercatorCoordinate.fromLngLat(tr.getCameraLngLat(), 0);
    return { ox: (cam.x - p.x) / s, oy: -(cam.y - p.y) / s, oz: tr.getCameraAltitude() - t.altitude, p, s };
  }

  /** Повернуть камеру вокруг pivot: dBearing — по часовой, dPitch — к горизонту. */
  private rotate(pivot: Pivot, dBearing: number, dPitch: number) {
    const map = this.map;
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    const newPitch = Math.max(MIN_PITCH, Math.min(map.getMaxPitch(), pitch + dPitch));
    dPitch = newPitch - pitch;

    // Локальная система в метрах вокруг pivot: x — восток, y — север, z — вверх
    const p = MercatorCoordinate.fromLngLat(pivot.lngLat, 0);
    const s = p.meterInMercatorCoordinateUnits();
    // Положения камеры нет в публичном API Map, но есть у внутреннего transform
    // (в MapLibre 6 — map._camera.transform, раньше — map.transform)
    type CameraTransform = { getCameraLngLat(): LngLat; getCameraAltitude(): number };
    const m = map as unknown as { _camera?: { transform?: CameraTransform }; transform?: CameraTransform };
    const t = m._camera?.transform ?? m.transform;
    if (!t) return;
    const cam = MercatorCoordinate.fromLngLat(t.getCameraLngLat(), 0);
    let ox = (cam.x - p.x) / s;
    let oy = -(cam.y - p.y) / s;
    let oz = t.getCameraAltitude() - pivot.altitude;

    // Наклон: поворот вокруг горизонтальной оси «вправо» (перпендикулярной направлению взгляда)
    const b = (bearing * Math.PI) / 180;
    const fx = Math.sin(b), fy = Math.cos(b); // направление взгляда по горизонтали
    const rx = fy, ry = -fx; // вправо
    const a = ox * fx + oy * fy; // вдоль взгляда
    const r = ox * rx + oy * ry; // вбок
    const dp = (dPitch * Math.PI) / 180;
    // Больше наклон — камера опускается и отходит назад
    const a2 = a * Math.cos(dp) - oz * Math.sin(dp);
    const z2 = a * Math.sin(dp) + oz * Math.cos(dp);
    ox = a2 * fx + r * rx;
    oy = a2 * fy + r * ry;
    oz = z2;

    // Азимут: поворот по часовой вокруг вертикали через pivot
    const db = (dBearing * Math.PI) / 180;
    const ox2 = ox * Math.cos(db) + oy * Math.sin(db);
    const oy2 = -ox * Math.sin(db) + oy * Math.cos(db);

    const altitude = pivot.altitude + oz;
    // Ниже уровня земли MapLibre камеру не пускает; в режиме здания — до самой земли, чтобы заглянуть под объект
    if (altitude < (this.underground ? 0.3 : 1)) return;
    const camLngLat = new MercatorCoordinate(p.x + ox2 * s, p.y - oy2 * s, 0).toLngLat();
    // Под объектом (наклон > 90°) центр «по взгляду на землю» уходит в бесконечность — тогда центр ставим в pivot
    // на его высоте: камера смотрит на точку вращения, MapLibre сам вычисляет наклон и зум
    if (this.underground && newPitch > 80) {
      // Точка на оси взгляда на расстоянии до pivot: экран не прыгает, а центр остаётся конечным
      const nb = ((bearing + dBearing) * Math.PI) / 180, np = (newPitch * Math.PI) / 180;
      const dist = Math.max(5, Math.hypot(ox2, oy2, oz));
      const tx = Math.sin(nb) * Math.sin(np) * dist, ty = Math.cos(nb) * Math.sin(np) * dist;
      const tz = altitude - Math.cos(np) * dist;
      // ox2/oy2 — камера относительно pivot, t* — шаг от камеры вдоль взгляда
      const to = new MercatorCoordinate(p.x + (ox2 + tx) * s, p.y - (oy2 + ty) * s, 0).toLngLat();
      map.jumpTo(map.calculateCameraOptionsFromTo(camLngLat, altitude, to, Math.max(0, tz)));
      return;
    }
    map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(camLngLat, altitude, bearing + dBearing, newPitch));
  }
}

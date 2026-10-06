import { MercatorCoordinate, type LngLat, type Map as MlMap } from 'maplibre-gl';

/** Точка, вокруг которой вращаем: координаты и высота над землёй, м. */
export interface Pivot { lngLat: LngLat; altitude: number }

/**
 * Градусов на пиксель движения мыши — как у стандартного вращения MapLibre
 * (generateMouseRotationHandler / generateMousePitchHandler), чтобы при переключении режима
 * управление не менялось: вправо — по часовой, вниз — наклон уменьшается (вид сверху).
 */
const BEARING_PER_PX = 0.8;
const PITCH_PER_PX = -0.5;
const MIN_PITCH = 0;

/**
 * Вращение камеры как в SketchUp: вокруг точки под курсором, а не вокруг центра карты.
 * Камера поворачивается жёстко (и положение, и направление взгляда) вокруг оси через точку —
 * поэтому сама точка остаётся на том же месте экрана.
 *
 * Жесты: средняя или правая кнопка мыши, либо Ctrl + левая. Стандартное вращение MapLibre на время
 * включения режима отключается, перемещение левой кнопкой остаётся.
 */
export class CursorOrbit {
  private enabled = false;
  private drag?: { pivot: Pivot; x: number; y: number; pointerId: number };
  private readonly marker: HTMLDivElement;

  constructor(private readonly map: MlMap, private readonly pickPivot: (x: number, y: number) => Pivot) {
    this.marker = document.createElement('div');
    this.marker.className = 'orbit-pivot';
    this.marker.hidden = true;
    map.getContainer().appendChild(this.marker);

    const canvas = map.getCanvasContainer();
    canvas.addEventListener('pointerdown', this.onDown, { capture: true });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    // Для свободного облёта нужен наклон почти до горизонта (по умолчанию в MapLibre 60°)
    this.map.setMaxPitch(on ? 85 : 60);
    if (on) this.map.dragRotate.disable();
    else this.map.dragRotate.enable();
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || e.pointerType === 'touch') return;
    const orbit = e.button === 1 || e.button === 2 || (e.button === 0 && e.ctrlKey);
    if (!orbit) return;
    // Не даём MapLibre начать своё перемещение или вращение
    e.preventDefault();
    e.stopPropagation();
    const rect = this.map.getCanvas().getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    this.drag = { pivot: this.pickPivot(x, y), x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    this.marker.style.left = `${x}px`;
    this.marker.style.top = `${y}px`;
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
    this.drag = undefined;
    this.marker.hidden = true;
  };

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
    if (altitude < 1) return; // под землю не уходим
    const camLngLat = new MercatorCoordinate(p.x + ox2 * s, p.y - oy2 * s, 0).toLngLat();
    map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(camLngLat, altitude, bearing + dBearing, newPitch));
  }
}

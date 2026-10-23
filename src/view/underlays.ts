/**
 * Подложки пользователя: свои картинки (сканы планов, чертежи, фасады) под зданием в режиме здания.
 * Каждая привязана к зданию (ключ группы) и видна только в его режиме. Хранятся в IndexedDB (своя база):
 * оригинал картинки и её положение; в OSM и на сервер ничего не уходит.
 */
import { orientedFrame } from '../render/oriented-box';

type LonLat = [number, number];

export interface Underlay {
  id: string;
  /** Имя файла — подпись в списке и в source changeset. */
  name: string;
  /** Ключ здания (группы), к которому привязана подложка. */
  building: string;
  /** Оригинал картинки. */
  blob: Blob;
  /** Размер оригинала, px. */
  width: number;
  height: number;
  /** Центр картинки на местности. */
  center: LonLat;
  /** Высота центра над основанием (землёй или полом этажа), м; у лежащей — 0. */
  elevation: number;
  /** Этаж (`level`): видна только на нём, на отметке его пола; undefined — на земле, видна всегда. */
  level?: number;
  /** Метров на пиксель оригинала. */
  scale: number;
  /** Поворот оси X картинки от востока против часовой, рад. */
  rotation: number;
  /** Наклон вокруг оси X картинки, рад: 0 — лежит (план), π/2 — стоит (фасад, разрез). */
  tilt: number;
  /**
   * Поворот в плоскости стоящей картинки (вокруг её нормали), рад, против часовой, если смотреть на лицевую сторону;
   * у лежащей не нужен (это rotation). Ориентация: R_z(rotation)·R_x(tilt)·R_z(spin).
   */
  spin?: number;
  /** Зеркально по X. */
  mirror: boolean;
  /** Непрозрачность, 0…1. */
  opacity: number;
  visible: boolean;
  /** Когда добавлена (мс) — порядок в списке. */
  added: number;
}

/** Стоит (фасад, разрез), а не лежит. */
export const isVertical = (u: Underlay) => Math.abs(u.tilt) > 1e-6;
/** Поворот картинки в её плоскости: у лежащей — rotation, у стоящей — spin. */
export const planeAngle = (u: Underlay) => (isVertical(u) ? u.spin ?? 0 : u.rotation);
export const withPlaneAngle = (u: Underlay, a: number): Underlay => (isVertical(u) ? { ...u, spin: a } : { ...u, rotation: a });

/** Типы файлов, которые можно добавить подложкой. */
export const UNDERLAY_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
export const isUnderlayFile = (f: File | Blob) => UNDERLAY_TYPES.includes(f.type);

const DB = 'osm-simple3d-underlays';
const STORE = 'underlays';

async function database(): Promise<IDBDatabase | undefined> {
  if (!('indexedDB' in globalThis)) return;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('building', 'building');
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** Подложки здания по порядку добавления; без IndexedDB — пусто. */
export async function loadUnderlays(building: string): Promise<Underlay[]> {
  const db = await database();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).index('building').getAll(building);
      request.onsuccess = () => { db.close(); resolve((request.result as Underlay[]).sort((a, b) => a.added - b.added)); };
      request.onerror = () => { db.close(); resolve([]); };
    } catch { db.close(); resolve([]); }
  });
}

/** Записать подложку; false — не удалось (нет IndexedDB, нет места). */
export async function saveUnderlay(u: Underlay): Promise<boolean> {
  return write((s) => s.put(u));
}

export async function deleteUnderlay(id: string): Promise<boolean> {
  return write((s) => s.delete(id));
}

async function write(op: (s: IDBObjectStore) => void): Promise<boolean> {
  const db = await database();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      op(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(false); };
    } catch { db.close(); resolve(false); }
  });
}

/** Картинка файла (через <img>: так открываются и SVG); размер SVG без своего — 2048 px по большей стороне. */
export async function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) {
      img.width = 2048;
      img.height = 2048;
    }
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Размер картинки, px (у SVG без размеров — квадрат 2048). */
export const imageSize = (img: HTMLImageElement): [number, number] =>
  [img.naturalWidth || img.width, img.naturalHeight || img.height];

/** Запас вокруг здания при первой расстановке. */
const FIT_MARGIN = 1.1;
const R = 6378137;

/**
 * Первая расстановка: по осям здания (направленный bbox контуров), вписать в здание с запасом; длинная сторона
 * картинки — вдоль длинной стороны здания.
 */
export function fitToBuilding(points: LonLat[], width: number, height: number): Pick<Underlay, 'center' | 'scale' | 'rotation'> | undefined {
  if (!points.length) return;
  const lat0 = points.reduce((s, p) => s + p[1], 0) / points.length, lng0 = points.reduce((s, p) => s + p[0], 0) / points.length;
  const k = Math.cos(lat0 * Math.PI / 180) * R * Math.PI / 180;
  const local = points.map(([lng, lat]): [number, number] => [(lng - lng0) * k, (lat - lat0) * R * Math.PI / 180]);
  const f = orientedFrame(local);
  if (!f) return;
  const [w, h] = f.size;
  const cx = f.origin[0] + f.x[0] * w / 2 + f.y[0] * h / 2, cy = f.origin[1] + f.x[1] * w / 2 + f.y[1] * h / 2;
  let rotation = Math.atan2(f.x[1], f.x[0]);
  // Картинка «стоит» — длинная сторона здания вдоль её высоты
  const portrait = height > width;
  if (portrait) rotation += Math.PI / 2;
  const [iw, ih] = portrait ? [height, width] : [width, height];
  const scale = Math.max(w / iw, h / ih, 0.01) * FIT_MARGIN;
  return { center: [lng0 + cx / k, lat0 + cy / (R * Math.PI / 180)], scale, rotation };
}

/** Новая подложка здания из файла; undefined — файл не картинка или не открылся. */
export async function createUnderlay(file: File | Blob, building: string, outline: LonLat[], level?: number): Promise<Underlay | undefined> {
  if (!isUnderlayFile(file)) return;
  let img: HTMLImageElement;
  try { img = await decodeImage(file); } catch { return; }
  const [width, height] = imageSize(img);
  const fit = fitToBuilding(outline, width, height);
  if (!fit) return;
  return {
    id: crypto.randomUUID(),
    name: (file as File).name || 'image',
    building, blob: file, width, height,
    ...fit,
    elevation: 0, level, tilt: 0, mirror: false, opacity: 0.5, visible: true, added: Date.now(),
  };
}

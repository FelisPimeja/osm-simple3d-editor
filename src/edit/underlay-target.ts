import type * as THREE from 'three';
import type { SnapHit } from '../render/buildings-layer';

type Pt = [number, number];

/** Свои подложки как цель инструментов «Переместить», «Повернуть», «Масштаб» (подключает main.ts). */
export interface UnderlayTarget {
  /** Привязка на подложках ids под точкой экрана: угол, середина стороны, центр. */
  snap(point: Pt, ids: Set<string>): SnapHit | undefined;
  /** Точка на картинке одной из подложек ids под точкой экрана и нормаль картинки (метры сцены). */
  hit(point: Pt, ids: Set<string>): { p: THREE.Vector3; n: THREE.Vector3 } | undefined;
  /** Показать подложки преобразованными матрицей m (метры сцены; undefined — как есть). */
  preview(ids: Set<string>, m: THREE.Matrix4 | undefined): void;
}

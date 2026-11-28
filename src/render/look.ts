/**
 * «Контрастный свет»: тонмаппинг Neutral (мягко сжимает светлое, тёмное и средние тона не трогает) и свет
 * с меньшим рассеянным и более сильным солнцем — тени граней глубже, освещённые грани почти как раньше.
 * Свет регистрируется через lit(); renderer.toneMapping ставит каждый слой перед отрисовкой (toneMapping()).
 */
import * as THREE from 'three';

/** Множитель яркости в контрастном режиме: рассеянный свет слабее, солнце сильнее. */
export const CONTRAST = { ambient: 0.7, sun: 1.45 };

let on = false;
const lights = new Set<WeakRef<THREE.Light>>();
const base = new WeakMap<THREE.Light, number>();

function apply(l: THREE.Light) {
  const k = l instanceof THREE.DirectionalLight ? CONTRAST.sun : CONTRAST.ambient;
  l.intensity = base.get(l)! * (on ? k : 1);
}

/** Запомнить свет: его яркость будет меняться с режимом. */
export function lit<T extends THREE.Light>(l: T): T {
  base.set(l, l.intensity);
  lights.add(new WeakRef(l));
  apply(l);
  return l;
}

export function setContrastLight(v: boolean) {
  if (on === v) return;
  on = v;
  for (const r of lights) { const l = r.deref(); if (l) apply(l); else lights.delete(r); }
}

export const contrastLight = () => on;

/** Тонмаппинг для рендерера слоя — вызывать перед отрисовкой кадра. */
export function toneMapping(renderer: THREE.WebGLRenderer) {
  renderer.toneMapping = on ? THREE.NeutralToneMapping : THREE.NoToneMapping;
}

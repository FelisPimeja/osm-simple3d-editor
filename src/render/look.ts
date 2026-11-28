/**
 * «Контрастный свет»: тонмаппинг Neutral (мягко сжимает светлое, тёмное и средние тона не трогает) и свет
 * с меньшим рассеянным и более сильным солнцем — тени граней глубже, освещённые грани почти как раньше.
 * Свет регистрируется через lit(); renderer.toneMapping ставит каждый слой перед отрисовкой (toneMapping()).
 */
import * as THREE from 'three';

/** Множители яркости в контрастном режиме (рассеянный слабее, солнце сильнее), экспозиция тонмаппинга;
 *  shadow — насыщенность теней на земле (от режима не зависит). */
export const CONTRAST = { ambient: 0.8, sun: 1.35, exposure: 1.6, shadow: 0.35 };

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

/** Подстройка из настроек: множители рассеянного света и солнца, экспозиция тонмаппинга. */
export function setContrastValues(v: Partial<typeof CONTRAST>) {
  Object.assign(CONTRAST, v);
  for (const r of lights) { const l = r.deref(); if (l) apply(l); else lights.delete(r); }
}

/** Тонмаппинг для рендерера слоя — вызывать перед отрисовкой кадра. */
export function toneMapping(renderer: THREE.WebGLRenderer) {
  renderer.toneMapping = on ? THREE.NeutralToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = CONTRAST.exposure;
}

import type * as THREE from 'three';
import { tr, trn } from '../i18n';

/**
 * Переключатель «с соседями / отдельно» (attached / detached) — общий у всех инструментов, меняющих контур:
 * «Форма», «Вытянуть», «Переместить», «Повернуть», «Масштаб». Выбор один на всех и запоминается.
 */
const GLUE_STORAGE = 'push-glue';

export function loadGlue(): boolean {
  try { return localStorage.getItem(GLUE_STORAGE) !== 'off'; } catch { return true; }
}

export function saveGlue(on: boolean) {
  try { localStorage.setItem(GLUE_STORAGE, on ? 'on' : 'off'); } catch { /* без хранилища — до перезагрузки */ }
}

/** Клавиша переключения (D без модификаторов). */
export const isGlueKey = (e: KeyboardEvent) => e.code === 'KeyD' && !e.ctrlKey && !e.metaKey && !e.altKey;

/** Кнопки переключателя для панели ввода (клик — data-glue="on|off", см. glueClick). */
export function glueSwitch(on: boolean, title = tr('Общие с соседями узлы: «с соседями» — соседи тянутся следом, «отдельно» — часть отделяется от них (D)')): string {
  return `<span class="vcb-units" title="${title}">${[true, false]
    .map((v) => `<button type="button" data-glue="${v ? 'on' : 'off'}"${v === on ? ' class="active"' : ''}>${v ? tr('с соседями') : tr('отдельно')}</button>`).join('')}</span>`;
}

/** Клик по панели: выбранное значение переключателя или undefined. */
export function glueClick(e: Event): boolean | undefined {
  const g = (e.target as HTMLElement).closest<HTMLElement>('[data-glue]')?.dataset.glue;
  return g ? g === 'on' : undefined;
}

/**
 * Превью соседей «с соседями»: перестроить тех, кого потянет преобразование m объектов keys (m — undefined: вернуть
 * всех как были), и подсветить их. Возвращает, сколько соседей тянется. Подключает main.ts.
 */
export type LinkPreview = (keys: string[], m: THREE.Matrix4 | undefined, glue: boolean) => number;

/** Подпись «тянет N соседей» для панели ввода. */
export const linkedNote = (n: number) => (n ? `<span class="vcb-axis vcb-linked">${trn(n, 'тянет {n} соседа|тянет {n} соседей|тянет {n} соседей')}</span>` : '');

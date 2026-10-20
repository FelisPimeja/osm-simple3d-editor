import type { BuildingsLayer } from '../render/buildings-layer';
import { tr } from '../i18n';

export type PaintFace = 'roof' | 'wall';
/**
 * Скопированное: цвет и материал (undefined — не задан, при заливке удаляется). С фото (окно панорамы) — только
 * цвет: материал при заливке не трогается.
 */
export interface PaintSample { from: PaintFace | 'photo'; colour?: string; material?: string }

export const PAINT_TAGS: Record<PaintFace, { colour: string; material: string }> = {
  roof: { colour: 'roof:colour', material: 'roof:material' },
  wall: { colour: 'building:colour', material: 'building:material' },
};

/**
 * Инструмент «Заливка»: Ctrl (Cmd, Alt) + клик по поверхности — взять цвет и материал (крыша или верхняя
 * грань — крыши, стена — фасада); простой клик по поверхности — назначить взятое этой поверхности
 * (крыше или фасаду, куда кликнули). Что лежит в тегах объекта и как их менять — решают снаружи.
 */
export class PaintTool {
  state: 'off' | 'on' = 'off';
  sample?: PaintSample;

  constructor(
    private readonly layer: BuildingsLayer,
    private readonly allowed: (key: string) => boolean,
    private readonly read: (key: string, face: PaintFace) => PaintSample,
    private readonly apply: (key: string, face: PaintFace, sample: PaintSample) => void,
    private readonly onState: (hint: string, error?: boolean) => void,
  ) {}

  get active() { return this.state !== 'off'; }

  start() {
    this.state = 'on';
    this.hint();
  }

  stop() {
    this.state = 'off';
    this.onState('');
  }

  /** pick — взять образец (клик с Ctrl/Cmd/Alt). */
  click(point: [number, number], pick: boolean) {
    if (!this.active) return;
    const hit = this.layer.focusRayHits(point, this.allowed)[0];
    if (!hit) return;
    const face: PaintFace = hit.face === 'wall' ? 'wall' : 'roof';
    if (pick) {
      this.sample = this.read(hit.key, face);
      this.hint();
      return;
    }
    if (!this.sample) { this.onState(tr('Сначала возьмите образец: Ctrl+клик по поверхности.'), true); return; }
    this.apply(hit.key, face, this.sample);
  }

  /** Образец со здания (пипеткой): цвет и материал поверхности. */
  pickBuilding(key: string, face: PaintFace) {
    if (!this.active) return;
    this.sample = this.read(key, face);
    this.hint();
  }

  /** Цвет взят с растра (пипеткой: спутниковая подложка или фото в окне панорамы). */
  pickColour(colour: string) {
    if (!this.active) return;
    this.sample = { from: 'photo', colour };
    this.hint();
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active || e.type !== 'keydown' || e.key !== 'Escape') return false;
    this.stop();
    return true;
  }

  private hint() {
    const s = this.sample;
    const what = !s ? '' : s.from === 'photo'
      ? tr('цвет с растра {colour}', { colour: s.colour ?? '—' })
      : s.from === 'roof'
      ? tr('крыша: цвет {colour}, материал {material}', { colour: s.colour ?? '—', material: s.material ?? '—' })
      : tr('фасад: цвет {colour}, материал {material}', { colour: s.colour ?? '—', material: s.material ?? '—' });
    this.onState(s
      ? tr('Заливка ({what}): клик по крыше или стене — назначить. Ctrl+клик — взять другой образец. Esc — выйти.', { what })
      : tr('Заливка: клик по зданию — взять цвет и материал (крыша или фасад), по спутниковой подложке или фото в окне панорамы — только цвет. Esc — выйти.'));
  }
}

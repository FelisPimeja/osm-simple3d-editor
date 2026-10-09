import type { BuildingsLayer } from '../render/buildings-layer';

export type PaintFace = 'roof' | 'wall';
/** Скопированное: цвет и материал (undefined — не задан, при заливке удаляется). */
export interface PaintSample { from: PaintFace; colour?: string; material?: string }

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
    if (!this.sample) { this.onState('Сначала возьмите образец: Ctrl+клик по поверхности.', true); return; }
    this.apply(hit.key, face, this.sample);
  }

  key(e: KeyboardEvent): boolean {
    if (!this.active || e.type !== 'keydown' || e.key !== 'Escape') return false;
    this.stop();
    return true;
  }

  private hint() {
    const s = this.sample;
    const what = s ? `${s.from === 'roof' ? 'крыша' : 'фасад'}: цвет ${s.colour ?? '—'}, материал ${s.material ?? '—'}` : '';
    this.onState(s
      ? `Заливка (${what}): клик по крыше или стене — назначить. Ctrl+клик — взять другой образец. Esc — выйти.`
      : 'Заливка: Ctrl+клик по поверхности — взять цвет и материал (крыша или фасад). Esc — выйти.');
  }
}

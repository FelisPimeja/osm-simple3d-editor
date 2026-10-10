import type { Map as MlMap } from 'maplibre-gl';
import type { LonLat } from '../osm/model';
import type { BuildingsLayer } from '../render/buildings-layer';

/** Значок над зданием: ключ (отношение здания или само здание), точка и высота верха, м. */
export interface IndoorBadge { key: string; at: LonLat; top: number; title: string }

/**
 * Значки «есть поэтажный план» над зданиями в режиме карты: HTML поверх карты на высоте верха здания,
 * позиции пересчитываются на каждом кадре. Клик — onPick(ключ).
 */
export class IndoorBadges {
  private readonly root: HTMLDivElement;
  private items: { el: HTMLElement; b: IndoorBadge }[] = [];
  private signature = '';

  constructor(private readonly map: MlMap, private readonly layer: BuildingsLayer, private readonly icon: string, onPick: (key: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'indoor-badges';
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.indoor-badge');
      if (el?.dataset.key) { e.stopPropagation(); onPick(el.dataset.key); }
    });
    map.getContainer().appendChild(this.root);
    map.on('render', () => this.place());
  }

  set(badges: IndoorBadge[]) {
    const sig = badges.map((b) => `${b.key}@${b.top.toFixed(1)}`).join(',');
    if (sig === this.signature) return;
    this.signature = sig;
    this.root.innerHTML = '';
    this.items = badges.map((b) => {
      const el = document.createElement('div');
      el.className = 'indoor-badge';
      el.dataset.key = b.key;
      el.title = b.title;
      el.innerHTML = this.icon;
      this.root.appendChild(el);
      return { el, b };
    });
    this.place();
  }

  private place() {
    if (!this.items.length) return;
    const canvas = this.map.getCanvas(), w = canvas.clientWidth, h = canvas.clientHeight;
    const project = this.layer.geoProjector();
    for (const { el, b } of this.items) {
      const p = project?.(b.at, b.top);
      const visible = !!p && p[0] > -20 && p[1] > -20 && p[0] < w + 20 && p[1] < h + 20;
      el.hidden = !visible;
      if (visible) el.style.transform = `translate(${p![0]}px, ${p![1]}px)`;
    }
  }
}

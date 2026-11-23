import type { Map as MlMap } from 'maplibre-gl';
import type { BuildingsLayer } from '../render/buildings-layer';

/** Есть что подписать: номер подъезда или квартиры. */
const labelled = (t: Record<string, string>) => !!(t.ref || t['addr:flats']);

/**
 * Подписи над входами: номер (ref) и с новой строки квартиры (addr:flats) — видно, проставлены ли они у подъездов.
 * HTML поверх карты, позиции — на каждом кадре; вход на обратной к камере стене не подписан, закрытый другим
 * зданием (луч от камеры упирается в него раньше двери) — скрыт после остановки камеры.
 */
export class EntranceLabels {
  private readonly root: HTMLDivElement;
  private readonly els = new Map<number, HTMLDivElement>();
  private occluded = new Set<number>();
  private run = 0;

  constructor(private readonly map: MlMap, private readonly layer: BuildingsLayer, private readonly minZoom: number, private readonly shown: () => boolean,
    /** Теги входа с правками сессии (тайлы карты от правки тегов узла не пересобираются). */
    private readonly liveTags: (id: number, tags: Record<string, string>) => Record<string, string> = (_, t) => t) {
    this.root = document.createElement('div');
    this.root.className = 'entrance-labels';
    map.getCanvasContainer().appendChild(this.root);
    map.on('render', () => this.place());
    map.on('idle', () => this.updateOcclusion());
    map.on('movestart', () => { this.run++; });
  }

  private points() {
    if (!this.shown() || this.map.getZoom() < this.minZoom) return [];
    return this.layer.entranceScreenPoints(() => true).map((p) => ({ ...p, tags: this.liveTags(p.id, p.tags) })).filter((p) => labelled(p.tags));
  }

  private place() {
    const pts = this.points();
    const live = new Set<number>();
    for (const p of pts) {
      if (!p.facing) continue;
      live.add(p.id);
      let el = this.els.get(p.id);
      const text = [p.tags.ref, p.tags['addr:flats']].filter(Boolean).join('\n');
      if (!el) { el = document.createElement('div'); el.className = 'entrance-label'; this.root.appendChild(el); this.els.set(p.id, el); }
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('occluded', this.occluded.has(p.id));
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of this.els) if (!live.has(id)) { el.remove(); this.els.delete(id); }
  }

  /** Заслонение — кусками по 4 мс после остановки камеры. */
  private updateOcclusion() {
    const run = ++this.run;
    const pts = this.points().filter((p) => p.facing);
    const next = new Set<number>();
    let i = 0;
    const step = () => {
      if (run !== this.run) return;
      const until = performance.now() + 4;
      const project = this.layer.geoProjector();
      for (; i < pts.length && performance.now() < until; i++) {
        const p = pts[i], s = project?.(p.at, p.z);
        const hit = s && this.layer.pickHit(s);
        if (!hit) continue;
        const dHit = this.layer.depthAt(hit.lngLat, hit.altitude), dDoor = this.layer.depthAt({ lng: p.at[0], lat: p.at[1] }, p.z);
        // Попадание заметно ближе двери (своя стена у самой двери не в счёт)
        if (dHit !== undefined && dDoor !== undefined && dHit < dDoor && Math.hypot((hit.lngLat.lng - p.at[0]) * 111320 * Math.cos(p.at[1] * Math.PI / 180), (hit.lngLat.lat - p.at[1]) * 110540, hit.altitude - p.z) > 1.5) next.add(p.id);
      }
      if (i < pts.length) { setTimeout(step, 0); return; }
      this.occluded = next;
      this.place();
    };
    step();
  }
}

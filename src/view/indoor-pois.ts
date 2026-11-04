import * as THREE from 'three';
import type { Map as MlMap } from 'maplibre-gl';
import { pointOnSurface, type IndoorFeature, type LonLat } from '../osm/model';
import type { BuildingsLayer } from '../render/buildings-layer';

/**
 * Значки точечных объектов плана этажа (как в indoorequal): входы, лифты, лестницы, туалеты, магазины…
 * Иконки — Maki и Temaki (CC0), их же использует indoorequal. Значки — HTML поверх карты, в точке на высоте
 * пола этажа; позиции пересчитываются на каждом кадре.
 */
const MAKI = import.meta.glob('/node_modules/@mapbox/maki/icons/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const TEMAKI = import.meta.glob('/node_modules/@rapideditor/temaki/icons/{atm,vending_machine,bench,ticket,clothes_hanger}.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Лестница — своя (в Maki и Temaki нет). */
const STAIRS = '<svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg"><path d="M1 13h3.5v-3h3V7h3V4H14v2h-2v3H9v3H6v3H1z"/></svg>';
/** Вращающаяся дверь (в Maki и Temaki нет): круг с крестом створок. */
const REVOLVING = '<svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" style="fill:none;stroke:currentColor;stroke-width:1.4"><circle cx="7.5" cy="7.5" r="6"/><path d="M7.5 1.5v12M1.5 7.5h12" transform="rotate(30 7.5 7.5)"/></svg>';

function icon(name: string): string | undefined {
  if (name === 'stairs') return STAIRS;
  if (name === 'revolving-door') return REVOLVING;
  return MAKI[`/node_modules/@mapbox/maki/icons/${name}.svg`] ?? TEMAKI[`/node_modules/@rapideditor/temaki/icons/${name}.svg`];
}

const AMENITY: Record<string, string> = {
  toilets: 'toilet', atm: 'atm', vending_machine: 'vending_machine', cafe: 'cafe', restaurant: 'restaurant',
  fast_food: 'fast-food', bar: 'bar', pub: 'beer', bank: 'bank', pharmacy: 'pharmacy', drinking_water: 'drinking-water',
  post_office: 'post', library: 'library', cinema: 'cinema', theatre: 'theatre', place_of_worship: 'place-of-worship',
  police: 'police', doctors: 'doctor', clinic: 'doctor', hospital: 'hospital', dentist: 'dentist', telephone: 'telephone',
  waste_basket: 'waste-basket', recycling: 'recycling', parking: 'parking', bench: 'bench', ice_cream: 'ice-cream',
  information: 'information', fire_station: 'fire-station', school: 'school', college: 'college', university: 'college',
  kindergarten: 'playground', nightclub: 'nightclub', casino: 'casino', charging_station: 'charging-station',
  shelter: 'shelter', bicycle_parking: 'bicycle', car_rental: 'car-rental', marketplace: 'shop', townhall: 'town-hall',
  courthouse: 'town-hall', events_venue: 'star', conference_centre: 'star', studio: 'music', arts_centre: 'art-gallery',
};

const SHOP: Record<string, string> = {
  clothes: 'clothing-store', shoes: 'shoe', jewelry: 'jewelry-store', florist: 'florist', bakery: 'bakery',
  convenience: 'convenience', supermarket: 'grocery', gift: 'gift', optician: 'optician', hairdresser: 'hairdresser',
  beauty: 'hairdresser', alcohol: 'alcohol-shop', mobile_phone: 'mobile-phone', books: 'library', confectionery: 'confectionery',
  furniture: 'furniture', hardware: 'hardware', laundry: 'laundry', dry_cleaning: 'laundry', watches: 'watch',
  ticket: 'ticket', music: 'music', paint: 'paint', garden_centre: 'garden-centre', car: 'car', bicycle: 'bicycle',
};

/** Имя значка Maki/Temaki по тегам; undefined — объект без значка. */
export function poiIcon(t: Record<string, string>): string | undefined {
  if (t.room === 'elevator' || t.highway === 'elevator' || t.elevator === 'yes') return 'elevator';
  if (t.room === 'stairs' || t.stairs === 'yes' || t.highway === 'steps' || t.indoor === 'stairs') return 'stairs';
  if (t.emergency === 'defibrillator') return 'defibrillator';
  if (t.emergency === 'phone') return 'emergency-phone';
  if (t.amenity && AMENITY[t.amenity]) return AMENITY[t.amenity];
  if (t.room === 'toilet' || t.room === 'toilets') return 'toilet';
  if (t.room === 'dressing' || t.amenity === 'dressing_room') return 'clothes_hanger';
  if (t.room === 'reception' || t.amenity === 'reception_desk' || t.tourism === 'information') return 'information';
  if (t.room === 'security') return 'police';
  if (t.tourism === 'museum' || t.tourism === 'gallery') return 'museum';
  if (t.tourism === 'artwork') return 'art-gallery';
  if (t.healthcare) return 'doctor';
  if (t.shop && t.shop !== 'no') return SHOP[t.shop] ?? 'shop';
  if (t.office && t.office !== 'no') return 'suitcase';
  if (t.leisure === 'fitness_centre' || t.leisure === 'sports_centre') return 'fitness-centre';
  if (t.craft) return 'hardware';
  // Вращающаяся дверь — своим значком; вход — стрелкой в дверь (entrance в Maki — человек на ступенях, похож на эскалатор)
  if (t.door === 'revolving') return 'revolving-door';
  if (t.entrance && t.entrance !== 'no') return 'entrance-alt1';
  return; // двери — проёмами в стенах, без значков
}

/** Площадь кольца lon/lat (в градусах², для сравнения помещений между собой). */
function ringArea(r: LonLat[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
}

export class IndoorPois {
  private readonly root: HTMLDivElement;
  /** prio — кто важнее при наложении (больше — главнее); w, h — размер на экране, измеряется один раз. */
  private items: { key: string; el: HTMLElement; local: THREE.Vector3; shift?: string; below?: boolean; prio: number; w?: number; h?: number }[] = [];
  private selected = new Set<string>();
  private issueHighlighted = new Set<string>();
  private signature = '';
  private byEl = new Map<HTMLElement, IndoorFeature>();

  constructor(private readonly map: MlMap, private readonly layer: BuildingsLayer, onPick: (f: IndoorFeature, add: boolean, point: [number,number]) => void) {
    this.root = document.createElement('div');
    this.root.className = 'indoor-pois';
    // Перетаскивание карты (левая кнопка) над значком — тоже карте: MapLibre начинает его с mousedown на canvas.
    // Клик по значку — только если мышь почти не сдвинулась, иначе это было перетаскивание
    let downAt: [number, number] | undefined;
    this.root.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.ctrlKey) return;
      downAt = [e.clientX, e.clientY];
      map.getCanvasContainer().dispatchEvent(new MouseEvent('mousedown', e));
    });
    this.root.addEventListener('click', (e) => {
      if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { e.stopPropagation(); return; }
      const el = (e.target as HTMLElement).closest<HTMLElement>('.indoor-poi');
      const f = el && this.byEl.get(el);
      if (f) { e.stopPropagation(); const rect=map.getContainer().getBoundingClientRect(); onPick(f, e.shiftKey, [e.clientX-rect.left,e.clientY-rect.top]); }
    });
    // Колесо над значком — карте: значки лежат вне слоя, где MapLibre слушает колесо, и зум над ними не работал
    this.root.addEventListener('wheel', (e) => {
      e.preventDefault();
      map.getCanvas().dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    // Вращение камеры (средняя, правая или Ctrl+левая кнопка) над значком — тоже карте: вращение слушает canvas,
    // а нажатие над значком туда не доходило. Дальнейшее движение canvas получит сам (захват указателя)
    this.root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || !(e.button === 1 || e.button === 2 || (e.button === 0 && e.ctrlKey))) return;
      e.preventDefault();
      e.stopPropagation();
      map.getCanvasContainer().dispatchEvent(new PointerEvent('pointerdown', e));
    });
    map.getContainer().appendChild(this.root);
    map.on('render', () => this.place());
  }

  /** Подписи (номера и названия помещений) — без них в каркасе: значки остаются. */
  setLabels(on: boolean) {
    this.root.classList.toggle('no-labels', !on);
  }

  /** Подсветка выбранных точек; #poi у значка помещения совпадает с ключом самого помещения. */
  setSelection(keys: string[]) {
    this.selected = new Set(keys.map((key) => key.replace(/#poi$/, '')));
    this.updateHighlight();
  }

  setIssueHighlight(keys: string[]) {
    this.issueHighlighted = new Set(keys.map((key) => key.replace(/#poi$/, '')));
    this.updateHighlight();
  }

  private updateHighlight() {
    for (const { key, el } of this.items) {
      const k = key.replace(/#poi$/, '');
      el.classList.toggle('selected', this.selected.has(k) || this.issueHighlighted.has(k));
    }
    this.place(); // выделенные — первыми при вытеснении
  }

  /**
   * Значки этажа: объекты kind=poi с точкой, z — высота пола, м. Пустой список — убрать. refs — помещения и зоны:
   * с ref=* или name=* — подпись в середине (номер жирным, затем название; у помещения со значком — под значком).
   */
  set(pois: IndoorFeature[], z: number, positions: ReadonlyMap<string, { at: LonLat; z: number }> = new Map(), refs: IndoorFeature[] = []) {
    const shown = pois.filter((f) => f.point && poiIcon(f.tags));
    const represented = new Set(shown.map(f => f.key.replace(/#poi$/, '')));
    // Rooms created or retagged in this session may have no parsed #poi companion yet.
    for (const f of refs) if (!represented.has(f.key) && !f.line && f.polygons[0]?.outer.length && poiIcon(f.tags)) {
      shown.push({ ...f, key: `${f.key}#poi`, kind: 'poi', point: pointOnSurface(f.polygons[0]) });
      represented.add(f.key);
    }
    const labelled = refs.filter((f) => (f.tags.ref || f.tags.name) && !f.line && f.polygons.length);
    const sig = `${z}|${shown.map((f) => {
      const p = positions.get(f.key);
      // Точка и значок — тоже: дверь сдвинули («Переместить») или сменили вид — значок за ней
      return `${f.key}:${f.point!.join(',')}:${poiIcon(f.tags)}:${p ? `${p.at.join(',')}:${p.z}` : ''}`;
    }).join(',')}|${labelled.map((f) => `${f.key}:${f.tags.ref}:${f.tags.name}:${f.polygons[0].outer.length}:${f.polygons[0].outer[0]}`).join(',')}`;
    if (sig === this.signature) return;
    this.signature = sig;
    this.root.innerHTML = '';
    this.items = [];
    this.byEl.clear();
    for (const f of shown) {
      const position = positions.get(f.key);
      const local = this.layer.focusToLocal(position?.at ?? f.point!);
      const svg = icon(poiIcon(f.tags)!);
      if (!local || !svg) continue;
      const el = document.createElement('div');
      el.className = 'indoor-poi';
      el.innerHTML = svg.replace(/<\?xml[^>]*>/, '');
      const t = f.tags;
      el.title = [t.name ?? t.ref, t.shop ?? t.amenity ?? t.office ?? t.door ?? t.entrance, f.key.replace('#poi', '')].filter(Boolean).join(' · ');
      this.root.appendChild(el);
      this.byEl.set(el, f);
      // Значки важнее подписей; вход и лифт — важнее прочих значков
      const kind = poiIcon(f.tags);
      this.items.push({ key: f.key, el, local: new THREE.Vector3(local[0], local[1], position?.z ?? z + 0.3), prio: 2e9 + (kind === 'entrance-alt1' || kind === 'elevator' || kind === 'stairs' ? 1 : 0), w: 20, h: 20 });
    }
    const iconAt = new Map(shown.map((f) => [f.key.replace(/#poi$/, ''), f.point!]));
    for (const f of labelled) {
      const under = iconAt.get(f.key);
      const local = this.layer.focusToLocal(under ?? pointOnSurface(f.polygons[0]));
      if (!local) continue;
      const el = document.createElement('div');
      el.className = 'indoor-poi indoor-ref';
      if (f.tags.ref) el.append(Object.assign(document.createElement('b'), { textContent: f.tags.ref }));
      if (f.tags.ref && f.tags.name) el.append(' ');
      if (f.tags.name) el.append(f.tags.name);
      el.title = [f.tags.name, f.tags.ref && `ref=${f.tags.ref}`, f.key].filter(Boolean).join(' · ');
      this.root.appendChild(el);
      this.byEl.set(el, f);
      // Подпись большого помещения важнее подписи маленького
      this.items.push({ key: f.key, el, local: new THREE.Vector3(local[0], local[1], z + 0.3), shift: under ? 'translate(-50%, 12px)' : 'translate(-50%, -50%)', below: !!under, prio: ringArea(f.polygons[0].outer) });
    }
    this.items.sort((a, b) => b.prio - a.prio);
    this.setSelection([...this.selected]);
    this.place();
  }

  /**
   * Позиции на кадре и вытеснение: по убыванию важности (выделенные — первыми) каждый занимает свой прямоугольник
   * на экране; кто налезает на уже поставленный, прячется (crowded) — при приближении место найдётся.
   */
  private place() {
    if (!this.items.length) return;
    const w = this.map.getCanvas().clientWidth, h = this.map.getCanvas().clientHeight;
    const project = this.layer.focusProjector();
    const labels = !this.root.classList.contains('no-labels');
    const placed = new Map<number, [number, number, number, number][]>();
    const CELL = 64, GAP = 2;
    const cells = (x0: number, y0: number, x1: number, y1: number) => {
      const out: number[] = [];
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
        for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) out.push(i * 100003 + j);
      return out;
    };
    const order = this.selected.size || this.issueHighlighted.size
      ? [...this.items.filter((it) => this.isMarked(it.key)), ...this.items.filter((it) => !this.isMarked(it.key))] : this.items;
    for (const it of order) {
      const { el, local, shift } = it;
      const p = project?.(local);
      const visible = !!p && p[0] > -20 && p[1] > -20 && p[0] < w + 20 && p[1] < h + 20;
      el.hidden = !visible;
      if (!visible) continue;
      el.style.transform = `translate(${p![0]}px, ${p![1]}px)${shift ? ' ' + shift : ''}`;
      if (shift && !labels) continue; // подписи скрыты (каркас) — места не занимают
      if (!it.w) { it.w = el.offsetWidth; it.h = el.offsetHeight; }
      const bw = it.w!, bh = it.h!;
      const x0 = p![0] - bw / 2 - GAP, x1 = p![0] + bw / 2 + GAP;
      // Подпись под значком своего помещения стоит вплотную к нему (значок с зазором кончается ровно на +12):
      // зазор сверху у неё не берём, иначе значок всегда вытеснял бы её
      const y0 = it.below ? p![1] + 12 : p![1] - bh / 2 - GAP, y1 = (it.below ? p![1] + 12 : p![1] - bh / 2) + bh + GAP;
      const ks = cells(x0, y0, x1, y1);
      const hit = !this.isMarked(it.key) && ks.some((k) => placed.get(k)?.some((b) => b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0));
      el.classList.toggle('crowded', hit);
      if (hit) continue;
      for (const k of ks) (placed.get(k) ?? placed.set(k, []).get(k)!).push([x0, y0, x1, y1]);
    }
  }

  private isMarked(key: string) {
    const k = key.replace(/#poi$/, '');
    return this.selected.has(k) || this.issueHighlighted.has(k);
  }
}

import type { IndoorFeature } from './model';
import { tr } from '../i18n';

/**
 * Раскраска плана этажа по назначению помещений. Назначение — по тегам самого помещения и POI внутри него
 * (магазин-узел в помещении без тегов делает помещение магазином). Порядок проверок: закрытое — раньше назначения.
 */
export type IndoorCategory = 'private' | 'technical' | 'parking' | 'shop' | 'food' | 'medical' | 'office' | 'circulation' | 'other';

/** Бледные оттенки заливки пола. */
export const CATEGORY_COLOURS: Record<IndoorCategory, number> = {
  circulation: 0xffffff,
  private: 0xe2e0dd,
  technical: 0xe2e0dd,
  parking: 0xdde3ea,
  shop: 0xf8dbe6,
  food: 0xfbe2c8,
  medical: 0xd9f0dc,
  office: 0xd8ebfb,
  other: 0xfbf3cf,
};

/** Подписи легенды; закрытые и технические — одним пунктом (один цвет). */
export const CATEGORY_LABELS: Record<IndoorCategory, string> = {
  circulation: tr('Коридоры, холлы, лестницы, лифты'),
  private: tr('Закрытые и технические'),
  technical: tr('Закрытые и технические'),
  parking: tr('Парковка'),
  shop: tr('Магазины и услуги'),
  food: tr('Кафе и рестораны'),
  medical: tr('Медицина'),
  office: tr('Кабинеты, классы, туалеты'),
  other: tr('Прочие помещения'),
};

/** Порядок пунктов легенды. */
export const CATEGORY_ORDER: IndoorCategory[] = ['circulation', 'shop', 'food', 'office', 'medical', 'parking', 'private', 'other'];

const ROOM: Partial<Record<string, IndoorCategory>> = {
  corridor: 'circulation', hall: 'circulation', lobby: 'circulation', foyer: 'circulation', stairs: 'circulation', elevator: 'circulation',
  escalator: 'circulation', entrance: 'circulation', waiting: 'circulation', steps: 'circulation',
  // Платформа — общая зона прохода: магазин или кафе на ней её не перекрашивают (relation/19896350)
  platform: 'circulation',
  technical: 'technical', warehouse: 'technical', storage: 'technical', utility: 'technical', kitchen: 'technical', server: 'technical', electrical: 'technical',
  shop: 'shop', restaurant: 'food', cafe: 'food', food_court: 'food', foodcourt: 'food', dining: 'food',
  office: 'office', class: 'office', classroom: 'office', auditorium: 'office', amphitheatre: 'office', conference: 'office',
  laboratory: 'office', library: 'office', reception: 'office', sport: 'office', sports: 'office', toilets: 'office', toilet: 'office', bathroom: 'office', shower: 'office',
  lecture_hall: 'office', lecture: 'office', meeting: 'office', computer: 'office', study: 'office', administration: 'office', workshop: 'office',
  retail: 'shop', store: 'shop', kiosk: 'shop', bar: 'food', canteen: 'food', lounge: 'circulation',
  service: 'technical', security: 'technical', archive: 'technical', garage: 'technical',
  medical: 'medical', pharmacy: 'medical', parking: 'parking',
};
const FOOD = new Set(['cafe', 'restaurant', 'fast_food', 'food_court', 'bar', 'pub', 'ice_cream', 'biergarten']);
const SERVICES = new Set(['bank', 'atm', 'post_office', 'bureau_de_change', 'money_transfer', 'payment_centre', 'dry_cleaning', 'car_rental', 'ticket_office']);
const MEDICAL = new Set(['pharmacy', 'clinic', 'doctors', 'dentist', 'hospital', 'veterinary']);
const OFFICE = new Set(['toilets', 'school', 'college', 'university', 'library', 'kindergarten', 'training', 'coworking_space']);

/** Назначение по тегам одного объекта (помещения или POI); undefined — не понятно. */
function purpose(t: Record<string, string>): IndoorCategory | undefined {
  if (t.access === 'no' || t.access === 'private') return 'private';
  const a = t.amenity;
  if (a === 'parking' || t.parking) return 'parking';
  if (a && FOOD.has(a)) return 'food';
  if ((a && MEDICAL.has(a)) || t.healthcare) return 'medical';
  if (t.shop || t.craft || (a && SERVICES.has(a))) return 'shop';
  if (t.office || (a && OFFICE.has(a))) return 'office';
  if (t.highway === 'elevator' || t.highway === 'steps' || t.stairs === 'yes' || t.elevator === 'yes' || t.conveying) return 'circulation';
  return t.room ? ROOM[t.room] : undefined;
}

/** Мелочь на площадке (банкомат, автомат) — не назначение всей площадки. */
const SMALL = new Set(['atm', 'vending_machine', 'payment_terminal', 'bench', 'waste_basket', 'drinking_water', 'charging_station', 'parcel_locker', 'telephone', 'information']);

/** POI внутри, от которого помещение без своих тегов назначения берёт категорию; undefined — нет такого. */
export function categorySource(f: IndoorFeature, inside: IndoorFeature[] = []): IndoorFeature | undefined {
  if (purpose(f.tags)) return undefined;
  // Коридор — общее пространство: киоски, кафе и банкоматы в нём назначение не меняют
  if (f.kind !== 'room' && f.kind !== 'area') return undefined;
  for (const p of inside) {
    if (p.tags.door || p.tags.indoor === 'door' || p.tags.entrance) continue;
    if (f.kind === 'area' && (SMALL.has(p.tags.amenity ?? '') || p.tags.shop === 'kiosk' || p.tags.shop === 'vending')) continue;
    const c = purpose(p.tags);
    if (c && c !== 'private') return p;
  }
  return undefined;
}

/**
 * Категория помещения, коридора или площадки: по своим тегам (приоритет); без них — по POI внутри (первая
 * понятная, двери и входы не в счёт), иначе помещение — «прочее», коридор и площадка — белые.
 */
export function indoorCategory(f: IndoorFeature, inside: IndoorFeature[] = []): IndoorCategory {
  const own = purpose(f.tags);
  if (own) return own;
  const src = categorySource(f, inside);
  if (src) return purpose(src.tags)!;
  return f.kind === 'room' ? 'other' : 'circulation';
}

/** Значение room=*, соответствующее POI (для серой подсказки в поле «Назначение»). */
export function roomValueOf(t: Record<string, string>): string | undefined {
  const a = t.amenity;
  if (a && FOOD.has(a)) return a === 'fast_food' || a === 'restaurant' ? 'restaurant' : a === 'bar' || a === 'pub' ? 'bar' : 'cafe';
  if ((a && MEDICAL.has(a)) || t.healthcare) return a === 'pharmacy' ? 'pharmacy' : 'medical';
  if (t.shop || t.craft || (a && SERVICES.has(a))) return 'shop';
  if (t.office) return 'office';
  if (a === 'toilets') return 'toilets';
  if (a === 'library') return 'library';
  if (a && OFFICE.has(a)) return 'class';
  if (a === 'parking' || t.parking) return 'parking';
  return undefined;
}

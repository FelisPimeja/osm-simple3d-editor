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
  technical: 'technical', warehouse: 'technical', storage: 'technical', utility: 'technical', kitchen: 'technical', server: 'technical', electrical: 'technical',
  shop: 'shop', restaurant: 'food', cafe: 'food', food_court: 'food', dining: 'food',
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

/**
 * Категория помещения, коридора или площадки: по своим тегам; у помещения без них — по POI внутри (первая
 * понятная, двери и входы не в счёт), иначе «прочее». Коридор и площадка без своих тегов — белые.
 */
export function indoorCategory(f: IndoorFeature, inside: IndoorFeature[] = []): IndoorCategory {
  const own = purpose(f.tags);
  if (own) return own;
  // Коридор и площадка — общее пространство: киоски, кафе и банкоматы в них назначение не меняют
  if (f.kind !== 'room') return 'circulation';
  for (const p of inside) {
    if (p.tags.door || p.tags.indoor === 'door' || p.tags.entrance) continue;
    const c = purpose(p.tags);
    if (c && c !== 'private') return c;
  }
  return 'other';
}

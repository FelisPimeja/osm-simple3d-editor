/**
 * Подписи полей и значений из схемы тегов iD (@openstreetmap/id-tagging-schema) — общие термины и переводы
 * с iD, Rapid и др. Выжимка — src/osm/id-schema.json (npm run presets:extract). Формам формат iD не нужен:
 * они спрашивают только здесь; свои подписи форм главнее (переопределяют iD), чего нет нигде — сырое значение.
 */
import schema from './id-schema.json';
import { lang } from '../i18n';

interface SchemaField {
  id: string;
  type: string;
  options?: string[];
  label: Partial<Record<string, string>>;
  placeholder?: Partial<Record<string, string>>;
  values: Partial<Record<string, Record<string, string>>>;
}

const FIELDS = schema.fields as Record<string, SchemaField>;
/** Свой язык, иначе английский iD (у поля без перевода). */
const pick = <T>(m: Partial<Record<string, T>> | undefined): T | undefined => m?.[lang] ?? m?.en;

/** Название поля по ключу OSM. */
export const idFieldLabel = (key: string): string | undefined => pick(FIELDS[key]?.label);

/** Варианты значений поля из iD (если у поля есть список). */
export const idOptions = (key: string): string[] | undefined => FIELDS[key]?.options;

/** Подписи значений из iD, поверх — свои (own). */
export function valueLabels(key: string, own?: Record<string, string>): Record<string, string> {
  const f = FIELDS[key];
  // Только свой язык: английские подписи в русском списке хуже сырых значений
  return { ...(f?.values[lang] ?? {}), ...(own ?? {}) };
}

/** Версия схемы iD (для «О программе» и отладки). */
export const idSchemaVersion: string = schema.version;

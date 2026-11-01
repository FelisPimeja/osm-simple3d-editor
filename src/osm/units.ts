import { tr } from '../i18n';
import { FOOT, parseLength } from './heights';

/** Единица записи длины в тег. Настройка — только умолчание: у тега с заданным значением единица остаётся своя. */
export type LengthUnit = 'm' | 'ft';
export type UnitSystem = 'metric' | 'imperial';

const KEY = 'osm3d.units';
let system: UnitSystem = 'metric';
try { if (localStorage.getItem(KEY) === 'imperial') system = 'imperial'; } catch { /* нет хранилища */ }

export const unitSystem = () => system;
export function setUnitSystem(v: UnitSystem) {
  system = v;
  try { if (v === 'imperial') localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* нет хранилища */ }
}

/** Единица значения тега: явная имперская — футы, другое значение — метры, пусто — из настройки. */
export function lengthUnitOf(v?: string): LengthUnit {
  if (!v?.trim() || parseLength(v) === undefined) return system === 'imperial' ? 'ft' : 'm';
  return /^\s*-?[\d.]+\s*(ft|feet|foot|yds?|mi\b|miles?|'|")/.test(v) ? 'ft' : 'm';
}

/** Единица уже написана в поле (или там формула) — серая подпись не нужна. Кириллица — подсказки, не значение. */
export const hasOwnUnit = (v: string) => /[a-z'"=]/i.test(v);

/** Число в единице unit, без подписи. */
export const lengthNumber = (m: number, unit: LengthUnit) => String(Math.round((unit === 'ft' ? m / FOOT : m) * 100) / 100);

/** Значение тега из метров; prev — прежнее значение тега: его единица сохраняется. */
export function writeLength(m: number, prev?: string): string {
  const unit = lengthUnitOf(prev);
  return unit === 'ft' ? `${lengthNumber(m, unit)} ft` : lengthNumber(m, unit);
}

/** Введённое в поле: голое число получает единицу поля, остальное — как написано. */
export function withUnit(input: string, unit: LengthUnit | undefined): string {
  return unit === 'ft' && /^\s*-?\d+(\.\d+)?\s*$/.test(input) ? `${input.trim()} ft` : input;
}

/** Для инструментов: длина на экране и в наборе с клавиатуры — в единице настройки, внутри — метры. */
const inputFactor = () => (system === 'imperial' ? FOOT : 1);
export const unitLabel = () => (system === 'imperial' ? 'ft' : tr('м'));
export const toInputUnit = (m: number) => m / inputFactor();
export const fromInputUnit = (n: number) => n * inputFactor();
export const showLength = (m: number) => toInputUnit(m).toFixed(2);

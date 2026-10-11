/**
 * Язык интерфейса. Исходные строки — русские и сами служат ключами перевода (как в gettext):
 * tr('Свойства') → 'Properties'. Переводы — плоские JSON «ключ → строка» в src/i18n/locales/<язык>.json
 * (формат Key-Value JSON, понятный Transifex и подобным сервисам); ru.json — исходный файл, собирается из кода:
 * npm run i18n:extract. Чего нет в словаре — показывается по-русски (в dev-сборке — с предупреждением в консоли).
 * Проверка полноты словарей: npm run i18n:check.
 *
 * Язык выбирается один раз при загрузке страницы: сохранённый выбор (панель настроек), иначе — первый
 * из языков браузера и системы, который мы знаем; если ни один не подошёл — английский.
 * Смена языка перезагружает страницу: строки собираются в разных местах при старте.
 */
import en from './locales/en.json';

export type Lang = 'ru' | 'en';
/** Подписи — на своём языке, чтобы выбор находился при любом текущем. */
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
];

const STORE_KEY = 'osm3d.lang';
const DICTS: Record<Exclude<Lang, 'ru'>, Record<string, string>> = { en };

function isLang(v: unknown): v is Lang {
  return LANGS.some((l) => l.id === v);
}

/** Язык браузера и системы: navigator.languages по порядку, затем локаль Intl (обычно — системная). */
export function detectLang(): Lang {
  const prefs = [...(navigator.languages ?? []), navigator.language];
  try { prefs.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch { /* нет Intl */ }
  for (const p of prefs) {
    const base = p?.toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

function storedLang(): Lang | undefined {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return isLang(v) ? v : undefined;
  } catch { return undefined; }
}

export const lang: Lang = storedLang() ?? detectLang();
if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** Запомнить выбор и перезагрузить страницу (вызывающий сам спрашивает о несохранённых правках). */
export function setLang(l: Lang) {
  try { localStorage.setItem(STORE_KEY, l); } catch { /* без хранилища — только до перезагрузки, т.е. никак */ }
  location.reload();
}

/** Локаль для toLocaleString и Intl. */
export const locale = lang === 'ru' ? 'ru-RU' : 'en-US';

type Params = Record<string, string | number>;

const warned = new Set<string>();
function lookup(ru: string): string {
  if (lang === 'ru') return ru;
  const s = DICTS[lang][ru];
  if (s !== undefined) return s;
  if (import.meta.env?.DEV && !warned.has(ru)) {
    warned.add(ru);
    console.warn(`[i18n] нет перевода (${lang}):`, ru);
  }
  return ru;
}

function fill(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/**
 * Перевод строки. Ключ — русский текст литералом (иначе его не найдёт npm run i18n:check);
 * подстановки — {имя}: tr('Загружено {n} из {total}', { n, total }). Значения подставляются как есть —
 * в HTML экранируйте их заранее.
 */
export function tr(ru: string, params?: Params): string {
  return fill(lookup(ru), params);
}

/**
 * Перевод с числом: формы через «|» — русские 'здание|здания|зданий' (1, 2, 5), английские 'building|buildings'.
 * {n} в формах заменяется числом: trn(n, '{n} здание|{n} здания|{n} зданий').
 */
export function trn(n: number, ru: string, params?: Params): string {
  const forms = lookup(ru).split('|');
  return fill(forms[pluralIndex(n, forms.length)] ?? forms[forms.length - 1], { n, ...params });
}

function pluralIndex(n: number, count: number): number {
  const a = Math.abs(n);
  if (count < 3) return a === 1 ? 0 : 1; // английский (и русский, если форм указано две)
  if (!Number.isInteger(a)) return 1;
  const d = a % 10, dd = a % 100;
  if (d === 1 && dd !== 11) return 0;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 1;
  return 2;
}

/**
 * Перевод статичной разметки (index.html): текстовые узлы и атрибуты title, aria-label, placeholder.
 * Пробелы вокруг текста сохраняются; ключ — текст без них.
 */
export function localizeDom(root: ParentNode) {
  if (lang === 'ru') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const key = text.trim();
    if (!key || !/[А-Яа-яЁё]/.test(key)) continue;
    const start = text.indexOf(key);
    node.nodeValue = text.slice(0, start) + lookup(key) + text.slice(start + key.length);
  }
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const v = el.getAttribute(attr)!;
      if (/[А-Яа-яЁё]/.test(v)) el.setAttribute(attr, lookup(v));
    }
  }
}

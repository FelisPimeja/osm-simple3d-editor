// Проверка словарей src/i18n/locales: у каждой строки интерфейса — tr('…'), trn(n, '…') в src и текста index.html —
// есть английский текст, в словарях нет строк, которых больше нет в коде, ru.json актуален.
// npm run i18n:check — проверка; npm run i18n:extract (--write) — пересобрать ru.json из кода.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const CY = /[А-Яа-яЁё]/;

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { { if (p !== join(root, 'src/i18n')) yield* files(p); } } else if (/\.ts$/.test(e.name)) yield p;
  }
}

/** Строковый литерал (или их сумма через +) с позиции i; undefined — не литерал. */
function readLiteral(src, i) {
  let out = '', any = false;
  for (;;) {
    while (/\s/.test(src[i])) i++;
    const q = src[i];
    if (!`'"\``.includes(q)) return any ? { value: out, end: i } : undefined;
    let j = i + 1;
    while (src[j] !== q) { if (src[j] === '\\') j++; if (q === '`' && src[j] === '$' && src[j + 1] === '{') return { dynamic: true }; j++; }
    out += Function(`return ${src.slice(i, j + 1)}`)();
    any = true; i = j + 1;
    while (/\s/.test(src[i])) i++;
    if (src[i] !== '+') return { value: out, end: i };
    i++;
  }
}

const used = new Map(); // ключ → где встречается
const problems = [];
for (const file of files(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  const rel = file.slice(root.length);
  for (const m of src.matchAll(/(?<![\w.])(trn?)\(/g)) {
    let i = m.index + m[0].length;
    if (m[1] === 'trn') { // пропустить первый аргумент
      for (let depth = 0; ; i++) {
        const c = src[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { i++; break; }
      }
    }
    const line = src.slice(0, m.index).split('\n').length;
    const lit = readLiteral(src, i);
    if (!lit || lit.dynamic) { problems.push(`${rel}:${line}: ключ ${m[1]}() — не строковый литерал`); continue; }
    if (!used.has(lit.value)) used.set(lit.value, `${rel}:${line}`);
  }
}
const html = readFileSync(join(root, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
for (const m of html.matchAll(/>([^<]+)</g)) { const k = decode(m[1].trim()); if (CY.test(k)) used.set(k, 'index.html'); }
for (const m of html.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)) { const k = decode(m[1]); if (CY.test(k)) used.set(k, 'index.html'); }

const dir = join(root, 'src/i18n/locales');
// ru.json — русский перевод для Transifex: те же строки, что в коде, «ключ → ключ»
const source = Object.fromEntries([...used.keys()].map((k) => [k, k]));
const sourceText = JSON.stringify(source, null, 2) + '\n';
if (process.argv.includes('--write')) writeFileSync(join(dir, 'ru.json'), sourceText);
else if (readFileSync(join(dir, 'ru.json'), 'utf8') !== sourceText) problems.push('ru.json устарел — обновите: npm run i18n:extract');

let missing = 0, unused = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'ru.json')) {
  const lang = f.replace(/\.json$/, '');
  const dict = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  let langMissing = 0;
  for (const [k, where] of used) if (!(k in dict)) { langMissing++; console.log(`[${lang}] нет перевода (${where}): ${JSON.stringify(k)}`); }
  // Обязателен полный английский; остальные языки могут быть неполными — показываются по-русски
  if (lang === 'en') missing += langMissing;
  for (const k of Object.keys(dict)) if (!used.has(k)) { unused++; console.log(`[${lang}] не используется: ${JSON.stringify(k)}`); }
  for (const [k, v] of Object.entries(dict)) {
    const ph = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join();
    if (ph(k) !== ph(v)) problems.push(`[${lang}] подстановки не совпадают: ${JSON.stringify(k)}`);
    if (k.includes('|') !== v.includes('|')) problems.push(`[${lang}] формы через «|» — в ключе и переводе по-разному: ${JSON.stringify(k)}`);
  }
}
for (const p of problems) console.log(p);
console.log(`строк: ${used.size}, без перевода (en): ${missing}, лишних: ${unused}, ошибок: ${problems.length}`);
process.exit(missing || unused || problems.length ? 1 : 0);

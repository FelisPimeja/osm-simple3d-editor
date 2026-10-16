/**
 * Выжимка схемы тегов iD (@openstreetmap/id-tagging-schema) для полей редактора: подписи полей и значений
 * на наших языках. Вся схема с переводами — мегабайты, нам нужна малая часть: берём поля из белого списка
 * и подписи значений из полей и однотеговых пресетов (indoor=room → «Комната в здании»).
 * Отдельно (грузятся лениво) — пресеты для названия объекта по тегам: id-presets.json; и замены устаревших
 * тегов для валидатора: id-deprecated.json.
 * Обновление схемы: npm update @openstreetmap/id-tagging-schema && npm run presets:extract.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = '@openstreetmap/id-tagging-schema';
const { version } = require(`${dir}/package.json`);
const dist = (f) => JSON.parse(readFileSync(require.resolve(`${dir}/dist/${f}`), 'utf8'));

/** Ключ OSM → поле iD. */
const FIELDS = {
  'building:part': 'building/part', height: 'height', min_height: 'min_height', 'building:levels': 'building/levels',
  'roof:shape': 'roof/shape', 'roof:height': 'roof/height', 'roof:colour': 'roof/colour', 'building:colour': 'building/colour',
  level: 'level', indoor: 'indoor_type', room: 'room', door: 'door',
};
const LANGS = ['en', 'ru'];

const fields = dist('fields.json');
const presets = dist('presets.json');
const tr = Object.fromEntries(LANGS.map((l) => [l, dist(`translations/${l}.json`)[l].presets]));
const title = (s) => (typeof s === 'object' && s ? s.title : s);

const out = { version, fields: {} };
for (const [key, id] of Object.entries(FIELDS)) {
  const f = fields[id];
  if (!f || f.key !== key) throw new Error(`поле ${id} не про ${key}`);
  const entry = { id, type: f.type, label: {}, values: {} };
  if (f.options) entry.options = f.options;
  for (const l of LANGS) {
    const t = tr[l].fields[id] ?? {};
    if (t.label) entry.label[l] = t.label;
    if (t.placeholder) (entry.placeholder ??= {})[l] = t.placeholder;
    const values = {};
    // Однотеговые пресеты: имя объекта как подпись значения (поле с подписями ниже — главнее)
    for (const [pid, p] of Object.entries(presets)) {
      const tags = Object.entries(p.tags);
      if (tags.length !== 1 || tags[0][0] !== key || tags[0][1] === '*' || p.searchable === false) continue;
      const name = tr[l].presets[pid]?.name;
      if (name && !values[tags[0][1]]) values[tags[0][1]] = name;
    }
    for (const [v, s] of Object.entries(t.options ?? {})) if (title(s)) values[v] = title(s);
    if (Object.keys(values).length) entry.values[l] = values;
  }
  out.fields[key] = entry;
}
const write = (name, data, indent) => writeFileSync(new URL(`../src/osm/${name}`, import.meta.url), JSON.stringify(data, null, indent) + '\n');
write('id-schema.json', out, 1);

// Пресеты: теги, геометрия, вес, addTags, названия по языкам. Без региональных (locationSet: наш редактор
// не знает, где объект) и без пустых тегов (общие «точка», «линия» — у нас свои названия)
const list = [];
for (const [id, p] of Object.entries(presets)) {
  if (!Object.keys(p.tags).length || p.locationSet) continue;
  const name = Object.fromEntries(LANGS.map((l) => [l, tr[l].presets[id]?.name]).filter(([, n]) => n));
  if (!name.en) continue;
  list.push({ id, tags: p.tags, geometry: p.geometry, ...(p.matchScore !== undefined ? { score: p.matchScore } : {}),
    ...(p.addTags ? { addTags: p.addTags } : {}), ...(p.searchable === false ? { hidden: true } : {}), name });
}
write('id-presets.json', { version, presets: list });
write('id-deprecated.json', dist('deprecated.json'));
console.log(`id-tagging-schema ${version}: ${Object.keys(out.fields).length} полей, ${list.length} пресетов`);

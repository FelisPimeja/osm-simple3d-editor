// Снимок трансформаций моделей 3dmr.eu (поворот, масштаб, смещение) из ночной выгрузки репозитория.
// У моделей, загруженных до того, как 3dmr стал вшивать их в .glb (узел «3DMR transform»), эти поля есть
// только в базе, а /api/info их не отдаёт. Из архива (~300 МБ, без CORS) читается только info.json —
// HTTP Range-запросами: хвост с центральным каталогом zip и сама запись.
//
//   node scripts/3dmr-snapshot.mjs   → src/render/3dmr-transforms.json
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const URL = 'https://3dmr.eu/static/mainapp/3dmr-nightly.zip';
const OUT = new globalThis.URL('../src/render/3dmr-transforms.json', import.meta.url);
const UA = { 'User-Agent': 'osm-simple3d-editor 3dmr snapshot' };

async function range(from, to) {
  const r = await fetch(URL, { headers: { ...UA, Range: `bytes=${from}-${to}` } });
  if (r.status !== 206) throw new Error(`Range ${from}-${to}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const head = await fetch(URL, { method: 'HEAD', headers: UA });
const size = Number(head.headers.get('content-length'));
if (!size) throw new Error('нет размера архива');
const tail = await range(Math.max(0, size - 65536), size - 1);
const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocd < 0) throw new Error('не найден конец центрального каталога zip');
const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
const cd = await range(cdOffset, cdOffset + cdSize - 1);

let info;
for (let p = 0; p < cd.length;) {
  const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20);
  const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
  const offset = cd.readUInt32LE(p + 42), name = cd.toString('utf8', p + 46, p + 46 + nameLen);
  p += 46 + nameLen + extraLen + commentLen;
  if (name !== 'info.json') continue;
  const local = await range(offset, offset + 29);
  const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = await range(start, start + csize - 1);
  info = JSON.parse((method === 0 ? data : inflateRawSync(data)).toString('utf8'));
}
if (!info) throw new Error('в архиве нет info.json');

// Только модели с непустой трансформацией: остальным нечего применять
const out = {};
for (const [id, m] of Object.entries(info).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const t = m.translation ?? [];
  const rotation = m.rotation ?? 0, scale = m.scale ?? 1, translation = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  if (!rotation && scale === 1 && translation.every((v) => !v)) continue;
  out[id] = { revision: m.revision, rotation, scale, translation };
}
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${Object.keys(out).length} из ${Object.keys(info).length} моделей с трансформацией → ${OUT.pathname}`);

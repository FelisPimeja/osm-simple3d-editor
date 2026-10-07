import type { OsmElement, OsmRelation, OsmWay } from './api';
import { getToken } from './auth';
import { server } from './servers';

type Tags = Record<string, string>;

/** Изменение тегов одного пути или отношения. */
export interface TagEdit {
  key: string; // 'way/123'
  /** Элемент, как он пришёл из API (геометрия, члены, версия). */
  element: OsmWay | OsmRelation;
  /** Теги, с которых начиналась правка. */
  before: Tags;
  /** Теги, которые надо записать. */
  after: Tags;
  /** Новый объект: отрицательный id, уходит в <create>. */
  created?: boolean;
  /** У отношения изменён состав членов (element.members — уже новый). */
  membersChanged?: boolean;
}

export interface UploadResult {
  changeset: number;
  /** key → новая версия. */
  versions: Map<string, number>;
  /** Ключи созданных объектов: временный ('relation/-1') → настоящий. */
  newKeys: Map<string, string>;
  /** Объекты, изменённые на сервере параллельно: записаны поверх свежей версии с этими тегами. */
  rebased: Map<string, { element: OsmWay | OsmRelation; tags: Tags }>;
}

/** Конфликт, который нельзя разрешить автоматически: кто-то изменил те же теги. */
export class ConflictError extends Error {
  constructor(readonly conflicts: { key: string; tags: string[] }[]) {
    super(`Конфликт правок: ${conflicts.map((c) => `${c.key} (${c.tags.join(', ')})`).join('; ')}`);
  }
}

export class OsmApiError extends Error {
  constructor(readonly status: number, text: string) {
    super(`OSM API ${status}: ${text}`);
  }
}

const GENERATOR = 'osm-simple3d-editor';

const xmlEsc = (s: string | number) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const tagsXml = (tags: Tags) =>
  Object.entries(tags).map(([k, v]) => `<tag k="${xmlEsc(k)}" v="${xmlEsc(v)}"/>`).join('');

/** osmChange: новые элементы — в <create>, изменённые — в <modify>. */
export function buildOsmChange(edits: { element: OsmWay | OsmRelation; tags: Tags; created?: boolean }[], changeset: number): string {
  const xml = ({ element: e, tags, created }: (typeof edits)[number]) => {
    const attrs = `id="${e.id}"${created ? '' : ` version="${e.version}"`} changeset="${changeset}"`;
    if (e.type === 'way') {
      return `<way ${attrs}>${e.nodes.map((n) => `<nd ref="${n}"/>`).join('')}${tagsXml(tags)}</way>`;
    }
    const members = e.members.map((m) => `<member type="${m.type}" ref="${m.ref}" role="${xmlEsc(m.role)}"/>`).join('');
    return `<relation ${attrs}>${members}${tagsXml(tags)}</relation>`;
  };
  const create = edits.filter((e) => e.created).map(xml).join('');
  const modify = edits.filter((e) => !e.created).map(xml).join('');
  return `<osmChange version="0.6" generator="${GENERATOR}">${create ? `<create>${create}</create>` : ''}${
    modify ? `<modify>${modify}</modify>` : ''}</osmChange>`;
}

async function call(method: string, path: string, body?: string, accept = 'text/plain'): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('Нужно войти в OSM.');
  const res = await fetch(`${server().api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml; charset=utf-8', Accept: accept },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new OsmApiError(res.status, text || res.statusText);
  return text;
}

async function fetchElement(key: string): Promise<OsmWay | OsmRelation> {
  const text = await call('GET', `/${key}.json`, undefined, 'application/json');
  return (JSON.parse(text) as { elements: OsmElement[] }).elements[0] as OsmWay | OsmRelation;
}

/**
 * Применяет нашу правку поверх свежей версии с сервера.
 * Можно, если параллельно не трогали те же теги (геометрию и прочие теги берём с сервера).
 */
function rebase(edit: TagEdit, fresh: OsmWay | OsmRelation): { tags: Tags } | { conflict: string[] } {
  const serverTags = fresh.tags ?? {};
  const touched = [...new Set([...Object.keys(edit.before), ...Object.keys(edit.after)])]
    .filter((t) => edit.before[t] !== edit.after[t]);
  const conflict = touched.filter((t) => serverTags[t] !== edit.before[t] && serverTags[t] !== edit.after[t]);
  if (conflict.length) return { conflict };
  const tags = { ...serverTags };
  for (const t of touched) {
    if (edit.after[t] === undefined) delete tags[t];
    else tags[t] = edit.after[t];
  }
  return { tags };
}

/** Новые версии и id из diffResult (ключи — по старым id). */
function parseDiffResult(xml: string): Pick<UploadResult, 'versions' | 'newKeys'> {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const versions = new Map<string, number>();
  const newKeys = new Map<string, string>();
  for (const el of Array.from(doc.documentElement.children)) {
    const id = el.getAttribute('old_id'), v = el.getAttribute('new_version'), nid = el.getAttribute('new_id');
    if (!id || !v) continue;
    versions.set(`${el.tagName}/${id}`, Number(v));
    if (nid && nid !== id) newKeys.set(`${el.tagName}/${id}`, `${el.tagName}/${nid}`);
  }
  return { versions, newKeys };
}

/**
 * Загрузка правок одним changeset: create → upload → close.
 * При 409 (версия устарела) перечитывает изменённые элементы, переносит правки поверх свежих версий
 * и повторяет загрузку один раз; если те же теги изменил кто-то ещё — ConflictError.
 */
export async function uploadEdits(edits: TagEdit[], comment: string, onStatus: (s: string) => void = () => {}): Promise<UploadResult> {
  onStatus('Открываем changeset…');
  const changesetXml = `<osm><changeset>${tagsXml({
    comment,
    created_by: GENERATOR,
    hashtags: '#simple3d',
  })}</changeset></osm>`;
  const changeset = Number(await call('PUT', '/changeset/create', changesetXml));
  const rebased: UploadResult['rebased'] = new Map();
  try {
    let payload: Parameters<typeof buildOsmChange>[0] = edits.map((e) => ({ element: e.element, tags: e.after, created: e.created }));
    for (let attempt = 0; ; attempt++) {
      onStatus(`Загружаем ${payload.length} объектов в changeset ${changeset}…`);
      try {
        const diff = parseDiffResult(await call('POST', `/changeset/${changeset}/upload`, buildOsmChange(payload, changeset), 'application/xml'));
        return { changeset, ...diff, rebased };
      } catch (err) {
        if (!(err instanceof OsmApiError) || err.status !== 409 || attempt > 0) throw err;
        onStatus('Объекты изменились на сервере — переносим правки на свежие версии…');
        const conflicts: { key: string; tags: string[] }[] = [];
        payload = [];
        for (const edit of edits) {
          if (edit.created) { payload.push({ element: edit.element, tags: edit.after, created: true }); continue; }
          const fresh = await fetchElement(edit.key);
          if (fresh.version === edit.element.version) { payload.push({ element: edit.element, tags: edit.after }); continue; }
          // Состав членов автоматически не сливаем — пусть пользователь перезагрузит область
          if (edit.membersChanged) { conflicts.push({ key: edit.key, tags: ['состав членов'] }); continue; }
          const r = rebase(edit, fresh);
          if ('conflict' in r) conflicts.push({ key: edit.key, tags: r.conflict });
          else { payload.push({ element: fresh, tags: r.tags }); rebased.set(edit.key, { element: fresh, tags: r.tags }); }
        }
        if (conflicts.length) throw new ConflictError(conflicts);
      }
    }
  } finally {
    // Закрываем и при ошибке, чтобы не висел пустой changeset
    try { await call('PUT', `/changeset/${changeset}/close`); } catch { /* закроется сам через час */ }
  }
}

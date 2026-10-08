import { fetchElements, fetchNodes, type OsmMember, type OsmNode, type OsmRelation, type OsmWay } from './api';
import { getToken } from './auth';
import { server } from './servers';

type Tags = Record<string, string>;

/** Правка одного пути или отношения. Геометрию и версию берём с сервера в момент отправки. */
export interface TagEdit {
  key: string; // 'way/123'
  /** Теги, с которых начиналась правка. */
  before: Tags;
  /** Теги, которые надо записать. */
  after: Tags;
  /** Новое отношение или путь (отрицательный id) — уходит в <create>. */
  created?: OsmRelation | OsmWay;
  /** Новый состав членов отношения и исходный (если менялся). */
  members?: OsmMember[];
  membersBefore?: OsmMember[];
  /** Сдвинутые узлы: from — координаты, с которых начиналась правка. */
  nodeMoves?: { id: number; from: [number, number]; to: [number, number] }[];
  /** Список узлов пути менялся (рассечение): before — как было у нас, after — что записать. */
  wayNodes?: { before: number[]; after: number[] };
  /** Новые узлы (отрицательные id) — уходят в <create> раньше путей. */
  newNodes?: { id: number; at: [number, number] }[];
  /** Удалить объект (путь — вместе с его узлами без тегов, которые больше никому не нужны). */
  deleted?: boolean;
}

export interface UploadResult {
  changeset: number;
  /** key → новая версия. */
  versions: Map<string, number>;
  /** Ключи созданных объектов: временный ('relation/-1') → настоящий. */
  newKeys: Map<string, string>;
  /** Записанные теги (могут включать параллельные чужие правки других тегов). */
  written: Map<string, Tags>;
  /** Объекты, которые кто-то изменил после загрузки данных: наши правки перенесены поверх. */
  rebased: Set<string>;
  /** Объекты, у которых записана геометрия (узлы), даже если сам путь не менялся. */
  geometrySaved: Set<string>;
  /** Удалённые объекты. */
  deleted: Set<string>;
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
export function buildOsmChange(edits: { element: OsmWay | OsmRelation | (OsmNode & { version: number }); tags: Tags; created?: boolean; deleted?: boolean }[], changeset: number): string {
  const xml = ({ element: e, tags, created }: (typeof edits)[number]) => {
    const attrs = `id="${e.id}"${created ? '' : ` version="${e.version}"`} changeset="${changeset}"`;
    if (e.type === 'node') return `<node ${attrs} lat="${e.lat.toFixed(7)}" lon="${e.lon.toFixed(7)}">${tagsXml(tags)}</node>`;
    if (e.type === 'way') {
      return `<way ${attrs}>${e.nodes.map((n) => `<nd ref="${n}"/>`).join('')}${tagsXml(tags)}</way>`;
    }
    const members = e.members.map((m) => `<member type="${m.type}" ref="${m.ref}" role="${xmlEsc(m.role)}"/>`).join('');
    return `<relation ${attrs}>${members}${tagsXml(tags)}</relation>`;
  };
  // Новые: узлы, затем пути, затем отношения — на них ссылаются следующие
  const rank = { node: 0, way: 1, relation: 2 } as const;
  const create = edits.filter((e) => e.created).sort((x, y) => rank[x.element.type] - rank[y.element.type]).map(xml).join('');
  const modify = edits.filter((e) => !e.created && !e.deleted).map(xml).join('');
  // Удаление: сначала отношения, затем пути, затем узлы. if-unused — то, что ещё кем-то используется
  // (узел в чужом пути, путь в чужом отношении), сервер молча оставляет, а не отклоняет весь пакет
  const del = edits.filter((e) => e.deleted).sort((x, y) => rank[y.element.type] - rank[x.element.type])
    .map(({ element: e }) => `<${e.type} id="${e.id}" version="${e.version}" changeset="${changeset}"/>`).join('');
  return `<osmChange version="0.6" generator="${GENERATOR}">${create ? `<create>${create}</create>` : ''}${
    modify ? `<modify>${modify}</modify>` : ''}${del ? `<delete if-unused="true">${del}</delete>` : ''}</osmChange>`;
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
 * Загрузка правок одним changeset. Сначала читаем текущие версии с сервера и переносим правки на них:
 * данные для показа (Overpass) без версий и могут отставать. Если те же теги успел изменить
 * кто-то ещё — ConflictError, ничего не отправляется.
 */
export async function uploadEdits(edits: TagEdit[], comment: string, onStatus: (s: string) => void = () => {}): Promise<UploadResult> {
  onStatus('Получаем текущие версии объектов…');
  const fresh = await fetchElements(edits.filter((e) => !e.created).map((e) => e.key));
  const conflicts: { key: string; tags: string[] }[] = [];
  const payload: Parameters<typeof buildOsmChange>[0] = [];
  const written = new Map<string, Tags>();
  const rebased = new Set<string>();
  const geometrySaved = new Set<string>();
  // Узлы: двигаем, только если на сервере они там же, где были у нас (иначе — конфликт)
  const moves = edits.flatMap((e) => (e.nodeMoves ?? []).map((m) => ({ ...m, key: e.key })));
  const nodes = moves.length ? await fetchNodes([...new Set(moves.map((m) => m.id))]) : new Map();
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-7;
  for (const m of moves) {
    const n = nodes.get(m.id);
    if (!n) { conflicts.push({ key: m.key, tags: [`узел ${m.id} удалён на сервере`] }); continue; }
    if (!near(n.lon, m.from[0]) || !near(n.lat, m.from[1])) { conflicts.push({ key: m.key, tags: [`узел ${m.id} уже сдвинут`] }); continue; }
    payload.push({ element: { ...n, lon: m.to[0], lat: m.to[1] }, tags: n.tags ?? {} });
    geometrySaved.add(m.key);
  }
  // Новые узлы — первыми в <create>: на них ссылаются пути того же changeset
  const created = new Set<number>();
  for (const e of edits) {
    for (const n of e.newNodes ?? []) {
      if (created.has(n.id)) continue;
      created.add(n.id);
      payload.push({ element: { type: 'node', id: n.id, version: 0, lon: n.at[0], lat: n.at[1] }, tags: {}, created: true });
    }
  }
  // Узлы удаляемых путей: без тегов и не нужные нашим же новым и изменённым путям
  const deletedWays = edits.filter((e) => e.deleted && e.key.startsWith('way/')).map((e) => fresh.get(e.key)).filter((w): w is OsmWay => w?.type === 'way');
  const keepNodes = new Set(edits.filter((e) => !e.deleted).flatMap((e) => e.wayNodes?.after ?? []));
  const dropIds = [...new Set(deletedWays.flatMap((w) => w.nodes))].filter((id) => !keepNodes.has(id));
  const dropNodes = dropIds.length ? await fetchNodes(dropIds) : new Map();
  const deleted = new Set<string>();
  for (const edit of edits) {
    if (edit.deleted) {
      const f = fresh.get(edit.key);
      if (!f) continue; // уже удалён на сервере
      const r = rebase({ ...edit, after: edit.before }, f);
      if ('conflict' in r || !sameTags(f.tags ?? {}, edit.before)) { conflicts.push({ key: edit.key, tags: ['объект изменён на сервере после загрузки'] }); continue; }
      payload.push({ element: f, tags: {}, deleted: true });
      deleted.add(edit.key);
      continue;
    }
    if (edit.created) {
      const element = edit.created.type === 'way'
        ? { ...edit.created, nodes: edit.wayNodes?.after ?? edit.created.nodes }
        : { ...edit.created, members: edit.members ?? edit.created.members };
      payload.push({ element, tags: edit.after, created: true });
      written.set(edit.key, edit.after);
      continue;
    }
    const f = fresh.get(edit.key);
    if (!f) { conflicts.push({ key: edit.key, tags: ['объект удалён на сервере'] }); continue; }
    const r = rebase(edit, f);
    if ('conflict' in r) { conflicts.push({ key: edit.key, tags: r.conflict }); continue; }
    // Список узлов пути: на сервере он должен быть таким, с какого начиналась правка
    let element: OsmWay | OsmRelation = f;
    if (edit.wayNodes && f.type === 'way') {
      const same = f.nodes.length === edit.wayNodes.before.length && f.nodes.every((id, i) => id === edit.wayNodes!.before[i]);
      if (!same) { conflicts.push({ key: edit.key, tags: ['список узлов изменён на сервере'] }); continue; }
      element = { ...f, nodes: edit.wayNodes.after };
    }
    // Сдвинуты только узлы — сам путь не трогаем
    if (sameTags(r.tags, f.tags ?? {}) && !edit.members && !edit.wayNodes) continue;
    if (edit.members && f.type === 'relation') element = { ...f, members: mergeMembers(f.members, edit.membersBefore ?? [], edit.members) };
    payload.push({ element, tags: r.tags });
    written.set(edit.key, r.tags);
    if (!sameTags(r.tags, edit.after)) rebased.add(edit.key);
  }
  for (const n of dropNodes.values()) if (!Object.keys(n.tags ?? {}).length) payload.push({ element: n, tags: {}, deleted: true });
  if (conflicts.length) throw new ConflictError(conflicts);

  onStatus('Открываем changeset…');
  const changesetXml = `<osm><changeset>${tagsXml({
    comment,
    created_by: GENERATOR,
    hashtags: '#simple3d',
  })}</changeset></osm>`;
  const changeset = Number(await call('PUT', '/changeset/create', changesetXml));
  try {
    onStatus(`Загружаем ${payload.length} объектов в changeset ${changeset}…`);
    const diff = parseDiffResult(await call('POST', `/changeset/${changeset}/upload`, buildOsmChange(payload, changeset), 'application/xml'));
    return { changeset, ...diff, written, rebased, geometrySaved, deleted };
  } finally {
    // Закрываем и при ошибке, чтобы не висел пустой changeset
    try { await call('PUT', `/changeset/${changeset}/close`); } catch { /* закроется сам через час */ }
  }
}

/**
 * Переносит нашу правку состава (что добавили и что убрали) на актуальный список членов с сервера:
 * параллельные чужие изменения состава и члены-точки, которых мы не показываем, сохраняются.
 */
function mergeMembers(server: OsmMember[], before: OsmMember[], after: OsmMember[]): OsmMember[] {
  const id = (m: OsmMember) => `${m.type}/${m.ref}/${m.role}`;
  const was = new Set(before.map(id)), now = new Set(after.map(id));
  const removed = before.filter((m) => !now.has(id(m)));
  // Роль '?' (из старого кеша) — совпадение только по type/ref
  const isRemoved = (m: OsmMember) => removed.some((r) => r.type === m.type && r.ref === m.ref && (r.role === '?' || r.role === m.role));
  const kept = server.filter((m) => !isRemoved(m));
  const have = new Set(kept.map(id));
  return [...kept, ...after.filter((m) => !was.has(id(m)) && !have.has(id(m)))];
}

function sameTags(a: Tags, b: Tags): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

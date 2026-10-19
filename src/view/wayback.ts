/**
 * Esri World Imagery Wayback — архив выпусков снимков Esri (с 2014 г.), как в iD OpenHistoricalMap:
 * список выпусков — из группы ArcGIS, выпуск подложки выбирается по дате слайдера времени.
 * Дата выпуска — дата публикации архива, а не съёмки: в выпуске могут быть и более старые снимки.
 */
import { WAYBACK } from './basemaps';

const GROUP_URL = 'https://www.arcgis.com/sharing/rest/content/groups/0f3189e1d1414edfad860b697b7d8311?f=json';

export interface WaybackRelease { date: string; /** Десятичный год даты выпуска. */ t: number; tiles: string }

let releases: Promise<WaybackRelease[]> | undefined;

/** Выпуски по возрастанию даты; ошибка сети — пустой список (повторим при следующей смене даты). */
export function waybackReleases(): Promise<WaybackRelease[]> {
  releases ??= fetch(GROUP_URL).then((r) => r.json()).then((g: { items?: { type: string; title: string; url: string }[] }) => {
    const out: WaybackRelease[] = [];
    for (const it of g.items ?? []) {
      const m = it.type === 'WMTS' && it.title.match(/\(Wayback (\d{4})-(\d\d)-(\d\d)\)/);
      // Пара выпусков — без шаблона тайлов в адресе (ссылка на сервис целиком): их пропускаем
      if (!m || !it.url.includes('{level}')) continue;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const days = Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1);
      out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, t: y + (Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / days,
        tiles: it.url.replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}') });
    }
    if (!out.length) throw new Error('wayback: пустой список выпусков');
    return out.sort((a, b) => a.t - b.t);
  }).catch(() => { releases = undefined; return []; });
  return releases;
}

/** Последний выпуск до конца периода (to — десятичный год); раньше первого выпуска — первый. */
export function pickRelease(list: WaybackRelease[], to: number): WaybackRelease | undefined {
  let best = list[0];
  for (const r of list) if (r.t < to) best = r;
  return best;
}

/** Показать в подложке Wayback этот выпуск; true — выпуск сменился. */
export function setWaybackRelease(r: WaybackRelease): boolean {
  if (WAYBACK.tiles[0] === r.tiles) return false;
  WAYBACK.tiles = [r.tiles];
  WAYBACK.release = r.date;
  return true;
}

import type { StyleSpecification } from 'maplibre-gl';

/**
 * Серверы на движке openstreetmap-website (API 0.6, OAuth2): тестовый и боевой OSM, OpenGeofiction, OpenHistoricalMap.
 * Данные для редактирования берутся с того же сервера, куда идёт запись.
 */
export type ServerId = 'dev' | 'prod' | 'ogf' | 'ohm';

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles/liberty';

export interface OsmServer {
  id: ServerId;
  label: string;
  /** Название проекта для сообщений и кнопок («Сохранить в …», «Сервер … не отвечает»). */
  short: string;
  /** Сайт: OAuth и ссылки на объекты. */
  web: string;
  /** API 0.6. */
  api: string;
  /** client_id OAuth-приложения, зарегистрированного на этом сервере. */
  clientId: string;
  /** Подложка: адрес стиля или стиль. */
  style: string | StyleSpecification;
  /** Здания из векторных тайлов в схеме OpenMapTiles (источник openmaptiles). */
  tileBuildings: boolean;
  /**
   * Кодировка id фич тайлов: openfreemap — id·10 + тип (1 узел, 2 линия, 3 отношение; 0 — склеенные здания);
   * openmaptiles (imposm, как у OGF) — id·10 + 0 у линий, + 1 у отношений, склеенных нет.
   */
  tileIds?: 'openfreemap' | 'openmaptiles';
  /** Не отправлять Referer: сервер подложки режет картинки (спрайт) с чужих сайтов (OGF). */
  noReferrer?: boolean;
}

export const SERVERS: Record<ServerId, OsmServer> = {
  dev: {
    id: 'dev',
    label: 'OpenStreetMap (Dev)',
    short: 'OpenStreetMap (тестовый)',
    web: 'https://master.apis.dev.openstreetmap.org',
    api: 'https://master.apis.dev.openstreetmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OSM_DEV_CLIENT_ID ?? '',
    style: OPENFREEMAP,
    tileBuildings: true,
  },
  prod: {
    id: 'prod',
    label: 'OpenStreetMap',
    short: 'OpenStreetMap',
    web: 'https://www.openstreetmap.org',
    api: 'https://api.openstreetmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OSM_CLIENT_ID ?? '',
    style: OPENFREEMAP,
    tileBuildings: true,
  },
  ogf: {
    id: 'ogf',
    label: 'OpenGeofiction',
    short: 'OpenGeofiction',
    web: 'https://opengeofiction.net',
    api: 'https://opengeofiction.net/api/0.6',
    clientId: import.meta.env?.VITE_OGF_CLIENT_ID ?? '',
    // Векторный стиль OGF в схеме OpenMapTiles (источник тоже openmaptiles) — тайловые здания как у OSM
    style: 'https://ogfvector.infinatio.us/styles/OGFBright/style.json',
    tileBuildings: true,
    tileIds: 'openmaptiles',
    noReferrer: true,
  },
  ohm: {
    id: 'ohm',
    label: 'OpenHistoricalMap',
    short: 'OpenHistoricalMap',
    web: 'https://www.openhistoricalmap.org',
    api: 'https://www.openhistoricalmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OHM_CLIENT_ID ?? '',
    style: 'https://www.openhistoricalmap.org/map-styles/main/main.json',
    tileBuildings: false,
  },
};

/** Переменная .env с client_id сервера. */
export const CLIENT_ID_ENV: Record<ServerId, string> = {
  dev: 'VITE_OSM_DEV_CLIENT_ID', prod: 'VITE_OSM_CLIENT_ID', ogf: 'VITE_OGF_CLIENT_ID', ohm: 'VITE_OHM_CLIENT_ID',
};

/** Серверы в списке выбора, по порядку; тестовый OSM — только в dev-сборке (на GitHub Pages его нет). */
export const SERVER_LIST: OsmServer[] = [SERVERS.prod, ...(import.meta.env?.DEV ? [SERVERS.dev] : []), SERVERS.ohm, SERVERS.ogf];

/** Параметр адреса ?server= (у тестового OSM его нет — сервер только для разработки). */
const URL_IDS: Partial<Record<ServerId, string>> = { prod: 'osm', ohm: 'ohm', ogf: 'ogf' };

/**
 * Сервер при загрузке — из адреса (?server=osm|ohm|ogf). Старые ссылки (без параметра) и неизвестное значение —
 * OpenStreetMap; выбор из localStorage не подставляем: ссылка должна открываться у всех одинаково.
 * Тестовый OSM (только dev-сборка) — по пометке в адресе не открывается, лишь выбором в списке.
 */
function load(): ServerId {
  const q = new URLSearchParams(location.search).get('server');
  return (Object.keys(URL_IDS) as ServerId[]).find((id) => URL_IDS[id] === q) ?? 'prod';
}

/** Записать сервер в адрес (replaceState, без перезагрузки). */
export function writeServerParam(id: ServerId = current.id) {
  const url = new URL(location.href);
  const v = URL_IDS[id];
  if (v) url.searchParams.set('server', v); else url.searchParams.delete('server');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

let current: OsmServer = SERVERS[load()];
writeServerParam();

export const server = (): OsmServer => current;

export function setServer(id: ServerId) {
  current = SERVERS[id];
  writeServerParam(id);
}

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
  /** Короткое имя для кнопок («Сохранить в …»). */
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
}

export const SERVERS: Record<ServerId, OsmServer> = {
  dev: {
    id: 'dev',
    label: 'OSM тестовый (master.apis.dev)',
    short: 'OSM (тест)',
    web: 'https://master.apis.dev.openstreetmap.org',
    api: 'https://master.apis.dev.openstreetmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OSM_DEV_CLIENT_ID ?? '',
    style: OPENFREEMAP,
    tileBuildings: true,
  },
  prod: {
    id: 'prod',
    label: 'OSM боевой (openstreetmap.org)',
    short: 'OSM',
    web: 'https://www.openstreetmap.org',
    api: 'https://api.openstreetmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OSM_CLIENT_ID ?? '',
    style: OPENFREEMAP,
    tileBuildings: true,
  },
  ogf: {
    id: 'ogf',
    label: 'OpenGeofiction (opengeofiction.net)',
    short: 'OGF',
    web: 'https://opengeofiction.net',
    api: 'https://opengeofiction.net/api/0.6',
    clientId: import.meta.env?.VITE_OGF_CLIENT_ID ?? '',
    // Векторный стиль OGF в схеме OpenMapTiles (источник тоже openmaptiles) — тайловые здания как у OSM
    style: 'https://ogfvector.infinatio.us/styles/OGFBright/style.json',
    tileBuildings: true,
  },
  ohm: {
    id: 'ohm',
    label: 'OpenHistoricalMap (openhistoricalmap.org)',
    short: 'OHM',
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

const STORAGE_KEY = 'osm3d.server';

function load(): ServerId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && v in SERVERS) return v as ServerId;
  } catch { /* хранилище недоступно */ }
  return 'prod';
}

let current: OsmServer = SERVERS[load()];

export const server = (): OsmServer => current;

export function setServer(id: ServerId) {
  current = SERVERS[id];
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* не критично */ }
}

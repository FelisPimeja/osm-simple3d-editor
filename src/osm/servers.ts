/** Серверы OSM: тестовый (dev) и боевой. Данные для редактирования берутся с того же сервера, куда идёт запись. */
export type ServerId = 'dev' | 'prod';

export interface OsmServer {
  id: ServerId;
  label: string;
  /** Сайт: OAuth и ссылки на объекты. */
  web: string;
  /** API 0.6. */
  api: string;
  /** client_id OAuth-приложения, зарегистрированного на этом сервере. */
  clientId: string;
}

export const SERVERS: Record<ServerId, OsmServer> = {
  dev: {
    id: 'dev',
    label: 'тестовый (master.apis.dev)',
    web: 'https://master.apis.dev.openstreetmap.org',
    api: 'https://master.apis.dev.openstreetmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OSM_DEV_CLIENT_ID ?? '',
  },
  prod: {
    id: 'prod',
    label: 'боевой (openstreetmap.org)',
    web: 'https://www.openstreetmap.org',
    api: 'https://api.openstreetmap.org/api/0.6',
    clientId: import.meta.env?.VITE_OSM_CLIENT_ID ?? '',
  },
};

const STORAGE_KEY = 'osm3d.server';

function load(): ServerId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dev' || v === 'prod') return v;
  } catch { /* хранилище недоступно */ }
  return 'dev';
}

let current: OsmServer = SERVERS[load()];

export const server = (): OsmServer => current;

export function setServer(id: ServerId) {
  current = SERVERS[id];
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* не критично */ }
}

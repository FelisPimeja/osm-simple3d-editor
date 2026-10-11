/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSM_CLIENT_ID?: string;
  readonly VITE_OSM_DEV_CLIENT_ID?: string;
  readonly VITE_OGF_CLIENT_ID?: string;
  readonly VITE_OHM_CLIENT_ID?: string;
  /** Публичный токен Mapbox (pk.…) — подложка Mapbox Satellite; без него её нет в списке. */
  readonly VITE_MAPBOX_TOKEN?: string;
}

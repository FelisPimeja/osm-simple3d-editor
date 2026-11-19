/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSM_CLIENT_ID?: string;
  readonly VITE_OSM_DEV_CLIENT_ID?: string;
  readonly VITE_OGF_CLIENT_ID?: string;
  readonly VITE_OHM_CLIENT_ID?: string;
  /** Публичный токен Mapbox (pk.…) — подложка Mapbox Satellite; без него её нет в списке. */
  readonly VITE_MAPBOX_TOKEN?: string;
  /** Клиентский токен Mapillary (MLY|…) — слой уличных фото Mapillary; без него его нет в списке. */
  readonly VITE_MAPILLARY_TOKEN?: string;
  readonly VITE_FOTOSHI_TOKEN?: string;
  /** Fine-grained PAT GitHub только с Issues: write — автоматические отчёты об ошибках отправки; без него их нет. */
  readonly VITE_REPORT_TOKEN?: string;
  /** Репозиторий для отчётов (owner/name); по умолчанию — репозиторий редактора. */
  readonly VITE_REPORT_REPO?: string;
  readonly VITE_GIT_SHA?: string;
}

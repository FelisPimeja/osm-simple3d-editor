import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

/**
 * MapLibre 6 создаёт воркер по адресу `./maplibre-gl-worker.mjs` рядом со своим модулем (import.meta.url),
 * поэтому Vite его не видит и в сборку не кладёт: локально работает (файл в node_modules), на Pages — 404.
 * Кладём воркер и его зависимость maplibre-gl-shared.mjs в dist/maplibre/ под исходными именами
 * (воркер импортирует shared относительным путём), а адрес задаём через maplibregl.setWorkerUrl в main.ts.
 */
function maplibreWorker(): Plugin {
  const dist = dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')) + '/dist';
  return {
    name: 'maplibre-worker',
    apply: 'build',
    generateBundle() {
      for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
        this.emitFile({ type: 'asset', fileName: `maplibre/${name}`, source: readFileSync(join(dist, name)) });
      }
    },
  };
}

/**
 * Номер сборки: в код (__BUILD__) и в dist/version.json. Ярлык на рабочем столе iPhone держит свой кеш index.html
 * и не подтягивает новую версию даже после перезапуска — main.ts сверяет version.json (в обход кеша) и перезагружается.
 */
const BUILD = String(Date.now());
function buildVersion(): Plugin {
  return {
    name: 'build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
    },
  };
}

// base: './' — чтобы сборка работала из подпапки на GitHub Pages.
// maplibre-gl исключён из pre-bundling: иначе ломается загрузка его web worker.
// oauth.html — страница возврата из OAuth (redirect_uri), отдельная точка входа сборки.
// HTTPS=1 (npm run dev:https) — dev-сервер по https с самоподписанным сертификатом: OpenGeofiction
// принимает только https-адреса возврата OAuth (https://localhost:5173/oauth.html). Кеш зависимостей у него
// свой: конфиги различаются, и общий кеш пересобирался при каждом запуске другого сервера (504 Outdated Optimize Dep).
export default defineConfig({
  base: './',
  cacheDir: process.env.HTTPS ? 'node_modules/.vite-https' : 'node_modules/.vite',
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // Только dev-сервер: разрешить JS Self-Profiling API (new Profiler) для замеров производительности в браузере
  server: { headers: { 'Document-Policy': 'js-profiling' } },
  build: { rollupOptions: { input: { main: 'index.html', oauth: 'oauth.html' } } },
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [maplibreWorker(), buildVersion(), ...(process.env.HTTPS ? [basicSsl()] : [])],
});

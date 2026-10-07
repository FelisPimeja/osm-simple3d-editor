import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

// base: './' — чтобы сборка работала из подпапки на GitHub Pages.
// maplibre-gl исключён из pre-bundling: иначе ломается загрузка его web worker.
// oauth.html — страница возврата из OAuth (redirect_uri), отдельная точка входа сборки.
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: { rollupOptions: { input: { main: 'index.html', oauth: 'oauth.html' } } },
  plugins: [maplibreWorker()],
});

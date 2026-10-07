import { defineConfig } from 'vite';

// base: './' — чтобы сборка работала из подпапки на GitHub Pages.
// maplibre-gl исключён из pre-bundling: иначе ломается загрузка его web worker.
// oauth.html — страница возврата из OAuth (redirect_uri), отдельная точка входа сборки.
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: { rollupOptions: { input: { main: 'index.html', oauth: 'oauth.html' } } },
});

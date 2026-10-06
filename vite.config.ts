import { defineConfig } from 'vite';

// base: './' — чтобы сборка работала из подпапки на GitHub Pages.
// maplibre-gl исключён из pre-bundling: иначе ломается загрузка его web worker.
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['maplibre-gl'] },
});

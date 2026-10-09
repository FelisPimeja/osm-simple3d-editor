/**
 * Курсоры карты: по умолчанию — обычная стрелка (вместо руки MapLibre), у инструментов режима здания —
 * стрелка со значком инструмента в углу. Картинки — SVG в data URI, собираются один раз.
 */
export type ToolCursor = 'move' | 'push' | 'split' | 'rect' | 'polygon' | 'measure' | 'paint' | 'pick' | 'offset';

/** Значки инструментов (viewBox 0 0 20 20, линии), как на кнопках панели. */
const ICONS: Record<ToolCursor, string> = {
  move: '<path d="M10 2v16M2 10h16M10 2L7.5 4.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5"/>',
  push: '<path d="M3 13l7 3.5 7-3.5-7-3.5z"/><path d="M10 9.5V2.5M7.5 5L10 2.5 12.5 5"/>',
  split: '<path d="M3 5h14v10H3z"/><path d="M8 3.5l4 13" stroke-dasharray="2 1.6"/>',
  rect: '<path d="M3.5 6h13v8h-13z"/>',
  polygon: '<path d="M4 15l-1-7 6-5 8 4-2 8z"/>',
  offset: '<path d="M2.5 2.5h15v15h-15z" stroke-dasharray="2.2 1.8"/><path d="M6.5 6.5h7v7h-7z"/>',
  measure: '<path d="M2.5 13.5l11-11 4 4-11 11z"/><path d="M6 10l1.5 1.5M8.5 7.5l1.5 1.5M11 5l1.5 1.5"/>',
  paint: '<path d="M4 7h10l-1.5 9h-7z"/><path d="M4.6 10.5h8.8l-.9 5.5h-7z" fill="currentColor" fill-opacity=".35" stroke="none"/><path d="M5.5 7a3.5 3.5 0 0 1 7 0"/><path d="M14 7.5c1.8.2 2.8 1.4 3 3"/><path d="M17 13s1.2 1.5 1.2 2.3a1.2 1.2 0 0 1-2.4 0c0-.8 1.2-2.3 1.2-2.3z" fill="currentColor"/>',
  pick: '<path d="M13 3.2a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L15 8.8 11.2 5z" fill="currentColor"/><path d="M10.4 5.8l3.8 3.8"/><path d="M12.6 8 5.4 15.2a1.6 1.6 0 0 1-.9.4l-1.6.3.3-1.6c.1-.3.2-.6.4-.9L10.8 6.2"/>',
};

/** Стрелка (остриё в 1,1) и значок на белой плашке справа снизу. */
function cursorUrl(icon: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <path d="M1 1v15l4-3.6 2.6 6 2.4-1-2.6-6H13z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
    <rect x="13" y="13" width="18" height="18" rx="4" fill="#fff" stroke="#9ca3af" stroke-width="1"/>
    <g transform="translate(15 15) scale(.7)" fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" color="#111">${icon}</g>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 1 1, default`;
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  const css = [
    // Стрелка везде над картой; рука MapLibre — только пока тащат карту
    '#map .maplibregl-canvas-container.maplibregl-interactive, #map .maplibregl-canvas-container canvas { cursor: default; }',
    '#map .maplibregl-canvas-container.maplibregl-interactive:active { cursor: grabbing; }',
    ...Object.entries(ICONS).map(([k, icon]) =>
      `#map .maplibregl-canvas-container.tool-${k}, #map .maplibregl-canvas-container.tool-${k} canvas { cursor: ${cursorUrl(icon)}; }`),
  ].join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

/** Курсор инструмента над картой (undefined — обычная стрелка). */
export function setToolCursor(container: HTMLElement, tool: ToolCursor | undefined) {
  install();
  for (const k of Object.keys(ICONS)) container.classList.toggle(`tool-${k}`, k === tool);
}

install();

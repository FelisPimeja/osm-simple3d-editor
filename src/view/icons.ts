/** Icons for UI controls, instead of Unicode symbols whose size and weight depend on the font. */
const PATHS = {
  close: '<path d="M5.500 5.500l9 9M14.500 5.500l-9 9"/>',
  move: '<path d="M10 2.500v15M2.500 10h15M7.500 5L10 2.500 12.500 5M7.500 15L10 17.500 12.500 15M5 7.500L2.500 10 5 12.500M15 7.500l2.500 2.500-2.500 2.500"/>',
  help: '<circle cx="10" cy="10" r="7.500"/><path d="M7.900 7.800a2.200 2.200 0 1 1 3.300 1.900c-.8.500-1.200 1-1.200 1.800"/><path d="M10 14.200h.01" stroke-width="2"/>',
  error: '<circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M6.900 6.900l6.200 6.200M13.100 6.900l-6.200 6.200" stroke="#fff" stroke-width="1.8"/>',
  warning: '<path d="M10 2.600l8 14H2z" fill="currentColor"/><path d="M10 8v4M10 14.400h.01" stroke="#fff" stroke-width="1.8"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16): string {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

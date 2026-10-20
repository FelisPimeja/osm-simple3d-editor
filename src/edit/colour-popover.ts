/**
 * Окно выбора цвета у цветового поля в свойствах (вместо системного по клику на плашку): пипетка — универсальная
 * (src/edit/eyedropper.ts: здание, спутниковая подложка, фото панорамы), последние использованные цвета
 * (src/edit/recent-colours.ts) и «Другой цвет…» — системный выбор. Системную пипетку подменить нельзя (она — часть браузера и ОС), поэтому окно своё.
 */
import { tr } from '../i18n';
import { recentColours } from './recent-colours';

const EYEDROPPER_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">'
  + '<path d="M13 3.2a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L15 8.8 11.2 5z" fill="currentColor"/><path d="M10.4 5.8l3.8 3.8"/>'
  + '<path d="M12.6 8 5.4 15.2a1.6 1.6 0 0 1-.9.4l-1.6.3.3-1.6c.1-.3.2-.6.4-.9L10.8 6.2"/></svg>';

export interface ColourPopoverHooks {
  /** Выбран цвет (из последних: имя или #rrggbb, как записали в тег). */
  pick(colour: string): void;
  /** Нажата пипетка. */
  eyedropper(): void;
}

let open: { el: HTMLElement; close: () => void } | undefined;

function closeColourPopover() {
  open?.close();
}

/** Открыть окно под плашкой; picker — системный выбор (input type=color) для «Другой цвет…». */
export function openColourPopover(anchor: HTMLElement, picker: HTMLInputElement, hooks: ColourPopoverHooks) {
  closeColourPopover();
  const el = document.createElement('div');
  el.className = 'colour-popover';
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'colour-popover-eye';
  eye.innerHTML = `${EYEDROPPER_SVG}<span>${tr('Пипетка')}</span>`;
  eye.title = tr('Взять цвет со здания, спутниковой подложки или фото панорамы');
  eye.addEventListener('click', () => { close(); hooks.eyedropper(); });
  const grid = document.createElement('div');
  grid.className = 'colour-popover-grid';
  const recent = recentColours();
  for (const c of recent) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => { close(); hooks.pick(c); });
    grid.append(b);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'colour-popover-more';
  more.textContent = tr('Другой цвет…');
  more.addEventListener('click', () => {
    close();
    try { picker.showPicker(); } catch { /* без поддержки showPicker — ничего */ }
  });
  const empty = document.createElement('div');
  empty.className = 'colour-popover-empty';
  empty.textContent = tr('Здесь появятся последние использованные цвета');
  el.append(eye, recent.length ? grid : empty, more);
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + 4 + h > innerHeight ? r.top - 4 - h : r.bottom + 4}px`;
  const outside = (e: Event) => { if (!el.contains(e.target as Node) && e.target !== anchor) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    el.remove();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', esc, true);
    if (open?.el === el) open = undefined;
  }
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', esc, true);
  open = { el, close };
}

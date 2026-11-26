/**
 * Плавающее окно плагина (src/plugins.ts, api.openPanel): заголовок с крестиком, тело — плагину.
 * Вид — как у окна уличных фото; окно двигается за заголовок, размер меняется углом (CSS resize).
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { PluginPanel } from '../plugins';
import { icon } from './icons';
import { tr } from '../i18n';

export function openPanel(title: string, _map: MlMap): PluginPanel {
  const el = document.createElement('div');
  el.className = 'panoramax-viewer plugin-panel';
  const head = document.createElement('header');
  head.className = 'panel-head panoramax-head';
  const h = document.createElement('h1');
  h.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panoramax-close';
  close.innerHTML = icon('close', 16);
  close.title = tr('Закрыть');
  head.append(h, close);
  const body = document.createElement('div');
  body.className = 'plugin-panel-body';
  el.append(head, body);
  document.body.append(el);
  const closers: (() => void)[] = [];
  let closed = false;
  const panel: PluginPanel = {
    body,
    setTitle: (t) => { h.textContent = t; },
    close: () => {
      if (closed) return;
      closed = true;
      el.remove();
      for (const cb of closers) { try { cb(); } catch (err) { console.warn('plugin panel:', err); } }
    },
    onClose: (cb) => { closers.push(cb); },
  };
  close.addEventListener('click', () => panel.close());
  // Перетаскивание за заголовок
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx))}px`;
      el.style.top = `${Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy))}px`;
      el.style.bottom = 'auto';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  return panel;
}

/** One shared photo window for built-in services and panorama plugins. */
import type { Map as MlMap } from 'maplibre-gl';
import type { PluginPanel } from '../plugins';
import { icon } from './icons';
import { tr } from '../i18n';
import { PhotoPanelLayout } from './photo-panel-layout';

class PhotoWindow {
  private readonly el = document.createElement('div');
  private readonly title = document.createElement('h1');
  private readonly body = document.createElement('div');
  private readonly layout: PhotoPanelLayout;
  private current?: PluginPanel;

  constructor() {
    this.el.className = 'panoramax-viewer';
    this.el.hidden = true;
    const head = document.createElement('header');
    head.className = 'panel-head panoramax-head';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panoramax-close';
    close.innerHTML = icon('close', 16);
    close.title = tr('Закрыть');
    close.addEventListener('click', () => this.current?.close());
    head.append(this.title, close);
    this.body.className = 'plugin-panel-body';
    this.el.append(head, this.body);
    document.body.append(this.el);
    this.layout = new PhotoPanelLayout(this.el, head);
  }

  open(title: string): PluginPanel {
    this.current?.close();
    this.title.textContent = title;
    this.body.replaceChildren();
    this.el.hidden = false;
    this.layout.place();
    // Each owner gets its own body; late work from a replaced viewer stays detached.
    const body = document.createElement('div');
    body.className = 'plugin-panel-body';
    body.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column';
    this.body.append(body);
    const closers: (() => void)[] = [];
    let closed = false;
    const panel: PluginPanel = {
      body,
      setTitle: value => { if (!closed) this.title.textContent = value; },
      close: () => {
        if (closed) return;
        closed = true;
        if (this.current === panel) { this.current = undefined; this.el.hidden = true; }
        body.remove();
        for (const cb of closers) { try { cb(); } catch (error) { console.warn('photo window:', error); } }
      },
      onClose: cb => { closers.push(cb); },
    };
    this.current = panel;
    return panel;
  }
}

let photoWindow: PhotoWindow | undefined;
export function openPanel(title: string, _map: MlMap): PluginPanel {
  return (photoWindow ??= new PhotoWindow()).open(title);
}

/**
 * Вкладка «Плагины» панели настроек: официальный список (галки) и свои плагины по ссылке на GitHub.
 * Подключение и отключение — сразу, без перезагрузки (src/plugins.ts).
 */
import { addCustom, CATALOG, enableCatalog, pluginEntries, removePlugin, type PluginManifest } from '../plugins';
import { tr } from '../i18n';

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function about(m: PluginManifest): HTMLElement {
  const box = el('div', 'plugin-about');
  if (m.description) box.append(el('div', 'hint', m.description));
  if (m.homepage) {
    const a = el('a', 'plugin-home', m.homepage.replace(/^https:\/\//, '')) as HTMLAnchorElement;
    a.href = m.homepage;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
  }
  return box;
}

let error = '';
let busy = false;

export function renderPluginsPane() {
  const pane = document.getElementById('pane-plugins');
  if (!pane) return;
  const entries = pluginEntries();
  const on = new Set(entries.map((e) => e.manifest.id));
  pane.replaceChildren();
  pane.append(el('p', 'hint panel-note', tr('Плагины добавляют подложки и источники данных вне ядра редактора. Подключаются сразу; выбор сохраняется в профиле.')));

  pane.append(el('h2', 'panel-sec', tr('Официальные')));
  for (const m of CATALOG) {
    const row = el('label', 'toggle plugin-row') as HTMLLabelElement;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = on.has(m.id);
    input.addEventListener('change', () => { enableCatalog(m.id, input.checked); renderPluginsPane(); });
    row.append(input, ` ${m.name}`);
    if (m.version) row.append(el('span', 'hint', ` ${m.version}`));
    pane.append(row, about(m));
  }

  pane.append(el('h2', 'panel-sec', tr('Свои')));
  const custom = entries.filter((e) => e.source !== 'catalog');
  for (const e of custom) {
    const row = el('div', 'plugin-row plugin-custom');
    const name = el('span', '', e.manifest.name);
    name.title = e.source;
    const del = el('button', 'link-btn', tr('Отключить')) as HTMLButtonElement;
    del.type = 'button';
    del.addEventListener('click', () => { removePlugin(e.manifest.id); renderPluginsPane(); });
    row.append(name, e.manifest.version ? el('span', 'hint', ` ${e.manifest.version}`) : '', ' · ', del);
    pane.append(row, about(e.manifest));
  }
  const form = el('form', 'plugin-add') as HTMLFormElement;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'github.com/user/repo';
  input.spellcheck = false;
  input.disabled = busy;
  const btn = el('button', '', tr('Подключить')) as HTMLButtonElement;
  btn.type = 'submit';
  btn.disabled = busy;
  form.append(input, btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!input.value.trim() || busy) return;
    busy = true; error = '';
    const v = input.value;
    renderPluginsPane();
    try { await addCustom(v); } catch (err) { error = err instanceof Error ? err.message : String(err); }
    busy = false;
    renderPluginsPane();
    if (error) {
      const i = document.querySelector<HTMLInputElement>('#pane-plugins .plugin-add input');
      if (i) i.value = v;
    }
  });
  pane.append(form);
  if (error) pane.append(el('p', 'plugin-error', error));
  pane.append(el('p', 'hint', tr('Ссылка на репозиторий GitHub с файлом simple3d-plugin.json в корне (лучше с тегом: автор/репо@v1.0) или https-ссылка на манифест .json. Свои плагины — только данные (подложки), без кода: так они не получат доступа к вашему аккаунту OSM.')));
  const doc = el('a', 'plugin-home', tr('Как сделать плагин: формат и отправка в официальный список')) as HTMLAnchorElement;
  doc.href = 'https://github.com/FelisPimeja/osm-simple3d-editor/blob/main/docs/plugins.md';
  doc.target = '_blank';
  doc.rel = 'noopener noreferrer';
  pane.append(el('p', 'hint', '').appendChild(doc).parentElement!);
}

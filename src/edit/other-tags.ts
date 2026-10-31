import { tr } from '../i18n';
import { loadIdTags } from '../osm/presets';
import { placeCombo } from './combo-place';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let serial = 0;
const icon = (d: string) => `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
/** Exclude precisely the keys with a visible specialized widget. */
export function otherTagEntries(tags: Record<string, string>, form: string): [string,string][] {
  const named = new Set([...form.matchAll(/data-(?:indoor-)?tag="([^"]+)"/g)].map(m=>m[1]));
  return Object.entries(tags).filter(([k])=>!named.has(esc(k))).sort(([a],[b])=>a.localeCompare(b));
}
export function renderOtherTags(key: string, tags: Record<string,string>, form = '', indoor = false, mixed = new Set<string>()): string {
  const prefix = `other-tags-${++serial}`;
  const rows = otherTagEntries(tags, form).map(([k,v],i)=>`<div class="other-tag-row"><label for="${prefix}-${i}">${esc(k)}</label><input id="${prefix}-${i}" data-other-value="${esc(k)}" value="${esc(v)}"${mixed.has(k) ? ` class="mixed" placeholder="${esc(tr('разные значения'))}" title="${esc(tr('разные значения'))}"` : ''} autocomplete="off" aria-label="${esc(k)}"><button type="button" data-other-delete="${esc(k)}" title="${tr('Удалить тег')}" aria-label="${tr('Удалить тег')} ${esc(k)}">${icon('M2.5 2.5l7 7M9.5 2.5l-7 7')}</button></div>`).join('');
  return `<section class="other-tags" data-other-key="${esc(key)}"${indoor?' data-other-indoor':''}><h3>${tr('Другие теги')}</h3>${rows}<form class="other-tag-add"><input data-other-new-key placeholder="${tr('Ключ')}" aria-label="${tr('Ключ')}" autocomplete="off" required><input data-other-new-value placeholder="${tr('Значение')}" aria-label="${tr('Значение')}" autocomplete="off" required><button type="submit" title="${tr('Добавить тег')}" aria-label="${tr('Добавить тег')}">${icon('M6 1.5v9M1.5 6h9')}</button></form></section>`;
}
/** Сначала совпадения с начала строки, затем по вхождению; пустой запрос — весь список (для ключей не нужен). */
export function tagSuggestions(query: string, pool: string[], limit = 50): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return pool.slice(0, limit);
  const lower = (s: string) => s.toLowerCase();
  const hits = pool.filter(s => lower(s) !== q && lower(s).includes(q));
  return [...hits.filter(s => lower(s).startsWith(q)), ...hits.filter(s => !lower(s).startsWith(q))].slice(0, limit);
}
export function bindOtherTags(container: HTMLElement, read: (key:string, indoor:boolean)=>Record<string,string>|undefined,
  write: (key:string, tag:string, value:string|undefined, indoor:boolean)=>void) {
  const section = (el:Element)=>el.closest<HTMLElement>('[data-other-key]');
  const save = (box:HTMLElement, tag:string, value:string|undefined)=>write(box.dataset.otherKey!,tag,value,box.hasAttribute('data-other-indoor'));
  bindSuggestions(container, section, read);
  // Enter в строке добавления: с ключа — к значению, со значения — сохранить. Иначе общий Enter снимает фокус до отправки формы
  container.addEventListener('keydown', e=>{
    const el=e.target as HTMLInputElement, form=el.closest?.<HTMLFormElement>('.other-tag-add');
    if (!form || e.key!=='Enter' || e.isComposing || el.tagName!=='INPUT') return;
    e.preventDefault();
    if (el.hasAttribute('data-other-new-key')) form.querySelector<HTMLInputElement>('[data-other-new-value]')!.focus();
    else form.requestSubmit();
  });
  container.addEventListener('change', e=>{
    const el=e.target as HTMLInputElement, box=section(el);
    if (box && el.dataset.otherValue) save(box,el.dataset.otherValue,el.value.trim()||undefined);
  });
  container.addEventListener('keydown', e=>{
    const el=e.target as HTMLInputElement;
    if (!el.hasAttribute('data-other-value')) return;
    if (e.key==='Enter') {e.preventDefault();const box=section(el);if (box) save(box,el.dataset.otherValue!,el.value.trim()||undefined);el.blur();}
    if (e.key==='Escape') {e.preventDefault();const box=section(el)!;el.value=read(box.dataset.otherKey!,box.hasAttribute('data-other-indoor'))?.[el.dataset.otherValue!]??'';el.blur();}
  });
  container.addEventListener('mousedown',e=>{if ((e.target as Element).closest('[data-other-delete]')) e.preventDefault();});
  container.addEventListener('click',e=>{
    const btn=(e.target as Element).closest<HTMLElement>('[data-other-delete]'), box=btn&&section(btn);
    if (btn && box) {e.preventDefault();save(box,btn.dataset.otherDelete!,undefined);}
  });
  container.addEventListener('input',e=>{
    const el=e.target as HTMLInputElement;
    if (!el.hasAttribute('data-other-new-key')) return;
    el.setCustomValidity('');
  });
  container.addEventListener('submit',e=>{
    const form=e.target as HTMLFormElement;
    if (!form.matches('.other-tag-add')) return;
    e.preventDefault();
    const box=section(form)!, keyInput=form.querySelector<HTMLInputElement>('[data-other-new-key]')!, valueInput=form.querySelector<HTMLInputElement>('[data-other-new-value]')!;
    const key=keyInput.value.trim(), value=valueInput.value.trim();
    const tags=read(box.dataset.otherKey!,box.hasAttribute('data-other-indoor'));
    const error=!key || /[\s=]/.test(key) ? tr('Ключ не должен содержать пробелы или знак равенства.') : tags && Object.hasOwn(tags,key) ? tr('Такой тег уже существует. Измените его значение в панели свойств.') : '';
    keyInput.setCustomValidity(error);
    if (error) {keyInput.reportValidity();return;}
    if (value) save(box,key,value);
  });
}

function bindSuggestions(container: HTMLElement, section: (el: Element) => HTMLElement | null,
  read: (key: string, indoor: boolean) => Record<string, string> | undefined) {
  let tags: Record<string, string[]> | undefined, loading = false, active = -1, target: HTMLInputElement | undefined;
  let list: HTMLUListElement | undefined;
  const close = () => { list?.remove(); target = undefined; active = -1; };
  const createList = () => {
    const ul = document.createElement('ul');
    ul.className = 'combo-list';
    ul.addEventListener('mousedown', e => {
      e.preventDefault();
      const li = (e.target as Element).closest('li');
      if (li) pick(li.textContent!);
    });
    return ul;
  };
  const isTagInput = (el: EventTarget | null): el is HTMLInputElement => ['data-other-value', 'data-other-new-key', 'data-other-new-value'].some(a => (el as Element).hasAttribute?.(a));
  const show = (el: HTMLInputElement) => {
    if (!tags) {
      if (!loading) { loading = true; loadIdTags().then(t => { tags = t; if (document.activeElement === el) show(el); }).catch(() => { loading = false; }); }
      return;
    }
    const box = section(el)!, own = read(box.dataset.otherKey!, box.hasAttribute('data-other-indoor')) ?? {};
    const isKey = el.hasAttribute('data-other-new-key');
    const key = el.dataset.otherValue ?? el.closest('form')?.querySelector<HTMLInputElement>('[data-other-new-key]')?.value.trim() ?? '';
    const found = isKey ? (el.value.trim() ? tagSuggestions(el.value, Object.keys(tags).filter(k => !Object.hasOwn(own, k)), 12) : [])
      : tagSuggestions(el.value, Object.hasOwn(tags, key) ? tags[key] : []);
    if (!found.length) { close(); return; }
    list ??= createList();
    list.replaceChildren(...found.map(s => { const li = document.createElement('li'), b = document.createElement('b'); b.textContent = s; li.append(b); return li; }));
    target = el; active = -1;
    el.parentElement!.append(list);
    placeCombo(list);
  };
  const pick = (value: string) => {
    const el = target!;
    close();
    el.value = value;
    el.setCustomValidity('');
    if (el.hasAttribute('data-other-new-key')) el.closest('form')!.querySelector<HTMLInputElement>('[data-other-new-value]')!.focus();
    else if (el.hasAttribute('data-other-value')) { el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); }
  };
  container.addEventListener('focusin', e => { if (isTagInput(e.target) && !e.target.hasAttribute('data-other-new-key')) show(e.target); });
  container.addEventListener('input', e => { if (isTagInput(e.target)) show(e.target); });
  container.addEventListener('focusout', e => { if (e.target === target) close(); });
  // Раньше обработчиков формы: Enter и Escape открытого списка относятся к нему, а не к полю
  container.addEventListener('keydown', e => {
    if (!list || e.target !== target || !list.isConnected) return;
    const li = [...list.children] as HTMLElement[];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      li[active]?.classList.remove('active');
      active = e.key === 'ArrowDown' ? (active + 1) % li.length : (active <= 0 ? li.length : active) - 1;
      li[active].classList.add('active');
      li[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(li[active].textContent!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  });
}

/** Absence on even one object is a different value, not an omitted key. */
export function multiTagValues(objects: Record<string,string>[]) {
  const tags: Record<string,string> = {}, mixed = new Set<string>();
  for (const key of new Set(objects.flatMap(t => Object.keys(t)))) {
    const values = new Set(objects.map(t => t[key]));
    if (values.size > 1) mixed.add(key);
    tags[key] = values.size === 1 ? objects[0][key] : '';
  }
  return { tags, mixed };
}
export function renderMultiOtherTags(objects: Record<string,string>[], form: string, indoor = false): string {
  const { tags, mixed } = multiTagValues(objects);
  return renderOtherTags('@selection', tags, form, indoor, mixed);
}

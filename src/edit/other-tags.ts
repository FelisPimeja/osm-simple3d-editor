import { tr } from '../i18n';
import { idOptions, idTagKeys } from '../osm/presets';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let serial = 0;
/** Exclude precisely the keys with a visible specialized widget. */
export function otherTagEntries(tags: Record<string, string>, form: string): [string,string][] {
  const named = new Set([...form.matchAll(/data-(?:indoor-)?tag="([^"]+)"/g)].map(m=>m[1]));
  return Object.entries(tags).filter(([k])=>!named.has(esc(k))).sort(([a],[b])=>a.localeCompare(b));
}
export function renderOtherTags(key: string, tags: Record<string,string>, form = '', indoor = false, mixed = new Set<string>()): string {
  const prefix = `other-tags-${++serial}`;
  const list = (id: string, values: string[]) => `<datalist id="${id}">${values.map(v=>`<option value="${esc(v)}"></option>`).join('')}</datalist>`;
  const rows = otherTagEntries(tags, form).map(([k,v],i)=>`<div class="other-tag-row"><label for="${prefix}-${i}">${esc(k)}</label><input id="${prefix}-${i}" data-other-value="${esc(k)}" value="${esc(v)}"${mixed.has(k) ? ` class="mixed" placeholder="${esc(tr('разные значения'))}" title="${esc(tr('разные значения'))}"` : ''} list="${prefix}-values-${i}" aria-label="${esc(k)}">${list(`${prefix}-values-${i}`,idOptions(k)??[])}<button type="button" data-other-delete="${esc(k)}" title="${tr('Удалить тег')}" aria-label="${tr('Удалить тег')} ${esc(k)}">×</button></div>`).join('');
  return `<section class="other-tags" data-other-key="${esc(key)}"${indoor?' data-other-indoor':''}><h3>${tr('Другие теги')}</h3>${rows}<form class="other-tag-add"><input data-other-new-key placeholder="${tr('Ключ')}" aria-label="${tr('Ключ')}" list="${prefix}-keys" required><input data-other-new-value placeholder="${tr('Значение')}" aria-label="${tr('Значение')}" list="${prefix}-new-values" required><button type="submit" title="${tr('Добавить тег')}" aria-label="${tr('Добавить тег')}">+</button>${list(`${prefix}-keys`,idTagKeys())}${list(`${prefix}-new-values`,[])}</form></section>`;
}
export function bindOtherTags(container: HTMLElement, read: (key:string, indoor:boolean)=>Record<string,string>|undefined,
  write: (key:string, tag:string, value:string|undefined, indoor:boolean)=>void) {
  const section = (el:Element)=>el.closest<HTMLElement>('[data-other-key]');
  const save = (box:HTMLElement, tag:string, value:string|undefined)=>write(box.dataset.otherKey!,tag,value,box.hasAttribute('data-other-indoor'));
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
    const form=el.closest('form')!, values=form.querySelector('datalist:last-child')!;
    values.innerHTML=(idOptions(el.value.trim())??[]).map(v=>`<option value="${esc(v)}"></option>`).join('');
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

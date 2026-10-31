/** Выпадающий список в верхнем слое страницы: панели с прокруткой его не обрезают и не перекрывают. */
const GAP = 2;
let tracking = false;

function place(ul: HTMLElement) {
  const box = ul.parentElement!.getBoundingClientRect();
  ul.style.left = `${box.left}px`;
  ul.style.width = `${box.width}px`;
  const below = innerHeight - box.bottom - GAP * 2, above = box.top - GAP * 2;
  ul.style.maxHeight = '';
  const height = ul.getBoundingClientRect().height;
  const up = height > below && above > below;
  ul.style.maxHeight = `${Math.min(240, up ? above : below)}px`;
  ul.style.top = up ? `${box.top - GAP - Math.min(height, above)}px` : `${box.bottom + GAP}px`;
}

/** Показать открытый список под родителем, а если внизу не хватает места — над ним. */
export function placeCombo(ul: HTMLElement) {
  if (ul.hidden) return;
  ul.popover = 'manual';
  if (!ul.matches(':popover-open')) ul.showPopover();
  place(ul);
  if (tracking) return;
  tracking = true;
  const follow = () => { for (const el of document.querySelectorAll<HTMLElement>('.combo-list:popover-open')) if (!el.hidden) place(el); };
  addEventListener('resize', follow);
  document.addEventListener('scroll', (e) => { if (!(e.target as Element).matches?.('.combo-list')) follow(); }, true);
}

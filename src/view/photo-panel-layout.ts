/** Shared positioning and edge/corner resizing for photo and plugin viewers. */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Rect = { left: number; top: number; width: number; height: number };
// Like PhotoViewer's retained element, plugin panels remember geometry for this editor session.
const remembered = new Map<string, Rect>();

export class PhotoPanelLayout {
  private userPlaced = false;
  private readonly handles: HTMLElement[] = [];
  private readonly toolbarMutation?: MutationObserver;
  private readonly toolbarResize?: ResizeObserver;
  private readonly onResize = () => this.place();
  constructor(private readonly el: HTMLElement, head: HTMLElement, private readonly key?: string) {
    const saved = key ? remembered.get(key) : undefined;
    if (saved) { this.userPlaced = true; this.setRect(saved.left, saved.top, saved.width, saved.height); }
    for (const d of EDGES) {
      const handle = document.createElement('div');
      handle.className = `panoramax-rs panoramax-rs-${d}`;
      el.append(handle);
      this.handles.push(handle);
      this.bindResize(handle, d);
    }
    this.bindMove(head);
    const toolbars = document.getElementById('toolbars');
    if (toolbars) {
      this.toolbarMutation = new MutationObserver(this.onResize);
      this.toolbarMutation.observe(toolbars, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
      this.toolbarResize = new ResizeObserver(this.onResize);
      this.toolbarResize.observe(toolbars);
    }
    addEventListener('resize', this.onResize);
  }
  dispose() {
    this.toolbarMutation?.disconnect();
    this.toolbarResize?.disconnect();
    removeEventListener('resize', this.onResize);
    this.handles.forEach(handle => handle.remove());
  }

  place() {
    if (this.el.hidden) return;
    if (!this.userPlaced) {
      const tb = document.getElementById('toolbars');
      const r = tb && tb.offsetParent ? tb.getBoundingClientRect() : undefined;
      const left = r && r.width ? r.right + 8 : 10;
      // Окна, открытые раньше и стоящие на месте по умолчанию, — ниже этого
      let bottom = 34;
      for (const o of document.querySelectorAll<HTMLElement>('.panoramax-viewer')) {
        if (o === this.el) break;
        if (!o.hidden && o.style.bottom) bottom = Math.max(bottom, innerHeight - o.getBoundingClientRect().top + 8);
      }
      Object.assign(this.el.style, { left: `${left}px`, top: '', bottom: `${bottom}px`,
        maxWidth: `${innerWidth - left - 10}px`, maxHeight: `${innerHeight - bottom - 26}px` });
      return;
    }
    const r = this.el.getBoundingClientRect();
    const w = Math.min(r.width, innerWidth), h = Math.min(r.height, innerHeight);
    this.setRect(Math.max(0, Math.min(r.left, innerWidth - w)), Math.max(0, Math.min(r.top, innerHeight - h)), w, h);
  }

  private setRect(left: number, top: number, width: number, height: number) {
    Object.assign(this.el.style, { left: `${left}px`, top: `${top}px`, bottom: '', width: `${width}px`, height: `${height}px`,
      maxWidth: '', maxHeight: '' });
    if (this.key && this.userPlaced) remembered.set(this.key, { left, top, width, height });
  }

  /** Перетаскивание за заголовок (кроме кнопок). */
  private bindMove(head: HTMLElement) {
    let start: { x: number; y: number; r: DOMRect } | undefined;
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, r: this.el.getBoundingClientRect() };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!start) return;
      const { r } = start;
      this.userPlaced = true;
      this.setRect(Math.max(0, Math.min(r.left + e.clientX - start.x, innerWidth - r.width)),
        Math.max(0, Math.min(r.top + e.clientY - start.y, innerHeight - r.height)), r.width, r.height);
    });
    const up = () => { start = undefined; };
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }

  /** Изменение размера за край или угол d: двигается только эта сторона. */
  private bindResize(h: HTMLElement, d: typeof EDGES[number]) {
    const MIN_W = 240, MIN_H = 180;
    let start: { x: number; y: number; r: DOMRect } | undefined;
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, r: this.el.getBoundingClientRect() };
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', (e) => {
      if (!start) return;
      const { r } = start, dx = e.clientX - start.x, dy = e.clientY - start.y;
      let { left, top, right, bottom } = r;
      if (d.includes('w')) left = Math.max(0, Math.min(left + dx, right - MIN_W));
      if (d.includes('e')) right = Math.min(innerWidth, Math.max(right + dx, left + MIN_W));
      if (d.includes('n')) top = Math.max(0, Math.min(top + dy, bottom - MIN_H));
      if (d.includes('s')) bottom = Math.min(innerHeight, Math.max(bottom + dy, top + MIN_H));
      this.userPlaced = true;
      this.setRect(left, top, right - left, bottom - top);
    });
    const up = () => { start = undefined; };
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  }

}

import type { OsmElement } from './api';
import type { LonLat } from './model';

/** Узел с готовой 3D-моделью (тег 3dmr=<id>, репозиторий 3dmr.eu). */
export interface ModelNode { id: number; p: LonLat; tags: Record<string, string> }

export function parseModelNodes(elements: OsmElement[]): ModelNode[] {
  const out: ModelNode[] = [];
  for (const el of elements) if (el.type === 'node' && el.tags?.['3dmr']) out.push({ id: el.id, p: [el.lon, el.lat], tags: el.tags });
  return out;
}

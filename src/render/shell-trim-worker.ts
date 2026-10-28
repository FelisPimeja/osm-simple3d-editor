/// <reference lib="webworker" />
/** Web Worker обрезки граней оболочки здания (см. shell-trim-pool). */
import { trimSync, type TrimMessage } from './shell-trim-pool';
import type { PreparedSolid } from './shell-trim';

const solids = new Map<number, PreparedSolid>();

self.onmessage = (e: MessageEvent<TrimMessage>) => {
  const { id, job } = e.data;
  if (e.data.clear) solids.clear();
  for (const [k, s] of e.data.solids) solids.set(k, s);
  try {
    const result = trimSync(job, job.deps.map((k) => solids.get(k)!));
    self.postMessage({ id, result }, [result.walls.buffer, result.roof.buffer, result.cut.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

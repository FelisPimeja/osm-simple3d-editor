/// <reference lib="webworker" />
/** Web Worker разброса деревьев: большой лес считается десятки миллисекунд — не в главном потоке. */
import { scatterTrees } from './tree-scatter';
import type { LonLat } from '../osm/model';
import type { TreeData } from '../osm/trees';

interface Job { id: number; own: TreeData; woods: TreeData['woods']; buildings: LonLat[][]; bbox: [number, number, number, number] }

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, own, woods, buildings, bbox } = e.data;
  const trees = scatterTrees(own, woods, buildings, bbox);
  self.postMessage({ id, trees }, [trees.buffer]);
};

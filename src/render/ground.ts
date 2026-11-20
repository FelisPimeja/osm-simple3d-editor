/**
 * Отметка земли для слоёв сцены (рельеф, эксперимент): main подставляет выборку DEM, пока рельеф включён.
 * rev растёт при каждой смене отметок (пришёл тайл DEM, рельеф включили или выключили) — слои по ней пересобираются.
 */
export const ground = {
  on: false,
  rev: 0,
  at: (_p: [number, number]): number => 0,
};

export function setGroundSampler(at: ((p: [number, number]) => number) | undefined, rev: number) {
  ground.on = !!at;
  ground.at = at ?? (() => 0);
  ground.rev = rev;
}

/**
 * Затенение земли вокруг зданий: мягкая окклюзия у стен и тени от солнца, спроецированные на землю.
 * Идея — как у AOShadowLayer (github.com/wallabyway/maplibre-building-shadows), своя реализация без поля
 * расстояний: окклюзия — полосы вдоль рёбер следа и круги в вершинах с затемнением по расстоянию, тень — грани
 * здания, сплющенные на землю вдоль луча солнца. Всё рисуется в буфер с наложением по максимуму (перекрытия не
 * темнеют дважды), буфер чуть размывается и умножается на карту до отрисовки зданий — они закрывают свои следы.
 */
import * as THREE from 'three';

/** Направление на солнце в локальных метрах (x — восток, y — север, z — вверх): то же, что у света зданий. */
export const SUN = new THREE.Vector3(-0.5, -1, 1.5).normalize();
/** Ширина окклюзии у стены, м. */
export const AO_RADIUS = 4;
/** Затемнение у самой стены (0 — нет, 1 — чёрное). */
export const AO_STRENGTH = 0.35;
/** Затемнение в тени. */
export const SHADOW_STRENGTH = 0.35;
const DISC = 12;

export interface ShadeSource {
  /** Треугольники здания (xyz, локальные метры), без перекрытий. */
  positions: Float32Array;
  vertices: number;
  /** Кольца следа (локальные метры) для окклюзии; нет — здание не стоит на земле. Зовётся, только если окклюзия нужна. */
  rings?: () => [number, number][][];
  /** Отметка рельефа в точке (локальные метры); нет — земля z = 0. ground — версия отметок (пришли тайлы DEM — пересобрать). */
  height?: (x: number, y: number) => number;
  ground?: number;
}

export interface ShadeOptions { shadow: boolean; ao: boolean }

/** Вершина затенения — четвёрка (x, y, z, d): z — земля, d — расстояние от стены в долях AO_RADIUS (0…1), у тени −1. */
const STRIDE = 4;
const cache = new WeakMap<Float32Array, { key: string; part: Float32Array }>();

export function shadePart(s: ShadeSource, o: ShadeOptions): Float32Array {
  const key = `${s.vertices}|${o.shadow}|${o.ao}|${!!s.rings}|${s.height ? s.ground ?? 0 : '-'}`;
  const hit = cache.get(s.positions);
  if (hit?.key === key) return hit.part;
  const rings = o.ao && s.rings ? s.rings() : [];
  // Отметки в одной точке нужны многим вершинам (стены делят их) — запоминаем по точке (до мм)
  const memo = new Map<string, number>();
  const h = !s.height ? () => 0 : (x: number, y: number) => {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, v = s.height!(x, y));
    return v;
  };
  let edges = 0;
  for (const r of rings) edges += r.length;
  const out = new Float32Array(((o.shadow ? s.vertices * 2 : 0) + edges * (12 + DISC * 3)) * STRIDE);
  let n = 0;
  const v = (x: number, y: number, z: number, d: number) => { out[n++] = x; out[n++] = y; out[n++] = z; out[n++] = d; };
  const g = (x: number, y: number, d: number) => v(x, y, h(x, y), d);
  if (o.shadow) {
    // Тень даёт только надземная часть грани: треугольник обрезается по земле (высота над землёй в вершинах —
    // линейно по рёбрам), остаток (3–4 вершины) — лучом от каждой вершины на рельеф: (x − kx·t, y − ky·t, z − t),
    // t — где луч встречает землю, t = z − h(луч(t)), несколько итераций с затуханием (на ровной сходится сразу).
    // Иначе засыпанная склоном крыша красила бы тенью рельеф над собой
    const kx = SUN.x / SUN.z, ky = SUN.y / SUN.z, p = s.positions;
    const cast = (x: number, y: number, z: number, above: number, out: number[]) => {
      if (above <= 1e-6) { out.push(x, y, h(x, y)); return; }
      let t = above;
      if (s.height) for (let it = 0; it < 4; it++) t = Math.max(0, 0.5 * t + 0.5 * (z - h(x - kx * t, y - ky * t)));
      const sx = x - kx * t, sy = y - ky * t;
      out.push(sx, sy, s.height ? h(sx, sy) : z - t);
    };
    const poly: number[] = [], shadow: number[] = [];
    for (let i = 0; i < s.vertices * 3; i += 9) {
      poly.length = 0;
      const a = [0, 3, 6].map((k) => p[i + k + 2] - h(p[i + k], p[i + k + 1]));
      if (a[0] <= 0 && a[1] <= 0 && a[2] <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3, ak = a[k], aj = a[j], pk = i + k * 3, pj = i + j * 3;
        if (ak > 0) poly.push(p[pk], p[pk + 1], p[pk + 2], ak);
        if ((ak > 0) !== (aj > 0)) {
          // Точка ребра на земле
          const f = ak / (ak - aj);
          poly.push(p[pk] + (p[pj] - p[pk]) * f, p[pk + 1] + (p[pj + 1] - p[pk + 1]) * f, p[pk + 2] + (p[pj + 2] - p[pk + 2]) * f, 0);
        }
      }
      shadow.length = 0;
      for (let k = 0; k < poly.length; k += 4) cast(poly[k], poly[k + 1], poly[k + 2], poly[k + 3], shadow);
      // Веер из первой вершины; сплющенные в отрезок треугольники (стены вдоль луча) ничего не закрывают
      for (let k = 3; k + 3 < shadow.length; k += 3) {
        const ax = shadow[0], ay = shadow[1], bx = shadow[k], by = shadow[k + 1], cx = shadow[k + 3], cy = shadow[k + 4];
        if (Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) < 1e-4) continue;
        v(ax, ay, shadow[2], -1); v(bx, by, shadow[k + 2], -1); v(cx, cy, shadow[k + 5], -1);
      }
    }
  }
  for (const ring of rings) {
    const m = ring.length - (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
    for (let i = 0; i < m; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % m];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-3) continue;
      const nx = -(by - ay) / len * AO_RADIUS, ny = (bx - ax) / len * AO_RADIUS;
      // Полосы по обе стороны ребра: внутренняя закрыта самим зданием (обход колец знать не нужно)
      for (const s2 of [1, -1]) {
        const ox = nx * s2, oy = ny * s2;
        g(ax, ay, 0); g(bx, by, 0); g(bx + ox, by + oy, 1);
        g(ax, ay, 0); g(bx + ox, by + oy, 1); g(ax + ox, ay + oy, 1);
      }
      // Круг в вершине — скругляет внешние углы
      for (let k = 0; k < DISC; k++) {
        g(ax, ay, 0);
        g(ax + COS[k] * AO_RADIUS, ay + SIN[k] * AO_RADIUS, 1);
        g(ax + COS[k + 1] * AO_RADIUS, ay + SIN[k + 1] * AO_RADIUS, 1);
      }
    }
  }
  const part = n === out.length ? out : out.slice(0, n);
  cache.set(s.positions, { key, part });
  return part;
}
const COS = Array.from({ length: DISC + 1 }, (_, k) => Math.cos((k / DISC) * Math.PI * 2));
const SIN = Array.from({ length: DISC + 1 }, (_, k) => Math.sin((k / DISC) * Math.PI * 2));

/** Геометрия затенения группы: части зданий (из кеша) одним буфером; position — (x, y, z), d — отдельно. */
export function buildShade(sources: ShadeSource[], o: ShadeOptions = { shadow: true, ao: true }): THREE.BufferGeometry | undefined {
  const parts = sources.map((s) => shadePart(s, o));
  let total = 0;
  for (const p of parts) total += p.length;
  if (!total) return;
  const all = new Float32Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const buf = new THREE.InterleavedBuffer(all, STRIDE);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, 0));
  geo.setAttribute('d', new THREE.InterleavedBufferAttribute(buf, 1, 3));
  return geo;
}

/**
 * На карте с рельефом (ON_MAP): точка тени сдвигается вдоль луча к камере — на экране она там же, а для проверки
 * глубины оказывается перед поверхностью. Рельеф MapLibre рисует сеткой грубее выборки DEM (вдали — ещё грубее),
 * и тень на отметках выборки местами уходила под отрисованную поверхность (дыры у стен); сдвиг — доля расстояния.
 */
const TO_EYE = `uniform vec3 eye;
    vec3 toEye(vec3 p) {
      #ifdef ON_MAP
      vec3 d = eye - p;
      float l = length(d);
      return p + d * min(0.5, (1.5 + 0.02 * l) / max(l, 1e-3));
      #else
      return p;
      #endif
    }`;

/** Дальность теней: от центра карты на radius (м, в координатах группы) затенение гаснет, дальше не рисуется. */
const FADE = `float fade(vec2 p) {
      float f = 1.0 - smoothstep(0.75 * radius, radius, distance(p, center));
      if (f <= 0.0) discard;
      return f;
    }`;

/** Материал буфера затенения: в красный канал — затемнение, наложение по максимуму. */
export const SHADE_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { eye: { value: new THREE.Vector3() }, ao: { value: AO_STRENGTH }, shadow: { value: SHADOW_STRENGTH }, center: { value: new THREE.Vector2() }, radius: { value: 1e9 } },
  vertexShader: `attribute float d; varying float vD; varying vec2 vXY;
    ${TO_EYE}
    void main() { vD = d; vXY = position.xy; gl_Position = projectionMatrix * vec4(toEye(position), 1.0); }`,
  fragmentShader: `uniform float ao; uniform float shadow; uniform vec2 center; uniform float radius; varying float vD; varying vec2 vXY;
    ${FADE}
    void main() { float f = fade(vXY); float t = clamp(1.0 - vD, 0.0, 1.0); float v = (vD < -0.5 ? shadow : ao * t * t) * f; gl_FragColor = vec4(v, v, v, 1.0); }`,
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/**
 * Тень произвольных объектов (ограждения, деревья, модели): вершины в координатах группы сплющиваются на землю
 * вдоль луча солнца прямо в шейдере — геометрию не пересобираем; экземпляры (деревья) — через instanceMatrix.
 * На рельефе (onBase = 1) земля — плоскость на отметке основания объекта.
 */
export const CAST_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { eye: { value: new THREE.Vector3() }, shadow: { value: SHADOW_STRENGTH }, k: { value: new THREE.Vector2(SUN.x / SUN.z, SUN.y / SUN.z) }, center: { value: new THREE.Vector2() }, radius: { value: 1e9 }, onBase: { value: 0 }, groundZ: { value: 0 } },
  vertexShader: `uniform vec2 k; uniform float onBase; uniform float groundZ; varying vec2 vXY;
    ${TO_EYE}
    void main() {
      vec4 w = vec4(position, 1.0), o = vec4(0.0, 0.0, groundZ, 1.0);
      #ifdef USE_INSTANCING
      w = instanceMatrix * w; o = instanceMatrix * o;
      #endif
      w = modelMatrix * w; o = modelMatrix * o;
      // Земля — z = 0, а на рельефе — отметка основания объекта (начало его координат: дерево, модель)
      float base = onBase * o.z;
      w.xy -= k * max(w.z - base, 0.0);
      w.z = base;
      w.xyz = toEye(w.xyz);
      vXY = w.xy;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: `uniform float shadow; uniform vec2 center; uniform float radius; varying vec2 vXY;
    ${FADE}
    void main() { float v = shadow * fade(vXY); gl_FragColor = vec4(v, v, v, 1.0); }`,
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/**
 * Объекты, отбрасывающие тень, и матрица их группы (локальные метры → Mercator). groundZ — где у объекта (экземпляра)
 * в его собственных координатах земля: у кроны дерева начало — низ кроны, а земля ниже (на рельефе тень — на ней).
 */
export interface ShadeCasters { objects: THREE.Object3D[]; model: THREE.Matrix4; groundZ?: number }

/**
 * Те же материалы — прямо на карту, с проверкой глубины (рельеф: бровка перед тенью её закрывает): цвет карты
 * × (1 − затемнение), каждый пиксель — один раз (трафарет: рисуем, где 0, и отмечаем). Без размытия.
 */
function onMap(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const c = m.clone();
  c.defines = { ...c.defines, ON_MAP: '' };
  Object.assign(c, {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
    // Тень лежит на самом рельефе — чуть ближе к камере, чтобы не мерцать с ним
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.EqualStencilFunc, stencilZPass: THREE.IncrementStencilOp,
    stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilWriteMask: 0xff, stencilFuncMask: 0xff,
  });
  return c;
}
export const SHADE_ON_MAP = onMap(SHADE_MATERIAL);
export const CAST_ON_MAP = onMap(CAST_MATERIAL);

/** Наложение буфера на карту: цвет × (1 − затемнение); с blur > 0 — размытие 3×3 (мягкие края тени). */
export const COMPOSITE_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { map: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() }, blur: { value: 1.5 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D map; uniform vec2 texel; uniform float blur; varying vec2 vUv;
    void main() {
      float s = 0.0;
      for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += texture2D(map, vUv + vec2(float(x), float(y)) * texel * blur).r;
      s /= 9.0;
      gl_FragColor = vec4(s, s, s, 0.0);
    }`,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.ZeroFactor,
  blendDst: THREE.OneMinusSrcColorFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
});

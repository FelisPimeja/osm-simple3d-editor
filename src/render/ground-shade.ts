/**
 * Тени от солнца на земле: грани здания, сплющенные на землю вдоль луча солнца. Рисуются в буфер с наложением
 * по максимуму (перекрытия не темнеют дважды), буфер умножается на карту до отрисовки зданий — они закрывают свои следы.
 */
import * as THREE from 'three';

/** Направление на солнце в локальных метрах (x — восток, y — север, z — вверх): то же, что у света зданий. */
export const SUN = new THREE.Vector3(-0.5, -1, 1.5).normalize();
/** Затемнение в тени. */
export const SHADOW_STRENGTH = 0.35;

export interface ShadeSource {
  /** Треугольники здания (xyz, локальные метры), без перекрытий. */
  positions: Float32Array;
  vertices: number;
  /** Отметка рельефа в точке (локальные метры); нет — земля z = 0. ground — версия отметок (пришли тайлы DEM — пересобрать). */
  height?: (x: number, y: number) => number;
  ground?: number;
  /** Стеклянные вершины [от, до): их тень почти прозрачная. */
  glass?: [number, number][];
}

/** d стеклянной тени: GLASS_D − доля (у обычной −1 − доля); шейдер различает по d < −5. */
const GLASS_D = -10;
/** Насыщенность тени стекла от обычной. */
export const GLASS_SHADOW = 0.2;

/** Вершина тени — четвёрка (x, y, z, d): z — земля, d = −1 − (насколько вершина отнесена от своей точки объекта, в долях полной длины его тени) — для градиента. */
const STRIDE = 4;
const cache = new WeakMap<Float32Array, { key: string; part: Float32Array }>();

export function shadePart(s: ShadeSource): Float32Array {
  const key = `${s.vertices}|${s.height ? s.ground ?? 0 : '-'}|${s.glass?.join(';') ?? ''}`;
  const glassAt = (vi: number) => !!s.glass?.some(([a, b]) => vi >= a && vi < b);
  const hit = cache.get(s.positions);
  if (hit?.key === key) return hit.part;
  // Отметки в одной точке нужны многим вершинам (стены делят их) — запоминаем по точке (до мм)
  const memo = new Map<string, number>();
  const h = !s.height ? () => 0 : (x: number, y: number) => {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, v = s.height!(x, y));
    return v;
  };
  const out = new Float32Array(s.vertices * 2 * STRIDE);
  let n = 0;
  const v = (x: number, y: number, z: number, d: number) => { out[n++] = x; out[n++] = y; out[n++] = z; out[n++] = d; };
  {
    // Тень даёт только надземная часть грани: треугольник обрезается по земле (высота над землёй в вершинах —
    // линейно по рёбрам), остаток (3–4 вершины) — лучом от каждой вершины на рельеф: (x − kx·t, y − ky·t, z − t),
    // t — где луч встречает землю, t = z − h(луч(t)), несколько итераций с затуханием (на ровной сходится сразу).
    // Иначе засыпанная склоном крыша красила бы тенью рельеф над собой
    const kx = SUN.x / SUN.z, ky = SUN.y / SUN.z, p = s.positions;
    const cast = (x: number, y: number, z: number, above: number, out: number[]) => {
      if (above <= 1e-6) { out.push(x, y, h(x, y), 0); return; }
      let t = above;
      if (s.height) for (let it = 0; it < 4; it++) t = Math.max(0, 0.5 * t + 0.5 * (z - h(x - kx * t, y - ky * t)));
      const sx = x - kx * t, sy = y - ky * t;
      out.push(sx, sy, s.height ? h(sx, sy) : z - t, (t > 1e-6 ? Math.min(t * Math.hypot(kx, ky), outside(sx, sy)) : 0) / full);
    };
    const poly: number[] = [], shadow: number[] = [];
    // Полная длина тени объекта — от его высшей точки над землёй: градиент тени — в её долях
    let top = 0;
    for (let i = 0; i < s.vertices * 3; i += 3) top = Math.max(top, p[i + 2] - h(p[i], p[i + 1]));
    const full = Math.max(top, 0.1) * Math.hypot(kx, ky);
    // Градиент — от контура объекта (выпуклая оболочка его проекции), а не от точки, отбросившей тень: под навесом
    // и у стен тень сплошная — иначе тени колонн проступали полосами в светлой (дальней) тени высокого навеса
    const hull = hull2d(p, s.vertices);
    const outside = (x: number, y: number) => distToHull(hull, x, y);
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
      for (let k = 4; k + 4 < shadow.length; k += 4) {
        const ax = shadow[0], ay = shadow[1], bx = shadow[k], by = shadow[k + 1], cx = shadow[k + 4], cy = shadow[k + 5];
        if (Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) < 1e-4) continue;
        const o = glassAt(i / 3) ? GLASS_D : -1;
        v(ax, ay, shadow[2], o - shadow[3]); v(bx, by, shadow[k + 2], o - shadow[k + 3]); v(cx, cy, shadow[k + 6], o - shadow[k + 7]);
      }
    }
  }
  const part = n === out.length ? out : out.slice(0, n);
  cache.set(s.positions, { key, part });
  return part;
}

/** Выпуклая оболочка плана: вершины против часовой и рёбра (начало, направление, 1/длина²) — для distToHull. */
export interface Hull { n: number; e: Float64Array; minX: number; minY: number; maxX: number; maxY: number }

/** Выпуклая оболочка проекции вершин на план. Стены делят точки (каждая — в нескольких треугольниках): сначала без повторов. */
export function hull2d(p: Float32Array, count: number): Hull {
  const seen = new Set<string>(), xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < count * 3; i += 3) {
    const k = `${Math.round(p[i] * 100)},${Math.round(p[i + 1] * 100)}`;
    if (seen.has(k)) continue;
    seen.add(k); xs.push(p[i]); ys.push(p[i + 1]);
  }
  const idx = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const cross = (o: number, a: number, b: number) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const lo: number[] = [], hi: number[] = [];
  for (const q of idx) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = idx.length - 1; i >= 0; i--) { const q = idx[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  const ring = [...lo.slice(0, -1), ...hi.slice(0, -1)], n = ring.length, e = new Float64Array(n * 5);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], ex = xs[b] - xs[a], ey = ys[b] - ys[a], l2 = ex * ex + ey * ey;
    e.set([xs[a], ys[a], ex, ey, l2 ? 1 / l2 : 0], i * 5);
    minX = Math.min(minX, xs[a]); maxX = Math.max(maxX, xs[a]); minY = Math.min(minY, ys[a]); maxY = Math.max(maxY, ys[a]);
  }
  return { n, e, minX, minY, maxX, maxY };
}

/** Расстояние от точки до выпуклой оболочки (внутри — 0). */
export function distToHull(h: Hull, x: number, y: number): number {
  const { n, e } = h;
  if (!n) return 0;
  if (n < 3) return Math.hypot(x - e[0], y - e[1]);
  // Внутри: все рёбра слева (против часовой); снаружи ограничивающего прямоугольника — сразу к рёбрам
  let inside = x >= h.minX && x <= h.maxX && y >= h.minY && y <= h.maxY, best = Infinity;
  if (inside) {
    for (let i = 0; i < n * 5; i += 5) if (e[i + 2] * (y - e[i + 1]) - e[i + 3] * (x - e[i]) < 0) { inside = false; break; }
    if (inside) return 0;
  }
  for (let i = 0; i < n * 5; i += 5) {
    const dx = x - e[i], dy = y - e[i + 1], f = Math.max(0, Math.min(1, (dx * e[i + 2] + dy * e[i + 3]) * e[i + 4]));
    const qx = dx - e[i + 2] * f, qy = dy - e[i + 3] * f, d2 = qx * qx + qy * qy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Геометрия затенения группы: части зданий (из кеша) одним буфером; position — (x, y, z), d — отдельно. */
export function buildShade(sources: ShadeSource[]): THREE.BufferGeometry | undefined {
  const parts = sources.map((s) => shadePart(s));
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
      #if defined(ON_MAP) || defined(ON_MAP_POS)
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

/**
 * На карте (ON_MAP) затемнение берётся из буфера, куда та же геометрия нарисована с наложением по максимуму:
 * на карту пиксель пишется один раз (трафарет), и без буфера в нём оставался первый треугольник, а не самый тёмный.
 */
const FROM_BUF = `uniform sampler2D buf; uniform vec2 bufTexel;
    vec3 fromBuf(float v) {
      #ifdef ON_MAP
      return vec3(texture2D(buf, gl_FragCoord.xy * bufTexel).r);
      #else
      return vec3(v);
      #endif
    }`;

/** Материал буфера затенения: в красный канал — затемнение, наложение по максимуму. */
export const SHADE_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { eye: { value: new THREE.Vector3() }, shadow: { value: SHADOW_STRENGTH }, grad: { value: 0 }, gradLen: { value: 1 }, center: { value: new THREE.Vector2() }, radius: { value: 1e9 }, buf: { value: null }, bufTexel: { value: new THREE.Vector2() } },
  vertexShader: `attribute float d; varying float vD; varying vec2 vXY;
    ${TO_EYE}
    void main() { vD = d; vXY = position.xy; gl_Position = projectionMatrix * vec4(toEye(position), 1.0); }`,
  fragmentShader: `uniform float shadow; uniform vec2 center; uniform float radius; varying float vD; varying vec2 vXY;
    uniform float grad; uniform float gradLen;
    float gradient(float dist) { return 1.0 - grad * clamp(dist / gradLen, 0.0, 1.0); }
    ${FADE}
    ${FROM_BUF}
    void main() {
      bool glass = vD < -5.0;
      float v = shadow * gradient(glass ? ${GLASS_D.toFixed(1)} - vD : -1.0 - vD) * fade(vXY) * (glass ? ${GLASS_SHADOW.toFixed(2)} : 1.0);
      gl_FragColor = vec4(fromBuf(v), 1.0);
    }`,
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
  uniforms: { eye: { value: new THREE.Vector3() }, shadow: { value: SHADOW_STRENGTH }, grad: { value: 0 }, gradLen: { value: 1 }, top: { value: 1 }, height: { value: 0 }, k: { value: new THREE.Vector2(SUN.x / SUN.z, SUN.y / SUN.z) }, center: { value: new THREE.Vector2() }, radius: { value: 1e9 }, onBase: { value: 0 }, groundZ: { value: 0 }, buf: { value: null }, bufTexel: { value: new THREE.Vector2() } },
  vertexShader: `uniform vec2 k; uniform float onBase; uniform float groundZ; uniform float top; uniform float height; varying vec2 vXY; varying float vDist;
    ${TO_EYE}
    void main() {
      vec4 w = vec4(position, 1.0), o = vec4(0.0, 0.0, groundZ, 1.0), t = vec4(0.0, 0.0, top, 1.0);
      #ifdef USE_INSTANCING
      w = instanceMatrix * w; o = instanceMatrix * o; t = instanceMatrix * t;
      #endif
      w = modelMatrix * w; o = modelMatrix * o; t = modelMatrix * t;
      // Высота объекта: задана (модели, ограждения) или от земли до верха экземпляра (деревья)
      float full = height > 0.0 ? height : max(t.z - o.z, 0.1);
      // Земля — z = 0, а на рельефе — отметка основания объекта (начало его координат: дерево, модель)
      float base = onBase * o.z;
      float up = max(w.z - base, 0.0);
      vDist = up / full;
      w.xy -= k * up;
      w.z = base;
      w.xyz = toEye(w.xyz);
      vXY = w.xy;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: `uniform float shadow; uniform vec2 center; uniform float radius; varying vec2 vXY; varying float vDist;
    uniform float grad; uniform float gradLen;
    float gradient(float dist) { return 1.0 - grad * clamp(dist / gradLen, 0.0, 1.0); }
    ${FADE}
    ${FROM_BUF}
    void main() { float v = shadow * gradient(vDist) * fade(vXY); gl_FragColor = vec4(fromBuf(v), 1.0); }`,
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
/** groundZ — земля, top — верх объекта (в координатах экземпляра); height — высота объекта, м (вместо top). */
export interface ShadeCasters { objects: THREE.Object3D[]; model: THREE.Matrix4; groundZ?: number; top?: number; height?: number }

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

/** Первый проход на рельефе: те же вершины, что на карте (сдвиг к камере), — в буфер по максимуму, без глубины. */
function toBuf(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const c = m.clone();
  c.defines = { ...c.defines, ON_MAP_POS: '' };
  return c;
}
export const SHADE_TO_BUF = toBuf(SHADE_MATERIAL);
export const CAST_TO_BUF = toBuf(CAST_MATERIAL);

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

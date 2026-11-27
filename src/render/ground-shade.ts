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
  /** Треугольники здания (xyz, локальные метры), без перекрытий; z = 0 — земля. */
  positions: Float32Array;
  vertices: number;
  /** Кольца следа (локальные метры) для окклюзии; нет — здание не стоит на земле. Зовётся, только если окклюзия нужна. */
  rings?: () => [number, number][][];
}

export interface ShadeOptions { shadow: boolean; ao: boolean }

/** Затенение одного здания: тройки (x, y, d), d — расстояние от стены в долях AO_RADIUS (0…1), у тени d = −1. */
const cache = new WeakMap<Float32Array, { key: string; part: Float32Array }>();

export function shadePart(s: ShadeSource, o: ShadeOptions): Float32Array {
  const key = `${s.vertices}|${o.shadow}|${o.ao}|${!!s.rings}`;
  const hit = cache.get(s.positions);
  if (hit?.key === key) return hit.part;
  const rings = o.ao && s.rings ? s.rings() : [];
  let edges = 0;
  for (const r of rings) edges += r.length;
  const out = new Float32Array((o.shadow ? s.vertices * 3 : 0) + edges * (12 + DISC * 3) * 3);
  let n = 0;
  const v = (x: number, y: number, d: number) => { out[n++] = x; out[n++] = y; out[n++] = d; };
  if (o.shadow) {
    const kx = SUN.x / SUN.z, ky = SUN.y / SUN.z, p = s.positions;
    for (let i = 0; i < s.vertices * 3; i += 9) {
      const z0 = Math.max(0, p[i + 2]), z1 = Math.max(0, p[i + 5]), z2 = Math.max(0, p[i + 8]);
      const x0 = p[i] - kx * z0, y0 = p[i + 1] - ky * z0;
      const x1 = p[i + 3] - kx * z1, y1 = p[i + 4] - ky * z1;
      const x2 = p[i + 6] - kx * z2, y2 = p[i + 7] - ky * z2;
      // Сплющенные в отрезок треугольники (стены вдоль луча) ничего не закрывают
      if (Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) < 1e-4) continue;
      v(x0, y0, -1); v(x1, y1, -1); v(x2, y2, -1);
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
        v(ax, ay, 0); v(bx, by, 0); v(bx + ox, by + oy, 1);
        v(ax, ay, 0); v(bx + ox, by + oy, 1); v(ax + ox, ay + oy, 1);
      }
      // Круг в вершине — скругляет внешние углы
      for (let k = 0; k < DISC; k++) {
        v(ax, ay, 0);
        v(ax + COS[k] * AO_RADIUS, ay + SIN[k] * AO_RADIUS, 1);
        v(ax + COS[k + 1] * AO_RADIUS, ay + SIN[k + 1] * AO_RADIUS, 1);
      }
    }
  }
  const part = n === out.length ? out : out.slice(0, n);
  cache.set(s.positions, { key, part });
  return part;
}
const COS = Array.from({ length: DISC + 1 }, (_, k) => Math.cos((k / DISC) * Math.PI * 2));
const SIN = Array.from({ length: DISC + 1 }, (_, k) => Math.sin((k / DISC) * Math.PI * 2));

/** Геометрия затенения группы: части зданий (из кеша) одним буфером; position = (x, y, d). */
export function buildShade(sources: ShadeSource[], o: ShadeOptions = { shadow: true, ao: true }): THREE.BufferGeometry | undefined {
  const parts = sources.map((s) => shadePart(s, o));
  let total = 0;
  for (const p of parts) total += p.length;
  if (!total) return;
  const all = new Float32Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
  return geo;
}

/** Дальность теней: от центра карты на radius (м, в координатах группы) затенение гаснет, дальше не рисуется. */
const FADE = `float fade(vec2 p) {
      float f = 1.0 - smoothstep(0.75 * radius, radius, distance(p, center));
      if (f <= 0.0) discard;
      return f;
    }`;

/** Материал буфера затенения: в красный канал — затемнение, наложение по максимуму. */
export const SHADE_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { ao: { value: AO_STRENGTH }, shadow: { value: SHADOW_STRENGTH }, center: { value: new THREE.Vector2() }, radius: { value: 1e9 } },
  vertexShader: `varying float vD; varying vec2 vXY;
    void main() { vD = position.z; vXY = position.xy; gl_Position = projectionMatrix * vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform float ao; uniform float shadow; uniform vec2 center; uniform float radius; varying float vD; varying vec2 vXY;
    ${FADE}
    void main() { float f = fade(vXY); float t = clamp(1.0 - vD, 0.0, 1.0); gl_FragColor = vec4((vD < -0.5 ? shadow : ao * t * t) * f, 0.0, 0.0, 1.0); }`,
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/**
 * Тень произвольных объектов (ограждения, деревья): вершины в координатах группы сплющиваются на землю вдоль
 * луча солнца прямо в шейдере — геометрию не пересобираем; экземпляры (деревья) — через instanceMatrix.
 */
export const CAST_MATERIAL = new THREE.ShaderMaterial({
  uniforms: { shadow: { value: SHADOW_STRENGTH }, k: { value: new THREE.Vector2(SUN.x / SUN.z, SUN.y / SUN.z) }, center: { value: new THREE.Vector2() }, radius: { value: 1e9 } },
  vertexShader: `uniform vec2 k; varying vec2 vXY;
    void main() {
      vec4 w = vec4(position, 1.0);
      #ifdef USE_INSTANCING
      w = instanceMatrix * w;
      #endif
      w = modelMatrix * w;
      w.xy -= k * max(w.z, 0.0);
      w.z = 0.0;
      vXY = w.xy;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: `uniform float shadow; uniform vec2 center; uniform float radius; varying vec2 vXY;
    ${FADE}
    void main() { gl_FragColor = vec4(shadow * fade(vXY), 0.0, 0.0, 1.0); }`,
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Объекты, отбрасывающие тень, и матрица их группы (локальные метры → Mercator). */
export interface ShadeCasters { objects: THREE.Object3D[]; model: THREE.Matrix4 }

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

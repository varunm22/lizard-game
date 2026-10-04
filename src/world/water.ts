import * as THREE from 'three';
import { toonGradient } from '../render/toon';
import { OCEAN_X0, SEA_DEPTH, WATER_Y } from './shore';
import { terrainHeight } from './terrain';

/** Ripples alive at once; a new one replaces the oldest. */
const MAX_RIPPLES = 16;
/** Rings spread at this speed (m/s), about what small ripples on real water do. */
const RIPPLE_SPEED = 0.22;
/** Distance between a ripple's rings (m). */
const RIPPLE_WAVELENGTH = 0.028;
/** Height of a strength-1 ripple's rings (m). */
const RIPPLE_HEIGHT = 0.003;
/** A ripple lasts base + perStrength * strength seconds. */
const RIPPLE_LIFE = { base: 1.4, perStrength: 1.2 };
/**
 * The sheet runs from OCEAN_X0 out to the horizon (m east), and this far north and south. Its grid
 * is ~8 cm, enough for the swells; ripple rings and the shore wash are shaded per pixel.
 */
const SHEET = { east: 12, halfWidth: 9, cell: 0.08 };
/**
 * Water depth is read from a texture of the sea floor over this stretch (m), one texel every
 * DEPTH_TEXEL; past it the sea is open-water deep.
 */
const DEPTH_MAP = { x0: OCEAN_X0, x1: 5, z0: -6, z1: 6 };
const DEPTH_TEXEL = 0.025;

/** Sea-floor depth below the surface (m) at a world (x, z), from the depth texture. */
const DEPTH_GLSL = /* glsl */ `
uniform sampler2D uDepth;
float seaDepth(vec2 p) {
  vec2 uv = (p - vec2(${DEPTH_MAP.x0.toFixed(2)}, ${DEPTH_MAP.z0.toFixed(2)})) / vec2(${(DEPTH_MAP.x1 - DEPTH_MAP.x0).toFixed(2)}, ${(DEPTH_MAP.z1 - DEPTH_MAP.z0).toFixed(2)});
  if (uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return ${SEA_DEPTH.toFixed(2)};
  return texture2D(uDepth, uv).r * ${SEA_DEPTH.toFixed(2)};
}
`;

/** The sea floor's depth below the surface over DEPTH_MAP, 0 on land, as a one-channel texture (1 = SEA_DEPTH or deeper). */
function depthTexture(): THREE.DataTexture {
  const w = Math.round((DEPTH_MAP.x1 - DEPTH_MAP.x0) / DEPTH_TEXEL);
  const h = Math.round((DEPTH_MAP.z1 - DEPTH_MAP.z0) / DEPTH_TEXEL);
  const data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = DEPTH_MAP.x0 + ((i + 0.5) / w) * (DEPTH_MAP.x1 - DEPTH_MAP.x0);
      const z = DEPTH_MAP.z0 + ((j + 0.5) / h) * (DEPTH_MAP.z1 - DEPTH_MAP.z0);
      data[j * w + i] = Math.round(255 * Math.min(1, Math.max(0, (WATER_Y - terrainHeight(x, z)) / SEA_DEPTH)));
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RedFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Surface height above WATER_Y at a point of the sheet (world metres): a few slow crossing
 * swells, plus every live ripple, a packet of rings travelling out from where it started, widening
 * and fading as it goes, in .x. Shared by both shaders. In .y, how strongly a ripple's crest shows
 * there (0 to 1), for the foam lines that make even a gentle ripple readable in the toon shading.
 */
const HEIGHT_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uRipples[${MAX_RIPPLES}];
uniform float uRipplesUntil;

float swellHeight(vec2 p) {
  return 0.0016 * sin(dot(p, vec2(9.0, 1.5)) + uTime * 1.1)
       + 0.0011 * sin(dot(p, vec2(17.0, 9.0)) - uTime * 1.3)
       + 0.0008 * sin(dot(p, vec2(-11.0, 23.0)) - uTime * 1.7)
       + 0.0005 * sin(dot(p, vec2(31.0, -26.0)) - uTime * 2.6);
}

vec2 rippleHeight(vec2 p) {
  // Most of the time nothing is rippling: skip the loop over every pixel of the sea.
  if (uTime > uRipplesUntil) return vec2(0.0);
  float h = 0.0;
  float crest = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    float life = ${RIPPLE_LIFE.base.toFixed(2)} + ${RIPPLE_LIFE.perStrength.toFixed(2)} * r.w;
    if (r.w <= 0.0 || age < 0.0 || age > life) continue;
    float d = distance(p, r.xy);
    float front = ${RIPPLE_SPEED.toFixed(3)} * age;
    float width = 0.012 + 0.008 * r.w + 0.03 * age;
    float x = (d - front) / width;
    float t = age / life;
    float ring = exp(-x * x) * cos(${((2 * Math.PI) / RIPPLE_WAVELENGTH).toFixed(2)} * (d - front));
    h += ${RIPPLE_HEIGHT.toFixed(4)} * r.w * (1.0 - t) * (1.0 - t) / (1.0 + 6.0 * front) * ring;
    crest = max(crest, (1.0 - t * t) * (0.5 + 0.5 * min(1.0, r.w)) * ring);
  }
  return vec2(h, crest);
}
`;

/**
 * The sea's surface: a translucent toon sheet from the shore out to the horizon, seen from above
 * and below, that swells gently and carries ripples. Waves and ripples are all computed on the GPU
 * from a time and a short list of ripple origins; the vertices rise and fall with the swells, and
 * each pixel's normal comes from the same height function, so the rings (finer than the grid) shade
 * crisply in the toon light bands. A texture of the sea floor's depth tints it: clear turquoise over
 * the shallows, deep blue further out, with a band of foam washing up and down the waterline.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private time = 0;
  private next = 0;
  private uniforms = {
    uTime: { value: 0 },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uRipplesUntil: { value: -1 },
    uDepth: { value: depthTexture() },
  };

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshToonMaterial({
      color: 0xffffff,
      gradientMap: toonGradient(),
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}\nvarying vec2 vWaterXZ;`)
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWaterXZ = transformed.xz;\ntransformed.y += swellHeight(transformed.xz);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}\n${DEPTH_GLSL}\nvarying vec2 vWaterXZ;`)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          // Clear over the sand, turquoise in the shallows, deep blue offshore.
          float depth = seaDepth(vWaterXZ);
          diffuseColor.rgb = mix(vec3(0.42, 0.86, 0.82), vec3(0.16, 0.5, 0.66), smoothstep(0.02, 0.3, depth));
          diffuseColor.a = mix(0.35, 0.82, smoothstep(0.0, 0.25, depth));
          // Wash: foam where the water thins out on the sand, sliding up and back with the waves.
          float wash = 0.004 + 0.003 * sin(uTime * 0.9 + vWaterXZ.y * 2.3) + 0.0015 * sin(uTime * 2.1 - vWaterXZ.y * 5.0);
          float shoreFoam = 1.0 - smoothstep(wash, wash + 0.004, depth);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.98, 1.0), 0.75 * shoreFoam);
          diffuseColor.a = max(diffuseColor.a, 0.8 * shoreFoam);
          const float E = 0.0015;
          vec2 dx = vWaterXZ + vec2(E, 0.0);
          vec2 dz = vWaterXZ + vec2(0.0, E);
          float swell = swellHeight(vWaterXZ);
          vec2 rings = rippleHeight(vWaterXZ);
          float h = swell + rings.x;
          vec2 slope = (vec2(swellHeight(dx) + rippleHeight(dx).x, swellHeight(dz) + rippleHeight(dz).x) - h) / E;
          // Foam on ripple crests, and a faint glint along the swells' tops.
          float foam = smoothstep(0.42, 0.52, rings.y);
          float glint = smoothstep(0.0029, 0.0031, swell);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.98, 1.0), max(0.5 * foam, 0.2 * glint));
          diffuseColor.a = mix(diffuseColor.a, 0.7, foam);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `#include <normal_fragment_begin>
          normal = normalize(mat3(viewMatrix) * vec3(-slope.x, 1.0, -slope.y)) * faceDirection;`,
        );
    };

    const width = SHEET.east - OCEAN_X0;
    const geometry = new THREE.PlaneGeometry(width, 2 * SHEET.halfWidth, Math.round(width / SHEET.cell), Math.round((2 * SHEET.halfWidth) / SHEET.cell))
      .rotateX(-Math.PI / 2)
      .translate(OCEAN_X0 + width / 2, 0, 0);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(0, WATER_Y, 0);
    // The vertices move a few millimetres; don't let culling use the flat sheet's box.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'water';
    scene.add(this.mesh);
  }

  /** Start a ripple at world (x, z), `delay` seconds from now; strength ~0.6 for a gentle touch up to 1.2 for a splash. */
  ripple(x: number, z: number, strength: number, delay = 0) {
    this.uniforms.uRipples.value[this.next].set(x, z, this.time + delay, strength);
    const end = this.time + delay + RIPPLE_LIFE.base + RIPPLE_LIFE.perStrength * strength;
    this.uniforms.uRipplesUntil.value = Math.max(this.uniforms.uRipplesUntil.value, end);
    this.next = (this.next + 1) % MAX_RIPPLES;
  }

  /** Live ripples, newest last, for tests. */
  ripples(): { x: number; z: number; age: number; strength: number }[] {
    const out = [];
    for (let k = 0; k < MAX_RIPPLES; k++) {
      const r = this.uniforms.uRipples.value[(this.next + k) % MAX_RIPPLES];
      const age = this.time - r.z;
      if (r.w > 0 && age >= 0 && age <= RIPPLE_LIFE.base + RIPPLE_LIFE.perStrength * r.w) out.push({ x: r.x, z: r.y, age, strength: r.w });
    }
    return out;
  }

  update(dt: number) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
  }
}

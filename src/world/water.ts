import * as THREE from 'three';
import { toonGradient } from '../render/toon';
import { POND, POND_REACH, WATER_Y } from './pond';

/** Ripples alive at once; a new one replaces the oldest. */
const MAX_RIPPLES = 16;
/** Rings spread at this speed (m/s), about what small ripples on a real pond do. */
const RIPPLE_SPEED = 0.22;
/** Distance between a ripple's rings (m). */
const RIPPLE_WAVELENGTH = 0.022;
/** Height of a strength-1 ripple's rings (m). */
const RIPPLE_HEIGHT = 0.0025;
/** A ripple lasts base + perStrength * strength seconds. */
const RIPPLE_LIFE = { base: 1.2, perStrength: 1.4 };
/** Grid cells across the water sheet: ~1.5 cm, enough for the waves; ripple rings are shaded per pixel. */
const SEGMENTS = 160;

/**
 * Surface height above WATER_Y at a point of the sheet (pond-centred metres): a few slow crossing
 * swells, plus every live ripple, a packet of rings travelling out from where it started, widening
 * and fading as it goes. Shared by both shaders.
 */
const HEIGHT_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uRipples[${MAX_RIPPLES}];

float swellHeight(vec2 p) {
  return 0.0011 * sin(dot(p, vec2(17.0, 9.0)) - uTime * 1.3)
       + 0.0008 * sin(dot(p, vec2(-11.0, 23.0)) - uTime * 1.7)
       + 0.0005 * sin(dot(p, vec2(31.0, -26.0)) - uTime * 2.6);
}

float rippleHeight(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    float life = ${RIPPLE_LIFE.base.toFixed(2)} + ${RIPPLE_LIFE.perStrength.toFixed(2)} * r.w;
    if (r.w <= 0.0 || age < 0.0 || age > life) continue;
    float d = distance(p, r.xy);
    float front = ${RIPPLE_SPEED.toFixed(3)} * age;
    float width = 0.012 + 0.02 * r.w + 0.03 * age;
    float x = (d - front) / width;
    float fade = (1.0 - age / life) * (1.0 - age / life) / (1.0 + 12.0 * front);
    h += ${RIPPLE_HEIGHT.toFixed(4)} * r.w * fade * exp(-x * x) * cos(${((2 * Math.PI) / RIPPLE_WAVELENGTH).toFixed(2)} * (d - front));
  }
  return h;
}
`;

/**
 * The pond's surface: a translucent toon sheet over the bowl, seen from above and below, that
 * swells gently and carries ripples. Waves and ripples are all computed on the GPU from a time and
 * a short list of ripple origins; the vertices rise and fall with the swells, and each pixel's normal comes from
 * the same height function, so the rings (finer than the grid) shade crisply in the toon light bands.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private time = 0;
  private next = 0;
  private uniforms = {
    uTime: { value: 0 },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  };

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshToonMaterial({
      color: 0x5aa9b5,
      gradientMap: toonGradient(),
      transparent: true,
      opacity: 0.55,
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
        .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}\nvarying vec2 vWaterXZ;`)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          if (length(vWaterXZ) > ${POND_REACH.toFixed(3)}) discard;
          const float E = 0.0015;
          vec2 dx = vWaterXZ + vec2(E, 0.0);
          vec2 dz = vWaterXZ + vec2(0.0, E);
          float swell = swellHeight(vWaterXZ);
          float rings = rippleHeight(vWaterXZ);
          float h = swell + rings;
          vec2 slope = (vec2(swellHeight(dx) + rippleHeight(dx), swellHeight(dz) + rippleHeight(dz)) - h) / E;
          // Foam on ripple crests, and a faint glint along the swells' tops.
          float foam = smoothstep(0.0009, 0.0013, rings);
          float glint = smoothstep(0.0015, 0.0017, swell);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.98, 1.0), max(0.75 * foam, 0.2 * glint));
          diffuseColor.a = mix(diffuseColor.a, 0.85, foam);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `#include <normal_fragment_begin>
          normal = normalize(mat3(viewMatrix) * vec3(-slope.x, 1.0, -slope.y)) * faceDirection;`,
        );
    };

    const geometry = new THREE.PlaneGeometry(2 * POND_REACH, 2 * POND_REACH, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(POND.x, WATER_Y, POND.z);
    // The vertices move a few millimetres; don't let culling use the flat sheet's box.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'water';
    scene.add(this.mesh);
  }

  /** Start a ripple at world (x, z), `delay` seconds from now; strength ~0.3 for a gentle touch up to ~1.5 for a splash. */
  ripple(x: number, z: number, strength: number, delay = 0) {
    this.uniforms.uRipples.value[this.next].set(x - POND.x, z - POND.z, this.time + delay, strength);
    this.next = (this.next + 1) % MAX_RIPPLES;
  }

  /** Live ripples, newest last, for tests. */
  ripples(): { x: number; z: number; age: number; strength: number }[] {
    const out = [];
    for (let k = 0; k < MAX_RIPPLES; k++) {
      const r = this.uniforms.uRipples.value[(this.next + k) % MAX_RIPPLES];
      const age = this.time - r.z;
      if (r.w > 0 && age >= 0 && age <= RIPPLE_LIFE.base + RIPPLE_LIFE.perStrength * r.w) out.push({ x: r.x + POND.x, z: r.y + POND.z, age, strength: r.w });
    }
    return out;
  }

  update(dt: number) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
  }
}

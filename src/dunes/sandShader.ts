import * as THREE from 'three';
import { duneRipples, WIND } from './layout';

/**
 * Wind ripples on the dunes' open sand, too fine for the ground's 3 cm grid: drawn per pixel in
 * the ground's toon shader as thin shadowed lines across the wind, about 7 cm apart, wavering
 * along their length. Each vertex carries `aSand`, how much its ground shows them (none on lava,
 * down a burrow or wet at the shore). They fade out once they'd be finer than a couple of pixels.
 */
export function rippleAttribute(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  const sand = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) sand[i] = duneRipples(pos.getX(i), pos.getZ(i), pos.getY(i));
  geo.setAttribute('aSand', new THREE.BufferAttribute(sand, 1));
}

export function rippleSand(material: THREE.Material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSand;\nvarying float vSand;\nvarying vec2 vSandXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSand = aSand;\nvSandXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSand;\nvarying vec2 vSandXZ;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${RIPPLE_GLSL}`);
  };
  material.customProgramCacheKey = () => 'dune-sand';
}

const RIPPLE_GLSL = /* glsl */ `
{
  vec2 wind = vec2(${WIND.x.toFixed(3)}, ${WIND.z.toFixed(3)});
  vec2 across = vec2(-wind.y, wind.x);
  float along = dot(vSandXZ, across);
  float phase = dot(vSandXZ, wind) / 0.07 + 0.5 * sin(along / 0.35) + 0.22 * sin(along / 0.11 + dot(vSandXZ, wind) * 3.0);
  float f = fract(phase);
  // Each ripple: a gentle lit back, a sharp crest, a thin shadowed lee.
  float lee = smoothstep(0.62, 0.78, f) * (1.0 - smoothstep(0.86, 1.0, f));
  float crest = smoothstep(0.4, 0.6, f) * (1.0 - smoothstep(0.6, 0.66, f));
  float fade = 1.0 - smoothstep(0.18, 0.45, fwidth(phase));
  diffuseColor.rgb *= 1.0 + vSand * fade * (0.04 * crest - 0.08 * lee);
}
`;

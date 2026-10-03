import * as THREE from 'three';

/** Shared by every plant material: time drives the breeze. */
export const plantUniforms = {
  uTime: { value: 0 },
  /** Breeze sway (radians at the tip) along world X and Z. */
  uWind: { value: new THREE.Vector2(0.035, 0.02) },
};

/**
 * Bend an instanced plant mesh in the vertex shader. Each instance carries `aBend`, its tilt in its
 * own frame (radians, the vector points where the top leans). The stem pivots at its root by that
 * tilt and also curves along its length, tip further over than the base, so the drawn stem at any
 * height leans at least as far as the tilt the collision used. Vertices off the stem (leaves,
 * petals) swing with it, so a flower head tips over with its stalk. Adds a gentle breeze on top.
 */
export function bendPlants(material: THREE.Material, height: number) {
  const uHeight = { value: height };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = plantUniforms.uTime;
    shader.uniforms.uWind = plantUniforms.uWind;
    shader.uniforms.uHeight = uHeight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BEND_GLSL}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = plantBend(objectNormal, position.y, true);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = plantBend(transformed, position.y, false);');
  };
  // Same program for every plant kind; only uniform values differ.
  material.customProgramCacheKey = () => 'plant-bend';
}

const BEND_GLSL = /* glsl */ `
attribute vec2 aBend;
uniform float uTime;
uniform vec2 uWind;
uniform float uHeight;

vec2 plantTilt() {
  vec2 root = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  float phase = dot(root, vec2(7.3, 5.1));
  vec2 wind = uWind * vec2(sin(uTime * 1.7 + phase), sin(uTime * 2.3 + phase * 1.3));
  // The breeze is in world axes; express it in the instance's own (yawed) frame.
  vec2 ax = normalize(vec2(instanceMatrix[0].x, instanceMatrix[0].z));
  vec2 az = normalize(vec2(instanceMatrix[2].x, instanceMatrix[2].z));
  return aBend + vec2(dot(wind, ax), dot(wind, az));
}

// Pivot by tilt A at the root, plus curvature adding up to half of A again by the tip (capped so the
// tip never dips past horizontal). For a point: its height p.y rides along the curved stem, and its
// offset from the stem rotates by the stem's angle there. A normal (isNormal) only rotates, by the
// stem's angle at its vertex's height.
vec3 plantBend(vec3 p, float height, bool isNormal) {
  vec2 b = plantTilt();
  float A = length(b);
  if (A < 1e-4) return p;
  vec2 dir = b / A;
  float extra = clamp(min(0.5 * A, 1.5 - A), 0.0, 1.0);
  float k = extra / uHeight;
  float y = max(height, 0.0);
  float a = A + k * y;
  vec2 o = p.xz;
  float par = dot(o, dir);
  vec2 perp = o - dir * par;
  if (isNormal) {
    vec2 n = perp + dir * (par * cos(a) + p.y * sin(a));
    return vec3(n.x, p.y * cos(a) - par * sin(a), n.y);
  }
  float h, v;
  if (k * y < 1e-4) {
    h = y * sin(A);
    v = y * cos(A);
  } else {
    h = (cos(A) - cos(a)) / k;
    v = (sin(a) - sin(A)) / k;
  }
  vec2 q = perp + dir * (h + par * cos(a));
  return vec3(q.x, v - par * sin(a), q.y);
}
`;

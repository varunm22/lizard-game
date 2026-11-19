import * as THREE from 'three';
import { floorAirGrid } from './layout';

/** Colour of the rock's inside, as `rock.ts` draws its back faces. */
const INSIDE = "vec3(0.025, 0.021, 0.018)";

/** The cut stops this far (m, along the view) short of the point on the lizard the camera looks at. */
export const SECTION_SHORT = 0.035;
/** Rock up to this far (m) over the lizard's feet is kept: the floor it stands on and any just ahead. */
const FLOOR_KEEP = 0.008;
/** All rock this share of the way from the camera to the lizard is cut (the camera's own surroundings). */
const NEAR_SHARE = 0.45;
/** The lizard as the cut sees it, from its feet along its facing (m): snout, tail tip, and how wide round them. */
const SNOUT = 0.08;
const TAIL = 0.13;
const WIDTH = 0.04;

const fwd = new THREE.Vector3();
const head = new THREE.Vector3();
const tail = new THREE.Vector3();
const ndc = new THREE.Vector3();

/**
 * Keeps the lizard in sight in the tubes by cutting away only the rock that hides it. Rock nearer
 * the camera than a plane just short of the lizard, square to the view, is not drawn where it lies
 * over the lizard on screen (a band from snout to tail, a few centimetres wider), nor anywhere in the
 * nearer part of the way from the camera (the rock the eased camera may sit in). Rock beside the
 * lizard, past it, or at and below its feet is drawn as usual. Through a cut the eye sees into the
 * solid: the rock's back faces draw as its dark inside (`rock.ts`) and so does the ground inside the
 * rock (`darkenGroundUnderRock`), so nothing outside the maze shows except through real openings.
 */
export class RockSection {
  private uniforms = {
    sectionFrom: { value: new THREE.Vector3() },
    sectionDir: { value: new THREE.Vector3(0, 0, -1) },
    sectionDepth: { value: 0 },
    sectionNear: { value: 0 },
    sectionFloor: { value: -10 },
    sectionA: { value: new THREE.Vector2() },
    sectionB: { value: new THREE.Vector2() },
    sectionWidth: { value: 0 },
    sectionAspect: { value: 1 },
  };

  constructor(rock: THREE.Mesh) {
    const material = rock.material as THREE.Material;
    const before = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSectionWorld;\nvarying vec4 vSectionClip;')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvSectionWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSectionClip = gl_Position;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vSectionWorld;
varying vec4 vSectionClip;
uniform vec3 sectionFrom;
uniform vec3 sectionDir;
uniform float sectionDepth;
uniform float sectionNear;
uniform float sectionFloor;
uniform vec2 sectionA;
uniform vec2 sectionB;
uniform float sectionWidth;
uniform float sectionAspect;`,
        )
        .replace(
          'void main() {',
          `void main() {
  float sectionT = dot(vSectionWorld - sectionFrom, sectionDir);
  if (sectionT < sectionDepth && vSectionWorld.y > sectionFloor) {
    vec2 p = vSectionClip.xy / vSectionClip.w;
    p.x *= sectionAspect;
    vec2 ab = sectionB - sectionA;
    float h = clamp(dot(p - sectionA, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
    if (sectionT < sectionNear || length(p - sectionA - ab * h) < sectionWidth) discard;
  }`,
        );
    };
    material.customProgramCacheKey = () => 'rock-section';
  }

  /**
   * Each frame, after the camera is placed: the point on the lizard it looks at, and the lizard's
   * feet and facing (as its yaw).
   */
  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3, feet: THREE.Vector3, yaw: number) {
    const u = this.uniforms;
    camera.updateMatrixWorld();
    u.sectionFrom.value.copy(camera.position);
    const dir = u.sectionDir.value.subVectors(target, camera.position);
    const length = dir.length();
    dir.divideScalar(Math.max(length, 1e-5));
    u.sectionDepth.value = Math.max(0, length - SECTION_SHORT);
    u.sectionNear.value = length * NEAR_SHARE;
    u.sectionFloor.value = feet.y + FLOOR_KEEP;
    fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    head.copy(feet).addScaledVector(fwd, SNOUT).y += 0.025;
    tail.copy(feet).addScaledVector(fwd, -TAIL).y += 0.01;
    u.sectionAspect.value = camera.aspect;
    this.screen(head, camera, u.sectionA.value);
    this.screen(tail, camera, u.sectionB.value);
    u.sectionWidth.value = WIDTH / (Math.max(length, 0.01) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  /** Whether a world point is cut away (not drawn) right now, for the tests. */
  cuts(p: THREE.Vector3, camera: THREE.PerspectiveCamera) {
    const u = this.uniforms;
    if (p.y <= u.sectionFloor.value) return false;
    const t = new THREE.Vector3().subVectors(p, u.sectionFrom.value).dot(u.sectionDir.value);
    if (t >= u.sectionDepth.value) return false;
    if (t < u.sectionNear.value) return true;
    const q = this.screen(p, camera, new THREE.Vector2());
    const a = u.sectionA.value;
    const ab = new THREE.Vector2().subVectors(u.sectionB.value, a);
    const h = THREE.MathUtils.clamp(q.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-8), 0, 1);
    return q.sub(a).sub(ab.multiplyScalar(h)).length() < u.sectionWidth.value;
  }

  /** A world point on screen, x scaled by the aspect so screen distances are even both ways. */
  private screen(p: THREE.Vector3, camera: THREE.PerspectiveCamera, out: THREE.Vector2) {
    ndc.copy(p).project(camera);
    return out.set(ndc.x * camera.aspect, ndc.y);
  }
}

/**
 * The rock has no underside where it stands solid on the ground: the ground (the heightfield) closes
 * it. Normally no one sees the ground in there, but looking into the rock through the section's cut
 * would show it, light and sandy, so ground that lies inside the rock (not open on the lower floor,
 * `floorOpen`) draws as the rock's dark inside instead.
 */
export function darkenGroundUnderRock(terrain: THREE.Object3D) {
  const grid = floorAirGrid();
  const [sx, sz] = grid.size;
  const data = new Uint8Array(sx * sz);
  for (let n = 0; n < sx * sz; n++) data[n] = grid.bits[n >> 3] & (1 << (n & 7)) ? 255 : 0;
  const texture = new THREE.DataTexture(data, sx, sz, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  // Cell (i, k) is centred on origin + cell * (i, k); in texture space that's (i + 0.5) / size.
  const scale = new THREE.Vector2(1 / (grid.cell * sx), 1 / (grid.cell * sz));
  const offset = new THREE.Vector2((0.5 * grid.cell - grid.origin[0]) / (grid.cell * sx), (0.5 * grid.cell - grid.origin[1]) / (grid.cell * sz));
  terrain.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.Material;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { floorAir: { value: texture }, floorAirScale: { value: scale }, floorAirOffset: { value: offset } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vGroundWorld;\nuniform sampler2D floorAir;\nuniform vec2 floorAirScale;\nuniform vec2 floorAirOffset;',
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  vec2 airUv = vGroundWorld.xz * floorAirScale + floorAirOffset;
  if (all(greaterThanEqual(airUv, vec2(0.0))) && all(lessThan(airUv, vec2(1.0))) && texture2D(floorAir, airUv).r < 0.5) diffuseColor.rgb = ${INSIDE};`,
        );
    };
    material.customProgramCacheKey = () => 'ground-under-rock';
  });
}

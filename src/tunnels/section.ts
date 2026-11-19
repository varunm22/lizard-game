import * as THREE from 'three';
import { floorAirGrid } from './layout';

/** Colour of the rock's inside, as `rock.ts` draws its back faces. */
const INSIDE = "vec3(0.025, 0.021, 0.018)";

/** The cut stops this far (m, along the view) short of the point on the lizard the camera looks at. */
export const SECTION_SHORT = 0.035;
/** Rock up to this far (m) over the lizard's feet is kept: the floor it stands on and any just ahead. */
const FLOOR_KEEP = 0.008;

/**
 * A section view of the rock: the camera holds its distance (its arm passes through the rock), and
 * any rock nearer the camera than a plane just short of the lizard, square to the view, is not drawn,
 * except the floor at the lizard's feet and below. Where that plane slices the rock, the eye looks
 * into the solid and sees the rock's back faces, which draw as dark stone (`rock.ts`), so the cut
 * reads as a cut face of rock. The rock is one closed solid, so nothing outside the maze shows
 * through it: only real openings (skylights, the cove) let the sky in. Applies to the rock mesh only.
 */
export class RockSection {
  private uniforms = {
    sectionFrom: { value: new THREE.Vector3() },
    sectionDir: { value: new THREE.Vector3(0, 0, -1) },
    sectionDepth: { value: 0 },
    sectionFloor: { value: -10 },
  };

  constructor(rock: THREE.Mesh) {
    const material = rock.material as THREE.Material;
    const before = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSectionWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSectionWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vSectionWorld;\nuniform vec3 sectionFrom;\nuniform vec3 sectionDir;\nuniform float sectionDepth;\nuniform float sectionFloor;',
        )
        .replace(
          'void main() {',
          `void main() {
  if (dot(vSectionWorld - sectionFrom, sectionDir) < sectionDepth && vSectionWorld.y > sectionFloor) discard;`,
        );
    };
    material.customProgramCacheKey = () => 'rock-section';
  }

  /** Each frame: the camera, the point on the lizard it looks at, and the lizard's feet height. */
  update(camera: THREE.Vector3, target: THREE.Vector3, feetY: number) {
    const u = this.uniforms;
    u.sectionFrom.value.copy(camera);
    const dir = u.sectionDir.value.subVectors(target, camera);
    const length = dir.length();
    dir.divideScalar(Math.max(length, 1e-5));
    u.sectionDepth.value = Math.max(0, length - SECTION_SHORT);
    u.sectionFloor.value = feetY + FLOOR_KEEP;
  }

  /** Whether a world point is cut away (not drawn) right now. */
  cuts(p: THREE.Vector3) {
    const u = this.uniforms;
    return p.y > u.sectionFloor.value && new THREE.Vector3().subVectors(p, u.sectionFrom.value).dot(u.sectionDir.value) < u.sectionDepth.value;
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

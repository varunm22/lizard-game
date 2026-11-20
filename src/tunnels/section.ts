import * as THREE from 'three';
import { floorAirGrid } from './layout';

/** Colour of the rock's inside, as `rock.ts` draws its back faces. */
const INSIDE = "vec3(0.025, 0.021, 0.018)";

/** Rock up to this far (m) over the lizard's feet is kept: the floor it stands on and any just ahead. */
const FLOOR_KEEP = 0.008;

/**
 * Keeps the camera's view in the tubes clear by cutting away the rock nearer the camera than the
 * lizard: rock closer to the camera than to the point on the lizard it looks at isn't drawn (except
 * at and below the lizard's feet). Everything nearer the lizard, beside it, past it or under it is
 * drawn as usual. With the eased camera that's the rock round the camera, which it may sit in, and
 * anything on the near half of the way. Through a cut the eye sees into the solid: the rock's back
 * faces draw as its dark inside (`rock.ts`) and so does the ground inside the rock
 * (`darkenGroundUnderRock`), so nothing outside the maze shows except through real openings.
 */
export class RockSection {
  private uniforms = {
    sectionCamera: { value: new THREE.Vector3() },
    sectionTarget: { value: new THREE.Vector3() },
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
          '#include <common>\nvarying vec3 vSectionWorld;\nuniform vec3 sectionCamera;\nuniform vec3 sectionTarget;\nuniform float sectionFloor;',
        )
        .replace(
          'void main() {',
          `void main() {
  if (vSectionWorld.y > sectionFloor && distance(vSectionWorld, sectionCamera) < distance(vSectionWorld, sectionTarget)) discard;`,
        );
    };
    material.customProgramCacheKey = () => 'rock-section';
  }

  /** Each frame, after the camera is placed: the point on the lizard it looks at, and the lizard's feet height. */
  update(camera: THREE.Vector3, target: THREE.Vector3, feetY: number) {
    this.uniforms.sectionCamera.value.copy(camera);
    this.uniforms.sectionTarget.value.copy(target);
    this.uniforms.sectionFloor.value = feetY + FLOOR_KEEP;
  }

  /** Whether a world point is cut away (not drawn) right now, for the tests. */
  cuts(p: THREE.Vector3) {
    const u = this.uniforms;
    return p.y > u.sectionFloor.value && p.distanceTo(u.sectionCamera.value) < p.distanceTo(u.sectionTarget.value);
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

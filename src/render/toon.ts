import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let gradient: THREE.DataTexture | undefined;

/**
 * A skinned creature's bounding sphere, as measured at rest, is scaled up by this for frustum
 * culling, so a pose that reaches out (a claw, a wing, the tail) is never cut off at the screen edge.
 */
const POSE_REACH = 1.5;

/**
 * Light ramp shared by every toon material, for the bold cel look (`cel.ts`): deep shadow below
 * 0.6 of full light (14 of 24 texels), fully lit above.
 */
export function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    const ramp = Array.from({ length: 24 }, (_, i) => (i < 14 ? Math.round(0.22 * 255) : 255));
    gradient = new THREE.DataTexture(new Uint8Array(ramp), 24, 1, THREE.RedFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

/**
 * Swap the standard materials a GLB arrives with for flat toon materials of the same colour. A
 * skinned mesh in several materials (a creature: skin, eyes, claws...) is joined into one mesh, so
 * it is one draw call and one shadow draw rather than one per material, and given a bounding sphere
 * that holds every pose, so it can be culled off screen.
 */
export function toonify(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const swap = (m: THREE.Material) => {
      const src = m as THREE.MeshStandardMaterial;
      return new THREE.MeshToonMaterial({ color: src.color, map: src.map, gradientMap: toonGradient(), name: src.name });
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  joinSkinnedParts(root);
  root.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.geometry.computeBoundingSphere();
    mesh.boundingSphere = mesh.geometry.boundingSphere!.clone().applyMatrix4(mesh.bindMatrix);
    mesh.boundingSphere.radius *= POSE_REACH;
  });
}

/**
 * A toon material whose colour comes from the vertices, with the texture applied only where the
 * `textured` attribute is 1: the joined parts of a creature, some textured and some plain.
 * A subclass, not a patched instance, so a clone (an iguana's tint) keeps the patch.
 */
export class JoinedToonMaterial extends THREE.MeshToonMaterial {
  constructor(params: THREE.MeshToonMaterialParameters) {
    super({ ...params, vertexColors: true });
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float textured;\nvarying float vTextured;\nvoid main() {\n\tvTextured = textured;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vTextured;\nvoid main() {')
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace('diffuseColor *= sampledDiffuseColor;', 'diffuseColor *= mix( vec4( 1.0 ), sampledDiffuseColor, vTextured );'));
  }

  override customProgramCacheKey() {
    return 'joined-toon';
  }
}

/**
 * GLTFLoader draws a skinned mesh with several materials as sibling meshes, one per material, sharing
 * a skeleton. Join each such set into one mesh: each part's colour goes into its vertex colours, and
 * whether it was textured into `textured`, so it looks the same.
 */
function joinSkinnedParts(root: THREE.Object3D) {
  const sets = new Map<THREE.Object3D, THREE.SkinnedMesh[]>();
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.parent) return;
    if (!sets.has(mesh.parent)) sets.set(mesh.parent, []);
    sets.get(mesh.parent)!.push(mesh);
  });
  for (const [parent, parts] of sets) {
    if (parts.length < 2) continue;
    const materials = parts.map((p) => p.material as THREE.MeshToonMaterial);
    const maps = new Set(materials.map((m) => m.map?.source).filter((s) => s));
    if (maps.size > 1 || parts.some((p) => p.skeleton !== parts[0].skeleton || !p.bindMatrix.equals(parts[0].bindMatrix) || !p.matrix.equals(parts[0].matrix))) continue;
    const geometries = parts.map((p, i) => {
      const g = p.geometry.clone();
      const n = g.getAttribute('position').count;
      const colour = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) materials[i].color.toArray(colour, k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
      g.setAttribute('textured', new THREE.BufferAttribute(new Float32Array(n).fill(materials[i].map ? 1 : 0), 1));
      return g;
    });
    const geometry = mergeGeometries(geometries);
    if (!geometry) continue;
    const map = materials.find((m) => m.map)?.map ?? null;
    const joined = new THREE.SkinnedMesh(geometry, new JoinedToonMaterial({ map, gradientMap: toonGradient(), name: parent.name }));
    joined.name = parts[0].name;
    joined.matrix.copy(parts[0].matrix);
    joined.matrix.decompose(joined.position, joined.quaternion, joined.scale);
    joined.castShadow = joined.receiveShadow = true;
    joined.bind(parts[0].skeleton, parts[0].bindMatrix);
    for (const p of parts) {
      parent.remove(p);
      p.geometry.dispose();
    }
    parent.add(joined);
  }
}

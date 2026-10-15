import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let gradient: THREE.DataTexture | undefined;

/**
 * A skinned creature's bounding sphere, as measured at rest, is scaled up by this for frustum
 * culling, so a pose that reaches out (a claw, a wing, the tail) is never cut off at the screen edge.
 */
const POSE_REACH = 1.5;

/** Texels across the light ramp: enough to put a band edge where a render style wants it. */
const RAMP = 24;

/**
 * The shared ramp's texels, in red, for each direct-light level from facing away (0) to facing the
 * light (1). Green holds how far band edges are dithered (0 for hard edges) and blue the dither cell
 * in device pixels / 8; `render/style.ts` rewrites all three to change how every toon surface shades.
 */
export interface ToonRamp {
  /** Light at each band, 0 to 1, darkest first, and where each band after the first starts (0 to 1). */
  bands: { level: number; from: number }[];
  /** How far a band edge spreads into a dither, as a fraction of the ramp (0 for hard edges). */
  dither: number;
  /** Dither cell size in device pixels. */
  cell: number;
}

/** Three equal bands: shadow, mid, lit. */
export const CLASSIC_RAMP: ToonRamp = {
  bands: [{ level: 90 / 255, from: 0 }, { level: 170 / 255, from: 1 / 3 }, { level: 1, from: 2 / 3 }],
  dither: 0,
  cell: 1,
};

/** Light ramp shared by every toon material, three bands unless a render style sets another. */
export function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    gradient = new THREE.DataTexture(new Uint8Array(RAMP * 4), RAMP, 1, THREE.RGBAFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    setToonRamp(CLASSIC_RAMP);
  }
  return gradient;
}

/** Rewrite the shared light ramp: every toon surface shades by it from the next frame drawn. */
export function setToonRamp(ramp: ToonRamp) {
  const tex = toonGradient();
  const data = tex.image.data as Uint8Array;
  for (let i = 0; i < RAMP; i++) {
    const at = (i + 0.5) / RAMP;
    let level = ramp.bands[0].level;
    for (const b of ramp.bands) if (at >= b.from) level = b.level;
    data.set([Math.round(level * 255), Math.round(ramp.dither * 255), Math.round(Math.min(ramp.cell / 8, 1) * 255), 255], i * 4);
  }
  tex.needsUpdate = true;
}

// Every toon material looks its light up in the ramp here. Dither the lookup by a 4x4 Bayer pattern
// on screen, as far as the ramp's green says (none in the classic ramp), so band edges stipple.
const RAMP_LOOKUP = 'return vec3( texture2D( gradientMap, coord ).r );';
THREE.ShaderChunk.gradientmap_pars_fragment = THREE.ShaderChunk.gradientmap_pars_fragment.replace(
  RAMP_LOOKUP,
  `vec4 toonStyle = texture2D( gradientMap, vec2( 0.5, 0.5 ) );
		if ( toonStyle.g > 0.0 ) {
			ivec2 cell = ivec2( mod( floor( gl_FragCoord.xy / max( toonStyle.b * 8.0, 1.0 ) ), 4.0 ) );
			int bayer[ 16 ] = int[ 16 ]( 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 );
			coord.x += ( ( float( bayer[ cell.x + cell.y * 4 ] ) + 0.5 ) / 16.0 - 0.5 ) * toonStyle.g;
		}
		${RAMP_LOOKUP}`,
);

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

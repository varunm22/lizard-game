import * as THREE from 'three';
import type { LizardModel } from '../player/lizardModel';
import breedingUrl from '../assets/iguana-breeding.jpg';

/** The crest's colour on the plain lizard (assets-src/lizard.py `COLORS.Crest`, linear). */
const CREST = new THREE.Color().setRGB(0.2 ** 2.2, 0.205 ** 2.2, 0.215 ** 2.2);
/** The breeding male's crest: pale turquoise spines. */
const BREEDING_CREST = new THREE.Color(0x6fb3a8);

let texture: Promise<THREE.Texture> | null = null;

/** The breeding skin (assets-src/breeding_skin.py), laid out like the lizard's own. */
function breedingSkin(): Promise<THREE.Texture> {
  texture ??= new THREE.TextureLoader().loadAsync(breedingUrl).then((t) => {
    // As glTF textures are: not flipped, sRGB.
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  });
  return texture;
}

/**
 * Dress a lizard in the adult male's breeding colours: the red-and-turquoise skin, and turquoise
 * spines along its crest. `tint` dulls or warms it (another male, a female). Each model gets its
 * own material and colours, so others loaded from the same file keep theirs.
 */
export async function wearBreedingColours(model: LizardModel, tint = new THREE.Color(1, 1, 1), crest = BREEDING_CREST) {
  const map = await breedingSkin();
  model.root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material) => {
      const c = m.clone() as THREE.MeshToonMaterial;
      if (c.map) c.map = map;
      c.color.multiply(tint);
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    const colours = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colours) return;
    mesh.geometry = mesh.geometry.clone();
    const out = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < out.count; i++) {
      c.fromBufferAttribute(out, i);
      if (Math.abs(c.r - CREST.r) + Math.abs(c.g - CREST.g) + Math.abs(c.b - CREST.b) < 0.01) out.setXYZ(i, crest.r, crest.g, crest.b);
    }
    out.needsUpdate = true;
  });
}

import * as THREE from 'three';

let gradient: THREE.DataTexture | undefined;

/** Three-band light ramp shared by every toon material: shadow, mid, lit. */
export function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    gradient = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

/** Swap the standard materials a GLB arrives with for flat toon materials of the same colour. */
export function toonify(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const swap = (m: THREE.Material) => {
      const src = m as THREE.MeshStandardMaterial;
      return new THREE.MeshToonMaterial({ color: src.color, gradientMap: toonGradient(), name: src.name });
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

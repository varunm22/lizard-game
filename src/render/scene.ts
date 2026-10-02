import * as THREE from 'three';

export const PALETTE = {
  sky: 0xcfe6d8,
  ground: 0x8fb36a,
  stone: 0xb7ad9c,
  bark: 0x8a6446,
};

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createScene(container: HTMLElement): SceneContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.sky, 2, 8);

  // World units are metres; the lizard will be ~0.15 m long, so the camera sits low and close.
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0.6, 0.35, 0.9);
  camera.lookAt(0, 0.05, 0);

  scene.add(new THREE.HemisphereLight(0xdff2ff, 0x6b7d4a, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.position.set(1.5, 3, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const s = sun.shadow.camera;
  s.left = s.bottom = -1.5;
  s.right = s.top = 1.5;
  s.near = 0.1;
  s.far = 8;
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
}

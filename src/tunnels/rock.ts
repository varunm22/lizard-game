import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { loadGltf } from '../render/gltf';
import { FLOORS, JAMEO, rockColour, rockShade, SKYLIGHTS, TOP } from './layout';

/**
 * The tunnels' rock (`tunnels.glb`, from `assets-src/tunnels.py`): one mesh of every wall, roof and
 * upper floor, coloured here from the baked light and drawn unlit. The same triangles are its
 * collider, so the lizard stands on exactly what is drawn. Internal edges are fixed up so the
 * lizard's capsule slides over the seams of the upper floor's triangles without catching.
 */
export async function buildRock(url: string, scene: THREE.Scene, world: RAPIER.World) {
  const gltf = await loadGltf(url);
  let geometry: THREE.BufferGeometry | null = null;
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
  });
  const geo = geometry! as THREE.BufferGeometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  // Drawn faceted, each face coloured for where it faces, so every lump, ledge and broken block reads.
  const flat = geo.toNonIndexed();
  const fpos = flat.getAttribute('position') as THREE.BufferAttribute;
  // The generator's ambient occlusion, in the colour attribute.
  const ao = flat.getAttribute('color') as THREE.BufferAttribute | undefined;
  const colours = new Float32Array(fpos.count * 3);
  const c = new THREE.Color();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < fpos.count; i += 3) {
    a.fromBufferAttribute(fpos, i);
    b.fromBufferAttribute(fpos, i + 1);
    d.fromBufferAttribute(fpos, i + 2);
    n.subVectors(b, a).cross(d.clone().sub(a)).normalize();
    const occ = ao ? (ao.getX(i) + ao.getX(i + 1) + ao.getX(i + 2)) / 3 : 1;
    a.add(b).add(d).divideScalar(3);
    rockColour(a.x, a.y, a.z, n.y, c);
    c.multiplyScalar(rockShade(n.x, n.y, n.z, occ));
    for (let k = 0; k < 3; k++) c.toArray(colours, (i + k) * 3);
  }
  flat.deleteAttribute('normal');
  flat.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const mesh = new THREE.Mesh(flat, new THREE.MeshBasicMaterial({ vertexColors: true }));
  mesh.name = 'rock';
  scene.add(mesh);

  const vertices = new Float32Array(pos.array as ArrayLike<number>);
  const indices = new Uint32Array(geo.getIndex()!.array as ArrayLike<number>);
  const collider = world.createCollider(
    RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(1),
  );
  return { mesh, collider };
}

/**
 * Shafts of sunlight down each skylight and into the jameo: open cylinders slanted along the sun,
 * brightest at the top and fading down, added over the scene and never writing depth, so they read
 * as light in dusty air.
 */
export function buildSunbeams(scene: THREE.Scene, sun: THREE.Vector3) {
  const group = new THREE.Group();
  group.name = 'sunbeams';
  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vUp;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUp = uv.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      varying float vUp;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float face = abs(dot(normalize(vNormal), normalize(vView)));
        float a = 0.09 * smoothstep(0.0, 0.7, vUp) * (0.35 + 0.65 * face * face) * (0.9 + 0.1 * sin(vUp * 30.0 + time * 0.7));
        gl_FragColor = vec4(1.0, 0.93, 0.74, a);
      }`,
    transparent: true,
    depthWrite: false,
    // Seen from outside only: from inside a shaft the beam would haze the whole view.
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
  });
  const slant = sun.clone().normalize();
  for (const s of [...SKYLIGHTS.map((s) => ({ ...s, floor: FLOORS[1] })), { ...JAMEO, r: JAMEO.r * 0.75, floor: FLOORS[0] }]) {
    const height = TOP - s.floor;
    const along = height / slant.y;
    const geometry = new THREE.CylinderGeometry(s.r * 0.85, s.r * 0.85, along, 24, 1, true).translate(0, along / 2, 0);
    const beam = new THREE.Mesh(geometry, material);
    // Stand it on the sunlit patch, leaning back toward the sun.
    beam.position.set(s.x - (slant.x * height) / slant.y, s.floor, s.z - (slant.z * height) / slant.y);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), slant);
    beam.renderOrder = 5;
    beam.frustumCulled = false;
    group.add(beam);
  }
  scene.add(group);
  return { group, material };
}

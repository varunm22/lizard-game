import * as THREE from 'three';
import { terrainHeight } from '../world/terrain';
import { COLONY, NEST } from './layout';

/**
 * A column of light standing over a spot, seen from across the dunes: open-ended, glowing at its
 * foot and fading out upward, its sides brighter edge-on, unfogged and drawn over nothing (it never
 * writes depth), so it reads as a beacon rather than a solid thing.
 */
function column(radius: number, height: number, colour: THREE.ColorRepresentation, strength: number) {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, 48, 1, true).translate(0, height / 2, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: { colour: { value: new THREE.Color(colour) }, time: { value: 0 }, strength: { value: strength } },
    vertexShader: /* glsl */ `
      varying float vUp;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUp = position.y / ${height.toFixed(3)};
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 colour;
      uniform float time;
      uniform float strength;
      varying float vUp;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float edge = 1.0 - abs(dot(normalize(vNormal), normalize(vView)));
        float fade = pow(1.0 - vUp, 2.2);
        float shimmer = 0.85 + 0.15 * sin(vUp * 40.0 - time * 3.0);
        float a = strength * fade * (0.25 + 0.75 * edge * edge) * shimmer;
        gl_FragColor = vec4(colour, a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}

/** A glowing ring lying on the ground round a spot, following its rise and fall. */
function ring(x: number, z: number, radius: number, width: number, colour: THREE.ColorRepresentation) {
  const segments = 96;
  const positions: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    for (const [k, r] of [radius - width / 2, radius + width / 2].entries()) {
      const px = x + Math.sin(a) * r;
      const pz = z + Math.cos(a) * r;
      positions.push(px, terrainHeight(px, pz) + 0.004, pz);
      along.push(k);
    }
    if (i < segments) {
      const b = i * 2;
      index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('across', new THREE.Float32BufferAttribute(along, 1));
  geometry.setIndex(index);
  const material = new THREE.ShaderMaterial({
    uniforms: { colour: { value: new THREE.Color(colour) }, time: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float across;
      varying float vAcross;
      void main() {
        vAcross = across;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 colour;
      uniform float time;
      varying float vAcross;
      void main() {
        float band = 1.0 - abs(vAcross * 2.0 - 1.0);
        gl_FragColor = vec4(colour, band * (0.65 + 0.25 * sin(time * 2.5)));
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 9;
  return mesh;
}

/**
 * The run's start and finish, marked plainly: a pale ring and a low pillar of light over the nest
 * burrow, and a tall golden column of light and a ring round the adults at the end, visible over
 * the dunes from the start.
 */
export class Markers {
  readonly start = new THREE.Group();
  readonly finish = new THREE.Group();
  private shaders: THREE.ShaderMaterial[] = [];
  private time = 0;
  private finishColumn: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    const add = (group: THREE.Group, mesh: THREE.Mesh) => {
      group.add(mesh);
      this.shaders.push(mesh.material as THREE.ShaderMaterial);
    };
    const nestY = terrainHeight(NEST.x, NEST.z);
    const startColumn = column(0.12, 0.22, 0xbfe6ff, 0.35);
    startColumn.position.set(NEST.x, nestY - 0.02, NEST.z);
    add(this.start, startColumn);
    add(this.start, ring(NEST.x, NEST.z, 0.16, 0.014, 0xcfeeff));
    this.start.name = 'start-marker';

    const finishColumn = column(COLONY.r, 3.2, 0xffc94a, 0.75);
    finishColumn.position.set(COLONY.x, terrainHeight(COLONY.x, COLONY.z) - 0.05, COLONY.z);
    add(this.finish, finishColumn);
    this.finishColumn = finishColumn.material as THREE.ShaderMaterial;
    add(this.finish, ring(COLONY.x, COLONY.z, COLONY.r, 0.03, 0xffd35a));
    this.finish.name = 'finish-marker';
    scene.add(this.start, this.finish);
  }

  /** Each frame: the shimmer, and the finish column dimmed as the camera comes in under it. */
  update(dt: number, camera: THREE.Vector3) {
    this.time += dt;
    for (const m of this.shaders) m.uniforms.time.value = this.time;
    const d = Math.hypot(camera.x - COLONY.x, camera.z - COLONY.z);
    this.finishColumn.uniforms.strength.value = 0.75 * THREE.MathUtils.smoothstep(d, COLONY.r + 0.3, COLONY.r + 2.5);
  }
}

import * as THREE from 'three';
import { terrainHeight } from '../world/terrain';

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

const SAFE_COLOUR = 0x7fe3d4;
const SAFE_REACHED = 0xb6f0a0;

/** A glowing ring lying on the ground round a spot, following its rise and fall. */
function ring(x: number, z: number, radius: number, width: number, colour: THREE.ColorRepresentation, ground: (x: number, z: number) => number) {
  const segments = 96;
  const positions: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    for (const [k, r] of [radius - width / 2, radius + width / 2].entries()) {
      const px = x + Math.sin(a) * r;
      const pz = z + Math.cos(a) * r;
      positions.push(px, ground(px, pz) + 0.004, pz);
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
 * The run's start, safe points and finish, marked plainly: a pale ring and a low pillar of light
 * over the nest burrow; a teal column and ring at each safe point's crevice, turning pale green once
 * reached; and a tall golden column of light and a ring round the adults at the end, visible over
 * the dunes from the start. Columns dim as the camera comes in under them.
 */
/** Where a run starts and ends, and its safe points (world m; `r` the radius each counts within). */
export interface Marks {
  start: { x: number; z: number };
  finish: { x: number; z: number; r: number };
  safe: readonly { x: number; z: number; r: number }[];
  /** The ground the marks stand on, where that isn't the heightfield (the lava tunnels' upper floor). */
  ground?: (x: number, z: number) => number;
}

export class Markers {
  readonly start = new THREE.Group();
  readonly finish = new THREE.Group();
  private shaders: THREE.ShaderMaterial[] = [];
  private time = 0;
  private finishColumn: THREE.ShaderMaterial;
  readonly safe: THREE.Group[] = [];
  private safeColumns: THREE.ShaderMaterial[] = [];
  private safeRings: THREE.ShaderMaterial[] = [];
  private safeStrength: number[] = [];

  constructor(
    scene: THREE.Scene,
    private marks: Marks,
  ) {
    const { start: NEST, finish: COLONY, safe: SAFE_POINTS } = marks;
    const add = (group: THREE.Group, mesh: THREE.Mesh) => {
      group.add(mesh);
      this.shaders.push(mesh.material as THREE.ShaderMaterial);
    };
    const ground = marks.ground ?? terrainHeight;
    const nestY = ground(NEST.x, NEST.z);
    const startColumn = column(0.12, 0.22, 0xbfe6ff, 0.35);
    startColumn.position.set(NEST.x, nestY - 0.02, NEST.z);
    add(this.start, startColumn);
    add(this.start, ring(NEST.x, NEST.z, 0.16, 0.014, 0xcfeeff, ground));
    this.start.name = 'start-marker';

    const finishColumn = column(COLONY.r, 3.2, 0xffc94a, 0.75);
    finishColumn.position.set(COLONY.x, ground(COLONY.x, COLONY.z) - 0.05, COLONY.z);
    add(this.finish, finishColumn);
    this.finishColumn = finishColumn.material as THREE.ShaderMaterial;
    add(this.finish, ring(COLONY.x, COLONY.z, COLONY.r, 0.03, 0xffd35a, ground));
    this.finish.name = 'finish-marker';
    scene.add(this.start, this.finish);

    for (const [i, p] of SAFE_POINTS.entries()) {
      const group = new THREE.Group();
      const c = column(p.r * 0.8, 1.4, SAFE_COLOUR, 0.55);
      c.position.set(p.x, ground(p.x, p.z) - 0.03, p.z);
      add(group, c);
      const r = ring(p.x, p.z, p.r, 0.016, SAFE_COLOUR, ground);
      add(group, r);
      group.name = `safe-marker-${i}`;
      scene.add(group);
      this.safe.push(group);
      this.safeColumns.push(c.material as THREE.ShaderMaterial);
      this.safeRings.push(r.material as THREE.ShaderMaterial);
      this.safeStrength.push(0.55);
    }
  }

  /** Safe point `i` reached (pale green), or not yet (teal), as on a fresh run. */
  reached(i: number, yes: boolean) {
    const colour = yes ? SAFE_REACHED : SAFE_COLOUR;
    this.safeColumns[i].uniforms.colour.value.set(colour);
    this.safeRings[i].uniforms.colour.value.set(colour);
    this.safeStrength[i] = yes ? 0.3 : 0.55;
  }

  /** Each frame: the shimmer, and the finish column dimmed as the camera comes in under it. */
  update(dt: number, camera: THREE.Vector3) {
    this.time += dt;
    for (const m of this.shaders) m.uniforms.time.value = this.time;
    const { finish: COLONY, safe: SAFE_POINTS } = this.marks;
    const d = Math.hypot(camera.x - COLONY.x, camera.z - COLONY.z);
    this.finishColumn.uniforms.strength.value = 0.75 * THREE.MathUtils.smoothstep(d, COLONY.r + 0.3, COLONY.r + 2.5);
    SAFE_POINTS.forEach((p, i) => {
      const near = Math.hypot(camera.x - p.x, camera.z - p.z);
      this.safeColumns[i].uniforms.strength.value = this.safeStrength[i] * THREE.MathUtils.smoothstep(near, 0.35, 1.5);
    });
  }
}

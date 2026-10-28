import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonGradient } from '../render/toon';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { WATER_Y, shoreX } from '../world/shore';
import { covers, type Obstacle } from '../world/obstacles';
import type { Pusher } from '../world/plantSpring';
import type { PropsResult } from '../world/props';
import { crackHalf, crackX, overCrack } from './crack';

/** The manzanillo leans out over the sea: apples drop round a spot this far seaward (+X) of its trunk, up to this far from it, always into the water (m). */
const SEAWARD = 0.28;
const DROP_SPREAD = 0.2;
/** An apple's radius (m). */
export const APPLE_R = 0.02;
/** Ripe green-yellow, blushed red down one side, with a brown stalk on top and a dark dimple underneath. */
const APPLE_COLOUR = 0xbcc44a;
const BLUSH_COLOUR = 0xc86a3a;
const STEM_COLOUR = 0x5a4632;
const EYE_COLOUR = 0x4e5a24;
/** Afloat, an apple bobs this much (m) and this fast (rad/s); the water drags it to a stop at this rate (1/s), and the swell carries it out to drift about this far offshore (m, from the waterline), at most this fast (m/s), wandering along the shore. */
const BOB = { height: 0.003, rate: 2.2 };
const WATER_DRAG = 2.5;
const OFFSHORE = 0.45;
const DRIFT = 0.025;
const WANDER = 0.012;
/** Apples afloat under the tree at the start; a new one ripens and drops every so often (s, from-to) while fewer than MAX are about. */
const START_APPLES = 2;
const RIPEN = [25, 40] as const;
const MAX = 4;
/** Pushed, an apple keeps rolling a little, slowing at this rate (1/s), and never faster than this (m/s). */
const ROLL_DAMP = 7;
const MAX_ROLL = 1.2;
const GRAVITY = 9.81;
const DAMP_STEP = (dt: number) => Math.exp(-ROLL_DAMP * dt);
/** An apple this far either side of the snout's line (m) is in front of it, and nosed along; each step it drifts in to this share of its offset. */
const NOSE_WIDTH = 0.02;
const NOSE_CENTRE = 0.97;
/** How far up it bounces off the ground the first time (share of its fall speed). */
const BOUNCE = 0.25;

export interface Apple {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 'falling' from the crown, 'floating' in the sea, 'lying' on the ground (where it can be pushed and eaten), 'lost' in the crack, or 'eaten'. */
  state: 'falling' | 'floating' | 'lying' | 'lost' | 'eaten';
  /** Brought ashore by the lizard: it was pushed while afloat and has washed up on the beach. */
  landed: boolean;
  /** Its own phase for bobbing and wandering on the water. */
  phase: number;
  /** Times the lizard has pushed it (steps). */
  pushed: number;
  /** How it's turned: it rolls as it goes, so its stem comes round. */
  turn: THREE.Quaternion;
}

/**
 * A manzanillo at the back of the beach (`manzanillo` in props.glb: the poison apple, a short stout trunk
 * under a dense, rounded crown hung with apples) and its fruit. Its crown leans over the sea, so ripe apples drop now and then
 * into the shallows, where they bob and drift out to linger off the beach. They're drawn, not
 * simulated: a swimming lizard noses one ashore, where it washes up and lies on the sand; on land the
 * lizard's body nudges it along ahead of it, it rolls on a little, it stops against rocks and trunks,
 * and one pushed over the crack's rim drops in for good. The tortoise goes out of its way for apples on
 * land (`tortoise.ts`).
 */
export class Apples {
  readonly list: Apple[] = [];
  readonly tree: Obstacle;
  private rand = rng(61);
  private ripen: number;
  private mesh: THREE.InstancedMesh;
  private matrix = new THREE.Matrix4();
  private time = 0;
  /** An apple splashing into the sea, for a ripple. */
  onSplash: ((x: number, z: number) => void) | null = null;
  /** Where ripe apples drop from, above the tree's foot (m). */
  private crownY: number;

  constructor(
    scene: THREE.Scene,
    world: RAPIER.World,
    at: { x: number; z: number },
    model: PropsResult['appleTree'],
    private obstacles: () => readonly Obstacle[],
  ) {
    this.tree = plantTree(scene, world, at, model);
    this.crownY = model.extras.crown_y;
    const geometry = appleGeometry();
    const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
    this.mesh = new THREE.InstancedMesh(geometry, material, 16);
    this.mesh.name = 'apples';
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.ripen = this.spell();
  }

  private spell() {
    return RIPEN[0] + (RIPEN[1] - RIPEN[0]) * this.rand();
  }

  /** Apples on the ground, where they can be pushed and eaten. */
  get lying(): Apple[] {
    return this.list.filter((f) => f.state === 'lying');
  }

  /** A ripe apple drops from the crown into the sea (or, at the start, is already afloat). */
  drop(afloat = false): Apple {
    // Somewhere under the crown's seaward side that's water, not sand or a rock.
    let x = this.tree.position.x + SEAWARD;
    let z = this.tree.position.z;
    for (let k = 0; k < 12; k++) {
      const a = this.rand() * 2 * Math.PI;
      const d = DROP_SPREAD * Math.sqrt(this.rand());
      const tx = this.tree.position.x + SEAWARD + Math.cos(a) * d;
      const tz = this.tree.position.z + Math.sin(a) * d;
      if (terrainHeight(tx, tz) + APPLE_R < WATER_Y && !this.obstacles().some((o) => covers(o, tx, tz, APPLE_R))) {
        [x, z] = [tx, tz];
        break;
      }
    }
    // Lying on its side, the stem pointing some way along the ground.
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, this.rand() * 2 * Math.PI, 0, 'YXZ'));
    const apple: Apple = {
      x,
      y: afloat ? WATER_Y : this.tree.position.y + this.crownY,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      state: afloat ? 'floating' : 'falling',
      pushed: 0,
      turn,
      landed: false,
      phase: this.rand() * 2 * Math.PI,
    };
    this.list.push(apple);
    return apple;
  }

  /** The tortoise eats it. */
  eat(apple: Apple) {
    apple.state = 'eaten';
  }

  /** Tests: put apple `i` at (x, z), lying still (afloat, if that's in the sea). */
  place(i: number, x: number, z: number) {
    const f = this.list[i];
    const ground = terrainHeight(x, z) + APPLE_R;
    Object.assign(f, { x, z, y: Math.max(ground, WATER_Y), vx: 0, vy: 0, vz: 0, state: ground < WATER_Y ? 'floating' : 'lying', landed: false });
  }

  /**
   * One fixed step: apples ripen and fall, and the lizard's body spheres push those lying in its way,
   * on the way it's heading (`ahead`, a level unit vector) as much as straight out from the sphere, so
   * one nosed along stays in front of the snout instead of slipping off to the side.
   */
  step(dt: number, pushers: readonly Pusher[], ahead: { x: number; z: number }) {
    // The first few are already afloat (dropped here, once what they stop against is all laid out).
    if (this.time === 0) for (let i = 0; i < START_APPLES; i++) this.drop(true);
    this.time += dt;
    this.ripen -= dt;
    if (this.ripen <= 0) {
      this.ripen = this.spell();
      if (this.list.filter((f) => f.state === 'falling' || f.state === 'floating' || f.state === 'lying').length < MAX) this.drop();
    }
    for (const f of this.list) {
      if (f.state === 'falling') this.fall(f, dt);
      else if (f.state === 'floating') this.float(f, dt, pushers, ahead);
      else if (f.state === 'lying') this.roll(f, dt, pushers, ahead);
      else if (f.state === 'lost') this.sink(f, dt);
    }
  }

  private fall(f: Apple, dt: number) {
    f.vy -= GRAVITY * dt;
    f.y += f.vy * dt;
    const ground = terrainHeight(f.x, f.z) + APPLE_R;
    if (ground < WATER_Y && f.y <= WATER_Y) {
      // Into the sea: a splash, and it floats.
      f.y = WATER_Y;
      f.vy = 0;
      f.state = 'floating';
      this.onSplash?.(f.x, f.z);
      return;
    }
    if (f.y > ground) return;
    f.y = ground;
    // One small bounce, then it lies there.
    if (f.vy < -0.5) f.vy = -f.vy * BOUNCE;
    else {
      f.vy = 0;
      f.state = 'lying';
    }
  }

  /** Gone over the rim: it drops on down the crack, between its walls, and lies at the bottom. */
  private sink(f: Apple, dt: number) {
    if (f.y <= terrainHeight(f.x, f.z) + APPLE_R && f.vy === 0 && f.vx === 0 && f.vz === 0) return;
    f.vy -= GRAVITY * dt;
    f.y += f.vy * dt;
    f.vx *= DAMP_STEP(dt);
    f.vz *= DAMP_STEP(dt);
    // Down the sloping floor into the slot at the bottom.
    const mid = crackX(f.z);
    const room = Math.max(0, crackHalf(f.z) - APPLE_R * 1.5);
    f.vx += Math.sign(mid - f.x) * GRAVITY * 0.5 * dt * (f.y < terrainHeight(f.x, f.z) + APPLE_R * 2 ? 1 : 0);
    const nx = Math.min(mid + room, Math.max(mid - room, f.x + f.vx * dt));
    const nz = f.z + f.vz * dt;
    const d = Math.hypot(nx - f.x, nz - f.z);
    if (d > 1e-7) f.turn.premultiply(ROLL.setFromAxisAngle(AXIS.set((nz - f.z) / d, 0, -(nx - f.x) / d), d / APPLE_R));
    f.x = nx;
    f.z = nz;
    const ground = terrainHeight(f.x, f.z) + APPLE_R;
    if (f.y <= ground) {
      f.y = ground;
      f.vy = 0;
      // At rest once it's down in the slot.
      if (Math.abs(f.x - mid) < APPLE_R) f.vx = f.vz = 0;
    }
  }

  /** How far the lizard's body pushes `f` this step (m, along the ground or the water). */
  private push(f: Apple, pushers: readonly Pusher[], ahead: { x: number; z: number }): [number, number] {
    let px = 0;
    let pz = 0;
    // Just in front of the snout (the first sphere), it's nosed along: kept ahead of it, drifting
    // toward the middle, rather than slipping off to the side of a round snout.
    const [nose, ...body] = pushers;
    const rx = f.x - nose.x;
    const rz = f.z - nose.z;
    const fore = rx * ahead.x + rz * ahead.z;
    const side = rx * ahead.z - rz * ahead.x;
    const front = nose.r + APPLE_R;
    if (Math.abs(nose.y - f.y) < front + 0.01 && fore > -APPLE_R * 0.5 && fore < front && Math.abs(side) < NOSE_WIDTH + APPLE_R * 0.5) {
      const keep = side * NOSE_CENTRE;
      px = nose.x + ahead.x * front + ahead.z * keep - f.x;
      pz = nose.z + ahead.z * front - ahead.x * keep - f.z;
    }
    // Anywhere else, pushed out of every body sphere it's inside, sideways along the ground.
    for (const s of body) {
      if (Math.abs(s.y - f.y) > s.r + APPLE_R) continue;
      const dx = f.x + px - s.x;
      const dz = f.z + pz - s.z;
      const d = Math.hypot(dx, dz);
      const reach = s.r + APPLE_R;
      if (d >= reach || d < 1e-6) continue;
      px += (dx / d) * (reach - d);
      pz += (dz / d) * (reach - d);
    }
    return [px, pz];
  }

  /** Afloat: it bobs on the swell and drifts out to linger off the beach, nosed along by a swimming lizard; pushed into the shallows, it washes up and lies on the sand. */
  private float(f: Apple, dt: number, pushers: readonly Pusher[], ahead: { x: number; z: number }) {
    const [px, pz] = this.push(f, pushers, ahead);
    if (px !== 0 || pz !== 0) {
      f.pushed++;
      f.vx = px / dt;
      f.vz = pz / dt;
    } else {
      // Carried out to linger off the beach, wandering along it.
      const settle = 1 - Math.exp(-WATER_DRAG * dt);
      const out = OFFSHORE - (f.x - shoreX(f.z));
      const want = THREE.MathUtils.clamp(out, -1, 1) * DRIFT;
      f.vx += (want - f.vx) * settle;
      f.vz += (WANDER * Math.sin(this.time * 0.13 + f.phase) - f.vz) * settle;
    }
    const nx = f.x + f.vx * dt;
    const nz = f.z + f.vz * dt;
    if (this.obstacles().some((o) => o.kind !== 'log' && covers(o, nx, nz, APPLE_R))) {
      f.vx = f.vz = 0;
    } else {
      const d = Math.hypot(nx - f.x, nz - f.z);
      if (d > 1e-7) f.turn.premultiply(ROLL.setFromAxisAngle(AXIS.set((nz - f.z) / d, 0, -(nx - f.x) / d), d / APPLE_R));
      f.x = nx;
      f.z = nz;
    }
    f.y = WATER_Y + BOB.height * Math.sin(this.time * BOB.rate + f.phase);
    // Run aground: it's on the sand now.
    const ground = terrainHeight(f.x, f.z) + APPLE_R;
    if (ground >= WATER_Y - 0.004) {
      f.y = ground;
      f.vx = f.vz = 0;
      f.state = 'lying';
      if (f.pushed > 0) f.landed = true;
    }
  }

  private roll(f: Apple, dt: number, pushers: readonly Pusher[], ahead: { x: number; z: number }) {
    const [px, pz] = this.push(f, pushers, ahead);
    if (px !== 0 || pz !== 0) {
      f.pushed++;
      // It goes where it's pushed this step, then rolls on a little.
      f.vx = px / dt / DAMP_STEP(dt);
      f.vz = pz / dt / DAMP_STEP(dt);
      const v = Math.hypot(f.vx, f.vz);
      if (v > MAX_ROLL) {
        f.vx *= MAX_ROLL / v;
        f.vz *= MAX_ROLL / v;
      }
    }
    f.vx *= DAMP_STEP(dt);
    f.vz *= DAMP_STEP(dt);
    if (Math.hypot(f.vx, f.vz) < 1e-4) return;
    // Stopped by anything solid, sliding along it if it can.
    const blocked = (x: number, z: number) => this.obstacles().some((o) => o.kind !== 'log' && covers(o, x, z, APPLE_R));
    let nx = f.x + f.vx * dt;
    let nz = f.z + f.vz * dt;
    if (blocked(nx, nz)) {
      if (!blocked(nx, f.z)) [nz, f.vz] = [f.z, 0];
      else if (!blocked(f.x, nz)) [nx, f.vx] = [f.x, 0];
      else {
        f.vx = f.vz = 0;
        return;
      }
    }
    // Rolling, not sliding: it turns about the level axis across its travel, a radian per radius gone.
    const dx = nx - f.x;
    const dz = nz - f.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-7) f.turn.premultiply(ROLL.setFromAxisAngle(AXIS.set(dz / d, 0, -dx / d), d / APPLE_R));
    f.x = nx;
    f.z = nz;
    // Over the rim of the crack it drops in, out of reach for good; it falls from the rim's height.
    if (overCrack(f.x, f.z)) f.state = 'lost';
    else f.y = terrainHeight(f.x, f.z) + APPLE_R;
    // Pushed back into the sea, it floats off again.
    if (f.state === 'lying' && f.y < WATER_Y - 0.004) {
      f.y = WATER_Y;
      f.state = 'floating';
    }
  }

  /** Draw the apples where they are now. */
  update() {
    let n = 0;
    for (const f of this.list) {
      if (f.state === 'eaten') continue;
      this.matrix.compose(POS.set(f.x, f.y, f.z), f.turn, ONE);
      this.mesh.setMatrixAt(n++, this.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const ROLL = new THREE.Quaternion();
const AXIS = new THREE.Vector3();
const POS = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** An apple: round, a little flattened, a short stalk on top (+Y) and a dimple underneath, blushed down one side, so you can see it turn. One mesh, coloured by vertex. */
function appleGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(APPLE_R, 12, 8).toNonIndexed();
  body.deleteAttribute('uv');
  const pos = body.getAttribute('position');
  const colour = new Float32Array(pos.count * 3);
  const base = new THREE.Color(APPLE_COLOUR);
  const blush = new THREE.Color(BLUSH_COLOUR);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // Flattened, and pulled in at the top round the stalk.
    const y = pos.getY(i) / APPLE_R;
    const dip = y > 0.8 ? 0.25 * (y - 0.8) * 5 : 0;
    pos.setY(i, pos.getY(i) * 0.9 - dip * APPLE_R * 0.3);
    // The blush on the +X side.
    c.copy(base).lerp(blush, THREE.MathUtils.smoothstep(pos.getX(i) / APPLE_R, 0.1, 0.9) * 0.6);
    colour.set([c.r, c.g, c.b], i * 3);
  }
  body.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  body.computeVertexNormals();
  const stem = new THREE.CylinderGeometry(APPLE_R * 0.1, APPLE_R * 0.14, APPLE_R * 0.6, 5).translate(0, APPLE_R * 1.0, 0);
  const eye = new THREE.CylinderGeometry(APPLE_R * 0.25, APPLE_R * 0.25, APPLE_R * 0.1, 8).translate(0, -APPLE_R * 0.87, 0);
  const coloured = (g: THREE.BufferGeometry, color: number) => {
    const geo = g.toNonIndexed();
    geo.deleteAttribute('uv');
    const c = new THREE.Color(color);
    const n = geo.getAttribute('position').count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat()), 3));
    return geo;
  };
  return mergeGeometries([body, coloured(stem, STEM_COLOUR), coloured(eye, EYE_COLOUR)])!;
}

/** The manzanillo from props.glb, standing at `at`; solid at the trunk, up to where it forks. */
function plantTree(scene: THREE.Scene, world: RAPIER.World, at: { x: number; z: number }, model: PropsResult['appleTree']): Obstacle {
  const { trunk_radius: radius, trunk_height: height } = model.extras;
  const mesh = new THREE.Mesh(model.geometry, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() }));
  const y = terrainHeight(at.x, at.z) - 0.01;
  mesh.position.set(at.x, y, at.z);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'manzanillo';
  scene.add(mesh);
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cylinder(height / 2 + 0.03, radius).setTranslation(at.x, y + height / 2 - 0.03, at.z).setFriction(0.9),
  );
  return { name: 'manzanillo', kind: 'tree', position: mesh.position, height, radius, mesh, collider };
}

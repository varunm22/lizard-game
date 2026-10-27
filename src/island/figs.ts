import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonGradient } from '../render/toon';
import { PALETTE } from '../render/scene';
import { rng } from '../world/noise';
import { terrainHeight } from '../world/terrain';
import { covers, type Obstacle } from '../world/obstacles';
import type { Pusher } from '../world/plantSpring';
import { overCrack } from './crack';

/** The fig tree's trunk, crown and how far out under it figs land (m). */
const TRUNK = { radius: 0.06, height: 0.62 };
const CROWN = { y: 0.66, radius: 0.42 };
const DROP_RING = [0.2, 0.36] as const;
/** A fig's radius (m). */
export const FIG_R = 0.02;
/** Ripe purple. */
const FIG_COLOUR = 0x8a3a78;
/** Figs lying under the tree at the start; a new one ripens and drops every so often (s, from-to) while fewer than MAX are about. */
const START_FIGS = 2;
const RIPEN = [25, 40] as const;
const MAX = 4;
/** Pushed, a fig keeps rolling a little, slowing at this rate (1/s), and never faster than this (m/s). */
const ROLL_DAMP = 7;
const MAX_ROLL = 1.2;
const GRAVITY = 9.81;
const DAMP_STEP = (dt: number) => Math.exp(-ROLL_DAMP * dt);
/** A fig this far either side of the snout's line (m) is in front of it, and nosed along; each step it drifts in to this share of its offset. */
const NOSE_WIDTH = 0.02;
const NOSE_CENTRE = 0.97;
/** How far up it bounces off the ground the first time (share of its fall speed). */
const BOUNCE = 0.25;

export interface Fig {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 'falling' from the crown, 'lying' on the ground (where it can be pushed and eaten), 'lost' in the crack, or 'eaten'. */
  state: 'falling' | 'lying' | 'lost' | 'eaten';
  /** Times the lizard has pushed it (steps). */
  pushed: number;
}

/**
 * A fig tree at the forest edge (drawn here, not in props.glb: a stout trunk under a broad crown hung
 * with figs) and its fruit. Ripe figs drop now and then and lie under it. They're drawn, not
 * simulated: the lizard's body nudges one along the ground ahead of it, it rolls on a little, it
 * stops against rocks and trunks, and one pushed over the crack's rim drops in for good. The
 * tortoise goes out of its way for them (`tortoise.ts`).
 */
export class Figs {
  readonly list: Fig[] = [];
  readonly tree: Obstacle;
  private rand = rng(61);
  private ripen: number;
  private mesh: THREE.InstancedMesh;
  private matrix = new THREE.Matrix4();

  constructor(
    scene: THREE.Scene,
    world: RAPIER.World,
    at: { x: number; z: number },
    private obstacles: () => readonly Obstacle[],
  ) {
    this.tree = buildTree(scene, world, at);
    const geometry = new THREE.IcosahedronGeometry(FIG_R, 1).scale(1, 1.15, 1);
    const material = new THREE.MeshToonMaterial({ color: FIG_COLOUR, gradientMap: toonGradient() });
    this.mesh = new THREE.InstancedMesh(geometry, material, 16);
    this.mesh.name = 'figs';
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    for (let i = 0; i < START_FIGS; i++) this.drop(true);
    this.ripen = this.spell();
  }

  private spell() {
    return RIPEN[0] + (RIPEN[1] - RIPEN[0]) * this.rand();
  }

  /** Figs on the ground, where they can be pushed and eaten. */
  get lying(): Fig[] {
    return this.list.filter((f) => f.state === 'lying');
  }

  /** A ripe fig drops from the crown (or, at the start, is already lying under it). */
  drop(lying = false): Fig {
    const a = this.rand() * 2 * Math.PI;
    const d = DROP_RING[0] + (DROP_RING[1] - DROP_RING[0]) * this.rand();
    const x = this.tree.position.x + Math.cos(a) * d;
    const z = this.tree.position.z + Math.sin(a) * d;
    const ground = terrainHeight(x, z) + FIG_R;
    const fig: Fig = { x, y: lying ? ground : this.tree.position.y + CROWN.y, z, vx: 0, vy: 0, vz: 0, state: lying ? 'lying' : 'falling', pushed: 0 };
    this.list.push(fig);
    return fig;
  }

  /** The tortoise eats it. */
  eat(fig: Fig) {
    fig.state = 'eaten';
  }

  /** Tests: put fig `i` at (x, z), lying still. */
  place(i: number, x: number, z: number) {
    const f = this.list[i];
    Object.assign(f, { x, z, y: terrainHeight(x, z) + FIG_R, vx: 0, vy: 0, vz: 0, state: 'lying' });
  }

  /**
   * One fixed step: figs ripen and fall, and the lizard's body spheres push those lying in its way,
   * on the way it's heading (`ahead`, a level unit vector) as much as straight out from the sphere, so
   * one nosed along stays in front of the snout instead of slipping off to the side.
   */
  step(dt: number, pushers: readonly Pusher[], ahead: { x: number; z: number }) {
    this.ripen -= dt;
    if (this.ripen <= 0) {
      this.ripen = this.spell();
      if (this.list.filter((f) => f.state === 'falling' || f.state === 'lying').length < MAX) this.drop();
    }
    for (const f of this.list) {
      if (f.state === 'falling') this.fall(f, dt);
      else if (f.state === 'lying') this.roll(f, dt, pushers, ahead);
    }
  }

  private fall(f: Fig, dt: number) {
    f.vy -= GRAVITY * dt;
    f.y += f.vy * dt;
    const ground = terrainHeight(f.x, f.z) + FIG_R;
    if (f.y > ground) return;
    f.y = ground;
    // One small bounce, then it lies there.
    if (f.vy < -0.5) f.vy = -f.vy * BOUNCE;
    else {
      f.vy = 0;
      f.state = 'lying';
    }
  }

  private roll(f: Fig, dt: number, pushers: readonly Pusher[], ahead: { x: number; z: number }) {
    let px = 0;
    let pz = 0;
    // Just in front of the snout (the first sphere), it's nosed along: kept ahead of it, drifting
    // toward the middle, rather than slipping off to the side of a round snout.
    const [nose, ...body] = pushers;
    const rx = f.x - nose.x;
    const rz = f.z - nose.z;
    const fore = rx * ahead.x + rz * ahead.z;
    const side = rx * ahead.z - rz * ahead.x;
    const front = nose.r + FIG_R;
    if (Math.abs(nose.y - f.y) < front + 0.01 && fore > -FIG_R * 0.5 && fore < front && Math.abs(side) < NOSE_WIDTH + FIG_R * 0.5) {
      const keep = side * NOSE_CENTRE;
      px = nose.x + ahead.x * front + ahead.z * keep - f.x;
      pz = nose.z + ahead.z * front - ahead.x * keep - f.z;
    }
    // Anywhere else, pushed out of every body sphere it's inside, sideways along the ground.
    for (const s of body) {
      if (Math.abs(s.y - f.y) > s.r + FIG_R) continue;
      const dx = f.x + px - s.x;
      const dz = f.z + pz - s.z;
      const d = Math.hypot(dx, dz);
      const reach = s.r + FIG_R;
      if (d >= reach || d < 1e-6) continue;
      px += (dx / d) * (reach - d);
      pz += (dz / d) * (reach - d);
    }
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
    const blocked = (x: number, z: number) => this.obstacles().some((o) => o.kind !== 'log' && covers(o, x, z, FIG_R));
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
    f.x = nx;
    f.z = nz;
    f.y = terrainHeight(f.x, f.z) + FIG_R;
    // Over the rim of the crack it drops in, out of reach for good.
    if (overCrack(f.x, f.z)) f.state = 'lost';
  }

  /** Draw the figs where they are now. */
  update() {
    let n = 0;
    for (const f of this.list) {
      if (f.state === 'eaten') continue;
      this.matrix.compose(POS.set(f.x, f.y, f.z), STILL, ONE);
      this.mesh.setMatrixAt(n++, this.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const STILL = new THREE.Quaternion();
const POS = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** The fig tree: a short, stout trunk under a broad, low crown of glossy leaves with figs among them. One mesh; solid at the trunk. */
function buildTree(scene: THREE.Scene, world: RAPIER.World, at: { x: number; z: number }): Obstacle {
  const rand = rng(62);
  const parts: THREE.BufferGeometry[] = [];
  const part = (g: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4) => {
    const geo = (g.index ? g.toNonIndexed() : g).applyMatrix4(m);
    geo.deleteAttribute('uv');
    const c = new THREE.Color(color);
    const n = geo.getAttribute('position').count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat()), 3));
    parts.push(geo);
  };
  const m = new THREE.Matrix4();
  part(new THREE.CylinderGeometry(TRUNK.radius * 0.7, TRUNK.radius, TRUNK.height + 0.05, 10), PALETTE.bark, m.makeTranslation(0, (TRUNK.height + 0.05) / 2 - 0.05, 0));
  // Limbs spreading out into the crown.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 2 * Math.PI + rand();
    const tilt = 0.7 + 0.35 * rand();
    const limb = new THREE.Matrix4().makeTranslation(0, TRUNK.height - 0.1, 0).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.sin(a) * tilt, 0, Math.cos(a) * tilt)));
    part(new THREE.CylinderGeometry(0.014, 0.03, 0.22, 7).translate(0, 0.11, 0), PALETTE.bark, limb);
  }
  // The crown: a broad, uneven canopy of leafy clumps, darker underneath.
  for (let i = 0; i < 22; i++) {
    const a = rand() * 2 * Math.PI;
    const d = CROWN.radius * Math.sqrt(rand()) * 1.05;
    const r = 0.07 + 0.06 * rand();
    const under = rand() < 0.35;
    const leafy = new THREE.Color(under ? 0x2f5524 : 0x447a30).offsetHSL(0.03 * (rand() - 0.5), 0.05 * (rand() - 0.5), 0.06 * (rand() - 0.5));
    const y = CROWN.y + (under ? -0.05 : 0.03 + 0.06 * rand()) - (d / CROWN.radius) ** 2 * 0.08;
    part(new THREE.IcosahedronGeometry(r, 1).scale(1, 0.6, 1).rotateY(rand() * 3), leafy, m.makeTranslation(Math.cos(a) * d, y, Math.sin(a) * d));
  }
  // Figs in bunches along the limbs, under the leaves.
  for (let i = 0; i < 18; i++) {
    const a = rand() * 2 * Math.PI;
    const d = CROWN.radius * (0.2 + 0.7 * rand());
    part(new THREE.IcosahedronGeometry(FIG_R, 1).scale(1, 1.15, 1), FIG_COLOUR, m.makeTranslation(Math.cos(a) * d, CROWN.y - 0.08 - 0.04 * rand(), Math.sin(a) * d));
  }
  const geometry = mergeGeometries(parts)!;
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() }));
  const y = terrainHeight(at.x, at.z) - 0.01;
  mesh.position.set(at.x, y, at.z);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'fig-tree';
  scene.add(mesh);
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cylinder(TRUNK.height / 2 + 0.03, TRUNK.radius).setTranslation(at.x, y + TRUNK.height / 2 - 0.03, at.z).setFriction(0.9),
  );
  return { name: 'fig-tree', kind: 'tree', position: mesh.position, height: CROWN.y + 0.1, radius: TRUNK.radius, mesh, collider };
}

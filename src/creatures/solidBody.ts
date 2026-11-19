import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { ANIMAL_GROUP } from '../world/terrain';
import type { PlayerController } from '../player/controller';

/**
 * Animals' solid bodies: each a chain of small capsules fitted to the drawn body and moved with it
 * every frame, the way the beach's sea lions are (#53), instead of one shape round the whole animal.
 * They're in `ANIMAL_GROUP`: the lizard's controller runs into them and can stand on them, while
 * what only looks for the ground under an animal (crab and snake rays, the camera's arm, cover)
 * looks past them like the iguanas. Thin parts (wings, fins, flippers, bills, tails, tongues) are
 * left out by the caller, so the lizard isn't stopped by air round them.
 *
 * Kinematic parts don't push the character controller, so a big animal that moves into the lizard
 * slides it out (`pushOut`); a small one (a fish) just blocks it.
 */

/** One capsule fitted to a group of bones: carried by `bone`, at `local` in its frame. Sizes in world m. */
export interface BonePart {
  bone: THREE.Object3D;
  local: THREE.Matrix4;
  radius: number;
  half: number;
}

/** A part sits this much inside the skin it was fitted to, so the lizard touches the skin, not air. */
const INSET = 0.9;
const Y = new THREE.Vector3(0, 1, 0);
const m = new THREE.Matrix4();
const p = new THREE.Vector3();
const q = new THREE.Quaternion();
const s = new THREE.Vector3();
const inv = new THREE.Quaternion();
const lp = new THREE.Vector3();
const lq = new THREE.Quaternion();

/**
 * Fit a capsule to each group of bones of the skinned mesh under `root`, as posed now: the vertices
 * mostly carried by those bones, along their longest spread, as thick as most of them are from that
 * line. The first bone of a group carries its capsule. Groups whose bones carry nothing are dropped.
 * `inset` scales the radius (a flattened body: a ray's disc, a bird's breast).
 */
export function fitBoneParts(root: THREE.Object3D, groups: string[][], inset = INSET): BonePart[] {
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error(`${root.name} has no skinned mesh`);
  const sk = mesh as THREE.SkinnedMesh;
  root.updateMatrixWorld(true);
  sk.skeleton.update();
  // A loader may suffix repeated names (`_1`), so a bone matches by its name or that without the suffix.
  const named = (n: string, b: THREE.Bone) => b.name === n || b.name.replace(/_\d+$/, '') === n;
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => sk.skeleton.bones.forEach((b, bi) => g.some((n) => named(n, b)) && !groupOf.has(bi) && groupOf.set(bi, gi)));
  const pts: THREE.Vector3[][] = groups.map(() => []);
  const pos = sk.geometry.getAttribute('position');
  const si = sk.geometry.getAttribute('skinIndex');
  const sw = sk.geometry.getAttribute('skinWeight');
  for (let i = 0; i < pos.count; i++) {
    let best = -1;
    let w = 0;
    for (let k = 0; k < 4; k++) {
      if (sw.getComponent(i, k) > w) {
        w = sw.getComponent(i, k);
        best = si.getComponent(i, k);
      }
    }
    const g = groupOf.get(best);
    if (g === undefined) continue;
    pts[g].push(sk.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(sk.matrixWorld));
  }
  const out: BonePart[] = [];
  groups.forEach((g, gi) => {
    const v = pts[gi];
    const bone = sk.skeleton.bones.find((b) => named(g[0], b));
    if (v.length < 4 || !bone) return;
    const { centre, axis, radius, half } = capsuleAround(v, inset);
    q.setFromUnitVectors(Y, axis);
    m.compose(centre, q, s.set(1, 1, 1));
    out.push({ bone, local: bone.matrixWorld.clone().invert().multiply(m), radius, half });
  });
  return out;
}

/** The capsule along the longest spread of `v`: the middle 90% of its length, radius the 80th percentile distance off it. */
export function capsuleAround(v: THREE.Vector3[], inset = INSET) {
  const c = new THREE.Vector3();
  for (const x of v) c.add(x);
  c.divideScalar(v.length);
  // Longest spread: power iteration on the covariance.
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const x of v) {
    const d = [x.x - c.x, x.y - c.y, x.z - c.z];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += d[a] * d[b];
  }
  const axis = new THREE.Vector3(0.3, 0.5, 0.8);
  for (let it = 0; it < 30; it++) {
    const ax = cov[0] * axis.x + cov[1] * axis.y + cov[2] * axis.z;
    const ay = cov[3] * axis.x + cov[4] * axis.y + cov[5] * axis.z;
    const az = cov[6] * axis.x + cov[7] * axis.y + cov[8] * axis.z;
    axis.set(ax, ay, az);
    if (axis.lengthSq() < 1e-20) axis.set(0, 1, 0);
    axis.normalize();
  }
  const t = v.map((x) => p.subVectors(x, c).dot(axis)).sort((a, b) => a - b);
  const lo = t[Math.floor(t.length * 0.05)];
  const hi = t[Math.ceil(t.length * 0.95) - 1];
  const off = v.map((x) => p.subVectors(x, c).addScaledVector(axis, -p.dot(axis)).length()).sort((a, b) => a - b);
  const radius = Math.max(0.001, off[Math.floor(off.length * 0.8)] * inset);
  const centre = c.clone().addScaledVector(axis, (lo + hi) / 2);
  return { centre, axis, radius, half: Math.max(0, (hi - lo) / 2 - radius) };
}

/** A capsule in a rigid mesh's own space, moved with the mesh (`SolidBody.carry`). */
export interface MeshPart {
  local: THREE.Matrix4;
  radius: number;
  half: number;
}

const pct = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(a.length * f))];

/**
 * Capsules for a body drawn from one rigid mesh, nose toward +Z: one per band of its length (`bands`,
 * shares of the length back from the nose), lying along the body (`along`, a fish) or across it (a
 * ray's disc), as thick as most of the band is (fins and wingtips past that left out).
 */
export function slabParts(geometry: THREE.BufferGeometry, bands: readonly [number, number][], along: boolean, inset = INSET): MeshPart[] {
  const pos = geometry.getAttribute('position');
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const len = box.max.z - box.min.z;
  const out: MeshPart[] = [];
  for (const [f0, f1] of bands) {
    const z1 = box.max.z - f0 * len;
    const z0 = box.max.z - f1 * len;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z < z0 || z > z1) continue;
      xs.push(pos.getX(i));
      ys.push(pos.getY(i));
    }
    if (xs.length < 4) continue;
    const ay = [...ys].sort((a, b) => a - b);
    const ax = xs.map(Math.abs).sort((a, b) => a - b);
    const lo = pct(ay, 0.05);
    const hi = pct(ay, 0.95);
    const cy = (lo + hi) / 2;
    const zc = (z0 + z1) / 2;
    if (along) {
      const radius = Math.max(0.001, Math.min((hi - lo) / 2, pct(ax, 0.8)) * inset);
      out.push({ local: new THREE.Matrix4().compose(new THREE.Vector3(0, cy, zc), new THREE.Quaternion().setFromUnitVectors(Y, new THREE.Vector3(0, 0, 1)), ONE), radius, half: Math.max(0, (z1 - z0) / 2) });
    } else {
      const radius = Math.max(0.001, ((hi - lo) / 2) * inset);
      out.push({ local: new THREE.Matrix4().compose(new THREE.Vector3(0, cy, zc), new THREE.Quaternion().setFromUnitVectors(Y, new THREE.Vector3(1, 0, 0)), ONE), radius, half: Math.max(0, pct(ax, 0.9) * inset - radius) });
    }
  }
  return out;
}
const ONE = new THREE.Vector3(1, 1, 1);

/** Every solid body in each physics world, for `pushAnimalsOff`. */
const BODIES = new WeakMap<RAPIER.World, SolidBody[]>();

/** Each step, before the lizard moves: every heavy animal that has moved into it slides it out. */
export function pushAnimalsOff(world: RAPIER.World, player: PlayerController) {
  for (const b of BODIES.get(world) ?? []) b.pushOut(player);
}

/** Lizard pushed out of a part sideways only once it's more beside it than on it. */
const SIDEWAYS = 0.35;
/** Pushed this much past touching, so the next step doesn't start in it. */
const CLEAR = 0.0005;

export class SolidBody {
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[];
  private on = true;
  /** Rough reach of the whole body from its first part (m), for skipping the push when the lizard is far. */
  private reach: number;

  /**
   * `heavy` animals slide the lizard out of their way; light ones only block it. The parts go on
   * `parent` when given (an animal with a solid body of its own, which its shoves look past), else on a
   * body of their own that never moves.
   */
  constructor(
    world: RAPIER.World,
    parts: readonly { radius: number; half: number }[],
    readonly heavy = true,
    private parent: RAPIER.RigidBody | null = null,
  ) {
    this.body = parent ?? world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.colliders = parts.map((part) =>
      world.createCollider(
        (part.half > 1e-4 ? RAPIER.ColliderDesc.capsule(part.half, part.radius) : RAPIER.ColliderDesc.ball(part.radius))
          .setCollisionGroups((ANIMAL_GROUP << 16) | 0xffff)
          .setFriction(0.9),
        this.body,
      ),
    );
    this.reach = parts.reduce((a, part) => a + 2 * (part.half + part.radius), 0);
    let list = BODIES.get(world);
    if (!list) BODIES.set(world, (list = []));
    list.push(this);
  }

  /** Fitted to `root`'s bones (`fitBoneParts`), following them. */
  static fitted(world: RAPIER.World, root: THREE.Object3D, groups: string[][], heavy = true, inset = INSET, parent: RAPIER.RigidBody | null = null) {
    const parts = fitBoneParts(root, groups, inset);
    const body = new SolidBody(world, parts, heavy, parent);
    body.parts = parts;
    body.follow(parts);
    return body;
  }

  /** The bone parts it follows, when fitted to bones. */
  parts: BonePart[] | null = null;

  /** Move every part with its bone, when fitted to bones. */
  update() {
    if (this.parts && this.on) this.follow(this.parts);
  }

  /** Put part `i` at `at` (world), its capsule's long axis along the turn's +Y. */
  set(i: number, at: { x: number; y: number; z: number }, turn: { x: number; y: number; z: number; w: number }) {
    const c = this.colliders[i];
    if (this.parent) {
      // Into the parent body's frame, where it stands now.
      const t = this.parent.translation();
      const r = this.parent.rotation();
      inv.set(r.x, r.y, r.z, r.w).invert();
      lp.set(at.x - t.x, at.y - t.y, at.z - t.z).applyQuaternion(inv);
      lq.set(turn.x, turn.y, turn.z, turn.w).premultiply(inv);
      c.setTranslationWrtParent(lp);
      c.setRotationWrtParent(lq);
      return;
    }
    c.setTranslationWrtParent(at);
    c.setRotationWrtParent(turn);
  }

  /** Move every part with the bone that carries it, as drawn now. */
  follow(parts: readonly BonePart[]) {
    parts.forEach((part, i) => {
      part.bone.updateWorldMatrix(true, false);
      m.multiplyMatrices(part.bone.matrixWorld, part.local).decompose(p, q, s);
      this.set(i, p, q);
    });
  }

  /** Move every part with a rigid mesh whose world matrix is `matrix` (parts from `slabParts`). */
  carry(parts: readonly MeshPart[], matrix: THREE.Matrix4) {
    parts.forEach((part, i) => {
      m.multiplyMatrices(matrix, part.local).decompose(p, q, s);
      this.set(i, p, q);
    });
  }

  /** Solid or not: off while it strikes, flies or is gone. */
  get enabled() {
    return this.on;
  }

  set enabled(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    for (const c of this.colliders) c.setEnabled(on);
  }

  /** Whether any part is within `d` of (x, y, z), by its rough reach. */
  near(x: number, y: number, z: number, d: number) {
    const t = this.colliders[0].translation();
    return Math.hypot(t.x - x, t.y - y, t.z - z) < this.reach + d;
  }

  /**
   * A heavy animal that has moved into the lizard slides it out along the ground, part by part.
   * Returns how far it was moved (m). Nothing when the lizard is up on it.
   */
  pushOut(player: PlayerController): number {
    if (!this.heavy || !this.on) return 0;
    const at = player.position;
    if (!this.near(at.x, at.y, at.z, 0.15)) return 0;
    let moved = 0;
    for (const c of this.colliders) {
      const hit = c.contactCollider(player.collider, 0);
      if (!hit || hit.distance >= 0) continue;
      const n = hit.normal1;
      const side = Math.hypot(n.x, n.z);
      if (side < SIDEWAYS) continue;
      const d = (-hit.distance + CLEAR) / side;
      moved += player.shove((n.x / side) * d, (n.z / side) * d, c);
    }
    return moved;
  }
}

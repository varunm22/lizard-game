import * as THREE from 'three';

/**
 * Poses a skinned model whose bones have no parents (a "free rig", made by `assets-src/rigged.py`):
 * every bone is placed directly in the model's own space. A chain is worked out here instead, in
 * `chain`: each joint's turn, given in the model's space at rest, is added on to its parent's, and
 * the joint carried round with it, so a creature is posed from a handful of angles a frame.
 *
 * Model space is glTF's: +Z forward, +Y up, +X to the animal's left.
 */
export class FreeRig {
  readonly root: THREE.Object3D;
  private bones = new Map<string, { bone: THREE.Object3D; head: THREE.Vector3; rest: THREE.Quaternion }>();
  /** Each bone's posed turn (model space, relative to rest) and head, set by `chain`/`place`. */
  readonly turn = new Map<string, THREE.Quaternion>();
  readonly at = new Map<string, THREE.Vector3>();

  constructor(root: THREE.Object3D) {
    this.root = root;
    root.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      // A GLB holding several rigs has the same bone names in each; the loader numbers the repeats.
      o.name = o.name.replace(/_\d+$/, '');
      this.bones.set(o.name, { bone: o, head: o.position.clone(), rest: o.quaternion.clone() });
      this.turn.set(o.name, new THREE.Quaternion());
      this.at.set(o.name, o.position.clone());
    });
  }

  has(name: string) {
    return this.bones.has(name);
  }

  /** A bone's head at rest (model space). */
  rest(name: string): THREE.Vector3 {
    const b = this.bones.get(name);
    if (!b) throw new Error(`no bone ${name}`);
    return b.head;
  }

  /** Put a bone's head at `head` (model space), turned `turn` from rest. */
  place(name: string, head: THREE.Vector3, turn: THREE.Quaternion) {
    const b = this.bones.get(name)!;
    this.turn.get(name)!.copy(turn);
    this.at.get(name)!.copy(head);
    b.bone.position.copy(head);
    b.bone.quaternion.copy(turn).multiply(b.rest);
  }

  /**
   * Pose `name` as the child of `parent` (already posed): its head carried with the parent's turn,
   * its own turn `local` (model space at rest) added after the parent's. Without a parent, `local`
   * is the whole turn and `head` (if given) where it goes.
   */
  chain(name: string, parent: string | null, local: THREE.Quaternion, head?: THREE.Vector3) {
    const q = this.q.copy(local);
    const p = this.v.copy(head ?? this.rest(name));
    if (parent) {
      const pq = this.turn.get(parent)!;
      p.copy(this.rest(name)).sub(this.rest(parent)).applyQuaternion(pq).add(this.at.get(parent)!);
      q.premultiply(pq);
    }
    this.place(name, p, q);
  }

  /** Where a point given at rest (model space) on bone `name` is now. */
  point(name: string, restPoint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(restPoint).sub(this.rest(name)).applyQuaternion(this.turn.get(name)!).add(this.at.get(name)!);
  }

  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
}

const e = new THREE.Euler();
/**
 * A turn from three angles in model space: `pitch` raises the front (about -X), `yaw` turns to the
 * animal's left (about +Y), `roll` rolls its left side up (about -Z); applied roll, then pitch, then yaw.
 */
export function turn(out: THREE.Quaternion, pitch: number, yaw = 0, roll = 0): THREE.Quaternion {
  return out.setFromEuler(e.set(-pitch, yaw, roll, 'YXZ'));
}

/**
 * The turn taking direction `from` onto `to` (both model space), the shortest way round, then
 * rolled `twist` about `to`.
 */
export function aim(out: THREE.Quaternion, from: THREE.Vector3, to: THREE.Vector3, twist = 0): THREE.Quaternion {
  out.setFromUnitVectors(tmpA.copy(from).normalize(), tmpB.copy(to).normalize());
  if (twist) out.premultiply(tmpQ.setFromAxisAngle(tmpB, twist));
  return out;
}
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/**
 * The turn taking a flat part lying along `fromDir` with its face toward `fromUp` (rest) to lie
 * along `toDir` with its face as near `toUp` as it can.
 */
export function aimFlat(out: THREE.Quaternion, fromDir: THREE.Vector3, fromUp: THREE.Vector3, toDir: THREE.Vector3, toUp: THREE.Vector3): THREE.Quaternion {
  const f0 = tmpA.copy(fromDir).normalize();
  const s0 = tmpC.crossVectors(fromUp, f0).normalize();
  const u0 = tmpD.crossVectors(f0, s0);
  m0.makeBasis(s0, u0, f0);
  const f1 = tmpB.copy(toDir).normalize();
  const s1 = tmpC.crossVectors(toUp, f1);
  if (s1.lengthSq() < 1e-10) s1.set(1, 0, 0);
  s1.normalize();
  const u1 = tmpD.crossVectors(f1, s1);
  m1.makeBasis(s1, u1, f1);
  return out.setFromRotationMatrix(m1.multiply(m0.transpose()));
}
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const m0 = new THREE.Matrix4();
const m1 = new THREE.Matrix4();

/**
 * Two-bone reach: from `a` (root joint), with segment lengths `l1`, `l2`, where the middle joint
 * goes so the end lands on `target` (or as near as it can), bending toward `pole`. Writes the middle
 * joint and the end into `mid`, `end`.
 */
export function reach(a: THREE.Vector3, l1: number, l2: number, target: THREE.Vector3, pole: THREE.Vector3, mid: THREE.Vector3, end: THREE.Vector3) {
  const d = tmpA.copy(target).sub(a);
  let dist = d.length();
  dist = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-5), l1 + l2 - 1e-5);
  d.normalize();
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const bend = tmpB.copy(pole).addScaledVector(d, -pole.dot(d));
  if (bend.lengthSq() < 1e-10) bend.set(0, 1, 0).addScaledVector(d, -d.y);
  bend.normalize();
  mid.copy(a).addScaledVector(d, l1 * cosA).addScaledVector(bend, l1 * sinA);
  end.copy(a).addScaledVector(d, dist);
}

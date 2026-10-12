import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';

/** The lava heron from assets-src/heron.py, with the measurements written on its armature (heron space: Y up, +Z forward, toes on y = 0). */
export interface HeronKit {
  scene: THREE.Object3D;
  joints: Record<string, THREE.Vector3>;
  billTip: THREE.Vector3;
  bodyHeight: number;
}

export async function loadHeronKit(url: string): Promise<HeronKit> {
  const gltf = await loadGltf(url);
  toonify(gltf.scene);
  const rig = gltf.scene.getObjectByName('Heron');
  const x = (rig?.userData ?? {}) as { joints?: Record<string, number[]>; bill_tip?: number[]; body_height?: number };
  if (!x.joints || !x.bill_tip || !x.body_height) throw new Error('heron.glb is missing its rig extras');
  const joints: Record<string, THREE.Vector3> = {};
  for (const [k, v] of Object.entries(x.joints)) joints[k] = new THREE.Vector3(v[0], v[1], v[2]);
  return { scene: gltf.scene, joints, billTip: new THREE.Vector3(...(x.bill_tip as [number, number, number])), bodyHeight: x.body_height };
}

const NECK = ['neck_0', 'neck_1', 'neck_2', 'neck_3', 'neck_4'];
const SIDES = ['_L', '_R'] as const;
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** A rotation turning `from` onto `to` without rolling about them: each made into a frame with `up` (or across, `side`). */
function frame(dir: THREE.Vector3, ref: THREE.Vector3, out: THREE.Matrix4, sideways: boolean) {
  const f = dir;
  const s = new THREE.Vector3();
  const u = new THREE.Vector3();
  if (sideways) {
    s.copy(ref).addScaledVector(f, -ref.dot(f));
    if (s.lengthSq() < 1e-10) s.set(1, 0, 0);
    s.normalize();
    u.crossVectors(f, s);
  } else {
    s.crossVectors(ref, f);
    if (s.lengthSq() < 1e-10) s.set(1, 0, 0);
    s.normalize();
    u.crossVectors(f, s);
  }
  return out.makeBasis(s, u, f);
}

/**
 * One heron's body, posed from a few numbers each frame rather than from clips. The body is rigid,
 * set on its legs and leaning (`lean`, radians forward) and crouching (`crouch`, m). The neck is a
 * smooth curve from the shoulders to the head, wherever the head is put (`head`, in heron space);
 * `bill` is the way the bill points. Each foot stands where it was put down (world), and each leg
 * reaches it with the backward-bending ankle of a bird: a two-bone reach, worked out exactly, for
 * this drawn animal only (the player never gets foot IK).
 */
export class HeronBody {
  readonly root: THREE.Object3D;
  /** Where the heron stands (world: its middle on the ground) and which way it faces (as the lizard's yaw). */
  readonly at = new THREE.Vector3();
  yaw = 0;
  lean = 0;
  crouch = 0;
  /** The head joint (heron space) and the way the bill points (heron space, unit). */
  readonly head = new THREE.Vector3();
  readonly bill = new THREE.Vector3(0, 0, 1);
  /** The feet, where each stands (world), left then right. */
  readonly feet = [new THREE.Vector3(), new THREE.Vector3()];
  /** Rest joints, the bill tip's offset from the head joint, the shoulders, and the neck's rest length. */
  readonly rest: Record<string, THREE.Vector3>;
  readonly billOffset: THREE.Vector3;
  readonly bodyHeight: number;
  private bones = new Map<string, THREE.Bone>();
  private bind = new Map<string, THREE.Matrix4>();
  private parentInverse = new Map<string, THREE.Matrix4>();
  private restDir = new Map<string, THREE.Matrix4>();
  private leg: { thigh: number; shank: number }[];
  private world = new THREE.Matrix4();
  private worldInverse = new THREE.Matrix4();
  private bodyM = new THREE.Matrix4();
  private m = new THREE.Matrix4();
  private r = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private q = new THREE.Quaternion();
  /** Posed points (world) for tests and the hunt: the bill tip and the neck's base. */
  readonly billTip = new THREE.Vector3();
  readonly shoulders = new THREE.Vector3();

  constructor(kit: HeronKit) {
    this.root = clone(kit.scene);
    this.rest = kit.joints;
    this.bodyHeight = kit.bodyHeight;
    this.billOffset = kit.billTip.clone().sub(kit.joints.head);
    this.root.updateMatrixWorld(true);
    for (const name of Object.keys(kit.joints)) {
      const bone = this.root.getObjectByName(name) as THREE.Bone | undefined;
      if (!bone) throw new Error(`heron.glb has no bone ${name}`);
      this.bones.set(name, bone);
      this.bind.set(name, bone.matrixWorld.clone());
      this.parentInverse.set(name, bone.parent!.matrixWorld.clone().invert());
    }
    // Rest frames of the parts that turn to follow a line: the bill, the neck and the legs.
    const J = kit.joints;
    this.restDir.set('head', frame(this.billOffset.clone().normalize(), UP, new THREE.Matrix4(), false));
    NECK.forEach((n, i) => {
      const next = i + 1 < NECK.length ? J[NECK[i + 1]] : J.head;
      const prev = i > 0 ? J[NECK[i - 1]] : J[n];
      const t = next.clone().sub(prev).normalize();
      this.restDir.set(n, frame(t, UP, new THREE.Matrix4(), false));
    });
    for (const s of SIDES) {
      this.restDir.set(`tibia${s}`, frame(J[`tarsus${s}`].clone().sub(J[`tibia${s}`]).normalize(), SIDE, new THREE.Matrix4(), true));
      this.restDir.set(`tarsus${s}`, frame(J[`foot${s}`].clone().sub(J[`tarsus${s}`]).normalize(), SIDE, new THREE.Matrix4(), true));
    }
    this.leg = SIDES.map((s) => ({ thigh: J[`tarsus${s}`].distanceTo(J[`tibia${s}`]), shank: J[`foot${s}`].distanceTo(J[`tarsus${s}`]) }));
    this.head.copy(J.head);
    this.root.traverse((o) => {
      // Skinned to bones placed anywhere in the level: the rest-pose bounds mean nothing.
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
    });
  }

  /** Where the hip of leg `i` is in heron space, from the body's pose. */
  hip(i: number, out: THREE.Vector3) {
    return out.copy(this.rest[`tibia${SIDES[i]}`]).applyMatrix4(this.bodyM);
  }

  /** Where foot `i` stands at rest (world) for the heron standing at `at` facing `yaw`. */
  footHome(i: number, at: THREE.Vector3, yaw: number, out: THREE.Vector3) {
    const f = this.rest[`foot${SIDES[i]}`];
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return out.set(at.x + f.x * c + f.z * s, at.y, at.z - f.x * s + f.z * c);
  }

  /** Heron space to world for the current stance, into `out`. */
  toWorld(p: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(p).applyMatrix4(this.world);
  }

  /** World to heron space for the current stance, into `out`. */
  toLocal(p: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(p).applyMatrix4(this.worldInverse);
  }

  /** Set the stance (`at`, `yaw`) into the world matrices; call before `toLocal`/`toWorld` and `pose`. */
  place() {
    this.q.setFromAxisAngle(UP, this.yaw);
    this.world.compose(this.at, this.q, this.v.set(1, 1, 1));
    this.worldInverse.copy(this.world).invert();
  }

  /** The body's own transform in heron space: raised to stand, crouched and leaning about its middle. */
  private bodyPose() {
    const body = this.rest.body;
    this.r.makeRotationX(this.lean);
    this.bodyM.makeTranslation(-body.x, -body.y, -body.z).premultiply(this.r);
    this.bodyM.premultiply(this.m.makeTranslation(body.x, body.y - this.crouch, body.z));
  }

  /** Set bone `name` so its rest pose is turned by `rot` about its joint and moved to `p` (heron space). */
  private setBone(name: string, p: THREE.Vector3, rot: THREE.Matrix4) {
    const j = this.rest[name];
    this.m.makeTranslation(-j.x, -j.y, -j.z).premultiply(rot);
    this.m.setPosition(this.v.copy(j).negate().applyMatrix4(rot).add(p));
    this.m.premultiply(this.world).multiply(this.bind.get(name)!);
    this.m.premultiply(this.parentInverse.get(name)!);
    const bone = this.bones.get(name)!;
    this.m.decompose(bone.position, bone.quaternion, bone.scale);
  }

  /** A rotation taking the rest frame of `name` onto a frame along `dir`. */
  private turn(name: string, dir: THREE.Vector3, sideways: boolean, out: THREE.Matrix4) {
    frame(dir, sideways ? SIDE : UP, out, sideways);
    return out.multiply(this.m.copy(this.restDir.get(name)!).transpose());
  }

  /** Pose every bone from the current stance, body, head and feet. */
  pose() {
    this.place();
    this.bodyPose();
    const rot = new THREE.Matrix4().extractRotation(this.bodyM);
    const body = this.a.copy(this.rest.body).applyMatrix4(this.bodyM);
    this.setBone('body', body, rot);
    // The neck: a smooth curve from the shoulders (fixed to the body) to the head, bulging up and back.
    const base = this.b.copy(this.rest.neck_0).applyMatrix4(this.bodyM);
    this.toWorld(base, this.shoulders);
    const head = this.head;
    const ctrl = this.c.copy(base).lerp(head, 0.5);
    const reach = base.distanceTo(head);
    ctrl.y += 0.25 * reach;
    ctrl.z -= 0.15 * reach;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < NECK.length; i++) {
      const t = (i / NECK.length) * 0.97;
      const u = 1 - t;
      pts.push(new THREE.Vector3().copy(base).multiplyScalar(u * u).addScaledVector(ctrl, 2 * u * t).addScaledVector(head, t * t));
    }
    pts.push(head.clone());
    const t = new THREE.Vector3();
    NECK.forEach((n, i) => {
      t.subVectors(pts[i + 1], pts[Math.max(0, i - 1)]).normalize();
      this.setBone(n, pts[i], this.turn(n, t, false, this.r));
    });
    t.copy(this.bill).normalize();
    this.setBone('head', head, this.turn('head', t, false, this.r));
    this.toWorld(this.v.copy(this.billOffset).applyMatrix4(this.r).add(head), this.billTip);
    // The legs: each hip (on the body) reaches its foot, the ankle bent backward.
    SIDES.forEach((s, i) => {
      const hip = this.hip(i, new THREE.Vector3());
      const foot = this.toLocal(this.feet[i], new THREE.Vector3());
      // The foot joint sits a little above the sole.
      foot.y += this.rest[`foot${s}`].y;
      const { thigh, shank } = this.leg[i];
      const d = new THREE.Vector3().subVectors(foot, hip);
      let len = d.length();
      const max = (thigh + shank) * 0.999;
      if (len > max) {
        foot.copy(hip).addScaledVector(d, max / len);
        d.multiplyScalar(max / len);
        len = max;
      }
      d.normalize();
      // Across the hip-foot line, toward the tail: where the ankle bends to.
      const back = new THREE.Vector3(0, 0, -1).addScaledVector(d, d.z);
      if (back.lengthSq() < 1e-8) back.set(0, 1, 0);
      back.normalize();
      const along = (thigh * thigh - shank * shank + len * len) / (2 * len);
      const out = Math.sqrt(Math.max(0, thigh * thigh - along * along));
      const ankle = new THREE.Vector3().copy(hip).addScaledVector(d, along).addScaledVector(back, out);
      this.setBone(`tibia${s}`, hip, this.turn(`tibia${s}`, t.subVectors(ankle, hip).normalize(), true, this.r));
      this.setBone(`tarsus${s}`, ankle, this.turn(`tarsus${s}`, t.subVectors(foot, ankle).normalize(), true, this.r));
      this.setBone(`foot${s}`, foot, this.r.identity());
    });
  }
}

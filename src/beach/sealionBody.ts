import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { aimFlat, FreeRig, reach, turn } from '../render/freePose';

export type SeaLionKind = 'Cow' | 'Bull' | 'Pup';

/** The three sea lions from assets-src/sea_lions.py, each with its length and the top of its back at rest (m). */
export type SeaLionKit = Record<SeaLionKind, { scene: THREE.Object3D; length: number; height: number }>;

export async function loadSeaLionKit(url: string): Promise<SeaLionKit> {
  const gltf = await loadGltf(url);
  toonify(gltf.scene);
  const kit = {} as SeaLionKit;
  for (const kind of ['Cow', 'Bull', 'Pup'] as const) {
    const rig = gltf.scene.getObjectByName('SeaLion' + kind);
    if (!rig) throw new Error(`sea-lions.glb has no ${kind}`);
    const x = rig.userData as { length: number; height: number };
    kit[kind] = { scene: rig, length: x.length, height: x.height };
  }
  return kit;
}

/** One piece of a sea lion's solid body: a capsule lying across it (along its X), carried by `bone`. */
export interface BodyPart {
  bone: string;
  /** Its middle at rest (model space), radius and half the length of its straight part (m). */
  centre: THREE.Vector3;
  radius: number;
  half: number;
}

/** Slices along the body (body lengths from the middle, +Z forward) and the bone each is carried by. */
const SLICES: [number, string][] = [
  [0.44, 'head'],
  [0.34, 'neck'],
  [0.23, 'chest'],
  [0.12, 'chest'],
  [0.01, 'spine'],
  [-0.1, 'spine'],
  [-0.21, 'hips'],
  [-0.31, 'hips'],
];
const TRUNK = new Set(['hips', 'spine', 'chest', 'neck', 'head', 'jaw']);
/** A part sits this much inside the skin over the back and sides, so the lizard touches the coat, not air. */
const INSET = 0.9;

/**
 * Fit the body's solid parts to its mesh: for each slice, the trunk's vertices there (not the
 * flippers'), as a capsule across the body as wide and deep as they are.
 */
function fitParts(root: THREE.Object3D, length: number): BodyPart[] {
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error('sea lion has no skinned mesh');
  const m = mesh as THREE.SkinnedMesh;
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(m.matrixWorld);
  const pos = m.geometry.getAttribute('position');
  const si = m.geometry.getAttribute('skinIndex');
  const sw = m.geometry.getAttribute('skinWeight');
  const trunk = m.skeleton.bones.map((b) => TRUNK.has(b.name.replace(/_\d+$/, '')));
  const box = SLICES.map(() => ({ x: 0, lo: Infinity, hi: -Infinity, n: 0 }));
  const p = new THREE.Vector3();
  const band = 0.05 * length;
  for (let i = 0; i < pos.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (trunk[si.getComponent(i, k)]) w += sw.getComponent(i, k);
    if (w < 0.5) continue;
    p.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
    SLICES.forEach(([z], j) => {
      if (Math.abs(p.z - z * length) > band) return;
      const b = box[j];
      b.x = Math.max(b.x, Math.abs(p.x));
      b.lo = Math.min(b.lo, p.y);
      b.hi = Math.max(b.hi, p.y);
      b.n++;
    });
  }
  return SLICES.flatMap(([z], j) => {
    const b = box[j];
    if (!b.n) return [];
    const radius = ((b.hi - b.lo) / 2) * INSET;
    // Its underside on the belly's, so it lies on the sand as the body does.
    return [{ bone: SLICES[j][1], centre: new THREE.Vector3(0, b.lo + radius, z * length), radius, half: Math.max(0, b.x * INSET - radius) }];
  });
}

const SIDES = [
  ['_L', 1],
  ['_R', -1],
] as const;
const UP = new THREE.Vector3(0, 1, 0);
/** A Rapier capsule stands along Y; this lays it along X, across the body. */
const ACROSS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const w = new THREE.Vector3();
const mid = new THREE.Vector3();
const end = new THREE.Vector3();
const dir = new THREE.Vector3();
const flat = new THREE.Vector3();
const pole = new THREE.Vector3();

/**
 * One sea lion's body, posed from a few numbers each frame (no clips). `lift` raises it from lying
 * flat on its belly (0) to propped up on straight fore-flippers with the neck high (1), the way they
 * sit on a beach; `gait` blends in the galumph, a bounding walk on the fore-flippers with the hind
 * flippers turned forward under the hips, its phase run on by how far it went (`stride`); `swim` blends in
 * swimming, the fore-flippers beating like wings. The head turns (`look`, radians to its left) and
 * nods (`nod`, up), and the jaw drops (`jaw`, radians) to bark.
 */
export class SeaLionBody {
  readonly root: THREE.Object3D;
  readonly rig: FreeRig;
  readonly length: number;
  readonly height: number;
  /** Its solid parts, fitted to the mesh at rest; `partAt` says where each is posed now. */
  readonly parts: BodyPart[];
  lift = 0;
  gait = 0;
  swim = 0;
  look = 0;
  nod = 0;
  jaw = 0;
  /** Lying, the head down on the sand (1) or held up (0). */
  rest = 0;
  private phase: number;
  private breath: number;
  /** Rest lengths of each fore-flipper's two bones, and the blade. */
  private arm: number;
  private fore: number;
  private bladeDir = new Map<string, THREE.Vector3>();
  private footDir = new Map<string, THREE.Vector3>();

  /** `seed` staggers its cycles from the others'. */
  constructor(kit: SeaLionKit, readonly kind: SeaLionKind, seed = 0) {
    const k = kit[kind];
    this.phase = seed * 2.39;
    this.breath = seed * 3.71;
    this.root = clone(k.scene);
    this.rig = new FreeRig(this.root);
    this.length = k.length;
    this.height = k.height;
    this.parts = fitParts(this.root, k.length);
    const r = (n: string) => this.rig.rest(n);
    this.arm = r('fore_L').distanceTo(r('arm_L'));
    this.fore = r('hand_L').distanceTo(r('fore_L'));
    for (const [s] of SIDES) {
      // Each blade's rest direction, from the bone's own rest turn (bones point along their +Y).
      this.bladeDir.set(s, this.boneDir('hand' + s));
      this.footDir.set(s, this.boneDir('foot' + s));
    }
  }

  private boneDir(name: string): THREE.Vector3 {
    let out = new THREE.Vector3(0, 1, 0);
    this.root.traverse((o) => {
      if (o.name === name) out = new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion).normalize();
    });
    return out;
  }

  /** Run the cycles on: `travel` m moved this frame. */
  advance(dt: number, travel: number) {
    this.breath += dt;
    // A galumph stride is about half a body length; a flipper beat takes 0.9 s at cruising speed.
    this.phase += this.gait > 0.01 ? (travel / (0.5 * this.length)) * Math.PI * 2 : 0;
    if (this.swim > 0.01) this.phase += dt * (2 * Math.PI) / 0.9;
  }

  /** Pose every bone from the numbers above. */
  pose() {
    const rig = this.rig;
    const L = this.length;
    const lift = this.lift;
    const g = this.gait;
    const sw = this.swim;
    const ph = this.phase;
    const heave = Math.sin(ph) * g;
    const breathe = Math.sin(this.breath * 1.6) * 0.02;
    // Spine: propped, the hindquarters and belly stay on the sand and the body curves up through
    // the chest onto the fore-flippers, the neck high (each turn below adds to its parent's);
    // heaving as it galumphs, level in the water.
    const hipUp = 0.04 * heave * (1 - sw);
    const spineUp = (0.07 * lift + 0.08 * heave) * (1 - sw) + 0.03 * Math.sin(ph) * sw + breathe;
    const chestUp = (0.62 * lift + 0.1 * heave) * (1 - sw) + 0.05 * Math.sin(ph + 0.6) * sw;
    const neckUp = 0.55 * lift - 0.2 * this.rest * (1 - lift) + 0.15 * g - 0.05 * sw - 0.1 * heave;
    const headUp = -1.12 * lift + 0.1 * this.rest * (1 - lift) - 0.1 * g + this.nod;
    const bodyYaw = this.look * 0.15;
    const hipsAt = v.copy(rig.rest('hips'));
    hipsAt.y += 0.004 * L * Math.max(0, heave);
    rig.chain('hips', null, turn(q, hipUp, 0, 0), hipsAt);
    rig.chain('spine', 'hips', turn(q, spineUp, bodyYaw * 0.4));
    rig.chain('chest', 'spine', turn(q, chestUp, bodyYaw * 0.6));
    rig.chain('neck', 'chest', turn(q, neckUp, this.look * 0.45));
    rig.chain('head', 'neck', turn(q, headUp, this.look * 0.55));
    rig.chain('jaw', 'head', turn(q, -this.jaw));

    for (const [s, side] of SIDES) {
      // Fore-flipper: the shoulder carried by the chest; the wrist reaches for where the flipper
      // stands (lying, where it rests; propped, under the shoulder; galumphing, stepping).
      rig.chain('arm' + s, 'chest', q.identity());
      const shoulder = rig.at.get('arm' + s)!;
      const restWrist = rig.point('chest', rig.rest('hand' + s), w);
      const step = Math.sin(ph + (side > 0 ? 0 : Math.PI));
      const target = end.set(shoulder.x + side * 0.03 * L, 0.004 * L, shoulder.z + 0.03 * L + 0.07 * L * step * g);
      target.y += Math.max(0, Math.cos(ph + (side > 0 ? 0 : Math.PI))) * 0.03 * L * g;
      const prop = Math.min(1, lift + g);
      target.lerp(restWrist, 1 - prop);
      if (sw > 0) {
        // Swimming: the flippers held out and down, beating down and back.
        const beat = Math.sin(ph);
        target.lerp(w.set(shoulder.x + side * 0.11 * L, shoulder.y - 0.05 * L - 0.04 * L * beat, shoulder.z - 0.02 * L + 0.05 * L * beat), sw);
      }
      pole.set(side * 0.3, 0.2, -1);
      reach(shoulder, this.arm, this.fore, target, pole, mid, dir);
      const elbow = mid.clone();
      const wrist = dir.clone();
      rig.place('arm' + s, shoulder, aimFlat(q, this.restDir('arm' + s, 'fore' + s), UP, w.copy(elbow).sub(shoulder), UP));
      rig.place('fore' + s, elbow, aimFlat(q, this.restDir('fore' + s, 'hand' + s), UP, w.copy(wrist).sub(elbow), UP));
      // The blade lies flat, pointing out and a little forward when propped, back along the side lying.
      const bladeRest = this.bladeDir.get(s)!;
      flat.copy(bladeRest).applyQuaternion(rig.turn.get('chest')!);
      flat.y = Math.min(flat.y, 0);
      dir.set(side * 0.75, -0.05, 0.55).normalize();
      dir.lerp(flat.normalize(), 1 - prop).normalize();
      if (sw > 0) dir.lerp(w.set(side * 0.8, -0.3 - 0.3 * Math.sin(ph), -0.4 + 0.5 * Math.cos(ph)).normalize(), sw).normalize();
      rig.place('hand' + s, wrist, aimFlat(q, bladeRest, UP, dir, UP));

      // Hind flipper: trailing back lying and swimming; turned forward under the hips to galumph.
      rig.chain('thigh' + s, 'hips', q.identity());
      const ankle = rig.point('hips', rig.rest('foot' + s), mid);
      const footRest = this.footDir.get(s)!;
      const hindStep = Math.sin(ph + (side > 0 ? Math.PI * 0.5 : Math.PI * 1.5));
      dir.copy(footRest).applyQuaternion(rig.turn.get('hips')!);
      dir.lerp(flat.set(side * 0.55, -0.15, 0.8 + 0.3 * hindStep).normalize(), g).normalize();
      if (sw > 0) dir.lerp(flat.set(side * 0.12, -0.05, -1).normalize(), sw).normalize();
      ankle.y = Math.max(ankle.y, 0.01 * L);
      rig.place('foot' + s, ankle, aimFlat(q, footRest, UP, dir, sw > 0.5 ? w.set(side, 0, 0) : UP));
    }
  }

  /** Where part `i` is posed now (model space): its middle, and its turn with the capsule lying across the body. */
  partAt(i: number, centre: THREE.Vector3, turnOut: THREE.Quaternion) {
    const part = this.parts[i];
    this.rig.point(part.bone, part.centre, centre);
    return turnOut.copy(this.rig.turn.get(part.bone)!).multiply(ACROSS);
  }

  private restDir(from: string, to: string) {
    return new THREE.Vector3().copy(this.rig.rest(to)).sub(this.rig.rest(from));
  }
}

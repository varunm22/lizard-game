import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';

/** The racer model from assets-src/snake.py, with the measurements written on its armature. */
export interface SnakeKit {
  scene: THREE.Object3D;
  /** Snout tip to tail tip, and snout tip to the jaw (m). */
  length: number;
  headLength: number;
  /** Each bone's distance back from the snout tip along the body (m), head first. */
  spine: number[];
  /** Body width and depth at each bone (m). */
  width: number[];
  height: number[];
}

export async function loadSnakeKit(url: string): Promise<SnakeKit> {
  const gltf = await loadGltf(url);
  toonify(gltf.scene);
  const rig = gltf.scene.getObjectByName('Racer');
  const x = (rig?.userData ?? {}) as { length?: number; head_length?: number; spine?: number[]; width?: number[]; height?: number[] };
  if (!x.spine || !x.length || !x.head_length || !x.width || !x.height) throw new Error('snake.glb is missing its spine extras');
  return { scene: gltf.scene, length: x.length, headLength: x.head_length, spine: x.spine, width: x.width, height: x.height };
}

/** A point of the path the neck has crawled over, and how far along that path it lies (m). */
interface TrailPoint {
  x: number;
  y: number;
  z: number;
  d: number;
}

/** A new trail point once the neck is this far (m) from the last one. */
const TRAIL_STEP = 0.004;
/** Each bone's direction is taken across this much of the body either side of it (m). */
const TANGENT_SPAN = 0.012;
/** The bent front of the body is laid out in steps this long (m). */
const BEND_STEP = 0.004;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * One racer's body, laid along the path its neck has crawled: a real snake's body follows its
 * head's track ("follow the leader"), so the waves of lateral undulation stay put on the ground
 * while the body slides through them. The path is a list of points the neck has passed, newest
 * last; each bone of the skinned model is placed at its own distance back along it, turned to the
 * path's direction there. On top of that, the front of the body can be lifted off the ground
 * (`lift`, tapering to nothing `liftReach` back), as a racer does to look about, and the head turned
 * on its own (`headYaw`, `headPitch`). The forked tongue slides out and back (`tongue`, 0 to 1).
 */
export class SnakeBody {
  readonly root: THREE.Object3D;
  readonly length: number;
  readonly headLength: number;
  /** Distance of each bone behind the neck (m): 0 for the head, then each spine bone. */
  readonly arcs: number[];
  readonly width: number[];
  readonly height: number[];
  /** The path the neck has taken, oldest first. */
  private trail: TrailPoint[] = [];
  /** How far up the neck is lifted (m), and how far back along the body the lift reaches. */
  lift = 0;
  liftReach = 0.26;
  /**
   * How far the front of the body curves off its track (radians, as yaw: positive to the left), and
   * how far back the curve reaches (m). A racer turning to look at something bends its neck and
   * forebody round in one smooth curve, rather than kinking at the head.
   */
  turn = 0;
  turnReach = 0.24;
  /** The front of the body as last bent: points from the neck (index 0) back to `turnReach`, every BEND_STEP. */
  private front: THREE.Vector3[] = [];
  private bent = false;
  /** Which way the head points: yaw as the lizard's (0 looks along +Z), and pitch (positive up). */
  headYaw = 0;
  headPitch = 0;
  /** How far out the tongue is (0 in, 1 all the way out), and its flicker (radians up or down). */
  tongue = 0;
  tongueWag = 0;
  private bones: THREE.Bone[];
  private bind: THREE.Matrix4[];
  private parentInverse: THREE.Matrix4[];
  private tongueBone: THREE.Bone;
  private tongueBind: THREE.Quaternion;
  private tongueAxis: 'x' | 'y' | 'z';
  private m = new THREE.Matrix4();
  private r = new THREE.Matrix4();
  private t = new THREE.Vector3();
  private s = new THREE.Vector3();
  private u = new THREE.Vector3();
  private p = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  /** Bone positions as last posed (world m), head first. */
  readonly joints: THREE.Vector3[];

  /** `form` picks the colour form: 0 spotted, 1 striped (the two halves of the skin texture). */
  constructor(kit: SnakeKit, form = 0) {
    this.root = clone(kit.scene);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshToonMaterial;
      if (!m.map) return;
      mesh.material = m.clone();
      const map = m.map.clone();
      map.offset.x = 0.5 * form;
      (mesh.material as THREE.MeshToonMaterial).map = map;
    });
    this.length = kit.length;
    this.headLength = kit.headLength;
    this.arcs = kit.spine.map((s) => s - kit.headLength);
    this.width = kit.width;
    this.height = kit.height;
    this.root.updateMatrixWorld(true);
    const names = ['head', ...kit.spine.slice(1).map((_, i) => `spine_${i + 1}`)];
    this.bones = names.map((n) => this.root.getObjectByName(n) as THREE.Bone);
    this.bind = this.bones.map((b) => b.matrixWorld.clone());
    this.parentInverse = this.bones.map((b) => b.parent!.matrixWorld.clone().invert());
    this.tongueBone = this.root.getObjectByName('tongue') as THREE.Bone;
    this.tongueBind = this.tongueBone.quaternion.clone();
    // The bone axis the tongue lies along: whichever of its own axes points forward (+Z) at rest.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.tongueBone.getWorldQuaternion(new THREE.Quaternion()).invert());
    const ax = [Math.abs(fwd.x), Math.abs(fwd.y), Math.abs(fwd.z)];
    this.tongueAxis = (['x', 'y', 'z'] as const)[ax.indexOf(Math.max(...ax))];
    this.root.traverse((o) => {
      // Skinned to bones that roam the whole level: the rest-pose bounds mean nothing.
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
    });
    this.joints = this.bones.map(() => new THREE.Vector3());
  }

  /** The neck's position on the ground (the newest point of the path). */
  neck(out: THREE.Vector3): THREE.Vector3 {
    const n = this.trail[this.trail.length - 1];
    return out.set(n.x, n.y, n.z);
  }

  /**
   * Lay the body down along a path given from the neck backwards (`points`, world, each on the
   * ground), forgetting where it was.
   */
  layAlong(points: { x: number; y: number; z: number }[]) {
    this.trail = [];
    let d = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      const last = this.trail[this.trail.length - 1];
      if (last) d += Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      this.trail.push({ x: p.x, y: p.y, z: p.z, d });
    }
  }

  /** The neck has moved to (x, y, z): add it to the path if it's gone far enough, and drop what the tail has left. */
  crawlTo(x: number, y: number, z: number) {
    const last = this.trail[this.trail.length - 1];
    const step = Math.hypot(x - last.x, y - last.y, z - last.z);
    if (step < TRAIL_STEP) {
      // Not far enough for a new point: slide the newest one, unless it's the only one left.
      if (this.trail.length > 1) {
        const prev = this.trail[this.trail.length - 2];
        Object.assign(last, { x, y, z, d: prev.d + Math.hypot(x - prev.x, y - prev.y, z - prev.z) });
      }
      return;
    }
    this.trail.push({ x, y, z, d: last.d + step });
    const keep = this.trail[this.trail.length - 1].d - this.length - 0.05;
    let drop = 0;
    while (drop < this.trail.length - 2 && this.trail[drop + 1].d < keep) drop++;
    if (drop > 0) this.trail.splice(0, drop);
  }

  /** The point `back` m behind the neck along the path, on the ground, into `out`. */
  along(back: number, out: THREE.Vector3): THREE.Vector3 {
    const tr = this.trail;
    const head = tr[tr.length - 1];
    const want = head.d - back;
    for (let i = tr.length - 1; i > 0; i--) {
      const a = tr[i - 1];
      if (a.d <= want) {
        const b = tr[i];
        const t = b.d > a.d ? (want - a.d) / (b.d - a.d) : 0;
        return out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      }
    }
    // Past the end of the path: carry on straight from its last stretch.
    const a = tr[0];
    const b = tr[Math.min(1, tr.length - 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const over = a.d - want;
    return out.set(a.x - ((b.x - a.x) / len) * over, a.y, a.z - ((b.z - a.z) / len) * over);
  }

  /**
   * Lay out the bent front of the body: from `turnReach` back, where it leaves its track, walk
   * forward along the track's own wiggles with the heading turned by a growing share of `turn`
   * (none at the root, all of it at the neck, easing in and out so the curve has no corner).
   */
  private bend() {
    this.bent = Math.abs(this.turn) > 1e-3;
    if (!this.bent) return;
    const n = Math.ceil(this.turnReach / BEND_STEP);
    while (this.front.length <= n) this.front.push(new THREE.Vector3());
    const p = this.along(this.turnReach, this.front[n]);
    let px = p.x;
    let pz = p.z;
    for (let i = n - 1; i >= 0; i--) {
      const back = i * BEND_STEP;
      this.along(back + BEND_STEP, this.a);
      this.along(back, this.b);
      const t = 1 - back / this.turnReach;
      const share = t * t * (3 - 2 * t);
      const yaw = Math.atan2(this.b.x - this.a.x, this.b.z - this.a.z) + this.turn * share;
      const len = Math.hypot(this.b.x - this.a.x, this.b.z - this.a.z);
      px += Math.sin(yaw) * len;
      pz += Math.cos(yaw) * len;
      this.front[i].set(px, this.b.y, pz);
    }
  }

  /** The point `back` m behind the neck along the body as bent, on the ground, into `out`. */
  private bentAlong(back: number, out: THREE.Vector3): THREE.Vector3 {
    if (!this.bent || back >= this.turnReach) return this.along(back, out);
    const f = back / BEND_STEP;
    const i = Math.floor(f);
    return out.copy(this.front[i]).lerp(this.front[i + 1], f - i);
  }

  /** Where the body is lifted at `back` m behind the neck (m above the path). */
  private liftAt(back: number) {
    if (this.lift <= 0) return 0;
    const t = Math.max(0, 1 - back / this.liftReach);
    return this.lift * t * t * (3 - 2 * t);
  }

  /** The body's centre line at `back` m behind the neck, with the lift: into `out`. */
  point(back: number, out: THREE.Vector3): THREE.Vector3 {
    this.bentAlong(Math.max(0, back), out);
    if (back < 0) {
      // Ahead of the neck: along the head's own direction.
      const c = Math.cos(this.headPitch);
      out.x += Math.sin(this.headYaw) * c * -back;
      out.z += Math.cos(this.headYaw) * c * -back;
      out.y += Math.sin(this.headPitch) * -back;
    }
    out.y += this.liftAt(Math.max(0, back));
    return out;
  }

  /** Place every bone along the path, and the tongue. */
  pose() {
    this.bend();
    for (let i = 0; i < this.bones.length; i++) {
      const back = this.arcs[i];
      this.point(back, this.p);
      if (i === 0) {
        const c = Math.cos(this.headPitch);
        this.t.set(Math.sin(this.headYaw) * c, Math.sin(this.headPitch), Math.cos(this.headYaw) * c);
      } else {
        this.point(back - TANGENT_SPAN, this.a);
        this.point(back + TANGENT_SPAN, this.b);
        this.t.subVectors(this.a, this.b);
        if (this.t.lengthSq() < 1e-12) this.t.set(0, 0, 1);
        this.t.normalize();
      }
      this.s.crossVectors(UP, this.t);
      if (this.s.lengthSq() < 1e-10) this.s.set(1, 0, 0);
      this.s.normalize();
      this.u.crossVectors(this.t, this.s);
      this.r.makeBasis(this.s, this.u, this.t);
      // About the bind pose's belly line at this bone (0, 0, -s): rotate, then move onto the path.
      const s = this.arcs[i] + this.headLength;
      this.m.makeTranslation(0, 0, s).premultiply(this.r);
      this.m.setPosition(this.v.set(0, 0, s).applyMatrix4(this.r).add(this.p));
      this.m.multiply(this.bind[i]);
      this.m.premultiply(this.parentInverse[i]);
      this.m.decompose(this.bones[i].position, this.bones[i].quaternion, this.bones[i].scale);
      this.joints[i].copy(this.p);
    }
    const out = Math.max(0.01, this.tongue);
    this.tongueBone.scale.set(1, 1, 1);
    this.tongueBone.scale[this.tongueAxis] = out;
    this.q.setFromAxisAngle(this.v.set(1, 0, 0), this.tongueWag);
    this.tongueBone.quaternion.copy(this.tongueBind).multiply(this.q);
  }

  /** Total length of the path held (m), for tests. */
  get trailLength(): number {
    return this.trail[this.trail.length - 1].d - this.trail[0].d;
  }
}

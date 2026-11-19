import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { FreeRig, turn } from '../render/freePose';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import { CORMORANT_ROCKS, PENGUIN_ROCKS, SWIM_LOOPS } from './layout';

/** The lizard swimming this near (m) a swimming bird counts as swimming with it. */
export const WITH = 0.35;
/** Penguins swim their loops this fast (m/s); the cormorant this fast. */
const PENGUIN_SPEED = 0.2;
const CORMORANT_SPEED = 0.12;
/** The going cormorant: on its rock this long (s), then in the sea this long. */
const ASHORE_TIME = 14;
const AT_SEA_TIME = 22;
const WADE_TIME = 1.6;

const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

async function loadBird(url: string, name: string) {
  const gltf = await loadGltf(url);
  toonify(gltf.scene);
  const rig = gltf.scene.getObjectByName(name);
  if (!rig) throw new Error(`no ${name} in ${url}`);
  return rig;
}

/** A bird in the world: where it is, which way it faces, swimming or not, drawn between steps. */
class Bird {
  readonly root: THREE.Object3D;
  readonly rig: FreeRig;
  readonly pos = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  yaw = 0;
  prevYaw = 0;
  /** 0 standing, 1 swimming. */
  swim = 0;
  t: number;

  constructor(source: THREE.Object3D, seed: number) {
    this.root = clone(source);
    this.rig = new FreeRig(this.root);
    this.t = seed * 3.1;
  }

  begin() {
    this.prev.copy(this.pos);
    this.prevYaw = this.yaw;
  }

  draw(alpha: number) {
    this.root.position.lerpVectors(this.prev, this.pos, alpha);
    this.root.rotation.y = this.prevYaw + wrap(this.yaw - this.prevYaw) * alpha;
  }
}

/** Nearest point within reach of (x, z) where the sea is at least `depth` deep, by rings outward. */
function waterNear(x: number, z: number, depth: number): { x: number; z: number } {
  for (let r = 0.1; r < 1.5; r += 0.05) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const px = x + Math.sin(a) * r;
      const pz = z + Math.cos(a) * r;
      if (WATER_Y - terrainHeight(px, pz) > depth) return { x: px, z: pz };
    }
  }
  return { x, z: z - 1 };
}

/**
 * The point's seabirds: Galápagos penguins, two standing at the water's edge looking about and two
 * swimming loops off the beach, low in the water with the head up; and flightless cormorants, one
 * on its rock holding out its stubby wings to dry, the other going to sea for a while and coming
 * back. Posed from a few angles a frame on their free rigs (no clips).
 */
export class Birds {
  readonly penguins: Bird[] = [];
  readonly cormorants: Bird[] = [];
  /** The lizard has swum beside a penguin, and a cormorant. */
  nearPenguin = false;
  nearCormorant = false;
  private time = 0;
  /** The going cormorant: its state, the time in it, where it goes in and its loop's middle. */
  private goer = { state: 'ashore' as 'ashore' | 'in' | 'sea' | 'out', t: 4, entry: { x: 0, z: 0 }, loop: { x: 0, z: 0 }, a: 0 };

  private constructor(
    penguin: THREE.Object3D,
    cormorant: THREE.Object3D,
    scene: THREE.Scene,
    private swimmerFeet: (out: THREE.Vector3) => THREE.Vector3 | null,
    private surface: (x: number, z: number) => number,
  ) {
    PENGUIN_ROCKS.forEach((p, i) => this.penguins.push(this.add(penguin, scene, i, p.x, p.z, p.yaw)));
    SWIM_LOOPS.forEach((l, i) => {
      const b = this.add(penguin, scene, 2 + i, l.x, l.z, 0);
      this.swimLoop(b, i);
      b.begin();
      this.penguins.push(b);
    });
    CORMORANT_ROCKS.forEach((c, i) => this.cormorants.push(this.add(cormorant, scene, 5 + i, c.x, c.z, c.yaw)));
    const home = CORMORANT_ROCKS[1];
    this.goer.entry = waterNear(home.x, home.z, 0.03);
    const out = Math.atan2(this.goer.entry.x - home.x, this.goer.entry.z - home.z);
    const w = waterNear(this.goer.entry.x + Math.sin(out) * 0.45, this.goer.entry.z + Math.cos(out) * 0.45, 0.1);
    this.goer.loop = w;
  }

  /** `surface(x, z)`: the top of whatever is there, sand, lava or a rock. */
  static async load(penguinUrl: string, cormorantUrl: string, scene: THREE.Scene, swimmerFeet: (out: THREE.Vector3) => THREE.Vector3 | null, surface: (x: number, z: number) => number) {
    const [p, c] = await Promise.all([loadBird(penguinUrl, 'Penguin'), loadBird(cormorantUrl, 'Cormorant')]);
    return new Birds(p, c, scene, swimmerFeet, surface);
  }

  private add(source: THREE.Object3D, scene: THREE.Scene, seed: number, x: number, z: number, yaw: number) {
    const b = new Bird(source, seed);
    b.pos.set(x, terrainHeight(x, z), z);
    b.yaw = yaw;
    b.begin();
    scene.add(b.root);
    return b;
  }

  /**
   * Put a bird at (x, z): floating `floatAt` deep if it's swimming and there's water enough under
   * it, otherwise standing on what's there. A swimmer never swims over rock: where a rock or the
   * lava comes up under it, it stands (it is wading in or out).
   */
  private place(b: Bird, x: number, z: number, floatAt: number) {
    const ground = this.surface(x, z);
    if (b.swim > 0.5 && ground > WATER_Y - floatAt) b.swim = 0;
    b.pos.set(x, b.swim > 0.5 ? WATER_Y - floatAt : ground, z);
  }

  /** A swimming penguin where its time `t` puts it round loop `i`. */
  private swimLoop(b: Bird, i: number) {
    const l = SWIM_LOOPS[i];
    const r = (l.rx + l.rz) / 2;
    const a = (b.t * PENGUIN_SPEED) / r + i * 2;
    b.yaw = Math.atan2(-Math.sin(a) * l.rx, Math.cos(a) * l.rz);
    b.swim = 1;
    this.place(b, l.x + Math.cos(a) * l.rx, l.z + Math.sin(a) * l.rz, 0.022);
  }

  step(dt: number) {
    this.time += dt;
    const lizard = this.swimmerFeet(v);
    // The swimmers' loops.
    SWIM_LOOPS.forEach((_, i) => {
      const b = this.penguins[2 + i];
      b.begin();
      b.t += dt;
      this.swimLoop(b, i);
    });
    for (const b of this.penguins.slice(0, 2)) {
      b.begin();
      b.t += dt;
    }
    this.stepGoer(dt);
    this.cormorants[0].begin();
    this.cormorants[0].t += dt;
    if (lizard) {
      const near = (b: Bird) => b.swim > 0.5 && Math.hypot(b.pos.x - lizard.x, b.pos.z - lizard.z) < WITH;
      if (this.penguins.some(near)) this.nearPenguin = true;
      if (this.cormorants.some(near)) this.nearCormorant = true;
    }
  }

  private stepGoer(dt: number) {
    const g = this.goer;
    const b = this.cormorants[1];
    const home = CORMORANT_ROCKS[1];
    b.begin();
    b.t += dt;
    g.t += dt;
    switch (g.state) {
      case 'ashore':
        b.swim = 0;
        b.yaw = home.yaw + 0.3 * Math.sin(b.t * 0.3);
        if (g.t > ASHORE_TIME) {
          g.state = 'in';
          g.t = 0;
        }
        break;
      case 'in': {
        // Shuffles down to the water and slips in.
        const k = Math.min(1, g.t / WADE_TIME);
        b.yaw = Math.atan2(g.entry.x - home.x, g.entry.z - home.z);
        b.swim = k > 0.7 ? 1 : 0;
        this.place(b, home.x + (g.entry.x - home.x) * k, home.z + (g.entry.z - home.z) * k, 0.06);
        if (k >= 1) {
          g.state = 'sea';
          g.t = 0;
          g.a = Math.atan2(g.entry.x - g.loop.x, g.entry.z - g.loop.z);
        }
        break;
      }
      case 'sea': {
        // Round a loop off the point, now and then ducking its head under.
        const r = Math.max(0.2, Math.hypot(g.entry.x - g.loop.x, g.entry.z - g.loop.z));
        g.a += (CORMORANT_SPEED / r) * dt;
        const x = g.loop.x + Math.sin(g.a) * r;
        const z = g.loop.z + Math.cos(g.a) * r;
        b.yaw = g.a + Math.PI / 2;
        b.swim = 1;
        this.place(b, x, z, 0.06);
        if (g.t > AT_SEA_TIME && Math.hypot(x - g.entry.x, z - g.entry.z) < 0.08) {
          g.state = 'out';
          g.t = 0;
        }
        break;
      }
      case 'out': {
        const k = Math.min(1, g.t / WADE_TIME);
        b.yaw = Math.atan2(home.x - g.entry.x, home.z - g.entry.z);
        b.swim = k < 0.3 ? 1 : 0;
        this.place(b, g.entry.x + (home.x - g.entry.x) * k, g.entry.z + (home.z - g.entry.z) * k, 0.06);
        if (k >= 1) {
          g.state = 'ashore';
          g.t = 0;
        }
        break;
      }
    }
  }

  /** The cormorants that are swimming right now, for tests. */
  get cormorantAtSea() {
    return this.goer.state === 'sea';
  }

  update(alpha: number, eye: THREE.Vector3) {
    for (const b of [...this.penguins, ...this.cormorants]) {
      b.draw(alpha);
      if (Math.hypot(b.pos.x - eye.x, b.pos.z - eye.z) > 4) continue;
      if (this.penguins.includes(b)) this.posePenguin(b);
      else this.poseCormorant(b, b === this.cormorants[0]);
    }
  }

  private posePenguin(b: Bird) {
    const rig = b.rig;
    const t = b.t;
    const sw = b.swim;
    // Standing it leans a little forward, looking about; swimming, the body lies along the water, head up.
    const lean = -0.12 - 0.04 * Math.sin(t * 0.7);
    const pitch = sw > 0.5 ? -Math.PI / 2 + 0.12 + 0.03 * Math.sin(t * 6) : lean;
    rig.chain('body', null, turn(q, pitch, 0, sw > 0.5 ? 0.05 * Math.sin(t * 3) : 0));
    const look = sw > 0.5 ? 0.2 * Math.sin(t * 0.8) : 0.9 * Math.sin(t * 0.45) * Math.abs(Math.sin(t * 0.21));
    rig.chain('head', 'body', turn(q, sw > 0.5 ? Math.PI / 2 + 0.25 : -lean * 0.5 + 0.08 * Math.sin(t * 1.3), look));
    for (const [s, side] of [['_L', 1], ['_R', -1]] as const) {
      // Flippers held slightly out standing; swimming, beating back along the body.
      const out = sw > 0.5 ? 0.05 + 0.15 * Math.sin(t * 9) : 0.2 + 0.05 * Math.sin(t * 0.9 + side);
      rig.chain('flipper' + s, 'body', turn(q, 0, 0, side * out));
      if (sw > 0.5) rig.chain('foot' + s, 'body', turn(q, -0.6, 0));
      else rig.chain('foot' + s, null, q.identity());
    }
  }

  private poseCormorant(b: Bird, drying: boolean) {
    const rig = b.rig;
    const t = b.t;
    const sw = b.swim;
    rig.chain('body', null, turn(q, sw > 0.5 ? -0.55 : 0.05 * Math.sin(t * 0.5), 0));
    // The long neck in an S, the head turning; swimming, held up stiffly, now and then ducking under.
    const duck = sw > 0.5 ? Math.max(0, Math.sin(t * 0.35) - 0.9) * 10 : 0;
    rig.chain('neck1', 'body', turn(q, sw > 0.5 ? 0.6 - duck * 0.8 : 0.1 * Math.sin(t * 0.6), 0));
    rig.chain('neck2', 'neck1', turn(q, sw > 0.5 ? 0.05 : -0.1 + 0.08 * Math.sin(t * 0.6 + 1), 0.4 * Math.sin(t * 0.33)));
    rig.chain('head', 'neck2', turn(q, sw > 0.5 ? -0.1 - duck * 0.5 : 0.15 * Math.sin(t * 0.9), 0.5 * Math.sin(t * 0.27)));
    rig.chain('tail', 'body', turn(q, sw > 0.5 ? 0.45 : 0, 0));
    for (const [s, side] of [['_L', 1], ['_R', -1]] as const) {
      // Drying: held out from the sides, shivered now and then; else folded.
      // The wing hangs back along the flank at rest: swung out sideways and raised to dry.
      const shiver = drying ? 0.06 * Math.sin(t * 7) * Math.max(0, Math.sin(t * 0.4)) : 0;
      rig.chain('wing' + s, 'body', drying ? turn(q, 0.95 + shiver, -side * (1.2 + shiver), side * 0.5) : q.identity());
      if (sw > 0.5) rig.chain('foot' + s, 'body', turn(q, -0.4, 0));
      else rig.chain('foot' + s, null, q.identity());
    }
  }
}

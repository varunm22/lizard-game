import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from '../render/gltf';
import { toonify } from '../render/toon';
import { FreeRig, turn } from '../render/freePose';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import type RAPIER from '@dimforge/rapier3d';
import { SolidBody } from '../creatures/solidBody';
import { CORMORANT_ROCKS, PENGUIN_ROCKS, SWIM_LOOPS } from './layout';

/** The lizard swimming this near (m) a swimming bird counts as swimming with it. */
export const WITH = 0.35;
/** The bones each bird's solid body is fitted to: the trunk, neck and head, never wings, flippers, feet or tail. */
const PENGUIN_SOLID = [['body'], ['head']];
const CORMORANT_SOLID = [['body'], ['neck1'], ['neck2'], ['head']];
/** Penguins swim their loops this fast (m/s). */
const PENGUIN_SPEED = 0.2;
/** How deep (m) a bird's feet ride below the surface, swimming: a penguin low with its back out, a cormorant lower still, only its back awash. */
const PENGUIN_FLOAT = 0.022;
const CORMORANT_FLOAT = 0.042;
/** Under water on a dive, its feet this deep (m). */
const DIVE_DEPTH = 0.09;

/** The two birds that go to sea and come back, each by its own species' ways (see `Trip`). */
const TRIPS = {
  penguin: {
    walk: 0.07,
    swim: 0.2,
    float: PENGUIN_FLOAT,
    /** Ashore this long (s), at sea this long. */
    ashore: 18,
    sea: 26,
    /** Into the water: a hop off the edge headfirst, this long (s), this high (m). */
    inTime: 0.45,
    inHop: 0.025,
    /** Out: porpoising in at speed and leaping up onto the rock, landing on its feet. */
    outTime: 0.5,
    outHop: 0.05,
    /** Dives on the way round: this long under (s), every so often (s). */
    dive: 3,
    diveEvery: 7,
  },
  cormorant: {
    walk: 0.06,
    swim: 0.12,
    float: CORMORANT_FLOAT,
    ashore: 14,
    sea: 30,
    /** In: it leans out over the edge and slides in breast first. */
    inTime: 0.9,
    inHop: 0.004,
    /** Out: it swims up to the rock and scrambles up it, wings half open for balance. */
    outTime: 0.9,
    outHop: 0.02,
    dive: 4.5,
    diveEvery: 9,
  },
} as const;
type Species = keyof typeof TRIPS;
/** Back ashore, the cormorant holds its wings out to dry this long (s). */
const DRY_TIME = 12;

const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (k: number) => k * k * (3 - 2 * k);

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
  /** Walking: how much (0..1, eased), and its stride phase, run on by the ground it covers. */
  walk = 0;
  stride = 0;
  /** How far under on a dive (0 at the surface, 1 under). */
  under = 0;
  /** Its whole body's pitch (radians, front up) while it hops in or leaps out, overriding its pose; null otherwise. */
  pitch: number | null = null;
  /** Wings (a cormorant's) half open for balance (0..1). */
  balance = 0;
  /** A cormorant holding its wings out to dry. */
  drying = false;
  /** Its feet's stroke, in cycles (the fraction is where in the stroke it is), and on a dive whether
   * it is heading down (1) or up (-1). */
  kick = 0;
  dip = 0;
  /** Its body, neck and head as the lizard bumps into them (wings, flippers, feet and tail left out). */
  solid!: SolidBody;

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

type TripState = 'ashore' | 'walk' | 'in' | 'sea' | 'out' | 'back';

/**
 * A bird's trip to sea and back, the way its species does it. A penguin waddles down to the edge,
 * hops in headfirst, swims a loop with dives, then porpoises in fast and leaps out onto the rock,
 * landing on its feet. A flightless cormorant walks down, leans out and slides in breast first,
 * swims low with only its back, neck and head out, kicking with both feet together and diving
 * often, then scrambles out with its wings half open and, back on its rock, holds them out to dry.
 */
class Trip {
  state: TripState = 'ashore';
  t: number;
  /** The last dry rock before the water, the first spot deep enough to swim from, and the loop out from it. */
  private edge = new THREE.Vector3();
  private splash = { x: 0, z: 0 };
  private loop = { x: 0, z: 0, ux: 0, uz: 1, rx: 0.5, rz: 0.2 };
  private ready = false;
  private a = Math.PI;
  private diveLeft = 0;
  private nextDive: number;

  constructor(
    readonly bird: Bird,
    readonly species: Species,
    readonly home: { x: number; z: number; yaw: number },
    start: number,
  ) {
    this.t = start;
    this.nextDive = TRIPS[species].diveEvery * 0.6;
  }

  /** Find the way down to the water from its rock, and a loop out to sea clear of rock. */
  private plan(surface: (x: number, z: number) => number) {
    const home = this.home;
    const w = waterNear(home.x, home.z, 0.05);
    let ux = w.x - home.x;
    let uz = w.z - home.z;
    const d = Math.hypot(ux, uz) || 1;
    ux /= d;
    uz /= d;
    const dry = (x: number, z: number) => surface(x, z) > WATER_Y - 0.008;
    // Down to the water's edge, or to the top of a drop to it: it goes in from there, rather than
    // walking down a rock face.
    let s = 0;
    const at = (d: number) => surface(home.x + ux * d, home.z + uz * d);
    while (s < 1.5 && dry(home.x + ux * (s + 0.01), home.z + uz * (s + 0.01)) && at(s) - at(s + 0.01) < 0.012) s += 0.01;
    this.edge.set(home.x + ux * s, 0, home.z + uz * s);
    this.edge.y = surface(this.edge.x, this.edge.z);
    let o = s + 0.08;
    while (o < s + 0.6 && WATER_Y - surface(home.x + ux * o, home.z + uz * o) < 0.05) o += 0.02;
    this.splash = { x: home.x + ux * o, z: home.z + uz * o };
    // An oval out from the splash point and back, shrunk until it keeps to open water.
    const clear = (rx: number, rz: number) => {
      for (let k = 1; k < 32; k++) {
        const a = Math.PI + (k / 32) * Math.PI * 2;
        const x = this.splash.x + ux * rx * (1 + Math.cos(a)) + uz * rz * Math.sin(a);
        const z = this.splash.z + uz * rx * (1 + Math.cos(a)) - ux * rz * Math.sin(a);
        if (surface(x, z) > WATER_Y - DIVE_DEPTH - 0.02) return false;
      }
      return true;
    };
    let rx = 0.6;
    let rz = 0.3;
    for (let i = 0; i < 8 && !clear(rx, rz); i++) {
      rx *= 0.85;
      rz *= 0.85;
    }
    this.loop = { x: this.splash.x + ux * rx, z: this.splash.z + uz * rx, ux, uz, rx, rz };
    this.ready = true;
  }

  /** Where the loop puts it at angle `a` (π at the splash point), and its heading there. */
  private onLoop(a: number) {
    const l = this.loop;
    const c = Math.cos(a) * l.rx;
    const sn = Math.sin(a) * l.rz;
    const dc = -Math.sin(a) * l.rx;
    const ds = Math.cos(a) * l.rz;
    return {
      x: l.x + l.ux * c + l.uz * sn,
      z: l.z + l.uz * c - l.ux * sn,
      yaw: Math.atan2(l.ux * dc + l.uz * ds, l.uz * dc - l.ux * ds),
    };
  }

  /** Walk toward (x, z) on the ground; true once there. */
  private walkTo(x: number, z: number, dt: number, surface: (x: number, z: number) => number) {
    const b = this.bird;
    const dx = x - b.pos.x;
    const dz = z - b.pos.z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(d, TRIPS[this.species].walk * dt);
    if (d > 1e-4) b.yaw = Math.atan2(dx, dz);
    b.pos.x += (dx / (d || 1)) * step;
    b.pos.z += (dz / (d || 1)) * step;
    b.pos.y = surface(b.pos.x, b.pos.z);
    b.stride += step;
    return d - step < 0.002;
  }

  step(dt: number, surface: (x: number, z: number) => number) {
    const b = this.bird;
    const sp = TRIPS[this.species];
    b.begin();
    b.t += dt;
    this.t += dt;
    let walking = 0;
    b.pitch = null;
    b.balance = 0;
    switch (this.state) {
      case 'ashore':
        b.swim = 0;
        b.drying = this.species === 'cormorant' && this.t < DRY_TIME;
        b.yaw = this.home.yaw + 0.3 * Math.sin(b.t * 0.3);
        if (this.t > sp.ashore) {
          if (!this.ready) this.plan(surface);
          this.go('walk');
        }
        break;
      case 'walk':
        b.drying = false;
        walking = 1;
        if (this.walkTo(this.edge.x, this.edge.z, dt, surface)) this.go('in');
        break;
      case 'in': {
        const k = Math.min(1, this.t / sp.inTime);
        // Out over the water from the edge first, then down into it (and a penguin up off its feet first).
        const along = ease(Math.min(1, k * 1.6));
        const down = ease(k) * ease(k);
        b.pos.x = this.edge.x + (this.splash.x - this.edge.x) * along;
        b.pos.z = this.edge.z + (this.splash.z - this.edge.z) * along;
        const sea = WATER_Y - (this.species === 'penguin' ? DIVE_DEPTH * 0.6 : sp.float);
        b.pos.y = this.edge.y + (sea - this.edge.y) * down + 4 * sp.inHop * k * (1 - k);
        b.yaw = Math.atan2(this.splash.x - this.edge.x, this.splash.z - this.edge.z);
        // A penguin goes in headfirst, tipping from upright to diving; a cormorant leans out and slides in level.
        b.pitch = this.species === 'penguin' ? -0.15 - (Math.PI / 2 + 0.25) * ease(k) : -0.15 - 0.6 * Math.sin(Math.PI * Math.min(1, k * 1.2)) * (1 - k) - 0.75 * ease(k);
        b.swim = k > 0.7 ? 1 : 0;
        if (k >= 1) {
          this.go('sea');
          this.a = Math.PI;
          // The penguin came in under and surfaces; the cormorant is swimming at once.
          b.under = this.species === 'penguin' ? 1 : 0;
          b.pitch = null;
        }
        break;
      }
      case 'sea': {
        b.swim = 1;
        const r = (this.loop.rx + this.loop.rz) / 2;
        // Diving now and then, out on the loop: down, along under the surface, and up again.
        this.nextDive -= dt;
        if (this.nextDive <= 0 && this.diveLeft <= 0 && Math.cos(this.a) > -0.6) {
          this.diveLeft = sp.dive;
          this.nextDive = sp.diveEvery + sp.dive;
        }
        this.diveLeft -= dt;
        const want = this.diveLeft > 0.6 ? 1 : 0;
        const before = b.under;
        b.under += (want - b.under) * (1 - Math.exp(-(want ? 3 : 2.5) * dt));
        const u = b.under;
        b.dip = Math.max(-1, Math.min(1, ((b.under - before) / dt) * 1.5));
        // Strokes: a cormorant kicks both feet together, a quick stroke then a glide (burst and
        // glide), faster under water; a penguin paddles its feet at the surface and flies with its
        // flippers under it.
        const cormorant = this.species === 'cormorant';
        b.kick += dt * (cormorant ? 1.1 + 0.9 * u : 1.6 + 1.6 * u);
        // Under water it zooms: much faster than it paddles at the surface, surging with each stroke.
        const f = b.kick % 1;
        const surge = cormorant ? (f < 0.25 ? Math.sin((f / 0.25) * Math.PI) : 0) - 0.25 : 0;
        const zoom = (1 + (cormorant ? 2 : 1.4) * u) * (1 + 0.6 * u * surge);
        this.a += ((sp.swim * zoom) / r) * dt;
        const p = this.onLoop(this.a);
        // Hunting about under water: swinging from side to side off its line and rising and falling,
        // where the water's open enough.
        const swing = Math.sin(this.t * 1.4);
        const floatAt = sp.float + (DIVE_DEPTH - sp.float) * u * (0.85 + 0.15 * Math.sin(this.t * 0.9));
        let off = 0.08 * u * swing;
        const ox = Math.cos(p.yaw) * off;
        const oz = -Math.sin(p.yaw) * off;
        if (off && surface(p.x + ox, p.z + oz) > WATER_Y - floatAt - 0.015) off = 0;
        b.yaw = p.yaw + (off ? 0.45 * u * Math.cos(this.t * 1.4) : 0);
        b.pos.set(p.x + (off ? ox : 0), WATER_Y - floatAt, p.z + (off ? oz : 0));
        const home = Math.abs(wrap(this.a - Math.PI)) < 0.03;
        if (this.t > sp.sea && home && this.diveLeft <= 0 && b.under < 0.05) this.go('out');
        break;
      }
      case 'out': {
        const k = Math.min(1, this.t / sp.outTime);
        const e = ease(k);
        // Up out of the water first, then in onto the rock, so it clears the edge rather than climbing its face.
        const up = ease(Math.min(1, k * 1.5));
        const along = ease(k) * ease(k);
        b.pos.x = this.splash.x + (this.edge.x - this.splash.x) * along;
        b.pos.z = this.splash.z + (this.edge.z - this.splash.z) * along;
        const sea = WATER_Y - sp.float;
        b.pos.y = sea + (this.edge.y - sea) * up + 4 * sp.outHop * k * (1 - k);
        b.yaw = Math.atan2(this.edge.x - this.splash.x, this.edge.z - this.splash.z);
        b.under = 0;
        if (this.species === 'penguin') {
          // Shooting up out of the water nose first, swinging upright to land on its feet.
          b.pitch = -(Math.PI / 2 - 0.5) * (1 - ease(Math.min(1, k * 1.3))) - 0.12;
          b.swim = k < 0.35 ? 1 : 0;
        } else {
          // Breast up onto the rock, wings half open, and up onto its feet.
          b.pitch = -0.75 * (1 - e) + 0.25 * Math.sin(Math.PI * k);
          b.balance = Math.sin(Math.PI * Math.min(1, k * 1.1));
          b.swim = k < 0.4 ? 1 : 0;
          walking = k > 0.5 ? 1 : 0;
          b.stride += k > 0.5 ? sp.walk * dt * 1.5 : 0;
        }
        if (k >= 1) this.go('back');
        break;
      }
      case 'back':
        walking = 1;
        if (this.walkTo(this.home.x, this.home.z, dt, surface)) this.go('ashore');
        break;
    }
    b.walk += (walking - b.walk) * (1 - Math.exp(-8 * dt));
  }

  private go(state: TripState) {
    this.state = state;
    this.t = 0;
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
 * The point's seabirds: Galápagos penguins, one standing at the water's edge looking about, one
 * going to sea and back (`Trip`), and two swimming loops off the beach, low in the water with the
 * head up; and flightless cormorants, one on its rock holding out its stubby wings to dry, the other
 * going to sea and back. Posed from a few angles a frame on their free rigs (no clips).
 */
export class Birds {
  readonly penguins: Bird[] = [];
  readonly cormorants: Bird[] = [];
  /** The lizard has swum beside a penguin, and a cormorant. */
  nearPenguin = false;
  nearCormorant = false;
  private time = 0;
  /** A penguin and a cormorant that go to sea and come back. */
  readonly trips: Trip[] = [];

  private constructor(
    penguin: THREE.Object3D,
    cormorant: THREE.Object3D,
    scene: THREE.Scene,
    world: RAPIER.World,
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
    for (const b of this.penguins) b.solid = SolidBody.fitted(world, b.root, PENGUIN_SOLID);
    for (const b of this.cormorants) b.solid = SolidBody.fitted(world, b.root, CORMORANT_SOLID);
    this.follow();
    this.trips.push(new Trip(this.penguins[0], 'penguin', PENGUIN_ROCKS[0], 6), new Trip(this.cormorants[1], 'cormorant', CORMORANT_ROCKS[1], 2));
  }

  /** `surface(x, z)`: the top of whatever is there, sand, lava or a rock. */
  static async load(penguinUrl: string, cormorantUrl: string, scene: THREE.Scene, world: RAPIER.World, swimmerFeet: (out: THREE.Vector3) => THREE.Vector3 | null, surface: (x: number, z: number) => number) {
    const [p, c] = await Promise.all([loadBird(penguinUrl, 'Penguin'), loadBird(cormorantUrl, 'Cormorant')]);
    return new Birds(p, c, scene, world, swimmerFeet, surface);
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
      b.kick += dt * 1.6;
      this.swimLoop(b, i);
    });
    const p = this.penguins[1];
    p.begin();
    p.t += dt;
    for (const trip of this.trips) trip.step(dt, this.surface);
    this.cormorants[0].begin();
    this.cormorants[0].t += dt;
    this.cormorants[0].drying = true;
    if (lizard) {
      const near = (b: Bird) => b.swim > 0.5 && Math.hypot(b.pos.x - lizard.x, b.pos.z - lizard.z) < WITH;
      if (this.penguins.some(near)) this.nearPenguin = true;
      if (this.cormorants.some(near)) this.nearCormorant = true;
    }
    this.follow();
  }

  /** Every bird's solid body to where this step put it (in its last drawn pose). */
  private follow() {
    for (const b of [...this.penguins, ...this.cormorants]) {
      b.root.position.copy(b.pos);
      b.root.rotation.y = b.yaw;
      b.solid.update();
    }
  }

  update(alpha: number, eye: THREE.Vector3) {
    for (const b of [...this.penguins, ...this.cormorants]) {
      b.draw(alpha);
      if (Math.hypot(b.pos.x - eye.x, b.pos.z - eye.z) > 4) continue;
      if (this.penguins.includes(b)) this.posePenguin(b);
      else this.poseCormorant(b);
    }
  }

  private posePenguin(b: Bird) {
    const rig = b.rig;
    const t = b.t;
    const sw = b.swim > 0.5;
    const wk = b.walk;
    // A waddle: short steps, rocking from foot to foot, the flippers held out behind for balance.
    const ph = (b.stride / 0.02) * Math.PI;
    const rock = Math.sin(ph) * wk;
    // Standing it leans a little forward, looking about; swimming, the body lies along the water,
    // head up, and under water it flies, beating its flippers.
    const lean = -0.12 - 0.04 * Math.sin(t * 0.7) * (1 - wk) - 0.08 * wk;
    const kick = b.kick * Math.PI * 2;
    // Diving it points down going under and up coming back.
    let pitch = sw ? -Math.PI / 2 + 0.12 + 0.03 * Math.sin(kick) * (1 - b.under) - 0.45 * b.dip * b.under : lean;
    if (b.pitch !== null) pitch = b.pitch;
    const diving = b.pitch !== null && b.pitch < -0.6;
    rig.chain('body', null, turn(q, pitch, 0.1 * rock, sw ? 0.05 * Math.sin(t * 3) * (1 - b.under) : 0.17 * rock));
    const look = sw ? 0.2 * Math.sin(t * 0.8) * (1 - b.under) : 0.9 * Math.sin(t * 0.45) * Math.abs(Math.sin(t * 0.21)) * (1 - wk);
    // Head: up out of the water swimming, along the body under it or hopping in and leaping out.
    const headUp = diving ? 0.1 : sw ? Math.PI / 2 + 0.25 - (Math.PI / 2 + 0.1) * b.under : -lean * 0.5 + 0.08 * Math.sin(t * 1.3) * (1 - wk);
    rig.chain('head', 'body', turn(q, headUp, look));
    for (const [s, side] of [['_L', 1], ['_R', -1]] as const) {
      // Flippers: held slightly out standing, out and back walking or leaping, swept back hopping in;
      // swimming a slow scull at the surface, beating hard under it.
      let out = 0.2 + 0.05 * Math.sin(t * 0.9 + side);
      if (wk > 0.01) out += (0.45 + 0.05 * Math.sin(ph * 2) - out) * wk;
      if (sw) out = 0.06 + 0.04 * Math.sin(t * 2) * (1 - b.under) + b.under * (0.12 + 0.32 * Math.sin(kick * 1.5));
      if (b.pitch !== null) out = diving ? 0.12 : 0.6;
      rig.chain('flipper' + s, 'body', turn(q, 0, 0, side * out));
      // Feet: at the surface paddling, one then the other, down and back under it; under water held
      // back together against the tail, steering; stepping, one then the other, walking.
      const paddle = Math.sin(kick + (side > 0 ? 0 : Math.PI));
      const swimFoot = -1.2 + 0.55 * paddle * (1 - b.under) - 0.45 * b.under + 0.08 * b.under * Math.sin(t * 2.3);
      if (sw) rig.chain('foot' + s, 'body', turn(q, swimFoot, 0.12 * side * (1 - b.under)));
      else if (diving) rig.chain('foot' + s, 'body', turn(q, -1.65, 0));
      else rig.chain('foot' + s, null, turn(q, 0.5 * Math.max(0, side * Math.sin(ph)) * wk, 0));
    }
  }

  private poseCormorant(b: Bird) {
    const rig = b.rig;
    const t = b.t;
    const sw = b.swim > 0.5;
    const wk = b.walk;
    const u = b.under;
    const ph = (b.stride / 0.03) * Math.PI;
    const step = Math.sin(ph) * wk;
    // Body: upright standing (its rest pose), bobbing as it walks; swimming it lies level and low,
    // tipping forward to dive.
    // Its feet's stroke (see Trip): a quick stroke back, a glide with the feet stretched behind, and
    // a recovery forward. Under water the body rides a little nose down, more so in the stroke.
    const f = b.kick % 1;
    const stroke = f < 0.25 ? Math.sin((f / 0.25) * Math.PI) : 0;
    let pitch = sw ? -0.9 + 0.025 * Math.sin(t * 2.2) * (1 - u) - u * (0.18 + 0.1 * stroke + 0.55 * b.dip) : 0.05 * Math.sin(t * 0.5) * (1 - wk) - 0.12 * wk + 0.04 * Math.abs(step);
    if (b.pitch !== null) pitch = b.pitch;
    // Leaning out to slide in (not scrambling out, wings open), the neck reaches forward.
    const reaching = b.pitch !== null && b.balance < 0.01 ? Math.min(1, Math.max(0, -(b.pitch + 0.15) / 0.75)) : 0;
    rig.chain('body', null, turn(q, pitch, 0, 0.07 * step));
    // Neck: an S held up out of the water swimming (the bill tilted a little up), stretched out along
    // the body diving or sliding in; standing, an S that turns and looks about; walking, pumping.
    const swimNeck = sw ? 1 : reaching;
    const neck1 = (0.1 * Math.sin(t * 0.6) * (1 - wk) + 0.12 * Math.sin(ph * 2) * wk) * (1 - swimNeck) + swimNeck * (0.9 + 0.04 * Math.sin(t * 2.2 + 0.8) - 1.32 * Math.max(u, reaching * 0.8));
    const neck2 = (-0.1 + 0.08 * Math.sin(t * 0.6 + 1)) * (1 - swimNeck) + swimNeck * (-0.15 + 0.38 * Math.max(u, reaching));
    const turnNeck = 0.4 * Math.sin(t * 0.33) * (1 - wk) * (1 - u) * (sw ? 0.5 : 1);
    rig.chain('neck1', 'body', turn(q, neck1, 0));
    rig.chain('neck2', 'neck1', turn(q, neck2, turnNeck));
    // (Under water the head keeps pointing ahead as the body tilts with each stroke.)
    const head = (0.15 * Math.sin(t * 0.9) * (1 - wk)) * (1 - swimNeck) + swimNeck * (0.42 + 0.68 * Math.max(u, reaching) + 0.1 * u * stroke);
    rig.chain('head', 'neck2', turn(q, head, 0.5 * Math.sin(t * 0.27) * (1 - wk) * (1 - u) * (sw ? 0.4 : 1)));
    // Tail: flat along the water swimming.
    rig.chain('tail', 'body', turn(q, sw ? 0.3 - 0.18 * u - 0.12 * u * stroke : 0, 0));
    for (const [s, side] of [['_L', 1], ['_R', -1]] as const) {
      // Wings: folded tight (they're no use in the water), half open for balance scrambling out,
      // held out from the sides to dry, shivered now and then.
      const shiver = b.drying ? 0.06 * Math.sin(t * 7) * Math.max(0, Math.sin(t * 0.4)) : 0;
      if (b.drying) rig.chain('wing' + s, 'body', turn(q, 0.95 + shiver, -side * (1.2 + shiver), side * 0.5));
      else if (b.balance > 0.01) rig.chain('wing' + s, 'body', turn(q, 0.45 * b.balance, -side * 0.8 * b.balance, side * 0.3 * b.balance));
      else rig.chain('wing' + s, 'body', q.identity());
      // Feet: swimming, both kick back together behind it (cormorants swim with their feet);
      // walking, stepping one then the other.
      const back = f < 0.25 ? ease(f / 0.25) : f < 0.72 ? 1 : 1 - ease((f - 0.72) / 0.28);
      // Both together, splayed a little out from the body; swept wider and harder under water.
      if (sw) rig.chain('foot' + s, 'body', turn(q, -0.55 - (0.85 + 0.35 * u) * back, side * 0.28 * (0.5 + 0.5 * u)));
      else rig.chain('foot' + s, null, turn(q, 0.5 * Math.max(0, side * Math.sin(ph)) * wk, 0));
    }
  }
}

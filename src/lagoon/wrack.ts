import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import type { PlayerController } from '../player/controller';
import { MOVEMENT as M } from '../player/movement';
import { WATER_Y } from '../world/shore';
import { PLAYER_GROUP, terrainHeight } from '../world/terrain';
import { CREEK, CREEK_FLOW, current, DAM, depthAt, inChannel, SNAG } from './layout';

/** Stilled by the water at this rate (per second). */
const DRAG = 1.5;
/**
 * How a dam piece gives way. It's jammed in the tangle (`hold`, 1 to 0), and only a hard knock works
 * it loose: a ram at speed takes RAM per m/s over RAM_FROM off it (a fast swim about a third, a slow
 * one under a fifth), a landing on the tangle STOMP per m/s of fall over STOMP_FROM, and pressing on
 * it a little more (GRIND per second). A knock passes NEIGHBOUR of itself to the pieces it's tangled
 * with (either side across the creek), and a piece working free tugs LOOSEN off each of them.
 */
const RAM = 2.4;
const RAM_FROM = 0.05;
const STOMP = 0.7;
const STOMP_FROM = 0.2;
const GRIND = 0.04;
const NEIGHBOUR = 0.15;
const LOOSEN = 0.1;
/**
 * Once this many pieces are out, the rest of the tangle slackens: each gives SLACKEN at once, with a
 * shudder, but still has to be knocked out.
 */
const SLACK_AT = 4;
const SLACKEN = 0.15;
/** Loosening, a piece sags: leaning over this much further (radians) and settling this far (m) by the time it goes. */
const SAG_LEAN = 0.3;
const SAG_DROP = 0.025;
/** A knock sets it shaking, rocking on its foot: this much (rad/s) per m/s of knock, at this rate (rad/s), dying away at this rate (per second). */
const KICK = 6;
const SHAKE_RATE = 18;
const SHAKE_DAMP = 5;
/** A landing presses the tangle down this far (m) per m/s of fall, springing back at this rate (per second). */
const DIP = 0.012;
const DIP_BACK = 4;
/** Worked free, it topples out of the tangle onto the bed over this long (s), this far (m) along the knock. */
const FALL_TIME = 0.7;
const FALL_REACH = 0.07;
/** How hard the creek bears a piece coming out east, against how it was knocked (1). */
const DOWNSTREAM = 1.5;
/** A landing within this far (m) of a piece's share of the tangle counts as on it: the lizard's body is longer than its feet. */
const ON_TANGLE = 0.04;
/** Only a real fall counts as landing on it: this long in the air (s) at least. */
const MIN_AIR = 0.1;
/** Rolled along the bed by the current at this share of its speed at the surface. */
const BED_SHARE = 0.75;
/** The lizard's snout is against the tangle within this gap of it (m). */
const PUSH_GAP = 0.025;
/** Within this far (m) of the snag on the bed, a piece catches and racks up against it, taking this long (s). */
const CATCH = 0.1;
const RACK_TIME = 0.9;
/** The rack's top: just awash (m under the water), a little more or less piece to piece. */
const RACK_TOP = 0.004;
/** How far each piece leans from upright, pinned downstream against the snag by the current (radians). */
const LEAN = 0.4;
/** A log limb within this gap (m) of a racked piece's top hooks on it. */
const HOOK_GAP = 0.006;
/** The dam stands this far west of `DAM` (m), on the creek's flat bed before it drops into the channel. */
const DAM_WEST = 0.1;
/** The tangle's top stands this far out of the water (m): a heap to climb or land on. */
const DAM_TOP = 0.022;
/** Drift wrack big enough to dam a creek: the pieces are this much bigger than the models. */
const GROWN = 1.3;

export type WrackState = 'dam' | 'falling' | 'loose' | 'racking' | 'racked';

/** One piece of drift wrack: a dead twig or an old propagule, waterlogged, so it lies on the bed. */
export interface WrackPiece {
  kind: string;
  state: WrackState;
  readonly pos: THREE.Vector3;
  readonly quat: THREE.Quaternion;
  readonly body: RAPIER.RigidBody;
  readonly mesh: THREE.Mesh;
  /** Its colliders' segments in its own frame: the long axis is the first, end to end. */
  readonly limbs: { a: THREE.Vector3; b: THREE.Vector3; r: number }[];
  /** Its length along its own X, end to end (m), and how far its underside is below its middle. */
  length: number;
  readonly vel: { x: number; z: number };
  /** Where it lay in the dam. */
  readonly home: { x: number; z: number; yaw: number };
  /** Racking up against the snag: from where, to which slot, how far along (0 to 1). */
  rackT: number;
  from: THREE.Vector3;
  fromQ: THREE.Quaternion;
  slot: number;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  /** In the dam: how firmly it's jammed (1 to 0), its rocking (radians, rad/s, about a level axis through its foot) and how far a landing has pressed it down (m). */
  hold: number;
  shake: number;
  shakeV: number;
  readonly shakeAxis: THREE.Vector3;
  dip: number;
  /** The snout was clear of it last step, so touching it now is a fresh knock. */
  armed: boolean;
  /** The pieces it's tangled with. */
  tangled: WrackPiece[];
  readonly colliders: RAPIER.Collider[];
  /** Its share of the creek's width that the tangle blocks to the lizard while it's jammed in: bed to just over the surface. */
  cell: RAPIER.Collider | null;
  /** That cell's extent (m). */
  box: { x0: number; x1: number; y1: number; z0: number; z1: number };
}

/** The dam, as it lies at the start: offsets from `DAM` (m), heading (radians) and which model. */
const DAM_LAYOUT: { dx: number; dz: number; yaw: number; kind: string }[] = [
  { dx: -0.06, dz: -0.17, yaw: 0.4, kind: 'wrack_stick_0' },
  { dx: 0.02, dz: -0.05, yaw: 1.9, kind: 'propagule' },
  { dx: -0.03, dz: 0.11, yaw: -0.5, kind: 'wrack_stick_1' },
  { dx: 0.06, dz: 0.19, yaw: 1.2, kind: 'propagule' },
  { dx: 0.09, dz: -0.13, yaw: 2.6, kind: 'wrack_stick_1' },
  { dx: -0.1, dz: 0.03, yaw: 1.4, kind: 'wrack_stick_0' },
  { dx: 0.12, dz: 0.06, yaw: -1.1, kind: 'propagule' },
  { dx: -0.02, dz: 0.22, yaw: 0.1, kind: 'wrack_stick_0' },
];
/** Where each racked piece stands along the snag (m from its middle, toward its foot positive): from the lava knob's tip out across the channel, as they come. */
const SLOTS = [0.02, -0.03, -0.08, -0.13, -0.18, -0.23, -0.28, -0.33];

/**
 * The drift wrack: a tangle of dead mangrove twigs and old propagules dammed in the creek's mouth,
 * holding the log's pool back (`CREEK_FLOW.open`, the share cleared). It's solid to the lizard while
 * it holds. Rammed at speed or landed on, a piece shakes and sags, and its neighbours shake with it;
 * knocked enough, it works free and topples out, tugging at the rest, and once half are out the rest
 * slacken (each still has to be knocked out). Loose in the creek or the channel, the current rolls them
 * along the bed, and in the channel they catch on the drowned snag above the narrows and rack up
 * against it, standing up off the bed, pinned downstream, until their tops are awash: a spur out
 * from the east bank that catches a log's leading end.
 * Each piece is a kinematic body moved here; once loose the lizard passes through it, the log doesn't.
 */
export class Wrack {
  readonly pieces: WrackPiece[] = [];
  /** Whether the dam's all gone, every piece loose, so the creek runs. */
  get cleared(): boolean {
    return CREEK_FLOW.open >= 1;
  }
  /** Pieces racked on the snag so far. */
  racked = 0;
  onRacked: ((count: number) => void) | null = null;
  onCleared: (() => void) | null = null;
  private feet = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private p = new THREE.Vector3();
  private cur = { x: 0, z: 0 };
  private q = new THREE.Quaternion();
  private dir = new THREE.Vector3();
  /** The hardest the lizard has fallen (m/s down) since it was last on something or in the water. */
  private falling = 0;
  private airTime = 0;
  /** Most of the dam is out and the rest has slackened. */
  private slackened = false;

  constructor(
    world: RAPIER.World,
    kit: { geometry: Map<string, THREE.BufferGeometry>; extras: Map<string, Record<string, unknown>> },
    material: THREE.Material,
    scene: THREE.Scene,
    private player: PlayerController,
  ) {
    // The snag: the old trunk drowned across the channel on its bar, solid.
    const trunk = new THREE.Mesh(kit.geometry.get('drowned_trunk')!, material);
    trunk.name = 'drowned-trunk';
    const snagQ = new THREE.Quaternion().setFromAxisAngle(Y, -SNAG.heading);
    const snagAt = new THREE.Vector3(SNAG.x, WATER_Y - SNAG.depth - 0.01, SNAG.z);
    trunk.position.copy(snagAt);
    trunk.quaternion.copy(snagQ);
    trunk.receiveShadow = true;
    scene.add(trunk);
    const snag = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(snagAt.x, snagAt.y, snagAt.z).setRotation(snagQ));
    for (const s of kit.extras.get('drowned_trunk')!.segments as number[][]) {
      const a = new THREE.Vector3(s[0], s[1], s[2]);
      const b = new THREE.Vector3(s[3], s[4], s[5]);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize());
      world.createCollider(RAPIER.ColliderDesc.capsule(a.distanceTo(b) / 2, s[6]).setTranslation(mid.x, mid.y, mid.z).setRotation(q), snag);
    }
    for (const spot of DAM_LAYOUT) {
      const geometry = kit.geometry.get(spot.kind)!;
      // A propagule stands up along Y: lay it along X like the twigs.
      const segments = (kit.extras.get(spot.kind)?.segments as number[][] | undefined) ?? [[0, 0.004, 0, 0, 0.13, 0, 0.0055]];
      const g = (spot.kind === 'propagule' ? geometry.clone().rotateZ(-Math.PI / 2).translate(-0.065, 0, 0) : geometry.clone()).scale(GROWN, GROWN, GROWN);
      const limbs = segments.map((s) => {
        const a = new THREE.Vector3(s[0], s[1], s[2]);
        const b = new THREE.Vector3(s[3], s[4], s[5]);
        if (spot.kind === 'propagule') {
          a.set(a.y - 0.065, -a.x, a.z);
          b.set(b.y - 0.065, -b.x, b.z);
        }
        return { a: a.multiplyScalar(GROWN), b: b.multiplyScalar(GROWN), r: s[6] * GROWN };
      });
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const colliders: RAPIER.Collider[] = [];
      for (const l of limbs) {
        const mid = l.a.clone().add(l.b).multiplyScalar(0.5);
        const q = new THREE.Quaternion().setFromUnitVectors(Y, l.b.clone().sub(l.a).normalize());
        colliders.push(
          world.createCollider(
            RAPIER.ColliderDesc.capsule(l.a.distanceTo(l.b) / 2, l.r)
              .setTranslation(mid.x, mid.y, mid.z)
              .setRotation(q)
              .setCollisionGroups(LOG_ONLY)
              .setSolverGroups(LOG_ONLY)
              // Wet and smooth: a log pressed against the rack slides along it.
              .setFriction(0)
              .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
            body,
          ),
        );
      }
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.name = `wrack-${this.pieces.length}`;
      scene.add(mesh);
      // Smaller stuff caught on it up top, out of the water: a twig and a propagule across it. They go
      // where it goes, shaking with it and coming out with it.
      const n = this.pieces.length;
      const top = (spot.kind === 'propagule' ? 0.065 : 0.09) * GROWN;
      for (const [kind, at, turn, tilt] of [
        ['wrack_stick_1', top - 0.035, 1.3 + (n % 3) * 0.3, 0.25],
        ['propagule', top - 0.06, -1.1 - (n % 2) * 0.5, -0.35],
      ] as const) {
        const caught = new THREE.Mesh(kind === 'propagule' ? kit.geometry.get(kind)!.clone().rotateZ(-Math.PI / 2).translate(-0.065, 0, 0) : kit.geometry.get(kind)!, material);
        caught.position.set(at, 0, (n % 2 ? 1 : -1) * 0.008);
        caught.rotation.set(tilt, turn, 0);
        caught.castShadow = true;
        mesh.add(caught);
      }
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const l of limbs) {
        x0 = Math.min(x0, l.a.x, l.b.x);
        x1 = Math.max(x1, l.a.x, l.b.x);
      }
      this.pieces.push({
        kind: spot.kind,
        state: 'dam',
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        body,
        mesh,
        limbs,
        length: x1 - x0,
        vel: { x: 0, z: 0 },
        home: { x: DAM.x - DAM_WEST + spot.dx, z: DAM.z + spot.dz, yaw: spot.yaw },
        rackT: 0,
        from: new THREE.Vector3(),
        fromQ: new THREE.Quaternion(),
        slot: -1,
        prevPos: new THREE.Vector3(),
        prevQuat: new THREE.Quaternion(),
        hold: 1,
        shake: 0,
        shakeV: 0,
        shakeAxis: new THREE.Vector3(0, 0, -1),
        dip: 0,
        armed: true,
        tangled: [],
        colliders,
        cell: null,
        box: { x0: 0, x1: 0, y1: 0, z0: 0, z1: 0 },
      });
    }
    // The tangle across the creek, as the lizard meets it: a slab from bank to bank, cut into one cell
    // per piece across it, so a gap opens where one comes out. Its top is just over the surface, so the
    // lizard can climb or land on it.
    const byZ = [...this.pieces].sort((p, q) => p.home.z - q.home.z);
    const x0 = DAM.x - DAM_WEST + Math.min(...DAM_LAYOUT.map((d) => d.dx)) - 0.02;
    const x1 = DAM.x - DAM_WEST + Math.max(...DAM_LAYOUT.map((d) => d.dx)) + 0.02;
    const y0 = WATER_Y - CREEK.depth - 0.06;
    const y1 = WATER_Y + DAM_TOP;
    // Equal shares of the water's width; the end ones run on up the banks.
    const zA = CREEK.z - CREEK.half;
    const zB = CREEK.z + CREEK.half;
    byZ.forEach((w, k) => {
      const z0 = zA + ((zB - zA) * k) / byZ.length - (k === 0 ? 0.1 : 0);
      const z1 = zA + ((zB - zA) * (k + 1)) / byZ.length + (k === byZ.length - 1 ? 0.1 : 0);
      w.box = { x0, x1, y1, z0, z1 };
      // It stands in the middle of its share, give or take, tangled with the pieces either side.
      const zMid = zA + ((zB - zA) * (k + 0.5)) / byZ.length + (((k * 37) % 7) / 7 - 0.5) * 0.02;
      w.home.z = THREE.MathUtils.clamp(zMid, CREEK.z - CREEK.half + 0.04, CREEK.z + CREEK.half - 0.04);
      w.tangled = [byZ[k - 1], byZ[k + 1]].filter((o): o is WrackPiece => !!o);
      w.cell = world.createCollider(
        RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)
          .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
          .setCollisionGroups(CELL)
          .setFriction(0.9),
      );
    });
    this.reset();
  }

  /** Back in the creek's mouth, damming it, as at the start. */
  reset() {
    this.racked = 0;
    for (const w of this.pieces) {
      w.state = 'dam';
      w.vel.x = w.vel.z = 0;
      w.slot = -1;
      w.hold = 1;
      w.shake = w.shakeV = w.dip = 0;
      w.shakeAxis.set(0, 0, -1);
      w.armed = true;
      this.solid(w, true);
      this.pile(w, this.pieces.indexOf(w));
      w.prevPos.copy(w.pos);
      w.prevQuat.copy(w.quat);
      w.body.setTranslation(w.pos, true);
      w.body.setRotation(w.quat, true);
    }
    CREEK_FLOW.open = 0;
    this.slackened = false;
  }

  /** Every piece racked on the snag at once (tests). */
  rackAll() {
    for (const w of this.pieces) if (w.state !== 'racked') {
      this.solid(w, false);
      this.startRack(w);
    }
    for (const w of this.pieces) this.place(w, 1);
    CREEK_FLOW.open = 1;
  }

  /**
   * Stand a piece in the dam: jammed in the tangle on end, leaning upstream or down, one way and the
   * other piece to piece, its top up at the surface or just out of it.
   */
  private pile(w: WrackPiece, i: number) {
    const jitter = ((i * 37) % 7) / 7 - 0.5;
    const loosened = 1 - w.hold;
    const side = i % 2 === 0 ? 1 : -1;
    const surface = WATER_Y + DAM_TOP + jitter * 0.01;
    const up = this.dir;
    if (w.kind === 'propagule') {
      // Caught across the sticks just under the surface, nearly level: the tangle's top.
      const tilt = side * (0.12 + jitter * 0.15) - SAG_LEAN * loosened;
      // Along the creek, give or take, so it stays in its own share of the tangle.
      const turn = 0.35 * Math.sin(w.home.yaw);
      up.set(Math.cos(turn) * Math.cos(tilt), Math.sin(tilt), Math.sin(turn) * Math.cos(tilt));
      w.pos.set(w.home.x, surface - 0.012 - SAG_DROP * loosened - w.dip, w.home.z);
    } else {
      // Standing on end, its foot in the mud, leaning so its top reaches the surface.
      const bed = terrainHeight(w.home.x, w.home.z);
      const lean = Math.acos(THREE.MathUtils.clamp((surface - bed) / w.length, 0.3, 0.97)) + jitter * 0.15 + SAG_LEAN * loosened;
      // Leaning up or down the creek, a little to one side: within its own share of the tangle.
      up.set(side * Math.sin(lean), Math.cos(lean), 0.3 * Math.sin(lean) * Math.sin(w.home.yaw)).normalize();
      w.pos.set(w.home.x, bed + 0.004 - w.dip, w.home.z).addScaledVector(up, w.length / 2);
    }
    w.quat.setFromUnitVectors(X, up);
    // Rocking on its foot.
    if (w.shake !== 0) {
      const foot = this.p.copy(w.pos).addScaledVector(up, -w.length / 2);
      this.q.setFromAxisAngle(w.shakeAxis, w.shake);
      w.pos.sub(foot).applyQuaternion(this.q).add(foot);
      w.quat.premultiply(this.q);
    }
  }

  /** Its share of the dam blocking the creek to the lizard (jammed in it) or not (out of it: a gap). */
  private solid(w: WrackPiece, on: boolean) {
    w.cell?.setEnabled(on);
  }

  /** A knock on a piece in the dam at `speed` (m/s) along `dir` (level): it shakes, its neighbours with it, and it gives a little. */
  private knock(w: WrackPiece, speed: number, dir: THREE.Vector3, wear: number) {
    this.kick(w, speed, dir);
    w.hold -= wear;
    for (const o of w.tangled) {
      if (o.state !== 'dam') continue;
      this.kick(o, speed * NEIGHBOUR, dir);
      o.hold -= wear * NEIGHBOUR;
    }
  }

  private kick(w: WrackPiece, speed: number, dir: THREE.Vector3) {
    // Rocking over away from the knock: about the level axis across it.
    w.shakeAxis.set(dir.z, 0, -dir.x).normalize();
    w.shakeV += speed * KICK;
  }

  /** Worked free of the tangle: it topples out along `dir` (level) and the current has it. */
  free(w: WrackPiece, dir: { x: number; z: number }, speed = 0.05) {
    if (w.state !== 'dam') return;
    const n = Math.hypot(dir.x, dir.z) || 1;
    w.state = 'falling';
    w.rackT = 0;
    w.from.copy(w.pos);
    w.fromQ.copy(w.quat);
    // It goes the way it was knocked, but the creek's water bears it downstream, east.
    const ex = dir.x / n + DOWNSTREAM;
    const ez = dir.z / n;
    const e = Math.hypot(ex, ez) || 1;
    w.vel.x = (ex / e) * speed;
    w.vel.z = (ez / e) * speed;
    this.solid(w, false);
    // Tugging at what it was tangled with.
    this.dir.set(dir.x / n, 0, dir.z / n);
    for (const o of w.tangled) {
      if (o.state !== 'dam') continue;
      o.hold -= LOOSEN;
      this.kick(o, 0.15, this.dir);
    }
  }

  /** Lay a piece on the bed at (x, z), along `yaw`, a little rolled so it isn't level. */
  private lay(w: WrackPiece, x: number, z: number, yaw: number) {
    w.pos.set(x, terrainHeight(x, z) + 0.008, z);
    w.quat.setFromAxisAngle(Y, -yaw);
  }

  step(dt: number, pushing: boolean) {
    const player = this.player;
    player.feetAt(1, this.feet);
    const fx = Math.sin(player.yaw);
    const fz = Math.cos(player.yaw);
    this.dir.set(fx, 0, fz);
    // Rammed: the snout meeting a piece at speed. (Its last step's speed: touching, it's stopped.)
    const ramSpeed = Math.max(0, player.velocity.x * fx + player.velocity.z * fz);
    // Landed on: the hardest fall since last on something, now on the tangle or through it into the water.
    if (!player.grounded && !player.swimming && !player.climbing) {
      this.airTime += dt;
      if (this.airTime > MIN_AIR) this.falling = Math.max(this.falling, -player.velocity.y);
    } else {
      if (this.falling > STOMP_FROM) this.landOn(this.falling);
      this.falling = 0;
      this.airTime = 0;
    }
    let loose = 0;
    let out = 0;
    for (const w of this.pieces) if (w.state !== 'dam') out++;
    for (const w of this.pieces) {
      w.prevPos.copy(w.pos);
      w.prevQuat.copy(w.quat);
      if (w.state === 'racked') {
        loose++;
        continue;
      }
      if (w.state === 'racking') {
        loose++;
        w.rackT = Math.min(1, w.rackT + dt / RACK_TIME);
        this.place(w, w.rackT);
        continue;
      }
      if (w.state === 'dam') {
        const touching = this.touching(w, fx, fz);
        if (touching && w.armed && ramSpeed > RAM_FROM) this.knock(w, ramSpeed, this.dir, RAM * (ramSpeed - RAM_FROM));
        w.armed = !touching;
        if (touching && pushing) {
          w.hold -= GRIND * dt;
          if (w.shakeV === 0 && w.shake === 0) this.kick(w, 0.02, this.dir);
        }
        // Most of it out, the rest slackens once (and stays standing).
        if (out >= SLACK_AT && !this.slackened) {
          for (const o of this.pieces)
            if (o.state === 'dam') {
              o.hold -= SLACKEN;
              o.shakeV += 0.4;
            }
          this.slackened = true;
        }
        // Shaking on its foot, springing back up after a landing.
        w.shakeV += (-SHAKE_RATE * SHAKE_RATE * w.shake - 2 * SHAKE_DAMP * w.shakeV) * dt;
        w.shake += w.shakeV * dt;
        if (Math.abs(w.shake) < 1e-4 && Math.abs(w.shakeV) < 1e-3) w.shake = w.shakeV = 0;
        w.dip *= Math.exp(-DIP_BACK * dt);
        if (w.hold <= 0) {
          // Out it goes, the way it was pushed: downstream, unless knocked another way.
          const along = w.shakeAxis.lengthSq() > 0 ? { x: -w.shakeAxis.z, z: w.shakeAxis.x } : { x: 1, z: 0 };
          this.free(w, along);
        } else {
          this.pile(w, this.pieces.indexOf(w));
          w.body.setNextKinematicTranslation(w.pos);
          w.body.setNextKinematicRotation(w.quat);
          continue;
        }
      }
      loose++;
      if (w.state === 'falling') {
        // Toppling out of the tangle onto the bed, drifting the way it was knocked.
        w.rackT = Math.min(1, w.rackT + dt / FALL_TIME);
        const t = w.rackT;
        const s = t * t * (3 - 2 * t);
        const n = Math.hypot(w.vel.x, w.vel.z) || 1;
        const tx = w.home.x + (w.vel.x / n) * FALL_REACH;
        const tz = w.home.z + (w.vel.z / n) * FALL_REACH;
        this.lay(w, tx, tz, w.home.yaw + 0.6);
        w.pos.lerpVectors(w.from, w.pos, s);
        w.quat.slerpQuaternions(w.fromQ, w.quat, s);
        if (t >= 1) w.state = 'loose';
        w.body.setNextKinematicTranslation(w.pos);
        w.body.setNextKinematicRotation(w.quat);
        continue;
      }
      // The current along the bed, or the still water.
      current(w.pos.x, w.pos.z, this.cur);
      if (this.cur.x !== 0 || this.cur.z !== 0) {
        const k = Math.min(1, 2 * dt);
        w.vel.x += (this.cur.x * BED_SHARE - w.vel.x) * k;
        w.vel.z += (this.cur.z * BED_SHARE - w.vel.z) * k;
      } else {
        const d = Math.exp(-DRAG * dt);
        w.vel.x *= d;
        w.vel.z *= d;
      }
      const nx = w.pos.x + w.vel.x * dt;
      const nz = w.pos.z + w.vel.z * dt;
      // Only along the bed under water: it stops against a bank.
      if (depthAt(nx, nz) > 0.02) {
        // Tumbling a little as it goes.
        const yaw = -2 * Math.atan2(w.quat.y, w.quat.w) + Math.hypot(w.vel.x, w.vel.z) * dt * 3;
        this.lay(w, nx, nz, yaw);
      } else {
        w.vel.x *= -0.2;
        w.vel.z *= -0.2;
      }
      // On the snag: it catches and racks up.
      if (inChannel(w.pos.x, w.pos.z) && this.toSnag(w.pos.x, w.pos.z) < CATCH) this.startRack(w);
      w.body.setNextKinematicTranslation(w.pos);
      w.body.setNextKinematicRotation(w.quat);
    }
    const open = loose / this.pieces.length;
    if (open === 1 && CREEK_FLOW.open < 1) this.onCleared?.();
    CREEK_FLOW.open = open;
  }

  /** The lizard came down at `speed` (m/s): on the tangle, or through it into the water, it presses it down and shakes it. */
  private landOn(speed: number) {
    const f = this.feet;
    let hit = false;
    // Pressed down and over, the way the lizard came.
    const h = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    this.dir.set(h > 0.02 ? this.player.velocity.x / h : Math.sin(this.player.yaw), 0, h > 0.02 ? this.player.velocity.z / h : Math.cos(this.player.yaw));
    for (const w of this.pieces) {
      const b = w.box;
      if (w.state !== 'dam' || f.y > b.y1 + 0.03 || f.y < b.y1 - 0.06) continue;
      if (f.x < b.x0 - ON_TANGLE || f.x > b.x1 + ON_TANGLE || f.z < b.z0 - ON_TANGLE || f.z > b.z1 + ON_TANGLE) continue;
      hit = true;
      w.dip += DIP * speed;
      this.knock(w, speed * 0.5, this.dir, STOMP * (speed - STOMP_FROM));
    }
    // The whole tangle shudders.
    if (hit) for (const w of this.pieces) if (w.state === 'dam') w.shakeV += speed * KICK * 0.15 * (w.shakeV >= 0 ? 1 : -1);
  }

  /** Distance (m) from (x, z) to the snag's line, seen from above. */
  private toSnag(x: number, z: number): number {
    const sx = Math.cos(SNAG.heading);
    const sz = Math.sin(SNAG.heading);
    const t = Math.max(-SNAG.half, Math.min(SNAG.half, (x - SNAG.x) * sx + (z - SNAG.z) * sz));
    return Math.hypot(x - SNAG.x - sx * t, z - SNAG.z - sz * t);
  }

  /** Catch on the snag: the next free slot along it, and it stands up there. */
  private startRack(w: WrackPiece) {
    w.state = 'racking';
    w.shake = w.shakeV = 0;
    w.rackT = 0;
    w.slot = this.racked++;
    w.from.copy(w.pos);
    w.fromQ.copy(w.quat);
    this.onRacked?.(this.racked);
  }

  /** A racking piece `t` of the way (0 to 1) from where it caught to its slot: standing up off the bed, leaning downstream against the snag, its top at the rack's top. */
  private place(w: WrackPiece, t: number) {
    const sx = Math.cos(SNAG.heading);
    const sz = Math.sin(SNAG.heading);
    const k = SLOTS[w.slot % SLOTS.length];
    // Upstream of the snag's line (north), a little out of line piece to piece.
    const jitter = ((w.slot * 37) % 7) / 7 - 0.5;
    const x = SNAG.x + sx * k + sz * 0.035 + jitter * 0.01;
    const z = SNAG.z + sz * k - sx * 0.035;
    const top = WATER_Y - RACK_TOP + jitter * 0.012;
    // Its own X stands up, leaning downstream (south, across the snag) and along it, one way and the
    // other piece to piece, so they cross like a rack rather than standing in a row.
    const along = (w.slot % 2 === 0 ? 1 : -1) * (0.5 + jitter * 0.3);
    const up = new THREE.Vector3(-sz * Math.sin(LEAN), Math.cos(LEAN), sx * Math.sin(LEAN)).add(new THREE.Vector3(sx, 0, sz).multiplyScalar(along)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(X, up);
    const mid = new THREE.Vector3(x, top, z).addScaledVector(up, -w.length / 2);
    const s = t * t * (3 - 2 * t);
    w.pos.lerpVectors(w.from, mid, s);
    w.quat.slerpQuaternions(w.fromQ, q, s);
    if (t >= 1) w.state = 'racked';
    w.body.setNextKinematicTranslation(w.pos);
    w.body.setNextKinematicRotation(w.quat);
    if (t >= 1 && w.rackT >= 1) {
      w.body.setTranslation(w.pos, true);
      w.body.setRotation(w.quat, true);
    }
  }

  /**
   * Whether a log limb from `a` to `b` (radius `r`, world) touches a racked piece's upper half, where
   * the twigs' forks stand up out of the tangle: the point on the piece it hooks on into `out`.
   */
  hooks(a: THREE.Vector3, b: THREE.Vector3, r: number, out: THREE.Vector3): boolean {
    for (const w of this.pieces) {
      if (w.state !== 'racked') continue;
      const l = w.limbs[0];
      this.a.copy(l.a).applyQuaternion(w.quat).add(w.pos);
      this.b.copy(l.b).applyQuaternion(w.quat).add(w.pos);
      if (this.a.y > this.b.y) this.a.lerp(this.b, 0.5);
      else this.b.lerp(this.a, 0.5);
      if (segmentDistance(a, b, this.a, this.b, this.p, out) < r + l.r + HOOK_GAP) return true;
    }
    return false;
  }

  /** Whether the lizard's snout is against a piece's share of the tangle. */
  private touching(w: WrackPiece, fx: number, fz: number): boolean {
    const b = w.box;
    const reach = M.bodyHalfLength + M.bodyRadius + PUSH_GAP;
    const pos = this.player.position;
    const sx = pos.x + fx * reach;
    const sz = pos.z + fz * reach;
    return pos.y < b.y1 + M.bodyRadius && sx > b.x0 && sx < b.x1 && sz > b.z0 && sz < b.z1;
  }

  /** The drawn pieces, between the last two physics steps. */
  update(alpha: number) {
    for (const w of this.pieces) {
      w.mesh.position.lerpVectors(w.prevPos, w.pos, alpha);
      w.mesh.quaternion.slerpQuaternions(w.prevQuat, w.quat, alpha);
    }
  }
}

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
/** The pieces themselves meet only the log; the lizard meets the dam's cells (`DAM_CELL`). */
const LOG_ONLY = (0xffff << 16) | (0xffff & ~PLAYER_GROUP);
/** The dam's cells stop only the lizard. */
const DAM_GROUP = 0x0040;
const CELL = (DAM_GROUP << 16) | PLAYER_GROUP;
const d1 = new THREE.Vector3();
const d2 = new THREE.Vector3();
const rr = new THREE.Vector3();

/** Closest distance between segments p1-q1 and p2-q2, with the closest points on each into c1 and c2. */
function segmentDistance(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3): number {
  d1.subVectors(q1, p1);
  d2.subVectors(q2, p2);
  rr.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(rr);
  const c = d1.dot(rr);
  const b = d1.dot(d2);
  const den = a * e - b * b;
  let s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.max(0, Math.min(1, -c / a));
  } else if (t > 1) {
    t = 1;
    s = Math.max(0, Math.min(1, (b - c) / a));
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceTo(c2);
}

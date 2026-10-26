import * as THREE from 'three';
import { wrapAngle } from '../math/angles';
import { rng } from '../world/noise';
import type { Obstacle } from '../world/obstacles';
import { terrainHeight } from '../world/terrain';
import { GroundProbe, steer } from './ground';
import { SnakeBody, type SnakeKit } from './snakeBody';

/**
 * Something a racer hunts: the player, or one of the other hatchlings. Positions are world metres.
 */
export interface Prey {
  /** 'player', or 'hatchling-<n>'. */
  readonly id: string;
  /** Its feet, the middle of its body on the ground. */
  feet(out: THREE.Vector3): THREE.Vector3;
  /** Points along its body that a snake has to see (snout, middle, hips). */
  sightPoints(): readonly THREE.Vector3[];
  /** Ground speed now (m/s). Racers hunt by movement: what holds still is hard for them to see. */
  speed(): number;
  /** Down a burrow or under a bush: out of sight unless a snake is right beside it. */
  inCover(): boolean;
  /** Still out on the dunes to be hunted (not caught, not safe at the shore). */
  huntable(): boolean;
  /** A strike has landed. */
  caught(by: Racer): void;
}

/** Racer tuning: distances in m, speeds in m/s, times in s. */
export const RACER = {
  /** How far a lurking snake sees movement, and how far once it's after something. */
  sight: 1.15,
  chaseSight: 1.7,
  /** Anything this close is found by smell and touch, moving or not. */
  smell: 0.13,
  /** Under a bush, prey is found only this close. */
  bushSmell: 0.22,
  /** Slower than this counts as holding still. */
  moving: 0.04,
  /** Seconds of watching something move (sooner the closer it is) before the head comes up, and before the chase. */
  alertAt: 0.06,
  chaseAt: 1.0,
  /** Close enough that any movement it sees sets it off at once. */
  pounce: 0.4,
  /** Crawling home or about, searching, chasing; and the opening dash of a chase, faster than a hatchling's run. */
  crawl: 0.13,
  search: 0.16,
  chase: 0.47,
  dash: 0.68,
  dashTime: 0.55,
  /** The strike: from this far (head tip to prey), lunging this fast for at most this long; a hit within `bite`. */
  strikeRange: 0.11,
  strikeSpeed: 1.5,
  strikeTime: 0.14,
  bite: 0.035,
  strikeRest: 0.35,
  /** A chase is given up after this long, or this long without seeing the prey move, or this far from home. */
  chaseTime: 5,
  lostTime: 0.9,
  leash: 2.4,
  /** Nosing about where the prey was last seen, before going home. */
  searchTime: 3.5,
  /** Coiled round a catch, then lying up digesting it. */
  feedTime: 3,
  restTime: 14,
  /**
   * Lateral undulation: one wave of the body per this much crawled, the head's track swinging this
   * far (radians) either side of the course. A racer's body shows two or three waves along its length,
   * each about a tenth of it across.
   */
  wave: 0.34,
  sway: 0.8,
  /** How fast the course turns toward where it's going (radians per second), crawling and chasing. */
  turn: 3,
  chaseTurn: 6,
  /** The course bends no tighter than this (radians per m crawled), so a turn spreads along the body as a curve. */
  bend: 7,
};

export type RacerState = 'lurk' | 'prowl' | 'alert' | 'chase' | 'strike' | 'search' | 'feed' | 'rest' | 'return';

/** Lift of the neck off the ground in each state (m): head up to look about when alert. */
const LIFT: Record<RacerState, number> = { lurk: 0.012, prowl: 0.012, alert: 0.065, chase: 0.018, strike: 0.03, search: 0.014, feed: 0.01, rest: 0.004, return: 0.01 };
/** Where the obstacle check looks ahead (m), and the clearance it keeps from rocks. */
const LOOK = 0.16;
const MARGIN = 0.02;
const STEER_EVERY = 4;
/**
 * Lying up, a racer now and then crawls a little way about its home and lies up again where it
 * stops: after `wait` to `wait + waitMore` s, to a spot `near` to `far` m from home, at `speed`,
 * giving up after `time` s.
 */
const PROWL = { wait: 8, waitMore: 14, near: 0.15, far: 0.4, speed: 0.1, time: 8 };

/** One racer: where it lies up, what it's doing, and its body. */
export class Racer {
  state: RacerState = 'lurk';
  /** What it's watching, chasing or holding. */
  prey: Prey | null = null;
  /** Seconds of movement watched, toward `alertAt` and `chaseAt`. */
  notice = 0;
  readonly neck = new THREE.Vector3();
  /** Facing of the course it's crawling (yaw, as the lizard's). */
  course: number;
  /** Speed now (m/s). */
  speed = 0;
  /** Strikes made and landed, chases begun and given up. */
  strikes = 0;
  catches = 0;
  chases = 0;
  giveUps = 0;
  /** Seconds in the current state. */
  timer = 0;
  paused = false;
  readonly lastSeen = new THREE.Vector3();
  /** Seconds since it last saw its quarry move (chasing), and since its last strike. */
  lost = 0;
  sinceStrike = Infinity;
  /** Where the body's wave is (radians), the course the obstacle check last allowed and when it next looks. */
  phase = 0;
  steerTick: number;
  steered: number;
  strikeYaw = 0;
  /** Tongue flick under way (s left) and the wait for the next; the head's idle look about. */
  flick = 0;
  nextFlick: number;
  lookYaw = 0;
  nextLook = 0;
  /** Seconds left lying up before it next prowls about home, and where that prowl is going. */
  prowlIn: number;
  readonly prowlTo = new THREE.Vector3();

  constructor(
    readonly index: number,
    readonly body: SnakeBody,
    readonly home: { x: number; z: number; yaw: number },
    readonly rand: () => number,
  ) {
    this.course = home.yaw;
    this.steered = home.yaw;
    this.steerTick = index % STEER_EVERY;
    this.nextFlick = 1 + rand() * 3;
    this.prowlIn = PROWL.wait + rand() * PROWL.waitMore;
  }

  /** The tip of its snout, as last posed. */
  snout(out: THREE.Vector3): THREE.Vector3 {
    return this.body.point(-this.body.headLength, out);
  }

  /** Where its eyes are, a little above the head as last posed. */
  eye(out: THREE.Vector3): THREE.Vector3 {
    this.body.point(-0.012, out);
    out.y += 0.009;
    return out;
  }
}

/**
 * The racer snakes of the nesting dunes. Each lies up coiled by a lava knoll or the shore rocks
 * with its head just off the sand, flicking its tongue, and hunts by movement as the Fernandina
 * racers do: something moving in plain sight within about a metre makes it lift its head and
 * watch, and if it keeps moving (or moves close by) the snake goes after it, faster than a
 * hatchling can run for the first half second, then a little slower. Within a head's length or so
 * it strikes, and a strike that lands is a catch: it coils round its prey, then lies up digesting.
 *
 * What holds still is hard for it to see. A chase loses its quarry once it hasn't seen it move for
 * a moment, unless it's close enough to find by smell; then the snake noses about where it last saw
 * it, and goes home. It also gives up a long chase, or one that strays too far from home. Dune
 * crests, rocks and the adult iguanas block its view; a burrow or a bush hides prey from it unless
 * it's right beside it.
 */
export class Racers {
  readonly list: Racer[] = [];
  /** Called when a racer gives up a chase with its quarry still free. */
  onGiveUp: ((racer: Racer, prey: Prey) => void) | null = null;
  /** Called as a racer that was watching or nosing after prey goes home without it. */
  onLeave: ((racer: Racer, prey: Prey) => void) | null = null;
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private feet = new THREE.Vector3();

  constructor(
    kit: SnakeKit,
    scene: THREE.Scene,
    private ground: GroundProbe,
    private obstacles: readonly Obstacle[],
    private prey: () => readonly Prey[],
    private hidesUnderBush: (from: THREE.Vector3, to: THREE.Vector3) => boolean,
    homes: readonly { x: number; z: number; yaw: number }[],
  ) {
    homes.forEach((home, i) => {
      const body = new SnakeBody(kit, i % 2);
      scene.add(body.root);
      const racer = new Racer(i, body, home, rng(300 + i));
      coil(racer, home.x, home.z, home.yaw);
      this.list.push(racer);
    });
  }

  /** Every racer goes home at once, forgetting what it was after (the run starts over). */
  callOff(prey: Prey) {
    for (const r of this.list) {
      if (r.prey !== prey) continue;
      if (r.state !== 'feed' && r.state !== 'rest') this.to(r, 'return');
      r.prey = null;
      r.notice = 0;
    }
  }

  step(dt: number) {
    for (const r of this.list) if (!r.paused) this.stepOne(r, dt);
  }

  update(dt: number) {
    for (const r of this.list) {
      const b = r.body;
      // Lift and tongue ease toward what the state wants.
      b.lift += (LIFT[r.state] - b.lift) * Math.min(1, dt * 8);
      this.tongue(r, dt);
      b.pose();
    }
  }

  private to(r: Racer, state: RacerState) {
    if (r.state === state) return;
    const was = r.state;
    if ((was === 'alert' || was === 'search') && (state === 'lurk' || state === 'return') && r.prey && r.prey.huntable()) this.onLeave?.(r, r.prey);
    r.state = state;
    r.timer = 0;
    if (state === 'lurk') r.prowlIn = PROWL.wait + r.rand() * PROWL.waitMore;
    if (state === 'prowl') {
      const a = r.rand() * Math.PI * 2;
      const d = PROWL.near + r.rand() * (PROWL.far - PROWL.near);
      r.prowlTo.set(r.home.x + Math.sin(a) * d, 0, r.home.z + Math.cos(a) * d);
    }
    if (state === 'chase' && was !== 'strike') {
      r.chases++;
      r.lost = 0;
    }
  }

  /** How plainly `r` sees prey `p` now: 0 not at all, else 1. Also whether it's in smelling range. */
  private sees(r: Racer, p: Prey, range: number): { see: boolean; smell: boolean; dist: number } {
    p.feet(this.feet);
    r.snout(this.v);
    const dist = Math.hypot(this.feet.x - this.v.x, this.feet.z - this.v.z);
    const smell = dist < RACER.smell;
    if (dist > range) return { see: false, smell, dist };
    if (p.inCover() && dist > RACER.bushSmell) return { see: false, smell, dist };
    r.eye(this.w);
    let seen = 0;
    for (const pt of p.sightPoints()) {
      if (this.hidesUnderBush(this.w, pt)) continue;
      if (this.ground.clear(this.w.x, this.w.y, this.w.z, pt.x, pt.y, pt.z)) seen++;
    }
    return { see: seen >= 2, smell, dist };
  }

  private stepOne(r: Racer, dt: number) {
    r.timer += dt;
    r.sinceStrike += dt;
    const all = this.prey();
    if (r.prey && !r.prey.huntable() && r.state !== 'feed' && r.state !== 'rest') {
      r.prey = null;
      if (r.state !== 'lurk') this.to(r, 'return');
    }
    switch (r.state) {
      case 'lurk':
      case 'prowl':
      case 'alert':
      case 'return': {
        if (r.state === 'return' && r.timer < 1) break;
        if (r.state === 'lurk' && r.timer > r.prowlIn) this.to(r, 'prowl');
        // Watch for movement: whatever is moving nearest in plain sight.
        let best: Prey | null = null;
        let bestDist = Infinity;
        let bestSmell = false;
        for (const p of all) {
          if (!p.huntable()) continue;
          const s = this.sees(r, p, RACER.sight);
          const moving = p.speed() > RACER.moving;
          if (((s.see && moving) || (s.smell && moving)) && s.dist < bestDist) {
            best = p;
            bestDist = s.dist;
            bestSmell = s.smell;
          }
        }
        if (best) {
          if (r.prey !== best) r.notice = 0;
          r.prey = best;
          r.notice += dt * (1 + 1.5 * Math.max(0, 1 - bestDist / RACER.sight));
          best.feet(r.lastSeen);
          if (r.state !== 'alert' && r.notice > RACER.alertAt) this.to(r, 'alert');
          if (r.notice > RACER.chaseAt || bestDist < RACER.pounce || bestSmell) this.to(r, 'chase');
        } else {
          r.notice = Math.max(0, r.notice - dt * 0.3);
          if (r.state === 'alert' && r.timer > 2.5 && r.notice < 0.02) this.to(r, 'lurk');
        }
        break;
      }
      case 'chase': {
        const p = r.prey;
        if (!p) {
          this.to(r, 'return');
          break;
        }
        const s = this.sees(r, p, RACER.chaseSight);
        if ((s.see && p.speed() > RACER.moving) || s.smell) {
          p.feet(r.lastSeen);
          r.lost = 0;
        } else r.lost += dt;
        const fromHome = Math.hypot(r.neck.x - r.home.x, r.neck.z - r.home.z);
        if (r.timer > RACER.chaseTime || fromHome > RACER.leash) {
          r.giveUps++;
          this.onGiveUp?.(r, p);
          r.prey = null;
          this.to(r, 'return');
          break;
        }
        if (r.lost > RACER.lostTime) {
          this.to(r, 'search');
          break;
        }
        // Strike once the head is within reach and pointing at it.
        r.snout(this.v);
        p.feet(this.feet);
        const dist = Math.hypot(this.feet.x - this.v.x, this.feet.z - this.v.z);
        const yaw = Math.atan2(this.feet.x - r.neck.x, this.feet.z - r.neck.z);
        if (dist < RACER.strikeRange && Math.abs(wrapAngle(yaw - r.course)) < 0.8 && r.sinceStrike > RACER.strikeRest) {
          r.strikeYaw = yaw;
          r.strikes++;
          this.to(r, 'strike');
        }
        break;
      }
      case 'strike': {
        const p = r.prey;
        if (p && this.hit(r, p)) {
          r.catches++;
          p.caught(r);
          this.coilRound(r, p);
          this.to(r, 'feed');
          break;
        }
        if (r.timer > RACER.strikeTime) {
          r.sinceStrike = 0;
          this.to(r, p ? 'chase' : 'return');
        }
        break;
      }
      case 'search': {
        for (const p of all) {
          if (!p.huntable()) continue;
          const s = this.sees(r, p, RACER.sight);
          if ((s.see && p.speed() > RACER.moving) || s.smell) {
            r.prey = p;
            p.feet(r.lastSeen);
            this.to(r, 'chase');
            break;
          }
        }
        if (r.state === 'search' && r.timer > RACER.searchTime) this.to(r, 'return');
        break;
      }
      case 'feed':
        if (r.timer > RACER.feedTime) this.to(r, 'rest');
        break;
      case 'rest':
        if (r.timer > RACER.restTime) {
          r.prey = null;
          this.to(r, 'return');
        }
        break;
    }
    this.move(r, dt);
  }

  /** Whether the strike's snout has reached any part of the prey's body. */
  private hit(r: Racer, p: Prey): boolean {
    r.snout(this.v);
    for (const pt of p.sightPoints()) if (this.v.distanceTo(pt) < RACER.bite + 0.012) return true;
    return false;
  }

  /** Where it's going, how fast and how it sways, then crawl the neck there along the ground. */
  private move(r: Racer, dt: number) {
    let goal: { x: number; z: number } | null = null;
    let speed = 0;
    switch (r.state) {
      case 'chase': {
        const p = r.prey!;
        p.feet(this.feet);
        // Aim a little ahead of where it's going.
        goal = r.lost > 0 ? r.lastSeen : this.feet;
        speed = r.timer < RACER.dashTime ? RACER.dash : RACER.chase;
        break;
      }
      case 'strike':
        speed = RACER.strikeSpeed;
        break;
      case 'search':
        if (Math.hypot(r.lastSeen.x - r.neck.x, r.lastSeen.z - r.neck.z) > 0.06) {
          goal = r.lastSeen;
          speed = RACER.search;
        }
        break;
      case 'prowl':
        if (r.timer < PROWL.time && Math.hypot(r.prowlTo.x - r.neck.x, r.prowlTo.z - r.neck.z) > 0.05) {
          goal = r.prowlTo;
          speed = PROWL.speed;
        } else this.to(r, 'lurk');
        break;
      case 'return':
        if (Math.hypot(r.home.x - r.neck.x, r.home.z - r.neck.z) > 0.08) {
          goal = r.home;
          speed = RACER.crawl;
        } else this.to(r, 'lurk');
        break;
      default:
        speed = 0;
    }
    // Speed eases in and out, except the strike's lunge.
    r.speed = r.state === 'strike' ? speed : r.speed + (speed - r.speed) * Math.min(1, dt * 6);
    if (r.speed < 0.005) {
      r.speed = 0;
      return;
    }
    let want = r.course;
    if (r.state === 'strike') want = r.strikeYaw;
    else if (goal) want = Math.atan2(goal.x - r.neck.x, goal.z - r.neck.z);
    if (r.state !== 'strike') {
      if (++r.steerTick >= STEER_EVERY) {
        r.steerTick = 0;
        r.steered = steer(this.obstacles, r.neck.x, r.neck.z, want, LOOK, MARGIN);
      }
      want = r.steered;
    }
    // The lunge turns no quicker than a chase, so it doesn't leave a corner in the track.
    const rate = r.state === 'strike' ? RACER.chaseTurn : Math.min(r.state === 'chase' ? RACER.chaseTurn : RACER.turn, RACER.bend * r.speed);
    const dy = wrapAngle(want - r.course);
    r.course += Math.sign(dy) * Math.min(Math.abs(dy), rate * dt);
    const sway = r.state === 'strike' ? RACER.sway * 0.3 : RACER.sway;
    // Swinging side to side, the neck covers more ground than it gains: crawl that much further, so
    // the speeds above stay speeds along the course (1 / J0(sway), near enough).
    const stepLen = (r.speed * dt) / (1 - (sway * sway) / 4 + sway ** 4 / 64);
    r.phase += (2 * Math.PI * stepLen) / RACER.wave;
    const heading = r.course + sway * Math.sin(r.phase);
    const x = r.neck.x + Math.sin(heading) * stepLen;
    const z = r.neck.z + Math.cos(heading) * stepLen;
    r.neck.set(x, this.ground.at(x, z, Math.max(terrainHeight(x, z), r.neck.y)), z);
    r.body.crawlTo(r.neck.x, r.neck.y, r.neck.z);
  }

  /** Head direction and tongue, eased per frame. */
  private tongue(r: Racer, dt: number) {
    const b = r.body;
    // The head looks where the course goes, at its prey when it has one, or about it when lying up.
    let yaw = r.course;
    if (r.prey && (r.state === 'alert' || r.state === 'chase' || r.state === 'strike')) {
      r.prey.feet(this.feet);
      yaw = Math.atan2(this.feet.x - r.neck.x, this.feet.z - r.neck.z);
    } else if (r.state === 'lurk' || r.state === 'rest') {
      r.nextLook -= dt;
      if (r.nextLook <= 0) {
        r.lookYaw = (r.rand() - 0.5) * 1.6;
        r.nextLook = 2 + r.rand() * 4;
      }
      yaw = r.course + r.lookYaw;
    }
    // Held still, it turns to look by curving its forebody round, most of the turn spread along the
    // neck and the rest at the head; crawling, the body keeps to its track and only the head turns.
    b.along(0.03, this.v);
    const bodyYaw = Math.atan2(r.neck.x - this.v.x, r.neck.z - this.v.z);
    const still = r.state === 'feed' ? 0 : THREE.MathUtils.clamp(1 - r.speed / 0.05, 0, 1);
    const off = THREE.MathUtils.clamp(wrapAngle(yaw - bodyYaw), -1.1 - 0.9 * still, 1.1 + 0.9 * still);
    b.turn += (off * 0.7 * still - b.turn) * Math.min(1, dt * 5);
    const target = bodyYaw + off;
    b.headYaw += wrapAngle(target - b.headYaw) * Math.min(1, dt * 10);
    const pitch = r.state === 'alert' ? -0.12 : r.state === 'strike' ? -0.2 : -0.06;
    b.headPitch += (pitch - b.headPitch) * Math.min(1, dt * 8);
    // Flicks: every few seconds lying up, often when interested.
    const often = r.state === 'alert' || r.state === 'search' ? 0.7 : r.state === 'chase' || r.state === 'strike' || r.state === 'feed' ? 99 : 3;
    r.nextFlick -= dt;
    if (r.flick <= 0 && r.nextFlick <= 0) {
      r.flick = 0.42;
      r.nextFlick = often * (0.6 + 0.8 * r.rand());
    }
    if (r.flick > 0) {
      r.flick -= dt;
      const t = 0.42 - r.flick;
      b.tongue = t < 0.07 ? t / 0.07 : r.flick < 0.07 ? Math.max(0, r.flick / 0.07) : 1;
      b.tongueWag = 0.35 * Math.sin(t * 55);
    } else {
      b.tongue = 0;
      b.tongueWag = 0;
    }
  }

  /** Coiled round its catch: the front of its body looped round the prey, the head on it. */
  private coilRound(r: Racer, p: Prey) {
    p.feet(this.feet);
    const pts: { x: number; y: number; z: number }[] = [];
    // Back from the neck: once and a bit round the prey, then out along the way it came.
    const start = r.course + Math.PI;
    const turns = 1.25;
    const ring = 0.03;
    const loop = 2 * Math.PI * ring * turns;
    for (let d = 0; d <= loop; d += 0.004) {
      const a = start - (d / loop) * turns * 2 * Math.PI;
      const rr = ring + 0.012 * (d / loop);
      const x = this.feet.x + Math.sin(a) * rr;
      const z = this.feet.z + Math.cos(a) * rr;
      pts.push({ x, y: this.ground.at(x, z) + 0.006, z });
    }
    const last = pts[pts.length - 1];
    const back = r.course + Math.PI;
    for (let d = 0.004; d <= r.body.length; d += 0.004) {
      const x = last.x + Math.sin(back) * d;
      const z = last.z + Math.cos(back) * d;
      pts.push({ x, y: this.ground.at(x, z), z });
    }
    r.body.layAlong(pts);
    r.body.turn = 0;
    r.neck.set(pts[0].x, pts[0].y, pts[0].z);
    r.body.headYaw = Math.atan2(this.feet.x - pts[0].x, this.feet.z - pts[0].z);
  }
}

/**
 * Lay a racer down coiled where it lies up: a loose spiral, head outermost, its neck at (x, z)
 * pointing along `yaw`, the rest curling back round inside, never over itself.
 */
export function coil(r: Racer, x: number, z: number, yaw: number) {
  const len = r.body.length;
  const pts: { x: number; y: number; z: number }[] = [];
  const outer = 0.12;
  const inner = 0.05;
  // The spiral's middle sits off to the snake's left of its neck.
  const cx = x + Math.cos(yaw) * outer;
  const cz = z - Math.sin(yaw) * outer;
  let a = Math.atan2(x - cx, z - cz);
  for (let d = 0; d <= len + 0.05; d += 0.004) {
    const rr = outer - (outer - inner) * Math.min(1, d / len);
    pts.push({ x: cx + Math.sin(a) * rr, y: 0, z: cz + Math.cos(a) * rr });
    a -= 0.004 / rr;
  }
  for (const p of pts) p.y = terrainHeight(p.x, p.z);
  r.body.layAlong(pts);
  r.neck.set(pts[0].x, pts[0].y, pts[0].z);
  r.course = yaw;
  r.body.turn = 0;
  r.body.headYaw = yaw;
}

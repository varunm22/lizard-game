import * as THREE from 'three';
import { Goals, type GoalSpec } from '../goals';
import type { PlayerController } from '../player/controller';
import { VITALS, type DownCause, type Vitals } from '../player/vitals';
import type { Wounds } from '../player/wounds';
import { WATER_Y } from '../world/shore';
import { terrainHeight } from '../world/terrain';
import type { Birds } from './birds';
import { beachLava, DISPLAY_ROCKS, shoreZ, START } from './layout';
import type { ObjectiveView } from '../objective';
import { OLD_ROCK, WARM_ENOUGH, type Rivals } from './rivals';
import type { BeachPrey, SeaLions } from './sealions';

export type RunState = 'ready' | 'running' | 'caught' | 'home';

/** Down this long (s) before the lizard is put back. */
export const CAUGHT_TIME = 2.5;

/** Whether (x, z, height y) is up on the beach's sand, out of the water. */
export function onSand(x: number, z: number, y: number) {
  return z > shoreZ(x) + 0.05 && beachLava(x, z) < 0.5 && y > WATER_Y + 0.004;
}

/**
 * One go at the sea lion beach: ashore from the reef, past the bull, up to the lek, to win a display
 * rock and a female. The clock starts as the lizard first moves. The bull's charge takes health, as
 * do the cold, hunger and running out of air (the island's bars); at none the lizard is down, and
 * comes back where it first came ashore (or at the reef, if it never did), its bars full, the
 * rivals' rocks and the female as they were. Won once a female chooses it. Also keeps the beach's goals.
 */
export class BeachRun {
  state: RunState = 'ready';
  time = 0;
  best: number | null = null;
  attempts = 1;
  catches = 0;
  finishes = 0;
  /** Where it first came up onto the sand, or null. */
  ashore: { x: number; z: number; yaw: number } | null = null;
  readonly prey: BeachPrey;
  readonly goals: Goals;
  private feet = new THREE.Vector3();
  onReset: (() => void) | null = null;
  onCaught: ((by: DownCause) => void) | null = null;
  onHurt: (() => void) | null = null;
  onHome: (() => void) | null = null;
  onAshore: (() => void) | null = null;
  onRespawn: (() => void) | null = null;

  constructor(
    private player: PlayerController,
    private wounds: Wounds,
    readonly vitals: Vitals,
    private sealions: SeaLions,
    private rivals: Rivals,
    birds: Birds,
  ) {
    const free = () => this.state === 'ready' || this.state === 'running';
    this.prey = {
      feet: (out) => player.feetAt(1, out),
      swimming: () => player.swimming,
      huntable: () => free() && !wounds.down,
      struck: (dx, dz) => {
        if (!free() || !wounds.strike(dx, dz, VITALS.bullHit, 'sealion')) return null;
        if (wounds.down) return 'down';
        this.onHurt?.();
        return 'hurt';
      },
    };
    const specs: GoalSpec[] = [
      { id: 'bull', label: "Dodge the bull's charge", met: () => sealions.dodged > 0 },
      { id: 'pup', label: 'Get nudged by a sea lion pup', met: () => sealions.nudges > 0 },
      { id: 'penguin', label: 'Swim with a penguin', met: () => birds.nearPenguin },
      { id: 'cormorant', label: 'Swim beside a flightless cormorant', met: () => birds.nearCormorant },
      { id: 'display', label: 'Out-display a rival male', met: () => rivals.outDisplayed > 0 },
      { id: 'shove', label: 'Win a shoving match', met: () => rivals.shoveWins > 0 },
      { id: 'hold', label: 'See off a challenger from your rock', met: () => rivals.defended > 0 },
    ];
    this.goals = new Goals(specs);
  }

  get danger(): 'none' | 'watched' | 'chased' {
    if (this.state !== 'running' && this.state !== 'ready') return 'none';
    const a = this.sealions.danger;
    const b = this.rivals.danger;
    return a === 'chased' || b === 'chased' ? 'chased' : a === 'watched' || b === 'watched' ? 'watched' : 'none';
  }

  /** What finishes the stage, and a hint at the next step toward it. */
  get objective(): ObjectiveView {
    const text = 'Be chosen by a female';
    const r = this.rivals;
    if (this.state === 'home' || r.chosen) return { text, done: true, hint: 'Her eggs will hatch in the dunes.' };
    if (!this.ashore) return { text, done: false, hint: "Come ashore. The bull won't charge in among his cows, but mind their pups." };
    const cold = this.vitals.warmth < WARM_ENOUGH;
    const f = r.suitorFemale;
    if (r.held === OLD_ROCK) {
      if (cold) return { text, done: false, hint: 'Too cold to impress her. Warm up in the sun, then come back.' };
      return { text, done: false, hint: f?.state === 'watch' ? 'She is watching. Display to her (B).' : 'A female is coming over. Display to her (B).' };
    }
    const old = r.rivals[OLD_ROCK];
    if (old.state === 'routed') return { text, done: false, hint: "The old male's rock is free. Stand on it to claim it." };
    if (old.state === 'chase') return { text, done: false, hint: "Walk, don't run: keep him on your tail, down onto the bull's beach." };
    if (cold) return { text, done: false, hint: 'Cold, your displays impress nobody. Bask on the black lava first.' };
    return { text, done: false, hint: "The females watch only the old male's rock. He's too big to shove, but the bull isn't." };
  }

  /** Its input is held: down, or locked head to head in a shoving match. */
  get held() {
    return this.wounds.down || this.rivals.match !== null;
  }

  /** Where the HUD's arrow points: the beach until ashore, then the old male's rock (the bull's beach while he chases). */
  target(out: { x: number; z: number; r: number }) {
    this.player.feetAt(1, this.feet);
    if (!this.ashore) return Object.assign(out, { x: this.feet.x, z: shoreZ(this.feet.x) + 0.4, r: 0.3 });
    if (this.rivals.chasing) return Object.assign(out, { x: this.feet.x, z: shoreZ(this.feet.x) + 0.6, r: 0.5 });
    const best = DISPLAY_ROCKS[OLD_ROCK];
    return Object.assign(out, { x: best.x, z: best.z, r: best.r });
  }

  afterDown() {
    if (this.ashore) {
      const a = this.ashore;
      this.state = 'running';
      this.player.setFeet(this.feet.set(a.x, terrainHeight(a.x, a.z), a.z), a.yaw);
      this.sealions.callOff();
      this.rivals.reset();
      this.onRespawn?.();
    } else this.restart();
  }

  /** Back on the reef, the clock reset, everyone back where they started. */
  restart() {
    this.state = 'ready';
    this.time = 0;
    this.attempts++;
    this.ashore = null;
    this.wounds.reset();
    this.vitals.reset();
    this.player.setFeet(this.feet.set(START.x, terrainHeight(START.x, START.z), START.z), START.yaw);
    this.sealions.reset();
    this.rivals.reset();
    this.onReset?.();
  }

  step(dt: number, moving: boolean) {
    if (this.state === 'ready' && moving) this.state = 'running';
    if (this.state === 'running') {
      this.time += dt;
      this.player.feetAt(1, this.feet);
      // Up on the sand, or past the waterline some other way (over the lava shores).
      const landed = onSand(this.feet.x, this.feet.z, this.feet.y) || (this.player.grounded && this.feet.z > shoreZ(this.feet.x) + 0.3 && this.feet.y > WATER_Y + 0.004);
      if (!this.ashore && !this.player.swimming && landed) {
        // Put back here, it faces up the beach (south, +z).
        this.ashore = { x: this.feet.x, z: this.feet.z, yaw: 0 };
        this.onAshore?.();
      }
      if (this.rivals.chosen) {
        this.state = 'home';
        this.finishes++;
        if (this.best === null || this.time < this.best) this.best = this.time;
        this.sealions.callOff();
        this.onHome?.();
      }
    }
    if ((this.state === 'running' || this.state === 'ready') && this.wounds.down) {
      this.state = 'caught';
      this.catches++;
      this.sealions.callOff();
      this.rivals.callOff();
      this.onCaught?.(this.wounds.downBy ?? 'sealion');
    }
    this.goals.step(dt);
  }
}

import * as THREE from 'three';
import type { Cover } from '../world/cover';
import { lavaCover } from '../world/layout';
import { terrainHeight } from '../world/terrain';
import { SUN_OFFSET } from '../render/scene';
import { MOVEMENT as M } from './movement';
import type { PlayerController } from './controller';

/** The sun is this far off along SUN_OFFSET when checking whether it reaches the lizard (m): past every crown. */
const SUN_FAR = 8;
/** How long a sunlight reading stands before it's taken again (s): rays onto tree crowns aren't free. */
const SUN_EVERY = 0.25;
/** Standing this far above the ground (m), the lizard is up on something: a rock, a log, a shell, a back. */
const RAISED = 0.006;
/** Lizards within this distance of its middle (m) keep it company: about a body length and a half. */
export const COMPANY_REACH = 0.3;
/** Each lizard in reach adds this much to basking, up to this many of them. */
const COMPANY_BONUS = 0.25;
const COMPANY_MAX = 2;
/**
 * How well each surface warms a lizard lying on it: black lava soaks up the sun best, then rocks and
 * logs off the ground, then bare earth and sand.
 */
export const SURFACE = { lava: 1.5, raised: 1.3, ground: 1 } as const;

export interface Climate {
  /** Share of the lizard's back in the sun, 0 to 1. */
  sun: number;
  /** How well what it lies on warms it (SURFACE). */
  surface: number;
  surfaceKind: keyof typeof SURFACE;
  /** Other lizards near enough to keep it company. */
  company: number;
  /** Basking multiplier from that company: 1 alone. */
  companyScale: number;
  /** In the water at all; and with the snout under, unable to breathe. */
  wet: boolean;
  underwater: boolean;
}

/** Under this much water (m) the snout can't reach the air: a swimmer breathes with its back at the surface, or tilting up just under it. */
const SNOUT_UNDER = 0.003;

/**
 * Reads what the lizard's surroundings do to its warmth and breath: how much of its back the sun
 * reaches (a ray toward the sun for each of three points, through `Cover`, so trees, rocks, shelters
 * and plants shade it), what it's lying on, how many other lizards lie near, and whether it's in the
 * water and can breathe.
 */
export class ClimateSense {
  readonly now: Climate = { sun: 1, surface: 1, surfaceKind: 'ground', company: 0, companyScale: 1, wet: false, underwater: false };
  private sunIn = 0;
  private sunDir = SUN_OFFSET.clone().normalize();
  private eye = new THREE.Vector3();
  private p = new THREE.Vector3();
  private feet = new THREE.Vector3();

  constructor(
    private player: PlayerController,
    private cover: Cover,
    /** Where the other lizards are (their middles). */
    private others: () => Iterable<THREE.Vector3>,
    private waterDepth: (p: { x: number; y: number; z: number }) => number,
  ) {}

  step(dt: number) {
    const c = this.now;
    const pos = this.player.position;
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    const reach = M.bodyHalfLength + M.bodyRadius;
    const pitch = this.player.swimming ? this.player.swimPitch : 0;
    const ahead = reach * Math.cos(pitch);
    const snout = this.p.set(pos.x + fx * ahead, pos.y + M.bodyRadius + reach * Math.sin(pitch), pos.z + fz * ahead);
    c.underwater = this.waterDepth(snout) > SNOUT_UNDER;
    c.wet = this.player.swimming || this.waterDepth({ x: pos.x, y: pos.y - M.bodyRadius, z: pos.z }) > 0;

    this.player.feetAt(1, this.feet);
    const raised = this.player.grounded && this.feet.y - terrainHeight(this.feet.x, this.feet.z) > RAISED;
    const lava = THREE.MathUtils.clamp(lavaCover(this.feet.x, this.feet.z), 0, 1);
    const ground = SURFACE.ground + (SURFACE.lava - SURFACE.ground) * lava;
    c.surface = raised ? Math.max(SURFACE.raised, ground) : ground;
    c.surfaceKind = raised && SURFACE.raised >= ground ? 'raised' : lava > 0.5 ? 'lava' : 'ground';

    c.company = 0;
    for (const o of this.others()) if (Math.hypot(o.x - pos.x, o.z - pos.z) < COMPANY_REACH && Math.abs(o.y - pos.y) < COMPANY_REACH) c.company++;
    c.companyScale = 1 + COMPANY_BONUS * Math.min(c.company, COMPANY_MAX);

    this.sunIn -= dt;
    if (this.sunIn <= 0) {
      this.sunIn = SUN_EVERY;
      c.sun = this.sunlit();
    }
  }

  /** Share of three points along the back, snout to hips, that the sun reaches. */
  private sunlit(): number {
    const pos = this.player.position;
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    let lit = 0;
    for (const along of [-1, 0, 1]) {
      const d = along * M.bodyHalfLength;
      this.p.set(pos.x + fx * d, pos.y + M.bodyRadius + 0.002, pos.z + fz * d);
      this.eye.copy(this.p).addScaledVector(this.sunDir, SUN_FAR);
      if (this.cover.inSight(this.eye, this.p, this.player.body)) lit++;
    }
    return lit / 3;
  }
}

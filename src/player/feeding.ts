import type { Algae } from '../world/algae';
import type { LizardModel } from './lizardModel';

/** A bite takes this share of a full patch, as an iguana's does (see src/creatures/iguana.ts). */
export const BITE_SHARE = 1 / 6;
/** The snout and head spheres reach this much further into the fronds (m). */
const MOUTH_SLACK = 0.003;

/**
 * The player's bite (F): the bite clip plays wherever the lizard is, and as the jaws snap shut, the
 * algae patch touching its snout or head, if any, is bitten down (and eaten by the last bite).
 */
export class Feeding {
  /** Bites taken, and those that got some algae. */
  bites = 0;
  mouthfuls = 0;
  /** The patch the last bite got, or null if it closed on nothing. */
  lastBite: { id: number; ate: boolean } | null = null;
  /** Called for each mouthful of algae swallowed. */
  onMouthful: (() => void) | null = null;

  constructor(
    private model: LizardModel,
    private algae: Algae,
  ) {}

  /** Start a bite; false while one is already under way. */
  bite(): boolean {
    return this.model.bite(() => this.snap());
  }

  private snap() {
    this.bites++;
    this.model.updateBodySpheres();
    const [snout, head] = this.model.bodySpheres;
    const patch = [snout, head].map((s) => this.algae.touching(s.x, s.y, s.z, s.r + MOUTH_SLACK)[0]).find((p) => p);
    if (!patch) {
      this.lastBite = null;
      return;
    }
    this.mouthfuls++;
    this.onMouthful?.();
    this.lastBite = { id: patch.id, ate: this.algae.bite(patch.id, BITE_SHARE) };
  }
}

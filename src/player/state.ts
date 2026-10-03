import type { LizardClip } from './lizardModel';
import { MOVEMENT } from './movement';

export type MoveState = LizardClip;

/** Ground speed (m/s) above which the lizard counts as walking, and as running. */
const WALK_MIN = 0.02;
const RUN_MIN = (MOVEMENT.walkSpeed + MOVEMENT.runSpeed) / 2;
/** How long the land pose holds before idle can take over (the clip is a short squash). */
const LAND_HOLD = 0.15;

export interface PhysicsFacts {
  grounded: boolean;
  jumped: boolean;
  landed: boolean;
  verticalSpeed: number;
  horizontalSpeed: number;
  /** Scrambling up onto something: walks, whatever the ground speed. */
  climbing: boolean;
  /** In the water: swims, whatever else is true. */
  swimming: boolean;
}

/**
 * idle / walk / run / jump / fall / land / swim, decided only from physics facts. Each state maps to the
 * lizard clip of the same name.
 */
export class MovementStateMachine {
  state: MoveState = 'idle';
  private landTimer = 0;

  update(f: PhysicsFacts, dt: number): MoveState {
    if (f.swimming) return (this.state = 'swim');
    if (f.jumped) return (this.state = 'jump');
    if (!f.grounded) {
      // Rising out of a jump keeps the jump pose; anything else in the air is falling.
      if (!(this.state === 'jump' && f.verticalSpeed > 0)) this.state = 'fall';
      return this.state;
    }
    if (f.landed) {
      this.landTimer = LAND_HOLD;
      this.state = 'land';
    }
    this.landTimer -= dt;
    const gait: MoveState = f.climbing ? 'walk' : f.horizontalSpeed > RUN_MIN ? 'run' : f.horizontalSpeed > WALK_MIN ? 'walk' : 'idle';
    // Landing gives way at once to a gait, or to idle when the squash is done.
    if (this.state !== 'land' || gait !== 'idle' || this.landTimer <= 0) this.state = gait;
    return this.state;
  }
}

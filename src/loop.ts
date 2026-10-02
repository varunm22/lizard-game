export const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;

export interface LoopCallbacks {
  /** Advance the simulation by exactly FIXED_DT seconds. */
  step(dt: number): void;
  /** Draw a frame. `alpha` (0..1) is how far real time is between the last two physics steps. */
  render(alpha: number, frameDt: number): void;
}

/**
 * Fixed-step physics, variable-rate rendering. Physics always advances in FIXED_DT
 * increments so movement feels identical at any frame rate; rendering interpolates.
 */
export function startLoop({ step, render }: LoopCallbacks): () => void {
  let last = performance.now();
  let accumulator = 0;
  let handle = 0;

  const frame = (now: number) => {
    const frameDt = Math.min((now - last) / 1000, MAX_STEPS_PER_FRAME * FIXED_DT);
    last = now;
    accumulator += frameDt;

    while (accumulator >= FIXED_DT) {
      step(FIXED_DT);
      accumulator -= FIXED_DT;
    }

    render(accumulator / FIXED_DT, frameDt);
    handle = requestAnimationFrame(frame);
  };

  handle = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(handle);
}

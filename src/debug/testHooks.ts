import type { InputState } from '../input';

/** State exposed on `window.__game` so Playwright tests can check the game without reading pixels. */
export interface GameTestHooks {
  ready: boolean;
  physicsSteps: number;
  /**
   * Stop real time and run exactly `n` fixed physics steps right now, with input, camera and
   * animation updated each step, then draw one frame (unless `draw` is false). Headless Chromium
   * renders slowly, so tests use this instead of waiting for frames.
   */
  advance: (n: number, draw?: boolean) => void;
  /** The analytic terrain height the mesh and heightfield are built from. */
  terrainHeight: (x: number, z: number) => number;
  /** Height of the first physics surface under (x, z), found by a downward ray, or null. */
  groundAt: (x: number, z: number) => number | null;
  /** Obstacles with their current opacity (below 1 while faded for blocking the view). */
  obstacles: () => { name: string; x: number; y: number; z: number; height: number; opacity: number }[];
  /** Clips, the playing clip, and the head bone's position in the lizard's own frame (+Z forward, +X its left). */
  lizard: () => { clips: string[]; current: string | undefined; head: { x: number; y: number; z: number } };
  /** Feet position, facing, ground speed and movement state of the player. */
  player: () => { x: number; y: number; z: number; yaw: number; speed: number; grounded: boolean; state: string };
  /** `faded` names the obstacles currently blocking the view of the lizard. */
  camera: () => { x: number; y: number; z: number; yaw: number; pitch: number; arm: number; distance: number; faded: string[] };
  /**
   * Override player input fields (merged over the real devices) for exactly `forSteps` physics
   * steps, or until called with null when `forSteps` is 0. Camera look is not affected.
   */
  setInput: (input: Partial<InputState> | null, forSteps?: number) => void;
  /** Place the player's feet on the ground at (x, z) facing `yaw`, with the camera behind. */
  teleport: (x: number, z: number, yaw: number) => void;
}

declare global {
  interface Window {
    __game?: GameTestHooks;
  }
}

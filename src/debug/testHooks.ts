import type { InputState } from '../input';

/** State exposed on `window.__game` so Playwright tests can check the game without reading pixels. */
export interface GameTestHooks {
  ready: boolean;
  physicsSteps: number;
  /** The analytic terrain height the mesh and heightfield are built from. */
  terrainHeight: (x: number, z: number) => number;
  /** Height of the first physics surface under (x, z), found by a downward ray, or null. */
  groundAt: (x: number, z: number) => number | null;
  obstacles: () => { name: string; x: number; y: number; z: number; height: number }[];
  lizard: () => { clips: string[]; current: string | undefined };
  /** Feet position, facing, ground speed and movement state of the player. */
  player: () => { x: number; y: number; z: number; yaw: number; speed: number; grounded: boolean; state: string };
  camera: () => { x: number; y: number; z: number; yaw: number; pitch: number; arm: number; distance: number };
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

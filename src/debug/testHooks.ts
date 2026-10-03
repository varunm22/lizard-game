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
  /**
   * Clips, the playing clip, the head bone's position in the lizard's own frame (+Z forward, +X its
   * left), and the spine fit: absolute pitch of the hips, chest and each tail bone (radians, positive
   * raises the end nearer the snout).
   */
  lizard: () => {
    clips: string[];
    current: string | undefined;
    head: { x: number; y: number; z: number };
    spine: { hips: number; chest: number; tail: number[] };
  };
  /**
   * Each foot's gap to the surface under it (m): the lowest point of its sole as drawn, minus the
   * physics surface height there. Positive floats, negative sinks in.
   */
  feet: () => { leg: string; gap: number }[];
  /** Feet position, facing, ground speed and movement state of the player (physics feet, not as drawn). */
  player: () => {
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    grounded: boolean;
    climbing: boolean;
    swimming: boolean;
    /** Swimming pitch, radians, positive snout-up. */
    swimPitch: number;
    state: string;
  };
  /**
   * Every plant: its kind, root position, stem height (m), and current lean as a vector in the
   * ground plane (radians; points the way the top leans). `near` keeps only those within r of (x, z).
   */
  plants: (near?: { x: number; z: number; r: number }) => { kind: string; x: number; y: number; z: number; height: number; tiltX: number; tiltZ: number }[];
  /** The pond's centre, mean shoreline radius, deepest depth, and the height of its surface. */
  pond: () => { x: number; z: number; radius: number; depth: number; waterY: number };
  /** `faded` names the obstacles currently blocking the view of the lizard. */
  camera: () => { x: number; y: number; z: number; yaw: number; pitch: number; arm: number; distance: number; faded: string[] };
  /**
   * Override player input fields (merged over the real devices) for exactly `forSteps` physics
   * steps, or until called with null when `forSteps` is 0. Camera look is not affected.
   */
  setInput: (input: Partial<InputState> | null, forSteps?: number) => void;
  /** Pin the camera at this offset from the lizard's feet, looking at them (for screenshots); null releases it. */
  viewFrom: (offset: { x: number; y: number; z: number } | null) => void;
  /** Place the player's feet at (x, z) facing `yaw`, on the ground or at height `y`, with the camera behind. */
  teleport: (x: number, z: number, yaw: number, y?: number) => void;
}

declare global {
  interface Window {
    __game?: GameTestHooks;
  }
}

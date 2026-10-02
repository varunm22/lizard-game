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
}

declare global {
  interface Window {
    __game?: GameTestHooks;
  }
}

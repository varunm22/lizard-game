/** State exposed on `window.__game` so Playwright tests can check the game without reading pixels. */
export interface GameTestHooks {
  ready: boolean;
  physicsSteps: number;
  bodies: () => { x: number; y: number; z: number }[];
}

declare global {
  interface Window {
    __game?: GameTestHooks;
  }
}

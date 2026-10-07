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
  /**
   * Stop real time and play one frame of `frameDt` seconds as the real-time loop would: the physics
   * steps it owes, then the views at the interpolated in-between point. Drawn only if `draw`. For
   * checking what the game looks like at a display's own frame rate, not just at whole steps.
   */
  frame: (frameDt: number, draw?: boolean) => void;
  /** The analytic terrain height the mesh and heightfield are built from. */
  terrainHeight: (x: number, z: number) => number;
  /**
   * Height of the first physics surface under (x, z), found by a downward ray from `from` (default 5 m),
   * or null. It sees neither the player nor the other iguanas.
   */
  groundAt: (x: number, z: number, from?: number) => number | null;
  /**
   * Obstacles (rocks, logs, trees, cactus) with their footprint radius and current opacity (below 1
   * while faded for blocking the view). `height` is its top above the ground under its centre.
   */
  obstacles: () => { name: string; kind: string; x: number; y: number; z: number; height: number; radius: number; opacity: number }[];
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
    /** A bite is under way, and how far the jaw hangs open now (radians). */
    biting: boolean;
    jawOpen: number;
    /** The drawn snout tip (world m) and the radius of its sphere. */
    snout: { x: number; y: number; z: number; r: number };
  };
  /**
   * Each foot's gap to the surface under it (m): the lowest point of its sole as drawn, minus the
   * physics surface height there. Positive floats, negative sinks in.
   */
  feet: () => { leg: string; gap: number }[];
  /**
   * How deep each point the drawn body keeps clear is inside a rock, log or the ground (m, 0 when
   * clear): two points on each tail bone from the hips back, then each foot.
   */
  clearance: () => number[];
  /**
   * The same points as `clearance`, as drawn, in the lizard's own frame (m, +Z forward), so a test
   * can see the tail or a foot jump from one frame to the next.
   */
  clearancePoints: () => { x: number; y: number; z: number }[];
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
  plants: (near?: { x: number; z: number; r: number }) => {
    kind: string;
    x: number;
    y: number;
    z: number;
    height: number;
    tiltX: number;
    tiltZ: number;
    /** How trampled: 1 just flattened, easing to 0 as it stands back up. */
    crush: number;
    /** 0 seedling to 1 full grown. */
    growth: number;
  }[];
  /** Make a plant come up at (x, z), a seedling or `grown`; false if there's no room for it there. */
  sprout: (kind: string, x: number, z: number, grown?: boolean) => boolean;
  /**
   * The giant tortoise: where its centre stands, its facing (yaw, as the lizard's), what it's doing
   * and the clip playing, how far round its route it is (m), the route point 0.3 m ahead of it, and
   * the route itself (an oval: centre and half-axes).
   */
  tortoise: () => {
    x: number;
    y: number;
    z: number;
    yaw: number;
    state: string;
    clip: string | undefined;
    along: number;
    ahead: { x: number; z: number };
    route: { x: number; z: number; rx: number; rz: number };
  };
  /** Make the tortoise lie down for a rest now, or eat the next plant its mouth comes to. */
  tortoiseDo: (action: 'eat' | 'rest') => void;
  /**
   * The Sally Lightfoot crabs: where each stands, its facing (yaw, as the lizard's; it walks
   * sideways), what it's doing and the clip playing, whether it lives on a rock pile, how many hops
   * it has made, and who it's grooming.
   */
  crabs: () => {
    x: number;
    y: number;
    z: number;
    yaw: number;
    state: string;
    clip: string | undefined;
    onPile: boolean;
    hops: number;
    /** Who it's grooming or on its way to groom: 'player', another iguana's index, or null. */
    grooming: 'player' | number | null;
  }[];
  /** The crab's animation clips. */
  crabClips: () => string[];
  /** Send crab i walking to (x, z); it ignores the lizard until it gets there or is stopped. */
  crabGo: (i: number, x: number, z: number) => void;
  /** Put crab i down at (x, z), on the first surface below `y` (default 1 m). */
  crabPlace: (i: number, x: number, z: number, y?: number) => void;
  /**
   * The other marine iguanas: where each one's feet are, its facing, its home on the shore, what it's
   * doing (basking, shuffling to a new spot, going to food, grazing, going back to land), its movement
   * state and clip, whether it's on the ground or swimming, whether it's sneezing now, counts of its
   * sneezes, bites and meals, the algae patch it's going to or grazing, and the ground under it.
   */
  iguanas: () => {
    x: number;
    y: number;
    z: number;
    yaw: number;
    home: { x: number; z: number };
    activity: string;
    state: string;
    clip: string | undefined;
    grounded: boolean;
    swimming: boolean;
    sneezing: boolean;
    sneezes: number;
    bites: number;
    /** Its bite clip is playing. */
    biting: boolean;
    meals: number;
    meal: { id: number; x: number; y: number; z: number } | null;
    /** How far its drawn snout is from the fronds of that patch (m), or null. */
    touch: number | null;
    /** How much the ground under it is bare black lava, 0 (sand, soil) to 1. */
    lava: number;
    /** Who it's going to bask beside: 'player', an iguana's index, or null. */
    mate: 'player' | number | null;
  }[];
  /**
   * Send iguana i to feed as soon as it can, make it get up and find somewhere else to bask, or make
   * it sneeze when next on land and still.
   */
  iguanaDo: (i: number, action: 'feed' | 'move' | 'sneeze') => void;
  /** Put iguana i down at (x, z) facing `yaw`, basking there for `stay` seconds (default a minute). */
  iguanaPlace: (i: number, x: number, z: number, yaw: number, stay?: number) => void;
  /** How much the ground at (x, z) is bare black lava, 0 to 1. */
  lava: (x: number, z: number) => number;
  /** Salt spray droplets in the air. */
  saltSpray: () => number;
  /** The sea: height of its surface, and how deep the open sea floor lies below it. */
  ocean: () => { waterY: number; depth: number };
  /** X of the waterline at a given z (the sea is to the east, +X). */
  shoreX: (z: number) => number;
  /**
   * The rock piles running out into the sea: each runs east along z from x0 on the lava to x1 in the
   * water, its crest `peak` above the sea surface. Their slabs are obstacles named after the pile.
   */
  rockPiles: () => { name: string; z: number; x0: number; x1: number; peak: number }[];
  /** Algae patches still growing, or only those within r of (x, y, z), nearest first; `grown` is how far in (0 to 1). */
  algae: (near?: { x: number; y: number; z: number; r: number }) => { id: number; kind: string; x: number; y: number; z: number; grown: number }[];
  /** Remove (eat) the algae patch with this id; false if there's none. */
  removeAlgae: (id: number) => boolean;
  /** Bite, as pressing F does; false while a bite is already under way. */
  bite: () => boolean;
  /** The player's bites so far, those that got algae, and what the last one got (null if nothing). */
  feeding: () => { bites: number; mouthfuls: number; lastBite: { id: number; ate: boolean } | null };
  /** Sprout a new algae patch on a bare site on the rocks now; its id, or null if there's no room. */
  sproutAlgae: () => number | null;
  /** Ripples spreading on the pond: where each started, seconds since, and its strength (0.35 wake to 1.2 splash). */
  ripples: () => { x: number; z: number; age: number; strength: number }[];
  /** `faded` names the obstacles currently blocking the view of the lizard. */
  camera: () => { x: number; y: number; z: number; yaw: number; pitch: number; arm: number; distance: number; faded: string[] };
  /**
   * Override player input fields (merged over the real devices) for exactly `forSteps` physics
   * steps, or until called with null when `forSteps` is 0. Camera look is not affected.
   */
  setInput: (input: Partial<InputState> | null, forSteps?: number) => void;
  /**
   * Pin the camera at this offset from the lizard's feet, or from the point `at`, looking at it (for
   * screenshots); null releases it.
   */
  viewFrom: (offset: { x: number; y: number; z: number } | null, at?: { x: number; y: number; z: number }) => void;
  /** Place the player's feet at (x, z) facing `yaw`, on the ground or at height `y`, with the camera behind. */
  /**
   * The hawk: where it is (its middle, world m), its speed, state and clip, whether it's hunting the
   * lizard and could see it at its last look, strikes made and landed, and the perch it's on or bound for.
   */
  hawk: () => {
    x: number;
    y: number;
    z: number;
    speed: number;
    state: string;
    clip: string | null;
    hunting: boolean;
    seesPrey: boolean;
    strikes: number;
    hitsLanded: number;
    perch: number;
    enabled: boolean;
  };
  hawkClips: () => string[];
  /** 'hunt': go for the lizard now; 'off': never hunt (tests that aren't about it); 'on'; 'perch'; 'soar'. */
  hawkDo: (action: 'hunt' | 'off' | 'on' | 'perch' | 'soar') => void;
  /** Whether a predator's eye at `from` could see the point (x, y, z) (world/cover.ts). */
  inSight: (from: { x: number; y: number; z: number }, x: number, y: number, z: number) => boolean;
  /**
   * The hawk's hits on the lizard, whether it's knocked down and the countdown's whole seconds, whether
   * it's hunted, a flinch under way, and the dust and feathers in the air from strikes.
   */
  wounds: () => { hits: number; down: boolean; countdown: number | null; hunted: boolean; flinching: boolean; puff: number };
  teleport: (x: number, z: number, yaw: number, y?: number) => void;
}

declare global {
  interface Window {
    __game?: GameTestHooks;
  }
}

/**
 * The shot list for the demo video. Each shot runs inside the page against `window.__game`:
 * `setup(g, d)` places the lizard and camera, then `frame(g, d, i)` runs once per video frame
 * (30 fps) to steer it; the recorder advances physics two fixed steps (1/30 s) after each call.
 * `d` is a scratch object for the shot; setting `d.caption` in setup overrides the caption. Shots whose hooks are missing at an older commit are
 * skipped, and each picks its spot from the live world (obstacles, plants, shore) rather than
 * hard-coded positions where it can, so the list keeps working as the world changes.
 *
 * Yaw: the lizard faces +Z at yaw 0 and (sin yaw, cos yaw) in general.
 */

/** @typedef {{ name: string, caption: string, seconds: number, needs?: string[], setup: Function, frame: Function }} Shot */

/** @type {Shot[]} */
export const SHOTS = [
  {
    name: 'walk',
    caption: 'Out for a walk',
    seconds: 3,
    setup: (g, d) => {
      const s = g.player();
      // Spawn faces the log; turn east, across the open middle of the clearing.
      d.yaw = s.yaw - Math.PI / 2;
      g.teleport(s.x, s.z, d.yaw);
      g.advance(30, false);
    },
    frame: (g, d, i) => {
      g.setInput({ move: { x: 0, y: 1 } }, 2);
      // A slow orbit round the lizard, from its side towards its front.
      const a = d.yaw + 1.4 - i * 0.01;
      g.viewFrom({ x: Math.sin(a) * 0.24, y: 0.07, z: Math.cos(a) * 0.24 });
    },
  },
  {
    name: 'climb',
    caption: 'Clambering over logs',
    seconds: 3,
    setup: (g, d) => {
      const log = g.obstacles().find((o) => o.name === 'log');
      if (!log) return false;
      // Come at the log from the clearing side (+Z), heading -Z.
      g.teleport(log.x + 0.02, log.z + 0.22, Math.PI);
      g.advance(40, false);
    },
    frame: (g) => {
      g.setInput({ move: { x: 0, y: 1 } }, 2);
      g.viewFrom({ x: -0.3, y: 0.12, z: 0.1 });
    },
  },
  {
    name: 'jump',
    caption: 'Running and jumping',
    seconds: 3,
    setup: (g, d) => {
      const s = g.player();
      g.teleport(0.35, 0.15, Math.PI / 2 + 0.3);
      g.viewFrom(null);
      g.advance(40, false);
    },
    frame: (g, d, i) => {
      const jump = i === 30 || i === 62;
      g.setInput({ move: { x: 0, y: 1 }, run: true, jump }, 2);
    },
  },
  {
    name: 'plants',
    caption: 'Plants bend out of the way',
    seconds: 2.5,
    needs: ['plants'],
    setup: (g, d) => {
      // The densest patch of tall plants on open ground, entered from 25 cm south.
      const all = g.plants().filter((p) => p.height > 0.06);
      let best = null;
      for (const p of all) {
        if (g.obstacles().some((o) => Math.hypot(o.x - p.x, o.z - p.z) < (o.radius ?? 0.1) + 0.35)) continue;
        if (g.ocean && p.x > g.shoreX(p.z) - 0.5) continue;
        const n = all.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.15).length;
        if (!best || n > best.n) best = { p, n };
      }
      if (!best) return false;
      g.teleport(best.p.x, best.p.z + 0.22, Math.PI);
      g.advance(40, false);
    },
    frame: (g) => {
      g.setInput({ move: { x: 0, y: 1 } }, 2);
      g.viewFrom({ x: 0.2, y: 0.16, z: 0.22 });
    },
  },
  {
    name: 'forest',
    caption: 'Into the scalesia forest',
    seconds: 2.5,
    needs: ['ocean'],
    setup: (g, d) => {
      // Between two trunks at the forest edge, walking deeper in (west).
      g.teleport(-1.45, 0.4, -Math.PI / 2 - 0.2);
      g.advance(40, false);
    },
    frame: (g, d, i) => {
      g.setInput({ move: { x: 0, y: 1 } }, 2);
      g.viewFrom({ x: 0.42 - i * 0.002, y: 0.16, z: 0.22 });
    },
  },
  {
    name: 'swim',
    caption: 'Down the beach and into the sea',
    seconds: 3.5,
    setup: (g, d) => {
      if (g.ocean) {
        // The rock-free strip down the beach.
        d.z = 1.12;
        g.teleport(g.shoreX(d.z) - 0.4, d.z, Math.PI / 2);
      } else if (g.pond) {
        const p = g.pond();
        d.caption = 'Wading into the pond for a swim';
        g.teleport(p.x - p.radius - 0.25, p.z + 0.1, Math.PI / 2);
      } else return false;
      g.viewFrom(null);
      g.advance(40, false);
    },
    frame: (g, d, i) => {
      g.setInput({ move: { x: 0, y: 1 }, run: i < 60, jump: i > 80 && i % 24 === 0 }, 2);
    },
  },
  {
    name: 'algae',
    caption: 'Algae on the lava reef, ready to be eaten',
    seconds: 3,
    needs: ['algae', 'removeAlgae'],
    setup: (g, d) => {
      const { waterY } = g.ocean();
      // A dense underwater clump: the patch with the most neighbours within 15 cm.
      const all = g.algae().filter((a) => a.y < waterY - 0.06);
      let best = null;
      for (const a of all.filter((_, k) => k % 3 === 0)) {
        const n = all.filter((b) => Math.hypot(b.x - a.x, b.z - a.z) < 0.15).length;
        if (!best || n > best.n) best = { a, n };
      }
      if (!best) return false;
      d.a = best.a;
      // Swim in from the open sea (east), heading west onto the clump, filmed from seaward.
      g.teleport(d.a.x + 0.16, d.a.z, -Math.PI / 2, d.a.y + 0.03);
      g.advance(10, false);
    },
    frame: (g, d, i) => {
      g.setInput({ move: { x: 0, y: 0.25 } }, 2);
      g.viewFrom({ x: 0.16, y: 0.08, z: 0.12 });
      // Every half second the patch nearest the snout disappears.
      if (i > 20 && i % 15 === 0) {
        const p = g.player();
        const snout = { x: p.x + Math.sin(p.yaw) * 0.06, y: p.y, z: p.z + Math.cos(p.yaw) * 0.06, r: 0.08 };
        const near = g.algae(snout)[0];
        if (near) g.removeAlgae(near.id);
      }
    },
  },
];

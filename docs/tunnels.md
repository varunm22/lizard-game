# Lava tunnels (`?level=tunnels`)

The fourth stage, opened with `?level=tunnels` or from the "Select stage" picker (`src/stageSelect.ts`;
the still is `src/assets/stages/tunnels.jpg`). It's the lava tube area of the progression plan,
built as a maze with a vertical side: small lava tubes on two floors under a lava field. Holes in
the upper floor drop the lizard into the tubes below, sometimes into a dead end and sometimes onto
a shortcut; rubble piles under holes in the lower tubes' roofs climb back up. Skylights let the sun
in. The run ends in a jameo, a wide collapse open to the sky, in the south-east. There's no enemy
yet (the plan's barn owl, which hunts by sound, would fit here). Everything lives in `src/tunnels/`;
it reuses the dunes' `Markers` and run HUD and the shared player, camera and water.

## The rock (`assets-src/tunnels.py`)

The layout lives in the Python script, not in TypeScript: `TUBES` (polylines on floor 0 or 1),
`ROOMS`, `HOLES` (round `drop` holes and the `gap` across the north tube), `RAMPS` (rubble piles),
`SKYLIGHTS`, `JAMEO`, `POOLS`, `START`, `FINISH`. Running it (`npm run assets`, Python 3.11 with
`bpy` and `scikit-image`; about 40 s) writes three files the game reads:

- `src/assets/tunnels.glb`: the rock, one mesh. A signed distance field of the air (tubes with a flat
  floor and an arched roof, rough walls, shafts, the rubble piles' slabs taken back out) meshed by
  marching cubes on a 3 cm grid and decimated to ~110k triangles. Faces point into the air.
- `src/assets/tunnels-light.bin`: baked light on a 6 cm grid, two bytes a cell: `sun` (open sky
  straight up along the sun's slant, `SUN_OFFSET`) and `glow` (sunlight spread through the air,
  dimming with distance round corners).
- `src/assets/tunnels.json`: the layout, read by `src/tunnels/layout.ts`.

`assets-src/tunnels.py --plan out.png` draws both floors from above without meshing, for checking a
layout change.

Floors: the lower floor is the game's heightfield at `FLOORS[0]` (0 m), drawn and collided as on the
other levels (`tunnelsHeight`; the lower tubes' walls run straight down past it). The upper floor is
the rock mesh at `FLOORS[1]` (0.42 m, on a grid plane so it's exactly flat). The lava field is at
`TOP`. Tubes are about 0.44 m wide and 0.3 m high.

## Wiring

- `src/level.ts` knows `'tunnels'`. `terrain.ts` uses a 10 m square with no ground outside it, and
  draws the ground unlit (`MeshBasicMaterial`) with the light baked into its colours. `water.ts` has
  a small dark sheet; `OCEAN_X0` is off so the flooded dip is swimmable.
- `src/tunnels/main.ts` is the level's main, built like the lagoon's. Hooks are `window.__tunnels`
  (`TunnelsTestHooks` in `src/debug/testHooks.ts`, built in `createTunnelsHooks.ts`).
- Step order per physics tick: run (floors, drops, climbs, leaps, basking, finish, goals), player, Rapier.
- `rock.ts` loads the rock, colours each vertex with `rockColour` (stone by facing, toon bands of the
  baked glow, warm sun patches, moss where sun falls on an upward face) and uses the same triangles
  as a trimesh collider (`FIX_INTERNAL_EDGES`), so the lizard stands on exactly what is drawn. It also
  adds the sunbeams, slanted additive cylinders under each skylight and into the jameo.
- Lighting: nothing underground casts live shadows. Each frame the hemisphere and sun intensities
  follow the baked light at the lizard's feet, and a weak point light on the camera keeps the dark
  lizard readable against dark rock. The fog is dark and close, underwater it's dark green.

## Movement constraints that shaped the layout

- The physics capsule stays level (`docs/player.md`), so the lizard can't stand on ground steeper
  than ~14°: with nothing within 1.5 cm under its middle it tips off downhill. That's why the
  **rubble piles are stairs** of fallen slabs, not ramps: `STEPS` risers of 6 cm (the controller
  scrambles up anything 1.5 to 7.5 cm high) on 17 cm treads, the last tread flush with the upper
  floor, under a ceiling hole over the upper three quarters. It's also why the flooded dip's banks
  are ~15°.
- A drop hole is one-way: the floors are 42 cm apart and a jump reaches 10 cm.
- **The gap** (`r` 0.1 m, ~25 cm wide with its rounded rims) is wider than a running lizard can cross
  without jumping (it would fall more than the 7.5 cm it can scramble back up) and narrower than a
  running jump (27 cm, and landing short pulls up onto the rim). Walking or running into it drops
  into the tube below, which leads back to a rubble pile before the gap.

## The maze

Upper floor: the start chamber (skylight) east to a fork. North: a dead end with a skylight; east
along the north tube over **the gap** to a second fork, where a dead end ends in the `pocket` drop
hole and the east tube runs to the last chamber (skylight), whose `last` hole drops into the tube to
the jameo. South from the first fork: a sunny chamber whose `south` hole drops into the lower tubes,
which fork: north to a rubble pile up into an alcove off the east tube, or south through the flooded
stretch to the jameo. The `pocket` drop leads to the last tube too, a shortcut; falling in the gap
leads back to the `gap` rubble pile, a setback.

## Run and goals (`run.ts`)

The clock starts on the first move; reaching the jameo's floor (`FINISH`) wins; R starts over. The
run tracks the floor the lizard last stood on: landing on the lower floor having left the upper one
by a hole is a drop (by hole name), standing on the upper floor again having walked up is a climb,
landing on the upper floor after being in the air over the gap is a leap. Goals: drop through a
hole, climb a rubble pile, leap the gap, bask under all four skylights, swim the flooded tunnel,
reach the jameo, get out in under 60 s.

## Tests (`tests/tunnels.spec.ts`, `tests/helpers/bootTunnels.ts`)

Hooks: `layout()`, `light(x, y, z)`, `floorBelow(x, z, from)`, `run()`, `restart()`, plus the shared
`player`, `teleport` (with a height, for the upper floor), `setInput`, `viewFrom`, `advance`. Rapier
only answers ray casts after a step, so advance once before casting. The tests check the floors join
up (each hole's shaft reaches the lower floor, every riser is climbable, the last tread is flush),
the sun reaches each skylight's floor, a walk into a hole drops, both rubble piles climb, the gap is
leapt at a run and swallows a walk or a plain run, the flooded stretch is swum, and the last tube
leads into the jameo.

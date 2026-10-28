# Lava tunnels (`?level=tunnels`)

The fourth stage, opened with `?level=tunnels` or from the "Select stage" picker (`src/stageSelect.ts`;
the still is `src/assets/stages/tunnels.jpg`). It's the lava tube area of the progression plan,
built as a maze with a vertical side: small lava tubes on two floors under a lava field. Holes in
the upper floor drop the lizard into the tubes below, sometimes into a dead end and sometimes onto
a shortcut; rubble piles under holes in the lower tubes' roofs climb back up. Skylights let the sun
in. Past the jameo, a wide collapse open to the sky in the south-east, the tube runs on into a sea
mouth: a flooded tube end opening onto a cove, and the run ends on the cove's beach, looking across
the water at the outer islet where Galapagos sea lions bask (the final stage, not built yet). Barn
owls roost up two of the skylights and hunt by sound; whitetip reef shark pups rest in the flooded
mouth. Everything lives in `src/tunnels/`; it reuses the dunes' `Markers` and run HUD and the shared
player, camera and water.

## The rock (`assets-src/tunnels.py`)

The layout lives in the Python script, not in TypeScript: `TUBES` (polylines on floor 0 or 1),
`ROOMS`, `HOLES` (round `drop` holes and the `gap` across the north tube), `RAMPS` (rubble piles),
`SKYLIGHTS`, `JAMEO`, `POOLS`, `START`, `FINISH`, `ISLET`, `ROOSTS`, and `KEEP_CLEAR` (lanes the
fallen blocks stay out of: the routes the tests walk, holes, rubble piles, the start). Running it
(`npm run assets`, Python 3.11 with `bpy`, `scikit-image` and `scipy`; about 50 s) writes three
files the game reads:

- `src/assets/tunnels.glb`: the rock, one mesh. A signed distance field of the air meshed by
  marching cubes on a 3 cm grid and decimated to ~160k triangles. Faces point into the air. Real
  lava tubes aren't smooth pipes, so the field has: tubes whose width and height wander along their
  length (`tube_sdf`), lava benches (the ledges a falling flow leaves along the walls), big lumps and
  knobs on walls and roofs, an upper floor that sags a few millimetres, ragged lobed drop holes and
  skylights that flare open at the top, rims broken back near the gap's crossing, and **breakdown**:
  rotated, chamfered blocks of fallen roof (`make_blocks`), heaps under the skylights, a ring in the
  jameo and pieces scattered every ~20 cm along the tubes, 2.5 to 12 cm high so the lizard can
  clamber over most of them. The rubble stairs are jumbled slabs too (skewed, chipped, overlapping,
  with the centre tread of each riser kept exact). Each vertex carries baked ambient occlusion
  (`occlusion`, in the `COLOR_0` attribute).
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

- `src/level.ts` knows `'tunnels'`. `terrain.ts` uses a 10 m square, drawn unlit
  (`MeshBasicMaterial`) with the light baked into its colours, and a coarse outer grid out to 34 m
  (not under the tubes, `z < 2.5`) with its own fog-free material, so the sea and islet read in
  daylight from inside. `tunnelsHeight` (layout.ts) is the lower floor with a little roughness
  (ropy darkening in `tunnelsColour`), the cove south of `coveZ` (sand, boulders, the sea bed of the
  mouth's channel) and outside the square the sea floor rising to the islet (`outerHeight`).
  `water.ts` has a sheet over the whole south (`SHEET`), looking like the seep inside and the open sea
  outside (`OPEN_SEA`); `OCEAN_X0` is off so the flooded dip is swimmable.
- `src/tunnels/main.ts` is the level's main, built like the lagoon's. Hooks are `window.__tunnels`
  (`TunnelsTestHooks` in `src/debug/testHooks.ts`, built in `createTunnelsHooks.ts`).
- Step order per physics tick: run (floors, drops, climbs, leaps, basking, finish, goals), owls,
  sharks, player, Rapier. While caught, input is held still.
- `rock.ts` loads the rock and draws it faceted (non-indexed, one colour per face): `rockColour`
  (stone by facing, toon bands of the baked glow, warm sun patches, sparse moss where sun falls on an
  upward face) times `rockShade` (a fixed key light on the face normal and bands of the baked AO), so
  lumps and blocks read even unlit. The collider is the indexed mesh, a trimesh
  (`FIX_INTERNAL_EDGES`), so the lizard stands on exactly what is drawn. It also adds the sunbeams,
  slanted additive cylinders under each skylight and into the jameo.
- Camera: the follow camera's arm passes through the rock (its collider is in the pass-through
  set), so it keeps its distance instead of jerking in and out on every lump. `cutaway.ts` draws
  the rock inside a cone from the camera to the lizard as a faint ghost instead (floors below the
  lizard excepted): the solid rock discards those fragments and a second, see-through draw of the
  same geometry shows only them.
- The rock's sides are closed a few centimetres inside the square, and `floor_air` in the generator
  marks where the lower floor is open. A lizard found grounded or swimming on the lower floor
  anywhere else (inside the rock, under the tubes) is put back at its checkpoint (`onLost`).
- Lighting: nothing underground casts live shadows. Each frame the hemisphere and sun intensities
  follow the baked light at the lizard's feet, and a weak point light on the camera keeps the dark
  lizard readable against dark rock. The fog is dark and close inside and eases to the sky's far fog
outside (`outside()`, by the camera); underwater it goes from dark green to the sea's.

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

The way out: from the jameo the `mouth` tube widens and drops into a sea pool (the lizard swims it,
or climbs out onto the rock), opening south onto the cove. `FINISH` is on the cove's beach; across
the water to the south is `ISLET`.

## Creatures

They're `FreeRig`s (`src/render/freeRig.ts`): GLBs from `assets-src/owl.py`, `whitetip.py` and
`sealion.py` (shared builders in `assets-src/common.py`: `MeshBuilder`, `build_free_rig`, ...) whose
bones are unparented joints the game places part by part, as the heron does. Each has its joints in
the armature's extras.

- **Barn owls** (`owl.ts`, Galapagos barn owl). One sits on a ledge high in the shady side of the
  `south` and `last` skylight shafts (`ROOSTS`, a block in `make_blocks`), head turning after sounds.
  It hears the lizard on the floor under the skylight: running or a jump/landing within 0.9 m, a walk
  only within 0.16 m, standing still never (`HEARING`). Heard within `REACH` (0.55 m) it stirs
  (`alert`), drops on the spot it last heard, and if the lizard is still within 6.5 cm, mantles over
  it with wings spread: the run goes `caught` for 2.2 s, then the lizard is put back at the
  checkpoint (where it last changed floors, or the start) and the owl flies back up. A miss leaves it
  on the floor a moment, then it returns and stays deaf a little while. Basking 2 s under an owl
  without it stirring is a goal.
- **Whitetip reef sharks** (`sharks.ts`): two pups (0.55 m) lying on the sea pool's bed in the mouth,
  tails barely moving. A swimmer within 0.42 m wakes one: it bolts down the channel and out to sea,
  stays away 9 s, and cruises back to its spot. Harmless; startling one is a goal.
- **Sea lions** (`sealions.ts`): a herd on the islet's north beach (a bull, cows, pups: one model
  scaled and tinted), breathing and now and then lifting a head. Scenery for the stage to come.

## Run and goals (`run.ts`)

The clock starts on the first move; standing on the beach at `FINISH` (not swimming) wins; R starts
over. The run tracks the floor the lizard last stood on: landing on the lower floor having left the
upper one by a hole is a drop (by hole name), standing on the upper floor again having walked up is
a climb, landing on the upper floor after being in the air over the gap is a leap. Goals (9): drop
through a hole, climb a rubble pile, leap the gap, bask under all four skylights, swim the flooded
tunnel (inside, `x < 2.6`), bask under a barn owl without it hearing, swim over a resting whitetip,
find the way out to the sea, get out in under 60 s.

## Tests (`tests/tunnels.spec.ts`, `tests/helpers/bootTunnels.ts`)

Hooks: `layout()` (with `roosts` and `islet`), `light(x, y, z)`, `floorBelow(x, z, from)`, `run()`
(with `catches` and `checkpoint`), `owls()`, `sharks()`, `restart()`, plus the shared `player`,
`teleport` (with a height, for the upper floor; it also calls the owls back to their ledges, deaf a
moment, so they don't hear the lizard land), `setInput`, `viewFrom`, `advance`. Rapier only answers
ray casts after a step, so advance once before casting. Walking right under a roost is heard, so a
test that walks past one starts clear of it. The tests check the floors join up (each hole's shaft
reaches the lower floor, every riser is climbable, the last tread is flush), the sun reaches each
skylight's floor, a walk into a hole drops, both rubble piles climb, the gap is leapt at a run and
swallows a walk or a plain run, the flooded stretch is swum, the beach is the way out, an owl misses
a still lizard and catches a running one (and the lizard comes back at the checkpoint), and a pup
bolts out to sea when swum over.

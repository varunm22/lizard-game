# Nesting dunes (`?level=dunes`)

A second level, opened with `?level=dunes` or from the "Select stage" picker in the top-right corner (`src/stageSelect.ts`, a tile per stage with a still from `src/assets/stages/`; the island stays the default, and the choice is remembered for the tab where the URL can't carry it, as in the embedded preview). Each tile has a thin segmented bar along the foot of its still, filled for
the goals ticked off on that stage: `Goals` keeps them in `localStorage` (`src/progress.ts`, which
also holds each stage's goal count, `GOAL_COUNT`, checked under `?test`), so a stage reloads with its
goals as they were left. The picker is off in tests unless the URL has `picker`. The lizard hatches in a
burrow on the western nesting flat and has to cross the dunes to the adult colony on the shore
rocks in the east, past racer snakes (*Pseudalsophis occidentalis*), as Fernandina hatchlings do
each May and June. Everything lives in `src/dunes/`; shared systems (controller, camera, water,
plants, lizard model) are reused unchanged.

## Wiring

- `src/level.ts` reads the URL. `terrainHeight` and the ground colours dispatch on it
  (`src/world/terrain.ts`), so `Water`, the camera and the controller work without knowing the level.
  The dunes' sand ripples are drawn per pixel (`sandShader.ts`) from an `aSand` vertex attribute.
- `src/dunes/main.ts` is the level's own main: same fixed-step loop, `?test` driving and
  `advance`/`frame` as the island's. Test hooks are `window.__dunes` (`DunesTestHooks` in
  `src/debug/testHooks.ts`, built in `createDunesHooks.ts`); `window.__game` isn't set.
- Step order per physics tick: run (start, catch, finish, goals), racers, hatchlings (decide, then
  their controllers step), plant drag, player, Rapier. Racers and hatchlings use seeded `rng`.

## Layout (`layout.ts`)

The dunes square is 14 m (`TERRAIN_SIZE` and the heightfield's cells depend on the level, so cells
stay ~3 cm; the island stays 8 m). West to east, about 11 m from the nest to the colony: the
nesting flat (most of the 70 burrows; the lizard's is `NEST_BURROW`), a first belt of wind-ridged
dunes (crests across the south-east trade wind, slip faces on the lee, broken along their length),
the first safe point, a lava field of tongues and knolls with sand between, the second safe point, a
taller belt of beach dunes, then the lava coast with a sandy cove (mangroves). A few burrows are
dug out across the sand too, as places to duck into. `COLONY` is the finish; its `r` is where the
run is won, at the edge of the adults. `SAFE_POINTS` are rock crevices at the west foot of a knoll,
boulders either side (`props.ts`). `RACER_HOMES` are spots round the knolls (only on the far side
of the safe points' knolls) and on the shore rocks. `DUNES_EDGE` keeps animals and props off the walls.

## Racer snakes (`snakeBody.ts`, `racers.ts`, `assets-src/snake.py`)

- Model: 0.9 m (adults reach ~1.3 m), ~1.8 cm wide at midbody, from photos. 46 spine bones plus head
  and tongue; two colour forms (spotted, striped) side by side in one texture, picked by `map.offset`.
- Body: follow-the-leader. The neck's path is recorded (`crawlTo`), each bone is placed its own arc
  back along it, so the body slides along its own track. Lateral undulation is a heading sway that
  advances with distance crawled. Bones are flat (unparented) and the mesh is never frustum-culled.
- Behaviour: lurk coiled, lift the head and watch (`alert`) when something moves in plain sight,
  `chase` after a second of watched movement (sooner the closer; at once within `pounce` or smell),
  dash then chase speed, `strike` within a head's length, coil round a catch (`feed`), lie up
  (`rest`), `return` home. A chase is given up after `chaseTime`, beyond `leash`, or when the quarry
  hasn't been seen moving for `lostTime` (then `search`). Sight is a ray from the eye to three body
  points; dune crests, rocks and the adults block it, saltbush canopies (`bushes.ts`) too, and prey in
  a burrow or under a bush is found only within `bushSmell`.

## Hatchlings, colony, run

- `hatchlings.ts`: four nest-mates on the lizard's own controller and drawing, never solid to it.
  They come up from burrows round the nest, dash and freeze toward the colony, freeze while watched,
  dive for a bush when chased, and are replaced after being caught or getting home.
- `colony.ts`: five adults (the lizard model ×3.4, tinted), idle, solid (a ball per spine joint).
- `run.ts`: ready → running (first movement) → caught (2.5 s in the coils) or home. Reaching a safe
  point sets the checkpoint: inside it no snake hunts the lizard (`BodyPrey.huntable`), and a later
  catch puts the lizard back there with the clock still running; caught before the first, it starts
  over at the nest. R restarts; once the run is won, C goes on to the next stage (`runKeys` and
  `endKeys` in `hud.ts`, shared with the lagoon and the tunnels; after the tunnels, back to the
  island). Goals: shelter in a safe point, reach the colony, freeze until a
  watching snake looks away, hide from a hunting snake, outrun one, cross without being chased,
  cross in under 60 s.
- `markers.ts`: a pale ring at the nest; a teal column and ring at each safe point (pale green once
  reached); a golden light column (unfogged, additive, fades as the
  camera comes in) and ring at the colony. `hud.ts`: intro card, clock and best, distance and arrow
  to the light, danger warning, messages, controls.

## Props and plants

`props.ts` places basalt boulders, lava cactus, mangroves, bleached driftwood, saltbushes (solid
woody base, see-through canopy when in the camera's way), eggshells and shell grit, using
`props.glb` and `dunes.glb` (`assets-src/dunes.py`). `plants.ts` lays out the shared plant kinds for
the dunes through `Plants.load`'s `place` argument: grass tussocks on crests and lee slopes,
morning-glory runners across hollows, carpetweed along the strand, Tiquilia on lava, with bare lanes
left open between patches.

## Tests

`tests/dunes.spec.ts` with `tests/helpers/bootDunes.ts`, which holds the snakes and hatchlings
still unless a test asks for them. Hunting tests lay racer 2 down (`placeRacer`) on the open
nesting flat at (-5.2, -1.6) facing east, which has a clear view about 0.75 m out (further, dune
swells hide the lizard from its eye).

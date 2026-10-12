# Nesting dunes (`?level=dunes`)

A second level, opened with `?level=dunes` (the island stays the default). The lizard hatches in a
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

West to east: the nesting flat (34 burrows, the lizard's is `NEST_BURROW`), a belt of wind-ridged
dunes (crests across the south-east trade wind, slip faces on the lee, broken along their length),
two lava flows and six lava knolls standing out of the sand, then the lava coast with a sandy cove
(mangroves). `COLONY` is the finish; its `r` is where the run is won, at the edge of the adults.
`RACER_HOMES` are where the snakes lie up, mostly at the foot of knolls and shore rocks near the
straight line from the nest to the colony.

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
- `run.ts`: ready → running (first movement) → caught (2.5 s in the coils, then back at the nest)
  or home. R restarts. Goals: reach the colony, freeze until a watching snake looks away, hide from a
  hunting snake, outrun one, cross without being chased, cross in under 30 s.
- `markers.ts`: a pale ring at the nest; a golden light column (unfogged, additive, fades as the
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
still unless a test asks for them. Racer 2 lies on the open nesting flat with a clear view about
0.75 m out (further, dune swells hide the lizard from its eye), so hunting tests use it.

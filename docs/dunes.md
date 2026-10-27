# Nesting dunes (`?level=dunes`)

The first stage and the default load (the island is `?level=island`), also opened with `?level=dunes` or from the "Select stage" picker in the top-right corner (`src/stageSelect.ts`, a tile per stage with a still from `src/assets/stages/`; the choice is remembered for the tab where the URL can't carry it, as in the embedded preview). Each tile has a thin segmented bar along the foot of its still, filled for
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
  advances with distance crawled (`wave` 0.34 m, `sway` 0.8 rad: two or three waves along the body,
  each about a tenth of it across; the step is scaled by 1/J0(sway) so speeds stay speeds along the
  course). The course bends no tighter than `bend` rad/m, so a turn spreads along the body as a
  curve instead of a kink. With a small sway the body read as straight with one sharp bend. Held still, a
  racer looks round by curving its forebody (`turn`, spread over `turnReach` with an eased share
  so there's no corner; most of the look goes there, the rest at the head), and lifts the front
  over `liftReach` 0.26 m. The strike's lunge turns no quicker than a chase. Turning the head alone
  at one joint, and the old 30 rad/s strike turn, left sharp corners in the body. Bones
  are flat (unparented) and the mesh is never frustum-culled.
- Behaviour: lurk coiled, now and then `prowl` a little way about home (8 to 22 s after lying up,
  0.15 to 0.4 m out) and lie up where it stops, lift the head and watch (`alert`) when something moves in plain sight,
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
- `colony.ts`: meant to look like the island's colony, where the hatchling is headed. Six adults
  (the lizard model ×3.4, tinted) heaped along the shore seaward of an open lane running south
  (`LANE_X`, to `LANE_END`), two more landward of it, on a flat of black lava (`COLONY_FLAT` in
  `layout.ts`) ringed by big boulders (`COLONY_ROCKS`, placed last in `props.ts` so nothing before
  them moves); they turn their heads and sneeze salt (`SaltSpray`, `sneezeNod` from `iguana.ts`).
  Four Sally Lightfoot crabs (`crab.glb`, idle and graze clips only). Adults and crabs animate only
  within 4 m of the camera. Adults are solid (a ball per spine joint) until the walk-in. Keep the
  adults within about 0.75 m of the middle: the shore rocks and cactus start beyond that.
- `grove.ts`: the island's forest edge on the shore south of the colony (`GROVE`): tree daisies and
  palo santo from the island's `props.glb`, solid trunks, placed after the plants from their own
  random numbers so nothing else moves, the plants in their trunks removed. It's what the walk-in
  heads for, so leaving the dunes looks like walking into the island.
- `arrival.ts`: C on a won run (`runKeys`' `onContinue`) walks the hatchling on: it steers itself
  through the player's input, always forward, in one smooth bend from the way it's going round to
  the south (from the north, round by the landward side), joins the lane at no more than 45° and
  goes down it toward the grove. The adults stop being solid and the finish marker is hidden; the
  camera eases up behind it and swings round to look straight down the lane at the trees. After
  `WALK_IN` s (on the lane's last stretch, at most `WALK_MAX` 5 s) the screen fades to black over
  `FADE_OUT` s (`hud.fade`), then the island loads. Waypoints it has passed close by are skipped,
  so it never circles back. Hooks `leave()`, `arrival()` and `colony()`.
- `run.ts`: ready → running (first movement) → caught (2.5 s in the coils) or home. Reaching a safe
  point sets the checkpoint: inside it no snake hunts the lizard (`BodyPrey.huntable`), and a later
  catch puts the lizard back there with the clock still running; caught before the first, it starts
  over at the nest. R restarts; once the run is won, C goes on to the next stage (`runKeys` and
  `endKeys` in `hud.ts`, shared with the lagoon and the tunnels; after the tunnels, back to the
  island). Goals are few and short, things worth doing rather than a checklist of the level: reach
  the colony, freeze until a watching racer looks away, outrun one, cross without being chased.
  The warnings are one word ("Freeze!" while watched, "Run!" while chased) and the intro card three
  lines.
- `markers.ts`: a pale ring at the nest; a faint teal ring on the ground at each safe point
  (paler green once reached) under a faint 0.6 m column that only fades in as the camera comes
  within about 3.5 m (`SAFE_COLUMN`), so they're found rather than steered by; a golden light column (unfogged, additive, fades as the
  camera comes in) and ring at the colony. `hud.ts`: intro card, clock and best, distance and arrow
  to the light, danger warning, messages, controls.

## Props and plants

`props.ts` places basalt boulders, lava cactus, mangroves, bleached driftwood, saltbushes (solid
woody base, see-through canopy when in the camera's way), eggshells and shell grit, all from
`dunes.glb` (`assets-src/dunes.py`; the island's `props.glb` is no longer used here). The models
aim for low poly with natural irregularity rather than geometric shapes:

- Foliage is built from `clump`s (noise-pushed icospheres, smooth-shaded) whose shading normals
  lean out from the middle of the whole canopy, so under the two-band toon ramp a crown lights as
  one mass with one shadow edge; `leaves` scatters two-sided oval leaves over the clumps' surface
  to break up the edge. Both live in `assets-src/props.py` for reuse on other stages.
- Limbs are `tube`s with `rough` (noise out of round). Mangrove limbs fork at uneven heights and
  carry the leaf clumps at their tips, so the crown takes its shape from the branching; prop roots
  arch down from the trunk at random, some forking near the sand, and aerial roots drop from limbs.
- Boulders are hulls of a noisy ellipsoid with a few random fracture planes cut through it (the
  hull is still the collider). Driftwood tapers from a root end with broken roots to a snapped tip,
  out of round, with a stub or two of branch; its collider is the hull of the tapered trunk alone
  (extras `radius` at the root end, `tip`), underside along the ground.
- Lava cactus are dense clumps of ribbed columns of every height, the outer ones leaning out and
  turning up, golden at the young tips and grey-black at the base.

The props draw from seeded generators; the TypeScript placement consumes the same random numbers
as before, so the layout (and the racers' sightlines the tests depend on) only changes by shape. `plants.ts` lays out the shared plant kinds for
the dunes through `Plants.load`'s `place` argument: grass tussocks on crests and lee slopes,
morning-glory runners across hollows, carpetweed along the strand, Tiquilia on lava, with bare lanes
left open between patches.

## Tests

`tests/dunes.spec.ts` with `tests/helpers/bootDunes.ts`, which holds the snakes and hatchlings
still unless a test asks for them. Hunting tests lay racer 2 down (`placeRacer`) on the open
nesting flat at (-5.2, -1.6) facing east, which has a clear view about 0.75 m out (further, dune
swells hide the lizard from its eye).

# Mangrove lagoon (`?level=lagoon`)

The third stage, opened with `?level=lagoon` or from the "Select stage" picker (`src/stageSelect.ts`;
the still is `src/assets/stages/lagoon.jpg`). It's area 3 of the progression plan: a sheltered
lagoon behind the lava, like Elizabeth Bay or Black Turtle Cove, walled by red mangroves. The lizard
starts on the colony's lava coast in the west and has to reach the lava field across a tidal channel
in the east, past lava herons (*Butorides sundevalli*) stalking the shallows. The gate is a chain:
clear the drift wrack damming the log pool's creek so the pool drains; shove the driftwood log, stuck
by its keel at the pool's rim, loose; the creek carries it into the channel's ebb, where it catches
(on the wrack, which has drifted down and racked up on a drowned snag, or wedged where the channel
narrows) and lies across as a bridge.
Everything lives in `src/lagoon/`; it reuses the dunes' run pieces (`GroundProbe`, `Markers`, the run
HUD with the stage's own words, `HudText`) and the shared player, camera and water unchanged.

The plan's "high tide floats the log" is an **ebb current** here instead: a tide would mean a moving
`WATER_Y`, which every system reads as a constant. The current is `current(x, z)` in `layout.ts`.

## Wiring

- `src/level.ts` knows `'lagoon'`; `terrainHeight` and the ground colours dispatch to
  `lagoonHeight`/`lagoonColour` (`src/world/terrain.ts`, a 12 m square). The sea test `inOcean` is
  off here (`OCEAN_X0` in `shore.ts`), and `water.ts` has a lagoon sheet (tea-green, a calmer wash)
  with its depth tint over the whole square.
- `src/lagoon/main.ts` is the level's main, built like the dunes': fixed-step loop, `?test`
  driving, `advance`/`frame`. Hooks are `window.__lagoon` (`LagoonTestHooks` in
  `src/debug/testHooks.ts`, built in `createLagoonHooks.ts`).
- Step order per physics tick: run (start, catch, safe point, finish, goals), herons, wrack, log (both
  shoved if the lizard moves forward into them), sharks and rays (which read the lizard through the run's
  `prey`, like the herons), the current carrying a swimming lizard (`player.carry`), player, Rapier.
  Herons and swimmers use seeded `rng`.

## Layout (`layout.ts`)

West to east: the lava coast (`westCoastX`), a basin a few centimetres to a hand deep (flats where
herons wade, a pale sand bar, mud hummocks under mangrove stands, lava knobs to bask on, deeper
`POOLS`), then the channel along the foot of a lava flow, then the lava field. The channel's middle
line and half-width are `channelX(z)`/`channelHalf(z)`, narrowest at `JAM_Z`; its west bank is mud
(`BANK_TOP`), its east bank a lava face up to `SHELF_TOP`, too high to climb out onto from the water
(the controller climbs at most 7.5 cm above its feet, and swimming feet are 3 cm under). It's 30 cm
deep and wider than a jump. `CURRENT` runs south, faster through the narrows; once the wrack dam is
cleared (`CREEK_FLOW.open`, 0 to 1) the log pool drains toward its `CREEK`, east down it, and on out
into the channel a way (`CREEK_JET`) before the ebb turns it. The log pool (`rim`) has a flat floor
deep enough to float the log and its keel. Above the narrows a lava knob juts out from the east bank
(`eastEdge`) over the drowned snag's foot (`SNAG`, on a rubble bar), and upstream across from it the
west bank builds out as a mud spit just out of the water (`westEdge`), so a log caught there lies
from mud to lava. `SAFE_POINTS[0]` is a nook among three old mangroves (the
first stand). `HERON_HAUNTS` are each heron's spots: wadeable, clear of roots and rocks (the load
test checks each with the `wadeable` hook; re-check after moving props). `props.ts` keeps the first
three herons' spots clear as it scatters; herons 3 to 5 were placed in the clearings that leaves, so
adding them didn't move a prop or change the scatter's random draws.

## Props (`props.ts`, models in `assets-src/lagoon.py`)

Red mangroves (three sizes) stand on the hummocks and along the channel's west bank (`FRINGE`, with
gaps at the creek and the jam landing). Each has a trunk cylinder and capsules along its prop roots,
all `PLANT_STEM_GROUP`: they stop the lizard and the log and block a heron's view, but aren't ground
and the camera sees through them. Saplings in the shallows, black mangroves with their breathing
roots, propagules, stranded driftwood, rocks and lava cactus fill it out; more mangroves outside the
walls are drawn only. Red mangroves are instanced per kind; their `Mangrove` records (`reach`)
drive the herons' tangle and wading rules.

## Herons (`herons.ts`, `heronBody.ts`, model in `assets-src/heron.py`)

Six of them, tuning in `HERON`. A heron waits at a spot, head turning, and moves to its next spot
every 14 to 24 s. It sees the lizard within 1.7 m and ±115° of its bill if nothing solid is between
(roots and trunks included), then stalks it crouched, wading no deeper than 7 cm, never into a red
mangrove's roots, the channel or 2.5 m from its spot. Within 20 cm of its shoulders it draws its neck
back for 0.25 s and stabs (0.075 s) at where the lizard will be, the body lunging up to 3.5 cm after
the bill; the bill tip within 4 cm of the snout, middle or hips is a hit, which takes
`VITALS.heronHit` (40%) of the lizard's health and throws it aside (`Wounds.strike`). The heron then
recovers and, if it still sees the lizard, stalks again; only the stab that takes the last of its
health leaves the lizard in the heron's bill (`hold`). A heron that isn't
stalking yet strikes all the same at a lizard that comes within 22 cm in view (`ambush`), after only
a 0.1 s beat: a lizard swimming slowly past in the shallows gets speared with no stalking warning.
The lizard is out of reach in a tangle (within 85% of an old mangrove's root reach) or swimming over
water deeper than 11 cm (`hidden()`); it also gets away by staying out of sight 1.4 s or out of reach
4 s. `onLose` says which, for the goals.

Stalking is slow and careful (`GAIT.stalk`): one foot rises quickly and comes down slowly over 0.6 s
while the body glides on, then both feet stand still a 0.3 s beat while the body all but stops,
averaging 7.5 cm/s. Each foot reaches as far ahead as the body will have gone by the time it's down,
and half a step more. The head is held still in the world as the body moves under it
(`steadyHead`), easing back to the stalking pose. Walking between spots steps the same way without
the pauses. The body rides on the ground under the feet, not on the lifted foot, so it doesn't bob.

The model has no clips: all bones are unparented and posed each frame. The body leans and crouches,
the neck is a curve from the shoulders to wherever the head is put, the bill turns to the lizard,
and each leg reaches its planted foot with an exact two-bone solve, the ankle bending backward. That
foot IK is for this drawn NPC only; the player still has none. The simulation decides the head's
position and the bill tip from the stance alone (`billTip`), so posing never feeds back into the hunt.

## The drift log (`driftLog.ts`)

A forked red mangrove limb, bleached and barkless, with a waterlogged prop-root stub (the keel). It's
a real dynamic Rapier body: capsule colliders from the model's `segments`, the keel denser than the
water. Each step adds buoyancy and linear plus quadratic drag per sample along each collider,
relative to `current()`, so it floats, drifts, grounds and snags on its branches by itself. The
lizard isn't in its solver groups: it shoves it only through `shove` (snout within 3 cm of a limb,
seen from above, within 6 cm up or down; a sinking swimmer passes under, so tilt up), weighs on it
where it stands (`RIDER_WEIGHT`), and rides it by following its pose (`player.carry`).

It starts `aground`: a fixed body at `LOG_START`, its keel root stuck in the mud at the pool's west
rim. Shoved for `WORK_LOOSE` (0.4 s) in all it turns dynamic and floats (`onAfloat`); the drain then
carries it to the creek. Touching a racked wrack piece's upper half (`Wrack.hooks`), it hooks on: a
ball joint at that point, so the current swings it round on it. Still for 1.2 s with its main limb's
ends within 0.35 of the west bank and of the lava face (`acrossChannel`, `eastEdge`), it's `jammed`:
fixed for good, a bridge. Swept past the south edge it's lost and another floats in the pool. `R`
puts it back stuck in its pool.

## The drift wrack (`wrack.ts`)

Eight dead twigs and old propagules standing on end in a tangle in the creek's mouth (`DAM`),
leaning one way and another, tops at the surface. Kinematic bodies moved here; the log collides
with them, the lizard doesn't. Shoved by the lizard's snout (reaching 18 cm down: its feet catch
the twigs swimming over), a piece topples onto the bed and is loose; `CREEK_FLOW.open` is the share
loose (`onCleared` at all of them). Loose pieces roll along the bed with the current; in the channel
within 0.1 m of the snag line they rack up on it in turn (`SLOTS`, from the knob's tip out across),
standing and leaning downstream, tops just awash (`onRacked`). The drowned trunk is solid but lies
27 cm down, too deep to catch a floating log until the wrack stands up on it. `rackAll` (hook
`rackWrack`) racks them at once for tests.

## Vitals

The island's four bars (`src/player/vitals.ts`, drawn by `createVitalsPanel` in `src/vitalsPanel.ts`, bottom
right) run here as on the island: warmth from the sun on land (`ClimateSense`, with `lagoonLava` for
the black lava that warms best, and the instanced mangroves passed to `Cover` so they shade), lost in
the water and faster under it; air used under water; food burning down, and filled by biting the lagoon's algae (below); health mending while fed and warm, drained by freezing, starving or drowning, and taken
by stabs and bites. At none, `Wounds` lays the lizard down for `CAUGHT_TIME` (2.5 s); then the run puts it back
(`afterDown`) with full bars. Starting over (R) fills them too. `bootLagoon` holds the bars still
(`setVitals({ frozen: true })`, strikes still land) unless a test asks for `vitals`.

## Algae (`algae.ts`, models in `assets-src/lagoon.py`)

Not the open coast's red turf and sea lettuce but what grows in a sheltered mangrove lagoon:
gutweed (*Ulva intestinalis*), the bright green tube weed of calm brackish shallows (and a marine
iguana food), on the lava where it runs into the water (0.3 to 7 cm deep, round the knobs and along
the colony's coast); and *Bostrychia*, the dark red-purple moss-like alga of the "Bostrychietum" that
fringes mangrove prop roots at the waterline, on about half the roots (`rootWaterline` from
`buildLagoonProps`: where each root crosses the surface, pushed out to its bark). `lagoonAlgaeSites`
places them (seeded, 4.5 cm apart, about half grown at the start) for the island's `Algae`
(`src/world/algae.ts`, which takes a geometry per kind and optional sites), so patches regrow and
sprout as there. As on the island, "[F] to eat" shows while algae is within a bite (`createEatPrompt` in
`src/vitalsPanel.ts`), F bites (`Feeding`), and each mouthful fills food (`vitals.eat`). Hooks: `algae()`,
`bite()`, `feeding()`.

## Run and goals (`run.ts`)

As the dunes': the clock starts on the first move; going down (a heron's stab or a shark pup's bite
taking the last of its health, or the cold, hunger or drowning) puts the lizard back at the start, or at
the safe point once reached; reaching `FINISH` on the lava field wins. Goals: shelter in the roots,
cross, hide from a stalking heron in the roots, escape one into deep water, slip away from one, clear
the wrack dam, work the log loose, float it into the channel, catch it across the channel, ride it
1 s, swim beside a shark pup, swim with the rays. `GOAL_COUNT.lagoon` in `src/progress.ts` is 12.

## Sharks and rays (`swimmers.ts`, models in `assets-src/lagoon.py`)

Three newborn blacktip shark pups (0.38 m, slim) and fifteen young golden cownose rays (0.24 m
across) keep to their own pools, steering toward points deep enough to swim. Drawn and steered
only, no colliders. Each swims under the surface: its height is kept (only the smoothing changes it),
the top of its fins or wingtips (`height`, from the model's bounds plus the ray's bank) stays
`SUBMERGED` under the water, and it only heads where the water is `MIN_DEPTH` deep. Rays keep near the
bed; sharks cruise low and rise toward the surface when they come to look at a swimmer. Each has its own material, so the vertex shader bends it from its own uniforms:
a wave travelling down the shark's body, quicker and wider with speed, and the body curved a little
into a turn; the ray's wings rise and fall in a wave running back along them, in bouts of flapping
and gliding, banking into turns with the tail swinging out. Turn rates ease in and out.

A shark pup (`SHARK`) takes an interest now and then in a lizard swimming in its pool within 1.1 m
and comes over to circle it (`curious`), closer as it grows bolder; once close, out of mild
aggression, it may tense for 0.3 s (`tense`) and dart in to bite (`bite`). A lizard close by that
suddenly turns (more than 0.7 rad in the last half second) to swim straight at a pup gets bitten out
of surprise, with no warning; one swimming at it steadily makes it bolt. A bite takes
`VITALS.sharkBite` (30%) of the lizard's health (`prey.struck('shark', …)`), and a tensing or biting
pup shows as `chased` on the HUD.

The rays (`RAY`) drift between keeping company and going alone every 4 to 11 s. Keeping company,
they steer as boids with the others of their pool (in line, toward the middle, spread out when
close), taking up the first one's goal, so schools form, wander and break up. A swimming lizard
heading at a ray within 36 cm, or anywhere within 15 cm, sends it veering off (`shy`).

## Tests (`tests/lagoon.spec.ts`, `tests/helpers/bootLagoon.ts`)

`bootLagoon` holds the herons and the swimmers still unless a test asks for them. Hooks:
`herons()`, `heronBody(i)`, `placeHeron`, `haunts(i)`, `tangle`, `wadeable`, `log()` (with its
`spine`, the way along its top), `placeLog`, `logPoint`, `wrack()`, `pushWrack`, `rackWrack`,
`swimmers()`, `placeSwimmer`, `vitals()`, `setVitals`, `channel`, `current`, `depth`, `run()`, `restart`, `mangroves()`,
`marks()`. The hunting tests stand heron 1 at
its first spot facing south over the open flat. The log test runs the whole gate in about 6,000
steps (around 15 s): a shoved dam piece, the rest loosed with `pushWrack`, the log shoved loose, its
drift out of the pool and down to where it catches, and the walk from the west bank along its
`spine` onto the lava and to the light.

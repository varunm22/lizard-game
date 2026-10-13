# Mangrove lagoon (`?level=lagoon`)

The third stage, opened with `?level=lagoon` or from the "Select stage" picker (`src/stageSelect.ts`;
the still is `src/assets/stages/lagoon.jpg`). It's area 3 of the progression plan: a sheltered
lagoon behind the lava, like Elizabeth Bay or Black Turtle Cove, walled by red mangroves. The lizard
starts on the colony's lava coast in the west and has to reach the lava field across a tidal channel
in the east, past lava herons (*Butorides sundevalli*) stalking the shallows. The gate is a driftwood
log: floated out of its pool into the channel's ebb, it jams across the narrows as a bridge.
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
- Step order per physics tick: run (start, catch, safe point, finish, goals), herons, log (pushed if
  the lizard swims forward into it), sharks and rays, the current carrying a swimming lizard
  (`player.carry`), player, Rapier. Herons and swimmers use seeded `rng`.

## Layout (`layout.ts`)

West to east: the lava coast (`westCoastX`), a basin a few centimetres to a hand deep (flats where
herons wade, a pale sand bar, mud hummocks under mangrove stands, lava knobs to bask on, deeper
`POOLS`), then the channel along the foot of a lava flow, then the lava field. The channel's middle
line and half-width are `channelX(z)`/`channelHalf(z)`, narrowest at `JAM_Z`; its west bank is mud
(`BANK_TOP`), its east bank a lava face up to `SHELF_TOP`, too high to climb out onto from the water
(the controller climbs at most 7.5 cm above its feet, and swimming feet are 3 cm under). It's 30 cm
deep and wider than a jump. `CURRENT` runs south, faster through the narrows; the log pool drains
east down its `CREEK` into the channel. `SAFE_POINTS[0]` is a nook among three old mangroves (the
first stand). `HERON_HAUNTS` are each heron's spots: wadeable, clear of roots and rocks (a probe
checked them; re-check after moving props, since `props.ts` keeps clear of them).

## Props (`props.ts`, models in `assets-src/lagoon.py`)

Red mangroves (three sizes) stand on the hummocks and along the channel's west bank (`FRINGE`, with
gaps at the creek and the jam landing). Each has a trunk cylinder and capsules along its prop roots,
all `PLANT_STEM_GROUP`: they stop the lizard and the log and block a heron's view, but aren't ground
and the camera sees through them. Saplings in the shallows, black mangroves with their breathing
roots, propagules, stranded driftwood, rocks and lava cactus fill it out; more mangroves outside the
walls are drawn only. Red mangroves are instanced per kind; their `Mangrove` records (`reach`)
drive the herons' tangle and wading rules.

## Herons (`herons.ts`, `heronBody.ts`, model in `assets-src/heron.py`)

Tuning is `HERON`. A heron waits at a spot, head turning, and moves to its next spot every 14 to
24 s. It sees the lizard within 1.5 m and ±115° of its bill if nothing solid is between (roots and
trunks included), then stalks it crouched at 7 cm/s, wading no deeper than 6.5 cm, never into a red
mangrove's roots, the channel or 2.5 m from its spot. Within 17 cm of its shoulders it draws its neck
back for 0.35 s and stabs (0.16 s) at where the lizard will be; the bill tip within 3.5 cm of the
snout, middle or hips is a catch. The lizard is out of reach in a tangle (within 85% of an old
mangrove's root reach) or swimming over water deeper than 9 cm (`hidden()`); it also gets away by
staying out of sight 1.4 s or out of reach 4 s. `onLose` says which, for the goals.

The model has no clips: all bones are unparented and posed each frame. The body leans and crouches,
the neck is a curve from the shoulders to wherever the head is put, the bill turns to the lizard,
and each leg reaches its planted foot with an exact two-bone solve, the ankle bending backward. That
foot IK is for this drawn NPC only; the player still has none. Feet step one at a time when the body
has moved off them. The simulation decides the head's position and the bill tip from the stance
alone (`billTip`), so posing never feeds back into the hunt.

## The drift log (`driftLog.ts`)

A kinematic body (a 14-sided prism) moved each step as far as it fits: enough water under it along
its length and nothing in the way (a slightly shrunk shape, ignoring the ground and the lizard), or
else only its drift, or only its turn. The lizard shoves it by swimming forward with its snout
against its side (seen from above, and from up to 20 cm under it, since a swimmer sinks); a shove off
its middle turns it a little. Water drag stills it. The current carries it at the mean of the
current at three points along it, and the difference between its ends turns it, so a log nosing out
of the creek swings round into the ebb; in the channel it lines up with the flow and drifts out to
the middle. Within 0.4 m of the narrows it swings across in a scripted 1.6 s settle and lies jammed,
each end half sunk in the bank (mud on the west, a crack in the lava on the east) so the lizard walks
on and off it. Swept past the south edge it's lost and another lies in the pool. A lizard standing
on it is carried with it (`player.carry`). `R` puts it back in its pool.

## Run and goals (`run.ts`)

As the dunes': the clock starts on the first move; a catch puts the lizard back at the start, or at
the safe point once reached; reaching `FINISH` on the lava field wins. Goals: shelter in the roots,
cross, hide from a stalking heron in the roots, escape one into deep water, slip away from one, float
the log into the channel, jam it, ride it 1 s, swim beside a shark pup, swim with the rays.

## Sharks and rays (`swimmers.ts`)

Three blacktip shark pups and five golden rays keep to their own pools, wandering between random
points deep enough to swim; a shark pup darts off from a swimming lizard within 30 cm. Drawn and
steered only, no colliders; the tail beat and wing flap are in the vertex shader.

## Tests (`tests/lagoon.spec.ts`, `tests/helpers/bootLagoon.ts`)

`bootLagoon` holds the herons and the swimmers still unless a test asks for them. Hooks:
`herons()`, `heronBody(i)`, `placeHeron`, `tangle`, `log()`, `placeLog`, `swimmers()`, `channel`,
`current`, `depth`, `run()`, `restart`, `mangroves()`, `marks()`. The hunting tests stand heron 1 at
its first spot facing south over the open flat. The log test runs the whole gate in about 1,500
steps: a push, the creek mouth into the channel, a drift into the jam, and the walk across.

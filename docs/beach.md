# Sea lion beach (`?level=beach`)

The last stage: the outer islet, laid out like Española's beaches (Gardner Bay, Punta Suárez). The
lizard is grown now and wears the adult male's breeding colours (the "Christmas iguana": salmon-red
flanks blotched black, a turquoise crest and forelegs, a grey salt-crusted head). It comes in from
the sea, gets past the sea lions on the beach, and wins a display rock and a mate on the lek behind.
Won, the end screen sends it on (C) to the dunes, where its young hatch.

## Layout (`src/beach/layout.ts`)

A 12 m square, sea to the north (-z). North to south: open sea and a lava reef just awash where the
lizard starts (`START`); the white coral-sand beach (`shoreZ`), its waterline patrolled by the bull
(`BULL_BEAT`, `onBullStretch`), cows and pups lying above it (`COWS`, `PUPS`); the low lava field
(`fieldZ`) with the three display rocks (`DISPLAY_ROCKS`, tops 5 cm up, low enough to climb straight
onto), the rivals' sulking spots and the females at its back. West a rocky lava shore (`westX`),
east a lava point (`pointX`) with tide pools, where the penguins and cormorants stand. The terrain
uses `CELLS` 384 like the lagoon; `OCEAN_X0` is -12 so the shore code treats the whole stage as sea.

## Creatures

- **Sea lions** (`sealions.ts`, `sealionBody.ts`, model `assets-src/sea_lions.py`): three rigs in
  one GLB (cow 0.30 m, bull 0.44 m, pup 0.17 m: a fifth of real size, the tortoise's convention). A
  free rig (`render/freePose.ts`) posed each frame from a few numbers: `lift` (lying to propped up),
  `gait` (galumphing, the hind flippers turned forward), `swim` (fore-flippers beating), `look`,
  `nod`, `jaw`. Each has a kinematic capsule in `PLANT_STEM_GROUP` (solid, never ground to climb).
  The bull swims his beat 0.7 m off the waterline; a lizard on his stretch within `NOTICE` gets a
  rear-and-bark (`REAR_TIME`, HUD "watched") then a charge (`CHARGE_SPEED`, slow to turn,
  `CHARGE_TIME` at most, never past `BULL_STRETCH` up the sand). His muzzle within `HIT_REACH` takes
  `VITALS.bullHit` (cause `'sealion'`) and shoves the lizard aside. A charge or warning that ends
  without a hit counts as dodged. Pups come over to a lizard within `PUP_CURIOUS`, nudge it
  (`player.shove`) and go back to their mothers. The reaches are measured to the lizard's middle and
  include the gap the controller keeps from a body pressing into it (about 0.12 m), so don't shrink
  them to "touching" distances.
- **Rival males and females** (`rivals.ts`): each an `Npc`, a `PlayerController` + `LizardVisual`
  driven by an `InputState` like the island's iguanas. A male warns a lizard within `WARN` of his
  rock, displaying (`displayNod`, three head-bobs) every 1.8 s; a display back (B, gamepad Y) within
  `ANSWER` counts an exchange; after `backDown` exchanges (2 young, 4 seasoned, never the old male)
  he retreats to sulk for `SULK` s, then comes back. Within `CONTACT` it's a shoving match: both are
  locked head to head and moved by `carry`, the run holds the lizard's input (`BeachRun.held`); he
  surges (`SURGE`) and eases (`EASE`); holding forward pushes `PLAYER_PUSH`, and a butt (Space, only
  counted while he eases) adds `BUTT`. `WIN` either way ends it. Standing on a vacant rock for
  `CLAIM_TIME` claims it; seeing off the male who comes back for it counts as `defended` and brings
  the nearest female over; two displays to her (`COURTSHIP`) and she chooses the lizard: the run is won.
- **Seabirds** (`birds.ts`, `assets-src/penguin.py`, `assets-src/cormorant.py`): Galápagos penguins
  (two standing, two swimming loops low in the water, head up) and flightless cormorants (one holding
  its stubby wings out to dry, one going to sea and back). Swimming within `WITH` of a swimming bird
  ticks its goal.

Creatures are posed only within a few metres of the camera; the rivals and females go to
`lowDetail` past 1.5 m. None of that touches the simulation.

## Breeding colours

`assets-src/breeding_skin.py` paints `src/assets/iguana-breeding.jpg`, a second skin in the lizard
atlas's layout; `breeding.ts` swaps it onto a model's (cloned) materials and recolours the crest's
vertex colours turquoise. `lizard.glb` is unchanged.

## Run and goals (`run.ts`)

ready → running (first move) → caught or home (chosen). Down, it comes back where it first came
ashore (or on the reef if it never did), with the rivals and female reset. Goals (10, `GOAL_COUNT`):
ashore, dodge the bull, a pup's nudge, swim with a penguin, swim beside a cormorant, out-display a
rival, win a shove, claim a rock, see off a challenger, be chosen.

## Tests (`tests/beach.spec.ts`, `window.__beach`)

`bootBeach` pauses the sea lions and the rivals unless asked (`{ sealions: true, rivals: true }`) and
freezes the bars unless `vitals`. Hooks: `sealions()`, `placeBull`, `rivals()`, `display()`,
`rivalTo(i, 'retreat' | 'return')`, `displayRocks()`, `birds()`, `birdGoals()`, `vitals`/`setVitals`,
`pause`, `shoreZ`, `onBullStretch`, `depth`.

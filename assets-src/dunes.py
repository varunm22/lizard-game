"""Generate the nesting dunes' props -> src/assets/dunes.glb. Low poly, but irregular the way plants,
wood and rock are, rather than geometric: see docs/dunes.md.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/dunes.py

Same conventions as props.py (Blender space, Z up, exported Y up; each prop stands on z = 0 at the
origin at its real size in metres, coloured per vertex). Objects:

- saltbush_0/1: saltbush (Cryptocarpus pyriformis), the commonest shrub at the back of Galapagos
  beaches: a mound of bright yellow-green leaf clumps over a tangle of grey woody stems that arch
  out from the base, open underneath. Extras `radius` (the canopy's reach), `height` (its top) and
  `rim` (how high its edge stands off the ground): the game hides what's under it from the snakes.
- dune_cactus_0/1: lava cactus clumps; extras `trunk_radius`, `trunk_height` for the collider.
- driftwood_0/1/2: bleached trunks lying along X, root end at -X, underside on z = 0. Extras
  `radius` (root end), `tip` and `length` give the tapered hull the game collides with.
- basalt_0..5: boulders about 1 m across with fracture faces, convex, flat base at
  z = -0.55 * squash (extras `squash`); the game scales and sinks them.
- mangrove: a red mangrove (Rhizophora mangle) at the back of the sandy cove, a stilt of arching
  prop roots under a dark glossy crown. Extras `trunk_radius`, `trunk_height` for its collider.
- eggshell_0/1: the torn, collapsed leathery shell a hatchling leaves in its burrow, ~6 cm long.
- shell_0..3: fragments of shell and coral a few mm across, white to pink, strewn over the sand
  by the thousand.
"""

import math
import os
import random
import sys

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
import bmesh
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import srgb  # noqa: E402
from props import MeshBuilder, clump, frames, leaves, make_object, mix, path, tube  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'dunes.glb')

C = {
    'stem': srgb('#8b8378'),
    'stem_dark': srgb('#5f574d'),
    'leaf': srgb('#9db343'),
    'leaf_light': srgb('#c3cf5e'),
    'leaf_dark': srgb('#62792c'),
    'mangrove_bark': srgb('#6a5a4a'),
    'root': srgb('#8a7562'),
    'mangrove_leaf': srgb('#3f6a2c'),
    'mangrove_light': srgb('#6b9440'),
    'egg': srgb('#ece4cf'),
    'egg_shade': srgb('#cbbf9f'),
    'shell_white': srgb('#f2eee4'),
    'shell_pink': srgb('#e6b9a8'),
    'shell_grey': srgb('#b9b3a8'),
    'cactus_base': srgb('#3e3833'),
    'cactus_old': srgb('#6b6650'),
    'cactus': srgb('#98974e'),
    'cactus_tip': srgb('#e0c768'),
    'cactus_rib': srgb('#5d5a36'),
    'drift': srgb('#b9b2a6'),
    'drift_light': srgb('#e2dccf'),
    'drift_crack': srgb('#7d7469'),
    'basalt': srgb('#4b4744'),
    'basalt_rust': srgb('#5f4c43'),
    'basalt_light': srgb('#6e6964'),
    'sand_dust': srgb('#c9b48a'),
}


def saltbush(rng, radius, height, rim):
    mb = MeshBuilder()
    seed = rng.random() * 50
    wood = lambda co, s: mix(C['stem_dark'], C['stem'], 0.3 + 0.7 * s)
    # The outline isn't round: a few lobes where branches have pushed further out, at random.
    lobes = [(rng.uniform(0.1, 0.22), rng.randint(2, 4), rng.uniform(0, 2 * math.pi)) for _ in range(2)]
    reach = lambda phi: 1 + sum(a * math.sin(k * phi + ph) for a, k, ph in lobes) * 0.6 - 0.06
    # Woody stems: up from the base and out into the canopy, forking, hidden by the leaves but for
    # the bare tangle under the rim.
    for i in range(10):
        a = 2 * math.pi * (i + rng.uniform(-0.4, 0.4)) / 10
        out = Vector((math.cos(a), math.sin(a), 0))
        pts = path(out * 0.012, out * rng.uniform(0.7, 1.2) + Vector((0, 0, 1)), radius * reach(a) * rng.uniform(0.7, 0.85), 6,
                   bend=out * 0.6 - Vector((0, 0, 0.5)), wobble=0.25, rng=rng)
        tube(mb, pts, lambda s: 0.0075 * (1 - 0.65 * s), wood, sides=5, rough=0.2, seed=seed + i)
        for j in (2, 4):
            side = Vector((-out.y, out.x, 0)) * rng.choice((-1, 1))
            twig = path(pts[j], side + out + Vector((0, 0, 0.8)), radius * rng.uniform(0.25, 0.4), 3, wobble=0.3, rng=rng)
            tube(mb, twig, lambda s: 0.003 * (1 - 0.6 * s), wood, sides=4)
    # Leaf clumps heaped into a low lumpy mound, bigger and thicker over the middle, thinning and
    # breaking up toward the rim, which stands clear of the sand so the base is open.

    def leaf(co, hz):
        n = noise.noise(Vector(co) * 9 + Vector((seed, 0, 0))) * 0.5 + 0.5
        dapple = noise.noise(Vector(co) * 45 + Vector((0, seed, 0)))
        c = mix(C['leaf_dark'], C['leaf'], hz * 0.9 + co.z / height * 0.5 - 0.15 + dapple * 0.35)
        return mix(c, C['leaf_light'], max(0.0, n - 0.45) * 1.6 * hz)
    clumps = []
    for k in range(48):
        t = math.sqrt(rng.random()) * 1.4
        phi = rng.uniform(0, 2 * math.pi)
        rr = radius * reach(phi) * rng.uniform(0.82, 1.0)
        z = rim + (height - rim) * max(0.0, math.cos(t)) ** 0.8 * rng.uniform(0.85, 1.0)
        s = rng.uniform(0.055, 0.09) * (1.25 - 0.4 * t / 1.4)
        z = max(z, rim + s * 0.55)
        centre, size = (rr * math.sin(t) * math.cos(phi), rr * math.sin(t) * math.sin(phi), z), (s, s * rng.uniform(0.8, 1.2), s * 0.75)
        clump(mb, centre, size, leaf, rng, detail=2, lump=0.35, crown=(0, 0, rim * 0.5), crown_k=0.5)
        clumps.append((centre, size))
    # A core of leaf over the middle, so the mound reads solid from the side, not as an arch.
    for k in range(8):
        a = rng.uniform(0, 2 * math.pi)
        d = radius * 0.45 * math.sqrt(rng.random())
        s = rng.uniform(0.08, 0.11)
        z = rng.uniform(rim + s * 0.7, rim + (height - rim) * 0.6)
        clump(mb, (math.cos(a) * d, math.sin(a) * d, z), (s, s, s * 0.8), leaf, rng, detail=2, lump=0.35, crown=(0, 0, rim * 0.5), crown_k=0.5)
    leaves(mb, clumps, 260, 0.035, lambda co, r: leaf(co, 0.5 + 0.5 * r), rng, crown=(0, 0, rim * 0.5), lift=0.5)
    return mb


def mangrove(rng):
    mb = MeshBuilder()
    seed = rng.random() * 50

    def bark(co, s):
        n = noise.noise(Vector(co) * 16 + Vector((seed, 0, 0))) * 0.5 + 0.5
        return mix(C['mangrove_bark'], C['root'], 0.15 + 0.6 * n)
    trunk_h = 0.55
    lean = Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 1))
    trunk = path(Vector((0, 0, 0.12)), lean, trunk_h - 0.08, 6, bend=-lean * 0.3 + Vector((0, 0, 0.3)), wobble=0.12, rng=rng)
    tube(mb, trunk, lambda s: 0.03 * (1 - 0.35 * s), bark, sides=7, rough=0.18, seed=seed)

    def root(start, out, r, g):
        """A prop root: out from the stem and arching down into the sand, steeper as it goes."""
        p = Vector(start)
        d = (out + Vector((0, 0, rng.uniform(0.0, 0.5)))).normalized()
        pts = [p.copy()]
        while p.z > -0.02 and len(pts) < 40:
            d = (d + Vector((0, 0, -g)) + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * 0.1).normalized()
            p = p + d * 0.025
            pts.append(p.copy())
        tube(mb, pts, lambda s: r * (1 - 0.3 * s), lambda co, s: mix(C['mangrove_bark'], C['root'], 0.3 + 0.7 * s), sides=5, rough=0.2, seed=seed + p.x)
        return pts
    # Prop roots: from the foot of the trunk and up its length, each its own arc; a few fork where
    # they near the sand.
    n = rng.randint(10, 13)
    for i in range(n):
        a = 2 * math.pi * (i + rng.uniform(-0.4, 0.4)) / n
        out = Vector((math.cos(a), math.sin(a), 0))
        start = trunk[min(int(rng.random() ** 1.5 * 4), 5)] + out * 0.018
        pts = root(start, out, rng.uniform(0.007, 0.011), rng.uniform(0.18, 0.5))
        if len(pts) > 6 and rng.random() < 0.4:
            k = len(pts) - rng.randint(3, 5)
            side = Vector((-out.y, out.x, 0)) * rng.choice((-1, 1))
            root(pts[k], (out + side).normalized(), 0.005, 0.6)

    # Branches: a few limbs at uneven heights and angles, forking twice, each fork shorter. Leaves
    # gather at the ends, so the crown is the shape the branching gives it.
    tips = []
    drops = []

    def grow(start, d, r, length, depth):
        pts = path(start, d, length, 4, bend=Vector((0, 0, 0.35)) - d * 0.2, wobble=0.25, rng=rng)
        tube(mb, pts, lambda s: r * (1 - 0.4 * s), bark, sides=6 if depth < 2 else 4, rough=0.15, seed=seed + depth)
        if depth >= 2:
            tips.append(pts[-1])
            return
        if depth == 0:
            drops.append(pts[2])
        for _ in range(rng.choice((2, 2, 3))):
            a = rng.uniform(0, 2 * math.pi)
            nd = (Vector(d) * 0.9 + Vector((math.cos(a), math.sin(a), rng.uniform(-0.1, 0.5))) * rng.uniform(0.5, 1.0)).normalized()
            grow(pts[rng.randint(2, 4)], nd, r * 0.62, length * rng.uniform(0.5, 0.8), depth + 1)
    limbs = rng.randint(3, 4)
    a0 = rng.uniform(0, 2 * math.pi)
    for i in range(limbs):
        a = a0 + 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / limbs
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.4, 1.0)))
        grow(trunk[rng.randint(3, 6)], d, rng.uniform(0.012, 0.016), rng.uniform(0.22, 0.36), 0)
    grow(trunk[-1], lean.normalized() + Vector((0, 0, 1)), 0.014, 0.2, 1)
    # Aerial roots dropping from the lower limbs.
    for p in drops:
        if rng.random() < 0.7:
            root(p, Vector((rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), -1)), 0.004, 0.3)

    def leaf(co, hz):
        n = noise.noise(Vector(co) * 7 + Vector((seed, 2, 0))) * 0.5 + 0.5
        dapple = noise.noise(Vector(co) * 40 + Vector((0, seed, 0)))
        return mix(C['mangrove_leaf'], C['mangrove_light'], hz * 0.55 + (n - 0.5) * 0.6 + dapple * 0.3)
    crown = sum(tips, Vector()) / len(tips) - Vector((0, 0, 0.08))
    clumps = []
    for p in tips:
        for _ in range(rng.randint(2, 3)):
            off = Vector((rng.uniform(-0.07, 0.07), rng.uniform(-0.07, 0.07), rng.uniform(-0.01, 0.06)))
            s = rng.uniform(0.075, 0.115)
            size = (s, s * rng.uniform(0.8, 1.2), s * rng.uniform(0.7, 0.9))
            clump(mb, p + off, size, leaf, rng, detail=2, lump=0.35, crown=crown, crown_k=0.5)
            clumps.append((p + off, size))
    leaves(mb, clumps, 320, 0.05, lambda co, r: leaf(co, 0.3 + 0.7 * r), rng, crown=crown, lift=0.4)
    return mb, 0.06, trunk_h


def lava_cactus(rng):
    """Lava cactus (Brachycereus nesioticus), the first plant on bare flows: a clump of short ribbed
    columns of every height, the outer ones leaning out and turning up, golden with spines at the
    growing tips, browning to grey-black at the old base."""
    mb = MeshBuilder()
    ribs = 6
    cx, cy = rng.uniform(-0.008, 0.008), rng.uniform(-0.008, 0.008)
    cols = []
    for i in range(rng.randint(13, 17)):
        a = rng.uniform(0, 2 * math.pi)
        d = 0.03 * math.sqrt(rng.random())
        hh = 0.02 + 0.07 * rng.random() ** 1.4 * (1.3 - d / 0.03 * 0.7)
        cols.append((cx + math.cos(a) * d, cy + math.sin(a) * d, a, d, hh, rng.uniform(0.007, 0.011)))
    for x, y, a, d, hh, r in cols:
        out = Vector((math.cos(a), math.sin(a), 0))
        lean = d / 0.03 * rng.uniform(0.3, 0.8)
        pts = path((x, y, -0.005), out * lean + Vector((0, 0, 1)), hh, 4, bend=-out * lean * 0.9, wobble=0.06, rng=rng)
        # Some columns are old, grey to the tip; the young ones are golden with spines up top.
        young = 1.0 if rng.random() < 0.7 else 0.3
        rings = []
        fr = frames(pts)
        k_round = 3  # rings that round over the top
        for i, (p, (t, u, v)) in enumerate(zip(pts, fr)):
            s = i / (len(pts) - 1)
            dome = 1.0 if i < len(pts) - 1 else 0.75
            rings.append((p, t, u, v, r * (1 - 0.15 * s) * dome, s))
        p, t, u, v, rr, _ = rings[-1]
        for j in range(1, k_round):
            q = j / k_round
            rings.append((p + t * rr * 0.6 * math.sin(q * math.pi / 2), t, u, v, rr * math.cos(q * math.pi / 2), 1.0))
        grid = []
        for p, t, u, v, rr, s in rings:
            row = []
            for k in range(ribs * 2):
                ang = math.pi * k / ribs
                groove = k % 2
                co = p + (u * math.cos(ang) + v * math.sin(ang)) * rr * (0.8 if groove else 1.0)
                c = mix(C['cactus_base'], C['cactus_old'], min(1.0, s * 2.0))
                c = mix(c, C['cactus'], (s - 0.6) * 2.5 * young)
                c = mix(c, C['cactus_tip'], (s - 0.85) * 6 * young)
                row.append(mb.vert(co, mix(c, C['cactus_rib'], 0.35) if groove else c))
            grid.append(row)
        n = ribs * 2
        for ra, rb in zip(grid, grid[1:]):
            for k in range(n):
                mb.face(ra[k], ra[(k + 1) % n], rb[(k + 1) % n], rb[k])
        top = mb.vert(rings[-1][0] + rings[-1][1] * rings[-1][4] * 0.5, C['cactus_tip'])
        for k in range(n):
            mb.face(grid[-1][k], grid[-1][(k + 1) % n], top)
    return mb, 0.045, max(c[4] for c in cols)


def driftwood(rng, r_base, r_tip, length):
    """A bleached trunk thrown up on the strand, lying along X with its underside on z = 0: thick at
    the root end (x < 0), where broken roots splay, tapering to a snapped tip, out of round and
    split along the grain, with a stub or two of broken branch. The game's collider is the hull of
    the tapered trunk alone (extras `radius` at the root end, `tip` at the other, `length`)."""
    mb = MeshBuilder()
    sides = 12
    steps = max(8, int(length / 0.05))
    seed = rng.random() * 50
    sweep = rng.uniform(-0.6, 0.6) * r_base

    def wood(co, s):
        n = noise.noise(Vector((co[0] * 4, co[1] * 30, co[2] * 30)) + Vector((seed, 0, 0)))
        c = mix(C['drift'], C['drift_light'], noise.noise(Vector(co) * 6 + Vector((0, seed, 0))) * 0.5 + 0.5)
        return mix(c, C['drift_crack'], (0.15 - n) * 3)
    rad = lambda s: r_base + (r_tip - r_base) * s ** 0.8
    rings = []
    for i in range(steps + 1):
        s = i / steps
        x = (s - 0.5) * length
        r = rad(s)
        y0 = sweep * math.sin(math.pi * s)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * (k + 0.5) / sides
            # Out of round, with grooves along the grain.
            g = 1 + 0.12 * noise.noise(Vector((x * 3, math.cos(a) * 1.5, math.sin(a) * 1.5 + seed))) - 0.07 * max(0.0, noise.noise(Vector((x * 0.8, a * 2.2, seed))))
            co = (x, y0 + math.sin(a) * r * g, max(0.0, r + math.cos(a) * r * g))
            ring.append(mb.vert(co, wood(co, s)))
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for k in range(sides):
            mb.face(ra[k], rb[k], rb[(k + 1) % sides], ra[(k + 1) % sides])
    # Ends: the root end sawn off by the sea into a rounded stump, the tip snapped to a splinter.
    for ring, sign, r in ((rings[0], -1, r_base), (rings[-1], 1, r_tip)):
        x = sign * length / 2
        centre = mb.vert((x + sign * r * (0.3 if sign < 0 else 0.9), 0, r * rng.uniform(0.9, 1.2)), C['drift_light'])
        for k in range(sides):
            k2 = (k + 1) % sides
            mb.face(*((ring[k2], ring[k], centre) if sign > 0 else (ring[k], ring[k2], centre)))
    # Broken roots splaying from the root end, half buried.
    for i in range(rng.randint(4, 6)):
        a = rng.uniform(-0.3, 1.0) * math.pi
        d = Vector((-0.6, math.cos(a), math.sin(a)))
        start = Vector((-length / 2 + r_base * 0.5, d.y * r_base * 0.6, r_base + d.z * r_base * 0.6))
        pts = path(start, d, r_base * rng.uniform(1.4, 2.8), 3, bend=Vector((0, 0, -0.6)), wobble=0.3, rng=rng)
        tube(mb, pts, lambda s, rr=r_base * rng.uniform(0.25, 0.4): rr * (1 - 0.6 * s), wood, sides=5, rough=0.2, seed=seed + i)
    # Stubs of branches, snapped short, on the upper side.
    for i in range(rng.randint(1, 2)):
        s = rng.uniform(0.3, 0.8)
        x = (s - 0.5) * length
        a = rng.choice((-1, 1)) * rng.uniform(0.5, 1.4)
        side = Vector((rng.uniform(0.5, 1.1), math.sin(a), math.cos(a))).normalized()
        r = rad(s)
        c = Vector((x, sweep * math.sin(math.pi * s), r))
        pts = path(c + side * r * 0.6, side, r * rng.uniform(0.8, 2.2), 2, wobble=0.2, rng=rng)
        tube(mb, pts, lambda t, rr=r * rng.uniform(0.35, 0.5): rr * (1 - 0.35 * t), wood, sides=5, rough=0.15, seed=seed + 7 * i)
    return mb


def basalt(rng, squash):
    """A basalt boulder: a lumpy weathered mass with flat fracture faces where pieces have split
    off. Points on a noisy ellipsoid, the ones beyond a few random cutting planes pressed onto
    them, then the convex hull (the game's collider is the hull of the mesh, so this is what you
    stand on). Flat base at z = -0.55 * squash, like props.py's rocks; each face shaded by smooth
    noise so the cut faces read as single planes and the weathered sides as a mottled skin."""
    seed = Vector((rng.random() * 40, rng.random() * 40, 0))
    stretch = (rng.uniform(0.85, 1.15), rng.uniform(0.75, 1.05))
    cuts = []
    for _ in range(rng.randint(3, 6)):
        a = rng.uniform(0, 2 * math.pi)
        n = Vector((math.cos(a), math.sin(a), rng.uniform(-0.2, 1.2))).normalized()
        cuts.append((n, rng.uniform(0.55, 0.85)))
    bm = bmesh.new()
    count = 90
    for i in range(count):
        # A Fibonacci sphere, jittered: evenly spread but not on a lattice.
        z = 1 - 2 * (i + 0.5) / count
        ring = math.sqrt(1 - z * z)
        a = i * 2.39996 + rng.uniform(-0.2, 0.2)
        p = Vector((ring * math.cos(a), ring * math.sin(a), z))
        p *= 1 + 0.2 * noise.noise(p * 1.4 + seed) + 0.06 * noise.noise(p * 4 + seed)
        for nrm, d in cuts:
            over = p.dot(nrm) - d
            if over > 0:
                p -= nrm * over
        bm.verts.new(Vector((p.x * stretch[0], p.y * stretch[1], max(p.z, -0.55) * squash)))
    bmesh.ops.convex_hull(bm, input=list(bm.verts))
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    mb = MeshBuilder()
    for f in bm.faces:
        c = f.calc_center_median()
        n = noise.noise(c * 2.2 + seed) * 0.5 + 0.5
        col = mix(C['basalt'], C['basalt_rust'], (n - 0.6) * 2.5)
        col = mix(col, C['basalt_light'], max(0.0, f.normal.z - 0.6) * 0.8 + rng.uniform(-0.05, 0.08))
        if f.normal.z > 0.85:
            col = mix(col, C['sand_dust'], 0.18)
        mb.face(*[mb.vert(v.co, col) for v in f.verts])
    bm.free()
    return mb


def eggshell(rng):
    """Half a leathery egg, split and slumped: a wrinkled cup with a ragged rim, open side up and over."""
    mb = MeshBuilder()
    L, W = 0.032, 0.02
    rings, sides = 6, 12
    seed = rng.random() * 50
    grid = []
    for i in range(rings + 1):
        t = i / rings * math.pi * 0.55
        row = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            rim = 1.0 if i < rings else 0.85 + 0.3 * rng.random()  # torn edge
            wr = 1 + 0.18 * noise.noise(Vector((i * 0.7, k * 0.6, seed)))
            x = L * math.cos(t) * (1 if i < rings else rim)
            y = W * math.sin(t) * math.cos(a) * wr
            z = W * math.sin(t) * math.sin(a) * wr * 0.55 + W * 0.5
            row.append(mb.vert((x - L * 0.3, y, max(0.0, z)), mix(C['egg_shade'], C['egg'], 0.5 + 0.5 * math.sin(a))))
        grid.append(row)
    tip = mb.vert((L * 0.7 + 0.002, 0, W * 0.5), C['egg'])
    for k in range(sides):
        mb.face(tip, grid[0][(k + 1) % sides], grid[0][k])
    for a, b in zip(grid, grid[1:]):
        for k in range(sides):
            mb.face(a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k])
    # The inside, so the open end isn't see-through.
    inner = [mb.vert(Vector(mb.verts[v]) * 0.94 + Vector((0, 0, 0.0006)), C['egg_shade']) for v in grid[-1]]
    centre = mb.vert(((mb.verts[grid[-1][0]][0]) - 0.004, 0, W * 0.5), C['egg_shade'])
    for k in range(sides):
        mb.face(centre, inner[k], inner[(k + 1) % sides])
    return mb


def shell(rng, colour):
    """A chip of shell or coral, a few mm across: a bent flake."""
    mb = MeshBuilder()
    s = rng.uniform(0.0025, 0.0045)
    pts = []
    n = 5
    for k in range(n):
        a = 2 * math.pi * k / n + rng.uniform(-0.3, 0.3)
        r = s * rng.uniform(0.6, 1.0)
        pts.append((math.cos(a) * r, math.sin(a) * r * 0.7, 0.0008 * math.cos(2 * a)))
    top = [mb.vert(p, colour) for p in pts]
    mid = mb.vert((0, 0, 0.0012), mix(colour, (1, 1, 1), 0.3))
    for k in range(n):
        mb.face(mid, top[k], top[(k + 1) % n])
    bottom = mb.vert((0, 0, -0.0004), colour)
    for k in range(n):
        mb.face(bottom, top[(k + 1) % n], top[k])
    return mb


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(53)
    mat = bpy.data.materials.new('Prop')
    objects = []
    for i, (radius, height) in enumerate(((0.36, 0.4), (0.3, 0.32))):
        objects.append(make_object(f'saltbush_{i}', saltbush(rng, radius, height, 0.075), mat,
                                   extras={'radius': radius + 0.06, 'height': height + 0.05, 'rim': 0.075}))
    mb, r, h = mangrove(rng)
    objects.append(make_object('mangrove', mb, mat, extras={'trunk_radius': r, 'trunk_height': h}))
    for i in range(2):
        objects.append(make_object(f'eggshell_{i}', eggshell(rng), mat))
    # The cactus, driftwood and boulders draw from their own generator.
    nrng = random.Random(71)
    for i in range(2):
        mb, r, h = lava_cactus(nrng)
        objects.append(make_object(f'dune_cactus_{i}', mb, mat, extras={'trunk_radius': r, 'trunk_height': h}))
    for i, (r0, r1, length) in enumerate(((0.05, 0.032, 0.9), (0.035, 0.024, 0.7), (0.085, 0.055, 1.4))):
        objects.append(make_object(f'driftwood_{i}', driftwood(nrng, r0, r1, length), mat, extras={'radius': r0, 'tip': r1, 'length': length}))
    for i, squash in enumerate((0.55, 0.7, 0.8, 0.6, 0.9, 0.5)):
        objects.append(make_object(f'basalt_{i}', basalt(nrng, squash), mat, smooth=False, extras={'squash': squash}))
    for i, col in enumerate(('shell_white', 'shell_pink', 'shell_grey', 'shell_white')):
        objects.append(make_object(f'shell_{i}', shell(rng, C[col]), mat, smooth=False))
    for i, obj in enumerate(objects):
        obj.location.x = i * 1.0  # spread out for inspection in Blender; the game ignores placement

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_materials='EXPORT',
        export_vertex_color='ACTIVE',
        export_texcoords=False,
        export_extras=True,
    )
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

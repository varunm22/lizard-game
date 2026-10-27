"""Generate the Galapagos props: trees, cactus, fallen logs, lava rocks and algae -> src/assets/props.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/props.py

Conventions (Blender space, Z up, exported as Y up): every prop stands on z = 0 at the origin, at
its real size in metres (the lizard is ~0.19 m long), coloured per vertex (COLOR_0), one mesh per
object so the game can fade each placed prop on its own. Objects:

- scalesia_0/1, palo_santo_0/1, opuntia_0/1: trees. Extras `trunk_radius` and `trunk_height` give
  the solid upright cylinder the game uses as each tree's collider.
- lava_cactus: a clump of columns; extras `trunk_radius`, `trunk_height` likewise.
- log_0/1/2: fallen logs lying along X, centred on the origin, the underside touching z = 0. Extras
  `radius` and `length`: the game's collider is a 14-sided prism of that size with a flat face on top,
  the same prism the bark is built round.
- rock_0..5: lava boulders, convex (the game's collider is the hull of the mesh), about 1 m across,
  flat base at z = -0.55 * squash; the game scales and sinks them. Grey, so the game tints them per place.
- algae_green, algae_red: sea lettuce and red turf tufts a few cm across, growing up from the origin.
- fig_tree: the island puzzle's wild fig, ripe figs on its limbs; extras `trunk_radius` and
  `trunk_height` (up to the fork) as for the trees, and `crown_y`, the underside of its leaves.
- slab_0..3: blocky lava slabs for the rock piles, convex, about 2 m across (radius ~1), the top a
  near-flat facet at z = extras `top`, the base at z = extras `bottom`. The game scales them
  unevenly (each slab's top set by the pile's shape, its base pushed down to the ground) and
  stacks them into piles that can be climbed step by step.
"""

import math
import os
import random

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
import bmesh
from mathutils import Vector, noise

from common import srgb

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'props.glb')


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def scale(c, k):
    return tuple(x * k for x in c)


C = {
    'scalesia_bark': srgb('#6d6152'),
    'moss': srgb('#6d8a3a'),
    'lichen': srgb('#c9c7b4'),
    'scalesia_leaf': srgb('#4f7f34'),
    'scalesia_leaf_light': srgb('#7fa84a'),
    'palo_bark': srgb('#bdb7aa'),
    'palo_dark': srgb('#8d887c'),
    'palo_leaf': srgb('#8fae5a'),
    'opuntia_bark': srgb('#8a5a3e'),
    'opuntia_plate': srgb('#b07a52'),
    'pad': srgb('#6c9a45'),
    'pad_light': srgb('#97bf5c'),
    'spine': srgb('#e8dc9a'),
    'log_bark': srgb('#6b5848'),
    'log_grey': srgb('#9a9286'),
    'wood': srgb('#c9a77a'),
    'wood_ring': srgb('#9c7a52'),
    'cactus_base': srgb('#3e3833'),
    'cactus_old': srgb('#6b6650'),
    'cactus': srgb('#98974e'),
    'cactus_tip': srgb('#e0c768'),
    'cactus_rib': srgb('#5d5a36'),
    'rock': srgb('#8e8984'),
    'rock_rust': srgb('#8e7466'),
    'ulva': srgb('#4fa832'),
    'ulva_tip': srgb('#a6e05c'),
    'turf': srgb('#6e2228'),
    'turf_tip': srgb('#c45a48'),
    'fig_bark': srgb('#a39d92'),
    'fig_bark_dark': srgb('#76726a'),
    'fig_leaf': srgb('#2f5f2a'),
    'fig_leaf_light': srgb('#5f8f3c'),
    'fig': srgb('#e0c03a'),
    'fig_green': srgb('#a9b04a'),
}

# Grey lava rock, tinted per place by the game (black by the sea, mossy in the forest).
ROCK = {'base': srgb('#8e8984'), 'rust': srgb('#8e7466'), 'light': srgb('#a8a39d'), 'dust': srgb('#b9b49c')}


class MeshBuilder:
    """Collects vertices, per-vertex colours and faces for one prop mesh."""

    def __init__(self):
        self.verts, self.cols, self.faces = [], [], []
        # Shading normals set by hand, by vertex index; the rest are worked out from the faces.
        self.normals = {}

    def vert(self, co, col):
        self.verts.append(tuple(co))
        self.cols.append(col)
        return len(self.verts) - 1

    def face(self, *idx):
        self.faces.append(idx)


def frames(pts):
    """A normal for each point of a path, carried along it without twisting (parallel transport)."""
    tangents = []
    for i in range(len(pts)):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, len(pts) - 1)]
        tangents.append((b - a).normalized())
    up = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.9 else Vector((1, 0, 0))
    n = tangents[0].cross(up).normalized()
    out = []
    for t in tangents:
        n = (n - t * n.dot(t)).normalized()
        out.append((t, n, t.cross(n)))
    return out


def tube(mb, pts, radius, colour, sides=8, cap=True, phase=0.0, rough=0.0, seed=0.0):
    """A ring of `sides` vertices at each point of `pts`, radius(t) and colour(world point, t) per vertex.
    `rough` pushes each vertex in or out by up to that fraction of the radius, by noise over the
    surface, so a limb is knobbly and out of round rather than a lathed cylinder."""
    pts = [Vector(p) for p in pts]
    rings = []
    n = len(pts) - 1
    for i, (p, (t, a, b)) in enumerate(zip(pts, frames(pts))):
        s = i / n
        r = radius(s)
        ring = []
        for k in range(sides):
            ang = 2 * math.pi * (k + phase) / sides
            off = a * math.cos(ang) + b * math.sin(ang)
            if rough:
                off *= 1 + rough * noise.noise((p + off * r) * (1.2 / max(r, 1e-4)) + Vector((seed, 0, 0)))
            co = p + off * r
            ring.append(mb.vert(co, colour(co, s)))
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for k in range(sides):
            mb.face(ra[k], ra[(k + 1) % sides], rb[(k + 1) % sides], rb[k])
    if cap:
        tip = mb.vert(pts[-1] + (pts[-1] - pts[-2]).normalized() * radius(1.0) * 0.6, colour(pts[-1], 1.0))
        last = rings[-1]
        for k in range(sides):
            mb.face(last[k], last[(k + 1) % sides], tip)
    return rings


def blob(mb, centre, size, colour, rng, detail=1):
    """A lumpy low-poly ellipsoid (a clump of leaves), each face its own flat colour."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=1.0)
    for v in bm.verts:
        d = 1 + 0.25 * noise.noise(v.co * 1.7 + Vector((rng.random() * 9, 0, 0)))
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) * d + Vector(centre)
    for f in bm.faces:
        col = colour(f.calc_center_median(), rng.random())
        ids = [mb.vert(v.co, col) for v in f.verts]
        mb.face(*ids)
    bm.free()


def clump(mb, centre, size, colour, rng, detail=1, lump=0.3, crown=None, crown_k=0.7):
    """A soft, lumpy clump of foliage: an icosphere pushed in and out by noise, its vertices shared
    so it shades smooth. colour(point, height 0..1 within the clump) per vertex. With `crown` (a
    point inside the whole canopy) the shading normals lean that much (`crown_k`) toward pointing
    out from it, so a canopy of many clumps lights as one rounded mass with a single clean shadow
    edge under the two-band toon ramp, and the clumps show by their lumpy outline, not as a heap of
    separately lit balls."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=1.0)
    seed = Vector((rng.random() * 40, rng.random() * 40, rng.random() * 40))
    ids = {}
    for v in bm.verts:
        d = 1 + lump * noise.noise(v.co * 1.3 + seed) + lump * 0.5 * noise.noise(v.co * 2.9 + seed)
        co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) * d + Vector(centre)
        ids[v.index] = mb.vert(co, colour(co, v.co.z * 0.5 + 0.5))
        if crown is not None:
            local = Vector((v.co.x / size[0], v.co.y / size[1], v.co.z / size[2])).normalized()
            mb.normals[ids[v.index]] = local.lerp((co - Vector(crown)).normalized(), crown_k).normalized()
    for f in bm.faces:
        mb.face(*[ids[v.index] for v in f.verts])
    bm.free()


def leaves(mb, clumps, count, length, colour, rng, crown=None, lift=0.5):
    """Single leaves set into the surface of foliage clumps ((centre, size) pairs), lying along it
    like shingles with their tips lifted out by `lift`, so a canopy's skin and edge break up into
    leaves instead of ending smooth: each an oval of six points, `length` long, two-sided (a face
    each way). Shading normals point out from `crown` like the clumps' so they light with the
    mass. colour(point, rand) per leaf."""
    for _ in range(count):
        centre, size = rng.choice(clumps)
        centre = Vector(centre)
        d = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.3, 1))).normalized()
        base = centre + Vector((d.x * size[0], d.y * size[1], d.z * size[2])) * rng.uniform(0.9, 1.05)
        out = (base - Vector(crown if crown is not None else centre)).normalized()
        along = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        along = (along - out * along.dot(out))
        if along.length < 1e-3:
            continue
        axis = (along.normalized() + out * lift).normalized()
        side = axis.cross(out).normalized()
        flat = side.cross(axis)
        L = length * rng.uniform(0.75, 1.25)
        W = L * 0.32
        col = colour(base + axis * L * 0.5, rng.random())
        cup = flat * L * 0.06
        pts = (base, base + axis * L * 0.3 + side * W + cup, base + axis * L * 0.7 + side * W * 0.8 + cup,
               base + axis * L, base + axis * L * 0.7 - side * W * 0.8 + cup, base + axis * L * 0.3 - side * W + cup)
        nrm = out.lerp(Vector((0, 0, 1)), 0.3).normalized()
        for order in (range(6), range(5, -1, -1)):
            ids = [mb.vert(pts[k], col) for k in order]
            for i in ids:
                mb.normals[i] = nrm
            for k in range(1, 5):
                mb.face(ids[0], ids[k], ids[k + 1])


def path(start, direction, length, steps, bend=Vector((0, 0, 0)), wobble=0.0, rng=None):
    """Points along a gently curving branch: `bend` is added to the direction a little more each step."""
    p = Vector(start)
    d = Vector(direction).normalized()
    out = [p.copy()]
    for i in range(steps):
        d = (d + bend / steps + (Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * wobble if rng else Vector())).normalized()
        p = p + d * (length / steps)
        out.append(p.copy())
    return out


def bark(base, accents, freq, seed):
    """Bark colour at a point: the base, mottled with each (colour, amount) accent by noise."""
    def colour(co, s):
        c = base
        for i, (accent, amount, where) in enumerate(accents):
            n = noise.noise(Vector(co) * freq + Vector((seed + 13 * i, 3 * i, 7)))
            c = mix(c, accent, (n * 0.5 + 0.5 - (1 - amount)) * 3 * where(co, s))
        return scale(c, 0.92 + 0.16 * (noise.noise(Vector(co) * freq * 4 + Vector((seed, 1, 2))) * 0.5 + 0.5))
    return colour


def flare(base_r, top_r, flare_k=0.6, flare_h=0.1, height=1.0):
    """Trunk radius at height fraction s: tapering, flaring out into roots at the foot."""
    def radius(s):
        z = s * height
        return base_r + (top_r - base_r) * s + base_r * flare_k * math.exp(-z / flare_h)
    return radius


def scalesia(rng, r0):
    """Tree daisy of the highland forest: a tall mossy trunk, not quite straight, that forks near the
    top into limbs reaching up and out, each ending in a flat-topped spray of leaves, so the crown is
    a broad, uneven umbrella with gaps between the sprays."""
    mb = MeshBuilder()
    seed = rng.random() * 50
    h = rng.uniform(2.1, 2.6)
    lean = Vector((rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), 1))
    trunk = path((0, 0, 0), lean, h * 0.8, 12, bend=-lean * 0.1, rng=rng, wobble=0.04)
    col = bark(C['scalesia_bark'], [(C['moss'], 0.55, lambda co, s: max(0.0, 1 - co[2] / 1.2)), (C['lichen'], 0.25, lambda co, s: 1.0)], 6, seed)
    tube(mb, trunk, flare(r0, r0 * 0.55, 0.7, 0.08, h * 0.8), col, sides=10, rough=0.12, seed=seed)
    tips = []

    def grow(start, d, r, length, depth):
        br = path(start, d, length, 5, bend=Vector((0, 0, 0.3)) - Vector((d.x, d.y, 0)) * 0.3, rng=rng, wobble=0.15)
        tube(mb, br, lambda s: r * (1 - 0.45 * s), col, sides=7 if depth == 0 else 5, rough=0.12, seed=seed + depth)
        if depth >= 1:
            tips.append(br[-1])
            return
        for _ in range(rng.choice((2, 2, 3))):
            a = rng.uniform(0, 2 * math.pi)
            nd = (Vector(d) + Vector((math.cos(a), math.sin(a), rng.uniform(-0.2, 0.3))) * rng.uniform(0.5, 0.9)).normalized()
            grow(br[rng.randint(3, 5)], nd, r * 0.6, length * rng.uniform(0.45, 0.7), depth + 1)
    n = rng.randint(4, 5)
    a0 = rng.uniform(0, 2 * math.pi)
    for i in range(n):
        a = a0 + 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / n
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.7, 1.3)))
        grow(trunk[rng.randint(8, 12)], d, r0 * rng.uniform(0.4, 0.5), rng.uniform(0.45, 0.75), 0)
    crown = sum(tips, Vector()) / len(tips) - Vector((0, 0, 0.35))

    def leaf(co, hz):
        n = noise.noise(Vector(co) * 4 + Vector((seed, 1, 0))) * 0.5 + 0.5
        dapple = noise.noise(Vector(co) * 25 + Vector((0, seed, 0)))
        return mix(C['scalesia_leaf'], C['scalesia_leaf_light'], hz * 0.6 + (n - 0.5) * 0.5 + dapple * 0.25)
    clumps = []
    for p in tips:
        for _ in range(rng.randint(1, 3)):
            off = Vector((rng.uniform(-0.14, 0.14), rng.uniform(-0.14, 0.14), rng.uniform(-0.03, 0.06)))
            sz = rng.uniform(0.16, 0.24)
            size = (sz, sz * rng.uniform(0.8, 1.2), sz * rng.uniform(0.4, 0.55))
            clump(mb, p + off, size, leaf, rng, detail=2, lump=0.3, crown=crown, crown_k=0.5)
            clumps.append((p + off, size))
    leaves(mb, clumps, 90, 0.09, lambda co, r: leaf(co, 0.3 + 0.7 * r), rng, crown=crown, lift=0.3)
    return mb, r0 * 1.25, 1.2


def palo_santo(rng, r0):
    """Palo santo of the dry lowlands: a short silvery trunk forking again and again into crooked,
    upswept branches, nearly bare, with a few small tufts of leaves at the ends."""
    mb = MeshBuilder()
    seed = rng.random() * 50
    trunk_h = rng.uniform(0.7, 1.0)
    col = bark(C['palo_bark'], [(C['palo_dark'], 0.4, lambda co, s: 1.0), (C['lichen'], 0.3, lambda co, s: 1.0)], 9, seed)
    trunk = path((0, 0, 0), (rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), 1), trunk_h, 6, rng=rng, wobble=0.08)
    tube(mb, trunk, flare(r0, r0 * 0.8, 0.5, 0.06, trunk_h), col, sides=9, rough=0.15, seed=seed)
    tufts = []

    def grow(start, direction, radius, length, depth):
        br = path(start, direction, length, 4, bend=Vector((0, 0, 0.5)), rng=rng, wobble=0.22)
        tube(mb, br, lambda s: radius * (1 - 0.45 * s), col, sides=6 if depth < 1 else 4, rough=0.15, seed=seed + depth)
        if depth >= 2 or (depth == 1 and rng.random() < 0.25):
            if rng.random() < 0.55:
                tufts.append(br[-1])
            return
        for _ in range(rng.choice((2, 2, 3))):
            a = rng.uniform(0, 2 * math.pi)
            d = (Vector(direction).normalized() + Vector((math.cos(a), math.sin(a), 0)) * rng.uniform(0.4, 1.0)).normalized()
            grow(br[rng.randint(2, 4)], d, radius * 0.6, length * rng.uniform(0.55, 0.85), depth + 1)

    for i in range(rng.randint(2, 3)):
        a = rng.uniform(0, 2 * math.pi)
        d = Vector((math.cos(a) * 0.6, math.sin(a) * 0.6, 1))
        grow(trunk[rng.randint(4, 6)], d, r0 * 0.65, rng.uniform(0.5, 0.75), 0)
    leaf = lambda c, r: mix(C['palo_leaf'], C['scalesia_leaf_light'], r * 0.6)
    # Each tuft a loose spray of a few small bunches of leaflets, not one solid ball.
    for p in tufts:
        for _ in range(rng.randint(1, 3)):
            sz = rng.uniform(0.035, 0.06)
            off = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0, 1))) * 0.045
            clump(mb, p + off, (sz, sz * rng.uniform(0.7, 1.3), sz * 0.7), leaf, rng, detail=2, lump=0.4)
    return mb, r0 * 1.15, 1.0


def pad(mb, centre, normal_dir, along, size, rng):
    """One flat oval cactus pad with spine dots: a flattened ring of rings, facing `normal_dir`."""
    n = Vector(normal_dir).normalized()
    u = Vector(along).normalized()
    u = (u - n * u.dot(n)).normalized()
    v = n.cross(u)
    w, l, t = size
    # Pads are lopsided, broader on one side and toward one end, never a perfect oval.
    lop = rng.uniform(0.1, 0.3)
    skew = rng.uniform(0, 2 * math.pi)
    rings = 6
    sides = 10
    prev = None
    first = last = None
    for i in range(1, rings):
        s = i / rings
        y = (s - 0.5) * 2
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            rad = math.sqrt(max(0.0, 1 - y * y)) * (1 + lop * math.sin(a + skew) * (0.5 - abs(y)))
            co = Vector(centre) + u * (y * l) + v * (math.cos(a) * w * rad) + n * (math.sin(a) * t * rad)
            dot = (k + i) % 3 == 0 and 0.15 < s < 0.85
            ring.append(mb.vert(co, C['spine'] if dot else mix(C['pad'], C['pad_light'], 0.5 + 0.5 * math.sin(a) + rng.uniform(-0.1, 0.1))))
        if prev:
            for k in range(sides):
                mb.face(prev[k], prev[(k + 1) % sides], ring[(k + 1) % sides], ring[k])
        else:
            first = ring
        prev = ring
    last = prev
    bottom = mb.vert(Vector(centre) - u * l, C['pad'])
    top = mb.vert(Vector(centre) + u * l, C['pad_light'])
    for k in range(sides):
        mb.face(first[(k + 1) % sides], first[k], bottom)
        mb.face(last[k], last[(k + 1) % sides], top)
    return Vector(centre) + u * l * 0.9, u, n


def opuntia(rng, r0):
    """Giant prickly pear: a scaly reddish trunk carrying a crown of jointed flat pads."""
    mb = MeshBuilder()
    h = rng.uniform(0.9, 1.25)
    col = bark(C['opuntia_bark'], [(C['opuntia_plate'], 0.45, lambda co, s: 1.0), (C['palo_dark'], 0.2, lambda co, s: 1.0)], 22, rng.random() * 50)
    trunk = path((0, 0, 0), (rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), 1), h, 8, rng=rng, wobble=0.03)
    tube(mb, trunk, flare(r0, r0 * 0.8, 0.35, 0.05, h), col, sides=9, rough=0.12, seed=rng.random() * 50)

    def chain(base, up, depth):
        for _ in range(rng.randint(1, 2) if depth else rng.randint(4, 6)):
            a = rng.uniform(0, 2 * math.pi)
            along = (Vector(up) * 1.0 + Vector((math.cos(a), math.sin(a), 0)) * rng.uniform(0.4, 1.0)).normalized()
            normal = Vector((-math.sin(a), math.cos(a), rng.uniform(-0.3, 0.3)))
            size = (rng.uniform(0.06, 0.11), rng.uniform(0.09, 0.15), 0.016)
            centre = Vector(base) + along * size[1] * 0.9
            tip, u, _ = pad(mb, centre, normal, along, size, rng)
            if depth < 2:
                chain(tip, (u + Vector((0, 0, 0.6))).normalized(), depth + 1)

    chain(trunk[-1], Vector((0, 0, 1)), 0)
    return mb, r0 * 1.15, 0.9


def lava_cactus(rng, tallest=None):
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
    if tallest:
        k = tallest / max(c[4] for c in cols)
        cols = [(x, y, a, d, hh * k, r) for x, y, a, d, hh, r in cols]
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


def log(rng, radius, length):
    """A fallen trunk along X: out of round and split along the grain, grey weathered bark mossy on
    top, a stub or two of broken branch, the ends snapped off ragged with pale wood showing. Its
    surface stays within a few percent of `radius` so the game's 14-sided prism collider fits it."""
    mb = MeshBuilder()
    sides = 14
    steps = max(6, int(length / 0.05))
    seed = rng.random() * 50
    col = bark(C['log_bark'], [(C['log_grey'], 0.45, lambda co, s: 1.0), (C['moss'], 0.4, lambda co, s: max(0.0, co[2] / radius - 0.9) * 2)], 11, seed)
    rings = []
    for i in range(steps + 1):
        x = (i / steps - 0.5) * length
        ring = []
        for k in range(sides):
            # Angles from straight up, offset half a side so a flat face sits on top.
            a = 2 * math.pi * (k + 0.5) / sides
            ridge = 1 + 0.05 * noise.noise(Vector((x * 4, math.cos(a) * 1.5, math.sin(a) * 1.5 + seed))) - 0.05 * max(0.0, noise.noise(Vector((x * 0.8, a * 2.2, seed))))
            co = (x, math.sin(a) * radius * ridge, max(0.0, radius + math.cos(a) * radius * ridge))
            ring.append(mb.vert(co, col(co, i / steps)))
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for k in range(sides):
            mb.face(ra[k], rb[k], rb[(k + 1) % sides], ra[(k + 1) % sides])
    # Broken ends: pale wood with a darker ring, snapped to a ragged peak.
    for ring, sign in ((rings[0], -1), (rings[-1], 1)):
        inner = []
        for k in range(sides):
            a = 2 * math.pi * (k + 0.5) / sides
            co = (sign * (length / 2 + rng.uniform(-0.004, 0.012)), math.sin(a) * radius * 0.8, radius + math.cos(a) * radius * 0.8)
            inner.append(mb.vert(co, C['wood_ring']))
        centre = mb.vert((sign * (length / 2 + radius * rng.uniform(0.2, 0.7)), radius * rng.uniform(-0.3, 0.3), radius * rng.uniform(0.9, 1.3)), C['wood'])
        for k in range(sides):
            k2 = (k + 1) % sides
            if sign < 0:
                mb.face(ring[k], ring[k2], inner[k2], inner[k])
                mb.face(inner[k], inner[k2], centre)
            else:
                mb.face(ring[k2], ring[k], inner[k], inner[k2])
                mb.face(inner[k2], inner[k], centre)
    # Stubs of branches, snapped short, out of the upper side and leaning toward the top end.
    for i in range(rng.randint(1, 2)):
        x = rng.uniform(-0.3, 0.35) * length
        a = rng.choice((-1, 1)) * rng.uniform(0.5, 1.3)
        side = Vector((rng.uniform(0.4, 1.0), math.sin(a), math.cos(a))).normalized()
        c = Vector((x, 0, radius))
        pts = path(c + side * radius * 0.6, side, radius * rng.uniform(0.8, 1.8), 2, wobble=0.2, rng=rng)
        tube(mb, pts, lambda t, rr=radius * rng.uniform(0.3, 0.45): rr * (1 - 0.35 * t), col, sides=5, rough=0.15, seed=seed + 7 * i)
    return mb


def rock(rng, squash, pal=None):
    """A lava boulder: a lumpy weathered mass with flat fracture faces where pieces have split
    off. Points on a noisy ellipsoid, the ones beyond a few random cutting planes pressed onto
    them, then the convex hull (the game's collider is the hull of the mesh, so this is what you
    stand on). Flat base at z = -0.55 * squash, each face shaded by smooth
    noise so the cut faces read as single planes and the weathered sides as a mottled skin."""
    pal = pal or ROCK
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
        col = mix(pal['base'], pal['rust'], (n - 0.6) * 2.5)
        col = mix(col, pal['light'], max(0.0, f.normal.z - 0.6) * 0.4 + rng.uniform(-0.05, 0.08))
        if f.normal.z > 0.85:
            col = mix(col, pal['dust'], 0.08)
        mb.face(*[mb.vert(v.co, col) for v in f.verts])
    bm.free()
    return mb


def slab(rng, top):
    """A lava slab: the hull of jittered points on a boxy superellipse, cut flat (a touch tilted) at
    the top and the base, so a piled stack of them gives level footing at each step."""
    bm = bmesh.new()
    pts = []
    stretch = rng.uniform(0.8, 1.0)
    tilt = (rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06))
    n = rng.randint(14, 20)
    for k in range(n):
        a = 2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / n
        c, s = math.cos(a), math.sin(a)
        # Superellipse with exponent 4: a rounded square outline, chipped at random.
        rad = (abs(c) ** 4 + abs(s) ** 4) ** -0.25 * rng.uniform(0.82, 1.0) * 0.8
        x, y = rad * c, rad * s * stretch
        for z in (top - rng.uniform(0.0, 0.08), -0.5, top * 0.4 + rng.uniform(-0.1, 0.1)):
            # The rim of each face is pulled in a little so the edges read as worn, not sawn.
            k2 = 1.0 if 0 < z < top * 0.9 else rng.uniform(0.82, 0.92)
            pts.append(Vector((x * k2, y * k2, z + (tilt[0] * x + tilt[1] * y if z > 0 else 0.0))))
    for p in pts:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=list(bm.verts))
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    mb = MeshBuilder()
    for f in bm.faces:
        tone = rng.uniform(0.7, 1.1)
        c = mix(C['rock'], C['rock_rust'], rng.random() ** 4)
        col = scale(c, tone * (1.08 if f.normal.z > 0.8 else 1.0))
        mb.face(*[mb.vert(v.co, col) for v in f.verts])
    bm.free()
    return mb


def ulva(rng):
    """Sea lettuce: a few ruffled translucent-green sheets rising from one holdfast, ~3 cm."""
    mb = MeshBuilder()
    for i in range(5):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / 5
        d = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-d.y, d.x, 0))
        h = rng.uniform(0.018, 0.03)
        w = rng.uniform(0.01, 0.016)
        steps = 5
        rows = []
        for s in range(steps + 1):
            t = s / steps
            centre = d * (0.012 * t + 0.002) + Vector((0, 0, h * math.sin(t * math.pi * 0.5)))
            half = w * 0.5 * math.sin(math.pi * (0.15 + 0.85 * t)) if s < steps else 0.0015
            ruffle = Vector((0, 0, 0.003 * math.sin(t * 9 + i)))
            col = mix(C['ulva'], C['ulva_tip'], t)
            rows.append((mb.vert(centre - side * half + ruffle, col), mb.vert(centre + side * half - ruffle, col)))
        for (a0, a1), (b0, b1) in zip(rows, rows[1:]):
            mb.face(a0, a1, b1, b0)
    return mb


def turf(rng):
    """Red turf algae: a low cushion of short forking strands, ~3 cm across."""
    mb = MeshBuilder()
    for i in range(9):
        a = rng.uniform(0, 2 * math.pi)
        r = 0.012 * math.sqrt(rng.random())
        base = Vector((math.cos(a) * r, math.sin(a) * r, 0))
        h = rng.uniform(0.009, 0.017)
        d = Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), 1))
        pts = path(base, d, h, 2, rng=rng, wobble=0.2)
        colour = lambda co, s: mix(C['turf'], C['turf_tip'], s)
        tube(mb, pts, lambda s: 0.0013 * (1 - 0.5 * s), colour, sides=3)
        fork = path(pts[1], d + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)), h * 0.55, 1, rng=rng)
        tube(mb, fork, lambda s: 0.0009, lambda co, s: mix(C['turf'], C['turf_tip'], 0.6 + 0.4 * s), sides=3)
    return mb


def fig_tree(rng):
    """A wild fig at the forest edge, the puzzle's fig tree: smooth pale grey bark, a short fluted
    trunk on a flare of surface roots snaking out over the ground, forking low into a few thick,
    sinuous limbs that spread wider than the tree is tall, under a dense dome of big dark leathery
    leaves. Ripe yellow figs (and a few green ones) sit in bunches straight on the limbs and twigs
    under the leaves. Returns the mesh, the trunk's radius and height (to the fork) and the height
    of the crown's underside, where figs drop from."""
    mb = MeshBuilder()
    seed = rng.random() * 50
    r0 = 0.07
    fork = rng.uniform(0.38, 0.46)
    col = bark(C['fig_bark'], [(C['fig_bark_dark'], 0.35, lambda co, s: 1.0), (C['lichen'], 0.3, lambda co, s: 1.0), (C['moss'], 0.3, lambda co, s: max(0.0, 1 - co[2] / 0.25))], 7, seed)
    lean = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1))
    trunk = path((0, 0, 0), lean, fork, 7, rng=rng, wobble=0.06)
    # Fluted: a few deep grooves running up the trunk, fading out toward the fork.
    tube(mb, trunk, flare(r0, r0 * 0.85, 0.9, 0.07, fork), col, sides=12, cap=False, rough=0.22, seed=seed)
    # Surface roots: buttresses running out from the foot, tall where they leave the trunk and
    # sinking into the ground within a short way, then showing only as low ridges snaking off.
    n = rng.randint(5, 7)
    a0 = rng.uniform(0, 2 * math.pi)
    for i in range(n):
        a = a0 + 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / n
        d = Vector((math.cos(a), math.sin(a), 0))
        length = rng.uniform(0.18, 0.34)
        rr = r0 * rng.uniform(0.4, 0.55)
        start = Vector((0, 0, rng.uniform(0.07, 0.12))) + d * r0 * 0.5
        root = path(start, d + Vector((0, 0, -0.6)), length, 7, bend=Vector((0, 0, 0.9)) + Vector((-d.y, d.x, 0)) * rng.uniform(-0.7, 0.7), rng=rng, wobble=0.1)
        for k, p in enumerate(root):
            # Never higher than the buttress allows, and half buried beyond it.
            s_ = k / (len(root) - 1)
            p.z = min(p.z, start.z * (1 - s_) ** 2 - rr * 0.45 * s_)
        tube(mb, root, lambda s, rr=rr: rr * (1 - 0.55 * s), col, sides=7, rough=0.2, seed=seed + i)
    tips = []
    twigs = []

    def grow(start, d, r, length, depth):
        br = path(start, d, length, 6, bend=Vector((0, 0, 0.25 - 0.15 * depth)) - Vector((d.x, d.y, 0)) * 0.15, rng=rng, wobble=0.2)
        tube(mb, br, lambda s: r * (1 - 0.4 * s), col, sides=8 if depth == 0 else 5, rough=0.15, seed=seed + depth)
        twigs.append((br, r))
        if depth >= 2 or (depth == 1 and rng.random() < 0.3):
            tips.append(br[-1])
            return
        for _ in range(rng.choice((2, 2, 3))):
            a = rng.uniform(0, 2 * math.pi)
            nd = (Vector(d) + Vector((math.cos(a), math.sin(a), rng.uniform(-0.1, 0.4))) * rng.uniform(0.5, 1.0)).normalized()
            grow(br[rng.randint(3, 6)], nd, r * 0.62, length * rng.uniform(0.5, 0.75), depth + 1)

    # A few thick limbs forking low and spreading out, more out than up.
    n = rng.randint(3, 4)
    a0 = rng.uniform(0, 2 * math.pi)
    for i in range(n):
        a = a0 + 2 * math.pi * (i + rng.uniform(-0.25, 0.25)) / n
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.55, 0.95)))
        grow(trunk[rng.randint(5, 7)], d, r0 * rng.uniform(0.55, 0.7), rng.uniform(0.38, 0.52), 0)
    crown = sum(tips, Vector()) / len(tips) - Vector((0, 0, 0.3))

    def leaf(co, hz):
        n = noise.noise(Vector(co) * 4 + Vector((seed, 2, 0))) * 0.5 + 0.5
        dapple = noise.noise(Vector(co) * 22 + Vector((0, seed, 1)))
        return mix(C['fig_leaf'], C['fig_leaf_light'], hz * 0.55 + (n - 0.5) * 0.5 + dapple * 0.2)
    clumps = []
    for p in tips:
        for _ in range(rng.randint(2, 3)):
            off = Vector((rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), rng.uniform(-0.02, 0.07)))
            sz = rng.uniform(0.14, 0.21)
            size = (sz, sz * rng.uniform(0.8, 1.2), sz * rng.uniform(0.55, 0.75))
            clump(mb, p + off, size, leaf, rng, detail=2, lump=0.3, crown=crown, crown_k=0.7)
            clumps.append((p + off, size))
    # Filling the middle of the dome, so the crown is one dense mass with an uneven skin.
    top = max(p.z for p in tips)
    for _ in range(rng.randint(3, 4)):
        c = crown + Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0))
        c.z = top + rng.uniform(-0.02, 0.06)
        sz = rng.uniform(0.18, 0.24)
        size = (sz, sz * rng.uniform(0.8, 1.2), sz * 0.6)
        clump(mb, c, size, leaf, rng, detail=2, lump=0.3, crown=crown, crown_k=0.7)
        clumps.append((c, size))
    # Big leathery leaves, fewer and broader than the tree daisy's.
    leaves(mb, clumps, 170, 0.085, lambda co, r: leaf(co, 0.25 + 0.75 * r), rng, crown=crown, lift=0.35)
    # Figs in bunches straight on the limbs, mostly ripe, hanging under the leaves.
    fig_r = 0.02
    for br, r in twigs:
        # Only up among the leaves, not on the bare trunk and lower limbs.
        if rng.random() < 0.35 or br[-1].z < crown.z:
            continue
        for _ in range(rng.randint(1, 3)):
            k = rng.randint(1, len(br) - 1)
            t = (br[k] - br[k - 1]).normalized()
            side = t.cross(Vector((0, 0, 1)))
            if side.length < 1e-3:
                side = Vector((1, 0, 0))
            side.normalize()
            ang = rng.uniform(0, 2 * math.pi)
            out = (side * math.cos(ang) + t.cross(side) * math.sin(ang)).normalized()
            out.z = min(out.z, -0.2)
            out.normalize()
            ripe = rng.random() < 0.8
            colour = lambda co, s, ripe=ripe: mix(C['fig'] if ripe else C['fig_green'], C['fig_bark_dark'], max(0.0, s - 0.85) * 3)
            base = br[k] + out * r * 0.9
            body = [base + out * fig_r * f for f in (0.0, 0.4, 1.0, 1.7, 2.2)]
            radii = (0.3, 0.75, 1.0, 0.8, 0.25)
            tube(mb, body, lambda s, radii=radii: fig_r * radii[min(4, round(s * 4))], lambda co, s: colour(co, 1 - s), sides=9)
    return mb, r0 * 1.2, fork, min(p.z for p, _ in clumps) - 0.05


def make_object(name, mb, mat, smooth=True, extras=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(mb.verts, [], mb.faces)
    mesh.update()
    attr = mesh.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(mb.cols):
        attr.data[i].color = (*c, 1.0)
    mesh.color_attributes.active_color = attr
    for poly in mesh.polygons:
        poly.use_smooth = smooth
    if mb.normals:
        mesh.normals_split_custom_set_from_vertices([mb.normals.get(i, v.normal) for i, v in enumerate(mesh.vertices)])
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    for k, v in (extras or {}).items():
        obj[k] = v
    bpy.context.scene.collection.objects.link(obj)
    return obj


# Trunk radii (m) and the cactus's height, kept from the first generation of these models: the game
# spaces everything it scatters by the trunks' colliders, so the island keeps its layout.
TRUNKS = {
    'scalesia': (0.10023434668758852 / 1.25, 0.09943357562829055 / 1.25),
    'palo_santo': (0.07073263624545541 / 1.15, 0.06534037291114314 / 1.15),
    'opuntia': (0.07170845049924561 / 1.15, 0.07101276677988799 / 1.15),
}
CACTUS_HEIGHT = 0.08505426035743524


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(29)
    mat = bpy.data.materials.new('Prop')
    objects = []
    for i in range(2):
        for name, fn in (('scalesia', scalesia), ('palo_santo', palo_santo), ('opuntia', opuntia)):
            mb, r, h = fn(rng, TRUNKS[name][i])
            objects.append(make_object(f'{name}_{i}', mb, mat, extras={'trunk_radius': r, 'trunk_height': h}))
    mb, r, h = lava_cactus(rng, CACTUS_HEIGHT)
    objects.append(make_object('lava_cactus', mb, mat, extras={'trunk_radius': r, 'trunk_height': h}))
    for i, (radius, length) in enumerate(((0.05, 0.9), (0.035, 0.7), (0.085, 1.4))):
        objects.append(make_object(f'log_{i}', log(rng, radius, length), mat, extras={'radius': radius, 'length': length}))
    for i, squash in enumerate((0.55, 0.7, 0.8, 0.6, 0.9, 0.5)):
        objects.append(make_object(f'rock_{i}', rock(rng, squash), mat, smooth=False, extras={'squash': squash}))
    objects.append(make_object('algae_green', ulva(rng), mat))
    objects.append(make_object('algae_red', turf(rng), mat))
    # Slabs draw from their own generator so adding them left every other prop as it was.
    srng = random.Random(31)
    for i, top in enumerate((0.3, 0.35, 0.25, 0.4)):
        objects.append(make_object(f'slab_{i}', slab(srng, top), mat, smooth=False, extras={'top': top, 'bottom': -0.5}))
    # The island puzzle's fig tree, likewise from its own generator.
    mb, r, h, crown_y = fig_tree(random.Random(37))
    objects.append(make_object('fig_tree', mb, mat, extras={'trunk_radius': r, 'trunk_height': h, 'crown_y': crown_y}))
    for i, obj in enumerate(objects):
        obj.location.x = i * 2.0  # spread out for inspection in Blender; the game ignores placement

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

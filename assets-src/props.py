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
    'cactus': srgb('#b4a85e'),
    'cactus_rib': srgb('#8a7f45'),
    'cactus_base': srgb('#5e5040'),
    'rock': srgb('#8e8984'),
    'rock_rust': srgb('#8e7466'),
    'ulva': srgb('#4fa832'),
    'ulva_tip': srgb('#a6e05c'),
    'turf': srgb('#6e2228'),
    'turf_tip': srgb('#c45a48'),
}


class MeshBuilder:
    """Collects vertices, per-vertex colours and faces for one prop mesh."""

    def __init__(self):
        self.verts, self.cols, self.faces = [], [], []

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


def tube(mb, pts, radius, colour, sides=8, cap=True, phase=0.0):
    """A ring of `sides` vertices at each point of `pts`, radius(t) and colour(world point, t) per vertex."""
    pts = [Vector(p) for p in pts]
    rings = []
    n = len(pts) - 1
    for i, (p, (t, a, b)) in enumerate(zip(pts, frames(pts))):
        s = i / n
        r = radius(s)
        ring = []
        for k in range(sides):
            ang = 2 * math.pi * (k + phase) / sides
            co = p + (a * math.cos(ang) + b * math.sin(ang)) * r
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


def scalesia(rng):
    """Tree daisy of the highland forest: a straight mossy trunk and a flat umbrella of leaf clumps."""
    mb = MeshBuilder()
    h = rng.uniform(2.1, 2.6)
    r0 = rng.uniform(0.075, 0.09)
    trunk = path((0, 0, 0), (rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08), 1), h, 12, rng=rng, wobble=0.02)
    col = bark(C['scalesia_bark'], [(C['moss'], 0.55, lambda co, s: max(0.0, 1 - co[2] / 1.2)), (C['lichen'], 0.25, lambda co, s: 1.0)], 6, rng.random() * 50)
    tube(mb, trunk, flare(r0, r0 * 0.5, 0.7, 0.08, h), col, sides=10, cap=False)
    top = trunk[-1]
    n = rng.randint(4, 6)
    for i in range(n):
        a = 2 * math.pi * (i + rng.uniform(-0.25, 0.25)) / n
        start = trunk[int(len(trunk) * rng.uniform(0.72, 0.92))]
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.6, 1.1)))
        length = rng.uniform(0.5, 0.8)
        br = path(start, d, length, 5, bend=Vector((0, 0, 0.6)), rng=rng, wobble=0.04)
        tube(mb, br, lambda s: r0 * 0.4 * (1 - 0.6 * s), col, sides=6)
        end = br[-1]
        for j in range(rng.randint(2, 3)):
            off = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), rng.uniform(-0.03, 0.08)))
            leaf = lambda c, r: mix(C['scalesia_leaf'], C['scalesia_leaf_light'], r * 0.5 + max(0.0, c[2] - end.z) * 3)
            blob(mb, end + off, (rng.uniform(0.28, 0.4), rng.uniform(0.28, 0.4), rng.uniform(0.1, 0.16)), leaf, rng)
    blob(mb, top + Vector((0, 0, 0.1)), (0.35, 0.35, 0.14), lambda c, r: mix(C['scalesia_leaf'], C['scalesia_leaf_light'], r * 0.6), rng)
    return mb, r0 * 1.25, 1.2


def palo_santo(rng):
    """Palo santo of the dry lowlands: silvery bark forking into many upswept, nearly bare branches."""
    mb = MeshBuilder()
    r0 = rng.uniform(0.055, 0.07)
    trunk_h = rng.uniform(0.7, 1.0)
    col = bark(C['palo_bark'], [(C['palo_dark'], 0.4, lambda co, s: 1.0), (C['lichen'], 0.3, lambda co, s: 1.0)], 9, rng.random() * 50)
    trunk = path((0, 0, 0), (rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1), trunk_h, 6, rng=rng, wobble=0.03)
    tube(mb, trunk, flare(r0, r0 * 0.8, 0.5, 0.06, trunk_h), col, sides=9, cap=False)

    def grow(start, direction, radius, length, depth):
        br = path(start, direction, length, 4, bend=Vector((0, 0, 0.5)), rng=rng, wobble=0.08)
        tube(mb, br, lambda s: radius * (1 - 0.45 * s), col, sides=6 if depth < 2 else 4)
        if depth >= 2:
            if rng.random() < 0.6:
                leaf = lambda c, r: mix(C['palo_leaf'], C['scalesia_leaf_light'], r)
                blob(mb, br[-1], (rng.uniform(0.08, 0.14),) * 2 + (0.06,), leaf, rng, detail=1)
            return
        for _ in range(rng.randint(2, 3)):
            a = rng.uniform(0, 2 * math.pi)
            d = (Vector(direction).normalized() + Vector((math.cos(a), math.sin(a), 0)) * rng.uniform(0.5, 0.9)).normalized()
            grow(br[-1], d, radius * 0.6, length * rng.uniform(0.65, 0.85), depth + 1)

    for i in range(rng.randint(2, 3)):
        a = rng.uniform(0, 2 * math.pi)
        d = Vector((math.cos(a) * 0.6, math.sin(a) * 0.6, 1))
        grow(trunk[-1], d, r0 * 0.65, rng.uniform(0.55, 0.75), 0)
    return mb, r0 * 1.15, 1.0


def pad(mb, centre, normal_dir, along, size, rng):
    """One flat oval cactus pad with spine dots: a flattened ring of rings, facing `normal_dir`."""
    n = Vector(normal_dir).normalized()
    u = Vector(along).normalized()
    u = (u - n * u.dot(n)).normalized()
    v = n.cross(u)
    w, l, t = size
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
            rad = math.sqrt(max(0.0, 1 - y * y))
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


def opuntia(rng):
    """Giant prickly pear: a scaly reddish trunk carrying a crown of jointed flat pads."""
    mb = MeshBuilder()
    r0 = rng.uniform(0.06, 0.075)
    h = rng.uniform(0.9, 1.25)
    col = bark(C['opuntia_bark'], [(C['opuntia_plate'], 0.45, lambda co, s: 1.0), (C['palo_dark'], 0.2, lambda co, s: 1.0)], 22, rng.random() * 50)
    trunk = path((0, 0, 0), (rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), 1), h, 8, rng=rng, wobble=0.03)
    tube(mb, trunk, flare(r0, r0 * 0.8, 0.35, 0.05, h), col, sides=9, cap=False)

    def chain(base, up, depth):
        for _ in range(rng.randint(1, 2) if depth else rng.randint(4, 6)):
            a = rng.uniform(0, 2 * math.pi)
            along = (Vector(up) * 1.0 + Vector((math.cos(a), math.sin(a), 0)) * rng.uniform(0.4, 1.0)).normalized()
            normal = Vector((-math.sin(a), math.cos(a), rng.uniform(-0.3, 0.3)))
            size = (rng.uniform(0.07, 0.1), rng.uniform(0.1, 0.14), 0.016)
            centre = Vector(base) + along * size[1] * 0.9
            tip, u, _ = pad(mb, centre, normal, along, size, rng)
            if depth < 2:
                chain(tip, (u + Vector((0, 0, 0.6))).normalized(), depth + 1)

    chain(trunk[-1], Vector((0, 0, 1)), 0)
    return mb, r0 * 1.15, 0.9


def lava_cactus(rng):
    """Lava cactus: a tight clump of short ribbed columns, yellow-green above, browning at the base."""
    mb = MeshBuilder()
    cols = []
    for i in range(rng.randint(6, 9)):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0, 0.03)
        cols.append((math.cos(a) * d, math.sin(a) * d, rng.uniform(0.04, 0.09), rng.uniform(0.009, 0.013)))
    for x, y, hh, r in cols:
        lean = Vector((x, y, 0)) * 1.5
        pts = path((x, y, 0), Vector((0, 0, 1)) + lean, hh, 5)
        # Ribs: alternate vertices round each ring are set in and darker.
        ribs = {'k': 0}

        def colour(co, s):
            ribs['k'] += 1
            top = mix(C['cactus'], C['cactus_rib'], 0.7) if ribs['k'] % 2 else C['cactus']
            return mix(C['cactus_base'], top, s * 2.2)
        tube(mb, pts, lambda s: r * (1 - 0.25 * s * s), colour, sides=10)
    return mb, 0.045, max(c[2] for c in cols)


def log(rng, radius, length):
    """A fallen trunk along X: grey weathered bark mossy on top, pale broken wood at the ends."""
    mb = MeshBuilder()
    sides = 14
    steps = max(6, int(length / 0.06))
    seed = rng.random() * 50
    col = bark(C['log_bark'], [(C['log_grey'], 0.45, lambda co, s: 1.0), (C['moss'], 0.4, lambda co, s: max(0.0, co[2] / radius - 0.9) * 2)], 11, seed)
    rings = []
    for i in range(steps + 1):
        x = (i / steps - 0.5) * length
        ring = []
        for k in range(sides):
            # Angles from straight up, offset half a side so a flat face sits on top.
            a = 2 * math.pi * (k + 0.5) / sides
            ridge = 1 + 0.03 * noise.noise(Vector((x * 9, k * 0.9, seed)))
            co = (x, math.sin(a) * radius * ridge, radius + math.cos(a) * radius * ridge)
            ring.append(mb.vert(co, col(co, i / steps)))
        rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        for k in range(sides):
            mb.face(ra[k], rb[k], rb[(k + 1) % sides], ra[(k + 1) % sides])
    # Broken ends: pale wood with a darker ring, jagged.
    for ring, sign in ((rings[0], -1), (rings[-1], 1)):
        inner = []
        for k in range(sides):
            a = 2 * math.pi * (k + 0.5) / sides
            co = (sign * (length / 2 + rng.uniform(-0.004, 0.01)), math.sin(a) * radius * 0.8, radius + math.cos(a) * radius * 0.8)
            inner.append(mb.vert(co, C['wood_ring']))
        centre = mb.vert((sign * (length / 2 + rng.uniform(0.0, 0.02)), 0, radius), C['wood'])
        for k in range(sides):
            k2 = (k + 1) % sides
            if sign < 0:
                mb.face(ring[k], ring[k2], inner[k2], inner[k])
                mb.face(inner[k], inner[k2], centre)
            else:
                mb.face(ring[k2], ring[k], inner[k], inner[k2])
                mb.face(inner[k2], inner[k], centre)
    return mb


def rock(rng, squash):
    """A lava boulder: the convex hull of jittered points on a squashed ellipsoid, flat-bottomed, each face its own tone."""
    bm = bmesh.new()
    pts = []
    stretch = (rng.uniform(0.85, 1.15), rng.uniform(0.8, 1.1))
    for _ in range(rng.randint(26, 40)):
        while True:
            p = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
            if 0.2 < p.length <= 1:
                break
        p.normalize()
        p *= rng.uniform(0.82, 1.0)
        p = Vector((p.x * stretch[0], p.y * stretch[1], max(p.z, -0.55) * squash))
        pts.append(bm.verts.new(p))
    bmesh.ops.convex_hull(bm, input=pts)
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    mb = MeshBuilder()
    for f in bm.faces:
        tone = rng.uniform(0.75, 1.15)
        c = mix(C['rock'], C['rock_rust'], rng.random() ** 3)
        col = scale(c, tone)
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
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    for k, v in (extras or {}).items():
        obj[k] = v
    bpy.context.scene.collection.objects.link(obj)
    return obj


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(29)
    mat = bpy.data.materials.new('Prop')
    objects = []
    for i in range(2):
        for name, fn in (('scalesia', scalesia), ('palo_santo', palo_santo), ('opuntia', opuntia)):
            mb, r, h = fn(rng)
            objects.append(make_object(f'{name}_{i}', mb, mat, extras={'trunk_radius': r, 'trunk_height': h}))
    mb, r, h = lava_cactus(rng)
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

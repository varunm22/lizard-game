"""Generate the bendy plants: low-poly toon meshes, one object per kind -> src/assets/plants.glb.

The kinds are Galapagos plants: native bunchgrass of the dry lowlands, ferns of the Scalesia forest
floor, Lecocarpus (an endemic shrubby daisy with yellow heads and deeply cut leaves), Darwin's
cotton (an endemic shrub with big cupped yellow flowers and lobed leaves) and Galapagos carpetweed
(Sesuvium edmonstonei, low fleshy mats on the coast that go orange and red in the dry season).

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/plants.py

Conventions (Blender space, Z up, exported as Y up): every plant stands on z = 0 with its stem rising
from the origin, so the game can bend it from the base. Colours are per-vertex (COLOR_0), one mesh
per kind, so the game can draw each kind as a single instanced mesh. Units are metres; the lizard is
~0.19 m long and ~2 cm tall, so grass reaches its back and flowers stand well over its head.
"""

import math
import os
import random

import bpy

from common import srgb

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'plants.glb')


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


C = {
    'grass_base': srgb('#6f8a3e'),
    'grass_tip': srgb('#d9cc8a'),
    'fern_base': srgb('#2f6e3a'),
    'fern_tip': srgb('#7fb85a'),
    'stem': srgb('#5c9a45'),
    'leaf': srgb('#6fae4f'),
    'lecocarpus': srgb('#f6c623'),
    'lecocarpus_eye': srgb('#c9851c'),
    'lecocarpus_leaf': srgb('#5f8f45'),
    'cotton': srgb('#fbe36a'),
    'cotton_eye': srgb('#7a2a34'),
    'cotton_leaf': srgb('#4f8a40'),
    'sesuvium_stem': srgb('#a8452e'),
    'sesuvium_green': srgb('#7fae4a'),
    'sesuvium_red': srgb('#d8582f'),
}


class MeshBuilder:
    """Collects vertices, per-vertex colours and faces for one plant mesh."""

    def __init__(self):
        self.verts, self.cols, self.faces = [], [], []

    def vert(self, co, col):
        self.verts.append(tuple(co))
        self.cols.append(col)
        return len(self.verts) - 1

    def face(self, *idx):
        self.faces.append(idx)


def curve(base, direction, height, lean, steps):
    """Points of a stalk rising `height` from `base`, arching `lean` metres out along `direction` (unit xy)."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        out = lean * t * t
        pts.append((base[0] + direction[0] * out, base[1] + direction[1] * out, base[2] + height * t))
    return pts


def blade(mb, pts, width, col_base, col_tip, side, tip_width=0.0):
    """A flat tapered strip along `pts`, `side` (unit xy) across it; double-sided in the game."""
    rows = []
    n = len(pts) - 1
    for i, p in enumerate(pts):
        t = i / n
        w = (width * (1 - t) + tip_width * t) * 0.5
        col = mix(col_base, col_tip, t)
        if i == n and tip_width == 0.0:
            rows.append((mb.vert(p, col),))
        else:
            rows.append((mb.vert((p[0] - side[0] * w, p[1] - side[1] * w, p[2]), col),
                         mb.vert((p[0] + side[0] * w, p[1] + side[1] * w, p[2]), col)))
    for a, b in zip(rows, rows[1:]):
        if len(b) == 1:
            mb.face(a[0], a[1], b[0])
        else:
            mb.face(a[0], a[1], b[1], b[0])


def tube(mb, pts, r0, r1, col0, col1, sides=5):
    """A thin stalk along `pts`, tapering from r0 to r1."""
    rings = []
    n = len(pts) - 1
    for i, p in enumerate(pts):
        t = i / n
        r = r0 + (r1 - r0) * t
        col = mix(col0, col1, t)
        rings.append([mb.vert((p[0] + r * math.cos(2 * math.pi * k / sides),
                               p[1] + r * math.sin(2 * math.pi * k / sides), p[2]), col) for k in range(sides)])
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            mb.face(a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k])
    return rings


def dome(mb, centre, radius, height, col, sides=8, up=True):
    """A shallow cone cap (flower eye), pointing up or down."""
    tip = mb.vert((centre[0], centre[1], centre[2] + (height if up else -height)), col)
    ring = [mb.vert((centre[0] + radius * math.cos(2 * math.pi * k / sides),
                     centre[1] + radius * math.sin(2 * math.pi * k / sides), centre[2]), col) for k in range(sides)]
    for k in range(sides):
        a, b = ring[k], ring[(k + 1) % sides]
        mb.face(a, b, tip) if up else mb.face(b, a, tip)


def grass(rng):
    """A tuft of blades fanning out from one root, 5-8 cm tall."""
    mb = MeshBuilder()
    count = 9
    for i in range(count):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / count
        d = (math.cos(a), math.sin(a))
        base = (d[0] * 0.004, d[1] * 0.004, 0.0)
        h = rng.uniform(0.05, 0.08)
        pts = curve(base, d, h, h * rng.uniform(0.25, 0.5), 4)
        blade(mb, pts, rng.uniform(0.004, 0.006), C['grass_base'], C['grass_tip'], (-d[1], d[0]))
    return mb


def fern(rng):
    """Fronds arching out from a crown, each a midrib with paired leaflets; about 10 cm tall."""
    mb = MeshBuilder()
    count = 6
    for i in range(count):
        a = 2 * math.pi * (i + rng.uniform(-0.2, 0.2)) / count
        d = (math.cos(a), math.sin(a))
        side = (-d[1], d[0])
        h = rng.uniform(0.08, 0.11)
        steps = 8
        # Rises steeply then droops: lean grows faster than height near the tip.
        pts = []
        for s in range(steps + 1):
            t = s / steps
            out = 0.07 * t
            pts.append((d[0] * out, d[1] * out, h * math.sin(t * math.pi * 0.62) / math.sin(math.pi * 0.62)))
        blade(mb, pts, 0.003, C['fern_base'], C['fern_tip'], side)
        for s in range(1, steps):
            t = s / steps
            p = pts[s]
            length = 0.022 * math.sin(t * math.pi) + 0.004
            col = mix(C['fern_base'], C['fern_tip'], t)
            for sign in (-1, 1):
                tip = (p[0] + (side[0] * sign + d[0] * 0.5) * length,
                       p[1] + (side[1] * sign + d[1] * 0.5) * length,
                       p[2] - 0.004)
                back = (p[0] - d[0] * 0.003, p[1] - d[1] * 0.003, p[2])
                fwd = (p[0] + d[0] * 0.004, p[1] + d[1] * 0.004, p[2])
                mb.face(mb.vert(back, col), mb.vert(tip, col), mb.vert(fwd, col))
    return mb


def cut_leaf(mb, base, d, length, width, lobes, col):
    """A deeply cut (pinnatifid) leaf: a midrib with pointed lobes either side, flat and upward-tilted."""
    side = (-d[1], d[0])
    pts = curve(base, d, length * 0.35, length, lobes + 1)
    blade(mb, pts, 0.0025, col, col, side)
    for i in range(1, lobes + 1):
        t = i / (lobes + 1)
        p = pts[i]
        w = width * (1 - 0.6 * t)
        for sign in (-1, 1):
            tip = (p[0] + (side[0] * sign + d[0] * 0.6) * w, p[1] + (side[1] * sign + d[1] * 0.6) * w, p[2] + 0.002)
            back = (p[0] - d[0] * 0.003, p[1] - d[1] * 0.003, p[2])
            fwd = (p[0] + d[0] * 0.004, p[1] + d[1] * 0.004, p[2])
            mb.face(mb.vert(back, col), mb.vert(tip, col), mb.vert(fwd, col))


def palm_leaf(mb, base, d, length, col):
    """A broad, palmately lobed leaf (three to five pointed lobes from one point) on a short stalk."""
    side = (-d[1], d[0])
    stalk = curve(base, d, length * 0.2, length * 0.35, 2)
    blade(mb, stalk, 0.0015, col, col, side, tip_width=0.0015)
    c = stalk[-1]
    centre = mb.vert(c, col)
    spokes = (-1.3, -0.65, 0.0, 0.65, 1.3)
    tips = []
    for k, a in enumerate(spokes):
        r = length * (0.75 if k in (0, 4) else 1.0 if k == 2 else 0.9)
        ca, sa = math.cos(a), math.sin(a)
        v = (d[0] * ca + side[0] * sa, d[1] * ca + side[1] * sa)
        tips.append(mb.vert((c[0] + v[0] * r, c[1] + v[1] * r, c[2] + r * 0.25), col))
    for k in range(len(spokes) - 1):
        a = (spokes[k] + spokes[k + 1]) / 2
        ca, sa = math.cos(a), math.sin(a)
        v = (d[0] * ca + side[0] * sa, d[1] * ca + side[1] * sa)
        r = length * 0.62
        notch = mb.vert((c[0] + v[0] * r, c[1] + v[1] * r, c[2] + r * 0.25), col)
        mb.face(centre, tips[k], notch)
        mb.face(centre, notch, tips[k + 1])


def flower(rng, height, petal, eye, petals, radius, cup, width, leaf):
    """A single stalk with leaves (`leaf(mb, base, direction)`) and an upward-facing flower head."""
    mb = MeshBuilder()
    lean = rng.uniform(0.006, 0.012)
    pts = curve((0, 0, 0), (1, 0), height, lean, 6)
    tube(mb, pts, 0.0012, 0.0009, C['stem'], C['stem'])
    for a, t in ((0.3, 0.22), (math.pi + 0.5, 0.38), (2.0, 0.55)):
        leaf(mb, (0, 0, height * t), (math.cos(a), math.sin(a)))
    top = pts[-1]
    r = radius
    for k in range(petals):
        a = 2 * math.pi * k / petals
        d = (math.cos(a), math.sin(a))
        s = (-d[1], d[0])
        w = 2 * math.pi * r / petals * width

        def at(out, across):
            # Cupped: the petal rises the further out it reaches.
            return mb.vert((top[0] + d[0] * out + s[0] * across, top[1] + d[1] * out + s[1] * across,
                            top[2] + cup * (out / r) ** 1.5), petal)
        base = at(0.002, 0.0)
        ring = [at(r * 0.55, -w), at(r, -w * 0.55), at(r, w * 0.55), at(r * 0.55, w)]
        mb.face(base, ring[3], ring[2], ring[1])
        mb.face(base, ring[1], ring[0])
    dome(mb, (top[0], top[1], top[2] + 0.001), 0.0045, 0.003, eye)
    dome(mb, (top[0], top[1], top[2] + 0.001), 0.0045, 0.003, C['stem'], up=False)
    return mb


def lecocarpus(rng):
    """Lecocarpus: a yellow daisy head of many narrow rays over a golden disc, on a stalk with cut leaves; ~13 cm."""
    return flower(rng, 0.13, C['lecocarpus'], C['lecocarpus_eye'], 12, 0.015, 0.002, 0.3,
                  lambda mb, base, d: cut_leaf(mb, base, d, 0.032, 0.012, 4, C['lecocarpus_leaf']))


def cotton(rng):
    """Darwin's cotton: five broad yellow petals cupped round a dark eye, on a stalk with lobed leaves; ~16 cm."""
    return flower(rng, 0.16, C['cotton'], C['cotton_eye'], 5, 0.02, 0.012, 0.55,
                  lambda mb, base, d: palm_leaf(mb, base, d, 0.024, C['cotton_leaf']))


def pod(mb, a, b, r, col0, col1, sides=3):
    """A fat succulent leaf from `a` to `b`: thin at the base, widest just past halfway, to a blunt point."""
    def ring(p, rad, col):
        return [mb.vert((p[0] + rad * math.cos(2 * math.pi * k / sides + 0.4),
                         p[1] + rad * math.sin(2 * math.pi * k / sides + 0.4), p[2]), col) for k in range(sides)]
    mid = tuple(a[i] + (b[i] - a[i]) * 0.6 for i in range(3))
    r0, r1 = ring(a, r * 0.35, col0), ring(mid, r, mix(col0, col1, 0.6))
    tip = mb.vert(b, col1)
    for k in range(sides):
        mb.face(r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k])
        mb.face(r1[k], r1[(k + 1) % sides], tip)


def sesuvium(rng):
    """Galapagos carpetweed: a low mat of sprawling fleshy stems crowded with fat leaves, green going orange-red; ~3 cm."""
    mb = MeshBuilder()
    count = 6
    for i in range(count):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / count
        d = (math.cos(a), math.sin(a))
        side = (-d[1], d[0])
        h = rng.uniform(0.018, 0.028)
        pts = curve((d[0] * 0.003, d[1] * 0.003, 0.0), d, h, rng.uniform(0.025, 0.035), 3)
        tube(mb, pts, 0.0016, 0.001, C['sesuvium_stem'], C['sesuvium_stem'], sides=3)
        red = rng.uniform(0.2, 1.0)
        for s in range(1, 4):
            t = s / 3
            p = pts[s]
            length = 0.016 * (1.1 - 0.3 * t)
            col0 = C['sesuvium_green']
            col1 = mix(C['sesuvium_green'], C['sesuvium_red'], min(1.0, red * (0.4 + t)))
            for sign in (-1, 1):
                tip = (p[0] + (side[0] * sign * 0.8 + d[0] * 0.6) * length,
                       p[1] + (side[1] * sign * 0.8 + d[1] * 0.6) * length,
                       p[2] + length * 0.6)
                pod(mb, p, tip, 0.0035, col0, col1)
    return mb


def make_object(name, mb, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(mb.verts, [], mb.faces)
    mesh.update()
    attr = mesh.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(mb.cols):
        attr.data[i].color = (*c, 1.0)
    mesh.color_attributes.active_color = attr
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(11)
    mat = bpy.data.materials.new('Plant')
    kinds = {
        'grass': grass(rng),
        'fern': fern(rng),
        'lecocarpus': lecocarpus(rng),
        'cotton': cotton(rng),
        'sesuvium': sesuvium(rng),
    }
    for i, (name, mb) in enumerate(kinds.items()):
        obj = make_object(name, mb, mat)
        obj.location.x = i * 0.3  # spread out for inspection in Blender; the game ignores placement

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
    )
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

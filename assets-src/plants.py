"""Generate the bendy plants: low-poly toon meshes, one object per kind -> src/assets/plants.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/plants.py

Conventions (Blender space, Z up, exported as Y up): every plant stands on z = 0 with its stem rising
from the origin, so the game can bend it from the base. Colours are per-vertex (COLOR_0), one mesh
per kind, so the game can draw each kind as a single instanced mesh. Units are metres; the lizard is
~0.15 m long and ~2 cm tall, so grass reaches its back and flowers stand well over its head.
"""

import math
import os
import random

import bpy

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'plants.glb')


def srgb(hex_colour):
    """'#rrggbb' as linear RGB, which is what glTF vertex colours are."""
    return tuple(((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5))


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


C = {
    'grass_base': srgb('#4f8a3c'),
    'grass_tip': srgb('#b7d66a'),
    'fern_base': srgb('#2f6e3a'),
    'fern_tip': srgb('#7fb85a'),
    'stem': srgb('#5c9a45'),
    'leaf': srgb('#6fae4f'),
    'daisy': srgb('#fbf6ea'),
    'daisy_eye': srgb('#f2b632'),
    'poppy': srgb('#ec6a3c'),
    'poppy_eye': srgb('#3a2a24'),
    'reed_base': srgb('#5b8f4a'),
    'reed_tip': srgb('#a9c46c'),
    'cattail': srgb('#7a4b2c'),
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


def flower(rng, petal, eye, petals, height):
    """A single stalk with two leaves and an upward-facing flower head."""
    mb = MeshBuilder()
    lean = rng.uniform(0.006, 0.012)
    pts = curve((0, 0, 0), (1, 0), height, lean, 6)
    tube(mb, pts, 0.0012, 0.0009, C['stem'], C['stem'])
    for a, t in ((0.3, 0.22), (math.pi + 0.5, 0.38)):
        d = (math.cos(a), math.sin(a))
        z = height * t
        leaf_pts = curve((0, 0, z), d, height * 0.25, 0.03, 4)
        blade(mb, leaf_pts, 0.007, C['leaf'], C['leaf'], (-d[1], d[0]))
    top = pts[-1]
    r = 0.016 if petals > 6 else 0.019
    cup = 0.003 if petals > 6 else 0.009
    for k in range(petals):
        a = 2 * math.pi * k / petals
        d = (math.cos(a), math.sin(a))
        s = (-d[1], d[0])
        w = 2 * math.pi * r / petals * 0.6
        base = mb.vert((top[0] + d[0] * 0.002, top[1] + d[1] * 0.002, top[2]), petal)
        l = mb.vert((top[0] + d[0] * r * 0.6 - s[0] * w, top[1] + d[1] * r * 0.6 - s[1] * w, top[2] + cup * 0.5), petal)
        tip = mb.vert((top[0] + d[0] * r, top[1] + d[1] * r, top[2] + cup), petal)
        rr = mb.vert((top[0] + d[0] * r * 0.6 + s[0] * w, top[1] + d[1] * r * 0.6 + s[1] * w, top[2] + cup * 0.5), petal)
        mb.face(base, rr, tip, l)
    dome(mb, (top[0], top[1], top[2] + 0.001), 0.0045, 0.003, eye)
    dome(mb, (top[0], top[1], top[2] + 0.001), 0.0045, 0.003, C['stem'], up=False)
    return mb


def reed(rng):
    """A clump of long leaves around a cattail stalk; stands at the pond's edge, about 25 cm tall."""
    mb = MeshBuilder()
    for i in range(5):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / 5
        d = (math.cos(a), math.sin(a))
        h = rng.uniform(0.16, 0.24)
        pts = curve((d[0] * 0.003, d[1] * 0.003, 0), d, h, h * rng.uniform(0.2, 0.35), 6)
        blade(mb, pts, 0.007, C['reed_base'], C['reed_tip'], (-d[1], d[0]))
    stalk = curve((0, 0, 0), (1, 0), 0.26, 0.01, 6)
    tube(mb, stalk, 0.0015, 0.001, C['reed_base'], C['reed_base'])
    head = curve(stalk[-2], (1, 0), 0.03, 0.002, 2)
    head = [(p[0], p[1], p[2] + 0.002) for p in head]
    rings = tube(mb, head, 0.004, 0.004, C['cattail'], C['cattail'], sides=6)
    dome(mb, head[-1], 0.004, 0.003, C['cattail'], sides=6)
    dome(mb, head[0], 0.004, 0.002, C['cattail'], sides=6, up=False)
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
        'daisy': flower(rng, C['daisy'], C['daisy_eye'], 9, 0.13),
        'poppy': flower(rng, C['poppy'], C['poppy_eye'], 5, 0.16),
        'reed': reed(rng),
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

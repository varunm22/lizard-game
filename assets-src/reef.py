"""Generate the reef life under the sea: Galapagos corals and fish -> src/assets/reef.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/reef.py

Same conventions as props.py (Z up in Blender, exported Y up, real size in metres at the game's
scale, where the marine iguana is ~0.19 m long, so roughly a fifth of life size; coloured per
vertex). Objects:

- coral_cauliflower: Pocillopora, the main reef builder in the Galapagos, a rounded bush of short
  blunt branches ~8 cm across, standing on the origin.
- coral_lobe: Porites lobata, a lumpy yellow-brown dome ~10 cm across, its base a little below z = 0
  so it beds into the sea floor.
- sea_fan: Pacifigorgia, a flat fan of fine branches ~9 cm tall in the XZ plane, painted pale so the
  game can tint each one (purple, orange, yellow).
- sun_coral: Tubastraea, a clump of orange cups ~3 cm across.
- urchin: the pencil urchin, a dark red ball with a dozen thick blunt spines, ~3 cm across.
- fish_salema, fish_sergeant, fish_surgeon, fish_angel: black-striped salema, Panamic sergeant
  major, yellowtail surgeonfish and king angelfish. Each faces -Y (+Z in glTF) with its snout at
  extras `length` / 2 and its tail at -length / 2, centred on the origin, body and fins as one mesh.
  Fins are single sheets, so the game draws fish double-sided. The game bends the body side to side
  as it swims, more toward the tail.
"""

import math
import os
import random

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
import bmesh
from mathutils import Vector, noise

from common import srgb
from props import MeshBuilder, make_object, mix, path, scale, tube

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'reef.glb')

C = {
    'pocillopora': srgb('#9a6e52'),
    'pocillopora_tip': srgb('#e2b79a'),
    'porites': srgb('#9a8a3c'),
    'porites_light': srgb('#c9b65e'),
    'porites_green': srgb('#7c8a48'),
    'fan': srgb('#e6dcd8'),
    'fan_base': srgb('#b8aca8'),
    'tubastraea': srgb('#e0601a'),
    'tubastraea_rim': srgb('#ff9a2a'),
    'polyp': srgb('#ffd04a'),
    'urchin': srgb('#5a1e1a'),
    'spine': srgb('#6e3e30'),
    'spine_band': srgb('#a87a62'),
    'eye': srgb('#101010'),
    'eye_ring': srgb('#d8d0b0'),
}


def coral_cauliflower(rng):
    """Pocillopora: a dome of short forking branches with knobbly, blunt tips."""
    mb = MeshBuilder()
    colour = lambda co, s: mix(C['pocillopora'], C['pocillopora_tip'], 0.15 + 0.85 * s ** 1.5)

    def branch(start, d, length, depth):
        pts = path(start, d, length, 3, rng=rng, wobble=0.15)
        r0 = 0.0042 if depth == 0 else 0.0032
        tube(mb, pts, lambda s: r0 * (1 - 0.25 * s), colour, sides=5)
        if depth < 2:
            for k in range(2):
                a = rng.uniform(0, 2 * math.pi)
                nd = (d.normalized() + Vector((math.cos(a), math.sin(a), 0)) * 0.7).normalized()
                branch(pts[-1], nd, length * rng.uniform(0.55, 0.75), depth + 1)

    for i in range(13):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / 13
        lean = rng.uniform(0.35, 0.9)
        d = Vector((math.cos(a) * lean, math.sin(a) * lean, 1)).normalized()
        branch(Vector((math.cos(a) * 0.006, math.sin(a) * 0.006, -0.002)), d, rng.uniform(0.016, 0.022), 0)
    return mb


def coral_lobe(rng):
    """Porites: a squat lumpy dome, mottled yellow-brown and olive, flat shaded."""
    mb = MeshBuilder()
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    seed = Vector((rng.random() * 9, rng.random() * 9, 0))
    for v in bm.verts:
        d = 1 + 0.22 * noise.noise(v.co * 2.2 + seed) + 0.08 * noise.noise(v.co * 6 + seed)
        v.co = Vector((v.co.x * 0.05, v.co.y * 0.045, max(v.co.z, -0.4) * 0.04)) * d
    for f in bm.faces:
        c = f.calc_center_median()
        n = noise.noise(c * 60 + seed) * 0.5 + 0.5
        col = mix(mix(C['porites'], C['porites_green'], n), C['porites_light'], max(0.0, f.normal.z) * 0.5)
        mb.face(*[mb.vert(v.co, col) for v in f.verts])
    bm.free()
    return mb


def sea_fan(rng):
    """Pacifigorgia: a flat fan of branches that fork and spread, standing in the XZ plane."""
    mb = MeshBuilder()
    colour = lambda co, s: mix(C['fan_base'], C['fan'], min(1.0, co.z / 0.03))

    def branch(start, a, length, r, depth):
        d = Vector((math.sin(a), rng.uniform(-0.05, 0.05), math.cos(a)))
        pts = path(start, d, length, 3, rng=rng, wobble=0.08)
        pts = [Vector((p.x, p.y * 0.3, p.z)) for p in pts]
        tube(mb, pts, lambda s: r * (1 - 0.3 * s), colour, sides=3)
        if depth < 5:
            spread = rng.uniform(0.3, 0.5) * (1.6 if depth == 0 else 1)
            for k in (-1, 1):
                branch(pts[-1], a + k * spread + rng.uniform(-0.1, 0.1), length * rng.uniform(0.68, 0.8), r * 0.75, depth + 1)

    branch(Vector((0, 0, -0.003)), rng.uniform(-0.1, 0.1), 0.02, 0.0024, 0)
    # The fine meshwork between the branches, drawn as one ruffled sheet across the fan.
    rows = 6
    cols = 16
    grid = []
    for i in range(rows + 1):
        t = 0.12 + 0.88 * i / rows
        row = []
        for j in range(cols + 1):
            a = (j / cols - 0.5) * 4.6
            edge = 1 - 0.1 * abs(math.sin(j * 1.7)) * t
            co = Vector((math.sin(a) * 0.038 * t * edge, 0.0012 * math.sin(i * 2.1 + j * 1.3), 0.05 + math.cos(a) * 0.034 * t * edge))
            row.append(mb.vert(co, scale(mix(C['fan_base'], C['fan'], t), 0.8 + 0.08 * math.sin(i * 3 + j))))
        grid.append(row)
    for ra, rb in zip(grid, grid[1:]):
        for j in range(cols):
            mb.face(ra[j], ra[j + 1], rb[j + 1], rb[j])
    return mb


def sun_coral(rng):
    """Tubastraea: a clump of short orange tubes, each a cup with a yellow polyp disc in it."""
    mb = MeshBuilder()
    for i in range(9):
        a = rng.uniform(0, 2 * math.pi)
        r = 0.009 * math.sqrt(rng.random())
        base = Vector((math.cos(a) * r, math.sin(a) * r, -0.002))
        d = Vector((math.cos(a) * r * 40, math.sin(a) * r * 40, 1)).normalized()
        h = rng.uniform(0.006, 0.012)
        top = base + d * h
        cup = rng.uniform(0.0028, 0.0038)
        rings = tube(mb, [base, base + d * h * 0.5, top], lambda s: cup * (0.8 + 0.2 * s), lambda co, s: mix(C['tubastraea'], C['tubastraea_rim'], s), sides=7, cap=False)
        # The polyp: a low cone of yellow inside the rim.
        tip = mb.vert(top + d * cup * 0.35, C['polyp'])
        last = rings[-1]
        for k in range(len(last)):
            mb.face(last[k], last[(k + 1) % len(last)], tip)
    return mb


def urchin(rng):
    """Pencil urchin: a dark red test bristling with a dozen thick, banded, blunt spines."""
    mb = MeshBuilder()
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.006)
    for v in bm.verts:
        v.co.z = v.co.z * 0.75 + 0.0045
    for f in bm.faces:
        mb.face(*[mb.vert(v.co, scale(C['urchin'], 0.85 + 0.3 * rng.random())) for v in f.verts])
    bm.free()
    centre = Vector((0, 0, 0.0045))
    for i in range(13):
        # Spread over the upper part of the ball by a golden-angle spiral.
        z = 1 - (i + 0.5) / 13 * 1.25
        a = i * 2.39996
        rr = math.sqrt(max(0.0, 1 - z * z))
        d = Vector((math.cos(a) * rr, math.sin(a) * rr, z)).normalized()
        length = rng.uniform(0.009, 0.013)
        pts = [centre + d * (0.004 + length * t) for t in (0, 0.33, 0.66, 1)]
        band = lambda co, s: C['spine_band'] if int(s * 5) % 2 else C['spine']
        tube(mb, pts, lambda s: 0.0016 * (1 - 0.2 * s), band, sides=5)
    return mb


# Fish ------------------------------------------------------------------------------------------

# Body shape along its length, u from the snout (0) to where the tail fin starts (1): half-height
# and half-width as a share of the fish's length, and how far the centreline sits above the snout.
BODY = [
    (0.0, 0.03, 0.02),
    (0.06, 0.14, 0.08),
    (0.18, 0.26, 0.12),
    (0.35, 0.3, 0.12),
    (0.55, 0.26, 0.1),
    (0.78, 0.14, 0.06),
    (0.95, 0.07, 0.03),
    (1.0, 0.075, 0.025),
]


def table(rows, u, col):
    for a, b in zip(rows, rows[1:]):
        if u <= b[0]:
            t = (u - a[0]) / (b[0] - a[0])
            return a[col] + (b[col] - a[col]) * t
    return rows[-1][col]


def fish(spec):
    """A laterally flattened fish: lofted body, forked or fan tail, dorsal, anal and pectoral fins, eyes."""
    mb = MeshBuilder()
    L = spec['length']
    body = 0.8 * L  # snout to the base of the tail fin
    deep = spec['deep']
    sides = 16
    rings = []
    steps = 16
    # u runs from the snout at -Y (+Z in glTF) back toward the tail.
    y_of = lambda u: -L / 2 + u * body
    for i in range(steps + 1):
        u = i / steps
        h = table(BODY, u, 1) * L * deep
        w = table(BODY, u, 2) * L * spec.get('wide', 1.0)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            v = math.cos(a)  # 1 on the back, -1 on the belly
            co = Vector((math.sin(a) * w, y_of(u), v * h))
            ring.append(mb.vert(co, spec['colour'](u, v)))
        rings.append(ring)
    snout = mb.vert(Vector((0, -L / 2 - 0.004 * L, -0.02 * L)), spec['colour'](0.0, 0.0))
    for k in range(sides):
        mb.face(snout, rings[0][(k + 1) % sides], rings[0][k])
    for ra, rb in zip(rings, rings[1:]):
        for k in range(sides):
            mb.face(ra[k], ra[(k + 1) % sides], rb[(k + 1) % sides], rb[k])
    end = mb.vert(Vector((0, y_of(1.0) + 0.01 * L, 0)), spec['colour'](1.0, 0.0))
    for k in range(sides):
        mb.face(rings[-1][k], rings[-1][(k + 1) % sides], end)

    def sheet(outline, colour):
        """A flat fin in the body's mid-plane (x = 0) from a list of (y, z) rows of (base, edge) pairs."""
        prev = None
        for (y0, z0), (y1, z1), t in outline:
            pair = (mb.vert(Vector((0, y0, z0)), colour(t, 0)), mb.vert(Vector((0, y1, z1)), colour(t, 1)))
            if prev:
                mb.face(prev[0], prev[1], pair[1], pair[0])
            prev = pair

    # Dorsal and anal fins: along the back and belly, their height from the spec.
    for which, (u0, u1, height) in (('dorsal', spec['dorsal']), ('anal', spec['anal'])):
        sign = 1 if which == 'dorsal' else -1
        rows = []
        for j in range(7):
            t = j / 6
            u = u0 + (u1 - u0) * t
            h = table(BODY, u, 1) * L * deep * 0.92
            fin = height * L * math.sin(math.pi * (0.15 + 0.85 * t)) ** 0.6 * (0.6 + 0.4 * t)
            rows.append(((y_of(u), sign * h), (y_of(u) + fin * 0.35, sign * (h + fin)), t))
        sheet(rows, spec['fin'])
    # Tail fin: forked (`fork` > 0) or nearly square.
    root = y_of(0.97)
    span = spec['tail'] * L
    reach = 0.2 * L
    rows = []
    for j in range(9):
        t = j / 8
        z = (t * 2 - 1)
        notch = spec['fork'] * (1 - abs(z)) ** 1.2
        rows.append(((root, z * 0.06 * L), (root + reach * (1 - notch) * (0.85 + 0.15 * abs(z)), z * span), abs(z)))
    sheet(rows, spec['tail_colour'])
    # Pectoral fins: small paddles behind the gills, angled back along each flank.
    for side in (-1, 1):
        u = 0.27
        w = table(BODY, u, 2) * L * spec.get('wide', 1.0)
        base = Vector((side * w * 0.9, y_of(u), -0.02 * L))
        a = mb.vert(base, spec['pectoral'](0))
        b = mb.vert(base + Vector((0, 0, 0.06 * L)), spec['pectoral'](0))
        c = mb.vert(base + Vector((side * 0.05 * L, 0.13 * L, 0.03 * L)), spec['pectoral'](1))
        d = mb.vert(base + Vector((side * 0.04 * L, 0.11 * L, -0.03 * L)), spec['pectoral'](1))
        mb.face(a, b, c, d)
    # Eyes: a dark ball in a pale ring, either side of the head.
    for side in (-1, 1):
        u = 0.1
        w = table(BODY, u, 2) * L * spec.get('wide', 1.0)
        centre = Vector((side * w * 0.8, y_of(u), 0.06 * L * deep / 1.0))
        for radius, col, out in ((0.045 * L, C['eye_ring'], 0.0), (0.03 * L, C['eye'], 0.012 * L)):
            bm = bmesh.new()
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius)
            for v in bm.verts:
                v.co.x *= 0.5
            for f in bm.faces:
                mb.face(*[mb.vert(v.co + centre + Vector((side * out, 0, 0)), col) for v in f.verts])
            bm.free()
    return mb


def bars(u, centres, width):
    return any(abs(u - c) < width for c in centres)


def salema(u, v):
    """Black-striped salema: silver, darker blue-grey back, black stripes along the flank."""
    base = mix(srgb('#c8d4dc'), srgb('#6f8494'), max(0.0, v) ** 0.8)
    if abs(v - 0.71) < 0.05 or abs(v) < 0.05:
        return srgb('#22282e')
    return base


def sergeant(u, v):
    """Panamic sergeant major: yellow back, pale silver-blue flanks, five black bars."""
    base = mix(srgb('#dfe6e8'), srgb('#e2c23a'), max(0.0, (v - 0.2) / 0.8) ** 0.7)
    if v > -0.55 and bars(u, (0.2, 0.36, 0.52, 0.68, 0.84), 0.045):
        return srgb('#1b2024')
    return base


def surgeon(u, v):
    """Yellowtail surgeonfish: slate grey, a darker face, a row of black scalpel spots by the tail."""
    base = mix(srgb('#3f4852'), srgb('#5f6a76'), (v + 1) / 2)
    if u < 0.2:
        base = scale(base, 0.75)
    if 0.84 < u < 0.95 and abs(v) < 0.4:
        return srgb('#121518')
    return base


def angel(u, v):
    """King angelfish: deep navy-brown, one white bar behind the head, a paler orange face."""
    base = mix(srgb('#1d2440'), srgb('#2c3a62'), (v + 1) / 2)
    if abs(u - 0.32) < 0.035:
        return srgb('#f2f2ee')
    if u < 0.12:
        return mix(srgb('#7a4a2a'), base, u / 0.12)
    return base


SPECIES = {
    'fish_salema': dict(
        length=0.035, deep=0.7, wide=1.0, colour=salema, dorsal=(0.3, 0.75, 0.12), anal=(0.6, 0.8, 0.08),
        tail=0.2, fork=0.8,
        fin=lambda t, e: mix(srgb('#7c8a96'), srgb('#c8d0d6'), e), tail_colour=lambda t, e: srgb('#9aa6b0'),
        pectoral=lambda e: srgb('#c8d0d6'),
    ),
    'fish_sergeant': dict(
        length=0.04, deep=1.05, colour=sergeant, dorsal=(0.22, 0.85, 0.12), anal=(0.58, 0.88, 0.1),
        tail=0.22, fork=0.6,
        fin=lambda t, e: mix(srgb('#c9b44a'), srgb('#e9e0b0'), e), tail_colour=lambda t, e: mix(srgb('#c8c4a0'), srgb('#e6e2c6'), t),
        pectoral=lambda e: srgb('#e9e0b0'),
    ),
    'fish_surgeon': dict(
        length=0.075, deep=0.95, colour=surgeon, dorsal=(0.18, 0.92, 0.1), anal=(0.45, 0.92, 0.1),
        tail=0.26, fork=0.45,
        fin=lambda t, e: mix(srgb('#3a424c'), srgb('#56606c'), e), tail_colour=lambda t, e: mix(srgb('#e7b51a'), srgb('#ffd447'), t),
        pectoral=lambda e: srgb('#4c5662'),
    ),
    'fish_angel': dict(
        length=0.06, deep=1.45, colour=angel, dorsal=(0.3, 0.98, 0.26), anal=(0.45, 0.98, 0.24),
        tail=0.22, fork=0.0,
        fin=lambda t, e: mix(srgb('#1d2440'), srgb('#5aa0f0'), e ** 3), tail_colour=lambda t, e: mix(srgb('#f0b020'), srgb('#ffe070'), e),
        pectoral=lambda e: srgb('#f2c832'),
    ),
}


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(61)
    mat = bpy.data.materials.new('Reef')
    objects = [
        make_object('coral_cauliflower', coral_cauliflower(rng), mat),
        make_object('coral_lobe', coral_lobe(rng), mat, smooth=False),
        make_object('sea_fan', sea_fan(rng), mat),
        make_object('sun_coral', sun_coral(rng), mat),
        make_object('urchin', urchin(rng), mat),
    ]
    for name, spec in SPECIES.items():
        objects.append(make_object(name, fish(spec), mat, extras={'length': spec['length']}))
    for i, obj in enumerate(objects):
        obj.location.x = i * 0.2  # spread out for inspection in Blender; the game ignores placement

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

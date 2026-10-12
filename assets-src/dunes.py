"""Generate the nesting dunes' own props -> src/assets/dunes.glb (the rocks, cactus and driftwood
come from props.glb, shared with the island).

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/dunes.py

Same conventions as props.py (Blender space, Z up, exported Y up; each prop stands on z = 0 at the
origin at its real size in metres, coloured per vertex). Objects:

- saltbush_0/1: saltbush (Cryptocarpus pyriformis), the commonest shrub at the back of Galapagos
  beaches: a mound of bright yellow-green leaf clumps over a tangle of grey woody stems that arch
  out from the base, open underneath. Extras `radius` (the canopy's reach), `height` (its top) and
  `rim` (how high its edge stands off the ground): the game hides what's under it from the snakes.
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
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import srgb  # noqa: E402
from props import MeshBuilder, blob, make_object, mix, path, tube  # noqa: E402

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
}


def saltbush(rng, radius, height):
    mb = MeshBuilder()
    wood = lambda co, s: mix(C['stem_dark'], C['stem'], 0.3 + 0.7 * s)
    # Woody stems: up from the base and arching out and down toward the rim.
    for i in range(14):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / 14
        out = Vector((math.cos(a), math.sin(a), 0))
        reach = rng.uniform(0.75, 1.05)
        pts = path(out * 0.015, out * 0.55 + Vector((0, 0, 1)), (radius + height) * 0.75 * reach, 7,
                   bend=out * 1.6 - Vector((0, 0, 1.4)), wobble=0.12, rng=rng)
        tube(mb, pts, lambda s: 0.0075 * (1 - 0.75 * s), wood, sides=5)
        # A twig or two off each.
        for j in (3, 5):
            p = pts[j]
            side = Vector((-out.y, out.x, 0)) * rng.choice((-1, 1))
            twig = path(p, side + Vector((0, 0, 0.6)), radius * 0.35, 3, bend=Vector((0, 0, -0.6)), wobble=0.2, rng=rng)
            tube(mb, twig, lambda s: 0.003 * (1 - 0.6 * s), wood, sides=4)
    # Leaf clumps over a dome, thinning out toward the rim, leaving the base open.
    leaf = lambda c, r: mix(mix(C['leaf_dark'], C['leaf'], min(1.0, c.z / height * 1.4)), C['leaf_light'], r * 0.45)
    for k in range(64):
        t = math.sqrt(rng.random()) * 1.42
        phi = rng.uniform(0, 2 * math.pi)
        rr = radius * (0.85 + 0.2 * rng.random())
        centre = Vector((rr * math.sin(t) * math.cos(phi), rr * math.sin(t) * math.sin(phi), height * max(0.0, math.cos(t)) ** 0.7))
        centre.z = max(centre.z, 0.075)
        s = rng.uniform(0.07, 0.12) * (1.15 - 0.3 * t / 1.42)
        blob(mb, centre, (s, s, s * 0.7), leaf, rng)
    return mb


def mangrove(rng):
    mb = MeshBuilder()
    bark = lambda co, s: mix(C['mangrove_bark'], C['root'], 0.4 * s)
    trunk_h = 0.55
    tube(mb, [Vector((0, 0, 0.22)), Vector((0.01, 0, 0.4)), Vector((0.0, 0.01, trunk_h))], lambda s: 0.03 * (1 - 0.4 * s), bark, sides=7)
    # Prop roots: from the trunk's foot and lower branches, arching out and down into the sand.
    for i in range(11):
        a = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / 11
        out = Vector((math.cos(a), math.sin(a), 0))
        start = Vector((0, 0, rng.uniform(0.2, 0.38))) + out * 0.02
        foot = out * rng.uniform(0.18, 0.32) - Vector((0, 0, 0.02))
        mid = (start + foot) / 2 + out * 0.06 + Vector((0, 0, 0.08))
        pts = [start.lerp(mid, t) if t < 1 else mid for t in (0, 0.5, 1)] + [mid.lerp(foot, t) for t in (0.5, 1)]
        tube(mb, pts, lambda s: 0.009 * (1 - 0.35 * s), lambda co, s: mix(C['mangrove_bark'], C['root'], s), sides=5)
    # Branches out into a broad dark crown.
    leaf = lambda c, r: mix(C['mangrove_leaf'], C['mangrove_light'], r * 0.5 + max(0.0, c.z - 0.75) * 2)
    for i in range(6):
        a = 2 * math.pi * i / 6 + rng.uniform(-0.3, 0.3)
        out = Vector((math.cos(a), math.sin(a), 0))
        pts = path(Vector((0, 0, trunk_h - 0.08)), out + Vector((0, 0, 1.1)), 0.32, 4, bend=out * 0.5, wobble=0.1, rng=rng)
        tube(mb, pts, lambda s: 0.014 * (1 - 0.6 * s), bark, sides=5)
        blob(mb, pts[-1] + Vector((0, 0, 0.05)), (0.17, 0.17, 0.1), leaf, rng)
    for k in range(10):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.05, 0.32)
        blob(mb, Vector((math.cos(a) * d, math.sin(a) * d, rng.uniform(0.72, 0.9))), (0.16, 0.16, 0.09), leaf, rng)
    return mb, 0.06, trunk_h


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
        objects.append(make_object(f'saltbush_{i}', saltbush(rng, radius, height), mat,
                                   extras={'radius': radius + 0.06, 'height': height + 0.05, 'rim': 0.075}))
    mb, r, h = mangrove(rng)
    objects.append(make_object('mangrove', mb, mat, extras={'trunk_radius': r, 'trunk_height': h}))
    for i in range(2):
        objects.append(make_object(f'eggshell_{i}', eggshell(rng), mat))
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

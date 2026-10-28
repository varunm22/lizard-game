"""Generate a Galapagos sea lion (Zalophus wollebaeki) -> src/assets/sealion.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/sealion.py [out.glb]

Real size for an adult female: about 1.5 m long (bulls reach 2.5 m, pups are born at about 0.75 m);
the game scales this one for bulls and pups. Sleek and long-necked, broadest at the chest, golden
brown when dry and darker on the back, paler below, with a small head, a pointed muzzle, big dark eyes,
tiny rolled ear flaps (sea lions are eared seals), long dark fore-flippers and fan-shaped hind
flippers. On land they lie belly down with the fore-flippers out to the sides and the hind flippers
trailing, and lift the head now and then. The lava tunnels show them across the water on the outer
islet, the next stage (src/tunnels/sealions.ts).

Conventions (Blender space, Z up, exported Y up): lying prone, facing -Y (+Z in glTF), its belly on
z = 0. Two unparented bones the game places: `body` and `head` (its joint at the base of the skull).
Extras on the armature, in glTF space: `joints`, `length`.
"""

import math
import os
import random
import sys

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MeshBuilder, build_free_rig, build_skinned, export_skinned, flat_materials, gltf_point, lerp, srgb  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'sealion.glb')

COLORS = {
    'Coat': srgb('#9a7d5a'),
    'Back': srgb('#76604a'),
    'Belly': srgb('#b39874'),
    'Flipper': srgb('#3c332c'),
    'Nose': srgb('#211e1b'),
    'Eye': srgb('#0d0b0a'),
}
rnd = random.Random(8)

# Sections along the body (y, half width, half height, centre z), snout to tail.
LOFT = [(-0.75, 0.012, 0.01, 0.075), (-0.74, 0.024, 0.022, 0.078), (-0.715, 0.034, 0.033, 0.085), (-0.69, 0.046, 0.046, 0.094),
        (-0.665, 0.066, 0.064, 0.107), (-0.62, 0.076, 0.072, 0.11), (-0.57, 0.072, 0.07, 0.104), (-0.5, 0.09, 0.085, 0.104), (-0.38, 0.14, 0.11, 0.11),
        (-0.26, 0.18, 0.135, 0.13), (-0.12, 0.2, 0.148, 0.142), (0.02, 0.19, 0.142, 0.138), (0.16, 0.16, 0.12, 0.12),
        (0.3, 0.115, 0.088, 0.092), (0.41, 0.075, 0.06, 0.064), (0.49, 0.045, 0.036, 0.046), (0.53, 0.02, 0.018, 0.04)]
NECK = Vector((0, -0.57, 0.1))


def loft_at(y):
    for a, b in zip(LOFT, LOFT[1:]):
        if y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            return tuple(lerp(p, q, t) for p, q in zip(a[1:], b[1:]))
    return LOFT[-1][1:]


def weights(y):
    t = max(0.0, min(1.0, (y - (NECK.y - 0.04)) / 0.1))
    if t <= 0:
        return {'head': 1.0}
    if t >= 1:
        return {'body': 1.0}
    return {'head': 1 - t, 'body': t}


def build_body(mb):
    mb.begin()
    sides = 18
    n = 40
    rings = []
    for i in range(n + 1):
        y = LOFT[0][0] + (LOFT[-1][0] - LOFT[0][0]) * i / n
        w, h, cz = loft_at(y)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            c = math.cos(a)
            # Belly flattened on the ground; the coat a little uneven (folds of skin at the neck).
            wob = 1 + 0.03 * math.sin(3 * a + y * 9) + 0.02 * rnd.uniform(-1, 1)
            z = cz + h * c * (1.0 if c > 0 else 0.8) * wob
            z = max(z, 0.003 if y > -0.5 else z)
            ring.append(mb.vert((w * math.sin(a) * wob, y, z), weights(y)))
        rings.append(ring)

    def mat(i, k):
        up = math.cos(2 * math.pi * (k + 0.5) / sides)
        if i == 0:
            return 'Nose'
        if up < -0.2:
            return 'Belly'
        return 'Back' if up > 0.55 and i > 6 else 'Coat'
    mb.ring_loft(rings, mat)
    mb.end()


def flipper(mb, root, pts, widths, thick, normal):
    """A flat flipper from `root` through `pts`, `widths` across and `thick` thick."""
    mb.begin()
    path = [Vector(root)] + [Vector(p) for p in pts]
    rings = []
    n = len(path)
    for i, (p, w, t) in enumerate(zip(path, widths, thick)):
        axis = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        across = normal.cross(axis).normalized()
        up = axis.cross(across).normalized()
        rings.append([mb.vert(p + across * (w * math.cos(2 * math.pi * k / 8)) + up * (t * math.sin(2 * math.pi * k / 8)), weights(p.y)) for k in range(8)])
    mb.ring_loft(rings, lambda i, k: 'Coat' if i == 0 else 'Flipper')
    mb.end()


def build_limbs(mb):
    up = Vector((0, 0, 1))
    for s in (1, -1):
        # Fore-flippers: out from the shoulders, swept back, lying flat on the ground.
        flipper(mb, (0.12 * s, -0.24, 0.07), [(0.22 * s, -0.2, 0.03), (0.33 * s, -0.12, 0.012), (0.42 * s, -0.03, 0.008)],
                [0.05, 0.065, 0.06, 0.03], [0.03, 0.015, 0.008, 0.004], up)
        # Hind flippers: trailing back, a broad fan at the end.
        flipper(mb, (0.035 * s, 0.44, 0.045), [(0.06 * s, 0.56, 0.02), (0.09 * s, 0.68, 0.008), (0.12 * s, 0.77, 0.006)],
                [0.035, 0.045, 0.07, 0.085], [0.025, 0.012, 0.006, 0.003], up)
        # Ears: tiny rolled flaps behind the eyes.
        flipper(mb, (0.064 * s, -0.622, 0.16), [(0.076 * s, -0.608, 0.172)], [0.008, 0.004], [0.006, 0.003], Vector((s, 0, 0)))
        # Eyes: big and dark.
        mb.begin()
        c = Vector((0.054 * s, -0.672, 0.124))
        n = 8
        ring = [mb.vert(c + Vector((0.004 * s, 0.012 * math.cos(2 * math.pi * k / n), 0.01 * math.sin(2 * math.pi * k / n))), weights(c.y)) for k in range(n)]
        out = mb.vert(c + Vector((0.008 * s, 0, 0)), weights(c.y))
        inn = mb.vert(c - Vector((0.006 * s, 0, 0)), weights(c.y))
        for k in range(n):
            k2 = (k + 1) % n
            mb.face([ring[k], ring[k2], out], 'Eye')
            mb.face([ring[k2], ring[k], inn], 'Eye')
        mb.end()


def joints():
    return {'body': Vector((0, -0.1, 0.14)), 'head': NECK}


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = flat_materials(COLORS, 0.7)
    rig = build_free_rig('SeaLion', joints())
    mb = MeshBuilder()
    build_body(mb)
    build_limbs(mb)
    build_skinned('SeaLion', rig, mb, COLORS, mats)
    rig['joints'] = {k: gltf_point(v) for k, v in joints().items()}
    rig['length'] = 1.52
    export_skinned(OUT)


if __name__ == '__main__':
    main()

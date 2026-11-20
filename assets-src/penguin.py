"""Generate a Galapagos penguin (Spheniscus mendiculus) for the beach stage -> src/assets/penguin.glb:
one skinned mesh on a free rig the game poses (src/beach/birds.ts). Checked against iNaturalist
photos (standing on lava at the waterline, swimming low with the head up).

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/penguin.py

The smallest banded penguin, 0.11 m tall here (about 0.5 m real, at the game's scale of about a
fifth). What marks it out: a slaty black back, head and flippers; white underparts with a few
black speckles; a black band across the upper chest whose ends run down the flanks to the legs, and
a thinner one above it; a thin white line from the base of the bill over the eye, round the back
of the cheek and down onto the throat; a stout black bill, pale pink at the base; black-and-pink
feet. Standing it leans a little forward, flippers held slightly out.

Conventions (Blender space, Z up, exported Y up): standing on z = 0, facing -Y (+Z in glTF). Bones
(unparented): body, head, flipper_L/R, foot_L/R. Extras on the armature: `joints`, `height`.
"""

import math
import os
import sys

import bpy  # noqa: I001 (bpy has to load before mathutils)
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import srgb  # noqa: E402
from rigged import Builder, blend, export, flat_materials, free_rig, noise3, skin  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'penguin.glb')

COLOURS = {
    'Black': srgb('#25282d'),
    'Slate': srgb('#3a3f47'),
    'White': srgb('#eeeee8'),
    'Bill': srgb('#1c1c1e'),
    'Pink': srgb('#d9a3a0'),
    'Feet': srgb('#3a2f30'),
    'Eye': srgb('#2a1a16'),
}
# Body sections from the tail up to the throat: (z, half width, half depth, y of the middle).
BODY = [
    (0.010, 0.010, 0.011, 0.006),
    (0.018, 0.020, 0.020, 0.004),
    (0.030, 0.027, 0.026, 0.001),
    (0.044, 0.029, 0.028, -0.001),
    (0.057, 0.027, 0.026, -0.002),
    (0.068, 0.022, 0.021, -0.003),
    (0.077, 0.016, 0.016, -0.004),
    (0.084, 0.013, 0.014, -0.005),
]
HEAD = Vector((0, -0.006, 0.093))
JOINTS = {
    'body': ((0, 0.004, 0.012), (0, -0.004, 0.08)),
    'head': ((0, -0.005, 0.083), (0, -0.03, 0.093)),
    'flipper_L': ((0.024, -0.002, 0.068), (0.033, 0.006, 0.034)),
    'flipper_R': ((-0.024, -0.002, 0.068), (-0.033, 0.006, 0.034)),
    'foot_L': ((0.009, -0.002, 0.008), (0.011, -0.019, 0.001)),
    'foot_R': ((-0.009, -0.002, 0.008), (-0.011, -0.019, 0.001)),
}


def body_at(z):
    """The body section at height z, eased between the listed ones."""
    for a, b in zip(BODY, BODY[1:]):
        if z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            t = t * t * (3 - 2 * t)
            return tuple(p + (q - p) * t for p, q in zip(a, b))
    return BODY[-1]


def body_mat(z, front, k):
    """Plumage by height and how far round toward the front (1 straight ahead)."""
    if z > 0.0795:
        return 'White' if front > 0.55 and z < 0.0815 else 'Black'
    if z > 0.0705:
        return 'Black'
    # The lower band's ends run down each flank to the legs.
    if 0.022 < z and abs(front - 0.32) < 0.13 - 0.6 * max(0.0, 0.035 - z):
        return 'Black'
    if front > 0.18:
        return 'White'
    return 'Slate'


def build_body(mb):
    noise = noise3(4)
    sides = 24
    zs = [BODY[0][0] + (BODY[-1][0] - BODY[0][0]) * i / 26 for i in range(27)]
    rings = []
    for z in zs:
        _, w, d, cy = body_at(z)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides  # 0 at the front (-Y), toward +X
            p = Vector((w * math.sin(a), cy - d * math.cos(a), z))
            p.x *= 1 + 0.03 * noise(p, 0.01)
            ring.append(mb.vert(p, blend(z, [(0.07, 'body'), (0.086, 'head')])))
        rings.append(ring)

    def mat(i, k):
        return body_mat((zs[i] + zs[i + 1]) / 2, math.cos(2 * math.pi * (k + 0.5) / sides), k)
    start = mb.mark()
    mb.loft(rings, mat, cap_start=(Vector((0, 0.008, 0.004)), {'body': 1.0}))
    # Close the top under the head.
    c = mb.vert(Vector((0, -0.006, 0.088)), {'head': 1.0})
    for k in range(sides):
        mb.face([rings[-1][k], rings[-1][(k + 1) % sides], c], 'Black')
    mb.outward(start)


def build_head(mb):
    head = {'head': 1.0}

    def mat(i, k):
        # Rings from the crown (i = 0) down; k round from the front toward +X.
        phi = math.pi * (i + 0.5) / 7
        th = 2 * math.pi * (k + 0.5) / 12
        front = math.cos(th)
        side = abs(math.sin(th))
        # The thin white line: over the eye from the bill, round the back of the cheek, down the throat.
        brow = 0.95 < phi < 1.3 and side > 0.4 and -0.25 < front < 0.8
        cheek = 1.3 <= phi < 2.05 and -0.3 < front < 0.12
        throat = 2.05 <= phi < 2.45 and front > 0.05
        line = brow or cheek or throat
        return 'White' if line else 'Black'
    mb.ellipsoid(HEAD, (0.0165, 0.0135, 0.0135), head, mat, rings=7, sides=12,
                 axes=(Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))))
    # Stout bill, pink at the base.
    base = HEAD + Vector((0, -0.014, -0.001))
    tip = HEAD + Vector((0, -0.03, -0.004))
    mb.paddle([base, base + (tip - base) * 0.4, tip], [0.0045, 0.0033, 0.0008], [0.0045, 0.0035, 0.001], lambda t: head,
              'Bill', Vector((0, 0, 1)), sides=8)
    for s in (1, -1):
        mb.ellipsoid(base + Vector((s * 0.0042, 0.001, -0.0015)), (0.0016, 0.0035, 0.0018), head, 'Pink', rings=3, sides=6)
        mb.ellipsoid(HEAD + Vector((s * 0.0115, -0.008, 0.002)), (0.0016, 0.0016, 0.0016), head, 'Eye', rings=4, sides=6)


def build_limbs(mb):
    for s, side in ((1, 'L'), (-1, 'R')):
        a, b = (Vector(p) for p in JOINTS['flipper_' + side])
        normal = Vector((s, 0.1, 0)).normalized()
        mb.paddle([a, a + (b - a) * 0.3, a + (b - a) * 0.7, b], [0.0055, 0.008, 0.0065, 0.0015], [0.0025, 0.0018, 0.0012, 0.0006],
                  lambda t, side=side: {'flipper_' + side: 1.0}, 'Black', normal, sides=8)
        a, b = (Vector(p) for p in JOINTS['foot_' + side])
        mb.paddle([a, a + (b - a) * 0.5, b], [0.003, 0.006, 0.0065], [0.0025, 0.0012, 0.0008],
                  lambda t, side=side: {'foot_' + side: 1.0}, 'Feet', Vector((0, 0, 1)), sides=6)
    # The short stiff tail.
    mb.paddle([Vector((0, 0.012, 0.012)), Vector((0, 0.022, 0.006))], [0.006, 0.002], [0.002, 0.001], lambda t: {'body': 1.0},
              'Black', Vector((0, 0, 1)), sides=6)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = flat_materials(COLOURS, 0.7)
    rig = free_rig('Penguin', JOINTS)
    mb = Builder()
    build_body(mb)
    build_head(mb)
    build_limbs(mb)
    skin('Penguin', rig, mb, mats)
    rig['height'] = HEAD.z + 0.0135
    export(os.path.abspath(OUT))
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

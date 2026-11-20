"""Generate a flightless cormorant (Nannopterum harrisi) for the beach stage ->
src/assets/cormorant.glb: one skinned mesh on a free rig the game poses (src/beach/birds.ts).
Checked against iNaturalist photos (standing on wet lava with the wings held out to dry, the long
neck in an S, swimming low).

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/cormorant.py

About 0.13 m tall here, standing (it's about 0.9 m long real, at the game's scale of about a
fifth). What marks it out: heavy and upright on short legs set far back, a stiff tail propped on
the rock; tiny, ragged wings, far too small to fly with, held out to dry after a dive; a long neck in
an S; a long, hooked, grey bill; a turquoise eye; dark brown-black plumage, browner and scaly over
the back, a little paler at the throat; huge black webbed feet.

Conventions (Blender space, Z up, exported Y up): standing on z = 0, facing -Y (+Z in glTF). Bones
(unparented): body, neck1, neck2, head, wing_L/R, foot_L/R, tail. Extras: `joints`, `height`.
"""

import math
import os
import random
import sys

import bpy  # noqa: I001 (bpy has to load before mathutils)
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import srgb  # noqa: E402
from rigged import Builder, blend, export, flat_materials, free_rig, noise3, skin  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'cormorant.glb')

COLOURS = {
    'Plumage': srgb('#2b2724'),
    'Back': srgb('#433a31'),
    'Edge': srgb('#5a4d40'),
    'Throat': srgb('#4a423a'),
    'Bill': srgb('#827b6f'),
    'Ridge': srgb('#4e4942'),
    'Eye': srgb('#2cb3ad'),
    'Feet': srgb('#1b1a19'),
}
REAR = Vector((0, 0.028, 0.019))
BREAST = Vector((0, -0.016, 0.076))
NECK = [Vector((0, -0.018, 0.072)), Vector((0, -0.030, 0.088)), Vector((0, -0.026, 0.104)), Vector((0, -0.030, 0.118)), Vector((0, -0.036, 0.124))]
HEAD = Vector((0, -0.038, 0.125))
JOINTS = {
    'body': ((0, 0.03, 0.03), (0, -0.012, 0.07)),
    'neck1': (tuple(NECK[0]), tuple(NECK[2])),
    'neck2': (tuple(NECK[2]), tuple(NECK[4])),
    'head': ((0, -0.036, 0.124), (0, -0.08, 0.118)),
    'tail': ((0, 0.03, 0.018), (0, 0.05, 0.002)),
    'wing_L': ((0.017, -0.004, 0.062), (0.022, 0.024, 0.042)),
    'wing_R': ((-0.017, -0.004, 0.062), (-0.022, 0.024, 0.042)),
    'foot_L': ((0.012, 0.012, 0.012), (0.015, -0.014, 0.001)),
    'foot_R': ((-0.012, 0.012, 0.012), (-0.015, -0.014, 0.001)),
}


def build_body(mb):
    noise = noise3(9)
    axis = BREAST - REAR
    length = axis.length
    f = axis.normalized()
    side = Vector((1, 0, 0))
    up = f.cross(side).normalized()  # toward the bird's back
    sides = 20
    n = 18
    rings, ts = [], []
    for i in range(n + 1):
        t = i / n
        r = 0.0235 * math.sin(math.pi * (0.06 + 0.88 * t)) ** 0.7
        r = max(r, 0.004)
        c = REAR + axis * t
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides  # 0 along the back
            d = side * math.sin(a) * r * 0.95 + up * math.cos(a) * r * (1.05 if math.cos(a) > 0 else 1.0)
            d *= 1 + 0.05 * noise(c + d, 0.008)  # ruffled
            ring.append(mb.vert(c + d, blend(t, [(0.0, 'tail'), (0.12, 'body'), (0.88, 'body'), (1.0, 'neck1')])))
        rings.append(ring)
        ts.append(t)

    pick = random.Random(17)
    edges = {(i, k) for i in range(n) for k in range(sides) if pick.random() < 0.28}

    def scaly(i, k):
        return (i, k) in edges

    def mat(i, k):
        a = 2 * math.pi * (k + 0.5) / sides
        t = ts[i]
        if math.cos(a) > 0.35 and 0.15 < t < 0.85:
            # Scaly back: browner, here and there a feather's paler edge showing, in no pattern.
            return 'Edge' if scaly(i, k) else 'Back'
        return 'Plumage'
    start = mb.mark()
    mb.loft(rings, mat, cap_start=(REAR - f * 0.004, {'tail': 1.0}), cap_end=(BREAST + f * 0.002, {'neck1': 1.0}))
    mb.outward(start)


def build_neck_head(mb):
    head = {'head': 1.0}
    pts = NECK
    radii = [0.011, 0.0068, 0.0058, 0.0058, 0.0064]

    def weights(t):
        return blend(t, [(0.0, 'body'), (0.15, 'neck1'), (0.45, 'neck1'), (0.6, 'neck2'), (0.85, 'neck2'), (1.0, 'head')])
    mb.paddle(pts, radii, radii, weights, 'Plumage', Vector((1, 0, 0)), sides=10)
    # Throat a shade paler: a patch under the chin.
    mb.ellipsoid(HEAD + Vector((0, -0.004, -0.006)), (0.0062, 0.008, 0.004), head, 'Throat', rings=4, sides=8)
    mb.ellipsoid(HEAD, (0.0085, 0.0118, 0.0086), head, 'Plumage', rings=6, sides=10,
                 axes=(Vector((1, 0, 0)), Vector((0, -1, 0.1)).normalized(), Vector((0, 0.1, 1)).normalized()))
    # The long bill, hooked down at the tip, a darker ridge along the top.
    b0 = HEAD + Vector((0, -0.009, -0.001))
    path = [b0, b0 + Vector((0, -0.012, -0.0015)), b0 + Vector((0, -0.024, -0.003)), b0 + Vector((0, -0.033, -0.004)), b0 + Vector((0, -0.037, -0.0075))]
    mb.paddle(path, [0.0035, 0.0026, 0.002, 0.0017, 0.0007], [0.0037, 0.0027, 0.002, 0.0018, 0.001], lambda t: head, 'Bill', Vector((0, 0, 1)),
              sides=8, tip_mat='Ridge')
    mb.paddle([p + Vector((0, 0, 0.002)) for p in path[:4]], [0.0012, 0.001, 0.0008, 0.0006], [0.0012, 0.001, 0.0008, 0.0006], lambda t: head,
              'Ridge', Vector((0, 0, 1)), sides=6)
    for s in (1, -1):
        mb.ellipsoid(HEAD + Vector((s * 0.0072, -0.006, 0.002)), (0.0019, 0.0019, 0.0019), head, 'Eye', rings=4, sides=6)


def build_limbs(mb):
    for s, side in ((1, 'L'), (-1, 'R')):
        a, b = (Vector(p) for p in JOINTS['wing_' + side])
        w = {'wing_' + side: 1.0}
        normal = Vector((s, 0, 0.2)).normalized()
        mb.paddle([a, a + (b - a) * 0.4, a + (b - a) * 0.8, b], [0.007, 0.009, 0.007, 0.003], [0.0025, 0.002, 0.0015, 0.0008],
                  lambda t, w=w: w, 'Back', normal, sides=8)
        # Ragged: a few loose flight feathers off the trailing edge.
        along = (b - a).normalized()
        back = normal.cross(along).normalized()
        for k in range(3):
            p = a + (b - a) * (0.55 + 0.2 * k) + back * 0.006
            mb.ellipsoid(p, (0.0016, 0.0055, 0.0007), w, 'Plumage', rings=3, sides=6,
                         axes=(back, (along + back * 0.5).normalized(), normal))
        # Short black legs set far back, and big webbed feet.
        a, b = (Vector(p) for p in JOINTS['foot_' + side])
        heel = Vector((a.x, a.y - 0.003, 0.002))
        mb.paddle([a + Vector((0, 0, 0.004)), heel + Vector((0, 0, 0.001))], [0.0032, 0.0022], [0.0032, 0.0022],
                  lambda t, side=side: {'foot_' + side: 1.0}, 'Feet', Vector((0, 1, 0)), sides=6)
        mb.paddle([heel, heel + (b - heel) * 0.5, b], [0.003, 0.009, 0.011], [0.0015, 0.001, 0.0008],
                  lambda t, side=side: {'foot_' + side: 1.0}, 'Feet', Vector((0, 0, 1)), sides=6)
    # The stiff tail, propped on the rock.
    a, b = (Vector(p) for p in JOINTS['tail'])
    mb.paddle([a, a + (b - a) * 0.5, b], [0.009, 0.01, 0.008], [0.003, 0.002, 0.001], lambda t: {'tail': 1.0}, 'Plumage', Vector((0, 0.7, 0.7)).normalized(),
              sides=8)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = flat_materials(COLOURS, 0.7)
    rig = free_rig('Cormorant', JOINTS)
    mb = Builder()
    build_body(mb)
    build_neck_head(mb)
    build_limbs(mb)
    skin('Cormorant', rig, mb, mats)
    rig['height'] = HEAD.z + 0.009
    export(os.path.abspath(OUT))
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

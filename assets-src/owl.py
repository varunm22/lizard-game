"""Generate a Galapagos barn owl (Tyto alba punctatissima) -> src/assets/owl.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/owl.py [out.glb]

Real size: about 0.33 m long, standing about 0.27 m tall perched, a wingspan of about 0.8 m. The
Galapagos race is small and dark for a barn owl: grey-brown above washed with golden buff, finely
spotted white and dark ("punctatissima", the most spotted), buff to cinnamon below with dark spots,
and the white heart-shaped facial disc with a rusty-brown rim, dark eyes and a pale hooked bill. It
has long legs feathered whitish down to grey toes. On Galapagos barn owls roost in lava tubes and
hunt from perches by sound, dropping onto prey with the talons swung forward: the game does that
(src/tunnels/owl.ts).

Conventions (Blender space, Z up, exported Y up): the owl faces -Y (+Z in glTF), +X is its left,
perched with its toes on z = 0. There are no clips: the game poses every bone itself, so they are all
unparented and the game places each directly:

- `body`: the body, rigid. `head`: the head, disc, eyes and bill. `tail`: the tail.
- `fold_L/R`: the folded wing lying along each flank (perched).
- `wing_L/R` (joint at the shoulder) and `hand_L/R` (joint at the wrist): the spread wing, modelled
  held out level. Perched, the game shrinks the spread wings to nothing at the shoulder and shows the
  folded ones; flying, the other way round.
- `leg_L/R`: each leg and foot, from the hip.

Extras on the armature, in glTF space (Y up, +Z forward): `joints` (each bone's joint, by name),
`talons` (between the feet), `height` (the top of the head, perched).
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
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'owl.glb')

COLORS = {
    'Back': srgb('#8b7d66'),
    'Gold': srgb('#b08c56'),
    'LightSpot': srgb('#efe6d4'),
    'DarkSpot': srgb('#3e3226'),
    'Belly': srgb('#cfa874'),
    'Under': srgb('#ece0c8'),
    'Bar': srgb('#5f4c38'),
    'Face': srgb('#ece2cf'),
    'Rim': srgb('#8a5634'),
    'Smudge': srgb('#9c6a48'),
    'Eye': srgb('#0f0b09'),
    'Bill': srgb('#e3cdb8'),
    'Leg': srgb('#e0cfae'),
    'Toe': srgb('#77716a'),
    'Claw': srgb('#221d19'),
}

SIDES = {'_L': 1, '_R': -1}
rnd = random.Random(11)

# ---------------------------------------------------------------------------------------------
# Shape (Blender space, metres).
# ---------------------------------------------------------------------------------------------
# The body: an egg along its axis from the vent up to the base of the neck, leaning a little
# forward. Sections: (t along the axis, half width, half depth front to back, forward offset).
BODY_A = Vector((0, 0.035, 0.055))
BODY_B = Vector((0, -0.004, 0.205))
BODY = [(0.0, 0.016, 0.016, 0.0), (0.1, 0.034, 0.033, -0.004), (0.28, 0.048, 0.045, -0.008), (0.5, 0.053, 0.049, -0.009),
        (0.7, 0.051, 0.046, -0.007), (0.86, 0.044, 0.04, -0.004), (1.0, 0.032, 0.03, 0.0)]
HEAD_C = Vector((0, -0.006, 0.236))
HEAD_R = (0.044, 0.038, 0.041)
NECK = Vector((0, -0.002, 0.205))
# The facial disc: a heart (point at the chin, notch at the forehead) on the front of the head.
DISC_C = Vector((0, HEAD_C.y - HEAD_R[1] + 0.004, 0.236))
DISC_W, DISC_H = 0.046, 0.052
EYE_Z = 0.243
SHOULDER = Vector((0.04, 0.002, 0.19))
WRIST = Vector((0.165, -0.004, 0.192))
TIP = Vector((0.385, 0.035, 0.19))
HIP = Vector((0.022, 0.004, 0.07))
ANKLE = Vector((0.025, -0.006, 0.012))
TAIL = Vector((0, 0.045, 0.082))


def body_frame(t):
    """Point on the body's axis at t and the section there."""
    for a, b in zip(BODY, BODY[1:]):
        if t <= b[0]:
            u = (t - a[0]) / (b[0] - a[0])
            sec = tuple(lerp(p, q, u) for p, q in zip(a[1:], b[1:]))
            break
    else:
        sec = BODY[-1][1:]
    return BODY_A.lerp(BODY_B, t), sec


def plumage(co, front, seed):
    """Which plumage a body face shows: buff spotted dark in front, grey-brown and golden spotted
    white behind."""
    r = rnd.random()
    if front > 0.2:
        return 'DarkSpot' if r < 0.05 else 'Belly'
    if front > -0.15:
        return 'Gold' if r < 0.5 else 'Belly'
    if r < 0.05:
        return 'LightSpot'
    if r < 0.07:
        return 'DarkSpot'
    return 'Gold' if (co.z > 0.12 and r < 0.45) else 'Back'


def build_body(mb):
    mb.begin()
    sides = 22
    rings = []
    steps = 18
    axis = (BODY_B - BODY_A).normalized()
    side = Vector((1, 0, 0))
    fwd = side.cross(axis).normalized() * -1  # toward -Y (the owl's front), across the axis
    if fwd.y > 0:
        fwd = -fwd
    for i in range(steps + 1):
        t = i / steps
        c, (w, d, off) = body_frame(t)
        c = c + fwd * off
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            # Plumage is fluffy: a little lumpy round the ring.
            bump = 1 + 0.05 * math.sin(3 * a + i * 1.3) + 0.03 * rnd.uniform(-1, 1)
            p = c + side * (w * math.sin(a) * bump) + fwd * (d * math.cos(a) * bump)
            ring.append(mb.vert(p, {'body': 1.0}))
        rings.append(ring)

    def mat(i, k):
        a = 2 * math.pi * (k + 0.5) / sides
        co = mb.verts[rings[i][k]]
        return plumage(co, math.cos(a), i * sides + k)
    mb.ring_loft(rings, mat)
    mb.end()


def ellipsoid(mb, c, r, weights, mat, rings=7, sides=12, jitter=0.0):
    mb.begin()
    top = mb.vert(c + Vector((0, 0, r[2])), weights)
    bottom = mb.vert(c - Vector((0, 0, r[2])), weights)
    layers = []
    for i in range(1, rings):
        th = math.pi * i / rings
        layer = []
        for k in range(sides):
            ph = 2 * math.pi * k / sides
            j = 1 + jitter * rnd.uniform(-1, 1)
            layer.append(mb.vert(c + Vector((r[0] * math.sin(th) * math.cos(ph) * j, r[1] * math.sin(th) * math.sin(ph) * j, r[2] * math.cos(th) * j)), weights))
        layers.append(layer)
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face([top, layers[0][k], layers[0][k2]], mat(0, k))
        mb.face([bottom, layers[-1][k2], layers[-1][k]], mat(rings - 1, k))
        for i, (a, b) in enumerate(zip(layers, layers[1:])):
            mb.face([a[k], b[k], b[k2], a[k2]], mat(i + 1, k))
    mb.end()


def heart(t):
    """The heart outline at angle t (0 at the forehead notch, pi at the chin point), unit size."""
    x = math.sin(t) ** 3
    y = (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)) / 16
    return x, y


def build_head(mb):
    h = {'head': 1.0}
    # The crown and nape: grey-brown, finely spotted.
    def head_mat(i, k):
        ph = 2 * math.pi * (k + 0.5) / 12
        front = -math.sin(ph)
        if front > 0.5:
            return 'Face'
        r = rnd.random()
        return 'LightSpot' if r < 0.1 else ('Gold' if r < 0.4 else 'Back')
    ellipsoid(mb, HEAD_C, HEAD_R, h, head_mat, rings=8, sides=12, jitter=0.02)
    # The facial disc: a shallow dish, its rim standing forward as a ruff.
    mb.begin()
    n = 20
    layers = []
    for s in (1.0, 0.85, 0.55, 0.2):
        layer = []
        for k in range(n):
            t = 2 * math.pi * k / n
            x, y = heart(t)
            px, pz = x * DISC_W * s, (y - 0.15) * DISC_H * s
            # On the curve of the face, the rim standing forward as a ruff and the middle dished.
            u = min(0.97, (px / (HEAD_R[0] * 1.05)) ** 2 + (pz / (HEAD_R[2] * 1.05)) ** 2)
            front = HEAD_C.y - HEAD_R[1] * math.sqrt(1 - u)
            depth = -0.006 * s ** 4 + 0.004 * (1 - s)
            layer.append(mb.vert(Vector((px, front + depth, DISC_C.z + pz)), h))
        layers.append(layer)
    back = [mb.vert(mb.verts[layers[0][k]] * 0.8 + HEAD_C * 0.2, h) for k in range(n)]
    centre = mb.vert(Vector((0, HEAD_C.y - HEAD_R[1] + 0.006, DISC_C.z - 0.15 * DISC_H * 0.1)), h)
    for i, (a, b) in enumerate(zip(layers, layers[1:])):
        for k in range(n):
            k2 = (k + 1) % n
            mb.face([a[k], b[k], b[k2], a[k2]], 'Rim' if i == 0 else 'Face')
    for k in range(n):
        k2 = (k + 1) % n
        mb.face([layers[-1][k], centre, layers[-1][k2]], 'Face')
        mb.face([layers[0][k2], back[k2], back[k], layers[0][k]], 'Rim')
    bc = mb.vert(HEAD_C, h)
    for k in range(n):
        k2 = (k + 1) % n
        mb.face([back[k], back[k2], bc], 'Rim')
    mb.end()
    # Eyes, dark and set in the disc, each with a rusty smudge toward the bill.
    for s in (1, -1):
        e = Vector((0.0145 * s, HEAD_C.y - HEAD_R[1] * 0.93, EYE_Z))
        ellipsoid(mb, e + Vector((-0.003 * s, 0.001, -0.004)), (0.008, 0.004, 0.009), h, lambda i, k: 'Smudge', rings=4, sides=8)
        ellipsoid(mb, e, (0.0062, 0.004, 0.0062), h, lambda i, k: 'Eye', rings=5, sides=10)
    # The bill: pale, hooked, half hidden in the feathers between the eyes.
    mb.begin()
    base = [Vector((0.0045, DISC_C.y - 0.002, 0.236)), Vector((-0.0045, DISC_C.y - 0.002, 0.236)), Vector((0, DISC_C.y + 0.003, 0.24))]
    tip = Vector((0, DISC_C.y - 0.01, 0.222))
    hook = Vector((0, DISC_C.y - 0.006, 0.216))
    vs = [mb.vert(p, h) for p in base] + [mb.vert(tip, h), mb.vert(hook, h)]
    mb.face([vs[0], vs[1], vs[3]], 'Bill')
    mb.face([vs[1], vs[2], vs[3]], 'Bill')
    mb.face([vs[2], vs[0], vs[3]], 'Bill')
    mb.face([vs[0], vs[3], vs[4]], 'Bill')
    mb.face([vs[3], vs[1], vs[4]], 'Bill')
    mb.face([vs[1], vs[0], vs[4]], 'Bill')
    mb.end()


def blade(mb, pts, widths, thick, normal_up, weights_at, top_mat, bottom_mat):
    """A flattened, pointed blade along `pts` (a feather tract): an elliptical section `widths` wide
    (across, in the plane whose normal is `normal_up`) and `thick` thick."""
    mb.begin()
    rings = []
    n = len(pts)
    sides = 8
    for i, (p, w, t) in enumerate(zip(pts, widths, thick)):
        axis = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        across = normal_up.cross(axis).normalized()
        up = axis.cross(across).normalized()
        ring = [mb.vert(p + across * (w * math.cos(2 * math.pi * k / sides)) + up * (t * math.sin(2 * math.pi * k / sides)), weights_at(i / (n - 1)))
                for k in range(sides)]
        rings.append(ring)
    mb.ring_loft(rings, lambda i, k: top_mat(i, k) if math.sin(2 * math.pi * (k + 0.5) / sides) > 0 else bottom_mat(i, k))
    mb.end()


def build_folded_wings(mb):
    for suffix, s in SIDES.items():
        w = {f'fold{suffix}': 1.0}
        pts = [Vector((0.044 * s, -0.004, 0.198)), Vector((0.052 * s, 0.012, 0.165)), Vector((0.05 * s, 0.03, 0.125)),
               Vector((0.042 * s, 0.05, 0.085)), Vector((0.028 * s, 0.066, 0.05)), Vector((0.012 * s, 0.078, 0.028))]
        widths = [0.014, 0.03, 0.036, 0.032, 0.022, 0.006]
        thick = [0.008, 0.012, 0.012, 0.009, 0.006, 0.002]

        def top(i, k, s=s):
            r = rnd.random()
            if i >= 3:
                return 'Bar' if (i + k) % 3 == 0 else 'Gold'
            return 'LightSpot' if r < 0.1 else ('Gold' if r < 0.5 else 'Back')
        blade(mb, pts, widths, thick, Vector((s, 0, 0)), lambda t: w, top, lambda i, k: 'Back')


def build_spread_wings(mb):
    """Each wing held out level: a loft of thin airfoil sections from the shoulder to the rounded tip,
    the arm on `wing`, the hand on `hand`; golden-grey above with barred flight feathers, white below,
    a soft, slightly ragged trailing edge."""
    for suffix, s in SIDES.items():
        mb.begin()
        stations = [  # (span 0..1 along shoulder-wrist-tip, chord, leading edge ahead of the bone, thickness)
            (0.0, 0.11, 0.03, 0.013), (0.15, 0.13, 0.03, 0.012), (0.33, 0.145, 0.028, 0.011), (0.45, 0.145, 0.025, 0.009),
            (0.6, 0.138, 0.02, 0.007), (0.75, 0.125, 0.017, 0.006), (0.86, 0.105, 0.014, 0.005), (0.94, 0.078, 0.01, 0.004), (0.985, 0.045, 0.006, 0.003), (1.0, 0.015, 0.002, 0.002)]
        rings = []
        for span, chord, lead, th in stations:
            if span <= 0.35:
                u = span / 0.35
                p = Vector((SHOULDER.x * s, SHOULDER.y, SHOULDER.z)).lerp(Vector((WRIST.x * s, WRIST.y, WRIST.z)), u)
            else:
                u = (span - 0.35) / 0.65
                p = Vector((WRIST.x * s, WRIST.y, WRIST.z)).lerp(Vector((TIP.x * s, TIP.y, TIP.z)), u)
            arm = max(0.0, min(1.0, (0.42 - span) / 0.12))
            wts = {f'wing{suffix}': arm, f'hand{suffix}': 1 - arm} if 0 < arm < 1 else ({f'wing{suffix}': 1.0} if arm >= 1 else {f'hand{suffix}': 1.0})
            ragged = 0.006 * rnd.uniform(-1, 1) if span > 0.4 else 0
            # Section points round the airfoil: leading edge, top, trailing edge, bottom.
            front = p + Vector((0, -lead, 0))
            back = p + Vector((0, chord - lead + ragged, 0))
            sec = [front, front.lerp(back, 0.3) + Vector((0, 0, th)), back + Vector((0, 0, 0.0005)), front.lerp(back, 0.3) - Vector((0, 0, th * 0.5))]
            rings.append([mb.vert(q, wts) for q in sec])

        def mat(i, k):
            top = k in (0, 1)
            if not top:
                return 'Under'
            if i >= 4:
                return 'Bar' if (i % 2 == 0 and k == 1) else 'Gold'
            return 'Back' if k == 0 else ('LightSpot' if rnd.random() < 0.1 else 'Gold')
        mb.ring_loft(rings, mat)
        mb.end()


def build_tail(mb):
    w = {'tail': 1.0}
    pts = [TAIL, TAIL + Vector((0, 0.022, -0.026)), TAIL + Vector((0, 0.036, -0.05))]
    blade(mb, pts, [0.018, 0.026, 0.024], [0.006, 0.004, 0.002], Vector((0, -0.6, 0.8)).normalized(), lambda t: w,
          lambda i, k: 'Bar' if i == 1 else 'Gold', lambda i, k: 'Under')


def tube(mb, path, radii, weights, mat, sides=8):
    mb.begin()
    rings = []
    n = len(path)
    for i, (c, r) in enumerate(zip(path, radii)):
        axis = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        side = axis.cross(Vector((0, 0, 1)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(axis).normalized()
        rings.append([mb.vert(c + r * math.cos(2 * math.pi * k / sides) * side + r * math.sin(2 * math.pi * k / sides) * up, weights) for k in range(sides)])
    mb.ring_loft(rings, lambda i, k: mat)
    mb.end()


def build_legs(mb):
    for suffix, s in SIDES.items():
        w = {f'leg{suffix}': 1.0}
        hip = Vector((HIP.x * s, HIP.y, HIP.z))
        ankle = Vector((ANKLE.x * s, ANKLE.y, ANKLE.z))
        # Long legs, feathered whitish to the toes ("knickers" at the top).
        tube(mb, [hip, hip.lerp(ankle, 0.35), hip.lerp(ankle, 0.75), ankle], [0.013, 0.01, 0.0065, 0.0055], w, 'Leg', sides=8)
        # Toes: two forward, one out to the side (an owl's reversible outer toe), one back.
        for ang, ln in ((-0.25, 0.028), (0.25, 0.026), (1.4 * s, 0.022), (math.pi, 0.018)):
            d = Vector((math.sin(ang) * (1 if ang in (-0.25, 0.25, math.pi) else 1), -math.cos(ang), 0))
            base = ankle + Vector((0, 0, -0.006))
            tip = base + d * ln + Vector((0, 0, -0.004))
            tube(mb, [base, base.lerp(tip, 0.6), tip], [0.0032, 0.0028, 0.0022], w, 'Toe', sides=6)
            claw = tip + d * 0.008 + Vector((0, 0, -0.003))
            tube(mb, [tip - d * 0.002, tip + d * 0.004, claw], [0.0018, 0.0014, 0.0003], w, 'Claw', sides=5)


def joints():
    out = {'body': (BODY_A + BODY_B) / 2, 'head': NECK, 'tail': TAIL}
    for suffix, s in SIDES.items():
        out[f'fold{suffix}'] = Vector((0.044 * s, -0.004, 0.198))
        out[f'wing{suffix}'] = Vector((SHOULDER.x * s, SHOULDER.y, SHOULDER.z))
        out[f'hand{suffix}'] = Vector((WRIST.x * s, WRIST.y, WRIST.z))
        out[f'leg{suffix}'] = Vector((HIP.x * s, HIP.y, HIP.z))
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = flat_materials(COLORS)
    rig = build_free_rig('Owl', joints())
    mb = MeshBuilder()
    build_body(mb)
    build_head(mb)
    build_folded_wings(mb)
    build_spread_wings(mb)
    build_tail(mb)
    build_legs(mb)
    build_skinned('Owl', rig, mb, COLORS, mats)
    rig['joints'] = {k: gltf_point(v) for k, v in joints().items()}
    rig['talons'] = gltf_point(Vector((0, -0.02, 0.0)))
    rig['height'] = round(HEAD_C.z + HEAD_R[2], 4)
    export_skinned(OUT)


if __name__ == '__main__':
    main()

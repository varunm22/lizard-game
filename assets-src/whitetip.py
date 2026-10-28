"""Generate a whitetip reef shark pup (Triaenodon obesus) -> src/assets/whitetip.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/whitetip.py [out.glb]

Real size for a pup: about 0.55 m from snout to tail tip (they're born at 52 to 60 cm). A slender
shark with a broad, flat head, a short blunt snout with flaps of skin at the nostrils, small oval
eyes, the first dorsal fin set well back on the body, a big second dorsal, broad pectoral fins and a
long upper tail lobe. Grey-brown above with a few darker spots, white below, and the bright white tips
on the first dorsal fin and the upper tail lobe the species is named for. Whitetips spend the day
resting on the bottom in caves and under ledges, flooded lava tubes included, pumping water over
their gills; disturbed, they swim off with a few strong sweeps of the tail. The game does both
(src/tunnels/sharks.ts).

Conventions (Blender space, Z up, exported Y up): the shark faces -Y (+Z in glTF), lying level, its
belly on z = 0. There are no clips: the game poses the spine itself, so the bones are unparented
joints along it, `spine_0` (the head) to `spine_6` (the tail fin), and the game places each on a
curve. Extras on the armature, in glTF space: `joints` (each bone's joint, by name), `length`.
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
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'whitetip.glb')

COLORS = {
    'Back': srgb('#7b766c'),
    'Spot': srgb('#55504a'),
    'Flank': srgb('#a39d92'),
    'Belly': srgb('#ece8e0'),
    'Tip': srgb('#f6f4ef'),
    'Fin': srgb('#6f6a61'),
    'Eye': srgb('#151719'),
}
rnd = random.Random(4)

NOSE, TAIL = -0.27, 0.28
# The body's sections along it (y, half width, half height, centre z): a broad, flat head, the
# deepest point just behind the gills, tapering to a slim tail stock.
LOFT = [(-0.27, 0.012, 0.004, 0.018), (-0.265, 0.024, 0.009, 0.019), (-0.25, 0.032, 0.014, 0.021), (-0.22, 0.036, 0.019, 0.024),
        (-0.18, 0.038, 0.025, 0.027), (-0.13, 0.037, 0.029, 0.03), (-0.08, 0.034, 0.03, 0.031), (-0.02, 0.029, 0.028, 0.03),
        (0.04, 0.023, 0.024, 0.029), (0.1, 0.016, 0.018, 0.028), (0.15, 0.01, 0.012, 0.027), (0.18, 0.007, 0.009, 0.027),
        (0.2, 0.005, 0.007, 0.028)]
SPINE = [-0.22, -0.13, -0.05, 0.03, 0.1, 0.16, 0.2]


def loft_at(y):
    for a, b in zip(LOFT, LOFT[1:]):
        if y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            return tuple(lerp(p, q, t) for p, q in zip(a[1:], b[1:]))
    return LOFT[-1][1:]


def spine_weights(y):
    """Weights between the two spine joints either side of y."""
    if y <= SPINE[0]:
        return {'spine_0': 1.0}
    for i in range(len(SPINE) - 1):
        if y <= SPINE[i + 1]:
            t = (y - SPINE[i]) / (SPINE[i + 1] - SPINE[i])
            return {f'spine_{i}': 1 - t, f'spine_{i + 1}': t}
    return {f'spine_{len(SPINE) - 1}': 1.0}


def build_body(mb):
    mb.begin()
    sides = 14
    ys = [NOSE + (LOFT[-1][0] - NOSE) * (i / 26) ** 1.1 for i in range(27)]
    rings = []
    for y in ys:
        w, h, cz = loft_at(y)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            # Flat-bellied: the lower half squashed.
            c = math.cos(a)
            z = cz + h * c * (1.0 if c > 0 else 0.75)
            ring.append(mb.vert((w * math.sin(a), y, z), spine_weights(y)))
        rings.append(ring)

    def mat(i, k):
        up = math.cos(2 * math.pi * (k + 0.5) / sides)
        if up < -0.3:
            return 'Belly'
        if up < 0.25:
            return 'Flank'
        return 'Spot' if rnd.random() < 0.025 and 3 < i < 22 else 'Back'
    mb.ring_loft(rings, mat)
    mb.end()


def fin(mb, root_a, root_b, tip, thick, mat, tip_mat=None, tip_from=0.7, sag=None):
    """A thin fin: a triangle from its root (a to b along the body) to its tip, a little thick at the
    root; `tip_mat` colours the part past `tip_from` of the way to the tip."""
    mb.begin()
    a, b, t = Vector(root_a), Vector(root_b), Vector(tip)
    # The trailing edge curves in a little (sag), like a real fin's.
    mid = (b + t) / 2 + (sag if sag is not None else Vector((0, 0, 0)))
    side = (b - a).cross(t - a).normalized()
    pts = [a, b, mid, t]
    w = [spine_weights(p.y) for p in pts]
    up = [mb.vert(p + side * thick * (1 if i < 2 else 0.4), w[i]) for i, p in enumerate(pts)]
    dn = [mb.vert(p - side * thick * (1 if i < 2 else 0.4), w[i]) for i, p in enumerate(pts)]
    # Split near the tip so it can be coloured.
    ta = mb.vert(a.lerp(t, tip_from) + side * thick * 0.3, spine_weights(a.lerp(t, tip_from).y))
    tb = mb.vert(mid.lerp(t, tip_from) + side * thick * 0.3, spine_weights(mid.lerp(t, tip_from).y))
    ua = mb.vert(a.lerp(t, tip_from) - side * thick * 0.3, spine_weights(a.lerp(t, tip_from).y))
    ub = mb.vert(mid.lerp(t, tip_from) - side * thick * 0.3, spine_weights(mid.lerp(t, tip_from).y))
    tm = tip_mat or mat
    mb.face([up[0], up[1], up[2], tb, ta], mat)
    mb.face([ta, tb, up[3]], tm)
    mb.face([dn[0], ua, ub, dn[2], dn[1]], mat)
    mb.face([ua, dn[3], ub], tm)
    mb.face([up[0], ta, ua, dn[0]], mat)
    mb.face([ta, up[3], dn[3], ua], tm)
    mb.face([up[3], tb, ub, dn[3]], tm)
    mb.face([tb, up[2], dn[2], ub], mat)
    mb.face([up[2], up[1], dn[1], dn[2]], mat)
    mb.face([up[1], up[0], dn[0], dn[1]], mat)
    mb.end()


def build_fins(mb):
    top = lambda y: loft_at(y)[2] + loft_at(y)[1]  # noqa: E731
    # First dorsal, set well back (its front over the pectorals' rear tips), bright white tip.
    fin(mb, (0, -0.07, top(-0.07) - 0.004), (0, -0.015, top(-0.015) - 0.004), (0, -0.005, top(-0.04) + 0.05), 0.003, 'Fin', 'Tip', 0.6,
        Vector((0, -0.008, -0.006)))
    # Second dorsal, nearly as big, plain.
    fin(mb, (0, 0.085, top(0.085) - 0.003), (0, 0.12, top(0.12) - 0.003), (0, 0.13, top(0.1) + 0.028), 0.0025, 'Fin', None, 0.8,
        Vector((0, -0.004, -0.004)))
    # Tail: a long upper lobe, its tip white, and a small lower lobe.
    tz = loft_at(0.2)[2]
    fin(mb, (0, 0.17, tz + 0.004), (0, 0.205, tz), (0, 0.28, tz + 0.05), 0.0025, 'Fin', 'Tip', 0.62, Vector((0, -0.01, -0.006)))
    fin(mb, (0, 0.18, tz - 0.004), (0, 0.205, tz - 0.002), (0, 0.235, tz - 0.035), 0.002, 'Fin', 'Tip', 0.85, Vector((0, -0.004, 0.004)))
    # Pectorals: broad, swept back, held out a little down; pelvics and anal fin small.
    for s in (1, -1):
        fin(mb, (0.03 * s, -0.16, 0.012), (0.026 * s, -0.11, 0.012), (0.1 * s, -0.075, 0.0), 0.003, 'Fin', None, 0.9, Vector((0, -0.01, 0)))
        fin(mb, (0.018 * s, 0.02, 0.01), (0.014 * s, 0.05, 0.011), (0.045 * s, 0.06, 0.004), 0.002, 'Fin', None, 0.9)
    fin(mb, (0, 0.09, 0.012), (0, 0.115, 0.014), (0, 0.125, -0.006), 0.002, 'Fin', None, 0.9)


def build_eyes(mb):
    for s in (1, -1):
        mb.begin()
        c = Vector((0.03 * s, -0.215, 0.03))
        w = spine_weights(c.y)
        n = 8
        ring = [mb.vert(c + Vector((0.002 * s, 0.005 * math.cos(2 * math.pi * k / n), 0.0032 * math.sin(2 * math.pi * k / n))), w) for k in range(n)]
        out = mb.vert(c + Vector((0.004 * s, 0, 0)), w)
        inn = mb.vert(c - Vector((0.002 * s, 0, 0)), w)
        for k in range(n):
            k2 = (k + 1) % n
            mb.face([ring[k], ring[k2], out], 'Eye')
            mb.face([ring[k2], ring[k], inn], 'Eye')
        mb.end()


def joints():
    out = {}
    for i, y in enumerate(SPINE):
        w, h, cz = loft_at(y)
        out[f'spine_{i}'] = Vector((0, y, cz))
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = flat_materials(COLORS, 0.6)
    rig = build_free_rig('Whitetip', joints())
    mb = MeshBuilder()
    build_body(mb)
    build_fins(mb)
    build_eyes(mb)
    build_skinned('Whitetip', rig, mb, COLORS, mats)
    rig['joints'] = {k: gltf_point(v) for k, v in joints().items()}
    rig['length'] = round(TAIL - NOSE, 4)
    export_skinned(OUT)


if __name__ == '__main__':
    main()

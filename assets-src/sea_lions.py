"""Generate Galapagos sea lions (Zalophus wollebaeki) for the beach stage -> src/assets/sea-lions.glb:
a cow, a territorial bull and a pup, each one skinned mesh on a free rig the game poses
(src/beach/sealions.ts). Checked against iNaturalist photos of the species (lying flat on sand,
propped up on the fore-flippers with the neck raised, swimming, pups in a heap on lava).

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/sea_lions.py

What makes it read as this species rather than a generic seal:
- An eared seal: long, thick, mobile neck; tiny rolled ear flaps behind the eyes; a dog-like
  pointed muzzle with fat whisker pads, a black nose, and big dark eyes.
- Long, naked, leathery fore-flippers coming out of the chest low down (it walks on them), and
  hind flippers that trail back as a fan with the toe tips scalloped.
- Cows: sleek, golden-tan to grey-brown dry (dark chocolate wet), paler on the belly and muzzle.
  Bulls: half again as long, dark, with a massive folded neck and chest and a raised forehead
  (the sagittal crest). Pups: small, chubby, dark brown, with a big head and eyes.

Sizes keep to the game's scale, where animals are about a fifth of real size against the 0.19 m
iguana (as the tortoise): a cow 0.30 m (1.5 m real), a bull 0.44 m (2.2 m), a pup 0.17 m (0.85 m).

Conventions (Blender space, Z up, exported Y up): lying belly down in the rest pose, facing -Y (+Z
in glTF), belly on z = 0, the head held up a little. Bones (unparented; the game poses each in the
model's space): hips, spine, chest, neck, head, jaw, and per side arm, fore, hand (fore-flipper:
shoulder to elbow, elbow to wrist, the blade) and thigh, foot (hind flipper). Extras on each
armature, in glTF space: `joints` (each bone's head), `length`, `height` (top of the back at rest).
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

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'sea-lions.glb')

# Body sections, snout to rump, in body lengths: (y, half width, top z, bottom z). The cow's.
COW = [
    (-0.507, 0.007, 0.150, 0.140),
    (-0.498, 0.018, 0.159, 0.128),
    (-0.484, 0.028, 0.166, 0.121),
    (-0.465, 0.035, 0.174, 0.118),
    (-0.445, 0.041, 0.185, 0.119),
    (-0.425, 0.049, 0.200, 0.122),
    (-0.405, 0.055, 0.210, 0.123),
    (-0.385, 0.057, 0.213, 0.121),
    (-0.365, 0.057, 0.208, 0.113),
    (-0.343, 0.060, 0.201, 0.099),
    (-0.312, 0.067, 0.193, 0.081),
    (-0.272, 0.081, 0.188, 0.059),
    (-0.222, 0.099, 0.187, 0.035),
    (-0.162, 0.117, 0.188, 0.012),
    (-0.092, 0.129, 0.186, 0.004),
    (-0.012, 0.133, 0.180, 0.004),
    (0.068, 0.129, 0.170, 0.004),
    (0.148, 0.117, 0.154, 0.005),
    (0.220, 0.098, 0.133, 0.008),
    (0.288, 0.075, 0.106, 0.012),
    (0.345, 0.052, 0.080, 0.015),
    (0.392, 0.031, 0.057, 0.019),
    (0.425, 0.012, 0.040, 0.025),
]
# Where the joints sit, in body lengths (Blender space, y forward is negative).
JOINTS = {
    'hips': ((0, 0.38, 0.040), (0, 0.12, 0.090)),
    'spine': ((0, 0.12, 0.090), (0, -0.10, 0.100)),
    'chest': ((0, -0.10, 0.100), (0, -0.27, 0.125)),
    'neck': ((0, -0.27, 0.125), (0, -0.37, 0.160)),
    'head': ((0, -0.37, 0.160), (0, -0.50, 0.150)),
    'jaw': ((0, -0.405, 0.132), (0, -0.50, 0.132)),
}
for s, side in ((1, 'L'), (-1, 'R')):
    JOINTS['arm_' + side] = ((0.07 * s, -0.16, 0.065), (0.112 * s, -0.135, 0.024))
    JOINTS['fore_' + side] = ((0.112 * s, -0.135, 0.024), (0.142 * s, -0.095, 0.009))
    JOINTS['hand_' + side] = ((0.142 * s, -0.095, 0.009), (0.25 * s, 0.03, 0.004))
    JOINTS['thigh_' + side] = ((0.028 * s, 0.30, 0.036), (0.036 * s, 0.385, 0.019))
    JOINTS['foot_' + side] = ((0.036 * s, 0.385, 0.019), (0.07 * s, 0.53, 0.004))

ALONG = [(-0.385, 'head'), (-0.335, 'neck'), (-0.26, 'neck'), (-0.18, 'chest'), (-0.11, 'chest'), (-0.01, 'spine'), (0.09, 'spine'), (0.21, 'hips')]

VARIANTS = {
    'Cow': dict(length=0.30, seed=3, colours={
        'Coat': '#9c8569', 'Back': '#86735d', 'Belly': '#b9a386', 'Muzzle': '#ae9a80',
        'Flipper': '#3b322b', 'Nose': '#26201c', 'Eye': '#0b0908', 'Shine': '#ffffff', 'Mouth': '#5a2c2a'}),
    'Bull': dict(length=0.44, seed=5, colours={
        'Coat': '#6f5e4d', 'Back': '#5e5043', 'Belly': '#8a7660', 'Muzzle': '#857360',
        'Flipper': '#2f2823', 'Nose': '#1e1a17', 'Eye': '#0b0908', 'Shine': '#ffffff', 'Mouth': '#5a2c2a'}),
    'Pup': dict(length=0.17, seed=7, colours={
        'Coat': '#55463a', 'Back': '#463a30', 'Belly': '#6c5a49', 'Muzzle': '#7a6652',
        'Flipper': '#2c2520', 'Nose': '#1e1a17', 'Eye': '#0b0908', 'Shine': '#ffffff', 'Mouth': '#5a2c2a'}),
}


def sections(kind):
    out = []
    for y, w, top, bot in COW:
        if kind == 'Bull':
            # A massive neck and chest, the forehead raised in a crest, a broader muzzle.
            neck = math.exp(-((y + 0.27) / 0.11) ** 2)
            w *= 1 + 0.42 * neck
            top += 0.05 * neck
            bot -= 0.025 * neck * (y < -0.25)
            crest = math.exp(-((y + 0.395) / 0.03) ** 2)
            top += 0.03 * crest
            if y < -0.44:
                w *= 1.15
        elif kind == 'Pup':
            # A big round head on a short neck, a chubby body.
            if y < -0.3:
                k = 1.25
                cy, cz = -0.34, 0.15
                y = cy + (y - cy) * 1.05
                w *= k
                top = cz + (top - cz) * k
                bot = cz + (bot - cz) * k
            else:
                w *= 1.1
                top *= 1.06
        out.append((y, w, top, bot))
    return out


def catmull(points, t):
    """Catmull-Rom through `points` (lists of numbers), t from 0 to 1 over the whole run."""
    n = len(points) - 1
    f = min(n - 1e-9, max(0.0, t * n))
    i = int(f)
    u = f - i
    p0 = points[max(i - 1, 0)]
    p1, p2 = points[i], points[i + 1]
    p3 = points[min(i + 2, n)]
    return [0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u ** 3)
            for a, b, c, d in zip(p0, p1, p2, p3)]


# Angles round a section (0 on top, going toward +X): even steps, with two close together along
# each side of the mouth so it reads as a thin line when shut and opens up as the jaw drops.
MOUTH_A = 1.86
ANGLES = sorted({round(2 * math.pi * k / 22, 4) for k in range(22)} - {round(2 * math.pi * k / 22, 4) for k in (6, 16)}
                | {MOUTH_A - 0.05, MOUTH_A + 0.05, 2 * math.pi - MOUTH_A - 0.05, 2 * math.pi - MOUTH_A + 0.05})


def build_body(mb, kind, L, seed):
    secs = sections(kind)
    noise = noise3(seed)
    rnd = random.Random(seed)
    n = 56
    rings, ys = [], []
    for i in range(n + 1):
        y, w, top, bot = catmull([list(s) for s in secs], i / n)
        ys.append(y)
        cz, h = (top + bot) / 2, (top - bot) / 2
        ring = []
        for a in ANGLES:
            c, s = math.cos(a), math.sin(a)
            # Rounded-off box: fuller flanks, a flatter belly that rests on the ground.
            sx = math.copysign(abs(s) ** 0.85, s)
            p = Vector((w * sx, y, cz + h * c * (1.0 if c > 0 else 0.9)))
            # Uneven: a lumpy, living outline, and folds of skin round the neck (deep on a bull).
            fold = (0.05 if kind == 'Bull' else 0.018) * math.exp(-((y + 0.3) / 0.07) ** 2) * math.sin(y * 260 + 1.3) * (c > -0.4)
            k = 1 + 0.03 * noise(p, 0.05) + fold
            p = Vector((p.x * k, y, cz + (p.z - cz) * k))
            if y > -0.25:
                p.z = max(p.z, 0.004)
            # Jaw: the lower lip and chin under the mouth line, from the hinge forward.
            lower = MOUTH_A < a < 2 * math.pi - MOUTH_A
            along = blend(y, ALONG)
            if lower and y < -0.4:
                j = min(1.0, (-0.4 - y) / 0.03)
                along = {b: v * (1 - j) for b, v in along.items()}
                along['jaw'] = along.get('jaw', 0) + j
            ring.append(mb.vert(p * L, along))
        rings.append(ring)

    def mat(i, k):
        y = ys[i]
        a = (ANGLES[k] + ANGLES[(k + 1) % len(ANGLES)]) / 2 if k + 1 < len(ANGLES) else (ANGLES[k] + 2 * math.pi) / 2
        c = math.cos(a)
        mid = Vector((math.sin(a) * 0.1, y, c * 0.1))
        if y < -0.498:
            return 'Nose'
        if y < -0.415 and (abs(a - MOUTH_A) < 0.051 or abs(a - (2 * math.pi - MOUTH_A)) < 0.051):
            return 'Mouth'
        if y < -0.445 and c < 0.75:
            return 'Muzzle'
        patch = 0.22 * noise(mid, 0.12)
        if c + patch < -0.45:
            return 'Belly'
        if c + patch > 0.72 and y > -0.38:
            return 'Back'
        return 'Coat'
    start = mb.mark()
    mb.loft(rings, mat, cap_start=(Vector((0, ys[0] - 0.003, secs[0][2] - 0.004)) * L, {'head': 1.0}),
            cap_end=(Vector((0, ys[-1] + 0.004, secs[-1][3] + 0.006)) * L, {'hips': 1.0}))
    mb.outward(start)
    return secs


def section_at(secs, y):
    """The body section (y, half width, top, bottom) at y, on the same curve the body is lofted along."""
    lo, hi = 0.0, 1.0
    for _ in range(40):
        t = (lo + hi) / 2
        if catmull([list(s) for s in secs], t)[0] < y:
            lo = t
        else:
            hi = t
    return catmull([list(s) for s in secs], lo)


def build_face(mb, kind, L, secs):
    head = {'head': 1.0}
    # Where the head's side is at the eyes.
    ey = -0.423 if kind != 'Pup' else -0.43
    _, w, top, bot = section_at(secs, ey)
    r = 0.019 if kind == 'Pup' else 0.0155
    for s in (1, -1):
        # Big dark eyes, set well forward and up, bulging a little.
        c = Vector((s * w * 0.8, ey, bot + (top - bot) * 0.66))
        out = Vector((s * 0.85, -0.45, 0.28)).normalized()
        side = out.cross(Vector((0, 0, 1))).normalized()
        up = side.cross(out).normalized()
        mb.ellipsoid(c * L, (r * 1.2 * L, r * L, r * 0.75 * L), head, 'Eye', rings=5, sides=8, axes=(side, up, out))
        mb.ellipsoid((c + out * r * 0.62 + up * r * 0.35 + side * r * 0.25 * s) * L, (r * 0.22 * L,) * 3, head, 'Shine', rings=3, sides=5)
        # Ears: tiny rolled flaps behind the eyes, angled back and down.
        _, ew, etop, ebot = section_at(secs, -0.372)
        e0 = Vector((s * ew * 0.82, -0.372, etop - 0.3 * (etop - ebot)))
        e1 = e0 + Vector((s * 0.012, 0.022, -0.012))
        mb.paddle([e0 * L, (e0 + (e1 - e0) * 0.5) * L, e1 * L], [0.0055 * L, 0.0045 * L, 0.0015 * L], [0.004 * L, 0.0035 * L, 0.001 * L],
                  lambda t: head, 'Back', Vector((s, 0, 0.3)).normalized(), sides=6)
        # Nostrils: two dark slits on the tip of the nose.
        _, nw, ntop, nbot = section_at(secs, -0.502)
        mb.ellipsoid(Vector((s * 0.006, -0.503, ntop - 0.006)) * L, (0.004 * L, 0.003 * L, 0.0022 * L), head, 'Nose', rings=3, sides=6)
        # Whisker pads: a row of pale bumps along each side of the muzzle.
        for k in range(3):
            y = -0.488 + 0.012 * k
            _, pw, ptop, pbot = section_at(secs, y)
            p = Vector((s * pw * 0.88, y, pbot + 0.35 * (ptop - pbot)))
            mb.ellipsoid(p * L, (0.006 * L, 0.006 * L, 0.0045 * L), head, 'Muzzle', rings=3, sides=6)


def flipper_weights(names):
    def f(t):
        # Shoulder to elbow, elbow to wrist, the blade.
        return blend(t, [(0.0, names[0]), (0.22, names[0]), (0.34, names[1]), (0.45, names[1]), (0.55, names[2])])
    return f


def build_flippers(mb, kind, L):
    up = Vector((0, 0, 1))
    for s, side in ((1, 'L'), (-1, 'R')):
        sh, el = (Vector(p) for p in JOINTS['arm_' + side])
        wr = Vector(JOINTS['fore_' + side][1])
        tip = Vector(JOINTS['hand_' + side][1])
        blade = tip - wr
        # The fore-flipper: thick and fleshy where it leaves the body, then a long naked blade,
        # broadest past the wrist, its leading edge thick, rounding off to the tip.
        path = [sh, sh + (el - sh) * 0.6, el, el + (wr - el) * 0.5, wr, wr + blade * 0.3, wr + blade * 0.6, wr + blade * 0.85, tip]
        widths = [0.032, 0.034, 0.033, 0.034, 0.037, 0.042, 0.039, 0.03, 0.012]
        thick = [0.03, 0.026, 0.02, 0.014, 0.01, 0.007, 0.005, 0.004, 0.002]
        if kind == 'Pup':
            widths = [w * 1.1 for w in widths]
        mb.paddle([p * L for p in path], [w * L for w in widths], [t * L for t in thick], flipper_weights(('arm_' + side, 'fore_' + side, 'hand_' + side)),
                  'Flipper', up, sides=10)
        # Hind flipper: out of the rump, a fan with the toe tips scalloped.
        a0, a1 = (Vector(p) for p in JOINTS['thigh_' + side])
        b1 = Vector(JOINTS['foot_' + side][1])
        foot = b1 - a1
        path = [a0, a1, a1 + foot * 0.3, a1 + foot * 0.6, a1 + foot * 0.85, b1]
        widths = [0.024, 0.02, 0.024, 0.034, 0.044, 0.046]
        thick = [0.02, 0.012, 0.006, 0.004, 0.003, 0.002]
        mb.paddle([p * L for p in path], [w * L for w in widths], [t * L for t in thick],
                  lambda t, side=side: blend(t, [(0.0, 'thigh_' + side), (0.25, 'thigh_' + side), (0.4, 'foot_' + side)]), 'Flipper', up, sides=10)
        across = foot.cross(up).normalized()
        for k in range(5):
            u = (k - 2) / 2
            p = b1 + across * (u * 0.038) - foot.normalized() * (0.004 + 0.006 * (1 - u * u))
            mb.ellipsoid(p * L, (0.008 * L, 0.012 * L, 0.0025 * L), {'foot_' + side: 1.0}, 'Flipper', rings=3, sides=6,
                         axes=(across, foot.normalized(), up))


def build(kind):
    v = VARIANTS[kind]
    L = v['length']
    colours = {k: srgb(c) for k, c in v['colours'].items()}
    mats = flat_materials({k: c for k, c in colours.items()}, 0.75)
    for m in mats.values():
        m.name = f'{kind}{m.name}'
    rig = free_rig('SeaLion' + kind, {b: (Vector(h) * L, Vector(t) * L) for b, (h, t) in JOINTS.items()})
    mb = Builder()
    secs = build_body(mb, kind, L, v['seed'])
    build_face(mb, kind, L, secs)
    build_flippers(mb, kind, L)
    skin('SeaLion' + kind, rig, mb, mats)
    rig['length'] = L
    rig['height'] = max(s[2] for s in secs) * L
    return rig


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for kind in VARIANTS:
        build(kind)
    export(os.path.abspath(OUT))
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

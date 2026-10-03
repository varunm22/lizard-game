"""Generate the marine iguana look for the player -> src/assets/marine_iguana.glb.

    python3 assets-src/marine_iguana.py

Same armature, clips and bone positions as assets-src/lizard.py (the game's spine fit, leg reach,
colliders and gait speeds all assume them), so this script reuses that one and only swaps the look:
a blunt, salt-crusted head covered in knobbly scales, a spiky crest from the nape to the tail, a
tall flattened tail, stocky clawed legs, and charcoal skin blotched with rust red and moss green.

The centre heights in PROFILE must stay as in lizard.py: the bones sit on them.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import lizard as base  # noqa: E402
from lizard import blob, leg_name, leg_points, profile_at, tube  # noqa: E402

base.OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'marine_iguana.glb')

# (y, half_width, half_height, centre_z), snout at -Y. A broad blunt head with heavy jowls, barely
# any neck, and a tail that is taller than it is wide.
base.PROFILE = [
    (-0.064, 0.0044, 0.0040, 0.0080),
    (-0.061, 0.0078, 0.0062, 0.0084),
    (-0.056, 0.0100, 0.0076, 0.0090),
    (-0.048, 0.0114, 0.0084, 0.0096),
    (-0.040, 0.0110, 0.0078, 0.0094),
    (-0.033, 0.0090, 0.0062, 0.0086),
    (-0.025, 0.0096, 0.0064, 0.0082),
    (-0.012, 0.0114, 0.0068, 0.0080),
    (0.000, 0.0112, 0.0066, 0.0078),
    (0.010, 0.0090, 0.0060, 0.0076),
    (0.020, 0.0058, 0.0054, 0.0072),
    (0.035, 0.0034, 0.0048, 0.0064),
    (0.055, 0.0021, 0.0040, 0.0054),
    (0.075, 0.0012, 0.0026, 0.0044),
    (0.092, 0.0003, 0.0006, 0.0036),
]

base.COLORS = {
    'Skin': base.srgb('#474a4f'),
    'Belly': base.srgb('#5d5952'),
    'Rust': base.srgb('#a3462e'),
    'Moss': base.srgb('#5b7651'),
    'Salt': base.srgb('#dcd8cd'),
    'Crest': base.srgb('#34363a'),
    'Claw': base.srgb('#cfc6b2'),
    'Eye': base.srgb('#151a1c'),
    'Shine': base.srgb('#ffffff'),
}


def surface_z(y, x):
    """Height of the back's surface at (x, y), on the body ring that build_body makes."""
    hw, hh, cz = profile_at(y)
    s = max(-1.0, min(1.0, x / hw))
    return cz + hh * math.cos(math.asin(s))


def mottle(y, a, seed):
    """Smooth, irregular -1..1 noise over the skin (y along the body, a around it), for blotches."""
    return (
        math.sin(y * 400 + seed) * 0.45
        + math.sin(y * 230 + a * 2.3 + seed * 2.1) * 0.35
        + math.sin(a * 3.7 - y * 150 + seed * 3.3) * 0.3
    )


# Finer than the cartoon lizard's mesh so the blotches and salt have ragged, not blocky, edges.
base.STEPS, base.RING = 80, 20


def build_body(mb):
    steps, ring_n = base.STEPS, base.RING
    y0, y1 = base.PROFILE[0][0], base.PROFILE[-1][0]
    rings = []
    for i in range(steps):
        y = base.lerp(y0, y1, i / (steps - 1))
        hw, hh, cz = profile_at(y)
        ring = []
        for k in range(ring_n):
            a = 2 * math.pi * k / ring_n
            s, c = math.sin(a), math.cos(a)
            z = cz + hh * c * (1.0 if c > 0 else 0.7)
            ring.append(mb.add_vert((hw * s, y, z), ('spine', y)))
        rings.append(ring)

    for i in range(steps - 1):
        y = base.lerp(y0, y1, (i + 0.5) / (steps - 1))
        for k in range(ring_n):
            a = 2 * math.pi * (k + 0.5) / ring_n
            c, s = math.cos(a), abs(math.sin(a))
            if c < -0.45:
                mat = 'Belly'
            elif y < -0.042 and c > 0.6 and mottle(y, a, 1.0) - (y + 0.04) * 40 > 0.55:
                mat = 'Salt'  # the crust of salt they sneeze onto their heads, thickest on the snout
            elif -0.034 < y < 0.03 and s > 0.35 and mottle(y, a, 4.0) > 0.3:
                mat = 'Rust'
            elif -0.036 < y < 0.02 and c > 0.2 and mottle(y, a, 7.0) > 0.5:
                mat = 'Moss'
            elif y > 0.03 and int(y / 0.012) % 2 == 1 and c > 0.2:
                mat = 'Crest'  # faint bands down the tail
            else:
                mat = 'Skin'
            k2 = (k + 1) % ring_n
            mb.add_face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat)

    # A flat, blunt snout and a pointed tail tip.
    for ring, y, flip in ((rings[0], y0 - 0.0012, True), (rings[-1], y1 + 0.0005, False)):
        cz = profile_at(y0 if flip else y1)[2]
        tip = mb.add_vert((0, y, cz), ('spine', y))
        for k in range(ring_n):
            k2 = (k + 1) % ring_n
            face = [ring[k], tip, ring[k2]] if flip else [ring[k2], tip, ring[k]]
            mb.add_face(face, 'Skin')

    build_crest(mb)
    build_head_scales(mb)


def build_crest(mb):
    """Spikes along the back from the nape to near the tail tip, longest at the neck."""
    y, start, end = -0.038, -0.038, 0.084
    while y < end:
        t = (y - start) / (end - start)
        length = 0.0026 if t < 0.25 else 0.0019 if t < 0.5 else 0.0013 if t < 0.8 else 0.0008
        size = base.lerp(0.0042, 0.0010, t) if y < 0.0 else base.lerp(0.0030, 0.0010, t)
        top = surface_z(y, 0.0) - 0.0004
        half_w = 0.00045
        part = ('spine', y)
        corners = [
            mb.add_vert((-half_w, y - length / 2, top), part),
            mb.add_vert((half_w, y - length / 2, top), part),
            mb.add_vert((half_w, y + length / 2, top), part),
            mb.add_vert((-half_w, y + length / 2, top), part),
        ]
        tip = mb.add_vert((0, y + length * 0.6, top + size), ('spine', y))  # swept back
        for a, b in zip(corners, corners[1:] + corners[:1]):
            mb.add_face([a, b, tip], 'Crest')
        y += length * 1.15


def build_head_scales(mb):
    """Knobbly conical scales over the top and sides of the head, the top ones crusted with salt."""
    for y, x, r in (
        (-0.058, 0.0, 0.0019), (-0.057, 0.0042, 0.0014), (-0.053, 0.0018, 0.0016), (-0.052, 0.0060, 0.0013),
        (-0.048, 0.0, 0.0018), (-0.046, 0.0034, 0.0016), (-0.043, 0.0068, 0.0014), (-0.041, 0.0016, 0.0014),
        (-0.039, 0.0052, 0.0013), (-0.061, 0.0024, 0.0012),
    ):
        for side in ((1,) if x == 0 else (1, -1)):
            sx = side * x
            z = surface_z(y, sx)
            mat = 'Salt' if y < -0.044 and abs(x) < 0.005 else 'Skin'
            blob(mb, (sx, y, z - r * 0.35), (r, r, r * 0.8), ('bone', 'head'), mat, 4, 7)
    # Jowl scales: a big round one under each ear, as marine iguanas have.
    for side in (1, -1):
        blob(mb, (side * 0.0106, -0.041, 0.0082), (0.0016, 0.0022, 0.0022), ('bone', 'head'), 'Skin', 4, 8)


def build_legs(mb):
    for front in (True, False):
        for side in (1, -1):
            n = leg_name(side, front)
            root, knee, foot = leg_points(side, front)
            r = 0.0030 if front else 0.0034
            upper, lower = ('bone', 'upper_' + n), ('bone', 'lower_' + n)
            tube(mb, root, knee, r, r * 0.85, upper, upper, 'Skin')
            tube(mb, knee, foot, r * 0.85, r * 0.65, lower, lower, 'Skin')
            fx, fy, fz = foot
            # The pad is what the game plants (its lowest 1.5 mm is the sole), so it matches the
            # cartoon lizard's; the toes leave it above that, or they'd drag the planted point forward.
            cx, cy = fx + side * 0.0015, fy - 0.0012
            blob(mb, (cx, cy, 0.0019), (0.0032, 0.0034, 0.0018), lower, 'Skin')
            # Four long toes fanned forward and out, each ending in a pale hooked claw.
            for t in (-0.15, 0.35, 0.85, 1.4):
                dx, dy = side * math.sin(t), -math.cos(t)
                a = (cx + dx * 0.0022, cy + dy * 0.0022, 0.0023)
                b = (cx + dx * 0.0044, cy + dy * 0.0044, 0.0022)
                c = (cx + dx * 0.0062, cy + dy * 0.0062, 0.0018)
                tube(mb, a, b, 0.0007, 0.00055, lower, lower, 'Skin', sides=5)
                tube(mb, b, c, 0.00045, 0.0001, lower, lower, 'Claw', sides=4)


def build_eyes(mb):
    # Smaller, deeper-set eyes than the cartoon lizard's, under a heavy brow.
    for side in (1, -1):
        c = (side * 0.0100, -0.051, 0.0122)
        blob(mb, c, (0.0029, 0.0029, 0.0029), ('bone', 'head'), 'Eye')
        blob(mb, (c[0] + side * 0.0014, c[1] - 0.0016, c[2] + 0.0012), (0.0007, 0.0007, 0.0007), ('bone', 'head'), 'Shine', 4, 6)
        blob(mb, (side * 0.0086, -0.0512, 0.0150), (0.0030, 0.0034, 0.0012), ('bone', 'head'), 'Skin', 4, 8)


base.build_body = build_body
base.build_legs = build_legs
base.build_eyes = build_eyes

if __name__ == '__main__':
    base.main()

"""Generate the player as a marine iguana -> src/assets/marine_iguana.glb.

    python3 assets-src/marine_iguana.py

Reuses assets-src/lizard.py's armature, skinning and clips (same bone names, gait strides and
timing, so LIZARD_GAIT_SPEED holds) and replaces its proportions and look with a marine iguana's:

- Proportions: snout-to-vent length matches the cartoon lizard's, so the physics capsule (which
  covers snout to hips) still fits, but the head is a short, blunt quarter of it, the neck thick,
  the forelegs set just behind the head, and the laterally flattened tail 1.5x the body.
- Skin: one painted texture (scales, colour, salt) instead of per-face colours, so the patterning
  is far finer than the mesh at the cost of a single small texture.

Where the game needs points the rig has no joint for (snout tip, tail tip, where the feet stand),
the script stores them on the armature as glTF extras; src/player/lizardModel.ts reads them.
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
import lizard as base  # noqa: E402
from lizard import blob, leg_name, lerp  # noqa: E402

base.OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'marine_iguana.glb')

# ---------------------------------------------------------------------------------------------
# Proportions (Blender space: snout at -Y, metres). Snout to vent 0.074 m, tail 0.114 m.
# ---------------------------------------------------------------------------------------------
# (y, half_width, half_height, centre_z). The head is about as wide as it is long, with heavy
# jowls; the tail is taller than wide from its base.
base.PROFILE = [
    (-0.0645, 0.0042, 0.0034, 0.0078),
    (-0.0630, 0.0059, 0.0048, 0.0081),
    (-0.0605, 0.0069, 0.0057, 0.0085),
    (-0.0570, 0.0075, 0.0061, 0.0087),
    (-0.0515, 0.0078, 0.0060, 0.0088),
    (-0.0470, 0.0073, 0.0056, 0.0087),
    (-0.0420, 0.0068, 0.0054, 0.0085),
    (-0.0360, 0.0076, 0.0057, 0.0084),
    (-0.0300, 0.0092, 0.0062, 0.0083),
    (-0.0180, 0.0104, 0.0066, 0.0081),
    (-0.0050, 0.0102, 0.0064, 0.0080),
    (0.0040, 0.0084, 0.0058, 0.0078),
    (0.0110, 0.0058, 0.0054, 0.0075),
    (0.0300, 0.0038, 0.0050, 0.0068),
    (0.0550, 0.0028, 0.0044, 0.0060),
    (0.0800, 0.0019, 0.0036, 0.0053),
    (0.1050, 0.0011, 0.0024, 0.0046),
    (0.1240, 0.0003, 0.0006, 0.0042),
]
base.SPINE = [
    ('head', -0.0645, -0.046, None),
    ('neck', -0.046, -0.034, None),
    ('chest', -0.034, -0.008, None),
    ('hips', -0.008, 0.010, None),
    ('tail1', 0.010, 0.039, None),
    ('tail2', 0.039, 0.067, None),
    ('tail3', 0.067, 0.096, None),
    ('tail4', 0.096, 0.124, None),
]
base.SHOULDER_Y, base.HIP_Y = -0.031, 0.008
base.LEG_ATTACH_X, base.LEG_ATTACH_Z = 0.0080, 0.0066
base.STEPS, base.RING = 110, 24
SNOUT_TIP = -0.0657  # the blunt snout's fan closes just ahead of the first cross-section


def leg_points(side, front):
    """Front legs as in lizard.py; the hind legs are longer and splay wider, as an iguana's do."""
    y = base.SHOULDER_Y if front else base.HIP_Y
    reach = -0.004 if front else 0.004
    root = (side * base.LEG_ATTACH_X, y, base.LEG_ATTACH_Z)
    if front:
        return root, (side * 0.0168, y + reach * 0.3, 0.0090), (side * 0.0203, y + reach, 0.0016)
    return root, (side * 0.0186, y + reach * 0.3, 0.0098), (side * 0.0228, y + reach, 0.0016)


base.leg_points = leg_points


def roundness(y):
    """Superellipse exponent of the cross-section: a boxy head, rounded body, keeled tail."""
    keys = ((-0.0645, 2.7), (-0.046, 2.7), (-0.034, 2.3), (0.004, 2.3), (0.03, 1.8), (0.124, 1.7))
    for (y0, a), (y1, b) in zip(keys, keys[1:]):
        if y0 <= y <= y1:
            return lerp(a, b, (y - y0) / (y1 - y0))
    return keys[0][1] if y < keys[0][0] else keys[-1][1]


def ring_point(y, a):
    """Point on the body surface at distance y along it and angle a around it (0 = top, + = left)."""
    hw, hh, cz = base.profile_at(y)
    e = 2 / roundness(y)
    s, c = math.sin(a), math.cos(a)
    x = hw * math.copysign(abs(s) ** e, s)
    z = cz + hh * math.copysign(abs(c) ** e, c) * (1.0 if c > 0 else 0.7)
    return x, z


def surface_z(y, x):
    """Height of the back at (x, y)."""
    hw, hh, cz = base.profile_at(y)
    n = roundness(y)
    s = min(1.0, abs(x) / hw) ** (n / 2)
    return cz + hh * (1 - s * s) ** (0.5 * 2 / n)


# ---------------------------------------------------------------------------------------------
# Texture atlas (Blender convention: row 0 is the bottom). Rows 256-511 wrap the body (columns
# run snout to tail tip, rows go round from the spine), rows 0-223 wrap the legs; a solid patch of
# plain skin serves the small bumps. Each block has a one-texel margin so filtering never bleeds.
# ---------------------------------------------------------------------------------------------
TEX_W, TEX_H = 1024, 512
BODY_ROWS, LIMB_ROWS, LIMB_COLS = (256, 256), (0, 224), 256
SOLID_UV = (640 / TEX_W, 112 / TEX_H)

PALETTE = {
    'skin': (0.255, 0.265, 0.280),
    'dark': (0.165, 0.170, 0.180),
    'light': (0.365, 0.370, 0.375),
    'belly': (0.420, 0.400, 0.370),
    'rust': (0.560, 0.250, 0.165),
    'moss': (0.330, 0.410, 0.300),
    'salt': (0.900, 0.885, 0.850),
}


def body_uv(t, a):
    r0, n = BODY_ROWS
    return ((1 + t * (TEX_W - 2)) / TEX_W, (r0 + 1 + a / (2 * math.pi) * (n - 2)) / TEX_H)


def limb_uv(t, a):
    r0, n = LIMB_ROWS
    return ((1 + t * (LIMB_COLS - 2)) / TEX_W, (r0 + 1 + a / (2 * math.pi) * (n - 2)) / TEX_H)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def waves(y, a, seed, wavelength, around, count=28):
    """Smooth noise (about -1..1) on a cylinder: random plane waves with whole cycles around it."""
    rng = np.random.default_rng(seed)
    out = np.zeros(np.broadcast(y, a).shape)
    for _ in range(count):
        f = 2 * math.pi / wavelength * rng.uniform(-1.4, 1.4)
        k = int(round(around * rng.uniform(-1.5, 1.5)))
        out += np.sin(f * y + k * a + rng.uniform(0, 2 * math.pi))
    return out / math.sqrt(count / 2)


def fbm(y, a, seed, wavelength, around):
    return 0.6 * waves(y, a, seed, wavelength, around) + 0.3 * waves(y, a, seed + 1, wavelength / 2.3, around * 2.3) + 0.15 * waves(
        y, a, seed + 2, wavelength / 5, around * 5)


def scales(y, a, girth, cell, around, seed):
    """Jittered-grid Voronoi cells on a cylinder: (edge darkness 0..1, per-scale shade -1..1).

    `cell` is the scale length along the body; `around` is how many scales make one ring, so the
    scales narrow down the tail into the long rings real tails have.
    """
    rng = np.random.default_rng(seed)
    gy, ga = y / cell, a / (2 * math.pi) * around
    iy, ia = np.floor(gy).astype(int), np.floor(ga).astype(int)
    span = int(iy.max() - iy.min()) + 3
    jitter = rng.uniform(0.1, 0.9, (span, around, 2))
    shade = rng.uniform(-1, 1, (span, around))
    base_iy = iy.min() - 1
    d1 = np.full(gy.shape, np.inf)
    d2 = np.full(gy.shape, np.inf)
    nearest = np.zeros(gy.shape)
    width = girth / around  # metres per cell around the body
    for dy in (-1, 0, 1):
        for da in (-1, 0, 1):
            cy, ca = iy + dy, ia + da
            jy, ja = (cy - base_iy) % span, ca % around
            py, pa = cy + jitter[jy, ja, 0], ca + jitter[jy, ja, 1]
            d = np.hypot((gy - py) * cell, (ga - pa) * width)
            closer = d < d1
            d2 = np.where(closer, d1, np.minimum(d2, d))
            nearest = np.where(closer, shade[jy, ja], nearest)
            d1 = np.where(closer, d, d1)
    edge = 1 - smoothstep(0.0, 0.16 * cell, d2 - d1)
    return edge, nearest


def mix(img, colour, mask):
    return img + (np.asarray(colour) - img) * mask[..., None]


def paint_body():
    rows, cols = BODY_ROWS[1], TEX_W
    t = (np.arange(cols) - 1 + 0.5) / (cols - 2)
    a = (np.arange(rows) - 1 + 0.5) / (rows - 2) * 2 * math.pi
    y0, y1 = SNOUT_TIP, base.PROFILE[-1][0]
    yy = np.broadcast_to(lerp(y0, y1, t)[None, :], (rows, cols))
    aa = np.broadcast_to(a[:, None], (rows, cols))
    prof = np.array([base.profile_at(max(v, base.PROFILE[0][0])) for v in lerp(y0, y1, t)])
    girth = np.broadcast_to((math.pi * (prof[:, 0] + prof[:, 1] * 0.85))[None, :], (rows, cols))
    c = np.cos(aa)  # 1 along the spine, -1 under the belly
    side = 1 - np.abs(c)

    img = np.broadcast_to(np.asarray(PALETTE['skin']), (rows, cols, 3)).copy()
    tone = fbm(yy, aa, 1, 0.02, 2)
    img = mix(img, PALETTE['dark'], np.clip(-tone, 0, 1) * 0.6)
    img = mix(img, PALETTE['light'], np.clip(tone, 0, 1) * 0.4)
    img = mix(img, PALETTE['dark'], smoothstep(0.75, 0.95, c) * 0.5)  # darker along the spine
    img = mix(img, PALETTE['belly'], smoothstep(-0.25, -0.6, c))

    # Breeding colours: rust-red flanks and legs, dull green over the shoulders and back, fading out
    # down the tail. Crisp edges keep them reading as toon colour blocks, just finer ones.
    body = smoothstep(-0.050, -0.040, yy) * smoothstep(0.060, 0.025, yy)
    rust = fbm(yy, aa, 11, 0.012, 3) + side * 0.9 - 1.0 - smoothstep(-0.3, -0.6, c)
    img = mix(img, PALETTE['rust'], smoothstep(0.0, 0.08, rust) * body * 0.9)
    moss = fbm(yy, aa, 21, 0.010, 3) + c * 0.4 - 0.85
    img = mix(img, PALETTE['moss'], smoothstep(0.0, 0.08, moss) * body * smoothstep(-0.1, 0.2, c) * 0.8)

    # Faint bands down the tail.
    bands = smoothstep(0.2, 0.5, np.sin(yy * 2 * math.pi / 0.011 + fbm(yy, aa, 31, 0.02, 1) * 0.8))
    img = mix(img, PALETTE['dark'], bands * smoothstep(0.02, 0.04, yy) * (c > -0.5) * 0.45)

    # Scales: fine granules on the body, big domed plates on the head, wide scutes under the belly.
    head = smoothstep(-0.044, -0.048, yy)
    fine_edge, fine_shade = scales(yy, aa, girth, 0.0010, 52, 41)
    big_edge, big_shade = scales(yy, aa, girth, 0.0019, 26, 42)
    edge = np.where(head > 0.5, big_edge, fine_edge)
    shade = np.where(head > 0.5, big_shade, fine_shade)
    img *= (1 - 0.30 * edge)[..., None]
    img *= (1 + 0.07 * shade)[..., None]

    # Salt crust over the top of the snout and head, patchy and thickest at the front.
    salt = (smoothstep(-0.050, -0.0625, yy) + c * 0.9 + fbm(yy, aa, 51, 0.004, 5) * 0.35
            + waves(yy, aa, 52, 0.0012, 14) * 0.15 - 1.75)
    salt *= smoothstep(-0.0652, -0.0638, yy)  # not on the very tip of the nose
    img = mix(img, PALETTE['salt'], smoothstep(0.0, 0.06, salt) * head * (c > 0.1))

    # Mouth: a dark line from the snout tip back under the eye, curving up toward the jowl.
    mouth_t = smoothstep(-0.0657, -0.052, yy)
    mouth_a = 1.90 - 0.18 * mouth_t
    on_mouth = smoothstep(0.07, 0.03, np.minimum(np.abs(aa - mouth_a), np.abs(aa - (2 * math.pi - mouth_a))))
    img = mix(img, (0.06, 0.06, 0.06), on_mouth * smoothstep(-0.0495, -0.0515, yy))
    # Nostrils near the tip of the snout.
    for na in (1.15, 2 * math.pi - 1.15):
        d = np.hypot((yy + 0.0633) / 0.0004, (aa - na) / 0.10)
        img = mix(img, (0.04, 0.04, 0.04), smoothstep(1.0, 0.6, d))
    return np.clip(img, 0, 1)


def paint_limbs():
    rows, cols = LIMB_ROWS[1], LIMB_COLS
    t = (np.arange(cols) - 1 + 0.5) / (cols - 2)
    a = (np.arange(rows) - 1 + 0.5) / (rows - 2) * 2 * math.pi
    yy = np.broadcast_to((t * 0.022)[None, :], (rows, cols))
    aa = np.broadcast_to(a[:, None], (rows, cols))
    girth = np.full((rows, cols), 0.016)
    img = np.broadcast_to(np.asarray(PALETTE['skin']), (rows, cols, 3)).copy()
    img = mix(img, PALETTE['dark'], np.clip(-fbm(yy, aa, 61, 0.012, 2), 0, 1) * 0.6)
    img = mix(img, PALETTE['rust'], smoothstep(0.0, 0.08, fbm(yy, aa, 62, 0.008, 2) - 0.45) * smoothstep(0.75, 0.5, t) * 0.8)
    img = mix(img, PALETTE['dark'], smoothstep(0.8, 0.95, t) * 0.5)  # darker toes
    edge, shade = scales(yy, aa, girth, 0.0009, 16, 63)
    img *= (1 - 0.30 * edge)[..., None]
    img *= (1 + 0.07 * shade)[..., None]
    return np.clip(img, 0, 1)


def make_texture():
    atlas = np.zeros((TEX_H, TEX_W, 3))
    atlas[:, :] = PALETTE['skin']
    atlas[BODY_ROWS[0]:BODY_ROWS[0] + BODY_ROWS[1], :] = paint_body()
    atlas[LIMB_ROWS[0]:LIMB_ROWS[0] + LIMB_ROWS[1], :LIMB_COLS] = paint_limbs()
    rgba = np.concatenate([atlas, np.ones((TEX_H, TEX_W, 1))], axis=2).astype(np.float32)
    img = bpy.data.images.new('IguanaSkin', TEX_W, TEX_H, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'JPEG'
    img.pack()
    return img


def srgb_lin(c):
    return tuple(v ** 2.2 for v in c)


COLORS = {
    'Skin': None,  # textured
    'Salt': srgb_lin(PALETTE['salt']),
    'Crest': srgb_lin((0.20, 0.205, 0.215)),
    'Claw': srgb_lin((0.80, 0.77, 0.69)),
    'Eye': base.srgb('#1d1714'),
    'Shine': base.srgb('#ffffff'),
}
base.COLORS = COLORS


def make_materials():
    mats = {}
    tex = make_texture()
    for name, rgb in COLORS.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = 0.8
        if rgb is None:
            node = m.node_tree.nodes.new('ShaderNodeTexImage')
            node.image = tex
            node.interpolation = 'Linear'
            m.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            m.diffuse_color = (*rgb, 1.0)
            bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        mats[name] = m
    return mats


base.make_materials = make_materials


# ---------------------------------------------------------------------------------------------
# Mesh. Same builder as lizard.py, plus a UV per face corner (faces without one use SOLID_UV).
# ---------------------------------------------------------------------------------------------
class MeshBuilder(base.MeshBuilder):
    def __init__(self):
        super().__init__()
        self.face_uvs = []

    def add_face(self, idx, mat, uvs=None):
        super().add_face(idx, mat)
        self.face_uvs.append(uvs)


def build_body(mb):
    steps, ring_n = base.STEPS, base.RING
    y0, y1 = base.PROFILE[0][0], base.PROFILE[-1][0]
    span = y1 - SNOUT_TIP
    rings, ts = [], []
    for i in range(steps):
        y = lerp(y0, y1, i / (steps - 1))
        ts.append((y - SNOUT_TIP) / span)
        ring = []
        for k in range(ring_n):
            x, z = ring_point(y, 2 * math.pi * k / ring_n)
            ring.append(mb.add_vert((x, y, z), ('spine', y)))
        rings.append(ring)

    def uv(i, k):
        return body_uv(ts[i], 2 * math.pi * k / ring_n)

    for i in range(steps - 1):
        for k in range(ring_n):
            k2 = (k + 1) % ring_n
            mb.add_face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], 'Skin',
                        [uv(i, k), uv(i, k + 1), uv(i + 1, k + 1), uv(i + 1, k)])

    # Close the blunt snout and the tail tip with fans.
    for ring, y, i, flip in ((rings[0], SNOUT_TIP, 0, True), (rings[-1], y1 + 0.0005, steps - 1, False)):
        cz = base.profile_at(y0 if flip else y1)[2]
        tip = mb.add_vert((0, y, cz), ('spine', y))
        t_tip = 0.0 if flip else 1.0
        for k in range(ring_n):
            mid = body_uv(t_tip, 2 * math.pi * (k + 0.5) / ring_n)
            if flip:
                mb.add_face([ring[k], tip, ring[(k + 1) % ring_n]], 'Skin', [uv(i, k), mid, uv(i, k + 1)])
            else:
                mb.add_face([ring[(k + 1) % ring_n], tip, ring[k]], 'Skin', [uv(i, k + 1), mid, uv(i, k)])

    build_crest(mb)
    build_head_scales(mb)


def build_crest(mb):
    """Slender spines along the spine from the back of the head to near the tail tip: tallest over
    the neck and shoulders, lower over the back, then tapering away down the tail."""
    y, end = -0.048, 0.116
    while y < end:
        if y < -0.028:
            height, length = 0.0031, 0.0012
        elif y < 0.005:
            height, length = lerp(0.0028, 0.0019, (y + 0.028) / 0.033), 0.0011
        else:
            height, length = lerp(0.0019, 0.0005, (y - 0.005) / (end - 0.005)), lerp(0.0011, 0.0007, (y - 0.005) / (end - 0.005))
        top = surface_z(y, 0.0) - 0.0003
        half_w = 0.0004 if y < 0.03 else 0.0003
        part = ('spine', y)
        corners = [
            mb.add_vert((-half_w, y - length / 2, top), part),
            mb.add_vert((half_w, y - length / 2, top), part),
            mb.add_vert((half_w, y + length / 2, top), part),
            mb.add_vert((-half_w, y + length / 2, top), part),
        ]
        tip = mb.add_vert((0, y + length * 0.9, top + height), part)  # swept back
        for a, b in zip(corners, corners[1:] + corners[:1]):
            mb.add_face([a, b, tip], 'Crest')
        y += length * 1.05


def build_head_scales(mb):
    """Big conical scales over the top of the head, salt-crusted toward the snout, and the large
    round scale on each jowl."""
    for y, x, r in (
        (-0.0605, 0.0, 0.0011), (-0.0600, 0.0026, 0.0010), (-0.0580, 0.0014, 0.0011), (-0.0575, 0.0040, 0.0010),
        (-0.0555, 0.0, 0.0013), (-0.0550, 0.0026, 0.0012), (-0.0530, 0.0045, 0.0010), (-0.0525, 0.0013, 0.0012),
        (-0.0505, 0.0032, 0.0012), (-0.0500, 0.0, 0.0011), (-0.0485, 0.0051, 0.0010), (-0.0480, 0.0020, 0.0010),
    ):
        for side in ((1,) if x == 0 else (1, -1)):
            sx = side * x
            mat = 'Salt' if y < -0.0570 and x < 0.0030 else 'Skin'
            blob(mb, (sx, y, surface_z(y, sx) - r * 0.4), (r, r, r * 0.9), ('bone', 'head'), mat, 4, 7)
    for side in (1, -1):
        blob(mb, (side * 0.0071, -0.0488, 0.0080), (0.0011, 0.0015, 0.0015), ('bone', 'head'), 'Skin', 4, 8)


def limb_tube(mb, a, b, r0, r1, part, t0, t1, mat='Skin', sides=8):
    """lizard.py's tapered tube, with leg-texture UVs (t0..t1 along the leg)."""
    a, b = Vector(a), Vector(b)
    axis = (b - a).normalized()
    side = axis.cross(Vector((0, 0, 1)))
    if side.length < 1e-6:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(axis).normalized()
    rings = []
    for f in (0.0, 0.5, 1.0):
        c, r = a.lerp(b, f), lerp(r0, r1, f)
        rings.append([mb.add_vert(c + r * (math.cos(2 * math.pi * k / sides) * side + math.sin(2 * math.pi * k / sides) * up), part)
                      for k in range(sides)])
    textured = mat == 'Skin'
    for i in range(2):
        ta, tb = lerp(t0, t1, i / 2), lerp(t0, t1, (i + 1) / 2)
        for k in range(sides):
            k2 = (k + 1) % sides
            uvs = None
            if textured:
                aa, ab = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
                uvs = [limb_uv(ta, aa), limb_uv(ta, ab), limb_uv(tb, ab), limb_uv(tb, aa)]
            mb.add_face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat, uvs)


def build_legs(mb):
    for front in (True, False):
        for side in (1, -1):
            n = leg_name(side, front)
            root, knee, foot = leg_points(side, front)
            r = 0.0028 if front else 0.0033
            upper, lower = ('bone', 'upper_' + n), ('bone', 'lower_' + n)
            limb_tube(mb, root, knee, r * 1.2, r * 0.8, upper, 0.0, 0.45, sides=10)
            limb_tube(mb, knee, foot, r * 0.8, r * 0.55, lower, 0.45, 0.8, sides=10)
            blob(mb, knee, (r * 0.85, r * 0.85, r * 0.85), upper, 'Skin', 5, 8)  # round off the elbow/knee
            # The pad is what the game plants (its lowest 1.5 mm is the sole), so the toes leave it
            # above that, or they'd drag the planted point forward.
            fx, fy, _ = foot
            cx, cy = fx + side * 0.0015, fy - 0.0012
            blob(mb, (cx, cy, 0.0019), (0.0030, 0.0032, 0.0018), lower, 'Skin')
            # Five long toes fanned forward and out, the hind foot's fourth toe longest, each with a
            # pale hooked claw for gripping wet lava.
            reach = (0.0050, 0.0058, 0.0062, 0.0058, 0.0040) if front else (0.0048, 0.0062, 0.0072, 0.0084, 0.0050)
            for t, length in zip((-0.35, 0.05, 0.45, 0.85, 1.45), reach):
                dx, dy = side * math.sin(t), -math.cos(t)
                a = (cx + dx * 0.0020, cy + dy * 0.0020, 0.0023)
                b = (cx + dx * length, cy + dy * length, 0.0022)
                c = (cx + dx * (length + 0.0020), cy + dy * (length + 0.0020), 0.0018)
                limb_tube(mb, a, b, 0.00068, 0.00052, lower, 0.82, 0.97, sides=5)
                limb_tube(mb, b, c, 0.00042, 0.0001, lower, 0, 0, 'Claw', sides=4)


def build_eyes(mb):
    for side in (1, -1):
        c = (side * 0.0066, -0.0572, 0.0114)
        blob(mb, c, (0.0018, 0.0018, 0.0018), ('bone', 'head'), 'Eye')
        blob(mb, (c[0] + side * 0.0009, c[1] - 0.0010, c[2] + 0.0008), (0.00045, 0.00045, 0.00045), ('bone', 'head'), 'Shine', 4, 6)
        # A heavy brow ridge over each eye.
        blob(mb, (side * 0.0060, -0.0575, 0.0131), (0.0019, 0.0025, 0.0008), ('bone', 'head'), 'Skin', 4, 8)


def build_mesh(rig, mats):
    mb = MeshBuilder()
    build_body(mb)
    build_legs(mb)
    build_eyes(mb)

    me = bpy.data.meshes.new('LizardMesh')
    me.from_pydata([tuple(v) for v in mb.verts], [], mb.faces)
    names = list(COLORS)
    for n in names:
        me.materials.append(mats[n])
    uv_layer = me.uv_layers.new(name='UVMap')
    for poly, mat, uvs in zip(me.polygons, mb.face_mats, mb.face_uvs):
        poly.material_index = names.index(mat)
        poly.use_smooth = True
        for li, uv in zip(poly.loop_indices, uvs or [SOLID_UV] * poly.loop_total):
            uv_layer.data[li].uv = uv
    me.validate()
    me.update()

    obj = bpy.data.objects.new('LizardBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones if b.name != 'root'}
    for i, (kind, val) in enumerate(mb.vert_part):
        for bone, w in (base.skin_weights(val) if kind == 'spine' else {val: 1.0}).items():
            groups[bone].add([i], w, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


base.build_mesh = build_mesh


def export(rig):
    # Points the game needs, in glTF space (+Z toward the snout, Y up).
    tail = base.PROFILE[-1]
    rig['snout'] = [0.0, base.PROFILE[0][3], -SNOUT_TIP]
    rig['tail_tip'] = [0.0, tail[3], -(tail[0] + 0.0005)]
    rig['hind_foot_z'] = -leg_points(1, False)[2][1]
    rig['front_foot_z'] = -leg_points(1, True)[2][1]
    os.makedirs(os.path.dirname(base.OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(base.OUT),
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_skins=True,
        export_morph=False,
        export_materials='EXPORT',
        export_texcoords=True,
        export_image_format='JPEG',
        export_jpeg_quality=88,
        export_extras=True,
        export_def_bones=False,
    )
    print('wrote', os.path.abspath(base.OUT), os.path.getsize(base.OUT), 'bytes')


base.export = export

if __name__ == '__main__':
    base.main()

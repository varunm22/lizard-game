"""Generate the player, a marine iguana: low-poly toon mesh with a painted skin, armature and
animation clips -> src/assets/lizard.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/lizard.py

Conventions (Blender space, Z up): the lizard faces -Y, which the glTF exporter turns into +Z forward,
Y up. Units are metres; snout to vent is 0.074 m, the tail 0.114 m more, and its feet rest on z = 0.

- Proportions are a marine iguana's: the head a short, blunt quarter of snout-to-vent, the neck thick,
  the forelegs just behind the head, and the laterally flattened tail 1.5x the body. The physics
  capsule covers snout to hips.
- Skin: one painted texture (scales, colour, salt) instead of per-face colours, so the patterning
  is far finer than the mesh at the cost of a single small texture.

Where the game needs points the rig has no joint for (snout tip, tail tip, where the feet stand),
the script stores them on the armature as glTF extras; src/player/lizardModel.ts reads them.
"""

import math
import os

import bpy
import numpy as np
from mathutils import Vector

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'lizard.glb')
FPS = 30

# ---------------------------------------------------------------------------------------------
# Proportions (Blender space: snout at -Y, metres). Snout to vent 0.074 m, tail 0.114 m.
# ---------------------------------------------------------------------------------------------
# (y, half_width, half_height, centre_z), measured off side-on photos (iNaturalist research-grade
# observations): the trunk is about 30% as deep as snout-to-vent and a little wider, the head about
# 22% of it long and 18% tall at the jowls, and the tail base about 18% deep, flattened side to side.
# Standing, the belly clears the ground by about a tenth of snout-to-vent.
PROFILE = [
    (-0.0645, 0.0044, 0.0040, 0.0135),
    (-0.0630, 0.0062, 0.0056, 0.0138),
    (-0.0605, 0.0072, 0.0066, 0.0142),
    (-0.0570, 0.0078, 0.0072, 0.0145),
    (-0.0515, 0.0082, 0.0076, 0.0147),
    (-0.0470, 0.0080, 0.0076, 0.0147),
    (-0.0420, 0.0080, 0.0082, 0.0147),
    (-0.0360, 0.0090, 0.0100, 0.0149),
    (-0.0300, 0.0102, 0.0115, 0.0150),
    (-0.0180, 0.0112, 0.0129, 0.0150),
    (-0.0050, 0.0112, 0.0126, 0.0149),
    (0.0040, 0.0108, 0.0116, 0.0145),
    (0.0120, 0.0088, 0.0098, 0.0134),
    (0.0300, 0.0046, 0.0070, 0.0116),
    (0.0550, 0.0032, 0.0054, 0.0093),
    (0.0800, 0.0022, 0.0040, 0.0072),
    (0.1050, 0.0013, 0.0026, 0.0056),
    (0.1240, 0.0003, 0.0006, 0.0048),
]
# Spine bones in order from snout to tail tip, used both to build the armature and to skin the body.
SPINE = [
    ('head', -0.0645, -0.046, None),
    ('neck', -0.046, -0.034, None),
    ('chest', -0.034, -0.008, None),
    ('hips', -0.008, 0.010, None),
    ('tail1', 0.010, 0.039, None),
    ('tail2', 0.039, 0.067, None),
    ('tail3', 0.067, 0.096, None),
    ('tail4', 0.096, 0.124, None),
]
SHOULDER_Y, HIP_Y = -0.031, 0.010
STEPS, RING = 110, 24
SNOUT_TIP = -0.0657  # the blunt snout's fan closes just ahead of the first cross-section
# The mouth: the lips run round the head at ring vertex LIP_K (and RING - LIP_K) on each side, a
# little below the middle of the flank, from the snout back to the corner of the mouth, just behind
# the eye; the jaw hinges there.
LIP_K = 7
MOUTH_CORNER_Y = -0.0515
MOUTH_ACROSS = 6  # faces across the palate and the floor of the mouth


def srgb(hex_colour):
    """'#rrggbb' as linear RGB, which is what glTF base colours are."""
    return tuple(((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5))


def lerp(a, b, t):
    return a + (b - a) * t


def profile_at(y):
    """Smoothly interpolate the cross-section at y (cosine easing between keys)."""
    for (y0, *a), (y1, *b) in zip(PROFILE, PROFILE[1:]):
        if y0 <= y <= y1:
            t = (y - y0) / (y1 - y0)
            t = 0.5 - 0.5 * math.cos(math.pi * t)
            return [lerp(p, q, t) for p, q in zip(a, b)]
    return PROFILE[-1][1:]


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.unit_settings.scale_length = 1.0


# How far the rest feet stand ahead of the shoulders and behind the hips.
FOOT_SETBACK = 0.004


def leg_points(side, front):
    """Semi-erect legs: the upper leg runs out and a little down from low on the flank, the lower
    leg nearly straight down. The forelegs are relatively long and the hind legs short for an
    iguana, so the two pairs are about the same length."""
    y = SHOULDER_Y if front else HIP_Y
    reach = -FOOT_SETBACK if front else FOOT_SETBACK
    if front:
        return (side * 0.0090, y, 0.0118), (side * 0.0160, y + reach * 0.3, 0.0100), (side * 0.0190, y + reach, 0.0016)
    return (side * 0.0078, y, 0.0112), (side * 0.0170, y + reach * 0.3, 0.0094), (side * 0.0200, y + reach, 0.0016)



def roundness(y):
    """Superellipse exponent of the cross-section: a boxy head, rounded body, keeled tail."""
    keys = ((-0.0645, 2.7), (-0.046, 2.7), (-0.034, 2.3), (0.004, 2.3), (0.03, 1.8), (0.124, 1.7))
    for (y0, a), (y1, b) in zip(keys, keys[1:]):
        if y0 <= y <= y1:
            return lerp(a, b, (y - y0) / (y1 - y0))
    return keys[0][1] if y < keys[0][0] else keys[-1][1]


def ring_point(y, a):
    """Point on the body surface at distance y along it and angle a around it (0 = top, + = left)."""
    hw, hh, cz = profile_at(y)
    e = 2 / roundness(y)
    s, c = math.sin(a), math.cos(a)
    x = hw * math.copysign(abs(s) ** e, s)
    z = cz + hh * math.copysign(abs(c) ** e, c) * (1.0 if c > 0 else 0.7)
    return x, z


def surface_z(y, x):
    """Height of the back at (x, y)."""
    hw, hh, cz = profile_at(y)
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
    y0, y1 = SNOUT_TIP, PROFILE[-1][0]
    yy = np.broadcast_to(lerp(y0, y1, t)[None, :], (rows, cols))
    aa = np.broadcast_to(a[:, None], (rows, cols))
    prof = np.array([profile_at(max(v, PROFILE[0][0])) for v in lerp(y0, y1, t)])
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
    'Eye': srgb('#1d1714'),
    'Shine': srgb('#ffffff'),
    'Mouth': srgb('#7c4846'),
}


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



# ---------------------------------------------------------------------------------------------
# Mesh building. Everything is one mesh so it skins to one armature; parts are tagged with a
# `part` so the skinning step knows which bone owns them. Each face corner carries a UV into the
# skin texture (faces without one use SOLID_UV).
# ---------------------------------------------------------------------------------------------
class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.face_mats, self.face_uvs, self.vert_part = [], [], [], [], []

    def add_vert(self, co, part):
        self.verts.append(Vector(co))
        self.vert_part.append(part)
        return len(self.verts) - 1

    def add_face(self, idx, mat, uvs=None):
        self.faces.append(idx)
        self.face_mats.append(mat)
        self.face_uvs.append(uvs)


def build_body(mb):
    """The body tube, snout to tail tip. Ahead of the mouth's corner each ring is split along the
    lips: its lower part rides the jaw bone, so the mouth can open, and a palate and a mouth floor
    (on their own vertices, so they don't soften the lips' shading) close the two jaws inside."""
    steps, ring_n = STEPS, RING
    y0, y1 = PROFILE[0][0], PROFILE[-1][0]
    span = y1 - SNOUT_TIP
    lips = (LIP_K, ring_n - LIP_K)
    # rings[i][k] = (upper vertex, lower vertex): the same one except on the jaw's side of the lips.
    rings, ts, split = [], [], []
    for i in range(steps):
        y = lerp(y0, y1, i / (steps - 1))
        ts.append((y - SNOUT_TIP) / span)
        mouth = y < MOUTH_CORNER_Y
        split.append(mouth)
        ring = []
        for k in range(ring_n):
            x, z = ring_point(y, 2 * math.pi * k / ring_n)
            on_jaw = mouth and lips[0] < k < lips[1]
            up = None if on_jaw else mb.add_vert((x, y, z), ('spine', y))
            lo = mb.add_vert((x, y, z), ('jaw', y)) if mouth and lips[0] <= k <= lips[1] else up
            ring.append((up if up is not None else lo, lo))
        rings.append(ring)

    def uv(i, k):
        return body_uv(ts[i], 2 * math.pi * k / ring_n)

    def jaw_face(k):
        return lips[0] <= k < lips[1]

    for i in range(steps - 1):
        for k in range(ring_n):
            k2 = (k + 1) % ring_n
            w = 1 if jaw_face(k) else 0
            mb.add_face([rings[i][k][w], rings[i][k2][w], rings[i + 1][k2][w], rings[i + 1][k][w]], 'Skin',
                        [uv(i, k), uv(i, k + 1), uv(i + 1, k + 1), uv(i + 1, k)])

    # Close the blunt snout and the tail tip with fans; the jaw's part of the snout closes on its own tip.
    lip_front = ring_point(y0, 2 * math.pi * LIP_K / ring_n)[1]
    jaw_tip = mb.add_vert((0, SNOUT_TIP, lip_front), ('jaw', SNOUT_TIP))
    for ring, y, i, flip in ((rings[0], SNOUT_TIP, 0, True), (rings[-1], y1 + 0.0005, steps - 1, False)):
        cz = profile_at(y0 if flip else y1)[2]
        tip = mb.add_vert((0, y, cz), ('spine', y))
        t_tip = 0.0 if flip else 1.0
        for k in range(ring_n):
            mid = body_uv(t_tip, 2 * math.pi * (k + 0.5) / ring_n)
            if flip:
                on_jaw = jaw_face(k)
                w, t = (1, jaw_tip) if on_jaw else (0, tip)
                mb.add_face([ring[k][w], t, ring[(k + 1) % ring_n][w]], 'Skin', [uv(i, k), mid, uv(i, k + 1)])
            else:
                mb.add_face([ring[(k + 1) % ring_n][0], tip, ring[k][0]], 'Skin', [uv(i, k + 1), mid, uv(i, k)])

    # Inside the mouth: the palate arches up into the head and faces down, the floor dips into the
    # jaw and faces up, each from the snout back to the corner, where they meet.
    last = split.index(False)  # the corner ring
    across = [i / MOUTH_ACROSS for i in range(MOUTH_ACROSS + 1)]
    for w, part, facing in ((0, 'spine', -1), (1, 'jaw', 1)):
        strips = []
        for i in range(last + 1):
            a, b = mb.verts[rings[i][lips[0]][w]], mb.verts[rings[i][lips[1]][w]]
            y = a.y
            hw, hh, cz = profile_at(y)
            # How deep: most of the way to the top of the head or the chin, closing up at the corner.
            reach = (cz + hh - a.z) * 0.55 if facing < 0 else (a.z - (cz - hh * 0.7)) * 0.5
            depth = -facing * reach * min(1.0, (MOUTH_CORNER_Y - y) / 0.004)
            strips.append([mb.add_vert((lerp(a.x, b.x, t) * (1 - 0.15 * math.sin(math.pi * t)), y, a.z + depth * math.sin(math.pi * t)), (part, y))
                           for t in across])
        tip = mb.add_vert((0, SNOUT_TIP + 0.0006, (profile_at(y0)[2] if facing < 0 else lip_front)), (part, SNOUT_TIP))
        for k in range(MOUTH_ACROSS):
            facing_face(mb, [strips[0][k], strips[0][k + 1], tip], 'Mouth', facing)
            for r0, r1 in zip(strips, strips[1:]):
                facing_face(mb, [r0[k], r0[k + 1], r1[k + 1], r1[k]], 'Mouth', facing)

    build_crest(mb)
    build_head_scales(mb)


def facing_face(mb, idx, mat, up):
    """Add a face wound so its normal points up (+Z, up=1) or down (up=-1)."""
    a, b, c = (mb.verts[i] for i in idx[:3])
    if (b - a).cross(c - a).z * up < 0:
        idx = idx[::-1]
    mb.add_face(idx, mat)


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
        blob(mb, (side * 0.0080, -0.0488, 0.0137), (0.0012, 0.0017, 0.0017), ('bone', 'head'), 'Skin', 4, 8)


def limb_tube(mb, a, b, r0, r1, part, t0, t1, mat='Skin', sides=8):
    """A tapered tube from a to b, with leg-texture UVs (t0..t1 along the leg)."""
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
            r = 0.0030 if front else 0.0035
            upper, lower = ('bone', 'upper_' + n), ('bone', 'lower_' + n)
            # The upper leg starts inside the body, and a ball centred on the shoulder or hip joint
            # (so it looks the same however the leg swings) fills the join with the flank.
            inner = Vector(root) + (Vector(root) - Vector(knee)).normalized() * r
            limb_tube(mb, inner, knee, r * 1.2, r * 0.8, upper, 0.0, 0.45, sides=10)
            blob(mb, root, (r * 1.35, r * 1.35, r * 1.35), upper, 'Skin', 6, 10)
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
        c = (side * 0.0069, -0.0572, 0.0167)
        blob(mb, c, (0.0018, 0.0018, 0.0018), ('bone', 'head'), 'Eye')
        blob(mb, (c[0] + side * 0.0009, c[1] - 0.0010, c[2] + 0.0008), (0.00045, 0.00045, 0.00045), ('bone', 'head'), 'Shine', 4, 6)
        # A heavy brow ridge over each eye.
        blob(mb, (side * 0.0062, -0.0575, 0.0185), (0.0019, 0.0025, 0.0008), ('bone', 'head'), 'Skin', 4, 8)


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
        if kind == 'spine':
            weights = skin_weights(val)
        elif kind == 'jaw':  # the jaw takes the head's share, so the lips stay together however the neck bends
            weights = {('jaw' if b == 'head' else b): w for b, w in skin_weights(val).items()}
        else:
            weights = {val: 1.0}
        for bone, w in weights.items():
            groups[bone].add([i], w, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj



def export(rig):
    # Points the game needs, in glTF space (+Z toward the snout, Y up).
    tail = PROFILE[-1]
    rig['snout'] = [0.0, PROFILE[0][3], -SNOUT_TIP]
    rig['tail_tip'] = [0.0, tail[3], -(tail[0] + 0.0005)]
    rig['hind_foot_z'] = -leg_points(1, False)[2][1]
    rig['front_foot_z'] = -leg_points(1, True)[2][1]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
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
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


def blob(mb, centre, radii, part, mat, rings=6, sides=10):
    """A UV-sphere-ish ellipsoid, for feet and eyes."""
    cx, cy, cz = centre
    rx, ry, rz = radii
    top = mb.add_vert((cx, cy, cz + rz), part)
    bottom = mb.add_vert((cx, cy, cz - rz), part)
    grid = []
    for i in range(1, rings):
        phi = math.pi * i / rings
        grid.append([
            mb.add_vert((
                cx + rx * math.sin(phi) * math.cos(2 * math.pi * k / sides),
                cy + ry * math.sin(phi) * math.sin(2 * math.pi * k / sides),
                cz + rz * math.cos(phi),
            ), part)
            for k in range(sides)
        ])
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.add_face([top, grid[0][k2], grid[0][k]], mat)
        mb.add_face([bottom, grid[-1][k], grid[-1][k2]], mat)
    for i in range(len(grid) - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            mb.add_face([grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]], mat)


def leg_name(side, front):
    return ('front' if front else 'hind') + ('_L' if side > 0 else '_R')


# ---------------------------------------------------------------------------------------------
# Armature
# ---------------------------------------------------------------------------------------------
def build_armature():
    arm_data = bpy.data.armatures.new('LizardRig')
    rig = bpy.data.objects.new('Lizard', arm_data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones

    root = eb.new('root')
    root.head, root.tail = (0, 0, 0), (0, 0, 0.006)

    def z_at(y):
        return profile_at(y)[2]

    bones = {}
    # Spine from the hips forward, and the tail from the hips back, so the hips are the body's centre.
    order_fwd = ['hips', 'chest', 'neck', 'head']
    order_back = ['tail1', 'tail2', 'tail3', 'tail4']
    spec = {name: (ya, yb) for name, ya, yb, _ in SPINE}
    parent = root
    for name in order_fwd:
        ya, yb = spec[name]
        b = eb.new(name)
        b.head, b.tail = (0, yb, z_at(yb)), (0, ya, z_at(ya))  # pointing toward the snout
        b.parent = parent
        b.use_connect = parent is not root
        bones[name] = parent = b
    parent = bones['hips']
    for name in order_back:
        ya, yb = spec[name]
        b = eb.new(name)
        b.head, b.tail = (0, ya, z_at(ya)), (0, yb, z_at(yb))  # pointing toward the tail tip
        b.parent = parent
        b.use_connect = parent is not bones['hips']
        bones[name] = parent = b

    # The lower jaw hinges at the corner of the mouth and points to the snout.
    lip = lambda y: ring_point(y, 2 * math.pi * LIP_K / RING)[1]
    jaw = eb.new('jaw')
    jaw.head, jaw.tail = (0, MOUTH_CORNER_Y, lip(MOUTH_CORNER_Y)), (0, SNOUT_TIP, lip(PROFILE[0][0]))
    jaw.parent = bones['head']

    for front in (True, False):
        for side in (1, -1):
            n = leg_name(side, front)
            root_p, knee, foot = leg_points(side, front)
            up = eb.new('upper_' + n)
            up.head, up.tail = root_p, knee
            up.parent = bones['chest'] if front else bones['hips']
            lo = eb.new('lower_' + n)
            lo.head, lo.tail = knee, foot
            lo.parent, lo.use_connect = up, True

    for b in eb:
        b.roll = 0.0
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def skin_weights(y):
    """Blend the two nearest spine bones by distance along the body."""
    centres = [(name, (ya + yb) / 2) for name, ya, yb, _ in SPINE]
    if y <= centres[0][1]:
        return {centres[0][0]: 1.0}
    if y >= centres[-1][1]:
        return {centres[-1][0]: 1.0}
    for (n0, c0), (n1, c1) in zip(centres, centres[1:]):
        if c0 <= y <= c1:
            t = (y - c0) / (c1 - c0)
            return {n0: 1.0 - t, n1: t}
    return {}


# ---------------------------------------------------------------------------------------------
# Animation. Spine, tail and head are posed directly (rotation_mode XYZ, bone-local): with roll 0
# a spine bone's local Z is world up, so Z rotation bends it sideways and X pitches it.
# Grounded clips place the feet with IK targets on the ground and bake the result to plain keys,
# so planted feet never slide or sink. Airborne clips pose the legs directly.
# ---------------------------------------------------------------------------------------------
LEGS = [leg_name(s, f) for f in (True, False) for s in (1, -1)]
TAIL = ['tail1', 'tail2', 'tail3', 'tail4']

# Gait timing. Body speed at playback rate 1 = 2 * stride / (duty * cycle). The game scales
# playback rate by (ground speed / these speeds) so feet don't skate; keep LIZARD_GAIT_SPEED in
# src/player/lizardModel.ts in sync. Step rate at a given speed is speed * duty / (2 * stride), so
# long strides and a short stance keep the cadence calm: about 4 steps a second at the game's walk
# and 6 at its run. A stride much past 15 mm overreaches these short legs and the feet slip.
WALK = dict(frames=12, stride=0.015, lift=0.0040, duty=0.5)  # 0.4 s cycle -> 0.15 m/s
RUN = dict(frames=10, stride=0.015, lift=0.0055, duty=0.3)  # 0.333 s cycle -> 0.30 m/s
# How much of the spine's side-to-side swing the hips take (the chest takes the rest), and how much
# of the hips' swing the tail base turns back against so the tail trails straight behind.
HIP_SWING = 0.6
TAIL_COUNTER = 0.8


def new_action(rig, name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    return act


def key(rig, frame, rot=None, loc=None):
    """rot: {bone: (x, y, z) radians}; loc: {bone: (x, y, z)} in bone-local metres."""
    for bone, r in (rot or {}).items():
        pb = rig.pose.bones[bone]
        pb.rotation_euler = r
        pb.keyframe_insert('rotation_euler', frame=frame)
    for bone, l in (loc or {}).items():
        pb = rig.pose.bones[bone]
        pb.location = l
        pb.keyframe_insert('location', frame=frame)


def leg_sign(name):
    return 1 if name.endswith('_L') else -1


def rest_foot(rig, leg):
    return rig.data.bones['lower_' + leg].tail_local.copy()


def setup_ik(rig):
    """An IK target empty per foot, constraints muted until a grounded clip is baked."""
    targets = {}
    for leg in LEGS:
        empty = bpy.data.objects.new('ik_' + leg, None)
        bpy.context.collection.objects.link(empty)
        empty.location = rest_foot(rig, leg)
        c = rig.pose.bones['lower_' + leg].constraints.new('IK')
        c.target = empty
        c.chain_count = 2
        c.mute = True
        targets[leg] = empty
    return targets


def bake_legs(rig, targets, frames, foot_at):
    """Drive the feet to foot_at(leg, frame) with IK, then key the solved leg rotations as FK."""
    scene = bpy.context.scene
    for leg in LEGS:
        rig.pose.bones['lower_' + leg].constraints[0].mute = False
    solved = []
    for f in frames:
        scene.frame_set(f)
        for leg in LEGS:
            targets[leg].location = foot_at(leg, f)
        bpy.context.view_layer.update()
        pose = {}
        for leg in LEGS:
            for part in ('upper_', 'lower_'):
                pb = rig.pose.bones[part + leg]
                pose[pb.name] = rig.convert_space(pose_bone=pb, matrix=pb.matrix, from_space='POSE', to_space='LOCAL')
        solved.append((f, pose))
    for leg in LEGS:
        rig.pose.bones['lower_' + leg].constraints[0].mute = True
    for f, pose in solved:
        key(rig, f, {name: m.to_euler('XYZ') for name, m in pose.items()})


def gait(rig, targets, name, frames, stride, lift, spine_bend, tail_bend, bob, duty, tuck, crouch):
    """A looping trot: diagonal leg pairs move together while the spine and tail wave side to side.

    Each foot is planted for `duty` of the cycle; under 0.5 the trot has a moment with every foot
    up, which is how running lizards get a long stride without a frantic cadence. The legs are
    short, so a long stride needs help: each stance is centred under its shoulder or hip, the feet
    tuck `tuck` m in toward the body, the body sits `crouch` m lower, and the spine bends so the
    shoulder over a foot reaching forward swings forward with it.
    """
    new_action(rig, name)
    phase = {'front_L': 0.0, 'hind_R': 0.0, 'front_R': 0.5, 'hind_L': 0.5}
    for f in range(frames + 1):
        w = 2 * math.pi * f / frames  # 0: front_L and hind_R plant
        rot = {
            # The chest swings so the shoulder over the front foot planted furthest forward leads;
            # neck and head turn back against it so the head stays nearly steady.
            'chest': (0, 0, spine_bend * math.cos(w)),
            'hips': (0, 0, -spine_bend * HIP_SWING * math.cos(w)),
            'neck': (0, 0, -spine_bend * (1 - HIP_SWING) * 0.7 * math.cos(w)),
            'head': (0, 0, -spine_bend * (1 - HIP_SWING) * 0.3 * math.cos(w)),
        }
        # The tail base turns back against the hips' swing so the tail trails straight behind,
        # with only a gentle wave of its own travelling down it.
        for i, tb in enumerate(TAIL):
            # The tail bones point backward, so the same turn in their frame takes the opposite sign.
            counter = -spine_bend * HIP_SWING * TAIL_COUNTER * math.cos(w) if i == 0 else 0.0
            rot[tb] = (0, 0, counter + tail_bend * math.cos(w - 0.8 * (i + 1)))
        root_y = -crouch + bob * abs(math.sin(w))
        key(rig, f, rot, {'root': (0, root_y, 0)})  # root's local Y is world up

    def foot_at(leg, f):
        p = (f / frames + phase[leg]) % 1.0
        rest = rest_foot(rig, leg)
        front = leg.startswith('front')
        # Rest feet sit a little ahead of the shoulders and behind the hips; centre stances under them.
        centre = rest.y + (FOOT_SETBACK if front else -FOOT_SETBACK)
        x = rest.x - leg_sign(leg) * tuck
        if p < duty:  # stance: planted, sliding back under the body from front (-Y) to back
            y = lerp(-stride, stride, p / duty)
            z = 0.0
        else:  # swing: lift and reach forward again
            q = (p - duty) / (1 - duty)
            y = lerp(stride, -stride, 0.5 - 0.5 * math.cos(math.pi * q))
            z = lift * math.sin(math.pi * q)
        return Vector((x, centre + y, rest.z + z))

    bake_legs(rig, targets, range(frames + 1), foot_at)


def idle(rig, targets):
    new_action(rig, 'idle')
    frames = 90
    for f in range(0, frames + 1, 3):
        w = 2 * math.pi * f / frames
        breath = math.sin(2 * w)
        rot = {
            'chest': (0.03 * breath, 0, 0),
            'neck': (-0.08 + 0.06 * max(0.0, math.sin(w)), 0, 0.12 * math.sin(w)),
            'head': (0.05 * math.sin(w + 1), 0, 0.10 * math.sin(w + 0.5)),
        }
        for i, tb in enumerate(TAIL):
            rot[tb] = (0, 0, (0.10 + 0.04 * i) * math.sin(w - 0.8 * i))
        key(rig, f, rot, {'root': (0, 0.0005 * breath, 0)})
    bake_legs(rig, targets, range(0, frames + 1, 3), lambda leg, f: rest_foot(rig, leg))


def land(rig, targets):
    # Squash on impact with feet planted, then settle back to a neutral stance.
    new_action(rig, 'land')
    keys = ((0, -0.0030, -0.15), (3, -0.0020, -0.08), (10, 0.0, 0.0))
    for f, squash, head in keys:
        key(rig, f, {'neck': (-head, 0, 0), 'tail1': (head * 0.5, 0, 0)}, {'root': (0, squash, 0)})
    bake_legs(rig, targets, range(0, 11), lambda leg, f: rest_foot(rig, leg))


def pose_air(rig, name, frames, legs_fwd, tail_up, head_up, wiggle):
    new_action(rig, name)
    for f in range(0, frames + 1, 2):
        w = 2 * math.pi * f / frames
        rot = {'neck': (-head_up, 0, 0), 'head': (-head_up * 0.5, 0, 0)}
        for i, tb in enumerate(TAIL):
            rot[tb] = (tail_up * (1 - 0.25 * i), 0, wiggle * math.sin(w - i))
        for leg in LEGS:
            s = leg_sign(leg)
            front = leg.startswith('front')
            splay = legs_fwd if front else -legs_fwd
            rot['upper_' + leg] = (0, 0, s * splay + wiggle * 0.5 * math.sin(w + (0 if front else 2)))
            rot['lower_' + leg] = (0, 0, 0)
        key(rig, f, rot)


def jump(rig):
    # Push-off: legs stretch back, head and tail lift. Plays once and holds the last frame.
    new_action(rig, 'jump')
    for f, stretch, head, tail in ((0, 0.0, 0.0, 0.0), (4, 0.6, 0.35, 0.35), (10, 0.45, 0.25, 0.3)):
        rot = {'neck': (-head, 0, 0), 'head': (-head * 0.4, 0, 0)}
        for i, tb in enumerate(TAIL):
            rot[tb] = (tail * (1 - 0.2 * i), 0, 0)
        for leg in LEGS:
            back = stretch if leg.startswith('hind') else stretch * 0.5
            rot['upper_' + leg] = (0, 0, leg_sign(leg) * -back)
            rot['lower_' + leg] = (0, 0, 0)
        key(rig, f, rot)


# Swimming: legs folded back flat along the body, a travelling wave down the body and tail drives it.
# Each leg's (upper sweep back, upper tilt, knee fold) in radians, found by fitting the feet to the
# body's flanks: front feet by the belly, hind feet along the base of the tail.
SWIM = dict(frames=20, legs={'front': (1.2, 0.15, 1.2), 'hind': (1.05, -0.15, 1.2)}, body=0.08, tail=0.32)


def swim(rig, frames, legs, body, tail):
    new_action(rig, 'swim')
    for f in range(frames + 1):
        w = 2 * math.pi * f / frames
        rot = {
            'neck': (0, 0, -body * 0.5 * math.cos(w + 0.6)),
            'chest': (0, 0, body * 0.6 * math.cos(w)),
            'hips': (0, 0, -body * math.cos(w - 0.6)),
        }
        for i, tb in enumerate(TAIL):
            rot[tb] = (0, 0, tail * (0.5 + 0.35 * i) * math.cos(w - 0.9 * (i + 1)))
        for leg in LEGS:
            sweep, tilt, fold = legs['front' if leg.startswith('front') else 'hind']
            rot['upper_' + leg] = (tilt, 0, leg_sign(leg) * sweep)
            rot['lower_' + leg] = (fold, 0, 0)
        key(rig, f, rot)


# A bite: the head lifts with the mouth gaping, lunges down onto the food, snaps shut, and tugs it
# off with a jerk to one side and back. Only the neck, head and jaw move, so the game layers it over
# whatever the body is doing (additively; its first and last frames are the rest pose).
# (frame, neck pitch, head pitch, head turn, jaw open), radians; positive pitch dips the snout.
BITE = (
    (0, 0.0, 0.0, 0.0, 0.0),
    (4, -0.14, -0.12, 0.0, 0.38),
    (8, 0.16, 0.20, 0.0, 0.45),
    (10, 0.20, 0.26, 0.0, 0.0),  # snap: BITE_SNAP in src/player/lizardModel.ts
    (12, 0.16, 0.18, 0.20, 0.0),
    (14, 0.08, 0.08, -0.12, 0.0),
    (18, 0.0, 0.0, 0.0, 0.0),
)


def bite(rig):
    new_action(rig, 'bite')
    for f, neck, head, turn, jaw in BITE:
        key(rig, f, {'neck': (neck, 0, 0), 'head': (head, 0, turn), 'jaw': (jaw, 0, 0)})


# Struck by the hawk: the body is knocked over toward the far side and jerks into a curve with both
# ends thrown toward the side it was hit on, the head ducks and the tail lashes, then it rights itself
# and straightens. One clip per side; like the bite it's layered over whatever the body is doing
# (additively; first and last frames are the rest pose), so only the root, spine and tail move.
# (frame, curve, duck, lash, tip): duck dips the head, curve and lash are fractions of the turns
# below, positive toward the struck side, and tip rolls the body away from the blow (radians).
FLINCH = (
    (0, 0.0, 0.0, 0.0, 0.0),
    (2, 1.0, 0.40, 0.6, 0.30),
    (5, -0.40, 0.28, -1.0, -0.10),
    (9, 0.15, 0.10, 0.45, 0.04),
    (14, 0.0, 0.0, 0.0, 0.0),
)


def flinch(rig, name, side):
    """side 1: struck on its left; -1: on its right."""
    new_action(rig, name)
    for f, curve, duck, lash, tip in FLINCH:
        c = side * curve
        rot = {
            # Rolling the left side up is a positive turn of the root.
            'root': (0, 0, side * tip),
            'chest': (0, 0, 0.42 * c),
            'neck': (duck * 0.6, 0, 0.40 * c),
            'head': (duck * 0.4, 0, 0.28 * c),
        }
        for i, tb in enumerate(TAIL):
            rot[tb] = (0, 0, side * (0.28 * curve + 0.16 * lash) * (1 + 0.25 * i))
        key(rig, f, rot)


# Caught a third time: it buckles, rolls over onto its right side, bounces once and lies there with
# its legs settling the way gravity leaves them (plays once and holds the last frame). The root bone
# points up, so its local Z is the body's long axis (snout forward) and rolling the left side up is a
# positive turn about it; its local Y is up. COLLAPSE_LIFT raises the body as it rolls so it rests on
# its flank on the ground instead of sinking into it.
COLLAPSE_FRAMES = 30
COLLAPSE_ROLL = ((0, 0.0), (3, 0.12), (7, 0.55), (11, 1.47), (14, 1.30), (18, 1.40), (22, 1.38))
COLLAPSE_LIFT = 0.0105
COLLAPSE_SHIFT = 0.006
# Where each leg comes to rest, lying on the right side: (upper tilt, upper sweep, knee fold), found by
# searching for the pose with each foot as low as it reaches, clear of the ground and the body by the
# leg's thickness, front feet just ahead of the shoulder and hind feet trailing. The right legs lie on
# the ground; the left ones can't reach it and drape back across the belly.
LEG_REST = {
    'front_L': (-1.80, 0.00, 0.45),
    'front_R': (-1.35, 0.30, 0.75),
    'hind_L': (-0.90, 0.90, 0.60),
    'hind_R': (-1.80, 1.20, 0.00),
}
# The right legs lift as it buckles, fold up under the body as it rolls onto them (found the same
# way, kept clear of the ground all through the roll), then stretch out to rest.
LEG_TUCK = {
    'front_R': (-2.10, 0.90, -0.60),
    'hind_R': (-0.90, -2.10, 1.20),
}
# How far the left legs have gone from their stance to the rest pose, by frame: they flail out as it
# goes over, then flop down past rest and back, the front one last.
LEG_SETTLE = {
    'front_L': ((0, 0.0), (6, -0.25), (11, -0.15), (16, 1.12), (20, 0.95), (23, 1.0), (25, 1.04), (28, 1.0)),
    'hind_L': ((0, 0.0), (6, -0.30), (10, -0.15), (14, 1.10), (18, 0.96), (21, 1.0)),
}
LEG_LIFT = {
    'front_R': (2.10, 2.10, 0.00),
    'hind_R': (0.30, 0.60, 0.60),
}
LEG_TUCK_FRAMES = (0, 2, 4, 8, 13)


def leg_pose(leg, f):
    """(upper tilt, upper sweep, knee fold) of a leg at frame f of the collapse."""
    rest = LEG_REST[leg]
    if leg in LEG_SETTLE:
        k = track(f, LEG_SETTLE[leg])
        return tuple(k * v for v in rest)
    poses = ((0.0, 0.0, 0.0), LEG_LIFT[leg], LEG_TUCK[leg], LEG_TUCK[leg], rest)
    return tuple(track(f, list(zip(LEG_TUCK_FRAMES, (p[i] for p in poses)))) for i in range(3))


def collapse(rig):
    new_action(rig, 'collapse')
    final = COLLAPSE_ROLL[-1][1]
    for f in range(COLLAPSE_FRAMES + 1):
        roll = track(f, COLLAPSE_ROLL)
        t = min(1.0, roll / final)
        # Buckling at the start: the body drops and the head sags before it goes over.
        sag = track(f, ((0, 0.0), (3, 1.0), (9, 0.0)))
        # The head hits the ground as the body lands, bounces a little, then lies still.
        nod = track(f, ((0, 0.0), (3, 0.12), (8, -0.10), (12, 0.35), (15, 0.22), (19, 0.30)))
        # The tail whips round as it rolls (up, once it's on its side), then curls slack on the ground.
        whip = track(f, ((0, 0.0), (5, 0.3), (11, -0.6), (16, -0.1), (22, 0.15)))
        rot = {
            'root': (0, 0, roll),
            'neck': (nod, 0, -0.25 * t),
            'head': (0.5 * nod, 0, -0.15 * t),
            'jaw': (track(f, ((0, 0.0), (12, 0.0), (16, 0.18), (22, 0.12))), 0, 0),
            'chest': (0.05 * t + 0.08 * sag, 0, -0.10 * t),
            'hips': (0.04 * sag, 0, 0.05 * t),
        }
        for i, tb in enumerate(TAIL):
            rot[tb] = (0, 0, 0.12 * whip * (1 + 0.3 * i))
        for leg in LEGS:
            ux, uz, lx = leg_pose(leg, f)
            rot['upper_' + leg] = (ux, 0, uz)
            rot['lower_' + leg] = (lx, 0, 0)
        lift = COLLAPSE_LIFT * math.sin(max(0.0, roll)) / math.sin(final)
        key(rig, f, rot, {'root': (-COLLAPSE_SHIFT * t, lift - 0.0008 * sag, 0)})


def track(f, keys):
    """Scalar channel: keys [(frame, value), ...], eased between keys, held past the ends."""
    if f <= keys[0][0]:
        return keys[0][1]
    for (f0, v0), (f1, v1) in zip(keys, keys[1:]):
        if f <= f1:
            u = (f - f0) / (f1 - f0)
            return lerp(v0, v1, u * u * (3 - 2 * u))
    return keys[-1][1]


def build_animations(rig):
    targets = setup_ik(rig)
    idle(rig, targets)
    gait(rig, targets, 'walk', spine_bend=0.3, tail_bend=0.06, bob=0.0005, tuck=0.005, crouch=0.0015, **WALK)
    gait(rig, targets, 'run', spine_bend=0.3, tail_bend=0.08, bob=0.0010, tuck=0.005, crouch=0.0015, **RUN)
    jump(rig)
    pose_air(rig, 'fall', frames=16, legs_fwd=0.5, tail_up=0.25, head_up=0.15, wiggle=0.15)
    land(rig, targets)
    swim(rig, **SWIM)
    bite(rig)
    flinch(rig, 'flinch_left', 1)
    flinch(rig, 'flinch_right', -1)
    collapse(rig)
    # The IK helpers only exist to bake; drop them so the export is a plain FK rig.
    for leg in LEGS:
        pb = rig.pose.bones['lower_' + leg]
        pb.constraints.remove(pb.constraints[0])
        bpy.data.objects.remove(targets[leg])
    # Push each action to its own NLA track so the exporter sees all of them, then clear the active one.
    for act in bpy.data.actions:
        track = rig.animation_data.nla_tracks.new()
        track.name = act.name
        strip = track.strips.new(act.name, int(act.frame_range[0]), act)
        strip.name = act.name
    rig.animation_data.action = None


def main():
    reset_scene()
    mats = make_materials()
    rig = build_armature()
    build_mesh(rig, mats)
    build_animations(rig)
    export(rig)


if __name__ == '__main__':
    main()

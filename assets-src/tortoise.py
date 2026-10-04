"""Generate a Galapagos giant tortoise (domed form, proportions from side-on photos of Santa Cruz
tortoises on iNaturalist) with its animation clips -> src/assets/tortoise.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/tortoise.py

Same conventions as assets-src/lizard.py (Blender space, Z up): the tortoise faces -Y, which the
glTF exporter turns into +Z forward, Y up. Units are metres at game scale, which is about a fifth of
real size so it stays in proportion to the 0.19 m iguana: the shell is 0.24 m long (1.2 m real),
its top 0.155 m off the ground when standing, and the feet rest on z = 0.

Clips (30 fps): idle, walk (loops at TORTOISE_GAIT_SPEED), eat (bite lands on BITE_FRAME),
withdraw (startle and hiss; hold its last frame while hidden), emerge, stand_tall (rises for
finches), lie_down, rest (loops lying down), get_up.

Grounded clips place the feet with IK targets and bake the result to plain keys, as the lizard does,
so planted feet never slide.
"""

import math
import os

import bpy
import numpy as np
from mathutils import Vector

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'tortoise.glb')
FPS = 30

# Walk: a lateral-sequence gait (hind left, fore left, hind right, fore right), each foot planted
# three quarters of the time so at least three feet are always down.
WALK = dict(frames=48, stride=0.021, duty=0.75, lift=0.011)
TORTOISE_GAIT_SPEED = 2 * WALK['stride'] / (WALK['duty'] * WALK['frames'] / FPS)  # m/s at rate 1
BITE_FRAME = 32

# ---------------------------------------------------------------------------------------------
# Shape (Blender space, metres at game scale)
# ---------------------------------------------------------------------------------------------
SHELL_L, SHELL_W, SHELL_TOP = 0.120, 0.086, 0.128  # half length, half width, top of the dome
CROWN_Y = 0.016  # the dome's high point sits behind the middle, so the front slopes longer
SHELL_P = 2.3  # superellipse exponent of the outline: a rounded oblong
DROP = 0.017  # how far the body sinks to rest its plastron on the ground


def rim_z(theta):
    """Height of the carapace edge at outline angle theta (0 = front): low over the bridge at the
    sides, flared up at the front over the neck and a little at the back over the tail."""
    c = math.cos(theta)
    return 0.025 + 0.032 * max(0.0, c) ** 1.3 - 0.004 * max(0.0, -c) ** 1.6


def outline(theta):
    """Unit-scale point on the shell outline (x, y); theta 0 = front (-Y), positive = left (+X)."""
    s, c = math.sin(theta), math.cos(theta)
    e = 2 / SHELL_P
    return math.copysign(abs(s) ** e, s), -math.copysign(abs(c) ** e, c)


def leg_points(side, front):
    """Shoulder/hip, elbow/knee and ankle. Forelegs bow out at the elbow; hind legs are columns."""
    if front:
        return (side * 0.048, -0.070, 0.045), (side * 0.074, -0.084, 0.031), (side * 0.076, -0.094, 0.009)
    return (side * 0.044, 0.062, 0.042), (side * 0.060, 0.070, 0.028), (side * 0.060, 0.078, 0.009)


HEAD_CENTRE = (0, -0.152, 0.0760)
NECK_PATH = [(0, -0.080, 0.048), (0, -0.099, 0.056), (0, -0.117, 0.064), (0, -0.136, 0.071)]


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def track(f, keys):
    """Scalar animation channel: keys [(frame, value), ...], eased between keys, held past the ends."""
    if f <= keys[0][0]:
        return keys[0][1]
    for (f0, v0), (f1, v1) in zip(keys, keys[1:]):
        if f <= f1:
            return lerp(v0, v1, smooth((f - f0) / (f1 - f0)))
    return keys[-1][1]


def srgb_lin(c):
    return tuple(v ** 2.2 for v in c)


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


# ---------------------------------------------------------------------------------------------
# Texture atlas, 1024 x 512, painted with numpy (Blender convention: row 0 is the bottom).
# Left half: the carapace seen from above (u, v = scaled x, -y). Right half: skin, rows banded by
# part (neck, legs, head) with wrinkles and scales.
# ---------------------------------------------------------------------------------------------
TEX_W, TEX_H = 1024, 512
SHELL_UV_PAD = 1.03
SKIN_BANDS = {'neck': (0.0, 0.3), 'leg': (0.3, 0.8), 'head': (0.8, 1.0)}


def shell_uv(xn, yn):
    """Normalised carapace coordinates (-1..1) to atlas UV."""
    return 0.25 + 0.25 * xn / SHELL_UV_PAD, 0.5 - 0.5 * yn / SHELL_UV_PAD


def skin_uv(band, t, a):
    v0, v1 = SKIN_BANDS[band]
    return 0.5 + 0.5 * ((a / (2 * math.pi)) % 1.0) * 0.999, lerp(v0, v1, min(0.999, max(0.001, t)))


def distance_to_edges(ids, max_d=40):
    """Pixel distance from each pixel to the nearest pixel of a different region (chamfer, 8-way)."""
    h, w = ids.shape
    edge = np.zeros_like(ids, dtype=bool)
    edge[:-1] |= ids[:-1] != ids[1:]
    edge[1:] |= ids[1:] != ids[:-1]
    edge[:, :-1] |= ids[:, :-1] != ids[:, 1:]
    edge[:, 1:] |= ids[:, 1:] != ids[:, :-1]
    d = np.where(edge, 0.0, float(max_d))
    for _ in range(max_d):
        p = np.pad(d, 1, constant_values=max_d)
        cand = [p[1:-1, :-2] + 1, p[1:-1, 2:] + 1, p[:-2, 1:-1] + 1, p[2:, 1:-1] + 1,
                p[:-2, :-2] + 1.414, p[:-2, 2:] + 1.414, p[2:, :-2] + 1.414, p[2:, 2:] + 1.414]
        d = np.minimum(d, np.min(cand, axis=0))
    return d


def paint_shell(rng):
    n = TEX_H
    v, u = np.mgrid[0:n, 0:n] + 0.5
    xn = (u / n * 2 - 1) * SHELL_UV_PAD
    yn = (1 - 2 * v / n) * SHELL_UV_PAD  # front (-Y) at the top of the image
    r = (np.abs(xn) ** SHELL_P + np.abs(yn) ** SHELL_P) ** (1 / SHELL_P)
    phi = np.arctan2(xn, -yn)
    # Scutes: a ring of 24 marginals (nuchal at the front, supracaudal at the back), five
    # vertebrals down the middle, four costals each side with seams offset from the vertebrals'.
    ids = np.zeros((n, n), dtype=np.int32)
    marginal = r > 0.84
    ids[marginal] = 100 + (np.round(phi[marginal] / (2 * np.pi) * 24).astype(int) % 24)
    band = 0.30 * (1 - 0.25 * np.abs(yn))
    vert = ~marginal & (np.abs(xn) < band)
    ids[vert] = 200 + np.clip(((yn[vert] + 0.84) / 1.68 * 5).astype(int), 0, 4)
    cost = ~marginal & ~vert
    ids[cost] = 300 + 10 * (xn[cost] > 0) + np.clip(((yn[cost] + 0.78) / 1.56 * 4).astype(int), 0, 3)
    d = distance_to_edges(ids)
    base = np.array(hexrgb('#5b5147'))
    img = np.tile(base, (n, n, 1))
    # Each scute a slightly different tone, its centre (the areola) paler and rougher.
    for sid in np.unique(ids):
        m = ids == sid
        img[m] *= 0.9 + 0.2 * rng.random()
    areola = np.clip(1 - d / 40, 0, 1) ** 2
    img = img * (1 - 0.35 * areola[..., None]) + np.array(hexrgb('#6a6052')) * 0.35 * areola[..., None]
    # Concentric growth rings parallel to the seams, and deep dark seams.
    wob = 1.5 * np.sin(u / 9.0) * np.sin(v / 11.0)
    rings = (np.sin((d + wob) * 2 * np.pi / 7.0) > 0.75) & (d > 4) & (d < 26)
    img[rings] *= 0.88
    seam = np.clip(1 - d / 3.0, 0, 1)[..., None]
    img = img * (1 - seam) + np.array(hexrgb('#16130f')) * seam
    # Dusty wear on the high top of the dome.
    noise = rng.random((n // 8, n // 8)).repeat(8, 0).repeat(8, 1)
    top = np.clip(1 - r / 0.6, 0, 1)[..., None] * (0.5 + 0.5 * noise[..., None])
    img = img * (1 - 0.25 * top) + np.array(hexrgb('#7d7466')) * 0.25 * top
    return np.clip(img, 0, 1)


def voronoi_cells(h, w, count, rng, aspect=1.0):
    """Distance to the nearest seed and to the second nearest, wrapping horizontally."""
    seeds = rng.random((count, 2)) * (h, w)
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    d1 = np.full((h, w), 1e9)
    d2 = np.full((h, w), 1e9)
    for sy, sx in seeds:
        dx = np.abs(xx - sx)
        dx = np.minimum(dx, w - dx)
        dd = np.sqrt(dx ** 2 + ((yy - sy) * aspect) ** 2)
        d2 = np.where(dd < d1, d1, np.minimum(d2, dd))
        d1 = np.minimum(d1, dd)
    return d1, d2


def paint_skin(rng):
    h, w = TEX_H, TEX_W // 2
    base = np.array(hexrgb('#6a655d'))
    img = np.tile(base, (h, w, 1))
    rows = {k: (int(a * h), int(b * h)) for k, (a, b) in SKIN_BANDS.items()}
    for part, count, aspect in (('neck', 520, 1.6), ('leg', 170, 1.0), ('head', 260, 1.0)):
        r0, r1 = rows[part]
        d1, d2 = voronoi_cells(r1 - r0, w, count, rng, aspect)
        edge = np.clip(1 - (d2 - d1) / 2.5, 0, 1)
        dome = np.clip(d1 / (d1 + d2 + 1e-6) * 2, 0, 1)
        tile = np.tile(base, (r1 - r0, w, 1))
        tile *= (1.08 - 0.25 * dome)[..., None]  # scales paler in the middle
        tile = tile * (1 - 0.45 * edge[..., None]) + np.array(hexrgb('#2c2a26')) * 0.45 * edge[..., None]
        if part == 'neck':
            # Loose folds around the neck.
            yy = np.arange(r1 - r0)[:, None] + 3 * np.sin(np.arange(w)[None, :] / w * 2 * np.pi * 3)
            fold = (np.sin(yy / (r1 - r0) * 2 * np.pi * 9) > 0.8)
            tile[fold] *= 0.85
        img[r0:r1] = tile
    return np.clip(img, 0, 1)


def make_texture():
    rng = np.random.default_rng(7)
    atlas = np.zeros((TEX_H, TEX_W, 3))
    atlas[:, :TEX_W // 2] = paint_shell(rng)
    atlas[:, TEX_W // 2:] = paint_skin(rng)
    rgba = np.concatenate([atlas, np.ones((TEX_H, TEX_W, 1))], axis=2).astype(np.float32)
    img = bpy.data.images.new('TortoiseSkin', TEX_W, TEX_H, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'JPEG'
    img.pack()
    return img


COLORS = {
    'Skin': None,  # textured: carapace and skin share one atlas
    'Plastron': srgb_lin(hexrgb('#6e5d45')),
    'Beak': srgb_lin(hexrgb('#3d3933')),
    'Nail': srgb_lin(hexrgb('#4a453d')),
    'Eye': srgb_lin(hexrgb('#141110')),
    'Shine': (1.0, 1.0, 1.0),
}
SOLID_UV = (0.75, 0.5)


def make_materials():
    mats = {}
    tex = make_texture()
    for name, rgb in COLORS.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = 0.85
        if rgb is None:
            node = m.node_tree.nodes.new('ShaderNodeTexImage')
            node.image = tex
            m.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        mats[name] = m
    return mats


# ---------------------------------------------------------------------------------------------
# Mesh: one mesh skinned to one armature; every vertex is tagged with the bone(s) that own it.
# ---------------------------------------------------------------------------------------------
class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.face_mats, self.face_uvs, self.weights = [], [], [], [], []

    def vert(self, co, weights):
        self.verts.append(Vector(co))
        self.weights.append(weights if isinstance(weights, dict) else {weights: 1.0})
        return len(self.verts) - 1

    def face(self, idx, mat, uvs=None, flip=False):
        if flip:  # reverse the winding so the normal points the other way
            idx = idx[::-1]
            uvs = uvs[::-1] if uvs else uvs
        self.faces.append(idx)
        self.face_mats.append(mat)
        self.face_uvs.append(uvs)


def dome_point(th, s):
    """Point on the carapace at outline angle th, a fraction s of the way from the crown to the rim."""
    ox, oy = outline(th)
    zr = rim_z(th)
    return (s * ox * SHELL_W, CROWN_Y * (1 - s) + s * oy * SHELL_L, zr + (SHELL_TOP - zr) * (1 - s ** 2.2) ** 0.5)


def lip_point(th):
    """The outermost point of the lip that rolls under the carapace's edge."""
    ox, oy = outline(th)
    flare = 1.025 + 0.02 * max(0.0, -math.cos(th)) ** 2
    return (flare * ox * SHELL_W, flare * oy * SHELL_L, rim_z(th) - 0.004)


def shell_hull_points():
    """The carapace's outside for the game's solid shell, in glTF space (x, up, toward the head):
    the crown, rings down the dome and the lip. The game adds the plastron underneath."""
    pts = [(0.0, CROWN_Y, SHELL_TOP)]
    for k in range(32):
        th = 2 * math.pi * k / 32
        pts += [dome_point(th, s) for s in (0.3, 0.55, 0.75, 0.9)] + [lip_point(th)]
    return [round(v, 5) for x, y, z in pts for v in (x, z, -y)]


def build_carapace(mb):
    """The dome as rings from the crown out to the rim, then a lip that rolls under. UVs follow arc
    length down each meridian so the scutes on the steep sides aren't stretched."""
    n_around, rings = 64, 20
    ss = [math.sin(math.pi / 2 * i / rings) for i in range(1, rings + 1)]
    cols = []
    for k in range(n_around):
        th = 2 * math.pi * k / n_around
        ox, oy = outline(th)
        zr = rim_z(th)
        pts = [(0.0, 0.0, SHELL_TOP)]
        for s in ss:
            pts.append(dome_point(th, s))
        # Lip: out and down a little, then tucked back under.
        pts.append(lip_point(th))
        pts.append((0.975 * ox * SHELL_W, 0.975 * oy * SHELL_L, zr - 0.009))
        arc = [0.0]
        for a, b in zip(pts[:rings], pts[1:rings + 1]):
            arc.append(arc[-1] + (Vector(b) - Vector(a)).length)
        frac = [a / arc[-1] for a in arc] + [0.995, 0.99]
        cols.append([(p, shell_uv(f * ox, f * oy)) for p, f in zip(pts, frac)])
    crown = mb.vert((0.0, CROWN_Y, SHELL_TOP), 'body')
    ids = [[mb.vert(p, 'body') for p, _ in col[1:]] for col in cols]
    for k in range(n_around):
        k2 = (k + 1) % n_around
        mb.face([crown, ids[k][0], ids[k2][0]], 'Skin', [cols[k][0][1], cols[k][1][1], cols[k2][1][1]])
        for i in range(len(ids[k]) - 1):
            mb.face([ids[k][i], ids[k][i + 1], ids[k2][i + 1], ids[k2][i]], 'Skin',
                    [cols[k][i + 1][1], cols[k][i + 2][1], cols[k2][i + 2][1], cols[k2][i + 1][1]])


def blob(mb, centre, radii, weights, mat, rings=8, sides=16, band=None):
    """Ellipsoid. With band, it gets skin UVs (around = u, top-to-bottom = v); else a solid colour."""
    cx, cy, cz = centre
    rx, ry, rz = radii
    grid = []
    for i in range(rings + 1):
        phi = math.pi * i / rings
        grid.append([mb.vert((cx + rx * math.sin(phi) * math.cos(2 * math.pi * k / sides),
                              cy + ry * math.sin(phi) * math.sin(2 * math.pi * k / sides),
                              cz + rz * math.cos(phi)), weights) for k in range(sides)])
    for i in range(rings):
        for k in range(sides):
            k2 = (k + 1) % sides
            uvs = None
            if band:
                a0, a1 = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
                uvs = [skin_uv(band, i / rings, a0), skin_uv(band, i / rings, a1),
                       skin_uv(band, (i + 1) / rings, a1), skin_uv(band, (i + 1) / rings, a0)]
            mb.face([grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]], mat, uvs, flip=True)


def tube(mb, path, radii, weights_at, band, mat='Skin', sides=12, flat=1.0, cap=False):
    """Tube through path (list of points) with matching radii; weights_at(t) gives each ring's bone
    weights. flat squashes it vertically (forelegs are flattened paddles)."""
    rings = []
    n = len(path)
    for i, (c, r) in enumerate(zip(path, radii)):
        c = Vector(c)
        a = Vector(path[min(i + 1, n - 1)]) - Vector(path[max(i - 1, 0)])
        axis = a.normalized()
        side = axis.cross(Vector((0, 0, 1)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(axis).normalized()
        t = i / (n - 1)
        rings.append([mb.vert(c + r * (math.cos(2 * math.pi * k / sides) * side * flat + math.sin(2 * math.pi * k / sides) * up),
                              weights_at(t)) for k in range(sides)])
    for i in range(n - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            uvs = None
            if mat == 'Skin':
                t0, t1 = i / (n - 1), (i + 1) / (n - 1)
                a0, a1 = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
                uvs = [skin_uv(band, t0, a0), skin_uv(band, t0, a1), skin_uv(band, t1, a1), skin_uv(band, t1, a0)]
            mb.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat, uvs, flip=True)
    if cap:
        tip = mb.vert(path[-1], weights_at(1.0))
        for k in range(sides):
            mb.face([rings[-1][k], rings[-1][(k + 1) % sides], tip], mat,
                    [SOLID_UV] * 3 if mat != 'Skin' else [skin_uv(band, 1, 0)] * 3, flip=True)


def neck_weights(t):
    """Blend neck1 -> neck2 -> head along the neck; the last stretch runs inside the head and moves
    with it, so the skin never parts from the skull when the head turns."""
    if t < 0.2:
        return {'neck1': 1.0}
    if t < 0.4:
        return {'neck1': 1 - (t - 0.2) / 0.2, 'neck2': (t - 0.2) / 0.2}
    if t < 0.6:
        return {'neck2': 1.0}
    if t < 0.75:
        return {'neck2': 1 - (t - 0.6) / 0.15, 'head': (t - 0.6) / 0.15}
    return {'head': 1.0}


def build_body(mb):
    build_carapace(mb)
    # Soft body filling the openings under the shell, and the flat horn plastron underneath.
    blob(mb, (0, 0.0, 0.043), (0.072, 0.104, 0.024), 'body', 'Skin', band='leg')
    blob(mb, (0, 0.004, 0.027), (0.077, 0.100, 0.009), 'body', 'Plastron', rings=6, sides=24)
    # A short pointed tail.
    tube(mb, [(0, 0.098, 0.036), (0, 0.115, 0.031), (0, 0.130, 0.024)], [0.010, 0.007, 0.002],
         lambda t: 'tail', 'leg', sides=10, cap=True)


def build_neck_head(mb):
    # Neck: a long loose tube, thick at the shell and narrowing toward the head.
    path, radii = [], []
    # As thick as the head is tall, barely tapering; it runs on into the skull so there's no seam.
    pts = [Vector(p) for p in NECK_PATH] + [Vector(HEAD_CENTRE)]
    segs = len(pts) - 1
    for i in range(17):
        t = i / 16
        seg = min(int(t * segs), segs - 1)
        path.append(tuple(pts[seg].lerp(pts[seg + 1], t * segs - seg)))
        radii.append(lerp(0.0145, 0.0105, t))
    tube(mb, path, radii, neck_weights, 'neck', sides=14, flat=1.1)
    # Head: a blunt dome of a skull over a horn beak, the lower jaw its own bone.
    blob(mb, HEAD_CENTRE, (0.0136, 0.0210, 0.0108), 'head', 'Skin', band='head')
    blob(mb, (0, -0.1690, 0.0728), (0.0066, 0.0042, 0.0046), 'head', 'Beak', rings=6, sides=12)
    blob(mb, (0, -0.152, 0.0680), (0.0108, 0.0175, 0.0055), 'jaw', 'Skin', band='head')
    blob(mb, (0, -0.1670, 0.0672), (0.0058, 0.0038, 0.0030), 'jaw', 'Beak', rings=6, sides=12)
    for side in (1, -1):
        c = (side * 0.0115, -0.1590, 0.0795)
        blob(mb, c, (0.0026, 0.0026, 0.0026), 'head', 'Eye', rings=6, sides=10)
        blob(mb, (c[0] + side * 0.0012, c[1] - 0.0009, c[2] + 0.0009), (0.0006, 0.0006, 0.0006), 'head', 'Shine', rings=4, sides=6)
        # Heavy lid folds over each eye, and the nostrils.
        blob(mb, (side * 0.0111, -0.1585, 0.0824), (0.0032, 0.0034, 0.0013), 'head', 'Skin', rings=5, sides=10, band='head')
        blob(mb, (side * 0.0026, -0.1710, 0.0792), (0.0011, 0.0009, 0.0008), 'head', 'Eye', rings=4, sides=6)


def leg_name(side, front):
    return ('front' if front else 'hind') + ('_L' if side > 0 else '_R')


LEGS = [leg_name(s, f) for f in (True, False) for s in (1, -1)]


def build_legs(mb):
    for front in (True, False):
        for side in (1, -1):
            n = leg_name(side, front)
            root, knee, ankle = (Vector(p) for p in leg_points(side, front))
            up, lo = 'upper_' + n, 'lower_' + n
            inner = root + (root - knee).normalized() * 0.012
            if front:
                # Flattened, armoured forelegs, widest at the wrist.
                tube(mb, [inner, root, knee], [0.0140, 0.0145, 0.0145], lambda t: up, 'leg', flat=0.9)
                tube(mb, [knee, knee.lerp(ankle, 0.5), ankle], [0.0145, 0.0155, 0.0150], lambda t: lo, 'leg', flat=0.85)
                pad, pr, nails = (ankle.x + side * 0.002, ankle.y - 0.004, 0.0055), (0.0150, 0.0160, 0.0062), 5
            else:
                # Columnar, elephant-like hind legs.
                tube(mb, [inner, root, knee], [0.0170, 0.0175, 0.0170], lambda t: up, 'leg')
                tube(mb, [knee, knee.lerp(ankle, 0.5), ankle], [0.0170, 0.0175, 0.0180], lambda t: lo, 'leg')
                pad, pr, nails = (ankle.x, ankle.y - 0.001, 0.0060), (0.0185, 0.0190, 0.0065), 4
            blob(mb, knee, (0.0146, 0.0146, 0.0146) if front else (0.0173, 0.0173, 0.0173), up, 'Skin', 6, 12, band='leg')
            blob(mb, pad, pr, lo, 'Skin', 6, 14, band='leg')
            # Short blunt nails around the front of the foot.
            spread = 1.5
            for i in range(nails):
                a = lerp(-spread / 2, spread / 2, i / (nails - 1)) + side * 0.25
                dx, dy = math.sin(a), -math.cos(a)
                base = (pad[0] + dx * pr[0] * 0.85, pad[1] + dy * pr[1] * 0.85, 0.0030)
                tip = (pad[0] + dx * (pr[0] + 0.0035), pad[1] + dy * (pr[1] + 0.0035), 0.0012)
                tube(mb, [base, tip], [0.0019, 0.0007], lambda t: lo, None, mat='Nail', sides=6, cap=True)


def build_mesh(rig, mats):
    mb = MeshBuilder()
    build_body(mb)
    build_neck_head(mb)
    build_legs(mb)
    me = bpy.data.meshes.new('TortoiseMesh')
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
    obj = bpy.data.objects.new('TortoiseBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones if b.name != 'root'}
    for i, w in enumerate(mb.weights):
        for bone, x in w.items():
            groups[bone].add([i], x, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


# ---------------------------------------------------------------------------------------------
# Armature: root on the ground, body (the shell) above it, a two-bone neck, head and jaw, a tail,
# and two-bone legs. With roll 0, a bone pointing forward has local Z up: X pitches (positive
# tips it down), Z turns it left/right, Y rolls about it.
# ---------------------------------------------------------------------------------------------
def build_armature():
    data = bpy.data.armatures.new('TortoiseRig')
    rig = bpy.data.objects.new('Tortoise', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones

    def bone(name, head, tail, parent=None, connect=False):
        b = eb.new(name)
        b.head, b.tail = head, tail
        b.parent, b.use_connect = parent, connect
        b.roll = 0.0
        return b

    root = bone('root', (0, 0, 0), (0, 0, 0.01))
    body = bone('body', (0, 0.02, 0.045), (0, -0.02, 0.045), root)
    n1 = bone('neck1', NECK_PATH[0], NECK_PATH[2], body)
    n2 = bone('neck2', NECK_PATH[2], NECK_PATH[3], n1, True)
    head = bone('head', NECK_PATH[3], (0, -0.176, 0.076), n2, True)
    bone('jaw', (0, -0.140, 0.071), (0, -0.172, 0.0675), head)
    bone('tail', (0, 0.098, 0.036), (0, 0.130, 0.024), body)
    for front in (True, False):
        for side in (1, -1):
            n = leg_name(side, front)
            r, k, a = leg_points(side, front)
            up = bone('upper_' + n, r, k, body)
            bone('lower_' + n, k, a, up, True)
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


# ---------------------------------------------------------------------------------------------
# Animation. Every clip is a pose function of the frame: bone rotations and locations (bone-local),
# and where each ankle should be (armature space). The body and neck are keyed directly; the legs
# are solved with IK to reach the ankle targets and baked to FK keys.
# ---------------------------------------------------------------------------------------------
def rest_ankle(rig, leg):
    return rig.data.bones['lower_' + leg].tail_local.copy()


def setup_ik(rig):
    targets = {}
    for leg in LEGS:
        empty = bpy.data.objects.new('ik_' + leg, None)
        bpy.context.collection.objects.link(empty)
        empty.location = rest_ankle(rig, leg)
        c = rig.pose.bones['lower_' + leg].constraints.new('IK')
        c.target = empty
        c.chain_count = 2
        c.mute = True
        targets[leg] = empty
    return targets


def clip(rig, targets, name, frames, pose, step=1):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    fs = list(range(0, frames + 1, step))
    if fs[-1] != frames:
        fs.append(frames)
    feet = {}
    for f in fs:
        rot, loc, ankles = pose(f)
        for b in ('body', 'neck1', 'neck2', 'head', 'jaw', 'tail', 'root'):
            pb = rig.pose.bones[b]
            pb.rotation_euler = rot.get(b, (0, 0, 0))
            pb.keyframe_insert('rotation_euler', frame=f)
            pb.location = loc.get(b, (0, 0, 0))
            pb.keyframe_insert('location', frame=f)
        feet[f] = {leg: ankles.get(leg, rest_ankle(rig, leg)) for leg in LEGS}
    # Legs: IK to the ankle targets, then bake.
    scene = bpy.context.scene
    for leg in LEGS:
        rig.pose.bones['lower_' + leg].constraints[0].mute = False
    solved = []
    for f in fs:
        scene.frame_set(f)
        for leg in LEGS:
            targets[leg].location = feet[f][leg]
        bpy.context.view_layer.update()
        pose_m = {}
        for leg in LEGS:
            for part in ('upper_', 'lower_'):
                pb = rig.pose.bones[part + leg]
                pose_m[pb.name] = rig.convert_space(pose_bone=pb, matrix=pb.matrix, from_space='POSE', to_space='LOCAL')
        solved.append((f, pose_m))
    for leg in LEGS:
        rig.pose.bones['lower_' + leg].constraints[0].mute = True
    for f, pose_m in solved:
        for name, m in pose_m.items():
            pb = rig.pose.bones[name]
            pb.rotation_euler = m.to_euler('XYZ')
            pb.keyframe_insert('rotation_euler', frame=f)
    return act


def offset(rig, leg, dx=0.0, dy=0.0, dz=0.0):
    p = rest_ankle(rig, leg)
    s = 1 if leg.endswith('_L') else -1
    return Vector((p.x + s * dx, p.y + dy, p.z + dz))


def body_loc(dz):
    """The body bone points forward, so its local Z is world up."""
    return (0, 0, dz)


def neck_loc(extend):
    """neck1 points forward along the neck: local Y slides the whole neck out of / into the shell."""
    return (0, extend, 0)


# Poses shared between clips: (body drop, neck extend, neck1/neck2/head pitch, jaw, feet offsets).
TUCKED_FEET = {'front': (-0.040, -0.026, 0.012), 'hind': (-0.006, 0.020, 0.0)}
LYING_FEET = {'front': (0.010, -0.030, 0.0), 'hind': (0.008, 0.034, 0.0)}


def feet_blend(rig, amount, offsets):
    """Ankle targets moved by `amount` (0..1) of the per-pair offsets (dx outward, dy, dz)."""
    out = {}
    for leg in LEGS:
        dx, dy, dz = offsets['front' if leg.startswith('front') else 'hind']
        out[leg] = offset(rig, leg, dx * amount, dy * amount, dz * amount)
    return out


def idle(rig, targets):
    frames = 120

    def pose(f):
        w = 2 * math.pi * f / frames
        breath = math.sin(2 * w)
        rot = {
            'body': (0.006 * breath, 0, 0),
            'neck1': (0.05 + 0.05 * math.sin(w + 1.0), 0, 0.28 * math.sin(w)),
            'neck2': (-0.04 * math.sin(w + 1.0), 0, 0.10 * math.sin(w - 0.4)),
            'head': (0.06 * math.sin(2 * w), 0, 0.12 * math.sin(w - 0.8)),
            'tail': (0, 0, 0.05 * math.sin(w)),
        }
        return rot, {'body': body_loc(0.0008 * breath), 'neck1': neck_loc(-0.002 + 0.002 * breath)}, {}

    clip(rig, targets, 'idle', frames, pose, step=3)


def walk(rig, targets, frames, stride, duty, lift):
    phase = {'hind_L': 0.0, 'front_L': 0.25, 'hind_R': 0.5, 'front_R': 0.75}

    def foot(leg, f):
        p = (f / frames + phase[leg]) % 1.0
        if p < duty:  # stance: planted, sliding back under the body
            y, z = lerp(-stride, stride, p / duty), 0.0
        else:  # swing: lift and plod forward again
            q = (p - duty) / (1 - duty)
            y = lerp(stride, -stride, smooth(q))
            z = lift * math.sin(math.pi * q) ** 0.8
        return offset(rig, leg, 0, y, z)

    def pose(f):
        w = 2 * math.pi * f / frames
        rot = {
            # The shell rolls toward whichever side is bearing weight and yaws a touch with each step.
            'body': (0.012 * math.sin(4 * w), 0.045 * math.sin(w + 0.6), 0.025 * math.sin(w)),
            'neck1': (0.0, 0, -0.06 * math.sin(w)),
            'neck2': (0.03 * math.sin(4 * w + 1.0), 0, -0.03 * math.sin(w)),
            'head': (-0.03 * math.sin(4 * w + 1.4), 0, 0.04 * math.sin(w)),
            'tail': (0, 0, 0.12 * math.sin(w - 0.8)),
        }
        loc = {'body': body_loc(0.0035 + 0.0018 * math.cos(4 * w)), 'neck1': neck_loc(0.006)}
        return rot, loc, {leg: foot(leg, f) for leg in LEGS}

    clip(rig, targets, 'walk', frames, pose)


def eat(rig, targets):
    """Reach down to a plant, open, bite on BITE_FRAME, tug it free, chew, look up again."""
    frames = 120
    B = BITE_FRAME
    n1 = [(0, 0.0), (B - 14, 0.55), (B, 0.62), (B + 8, 0.40), (B + 18, 0.18), (90, 0.18), (110, 0.0)]
    n2 = [(0, 0.0), (B - 14, 0.45), (B, 0.50), (B + 8, 0.30), (B + 18, 0.05), (90, 0.05), (110, 0.0)]
    hd = [(0, 0.0), (B - 14, 0.35), (B, 0.30), (B + 8, -0.05), (B + 18, -0.02), (90, -0.02), (110, 0.0)]
    ext = [(0, 0.0), (B - 14, 0.014), (B, 0.016), (B + 8, 0.004), (B + 18, 0.006), (90, 0.006), (110, 0.0)]
    bd = [(0, 0.0), (B - 14, 0.07), (B, 0.08), (B + 18, 0.02), (110, 0.0)]
    drop = [(0, 0.0), (B - 14, -0.006), (B, -0.007), (B + 18, -0.002), (110, 0.0)]

    def jaw(f):
        if f < B - 8:
            return 0.0
        if f < B:
            return 0.45 * smooth((f - (B - 8)) / 4) if f < B - 4 else 0.45 * (1 - smooth((f - (B - 4)) / 4))
        if B + 20 <= f < 90:  # chewing
            return 0.18 * (0.5 - 0.5 * math.cos(2 * math.pi * (f - B - 20) / 7))
        return 0.0

    def pose(f):
        tug = math.sin(math.pi * min(1, max(0, (f - B) / 10))) if f >= B else 0.0
        rot = {
            'body': (track(f, bd), 0, 0),
            'neck1': (track(f, n1), 0, 0),
            'neck2': (track(f, n2), 0, 0),
            'head': (track(f, hd), 0, 0.18 * tug * math.sin((f - B) * 1.3)),
            'jaw': (jaw(f), 0, 0),
        }
        return rot, {'body': body_loc(track(f, drop)), 'neck1': neck_loc(track(f, ext))}, {}

    clip(rig, targets, 'eat', frames, pose)


def withdraw_pose(rig, h, mouth=0.0):
    """h: 0 out, 1 fully withdrawn: head and neck pulled back into the shell in an S, forelegs
    folded across the opening, shell dropped onto the ground."""
    rot = {
        'neck1': (0.30 * h, 0, 0),
        'neck2': (-0.70 * h, 0, 0),
        'head': (0.45 * h, 0, 0),
        'jaw': (mouth, 0, 0),
        'tail': (0.5 * h, 0, 0),
    }
    loc = {'body': body_loc(-DROP * smooth((h - 0.2) / 0.8)), 'neck1': neck_loc(-0.046 * h)}
    return rot, loc, feet_blend(rig, smooth((h - 0.1) / 0.9), TUCKED_FEET)


def withdraw(rig, targets):
    """A startled snap back into the shell with a hiss (mouth open as the air is forced out)."""
    frames = 14

    def pose(f):
        h = 1 - (1 - f / frames) ** 2.5  # fast at first
        mouth = 0.25 * math.sin(math.pi * min(1, f / 10))
        return withdraw_pose(rig, h, mouth)

    clip(rig, targets, 'withdraw', frames, pose)


def emerge(rig, targets):
    """Slow and wary: the head peeks out first and looks, then the legs come out and the shell rises."""
    frames = 75

    def pose(f):
        neck = track(f, [(0, 1.0), (18, 0.45), (40, 0.45), (65, 0.0)])
        body = track(f, [(0, 1.0), (40, 1.0), (70, 0.0)])
        rot, loc, _ = withdraw_pose(rig, neck)
        loc['body'] = body_loc(-DROP * body)
        look = 0.35 * math.sin(2 * math.pi * max(0, f - 18) / 22) if 18 <= f < 40 else 0.0
        rot['neck2'] = (rot['neck2'][0], 0, look)
        return rot, loc, feet_blend(rig, smooth(body), TUCKED_FEET)

    clip(rig, targets, 'emerge', frames, pose)


def stand_tall(rig, targets):
    """Rises high on straightened legs and stretches the neck up, the invitation for finches to land
    and pick off ticks; holds, then settles."""
    frames = 150

    def pose(f):
        u = track(f, [(0, 0.0), (30, 1.0), (120, 1.0), (150, 0.0)])
        sway = 0.04 * math.sin(2 * math.pi * f / 50) * u
        rot = {
            'body': (-0.05 * u, sway * 0.5, 0),
            'neck1': (-0.75 * u, 0, sway),
            'neck2': (-0.25 * u, 0, 0),
            'head': (0.75 * u, 0, -sway),
        }
        loc = {'body': body_loc(0.012 * u), 'neck1': neck_loc(0.014 * u)}
        return rot, loc, feet_blend(rig, u, {'front': (0.004, -0.004, 0.0), 'hind': (-0.004, 0.0, 0.0)})

    clip(rig, targets, 'stand_tall', frames, pose)


def lying_pose(rig, u, breath=0.0):
    """u: 0 standing, 1 lying with the plastron on the ground, legs splayed and chin down."""
    rot = {
        'body': (0.004 * breath, 0, 0),
        'neck1': (0.38 * u, 0, 0.12 * u),
        'neck2': (0.05 * u, 0, 0.05 * u),
        'head': (-0.20 * u, 0, 0),
        'tail': (0.3 * u, 0, 0),
    }
    loc = {'body': body_loc(-DROP * u + 0.0007 * breath), 'neck1': neck_loc(0.010 * u)}
    return rot, loc, feet_blend(rig, u, LYING_FEET)


def lie_down(rig, targets, name, reverse):
    frames = 60

    def pose(f):
        t = f / frames
        return lying_pose(rig, smooth(1 - t if reverse else t))

    clip(rig, targets, name, frames, pose, step=2)


def rest(rig, targets):
    frames = 150

    def pose(f):
        return lying_pose(rig, 1.0, math.sin(2 * math.pi * f / frames * 2))

    clip(rig, targets, 'rest', frames, pose, step=3)


def build_animations(rig):
    targets = setup_ik(rig)
    idle(rig, targets)
    walk(rig, targets, **WALK)
    eat(rig, targets)
    withdraw(rig, targets)
    emerge(rig, targets)
    stand_tall(rig, targets)
    lie_down(rig, targets, 'lie_down', False)
    rest(rig, targets)
    lie_down(rig, targets, 'get_up', True)
    for leg in LEGS:
        pb = rig.pose.bones['lower_' + leg]
        pb.constraints.remove(pb.constraints[0])
        bpy.data.objects.remove(targets[leg])
    for act in bpy.data.actions:
        tr = rig.animation_data.nla_tracks.new()
        tr.name = act.name
        strip = tr.strips.new(act.name, int(act.frame_range[0]), act)
        strip.name = act.name
    rig.animation_data.action = None


def export(rig):
    # Facts the game would need, in glTF space (+Z toward the head, Y up).
    rig['gait_speed'] = TORTOISE_GAIT_SPEED
    rig['bite_time'] = BITE_FRAME / FPS
    rig['shell_top'] = SHELL_TOP
    rig['shell_half_extents'] = [SHELL_W, SHELL_L]
    rig['rest_drop'] = DROP
    rig['shell_hull'] = shell_hull_points()
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT), export_format='GLB', export_yup=True, export_apply=False,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True, export_morph=False,
        export_materials='EXPORT', export_texcoords=True, export_image_format='JPEG', export_jpeg_quality=88,
        export_extras=True, export_def_bones=False)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes; gait speed', round(TORTOISE_GAIT_SPEED, 4), 'm/s')


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    mats = make_materials()
    rig = build_armature()
    build_mesh(rig, mats)
    build_animations(rig)
    export(rig)


if __name__ == '__main__':
    main()

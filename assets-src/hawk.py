"""Generate a Galapagos hawk (Buteo galapagoensis) with its animation clips -> src/assets/hawk.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/hawk.py [out.glb]

Same conventions as the game's other creature scripts (Blender space, Z up): the hawk faces -Y,
which the glTF exporter turns into +Z forward, Y up; +X is its left. Units are metres at game
scale, a fifth of real size like the 0.19 m iguana: 0.11 m beak to tail tip, 0.25 m across the
wings (a real adult is about 55 cm long with a 1.25 m span).

The rest pose is the hawk gliding, wings spread and legs hanging. The armature origin is the middle
of its body; the game flies that point along the hawk's path.

Folded wings don't come from bending the spread ones: a broad wing skinned to three bones crumples
when folded. Instead each side has a second, folded wing lying along the flank on its own `fold`
bone. Flying clips scale `fold` to nothing; perched clips shrink the spread wing into the shoulder
(its `arm` bone scaled to nothing) and grow the folded one, and land and take off swap them while
the wings sweep.

Clips (30 fps): glide and flap (loops), stoop (diving, wings half shut, loops), strike (talons
thrown forward to hit, then the first wingbeat away; plays once), perch (sitting upright, scanning,
loops), land (flare, touch down, fold; plays once), take_off (open the wings, spring, beat away;
plays once). The game times its moves on the clips through extras on the armature: strike_time,
land_time, take_off_time, and where the talons and perched feet are relative to the origin.
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'hawk.glb')
FPS = 30

# ---------------------------------------------------------------------------------------------
# Shape (Blender space, metres at game scale).
# ---------------------------------------------------------------------------------------------
# Body, neck and head as one loft along Y: (y, half width, half height, centre z). Widest across the
# shoulders, a big head (buteos are broad-headed) and a short thick neck.
LOFT = [
    (0.0300, 0.0020, 0.0018, 0.0015),
    (0.0260, 0.0055, 0.0045, 0.0012),
    (0.0180, 0.0090, 0.0085, 0.0004),
    (0.0080, 0.0118, 0.0115, -0.0004),
    (-0.0020, 0.0125, 0.0125, -0.0002),
    (-0.0110, 0.0112, 0.0112, 0.0012),
    (-0.0170, 0.0082, 0.0086, 0.0040),
    (-0.0215, 0.0066, 0.0071, 0.0058),
    (-0.0262, 0.0063, 0.0066, 0.0065),
    (-0.0300, 0.0050, 0.0053, 0.0063),
    (-0.0335, 0.0032, 0.0036, 0.0060),
    (-0.0348, 0.0010, 0.0012, 0.0059),
]
HEAD = Vector((0, -0.0270, 0.0068))
EYE = Vector((0.0047, -0.0287, 0.0078))  # left eye; the right mirrors it
EYE_R = 0.0017
# The hooked beak: a curved, side-flattened cone from the cere down to the hook.
BEAK_PATH = [(0, -0.0322, 0.0064), (0, -0.0360, 0.0064), (0, -0.0392, 0.0054), (0, -0.0408, 0.0036), (0, -0.0404, 0.0017)]
BEAK_R = [0.0025, 0.0019, 0.0013, 0.0008, 0.0003]

# The spread wing (left; the right mirrors it). Spanwise stations along the arm: (x, leading edge
# y, trailing edge y, thickness at the leading edge). The joints sit on the leading edge.
SHOULDER = Vector((0.0080, -0.0090, 0.0050))
ELBOW = Vector((0.0330, -0.0075, 0.0058))
WRIST = Vector((0.0640, -0.0110, 0.0062))
HAND_TIP = Vector((0.0860, -0.0060, 0.0062))
WING = [
    (0.0060, -0.0120, 0.0150, 0.0050),
    (0.0120, -0.0125, 0.0280, 0.0036),
    (0.0230, -0.0115, 0.0360, 0.0026),
    (0.0330, -0.0105, 0.0390, 0.0022),
    (0.0450, -0.0115, 0.0395, 0.0020),
    (0.0560, -0.0128, 0.0380, 0.0019),
    (0.0640, -0.0138, 0.0350, 0.0018),
    (0.0730, -0.0118, 0.0310, 0.0016),
    (0.0820, -0.0085, 0.0270, 0.0014),
]
# Primaries: the slotted "fingers" past the hand. (root x, root y, tip x, tip y, root half width).
PRIMARIES = [
    (0.0790, -0.0090, 0.1190, -0.0060, 0.0034),
    (0.0805, -0.0045, 0.1250, 0.0015, 0.0036),
    (0.0810, 0.0005, 0.1265, 0.0090, 0.0037),
    (0.0805, 0.0060, 0.1235, 0.0165, 0.0037),
    (0.0790, 0.0115, 0.1170, 0.0230, 0.0036),
    (0.0770, 0.0170, 0.1080, 0.0285, 0.0035),
    (0.0745, 0.0215, 0.0985, 0.0320, 0.0034),
]
# The tail: a fan from its base under the rump to a squarish tip. (y, half width).
TAIL = [(0.0190, 0.0055), (0.0300, 0.0080), (0.0450, 0.0105), (0.0600, 0.0118), (0.0680, 0.0112)]
TAIL_Z = 0.0010
# Legs (left): hip, knee, ankle; three front toes and the hallux from the ankle.
HIP = Vector((0.0058, 0.0030, -0.0055))
KNEE = Vector((0.0070, 0.0015, -0.0145))
ANKLE = Vector((0.0072, 0.0030, -0.0265))
TOES = [(-0.40, 0.0085), (0.0, 0.0095), (0.40, 0.0080)]  # splay angle from straight ahead, length
HALLUX = 0.0065
TOE_R = 0.0010
# The folded wing lying along the flank: (y, out from the body's side, bottom z, top z).
FOLD = [
    (-0.0120, 0.0010, -0.0010, 0.0080),
    (-0.0040, 0.0020, -0.0080, 0.0100),
    (0.0080, 0.0020, -0.0100, 0.0105),
    (0.0200, 0.0015, -0.0080, 0.0090),
    (0.0320, 0.0010, -0.0040, 0.0070),
    (0.0450, 0.0006, -0.0005, 0.0055),
    (0.0560, 0.0003, 0.0015, 0.0040),
]
FOLD_TIP_X = 0.0030  # where the two wing tips cross over the tail


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def track(f, keys):
    """Scalar channel: keys [(frame, value), ...], eased between keys, held past the ends."""
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


def loft_at(y):
    """Half width, half height and centre z of the body loft at y."""
    pts = LOFT
    if y >= pts[0][0]:
        return pts[0][1:]
    for a, b in zip(pts, pts[1:]):
        if b[0] <= y <= a[0]:
            t = (a[0] - y) / (a[0] - b[0])
            return tuple(lerp(a[i], b[i], t) for i in (1, 2, 3))
    return pts[-1][1:]


# ---------------------------------------------------------------------------------------------
# Texture atlas, 512 x 256, painted with numpy (row 0 is the bottom). Regions (u0, v0, u1, v1):
# ---------------------------------------------------------------------------------------------
TEX_W, TEX_H = 512, 256
REGIONS = {
    'body': (0.0, 0.0, 0.5, 0.5),  # around the body (u) by along it, tail end to beak (v)
    'wing_top': (0.5, 0.0, 1.0, 0.5),  # span (u) by chord, leading edge to trailing (v)
    'wing_under': (0.0, 0.5, 0.5, 1.0),
    'tail': (0.5, 0.5, 0.75, 1.0),  # across (u) by base to tip (v); top half of u is the upper side
    'primary': (0.75, 0.5, 1.0, 1.0),  # top or under (u halves) by root to tip (v)
}
DARK = np.array(hexrgb('#2f231b'))
BROWN = np.array(hexrgb('#46342a'))
FRINGE = np.array(hexrgb('#6b5241'))
RUFOUS = np.array(hexrgb('#7a5236'))
GREY = np.array(hexrgb('#8e8984'))
PALE = np.array(hexrgb('#8f877f'))
TAIL_GREY = np.array(hexrgb('#544a43'))


def region_uv(name, u, v):
    u0, v0, u1, v1 = REGIONS[name]
    u = min(0.995, max(0.005, u))
    v = min(0.995, max(0.005, v))
    return (lerp(u0, u1, u), lerp(v0, v1, v))


def blur(a, n=2):
    for _ in range(n):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
    return a


def mix(img, colour, mask):
    m = mask[..., None]
    return img * (1 - m) + colour * m


def scallops(h, w, rows, cols, rng, offset=0.5):
    """Feather tips: overlapping rounded rows. Returns (edge mask, cell row index)."""
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    r = yy / h * rows
    row = np.floor(r)
    c = xx / w * cols + offset * (row % 2)
    fy = r - row
    fx = c - np.floor(c)
    # Each feather's rounded tip sits at fy = 1; the edge is a crescent just inside it.
    d = (fx - 0.5) ** 2 * 1.6 + (1 - fy) ** 2
    jitter = rng.random((h, w)) * 0.04
    edge = np.clip(1 - np.abs(np.sqrt(d) - 0.42 - jitter) / 0.09, 0, 1) * (fy > 0.35)
    return edge, row


def paint_body(rng):
    h, w = TEX_H // 2, TEX_W // 2
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    around = xx / w  # 0.25 = top of the back, 0.75 = the belly (see ring UVs)
    along = yy / h  # 0 = rump, 1 = beak
    img = np.tile(BROWN, (h, w, 1))
    belly = np.clip(1 - np.abs(around - 0.75) / 0.22, 0, 1)
    img = mix(img, DARK, np.clip(1 - np.abs(around - 0.25) / 0.3, 0, 1) * 0.5)
    edge, _ = scallops(h, w, 22, 14, rng)
    img = mix(img, FRINGE, edge * (0.55 - 0.25 * belly))
    # Belly and thighs: dark with rufous-buff bars and flecks, as on adults.
    bars = (np.sin(along * 2 * np.pi * 26 + np.sin(xx / w * 40) * 0.6) > 0.55).astype(float)
    flecks = blur((rng.random((h, w)) > 0.93).astype(float), 1) > 0.18
    img = mix(img, RUFOUS, belly * np.clip(0.55 * bars + 0.5 * flecks, 0, 1) * (along < 0.72))
    # Head and nape a shade darker; a paler mottled throat.
    head = np.clip((along - 0.72) / 0.08, 0, 1)
    img = mix(img, DARK, head * 0.6)
    throat = head * np.clip(1 - np.abs(around - 0.75) / 0.12, 0, 1) * (blur(rng.random((h, w)), 1) > 0.5)
    img = mix(img, FRINGE, throat * 0.6)
    return img


def paint_wing(rng, under):
    h, w = TEX_H // 2, TEX_W // 2
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    chord = yy / h  # 0 = leading edge, 1 = trailing
    span = xx / w
    if not under:
        img = np.tile(BROWN, (h, w, 1))
        # Coverts: rows of pale-fringed feathers over the front half of the wing.
        edge, _ = scallops(h, w, 16, 30, rng)
        img = mix(img, FRINGE, edge * np.clip((0.62 - chord) / 0.1, 0, 1) * 0.8)
        # Flight feathers: long dark vanes with faint bars and a dark tip.
        vane = np.abs(((span * 26) % 1.0) - 0.5) < 0.06
        img = mix(img, DARK, (chord > 0.6) * (0.35 * vane + 0.25 * (np.sin(chord * 70) > 0.6)))
        img = mix(img, DARK, np.clip((chord - 0.88) / 0.08, 0, 1) * 0.6)
        return img
    # Underneath: dark brown coverts, then grey flight feathers with dark bars and a dark trailing band.
    img = np.tile(GREY, (h, w, 1))
    coverts = np.clip((0.55 - chord) / 0.08, 0, 1)
    img = mix(img, BROWN, coverts)
    edge, _ = scallops(h, w, 12, 26, rng)
    img = mix(img, RUFOUS, edge * coverts * 0.5)
    bars = (np.sin(chord * 2 * np.pi * 9 + span * 3) > 0.55) * (chord > 0.55)
    img = mix(img, BROWN, bars * 0.55)
    img = mix(img, DARK, np.clip((chord - 0.86) / 0.06, 0, 1) * 0.8)
    return img


def paint_tail(rng):
    h, w = TEX_H // 2, TEX_W // 4
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    along = yy / h
    top = (xx / w) < 0.5
    img = np.where(top[..., None], TAIL_GREY, PALE)
    # Many narrow dark bars, then a broader one near the tip, and a pale tip.
    bars = np.sin(along * 2 * np.pi * 9.5) > 0.45
    img = mix(img, DARK, bars * np.where(top, 0.75, 0.45) * (along < 0.86))
    img = mix(img, DARK, np.clip(1 - np.abs(along - 0.9) / 0.04, 0, 1) * 0.8)
    img = mix(img, PALE, np.clip((along - 0.955) / 0.03, 0, 1) * 0.8)
    # Feather shafts fanning down the tail.
    shafts = np.abs(((xx / w * 2 % 1.0) * 12) % 1.0 - 0.5) < 0.05
    img = mix(img, DARK, shafts * 0.25)
    return img


def paint_primaries(rng):
    h, w = TEX_H // 2, TEX_W // 4
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    along = yy / h
    top = (xx / w) < 0.5
    img = np.where(top[..., None], DARK, GREY)
    bars = (np.sin(along * 2 * np.pi * 7) > 0.5) * (along < 0.7)
    img = mix(img, np.array(hexrgb('#3d3029')), bars * np.where(top, 0.4, 0.0))
    img = mix(img, BROWN, bars * np.where(top, 0.0, 0.6))
    img = mix(img, DARK, np.clip((along - 0.65) / 0.15, 0, 1) * np.where(top, 0.0, 0.85))
    shaft = np.abs((xx / w * 2 % 1.0) - 0.5) < 0.04
    img = mix(img, np.array(hexrgb('#1c1612')), shaft * 0.6)
    return img


def make_texture():
    rng = np.random.default_rng(11)
    img = np.zeros((TEX_H, TEX_W, 3))
    h2, w2, w4 = TEX_H // 2, TEX_W // 2, TEX_W // 4
    img[0:h2, 0:w2] = paint_body(rng)
    img[0:h2, w2:] = paint_wing(rng, under=False)
    img[h2:, 0:w2] = paint_wing(rng, under=True)
    img[h2:, w2:w2 + w4] = paint_tail(rng)
    img[h2:, w2 + w4:] = paint_primaries(rng)
    img = np.clip(img, 0, 1)
    tex = bpy.data.images.new('HawkAtlas', TEX_W, TEX_H, alpha=False)
    rgba = np.concatenate([img, np.ones((TEX_H, TEX_W, 1))], axis=2)
    tex.pixels.foreach_set(rgba.astype(np.float32).ravel())
    tex.pack()
    return tex


COLORS = {
    'Plumage': None,  # textured
    'Beak': srgb_lin(hexrgb('#2c2b30')),
    'Yellow': srgb_lin(hexrgb('#d8b23a')),
    'Talon': srgb_lin(hexrgb('#1b1918')),
    'Eye': srgb_lin(hexrgb('#1a120c')),
}
SOLID_UV = (0.5, 0.5)


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

    def face(self, idx, mat, uvs=None):
        self.faces.append(list(idx))
        self.face_mats.append(mat)
        self.face_uvs.append(uvs)

    def begin(self):
        self.start = len(self.faces)

    def end(self):
        """Close a piece: every piece is a closed shell, so if its signed volume comes out negative
        its faces were wound inward, and they're all turned round."""
        vol = 0.0
        for idx in self.faces[self.start:]:
            vs = [self.verts[i] for i in idx]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6
        if vol < 0:
            for k in range(self.start, len(self.faces)):
                self.faces[k] = self.faces[k][::-1]
                if self.face_uvs[k]:
                    self.face_uvs[k] = self.face_uvs[k][::-1]


def body_weights(y):
    """Rump into the tail, chest into the neck and head, by distance along the body."""
    if y > 0.020:
        t = min(1.0, (y - 0.020) / 0.012)
        return {'body': 1 - 0.5 * t, 'tail': 0.5 * t}
    if y > -0.012:
        return {'body': 1.0}
    if y > -0.019:
        t = (-0.012 - y) / 0.007
        return {'body': 1 - t, 'neck': t}
    if y > -0.024:
        t = (-0.019 - y) / 0.005
        return {'neck': 1 - t, 'head': t}
    return {'head': 1.0}


def build_body(mb):
    """The loft, closed at both ends. Ring UVs: u = angle round the body (0.25 the back), v along it."""
    mb.begin()
    sides = 20
    rings = []
    n = len(LOFT)
    y0, y1 = LOFT[0][0], LOFT[-1][0]
    for y, hw, hh, cz in LOFT:
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            # Flatter on the back, rounder underneath; a keel-less but deep chest.
            sa = math.sin(a)
            r_up = hh * (0.92 if sa > 0 else 1.0)
            ring.append(mb.vert((hw * math.cos(a), y, cz + r_up * sa), body_weights(y)))
        rings.append(ring)
    v_of = lambda y: (y - y0) / (y1 - y0)
    for i in range(n - 1):
        for k in range(sides):
            k2 = k + 1
            a0, a1 = k / sides, k2 / sides
            uvs = [region_uv('body', a0, v_of(LOFT[i][0])), region_uv('body', a0, v_of(LOFT[i + 1][0])),
                   region_uv('body', a1, v_of(LOFT[i + 1][0])), region_uv('body', a1, v_of(LOFT[i][0]))]
            mb.face([rings[i][k], rings[i + 1][k], rings[i + 1][k2 % sides], rings[i][k2 % sides]], 'Plumage', uvs)
    for end, ring, sign in ((0, rings[0], 1), (n - 1, rings[-1], -1)):
        y, _, _, cz = LOFT[end]
        c = mb.vert((0, y + 0.0004 * sign, cz), body_weights(y))
        for k in range(sides):
            k2 = (k + 1) % sides
            idx = [ring[k2], ring[k], c] if sign > 0 else [ring[k], ring[k2], c]
            mb.face(idx, 'Plumage', [region_uv('body', 0.5, v_of(y))] * 3)
    mb.end()


def blob(mb, centre, radii, weights, mat, rings=6, sides=10, uv=None):
    """Ellipsoid, faces out."""
    mb.begin()
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
            uvs = [uv] * 4 if uv else None
            mb.face([grid[i][k], grid[i + 1][k], grid[i + 1][k2], grid[i][k2]], mat, uvs)
    mb.end()


def tube(mb, path, radii, weights_at, mat, sides=8, flat=1.0, cap=True, uv=None):
    """Tube through path with matching radii, closed at both ends; cap rounds off the far end."""
    mb.begin()
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
            mb.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat, [uv or SOLID_UV] * 4)
    a = (Vector(path[1]) - Vector(path[0])).normalized()
    start = mb.vert(Vector(path[0]) - a * radii[0] * 0.3, weights_at(0.0))
    end = mb.vert(path[-1], weights_at(1.0)) if not cap else mb.vert(Vector(path[-1]) + (Vector(path[-1]) - Vector(path[-2])).normalized() * radii[-1] * 0.5, weights_at(1.0))
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face([rings[0][k2], rings[0][k], start], mat, [uv or SOLID_UV] * 3)
        mb.face([rings[-1][k], rings[-1][k2], end], mat, [uv or SOLID_UV] * 3)
    mb.end()


def slab(mb, grid_top, grid_bot, weights, uv_top, uv_bot):
    """A thin closed plate from two matching grids of points (rows x cols, top above bottom).
    weights[i][j] and uv grids give each grid point's skin weights and UVs."""
    mb.begin()
    rows, cols = len(grid_top), len(grid_top[0])
    top = [[mb.vert(grid_top[i][j], weights[i][j]) for j in range(cols)] for i in range(rows)]
    bot = [[mb.vert(grid_bot[i][j], weights[i][j]) for j in range(cols)] for i in range(rows)]
    for i in range(rows - 1):
        for j in range(cols - 1):
            q = [(i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)]
            mb.face([top[a][b] for a, b in q], 'Plumage', [uv_top[a][b] for a, b in q])
            mb.face([bot[a][b] for a, b in reversed(q)], 'Plumage', [uv_bot[a][b] for a, b in reversed(q)])
    # Seal the rim: walk round the grid's edge.
    edge = [(0, j) for j in range(cols)] + [(i, cols - 1) for i in range(1, rows)] + \
           [(rows - 1, j) for j in range(cols - 2, -1, -1)] + [(i, 0) for i in range(rows - 2, 0, -1)]
    for (a, b), (c, d) in zip(edge, edge[1:] + edge[:1]):
        mb.face([top[a][b], bot[a][b], bot[c][d], top[c][d]], 'Plumage', [uv_top[a][b], uv_bot[a][b], uv_bot[c][d], uv_top[c][d]])
    mb.end()
    return top, bot


def wing_weights(x, s):
    """Spread wing skin: body at the root, then arm, forearm and hand, blended across each joint."""
    n = lambda b: b + ('_L' if s > 0 else '_R')
    joints = [(SHOULDER.x + 0.002, 'body', n('arm'), 0.004), (ELBOW.x, n('arm'), n('fore'), 0.005),
              (WRIST.x, n('fore'), n('hand'), 0.004)]
    w = {'body': 1.0} if x < joints[0][0] else None
    for (jx, a, b, half), nxt in zip(joints, joints[1:] + [(1.0, None, None, 0)]):
        if x < jx - half:
            if w is None:
                w = {a: 1.0}
            break
        if x <= jx + half:
            t = (x - (jx - half)) / (2 * half)
            w = {a: 1 - t, b: t}
            break
        if x < nxt[0] - nxt[3]:
            w = {b: 1.0}
            break
    return w or {n('hand'): 1.0}


def build_wing(mb, s):
    """The spread wing as a thin cambered plate, thick at the leading edge, with a scalloped
    trailing edge of secondaries; then the primaries as separate tapered feathers."""
    chords = 7
    top, bot, wts, uvt, uvb = [], [], [], [], []
    span = WING[-1][0] - WING[0][0]
    for x, le, te, th in WING:
        rt, rb, rw, ru, rbv = [], [], [], [], []
        for j in range(chords + 1):
            u = j / chords
            y = lerp(le, te, u)
            if j == chords and x > 0.02:  # secondaries' tips: a slight scallop
                y += 0.0012 * abs(math.sin(x / 0.0055 * math.pi))
            z = lerp(SHOULDER.z, WRIST.z, (x - WING[0][0]) / span) + 0.0018 * math.sin(math.pi * min(1.0, u * 1.3))
            t = th * (1 - u) ** 1.6 + 0.0004
            rt.append(Vector((s * x, y, z + t * 0.6)))
            rb.append(Vector((s * x, y, z - t * 0.4)))
            rw.append(wing_weights(x, s))
            su = (x - WING[0][0]) / (0.125 - WING[0][0])
            ru.append(region_uv('wing_top', su, u))
            rbv.append(region_uv('wing_under', su, u))
        top.append(rt), bot.append(rb), wts.append(rw), uvt.append(ru), uvb.append(rbv)
    if s < 0:  # mirrored: reverse the rows so faces still point out
        top, bot, wts, uvt, uvb = top[::-1], bot[::-1], wts[::-1], uvt[::-1], uvb[::-1]
    slab(mb, top, bot, wts, uvt, uvb)
    hand = 'hand' + ('_L' if s > 0 else '_R')
    for i, (rx, ry, tx, ty, hw) in enumerate(PRIMARIES):
        along = Vector((tx - rx, ty - ry, 0))
        length = along.length
        d = along.normalized()
        across = Vector((-d.y, d.x, 0))  # toward the leading edge
        steps = 6
        rt, rb, rw, ru, rbv = [], [], [], [], []
        for k in range(steps + 1):
            t = k / steps
            # Emarginated: narrows from the middle, rounded at the tip.
            half = hw * (1 - 0.45 * smooth((t - 0.3) / 0.5)) * (math.sqrt(max(0.0, 1 - ((t - 0.82) / 0.18) ** 2)) if t > 0.82 else 1)
            half = max(half, 0.0003)
            c = Vector((rx, ry, WRIST.z + 0.0004)) + d * (length * t) + Vector((0, 0, 0.0035 * t * t))  # tips curl up
            th = 0.0011 * (1 - t) + 0.0003
            row_t, row_b = [], []
            for side in (-1, 1):
                p = c + across * (half * side)
                row_t.append(Vector((s * p.x, p.y, p.z + th / 2)))
                row_b.append(Vector((s * p.x, p.y, p.z - th / 2)))
            rt.append(row_t), rb.append(row_b)
            rw.append([{hand: 1.0}] * 2)
            ru.append([region_uv('primary', 0.05, t), region_uv('primary', 0.45, t)])
            rbv.append([region_uv('primary', 0.55, t), region_uv('primary', 0.95, t)])
        if s < 0:
            rt, rb, rw, ru, rbv = rt[::-1], rb[::-1], rw[::-1], ru[::-1], rbv[::-1]
        slab(mb, rt, rb, rw, ru, rbv)


def build_fold(mb, s):
    """The folded wing: a curved plate along the flank, from the shoulder back over the tail."""
    name = 'fold' + ('_L' if s > 0 else '_R')
    rows = len(FOLD)
    levels = 5
    top, bot, wts, uvt, uvb = [], [], [], [], []
    y_end = FOLD[-1][0]
    for i, (y, out, z0, z1) in enumerate(FOLD):
        rt, rb, rw, ru, rbv = [], [], [], [], []
        for j in range(levels + 1):
            u = j / levels
            z = lerp(z0, z1, u)
            hw, hh, cz = loft_at(min(y, 0.028))
            # Hug the body's side at this height, out a little; behind the body, close in over the tail.
            k = max(-1.0, min(1.0, (z - cz) / max(hh, 1e-4)))
            side = hw * math.sqrt(max(0.0, 1 - k * k)) if y < 0.026 else 0.0
            x = max(side, lerp(0.009, FOLD_TIP_X, smooth((y - 0.02) / (y_end - 0.02)))) + out + 0.0006
            th = 0.0009
            rt.append(Vector((s * (x + th), y, z)))
            rb.append(Vector((s * x, y, z)))
            rw.append({name: 1.0})
            # Seen from outside it shows the wing's upper surface: coverts at the top, flight feathers below and behind.
            ru.append(region_uv('wing_top', 0.3 + 0.6 * i / (rows - 1), 1 - u))
            rbv.append(region_uv('wing_under', 0.3 + 0.6 * i / (rows - 1), 1 - u))
        top.append(rt), bot.append(rb), wts.append(rw), uvt.append(ru), uvb.append(rbv)
    # "top" here is the outer face; order rows so its faces point away from the body.
    if s < 0:
        top, bot, wts, uvt, uvb = top[::-1], bot[::-1], wts[::-1], uvt[::-1], uvb[::-1]
    slab(mb, bot, top, wts, uvb, uvt)


def build_tail(mb):
    cols = 6
    top, bot, wts, uvt, uvb = [], [], [], [], []
    for i, (y, hw) in enumerate(TAIL):
        rt, rb, rw, ru, rbv = [], [], [], [], []
        v = i / (len(TAIL) - 1)
        for j in range(cols + 1):
            u = j / cols
            x = lerp(-hw, hw, u)
            # Rounded corners at the tip.
            yy = y - (0.003 * (2 * u - 1) ** 4 if i == len(TAIL) - 1 else 0)
            th = 0.0016 * (1 - v) + 0.0005
            z = TAIL_Z - 0.0006 * v
            rt.append(Vector((x, yy, z + th / 2)))
            rb.append(Vector((x, yy, z - th / 2)))
            rw.append({'tail': 1.0} if i > 0 else {'tail': 0.6, 'body': 0.4})
            ru.append(region_uv('tail', 0.02 + 0.46 * u, v))
            rbv.append(region_uv('tail', 0.52 + 0.46 * u, v))
        top.append(rt), bot.append(rb), wts.append(rw), uvt.append(ru), uvb.append(rbv)
    # Rows run base to tip (+Y), columns right to left (+X): top faces point up.
    slab(mb, [r[::-1] for r in top], [r[::-1] for r in bot], [r[::-1] for r in wts], [r[::-1] for r in uvt], [r[::-1] for r in uvb])


def build_head_details(mb):
    for s in (1, -1):
        e = Vector((s * EYE.x, EYE.y, EYE.z))
        blob(mb, e, (EYE_R * 0.8, EYE_R, EYE_R), 'head', 'Eye', rings=5, sides=8)
        # A heavy brow over the eye, the hawk's frown.
        blob(mb, e + Vector((-s * 0.0006, -0.0002, 0.0016)), (0.0024, 0.0034, 0.0011), 'head', 'Plumage', rings=4, sides=8,
             uv=region_uv('body', 0.25, 0.95))
    tube(mb, BEAK_PATH, BEAK_R, lambda t: {'head': 1.0}, 'Beak', sides=8, flat=0.7)
    # Yellow cere over the base of the beak, and the gape below it.
    blob(mb, (0, -0.0322, 0.0071), (0.0025, 0.0017, 0.0019), 'head', 'Yellow', rings=4, sides=8)
    tube(mb, [(0, -0.0318, 0.0046), (0, -0.0350, 0.0043), (0, -0.0372, 0.0040)], [0.0018, 0.0012, 0.0004],
         lambda t: {'head': 1.0}, 'Beak', sides=6, flat=0.9)


def build_legs(mb):
    for s in (1, -1):
        n = '_L' if s > 0 else '_R'
        hip, knee, ankle = (Vector((s * p.x, p.y, p.z)) for p in (HIP, KNEE, ANKLE))
        # Feathered "trousers" over the thigh.
        blob(mb, (hip + knee) / 2 + Vector((0, 0.0005, -0.0012)), (0.0044, 0.0052, 0.0090), {'thigh' + n: 1.0}, 'Plumage',
             rings=6, sides=10, uv=region_uv('body', 0.75, 0.45))
        tube(mb, [knee, (knee + ankle) / 2, ankle], [0.0016, 0.0013, 0.0012], lambda t: {'shank' + n: 1.0}, 'Yellow', sides=8)
        for a, length in TOES:
            d = Vector((s * math.sin(a), -math.cos(a), -0.08)).normalized()
            p0 = ankle + Vector((0, 0, -0.0006))
            p1 = p0 + d * length * 0.75
            tube(mb, [p0, p0 + d * length * 0.4, p1], [TOE_R * 1.1, TOE_R, TOE_R * 0.8], lambda t: {'toes' + n: 1.0}, 'Yellow', sides=6)
            # The talon: a curved hook down from the toe tip.
            c1 = p1 + d * 0.0016 + Vector((0, 0, -0.0004))
            c2 = c1 + d * 0.0012 + Vector((0, 0, -0.0014))
            tube(mb, [p1, c1, c2], [TOE_R * 0.75, TOE_R * 0.5, 0.0001], lambda t: {'toes' + n: 1.0}, 'Talon', sides=6)
        d = Vector((0, 1, -0.1)).normalized()
        p0 = ankle + Vector((0, 0, -0.0006))
        p1 = p0 + d * HALLUX * 0.75
        tube(mb, [p0, p1], [TOE_R * 1.1, TOE_R * 0.85], lambda t: {'hallux' + n: 1.0}, 'Yellow', sides=6)
        c1 = p1 + d * 0.0018 + Vector((0, 0, -0.0005))
        c2 = c1 + d * 0.0012 + Vector((0, 0, -0.0016))
        tube(mb, [p1, c1, c2], [TOE_R * 0.8, TOE_R * 0.55, 0.0001], lambda t: {'hallux' + n: 1.0}, 'Talon', sides=6)


def check_winding(me):
    """Every piece is a closed shell, so its signed volume must be positive (faces pointing out).
    Inside-out pieces render see-through in the game, so stop the build if there are any."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    seen, bad, count = set(), [], 0
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        stack, vol, comp = [f0], 0.0, []
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            comp.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        for f in comp:
            vs = [v.co for v in f.verts]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6
        count += 1
        if vol <= 0:
            bad.append((len(comp), vol))
    bm.free()
    print('winding:', count, 'pieces,', len(bad), 'inside out', bad[:5], '|', len(me.vertices), 'verts', len(me.polygons), 'faces')
    if bad:
        raise SystemExit('inside-out mesh pieces')


def build_mesh(rig, mats):
    mb = MeshBuilder()
    build_body(mb)
    build_head_details(mb)
    build_tail(mb)
    for s in (1, -1):
        build_wing(mb, s)
        build_fold(mb, s)
    build_legs(mb)
    me = bpy.data.meshes.new('HawkMesh')
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
    check_winding(me)
    obj = bpy.data.objects.new('HawkBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones if b.name != 'root'}
    for i, w in enumerate(mb.weights):
        for bone, x in w.items():
            groups[bone].add([i], x, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


# ---------------------------------------------------------------------------------------------
# Armature. Poses are written as rotations in the armature's own axes (X the hawk's left, Y back,
# Z up), each about the bone's head and on top of its parent's: see `pose_matrices`.
# ---------------------------------------------------------------------------------------------
SIDES = {'_L': 1, '_R': -1}


def bone_defs():
    """name -> (head, tail, parent)."""
    d = {
        'root': (Vector((0, 0, 0)), Vector((0, 0, 0.01)), None),
        'body': (Vector((0, 0.014, 0)), Vector((0, -0.014, 0)), 'root'),
        'neck': (Vector((0, -0.013, 0.003)), Vector((0, -0.021, 0.0062)), 'body'),
        'head': (Vector((0, -0.021, 0.0062)), Vector((0, -0.036, 0.0064)), 'neck'),
        'tail': (Vector((0, 0.019, 0.001)), Vector((0, 0.068, 0.0004)), 'body'),
    }
    for n, s in SIDES.items():
        m = lambda v: Vector((s * v.x, v.y, v.z))
        d['arm' + n] = (m(SHOULDER), m(ELBOW), 'body')
        d['fore' + n] = (m(ELBOW), m(WRIST), 'arm' + n)
        d['hand' + n] = (m(WRIST), m(HAND_TIP), 'fore' + n)
        d['fold' + n] = (m(Vector((0.0100, -0.0100, 0.0040))), m(Vector((0.0110, 0.0500, 0.0010))), 'body')
        d['thigh' + n] = (m(HIP), m(KNEE), 'body')
        d['shank' + n] = (m(KNEE), m(ANKLE), 'thigh' + n)
        d['toes' + n] = (m(ANKLE), m(ANKLE + Vector((0, -0.009, -0.0008))), 'shank' + n)
        d['hallux' + n] = (m(ANKLE), m(ANKLE + Vector((0, 0.0065, -0.0006))), 'shank' + n)
    return d


BONES = bone_defs()


def build_armature():
    data = bpy.data.armatures.new('HawkRig')
    rig = bpy.data.objects.new('Hawk', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    made = {}
    for name, (head, tail, parent) in BONES.items():
        b = eb.new(name)
        b.head, b.tail = head, tail
        b.roll = 0.0
        if parent:
            b.parent = made[parent]
        made[name] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


# ---------------------------------------------------------------------------------------------
# Animation. A pose is a dict: 'root_loc' (Vector), and per bone 'rot' (x, y, z) Euler radians in
# armature axes (applied x, then y, then z) and 'scale' (uniform, or (sx, sy, sz) in armature
# axes). Helpers below speak in the hawk's terms (dihedral, sweep, flex) and turn them into those.
# ---------------------------------------------------------------------------------------------
def pose_matrices(rig, pose):
    out = {}
    world = {}
    for name, (head, tail, parent) in BONES.items():
        rot = pose.get('rot', {}).get(name, (0, 0, 0))
        sc = pose.get('scale', {}).get(name, 1.0)
        if not isinstance(sc, tuple):
            sc = (sc, sc, sc)
        r = Euler(rot, 'XYZ').to_matrix().to_4x4()
        s = Matrix.Diagonal((*sc, 1.0))
        local = Matrix.Translation(head) @ r @ s @ Matrix.Translation(-head)
        if parent is None:
            t = Matrix.Translation(pose.get('root_loc', Vector((0, 0, 0)))) @ local
        else:
            t = world[parent] @ local
        world[name] = t
        out[name] = t @ rig.data.bones[name].matrix_local
    return out, world


def local_basis(rig, name, mats):
    bone = rig.data.bones[name]
    if bone.parent is None:
        return bone.matrix_local.inverted() @ mats[name]
    rest_rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
    return rest_rel.inverted() @ mats[bone.parent.name].inverted() @ mats[name]


def clip(rig, name, frames, pose_fn, loop=True):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    prev_q = {}
    for f in range(frames + 1):
        mats, _ = pose_matrices(rig, pose_fn(0 if (loop and f == frames) else f))
        for pb in rig.pose.bones:
            loc, q, sc = local_basis(rig, pb.name, mats).decompose()
            if pb.name in prev_q and prev_q[pb.name].dot(q) < 0:
                q.negate()
            prev_q[pb.name] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
            pb.location = loc
            pb.keyframe_insert('location', frame=f)
            pb.scale = sc
            pb.keyframe_insert('scale', frame=f)
    return act


class P:
    """Pose under construction, in the hawk's own terms."""

    def __init__(self):
        self.d = {'root_loc': Vector((0, 0, 0)), 'rot': {}, 'scale': {}}

    def root(self, pitch=0.0, roll=0.0, dz=0.0, dy=0.0):
        """Whole bird: pitch nose-up +, roll left wing down +, raised dz, moved back dy."""
        self.d['rot']['root'] = (-pitch, roll, 0)
        self.d['root_loc'] = Vector((0, dy, dz))
        return self

    def wing(self, dihedral=0.0, sweep=0.0, twist=0.0, elbow=0.0, wrist=0.0, hand_up=0.0, span=1.0, side=None):
        """dihedral: raised +; sweep: swept back +; twist: leading edge up +; elbow and wrist
        flex fold the forearm forward and the hand back; hand_up tips the hand up; span scales
        the whole spread wing (0 hides it in the shoulder)."""
        for n, s in SIDES.items():
            if side is not None and s != side:
                continue
            self.d['rot']['arm' + n] = (-twist * 0.5, -s * dihedral, s * sweep)
            self.d['rot']['fore' + n] = (-twist * 0.3, -s * 0.0, -s * elbow)
            self.d['rot']['hand' + n] = (-twist * 0.4, -s * hand_up, s * wrist)
            self.d['scale']['arm' + n] = max(span, 0.001)
        return self

    def fold(self, amount):
        for n in SIDES:
            self.d['scale']['fold' + n] = max(amount, 0.001)
        return self

    def tail(self, lift=0.0, fan=1.0, turn=0.0):
        self.d['rot']['tail'] = (lift, 0, turn)
        self.d['scale']['tail'] = (fan, 1.0, 1.0)
        return self

    def head(self, pitch_down=0.0, turn=0.0, neck_up=0.0, tilt=0.0):
        self.d['rot']['neck'] = (-neck_up + pitch_down * 0.3, 0, turn * 0.4)
        self.d['rot']['head'] = (pitch_down * 0.7, tilt, turn * 0.6)
        return self

    def legs(self, swing=0.0, knee=0.0, grip=0.0, spread=0.0):
        """swing: thighs back +; knee: shank bent back +; grip: toes curled shut + (open -);
        spread: feet apart +."""
        for n, s in SIDES.items():
            self.d['rot']['thigh' + n] = (swing, 0, 0)
            self.d['rot']['shank' + n] = (knee, -s * spread, 0)
            self.d['rot']['toes' + n] = (grip, 0, 0)
            self.d['rot']['hallux' + n] = (-grip, 0, 0)
        return self


def legs_tucked(p, grip=1.3):
    """In flight: legs drawn back along the belly with the toes balled up."""
    return p.legs(swing=1.25, knee=0.9, grip=grip)


def glide_pose(f, frames=60):
    w = 2 * math.pi * f / frames
    p = P().root(pitch=0.02 * math.sin(w), roll=0.03 * math.sin(w + 1))
    p.wing(dihedral=0.12 + 0.03 * math.sin(w), sweep=0.04, elbow=0.06, wrist=0.10, hand_up=0.10 + 0.04 * math.sin(w + 0.5))
    p.fold(0).tail(lift=-0.03, fan=1.3)
    # Scanning the ground: the head swings slowly side to side, looking down.
    p.head(pitch_down=0.35, turn=0.45 * math.sin(w))
    return legs_tucked(p).d


def flap_wing(ph, power=1.0):
    """Wing at phase ph of a wingbeat (0 = wings top, 0.5 = bottom): a long downstroke, and on the
    upstroke the wing flexes at the elbow and wrist so the hand sweeps back."""
    c = math.cos(2 * math.pi * ph)
    up = max(0.0, -math.sin(2 * math.pi * ph))  # 1 mid-upstroke
    down = max(0.0, math.sin(2 * math.pi * ph))
    return dict(dihedral=0.10 + 0.70 * power * c, sweep=0.05 - 0.10 * down + 0.15 * up, twist=-0.18 * down * power + 0.1 * up,
                elbow=0.10 + 0.55 * up, wrist=0.15 + 1.0 * up, hand_up=0.15 * c)


def mix_wing(a, b, t):
    return {k: lerp(a.get(k, 0.0), b.get(k, 0.0), t) for k in set(a) | set(b)}


def flap_phase(p, ph, power=1.0, legs=True):
    c = math.cos(2 * math.pi * ph)
    p.wing(**flap_wing(ph, power))
    p.root(dz=-0.0025 * c * power, pitch=0.04 * c)
    if legs:
        legs_tucked(p)
    return p


def flap_pose(f, frames=10):
    p = flap_phase(P(), f / frames)
    p.fold(0).tail(lift=-0.05, fan=1.1).head(pitch_down=0.2)
    return p.d


STOOP_WINGS = dict(dihedral=0.30, sweep=0.55, elbow=0.70, wrist=1.10, twist=-0.05, hand_up=0.0)
FLARE_WINGS = dict(dihedral=0.95, sweep=-0.25, elbow=0.10, wrist=0.25, twist=0.55, hand_up=0.1)


def stoop_pose(f, frames=20):
    w = 2 * math.pi * f / frames
    p = P().wing(**{**STOOP_WINGS, 'dihedral': STOOP_WINGS['dihedral'] + 0.05 * math.sin(w)})
    p.fold(0).tail(lift=0.05, fan=0.75 + 0.05 * math.sin(2 * w)).head(pitch_down=0.55)
    return legs_tucked(p).d


# Strike: talons swing forward and open as the wings flare up to brake, the feet hit and clench at
# STRIKE_FRAME, then one heavy wingbeat to climb away, ending on a flap's top position.
STRIKE_FRAMES = 24
STRIKE_FRAME = 9


def strike_pose(f):
    p = P()
    flare = track(f, [(0, 0.0), (6, 1.0)])
    wing = mix_wing(STOOP_WINGS, FLARE_WINGS, flare)
    if f > 9:
        ph = track(f, [(9, 0.0), (24, 1.0)]) % 1.0
        wing = mix_wing(wing, flap_wing(ph, 1.2), track(f, [(9, 0.0), (12, 1.0)]))
    p.wing(**wing)
    up = track(f, [(0, 0.0), (6, 1.0), (10, 1.0), (16, 0.0)])
    p.root(pitch=0.55 * up)
    p.fold(0).tail(lift=-0.35 * up, fan=lerp(0.8, 1.5, up))
    p.head(pitch_down=lerp(0.55, 0.25, up))
    # Legs: tucked, then thrown forward under the chest with the toes spread, then clenched at the
    # hit and drawn back again.
    reach = track(f, [(0, 0.0), (7, 1.0), (11, 1.0), (20, 0.0)])
    grip = track(f, [(0, 1.3), (5, -0.45), (8, -0.45), (STRIKE_FRAME, 0.4), (11, 1.25)])
    p.legs(swing=lerp(1.25, -0.25, reach), knee=lerp(0.9, -0.1, reach), grip=grip, spread=0.10 * reach)
    return p.d


# Perched: sitting upright on its feet, wings folded, the head turning in quick moves between holds.
PERCH_FRAMES = 120
PERCH_PITCH = 0.85  # body raised from horizontal (radians)
PERCH_HEAD = PERCH_PITCH - 0.15  # the head tipped back down to look out level, a little down
PERCH_LOOK = [(0, 0.0), (8, 0.0), (11, 0.55), (34, 0.55), (37, -0.2), (60, -0.2), (63, -0.6), (88, -0.6), (91, 0.15),
              (112, 0.15), (115, 0.0), (120, 0.0)]


def perch_base(p, breath=0.0):
    p.root(pitch=PERCH_PITCH, dz=PERCH_DZ, dy=PERCH_DY)
    p.wing(dihedral=0.0, sweep=0.6, elbow=1.2, wrist=1.6, span=0.001)
    p.fold(1.0 + 0.02 * breath)
    p.tail(lift=-0.55, fan=0.85)
    # Legs straight down under the body (counter the body's pitch), toes round the perch.
    p.legs(swing=PERCH_PITCH - 0.35, knee=0.55, grip=0.35, spread=0.04)
    return p


def perch_pose(f):
    w = 2 * math.pi * f / PERCH_FRAMES
    p = perch_base(P(), math.sin(3 * w))
    p.head(pitch_down=PERCH_HEAD + 0.12 * max(0.0, math.sin(2 * w)), turn=track(f, PERCH_LOOK), neck_up=0.15)
    # A flick of the tail now and then.
    p.tail(lift=-0.55 + track(f, [(0, 0), (70, 0), (73, 0.18), (78, 0)]), fan=0.85)
    return p.d


# Land: from a glide, flare with the body raised and wings braking, legs forward, touch down at
# LAND_FRAME, then fold the wings and settle into the perch.
LAND_FRAMES = 32
LAND_FRAME = 18


def land_pose(f):
    p = P()
    flare = track(f, [(0, 0.0), (10, 1.0), (LAND_FRAME, 1.0), (24, 0.0)])
    settle = track(f, [(LAND_FRAME, 0.0), (26, 1.0)])
    swap = track(f, [(21, 0.0), (25, 1.0)])
    # Braking: wings high and swept forward, a short beat as it comes in.
    beat = math.sin(math.pi * track(f, [(10, 0.0), (16, 1.0)])) * 0.5
    p.wing(dihedral=lerp(0.12, 0.85, flare) - beat + 0.5 * settle, sweep=lerp(0.04, -0.2, flare) + 0.8 * settle,
           elbow=lerp(0.06, 0.15, flare) + 1.0 * settle, wrist=lerp(0.1, 0.3, flare) + 1.3 * settle,
           twist=0.5 * flare, span=1 - swap)
    p.fold(swap)
    p.root(pitch=lerp(0.0, 0.75, flare) * (1 - settle) + PERCH_PITCH * settle, dz=PERCH_DZ * settle, dy=PERCH_DY * settle)
    p.tail(lift=lerp(-0.05, -0.45, flare) * (1 - settle) - 0.55 * settle, fan=lerp(1.2, 1.55, flare) * (1 - settle) + 0.85 * settle)
    p.head(pitch_down=lerp(0.3, 0.1, flare) * (1 - settle) + PERCH_HEAD * settle, neck_up=0.15 * settle)
    reach = track(f, [(4, 0.0), (12, 1.0)])
    p.legs(swing=lerp(1.25, -0.6, reach) * (1 - settle) + (PERCH_PITCH - 0.35) * settle,
           knee=lerp(0.9, 0.0, reach) * (1 - settle) + 0.55 * settle,
           grip=track(f, [(0, 1.3), (10, -0.4), (LAND_FRAME - 1, -0.4), (LAND_FRAME + 2, 0.35)]),
           spread=0.04 + 0.04 * reach * (1 - settle))
    return p.d


# Take off: crouch, open the wings, spring at TAKE_OFF_FRAME and beat away, ending on a flap's top.
TAKE_OFF_FRAMES = 26
TAKE_OFF_FRAME = 8


def take_off_pose(f):
    p = P()
    swap = track(f, [(1, 0.0), (5, 1.0)])
    stand = 1 - track(f, [(TAKE_OFF_FRAME - 1, 0.0), (14, 1.0)])
    crouch = track(f, [(0, 0.0), (5, 1.0), (TAKE_OFF_FRAME, 0.0)])
    if f <= TAKE_OFF_FRAME:
        rise = track(f, [(0, 0.0), (6, 1.0)])
        p.wing(dihedral=lerp(0.0, 1.0, rise), sweep=lerp(0.6, -0.1, rise), elbow=lerp(1.2, 0.15, rise),
               wrist=lerp(1.6, 0.3, rise), span=swap)
    else:
        flap_phase(p, track(f, [(TAKE_OFF_FRAME, 0.0), (14, 0.5), (20, 1.0), (26, 1.0)]) % 1.0, legs=False)
    p.fold(1 - swap)
    lean = track(f, [(0, 0.0), (5, 1.0), (14, 1.0)])
    pitch = PERCH_PITCH - 0.4 * lean
    p.root(pitch=pitch * stand, dz=(PERCH_DZ - 0.003 * crouch) * stand, dy=PERCH_DY * stand)
    p.tail(lift=-0.55 * stand - 0.05 * (1 - stand), fan=0.85 * stand + 1.2 * (1 - stand))
    p.head(pitch_down=PERCH_HEAD * stand + 0.2 * (1 - stand), neck_up=0.15 * stand)
    tuck = track(f, [(TAKE_OFF_FRAME, 0.0), (18, 1.0)])
    p.legs(swing=lerp(PERCH_PITCH - 0.35 - 0.3 * crouch, 1.25, tuck), knee=lerp(0.55 + 0.4 * crouch, 0.9, tuck),
           grip=lerp(0.35, 1.3, tuck), spread=0.04)
    return p.d


# Where the perched hawk's body sits relative to its feet: found by `fit_perch` from the pose itself.
PERCH_DZ = 0.0
PERCH_DY = 0.0


def feet_point(rig, pose):
    """Midpoint of the two ankles, the soles under them, in armature space."""
    _, world = pose_matrices(rig, pose)
    pts = [world['shank' + n] @ Vector((SIDES[n] * ANKLE.x, ANKLE.y, ANKLE.z - TOE_R * 1.6)) for n in SIDES]
    return (pts[0] + pts[1]) / 2


def talon_point(rig, pose):
    """Midpoint of the front talon tips, in armature space."""
    _, world = pose_matrices(rig, pose)
    pts = []
    for n, s in SIDES.items():
        tip = ANKLE + Vector((0, -TOES[1][1] - 0.002, -0.002))
        pts.append(world['toes' + n] @ Vector((s * tip.x, tip.y, tip.z)))
    return (pts[0] + pts[1]) / 2


def fit_perch(rig):
    """Shift the perched body so its feet are straight under the origin, origin above them by the
    feet's depth: the game puts the origin over the perch point."""
    global PERCH_DZ, PERCH_DY
    PERCH_DZ = PERCH_DY = 0.0
    feet = feet_point(rig, perch_base(P()).d)
    PERCH_DY = -feet.y
    return feet


def build_animations(rig):
    feet = fit_perch(rig)
    clip(rig, 'glide', 60, glide_pose)
    clip(rig, 'flap', 10, flap_pose)
    clip(rig, 'stoop', 20, stoop_pose)
    clip(rig, 'strike', STRIKE_FRAMES, strike_pose, loop=False)
    clip(rig, 'perch', PERCH_FRAMES, perch_pose)
    clip(rig, 'land', LAND_FRAMES, land_pose, loop=False)
    clip(rig, 'take_off', TAKE_OFF_FRAMES, take_off_pose, loop=False)
    for act in bpy.data.actions:
        tr = rig.animation_data.nla_tracks.new()
        tr.name = act.name
        strip = tr.strips.new(act.name, int(act.frame_range[0]), act)
        strip.name = act.name
    rig.animation_data.action = None
    return feet


def gltf(v):
    """Blender (x, y, z) -> glTF (x, z, -y)."""
    return [v.x, v.z, -v.y]


def export(rig, feet):
    talons = talon_point(rig, strike_pose(STRIKE_FRAME))
    rig['strike_time'] = STRIKE_FRAME / FPS
    rig['land_time'] = LAND_FRAME / FPS
    rig['take_off_time'] = TAKE_OFF_FRAME / FPS
    # The talons at the moment of the strike, and the perched feet, relative to the origin.
    rig['strike_talons'] = gltf(talons)
    rig['perch_feet'] = gltf(Vector((0, 0, feet.z)))
    rig['wingspan'] = 2 * PRIMARIES[2][2]
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT), export_format='GLB', export_yup=True, export_apply=False,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True, export_morph=False,
        export_materials='EXPORT', export_texcoords=True, export_image_format='JPEG', export_jpeg_quality=90,
        export_extras=True, export_def_bones=False)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes; talons', [round(x, 4) for x in gltf(talons)],
          'perch feet', round(feet.z, 4))


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    mats = make_materials()
    rig = build_armature()
    build_mesh(rig, mats)
    feet = build_animations(rig)
    export(rig, feet)


if __name__ == '__main__':
    main()

"""Generate the Galapagos racer (Pseudalsophis occidentalis, the Fernandina racer) -> src/assets/snake.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/snake.py

Real size: adults of this species run to about 1.2 m; the one here is a typical adult, 0.9 m snout
to tail tip, at the game's real scale (the hatchling iguana it hunts is ~0.19 m). Proportions were
checked against side-on and top-down iNaturalist photos (taxon 558936): the tail is about a
quarter of the length, the body at its thickest about 2.3% of the length across, a little less
deep, flat-bellied; the head distinct from the neck, about 3.6% of the length, with large eyes.

Colour: pale greyish-brown above with a blackish stripe down the middle of the back between two
pale stripes, dark spots along the flanks, a pair of cream blotches on the nape, cream lips and
belly. One texture, painted with numpy: u runs round the body (0.5 the middle of the back, 0 and 1
the middle of the belly), v along it (0 the snout, 1 the tail tip).

Conventions (Blender space, Z up, exported Y up): the snake lies straight along +Y with the snout
tip at the origin and faces -Y (+Z in glTF), its belly on z = 0. There are no clips: the game bends
it along the path its head has taken (src/dunes/snakeBody.ts). The armature's bones are all
unparented, so the game can place each one directly:

- `head`: rigid, owns the whole head back to the angle of the jaw (HEAD_LEN); its joint is there.
- `spine_1`..`spine_N`: evenly spaced from the jaw to the tail tip. Every body vertex is shared by
  the two joints either side of it, by distance, so the body bends smoothly between them.
- `tongue`: the forked tongue, child of `head`, its joint at the mouth; the game slides it out
  and back by scaling the bone along its length.

Extras on the armature: `length`, `head_length`, `spine` (each bone's distance back from the snout
tip along the body, head first), `width` and `height` (the body's girth at each of those).
"""

import math
import os
import sys

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import blur, check_winding, hexrgb, lerp, smooth, srgb_lin  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'snake.glb')

LENGTH = 0.90
HEAD_LEN = 0.032  # snout tip to the angle of the jaw
VENT = 0.74 * LENGTH  # tail is the last ~26%
SPINE_BONES = 46
RING_SIDES = 16
RINGS = 150

# Girth (m) along the body: (distance from the snout, width, height). The head is broad behind the
# eyes and narrows at the neck; the body thickens to mid-length and tapers to a fine tail tip.
GIRTH = [
    (0.000, 0.0030, 0.0022),
    (0.002, 0.0058, 0.0042),
    (0.006, 0.0082, 0.0058),
    (0.012, 0.0108, 0.0075),
    (0.020, 0.0140, 0.0094),
    (0.027, 0.0152, 0.0102),
    (0.032, 0.0140, 0.0102),
    (0.040, 0.0118, 0.0102),
    (0.060, 0.0125, 0.0110),
    (0.150, 0.0150, 0.0130),
    (0.330, 0.0180, 0.0155),
    (0.500, 0.0182, 0.0157),
    (0.620, 0.0164, 0.0142),
    (VENT, 0.0140, 0.0122),
    (0.800, 0.0090, 0.0082),
    (0.860, 0.0052, 0.0048),
    (0.890, 0.0018, 0.0018),
    (LENGTH, 0.0004, 0.0004),
]


def girth(s):
    for (s0, w0, h0), (s1, w1, h1) in zip(GIRTH, GIRTH[1:]):
        if s <= s1:
            t = (s - s0) / (s1 - s0)
            t = t * t * (3 - 2 * t)
            return lerp(w0, w1, t), lerp(h0, h1, t)
    return GIRTH[-1][1], GIRTH[-1][2]


# Arc positions of the bones: the head's joint at the jaw, then evenly to the tail tip.
SPINE = [HEAD_LEN] + [HEAD_LEN + (LENGTH - HEAD_LEN) * (i + 1) / SPINE_BONES for i in range(SPINE_BONES)]
BONES = ['head'] + [f'spine_{i + 1}' for i in range(SPINE_BONES)]

# Eyes: big, on the sides of the head toward the top, a little behind the snout.
EYE_S = 0.0105
EYE_R = 0.0019
EYE_UP = 0.0060
# The tongue: a thin black ribbon from the mouth, forked for its last third.
TONGUE_LEN = 0.024
TONGUE_W = 0.0011
MOUTH_UP = 0.0016

# ---------------------------------------------------------------------------------------------
# Texture
# ---------------------------------------------------------------------------------------------
TEX_W = 128  # round the body, per colour form
TEX_H = 2048  # along it

# Two colour forms, both common on Fernandina (see the photos): a spotted one, grey-brown with
# rows of dark blotches that join into a checker, and a striped one, nearly black with a thin pale
# line down each side of the back. Both have cream lips, a paler belly and pale nape spots. The
# texture holds both side by side; each snake's material shows one half.
FORMS = {
    'spotted': dict(back='#6c6253', flank='#5d5446', belly='#b9b19c', mark='#2b241d', line=None,
                    head='#4f463a', lip='#d9cfb4', nape='#cfc6aa'),
    'striped': dict(back='#2f2924', flank='#2a2420', belly='#9d968a', mark=None, line='#c4bea6',
                    head='#2a2420', lip='#cfc7ac', nape='#bdb69d'),
}


def paint_skin(rng, form):
    import numpy as np
    f = FORMS[form]
    v = (np.arange(TEX_H) + 0.5) / TEX_H  # along, 0 snout .. 1 tail tip
    u = (np.arange(TEX_W) + 0.5) / TEX_W  # round, 0.5 the middle of the back
    s = (v * LENGTH)[:, None] + np.zeros((1, TEX_W))
    d = np.abs(u - 0.5)[None, :] * 2 + np.zeros((TEX_H, 1))  # 0 on the back's midline, 1 on the belly's
    col = lambda h: np.array(hexrgb(h))
    mixin = lambda img, w, h: img * (1 - w[..., None]) + col(h) * w[..., None]
    img = np.zeros((TEX_H, TEX_W, 3)) + col(f['back'])
    img = mixin(img, smooth_np((d - 0.3) / 0.3), f['flank'])
    img = mixin(img, smooth_np((d - 0.62) / 0.12), f['belly'])
    body = (s > HEAD_LEN + 0.004).astype(float)
    fade = 1 - 0.6 * smooth_np((s - 0.6) / 0.25)
    if f['mark']:
        # Blotches in two staggered rows each side of the midline, joining across the back.
        period = 0.017
        k = np.floor(s / period)
        jit = rng.uniform(-0.15, 0.15, size=4096)[k.astype(int).clip(0, 4095)]
        ph = s / period - k - 0.5 - jit
        row1 = np.exp(-(ph / 0.26) ** 2 - ((d - 0.13) / 0.075) ** 2)
        ph2 = s / period - k - jit
        ph2 = np.minimum(np.abs(ph2), np.abs(ph2 - 1))
        row2 = np.exp(-(ph2 / 0.24) ** 2 - ((d - 0.38) / 0.07) ** 2)
        img = mixin(img, np.clip(0.85 * (row1 + row2), 0, 0.85) * body * fade, f['mark'])
    if f['line']:
        line = np.exp(-((d - 0.2) / 0.03) ** 2) * body * fade
        img = mixin(img, 0.9 * line, f['line'])
        low = np.exp(-((d - 0.56) / 0.025) ** 2) * body * fade * 0.6
        img = mixin(img, low, f['line'])
    # Head: plain on top, cream lips below the eye line, a dark streak back from the eye.
    head = (s < HEAD_LEN + 0.003).astype(float)
    img = mixin(img, 0.9 * head * (d < 0.45), f['head'])
    img = mixin(img, head * smooth_np((d - 0.5) / 0.08), f['lip'])
    behind_eye = np.exp(-((s - (EYE_S + 0.009)) / 0.006) ** 2 - ((d - 0.47) / 0.04) ** 2) * (s > EYE_S)
    img = mixin(img, 0.6 * behind_eye, '#1d1813')
    # The pair of pale spots on the nape.
    nape = np.exp(-((s - 0.04) / 0.005) ** 2 - ((d - 0.2) / 0.07) ** 2)
    img = mixin(img, 0.9 * nape, f['nape'])
    # Scales: smooth dorsals, ~19 rows round the back and sides, staggered; broad belly plates.
    belly = smooth_np((d - 0.62) / 0.12)
    rows = 19 / (2 * 0.62)
    row = d * rows
    along = s / 0.0052 + 0.5 * (np.floor(row) % 2)
    edge = np.minimum(np.abs(row - np.round(row)), 2.2 * np.abs(along - np.round(along)))
    scale_line = (1 - smooth_np(edge / 0.12)) * (1 - belly) * (s > HEAD_LEN)
    plates = (1 - smooth_np(np.abs(s / 0.0032 - np.round(s / 0.0032)) / 0.12)) * belly * (s > HEAD_LEN)
    img *= 1 - 0.12 * scale_line[..., None] - 0.1 * plates[..., None]
    # Pale scale edges catch the light on the dark form.
    if form == 'striped':
        img += 0.025 * scale_line[..., None]
    noise = blur(rng.normal(0, 1, (TEX_H, TEX_W)), 3)
    img *= 1 + 0.06 * noise[..., None] / max(1e-6, noise.std())
    return np.clip(img, 0, 1)


def smooth_np(t):
    import numpy as np
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def make_texture():
    import numpy as np
    rng = np.random.default_rng(31)
    img = np.concatenate([paint_skin(rng, form) for form in FORMS], axis=1)
    rgba = np.concatenate([img, np.ones((TEX_H, 2 * TEX_W, 1))], axis=2).astype(np.float32)
    # Blender images start at the bottom row; row 0 here is the snout, at v = 0.
    image = bpy.data.images.new('RacerSkin', 2 * TEX_W, TEX_H, alpha=False)
    image.colorspace_settings.name = 'sRGB'
    image.pixels.foreach_set(rgba.ravel())
    image.file_format = 'JPEG'
    image.pack()
    return image


COLORS = {
    'Skin': None,
    'Eye': srgb_lin(hexrgb('#1c140f')),
    'Tongue': srgb_lin(hexrgb('#24181a')),
}


def make_materials():
    mats = {}
    tex = make_texture()
    for name, rgb in COLORS.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = 0.5
        if rgb is None:
            node = m.node_tree.nodes.new('ShaderNodeTexImage')
            node.image = tex
            m.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        mats[name] = m
    return mats


# ---------------------------------------------------------------------------------------------
# Mesh
# ---------------------------------------------------------------------------------------------
class MeshBuilder:
    def __init__(self):
        self.verts, self.weights, self.faces, self.face_mats, self.face_uvs = [], [], [], [], []

    def vert(self, co, weights):
        self.verts.append(Vector(co))
        self.weights.append(weights)
        return len(self.verts) - 1

    def face(self, idx, mat, uvs=None):
        self.faces.append(idx)
        self.face_mats.append(mat)
        self.face_uvs.append(uvs)


def spine_weights(s):
    """The two joints either side of distance s, shared by how near each is; the head is rigid."""
    if s <= SPINE[0]:
        return {'head': 1.0}
    for i in range(len(SPINE) - 1):
        if s <= SPINE[i + 1]:
            t = (s - SPINE[i]) / (SPINE[i + 1] - SPINE[i])
            return {BONES[i]: 1 - t, BONES[i + 1]: t}
    return {BONES[-1]: 1.0}


def section(s, a):
    """A point of the cross-section at distance s, angle a round it (0 the top of the back, + toward
    the snake's left, +X): rounded above, nearly flat below, the belly resting on z = 0."""
    w, h = girth(s)
    x = 0.5 * w * math.sin(a)
    c = math.cos(a)
    # The lower half is squarer: a flat belly with rounded edges.
    z = 0.5 * h + 0.5 * h * (c if c >= 0 else -abs(c) ** 0.55)
    # The head's top is flatter, its jaw line straighter.
    if s < HEAD_LEN + 0.004:
        k = 1 - smooth((s - HEAD_LEN) / 0.004)
        if c > 0:
            z = 0.5 * h + 0.5 * h * lerp(c, c ** 0.6, 0.6 * k)
    return Vector((x, s, z))


def ring_s(i):
    # Rings crowd toward the snout, where the head's shape changes fastest.
    t = i / RINGS
    return LENGTH * (0.35 * t * t + 0.65 * t) if t < 1 else LENGTH


def build_body(mb):
    rings = []
    for i in range(RINGS + 1):
        s = max(0.0004, ring_s(i))
        if i == RINGS:
            break
        ring = []
        for k in range(RING_SIDES + 1):  # the seam vertex repeats, for the texture's wrap
            a = 2 * math.pi * k / RING_SIDES + math.pi  # starts and ends on the belly's midline
            ring.append(mb.vert(section(s, a), spine_weights(s)))
        rings.append((s, ring))
    tip = mb.vert((0, -0.0002, 0.0011), {'head': 1.0})
    tail = mb.vert((0, LENGTH, 0.0002), spine_weights(LENGTH))
    # The first colour form's half of the texture; the game shifts it for the other form.
    uv = lambda k, s: (0.5 * k / RING_SIDES, s / LENGTH)
    # The snout cap, then the rings.
    s0, r0 = rings[0]
    for k in range(RING_SIDES):
        mb.face([tip, r0[k + 1], r0[k]], 'Skin', [(0.5 * (k + 0.5) / RING_SIDES, 0.0), uv(k + 1, s0), uv(k, s0)])
    for (sa, ra), (sb, rb) in zip(rings, rings[1:]):
        for k in range(RING_SIDES):
            mb.face([ra[k], ra[k + 1], rb[k + 1], rb[k]], 'Skin', [uv(k, sa), uv(k + 1, sa), uv(k + 1, sb), uv(k, sb)])
    sl, rl = rings[-1]
    for k in range(RING_SIDES):
        mb.face([rl[k], rl[k + 1], tail], 'Skin', [uv(k, sl), uv(k + 1, sl), (0.5 * (k + 0.5) / RING_SIDES, 1.0)])


def sphere(mb, centre, r, mat, weights, rings=5, sides=8):
    c = Vector(centre)
    top = mb.vert(c + Vector((0, 0, r)), weights)
    bottom = mb.vert(c - Vector((0, 0, r)), weights)
    layers = []
    for i in range(1, rings):
        th = math.pi * i / rings
        layers.append([mb.vert(c + Vector((r * math.sin(th) * math.cos(2 * math.pi * k / sides),
                                           r * math.sin(th) * math.sin(2 * math.pi * k / sides),
                                           r * math.cos(th))), weights) for k in range(sides)])
    for k in range(sides):
        k1 = (k + 1) % sides
        mb.face([top, layers[0][k], layers[0][k1]], mat)
        mb.face([bottom, layers[-1][k1], layers[-1][k]], mat)
        for a, b in zip(layers, layers[1:]):
            mb.face([a[k], b[k], b[k1], a[k1]], mat)


def build_eyes(mb):
    w, h = girth(EYE_S)
    for side in (1, -1):
        # Set into the side of the head so a little more than half of it shows.
        x = side * (0.5 * w - 0.6 * EYE_R)
        sphere(mb, (x, EYE_S, EYE_UP), EYE_R, 'Eye', {'head': 1.0})


def build_tongue(mb):
    """A flat ribbon out in front of the mouth (-Y), forked for its last third; closed on itself
    top and bottom so it has some thickness."""
    t = 0.0004
    pts = []
    n = 6
    for i in range(n + 1):
        f = i / n
        pts.append((f, -TONGUE_LEN * f))
    fork = 0.62
    def strip(x0, x1, ys, w0, w1):
        top, bot = [], []
        for j, (f, y) in enumerate(ys):
            ww = lerp(w0, w1, j / (len(ys) - 1))
            x = lerp(x0, x1, j / (len(ys) - 1))
            top.append((mb.vert((x - ww, y, MOUTH_UP + t), {'tongue': 1.0}), mb.vert((x + ww, y, MOUTH_UP + t), {'tongue': 1.0})))
            bot.append((mb.vert((x - ww, y, MOUTH_UP - t), {'tongue': 1.0}), mb.vert((x + ww, y, MOUTH_UP - t), {'tongue': 1.0})))
        for (a, b), (c, d) in zip(top, top[1:]):
            mb.face([a, c, d, b], 'Tongue')
        for (a, b), (c, d) in zip(bot, bot[1:]):
            mb.face([a, b, d, c], 'Tongue')
        for (ta, tb), (ba, bb), (tc, td), (bc, bd) in zip(top, bot, top[1:], bot[1:]):
            mb.face([ta, ba, bc, tc], 'Tongue')
            mb.face([tb, td, bd, bb], 'Tongue')
        mb.face([top[0][0], top[0][1], bot[0][1], bot[0][0]], 'Tongue')
        mb.face([top[-1][0], bot[-1][0], bot[-1][1], top[-1][1]], 'Tongue')
    stem = [p for p in pts if p[0] <= fork + 1e-6] + [(fork, -TONGUE_LEN * fork)]
    stem = sorted(set(stem))
    strip(0, 0, [(f, y) for f, y in stem], TONGUE_W, TONGUE_W * 0.9)
    tine = [(f, -TONGUE_LEN * f) for f in (fork, (fork + 1) / 2, 1.0)]
    for side in (1, -1):
        strip(side * TONGUE_W * 0.5, side * TONGUE_W * 2.6, tine, TONGUE_W * 0.45, TONGUE_W * 0.15)


def build_mesh(rig, mats):
    mb = MeshBuilder()
    build_body(mb)
    build_eyes(mb)
    build_tongue(mb)
    me = bpy.data.meshes.new('RacerMesh')
    me.from_pydata([tuple(v) for v in mb.verts], [], mb.faces)
    names = list(COLORS)
    for n in names:
        me.materials.append(mats[n])
    uv_layer = me.uv_layers.new(name='UVMap')
    for poly, mat, uvs in zip(me.polygons, mb.face_mats, mb.face_uvs):
        poly.material_index = names.index(mat)
        poly.use_smooth = True
        for li, uv in zip(poly.loop_indices, uvs or [(0.5, 0.5)] * poly.loop_total):
            uv_layer.data[li].uv = uv
    me.validate()
    me.update()
    check_winding(me)
    obj = bpy.data.objects.new('RacerBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones}
    for i, ws in enumerate(mb.weights):
        for bone, w in ws.items():
            if w > 1e-4:
                groups[bone].add([i], w, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


def build_armature():
    data = bpy.data.armatures.new('RacerRig')
    rig = bpy.data.objects.new('Racer', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    for name, s in zip(BONES, SPINE):
        b = eb.new(name)
        # Each joint sits on the body's axis at its distance back, pointing back along the body.
        h = girth(s)[1] * 0.5
        b.head = (0, s, h)
        b.tail = (0, s + 0.01, h)
        b.roll = 0.0
    t = eb.new('tongue')
    t.head = (0, 0.002, MOUTH_UP)
    t.tail = (0, -0.008, MOUTH_UP)
    t.roll = 0.0
    t.parent = eb['head']
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def export(rig):
    rig['length'] = LENGTH
    rig['head_length'] = HEAD_LEN
    rig['spine'] = SPINE
    rig['width'] = [girth(s)[0] for s in SPINE]
    rig['height'] = [girth(s)[1] for s in SPINE]
    rig['tongue_length'] = TONGUE_LEN
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT), export_format='GLB', export_yup=True, export_apply=False,
        export_animations=False, export_skins=True, export_morph=False,
        export_materials='EXPORT', export_texcoords=True, export_image_format='JPEG', export_jpeg_quality=88,
        export_extras=True, export_def_bones=False)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = make_materials()
    rig = build_armature()
    build_mesh(rig, mats)
    export(rig)


if __name__ == '__main__':
    main()

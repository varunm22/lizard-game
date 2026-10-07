"""Generate a Sally Lightfoot crab (Grapsus grapsus) with its animation clips -> src/assets/crab.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/crab.py [out.glb]

Same conventions as the game's other creature scripts (Blender space, Z up): the crab faces -Y,
which the glTF exporter turns into +Z forward, Y up; +X is the crab's left. Units are metres at
game scale, about a fifth of real size like the 0.19 m iguana: the carapace is 16 mm wide (8 cm
real, a big adult) and the legs span about 45 mm.

A crab is a set of rigid plates, so every vertex belongs to exactly one bone (no weight blending),
and each joint gets a ball on the child segment so nothing opens up when it bends.

Clips (60 fps, crabs are quick): idle, walk_left, walk_right, run_left, run_right (sideways, loop at
CRAB_GAIT_SPEED), graze (claws pick algae off the rock and feed it to the mouth, loops; the same
motion serves for grooming an iguana's skin), hop_left, hop_right (leap onto or off a rock), duck (flatten with
the eyes folded down; hold the last frame while hiding), display (claws raised, body high, settle).
hop_left and hop_right crouch, spring and land in place: the game moves the crab along the leap
(src/creatures/crab.ts), from HOP_TAKEOFF to HOP_LAND, since every jump it makes is a different
height.

Legs are posed by placing each foot tip and solving the leg analytically in its own vertical
plane, then baked to plain rotation keys, so planted feet never slide.
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

from common import lerp, srgb_lin, smooth, track, hexrgb, blur, check_winding

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'crab.glb')
FPS = 60

# ---------------------------------------------------------------------------------------------
# Shape (Blender space, metres at game scale). Ratios measured off iNaturalist photos of adults
# on Galapagos lava (see measure notes in the thread): carapace slightly wider than long and
# widest just behind the eyes, legs spanning ~2.8x the carapace width, small equal claws.
# ---------------------------------------------------------------------------------------------
CW, CL = 0.0080, 0.0074  # carapace half width, half length
BODY_Z = 0.0068  # carapace underside height when standing
CARA_H = 0.0030  # dome height above the underside rim (carapace ~1/3 as thick as long)
BELLY_H = 0.0008  # sternum bulge below the rim

# Walking legs, front to back: coxa (on the body's side, armature space), splay angle of the leg
# from straight out (positive = toward the front), and segment lengths (merus, carpus+propodus,
# dactyl). Pair 1 is shortest, 2 and 3 are longest.
LEG_DEF = [
    dict(y=-0.0030, splay=0.68, seg=(0.0078, 0.0066, 0.0034)),
    dict(y=-0.0006, splay=0.22, seg=(0.0092, 0.0080, 0.0040)),
    dict(y=0.0018, splay=-0.18, seg=(0.0094, 0.0081, 0.0040)),
    dict(y=0.0040, splay=-0.62, seg=(0.0080, 0.0068, 0.0034)),
]
LEG_REACH = 0.72  # standing, the foot is this fraction of the leg's length out (horizontally) from the coxa
DACTYL_TILT = 0.45  # radians the dactyl leans out from vertical when planted
CLAW_SEG = (0.0034, 0.0026, 0.0046, 0.0028)  # merus, carpus, palm, finger (dactyl)

WALK = dict(frames=36, stride=0.0034, duty=0.62, lift=0.0030)
RUN = dict(frames=12, stride=0.0055, duty=0.50, lift=0.0034)


def gait_speed(g):
    return 2 * g['stride'] / (g['duty'] * g['frames'] / FPS)


CRAB_GAIT_SPEED = gait_speed(WALK)
CRAB_RUN_SPEED = gait_speed(RUN)


# ---------------------------------------------------------------------------------------------
# Texture atlas, 512 x 256, painted with numpy (row 0 is the bottom). Left half: the carapace seen
# from above. Right half: leg and claw bands (u around the segment, v along it).
# ---------------------------------------------------------------------------------------------
TEX_W, TEX_H = 512, 256
UV_PAD = 1.04
LEG_BANDS = {'leg': (0.0, 0.55), 'claw': (0.55, 0.85), 'finger': (0.85, 1.0)}


def cara_uv(xn, yn):
    return 0.25 + 0.25 * xn / UV_PAD, 0.5 - 0.5 * yn / UV_PAD


def leg_uv(band, t, a):
    v0, v1 = LEG_BANDS[band]
    return 0.5 + 0.5 * ((a / (2 * math.pi)) % 1.0) * 0.998, lerp(v0, v1, min(0.995, max(0.005, t)))


def paint_carapace(rng):
    """Seen from above (front at the top): the back two thirds are crossed by bold curved ridges,
    dark maroon over orange-red, arcing around a point in front of the carapace; the front edge
    and the deflexed face between the eyes are yellow-orange; pale yellow dots everywhere."""
    n = TEX_H
    v, u = np.mgrid[0:n, 0:n] + 0.5
    xn = (u / n * 2 - 1) * UV_PAD
    yn = (1 - 2 * v / n) * UV_PAD  # -1 = front
    red = np.array(hexrgb('#c0301a'))
    maroon = np.array(hexrgb('#6e1a14'))
    yellow = np.array(hexrgb('#f0a22a'))
    img = np.tile(red, (n, n, 1))
    # Ridges: rings around (0, -1.35), wobbled, each a dark groove with an orange crest behind it.
    r = np.sqrt(xn ** 2 + ((yn + 1.35) * 0.95) ** 2) + 0.012 * np.sin(xn * 17 + 2) + 0.008 * np.sin(yn * 23)
    ph = (r * 7.5) % 1.0
    groove = np.clip(1 - np.abs(ph - 0.5) / 0.22, 0, 1) ** 0.8
    crest = np.clip(1 - np.abs(ph - 0.15) / 0.18, 0, 1)
    img = img * (1 - 0.85 * groove[..., None]) + maroon * 0.85 * groove[..., None]
    img = img * (1 - 0.35 * crest[..., None]) + np.array(hexrgb('#f07a2e')) * 0.35 * crest[..., None]
    # Front edge and face: yellow-orange fading back into the ridges.
    front = np.clip((-yn - 0.62 + 0.5 * xn ** 2) * 3.5, 0, 1) * np.clip(1.4 - np.abs(xn) * 1.2, 0, 1)
    img = img * (1 - front[..., None]) + yellow * front[..., None]
    # Shallow grooves outlining the gastric region.
    h = blur(((np.abs(np.abs(xn) - 0.24 - 0.15 * (yn + 0.6) ** 2) < 0.02) & (yn < -0.3) & (yn > -0.85)).astype(float), 2)
    img = img * (1 - 0.5 * h[..., None]) + maroon * 0.5 * h[..., None]
    # Pale yellow dots scattered over everything, denser on the front.
    dots = blur((rng.random((n, n)) > 0.996).astype(float), 1)
    m = dots > 0.12
    img[m] = img[m] * 0.3 + np.array(hexrgb('#f6e08a')) * 0.7
    # The deflexed front edge and the rim of the orbits read darker from above.
    edge = np.clip((np.abs(xn) ** 3 + np.abs(yn) ** 2.6) * 1.0 - 0.82, 0, 1)[..., None] * 2.5
    img = img * (1 - 0.35 * np.clip(edge, 0, 1)) + maroon * 0.35 * np.clip(edge, 0, 1)
    return np.clip(img, 0, 1)


def paint_legs(rng):
    h, w = TEX_H, TEX_W // 2
    img = np.zeros((h, w, 3))
    rows = {k: (int(a * h), int(b * h)) for k, (a, b) in LEG_BANDS.items()}
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    # Legs: red on top, paler orange-pink underneath (u = 0.25 is the top of the segment), with
    # dark red mottled spots and a darker band near each joint.
    r0, r1 = rows['leg']
    t = (yy[r0:r1] - r0) / (r1 - r0)
    a = xx[r0:r1] / w * 2 * np.pi
    top = (0.5 + 0.5 * np.sin(a))[..., None]
    base = np.array(hexrgb('#d24a2a')) * (1 - top) + np.array(hexrgb('#b01c10')) * top
    spots = blur(rng.random((r1 - r0, w)), 2)
    spots = (spots > 0.56)[..., None] * top
    tile = base * (1 - 0.45 * spots) + np.array(hexrgb('#5c1410')) * 0.45 * spots
    joint = np.clip(1 - np.minimum(t, 1 - t) * 14, 0, 1)[..., None]
    tile = tile * (1 - 0.35 * joint) + np.array(hexrgb('#6a1812')) * 0.35 * joint
    dots = rng.random((r1 - r0, w)) > 0.995
    tile[dots] = np.array(hexrgb('#f2d070'))
    img[r0:r1] = tile
    # Claw palm: glossy red with a few pale tubercles.
    r0, r1 = rows['claw']
    a = xx[r0:r1] / w * 2 * np.pi
    top = (0.5 + 0.5 * np.sin(a))[..., None]
    tile = np.array(hexrgb('#e05a3a')) * (1 - top) + np.array(hexrgb('#c02414')) * top
    bumps = (rng.random((r1 - r0, w)) > 0.985)
    tile[bumps] = np.array(hexrgb('#f0c0a0'))
    img[r0:r1] = tile
    # Fingers: red at the base fading to white tips.
    r0, r1 = rows['finger']
    t = ((yy[r0:r1] - r0) / (r1 - r0))[..., None]
    img[r0:r1] = np.array(hexrgb('#c83a24')) * (1 - smooth_np(t)) + np.array(hexrgb('#f2ece0')) * smooth_np(t)
    return np.clip(img, 0, 1)


def smooth_np(t):
    t = np.clip((t - 0.3) / 0.5, 0, 1)
    return t * t * (3 - 2 * t)


def make_texture():
    rng = np.random.default_rng(11)
    atlas = np.zeros((TEX_H, TEX_W, 3))
    atlas[:, :TEX_W // 2] = paint_carapace(rng)
    atlas[:, TEX_W // 2:] = paint_legs(rng)
    rgba = np.concatenate([atlas, np.ones((TEX_H, TEX_W, 1))], axis=2).astype(np.float32)
    img = bpy.data.images.new('CrabShell', TEX_W, TEX_H, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'JPEG'
    img.pack()
    return img


COLORS = {
    'Shell': None,  # textured: carapace and limbs share one atlas
    'Belly': srgb_lin(hexrgb('#93b4b2')),  # pale blue-green underside
    'Joint': srgb_lin(hexrgb('#7c2416')),  # joint membranes, darker than the plates
    'Stalk': srgb_lin(hexrgb('#b8341f')),
    'Eye': srgb_lin(hexrgb('#4a2016')),  # reddish-brown
    'Claw tip': srgb_lin(hexrgb('#3a2018')),  # dark horny tips of the dactyls
    'Shine': (1.0, 1.0, 1.0),
}
SOLID_UV = (0.75, 0.5)


def make_materials():
    mats = {}
    tex = make_texture()
    for name, rgb in COLORS.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = 0.55
        if rgb is None:
            node = m.node_tree.nodes.new('ShaderNodeTexImage')
            node.image = tex
            m.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        mats[name] = m
    return mats


# ---------------------------------------------------------------------------------------------
# Rest skeleton. Every limb is a chain of joint points; a bone runs between consecutive points
# and its roll is set from a hint vector, the same way the poses are built, so rest and pose
# matrices share one convention.
# ---------------------------------------------------------------------------------------------
def side_name(side):
    return '_L' if side > 0 else '_R'


LEGS = [f'leg{i + 1}{side_name(s)}' for i in range(4) for s in (1, -1)]
CLAWS = ['claw_L', 'claw_R']
EYES = ['eye_L', 'eye_R']


def leg_info(name):
    i = int(name[3]) - 1
    side = 1 if name.endswith('_L') else -1
    return LEG_DEF[i], side


def coxa(name):
    d, side = leg_info(name)
    # Coxae sit along the curved side of the carapace, just under its rim.
    yn = d['y'] / CL
    x = CW * 0.80 * math.sqrt(max(0.0, 1 - (yn * 0.9) ** 2))
    return Vector((side * x, d['y'], BODY_Z - 0.0003))


def leg_out(name, splay_extra=0.0):
    """Horizontal unit vector a leg reaches along (its plane's direction)."""
    d, side = leg_info(name)
    a = d['splay'] + splay_extra
    return Vector((side * math.cos(a), -math.sin(a), 0.0))


def leg_sweep(name):
    d, _ = leg_info(name)
    return 1.4 * math.sin(d['splay']) - 0.3


def rest_foot(name, body=None):
    d, _ = leg_info(name)
    total = sum(d['seg'])
    c = coxa(name)
    p = c + leg_out(name) * (total * LEG_REACH)
    return Vector((p.x, p.y, 0.0))


def solve_leg(base, foot, segs, out_hint, tilt=DACTYL_TILT, sweep=0.0, back=Vector((0, 1, 0))):
    """Joint points (coxa, knee, ankle, tip) for a leg whose tip is planted at `foot`. The leg lies in
    the vertical plane through the coxa and the foot; the dactyl leans `tilt` out from vertical and
    the merus-propodus joint bends upward (crabs stand on arched legs). sweep leans the knee toward
    `back` (the body's +Y, its rear), so seen from above the legs bow the way a crab's do: knees
    near straight out to the side, the far segments fanning forward (front pair) or back."""
    l1, l2, l3 = segs
    flat = Vector((foot.x - base.x, foot.y - base.y, 0.0))
    out = flat.normalized() if flat.length > 1e-6 else out_hint
    up = Vector((0, 0, 1))
    ddir = (out * math.sin(tilt) - up * math.cos(tilt))
    ankle = foot - ddir * l3
    v = ankle - base
    dist = min(v.length, (l1 + l2) * 0.999)
    dist = max(dist, abs(l1 - l2) * 1.001)
    ax = v.normalized()
    # Bend direction: in the leg plane, perpendicular to base->ankle, pointing up.
    side = ax.cross(up)
    if side.length < 1e-6:
        side = out.cross(up)
    bend = side.cross(ax).normalized()
    if bend.z < 0:
        bend = -bend
    bend = bend + (back - ax * back.dot(ax)) * sweep
    bend = (bend - ax * bend.dot(ax)).normalized()
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    knee = base + ax * a + bend * h
    ankle = base + ax * dist
    tip = ankle + ddir * l3
    return [base, knee, ankle, tip]


def leg_hint(pts):
    """Roll hint for a leg's bones: the normal of the plane its upper joints bend in."""
    n = (pts[1] - pts[0]).cross(pts[2] - pts[0])
    if n.length < 1e-9:
        out = Vector((pts[-1].x - pts[0].x, pts[-1].y - pts[0].y, 0))
        return out.normalized().cross(Vector((0, 0, 1)))
    return n.normalized()


def claw_points(side, wrist, palm_dir, open_=0.0):
    """Joint points (shoulder, elbow, wrist, palm tip, finger tip) for a cheliped: the shoulder is on
    the body, the wrist is placed, the palm points along palm_dir and the finger opens by open_."""
    sh = Vector((side * 0.0042, -CL * 0.80, BODY_Z - 0.0004))
    l1, l2, lp, lf = CLAW_SEG
    v = wrist - sh
    dist = max(min(v.length, (l1 + l2) * 0.999), abs(l1 - l2) * 1.001)
    ax = v.normalized()
    # The elbow points outward and a little up.
    hint = Vector((side, 0.0, 0.6)).normalized()
    bend = (hint - ax * hint.dot(ax)).normalized()
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    elbow = sh + ax * a + bend * h
    wrist = sh + ax * dist
    pd = palm_dir.normalized()
    tip = wrist + pd * lp
    # The finger hinges at the palm's upper outer edge and closes down onto the fixed finger.
    hinge = pd.cross(Vector((0, 0, 1)))
    if hinge.length < 1e-6:
        hinge = Vector((1, 0, 0))
    hinge.normalize()
    fdir = (Matrix.Rotation(-side * (0.08 + open_), 3, Vector((0, 0, 1))) @ pd)
    fdir = (Matrix.Rotation(open_ * 0.6, 3, hinge) @ fdir).normalized()
    fbase = wrist + pd * (lp - lf * 0.95)
    return [sh, elbow, wrist, tip], fbase, fbase + fdir * lf


REST_WRIST = {s: Vector((s * 0.0031, -CL - 0.0010, BODY_Z - 0.0006)) for s in (1, -1)}
REST_PALM = {s: Vector((-s * 0.65, -0.25, -0.72)) for s in (1, -1)}


def eye_points(side, raise_=1.0, swivel=0.0):
    base = Vector((side * 0.0047, -CL * 0.94, BODY_Z + CARA_H * 0.55))
    d = Vector((side * 0.30, -0.55, 0.78 * raise_ - 0.2 * (1 - raise_)))
    d = Matrix.Rotation(swivel, 3, Vector((0, 0, 1))) @ d
    return [base, base + d.normalized() * 0.0009]


def rest_chains():
    """name -> (bone names, joint points, roll hint) for every limb at rest."""
    chains = {}
    for leg in LEGS:
        d, side = leg_info(leg)
        pts = solve_leg(coxa(leg), rest_foot(leg), d['seg'], leg_out(leg), sweep=leg_sweep(leg))
        chains[leg] = ([leg + '_a', leg + '_b', leg + '_c'], pts, leg_hint(pts))
    for side in (1, -1):
        n = 'claw' + side_name(side)
        pts, fb, ft = claw_points(side, REST_WRIST[side], REST_PALM[side])
        chains[n] = ([n + '_a', n + '_b', n + '_palm'], pts, Vector((0, 0, 1)))
        chains[n + '_finger'] = ([n + '_finger'], [fb, ft], Vector((0, 0, 1)))
        e = 'eye' + side_name(side)
        chains[e] = ([e], eye_points(side), Vector((0, -1, 0)))
    return chains


def bone_matrix(head, tail, hint):
    """Armature-space matrix of a bone from head to tail with its Z axis as close to hint as can be."""
    y = (tail - head).normalized()
    z = hint - y * hint.dot(y)
    if z.length < 1e-6:
        z = Vector((0, 0, 1)) - y * y.z
        if z.length < 1e-6:
            z = Vector((0, 1, 0))
    z.normalize()
    x = y.cross(z)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = head
    return m


CHAIN_PARENT = {}


def build_armature():
    data = bpy.data.armatures.new('CrabRig')
    rig = bpy.data.objects.new('Crab', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones

    def bone(name, mat, length, parent=None, connect=False):
        b = eb.new(name)
        b.head = mat.translation
        b.tail = mat.translation + mat.col[1].to_3d() * length
        b.align_roll(mat.col[2].to_3d())
        b.parent, b.use_connect = parent, connect
        return b

    root = eb.new('root')
    root.head, root.tail = (0, 0, 0), (0, 0, 0.004)
    body = eb.new('body')
    body.head, body.tail = (0, CL * 0.4, BODY_Z), (0, -CL * 0.4, BODY_Z)
    body.roll = 0.0
    body.parent = root
    for key, (names, pts, hint) in rest_chains().items():
        parent = body
        if key.endswith('_finger'):
            parent = eb[key[:-7] + '_palm']
        for i, n in enumerate(names):
            m = bone_matrix(pts[i], pts[i + 1], hint)
            parent = bone(n, m, (pts[i + 1] - pts[i]).length, parent, connect=i > 0)
            CHAIN_PARENT[n] = parent.parent.name
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


# ---------------------------------------------------------------------------------------------
# Mesh: one mesh skinned to the armature, every vertex owned by one bone.
# ---------------------------------------------------------------------------------------------
class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.face_mats, self.face_uvs, self.weights = [], [], [], [], []

    def vert(self, co, bone):
        self.verts.append(Vector(co))
        self.weights.append(bone)
        return len(self.verts) - 1

    def face(self, idx, mat, uvs=None):
        self.faces.append(idx)
        self.face_mats.append(mat)
        self.face_uvs.append(uvs)


def carapace_outline(th):
    """Unit outline (x, y) at angle th (0 = front, -Y; positive toward +X): a rounded square that is
    widest just behind the eyes and has a nearly straight front margin between them."""
    s, c = math.sin(th), math.cos(th)
    p = 3.0 if c > 0 else 2.4  # squarer at the front
    e = 2 / p
    x = math.copysign(abs(s) ** e, s)
    y = -math.copysign(abs(c) ** e, c)
    # Taper toward the back and flare a touch at the front corners.
    x *= 1.0 - 0.10 * max(0.0, -c) ** 1.5 + 0.04 * max(0.0, c) * abs(s)
    return x, y


def build_carapace(mb):
    """The carapace as rings from the centre out to the rim, a rim that rolls under, and the pale
    sternum closing it underneath. The dome is low and flat-topped, sloping off at the sides."""
    n_around, rings = 36, 7
    top = []
    for k in range(n_around):
        th = 2 * math.pi * k / n_around
        ox, oy = carapace_outline(th)
        col = []
        for i in range(1, rings + 1):
            s = i / rings
            z = BODY_Z + 0.0004 + CARA_H * (1 - s ** 3.2) ** 0.6
            # The front margin dips slightly between the eyes and the dome sits a touch forward.
            col.append(((s * ox * CW, s * oy * CL - 0.0003 * (1 - s), z), cara_uv(s * ox, s * oy)))
        # Rim: a little out and down, then tucked under onto the belly.
        # Rim: the carapace's sides drop nearly straight down to the leg bases, then tuck under.
        col.append(((1.01 * ox * CW, 1.01 * oy * CL, BODY_Z + 0.0001), cara_uv(ox, oy)))
        col.append(((1.00 * ox * CW, 1.00 * oy * CL, BODY_Z - 0.0007), cara_uv(0.995 * ox, 0.995 * oy)))
        col.append(((0.93 * ox * CW, 0.93 * oy * CL, BODY_Z - 0.0010), cara_uv(0.99 * ox, 0.99 * oy)))
        top.append(col)
    centre = mb.vert((0, -0.0003, BODY_Z + 0.0004 + CARA_H), 'body')
    ids = [[mb.vert(p, 'body') for p, _ in col] for col in top]
    cuv = cara_uv(0, 0)
    for k in range(n_around):
        k2 = (k + 1) % n_around
        # k runs counter-clockwise seen from above (front, then +X), so centre, k, k2 faces up.
        mb.face([centre, ids[k][0], ids[k2][0]], 'Shell', [cuv, top[k][0][1], top[k2][0][1]])
        for i in range(len(ids[k]) - 1):
            mb.face([ids[k][i], ids[k][i + 1], ids[k2][i + 1], ids[k2][i]], 'Shell',
                    [top[k][i][1], top[k][i + 1][1], top[k2][i + 1][1], top[k2][i][1]])
    # Sternum: a shallow dome underneath, joined to the tucked rim.
    rim = [ids[k][-1] for k in range(n_around)]
    belly_rings = 4
    prev = rim
    for j in range(1, belly_rings + 1):
        s = 1 - j / (belly_rings + 1)
        ring = []
        for k in range(n_around):
            th = 2 * math.pi * k / n_around
            ox, oy = carapace_outline(th)
            z = BODY_Z - 0.0010 - BELLY_H * (1 - s ** 2) ** 0.5
            ring.append(mb.vert((0.93 * s * ox * CW, 0.93 * s * oy * CL, z), 'body'))
        for k in range(n_around):
            k2 = (k + 1) % n_around
            mb.face([prev[k], ring[k], ring[k2], prev[k2]], 'Belly')
        prev = ring
    bottom = mb.vert((0, 0, BODY_Z - 0.0010 - BELLY_H), 'body')
    for k in range(n_around):
        mb.face([prev[k], bottom, prev[(k + 1) % n_around]], 'Belly')


def blob(mb, centre, radii, bone, mat, rings=5, sides=8, axes=None, band=None):
    """Ellipsoid, outward facing. axes: optional (x, y, z) unit vectors to orient its radii."""
    c = Vector(centre)
    ax = axes or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    grid = []
    for i in range(rings + 1):
        phi = math.pi * i / rings
        row = []
        for k in range(sides):
            th = 2 * math.pi * k / sides
            p = c + ax[0] * radii[0] * math.sin(phi) * math.cos(th) + ax[1] * radii[1] * math.sin(phi) * math.sin(th) \
                + ax[2] * radii[2] * math.cos(phi)
            row.append(mb.vert(p, bone))
        grid.append(row)
    for i in range(rings):
        for k in range(sides):
            k2 = (k + 1) % sides
            uvs = None
            if band:
                a0, a1 = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
                uvs = [leg_uv(band, i / rings, a0), leg_uv(band, (i + 1) / rings, a0),
                       leg_uv(band, (i + 1) / rings, a1), leg_uv(band, i / rings, a1)]
            # From the top pole down, k going counter-clockwise around +z: (i,k),(i+1,k),(i+1,k2),(i,k2)
            # faces outward.
            mb.face([grid[i][k], grid[i + 1][k], grid[i + 1][k2], grid[i][k2]], mat, uvs)


def segment(mb, a, b, hint, bone, widths, band, mat='Shell', sides=8, tip=False):
    """A rigid limb segment from a to b: a tube whose cross-section is an ellipse (half widths w in
    the plane of `hint`'s normal and h along hint), profiled along its length by widths(t) -> (w, h).
    With tip, the far end closes to a point; else both ends are capped (joint balls hide them)."""
    a, b = Vector(a), Vector(b)
    y = (b - a).normalized()
    z = hint - y * hint.dot(y)
    z = z.normalized() if z.length > 1e-6 else Vector((0, 0, 1))
    x = y.cross(z)
    n = 4
    rings = []
    for i in range(n + 1):
        t = i / n
        w, h = widths(t)
        c = a.lerp(b, t)
        rings.append([mb.vert(c + x * w * math.cos(2 * math.pi * k / sides) + z * h * math.sin(2 * math.pi * k / sides), bone)
                      for k in range(sides)])
    for i in range(n):
        for k in range(sides):
            k2 = (k + 1) % sides
            a0, a1 = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
            uvs = [leg_uv(band, i / n, a0), leg_uv(band, i / n, a1), leg_uv(band, (i + 1) / n, a1), leg_uv(band, (i + 1) / n, a0)] \
                if mat == 'Shell' else None
            # Ring k runs x -> z, counter-clockwise looking back down -y, so this order faces out.
            mb.face([rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]], mat, uvs and [uvs[0], uvs[3], uvs[2], uvs[1]])
    end_uv = [leg_uv(band, 0, 0)] * 3 if mat == 'Shell' else None
    c0 = mb.vert(a, bone)
    for k in range(sides):
        mb.face([rings[0][k], rings[0][(k + 1) % sides], c0], mat, end_uv)
    c1 = mb.vert(b + (y * 0.0 if tip else Vector()), bone)
    for k in range(sides):
        mb.face([rings[-1][(k + 1) % sides], rings[-1][k], c1], mat, end_uv)


def build_legs(mb, chains):
    for leg in LEGS:
        names, pts, hint = chains[leg]
        d, side = leg_info(leg)
        scale = d['seg'][0] / 0.0086
        # Merus: broad, flat blade, widest in the middle.
        segment(mb, pts[0], pts[1], hint, names[0],
                lambda t: (0.00075 * scale * (0.8 + 0.3 * math.sin(math.pi * t)), 0.00125 * scale * (0.8 + 0.35 * math.sin(math.pi * t))),
                'leg')
        # Carpus + propodus: narrower, tapering to the ankle.
        segment(mb, pts[1], pts[2], hint, names[1],
                lambda t: (0.00062 * scale * (1 - 0.3 * t), 0.00085 * scale * (1 - 0.25 * t)), 'leg')
        # Dactyl: a pointed, spiny claw with a dark horny tip.
        segment(mb, pts[2], pts[2].lerp(pts[3], 0.7), hint, names[2],
                lambda t: (0.00040 * scale * (1 - 0.45 * t), 0.00052 * scale * (1 - 0.45 * t)), 'leg')
        segment(mb, pts[2].lerp(pts[3], 0.7), pts[3], hint, names[2],
                lambda t: (0.00022 * scale * (1 - t) + 0.00002, 0.00029 * scale * (1 - t) + 0.00002), None,
                mat='Claw tip', sides=8, tip=True)
        # Joint balls, each on the child so it rides with it, and a coxa ball into the body.
        blob(mb, pts[0], (0.00075 * scale,) * 3, names[0], 'Joint')
        blob(mb, pts[1], (0.00070 * scale,) * 3, names[1], 'Joint')
        blob(mb, pts[2], (0.00048 * scale,) * 3, names[2], 'Joint')


def build_claws(mb, chains):
    for side in (1, -1):
        n = 'claw' + side_name(side)
        names, pts, _ = chains[n]
        fn, fpts, _ = chains[n + '_finger']
        up = Vector((0, 0, 1))
        segment(mb, pts[0], pts[1], up, names[0], lambda t: (0.00058, 0.00070 * (0.9 + 0.2 * math.sin(math.pi * t))), 'leg')
        segment(mb, pts[1], pts[2], up, names[1], lambda t: (0.00062 + 0.0002 * t, 0.00070), 'leg')
        # Palm: a plump, slightly flattened oval tapering into the fixed finger.
        segment(mb, pts[2], pts[3], up, names[2],
                lambda t: (0.00120 * math.sin(math.pi * min(1.0, 0.25 + t * 0.85)) ** 0.7 + 0.00012,
                           0.00150 * math.sin(math.pi * min(1.0, 0.25 + t * 0.85)) ** 0.7 + 0.00012), 'claw')
        # Movable finger (dactyl), white-tipped.
        segment(mb, fpts[0], fpts[1], up, fn[0], lambda t: (0.00045 * (1 - 0.8 * t) + 0.00005, 0.00042 * (1 - 0.8 * t) + 0.00005),
                'finger', tip=True)
        blob(mb, pts[0], (0.00075,) * 3, names[0], 'Joint')
        blob(mb, pts[1], (0.00070,) * 3, names[1], 'Joint')
        blob(mb, pts[2], (0.00078,) * 3, names[2], 'Joint')
        blob(mb, fpts[0], (0.00045,) * 3, fn[0], 'Joint')


def build_eyes(mb, chains):
    for side in (1, -1):
        e = 'eye' + side_name(side)
        names, pts, _ = chains[e]
        segment(mb, pts[0], pts[1], Vector((0, -1, 0)), e, lambda t: (0.00050, 0.00050), None, mat='Stalk', sides=8)
        d = (pts[1] - pts[0]).normalized()
        c = pts[1] + d * 0.0002
        blob(mb, c, (0.00062, 0.00062, 0.00072), e, 'Eye', 6, 10)
        blob(mb, pts[0], (0.0006,) * 3, e, 'Stalk')
        # A catch-light on the front of each eye.
        fwd = Vector((side * 0.3, -1, 0.4)).normalized()
        blob(mb, c + fwd * 0.00054, (0.00015,) * 3, e, 'Shine', 4, 6)
    # Mouthparts: the flat third maxillipeds closing the mouth under the front margin.
    for side in (1, -1):
        blob(mb, (side * 0.0011, -CL * 0.72, BODY_Z - 0.0005), (0.0010, 0.0012, 0.0004), 'body', 'Belly', 5, 10)


def build_mesh(rig, mats, chains):
    mb = MeshBuilder()
    build_carapace(mb)
    build_legs(mb, chains)
    build_claws(mb, chains)
    build_eyes(mb, chains)
    me = bpy.data.meshes.new('CrabMesh')
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
    obj = bpy.data.objects.new('CrabBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones if b.name != 'root'}
    for i, bone in enumerate(mb.weights):
        groups[bone].add([i], 1.0, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj, mb


# ---------------------------------------------------------------------------------------------
# Animation. A pose is: the body's offset and rotation, a foot target per leg, a wrist target,
# palm direction and finger opening per claw, and eye raise/swivel. Limb points are solved,
# turned into armature-space bone matrices, then into bone-local keys.
# ---------------------------------------------------------------------------------------------
class Pose:
    def __init__(self):
        self.body_loc = Vector((0, 0, 0))
        self.body_rot = (0.0, 0.0, 0.0)  # pitch (nose down +), roll (left side down +), yaw (left +)
        self.feet = {}
        self.lift = {}
        self.wrist = {}
        self.palm = {}
        self.open = {1: 0.0, -1: 0.0}
        self.eye_raise = 1.0
        self.eye_swivel = {1: 0.0, -1: 0.0}
        self.root_loc = Vector((0, 0, 0))


def body_matrix(p):
    pitch, roll, yaw = p.body_rot
    rot = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(roll, 4, 'Y') @ Matrix.Rotation(-pitch, 4, 'X')
    pivot = Vector((0, 0, BODY_Z))
    return Matrix.Translation(p.root_loc + p.body_loc + pivot) @ rot @ Matrix.Translation(-pivot)


def pose_matrices(rig, p):
    """Armature-space matrices for every bone in pose p."""
    out = {}
    root_m = Matrix.Translation(p.root_loc) @ rig.data.bones['root'].matrix_local
    out['root'] = root_m
    bm = body_matrix(p)
    out['body'] = bm @ rig.data.bones['body'].matrix_local
    for leg in LEGS:
        d, side = leg_info(leg)
        base = bm @ coxa(leg)
        foot = p.feet.get(leg, rest_foot(leg)) + p.root_loc
        pts = solve_leg(base, foot, d['seg'], (bm.to_3x3() @ leg_out(leg)), DACTYL_TILT + p.lift.get(leg, 0.0),
                        leg_sweep(leg), bm.to_3x3() @ Vector((0, 1, 0)))
        hint = leg_hint(pts)
        for i, n in enumerate([leg + '_a', leg + '_b', leg + '_c']):
            out[n] = bone_matrix(pts[i], pts[i + 1], hint)
    r3 = bm.to_3x3()
    for side in (1, -1):
        n = 'claw' + side_name(side)
        # Claw targets are in the body's frame (they move with it).
        pts, fb, ft = claw_points(side, p.wrist.get(side, REST_WRIST[side]), p.palm.get(side, REST_PALM[side]), p.open[side])
        pts = [bm @ q for q in pts]
        fb, ft = bm @ fb, bm @ ft
        up = r3 @ Vector((0, 0, 1))
        for i, b in enumerate([n + '_a', n + '_b', n + '_palm']):
            out[b] = bone_matrix(pts[i], pts[i + 1], up)
        out[n + '_finger'] = bone_matrix(fb, ft, up)
        e = 'eye' + side_name(side)
        ep = [bm @ q for q in eye_points(side, p.eye_raise, p.eye_swivel[side])]
        out[e] = bone_matrix(ep[0], ep[1], r3 @ Vector((0, -1, 0)))
    return out


def local_basis(rig, name, mats):
    """Bone-local basis matrix given armature-space pose matrices of it and its parent."""
    bone = rig.data.bones[name]
    if bone.parent is None:
        return bone.matrix_local.inverted() @ mats[name]
    rest_rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
    return rest_rel.inverted() @ mats[bone.parent.name].inverted() @ mats[name]


def clip(rig, name, frames, pose_fn, step=1, loop=True):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    fs = list(range(0, frames + 1, step))
    if fs[-1] != frames:
        fs.append(frames)
    prev_q = {}
    for f in fs:
        # Loops end on exactly their first pose so they cycle without a pop.
        mats = pose_matrices(rig, pose_fn(0 if (loop and f == frames) else f))
        for pb in rig.pose.bones:
            basis = local_basis(rig, pb.name, mats)
            loc, q, _ = basis.decompose()
            if pb.name in prev_q and prev_q[pb.name].dot(q) < 0:
                q.negate()  # keep quaternion keys on one hemisphere so they interpolate the short way
            prev_q[pb.name] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
            if pb.name in ('root', 'body'):
                pb.location = loc
                pb.keyframe_insert('location', frame=f)
    return act


# Gait: alternating tetrapods (L1 R2 L3 R4, then R1 L2 R3 L4). Walking sideways toward +X (the
# crab's left), the leading legs reach out and pull, the trailing legs push.
TETRA = {'leg1_L': 0.0, 'leg2_R': 0.0, 'leg3_L': 0.0, 'leg4_R': 0.0,
         'leg1_R': 0.5, 'leg2_L': 0.5, 'leg3_R': 0.5, 'leg4_L': 0.5}


def gait_pose(f, frames, stride, duty, lift, direction, crouch=0.0, bob=0.0003):
    p = Pose()
    w = 2 * math.pi * f / frames
    for leg in LEGS:
        # Slight phase lag front to back within each tetrapod looks less mechanical.
        i = int(leg[3]) - 1
        ph = (f / frames + TETRA[leg] + 0.04 * i) % 1.0
        if ph < duty:
            s = lerp(stride, -stride, ph / duty)
            z = 0.0
        else:
            q = (ph - duty) / (1 - duty)
            s = lerp(-stride, stride, smooth(q))
            z = lift * math.sin(math.pi * q) ** 0.7
        foot = rest_foot(leg)
        p.feet[leg] = Vector((foot.x + direction * s, foot.y, z))
    p.body_loc = Vector((0, 0, -crouch + bob * math.cos(4 * math.pi * f / frames)))
    p.body_rot = (0.0, direction * 0.03 * math.sin(2 * w), 0.015 * math.sin(2 * w))
    for side in (1, -1):
        sway = 0.0004 * math.sin(2 * w + side)
        p.wrist[side] = REST_WRIST[side] + Vector((0, 0, sway - crouch * 0.3))
    p.eye_swivel = {1: direction * 0.15, -1: direction * 0.15}
    return p


def idle(rig):
    frames = 240

    def pose(f):
        p = Pose()
        w = 2 * math.pi * f / frames
        p.body_loc = Vector((0, 0, 0.00012 * math.sin(2 * w)))
        p.body_rot = (0.01 * math.sin(w), 0.008 * math.sin(2 * w + 1), 0.0)
        # Eyes swivel independently, now and then flicking down and back up.
        flick = track(f % 120, [(0, 0.0), (70, 0.0), (74, 1.0), (82, 1.0), (90, 0.0)])
        p.eye_raise = 1.0 - 0.6 * flick
        p.eye_swivel = {1: 0.35 * math.sin(w + 0.5), -1: 0.35 * math.sin(w * 2 - 0.9)}
        # The claws twitch a little and the fingers flex.
        for side in (1, -1):
            t = 0.0003 * math.sin(3 * w + side)
            p.wrist[side] = REST_WRIST[side] + Vector((0, t, 0.0002 * math.sin(2 * w + side)))
            p.open[side] = 0.10 + 0.10 * math.sin(4 * w + side * 1.3)
        # One rear foot taps (shifts) mid-way.
        tap = math.sin(math.pi * min(1, max(0, (f - 150) / 16))) if 150 <= f < 166 else 0.0
        p.feet['leg4_R'] = rest_foot('leg4_R') + Vector((0, 0.0004 * tap, 0.0018 * tap))
        return p

    clip(rig, 'idle', frames, pose, step=4)


def gait_clip(rig, name, g, direction, crouch):
    def pose(f):
        return gait_pose(f, g['frames'], g['stride'], g['duty'], g['lift'], direction, crouch)

    clip(rig, name, g['frames'], pose)


def graze(rig):
    """Left and right claws take turns: pinch at the rock in front, scrape back, lift to the mouth
    and pass the food up while the other goes down. The body tips forward over the food."""
    frames = 72

    mouth = {s: Vector((s * 0.0010, -CL - 0.0006, BODY_Z - 0.0004)) for s in (1, -1)}
    ground = {s: Vector((s * 0.0030, -CL - 0.0050, 0.0007)) for s in (1, -1)}

    def pose(f):
        p = Pose()
        p.body_rot = (0.10, 0.0, 0.0)
        p.body_loc = Vector((0, 0.0004, -0.0012))
        for side in (1, -1):
            ph = (f / frames + (0.0 if side > 0 else 0.5)) % 1.0
            if ph < 0.35:  # reach down and pick: a few quick nips
                t = ph / 0.35
                w = ground[side] + Vector((0, 0.0008 * t, 0.0003 * abs(math.sin(t * 3 * math.pi))))
                op = 0.35 * abs(math.sin(t * 3 * math.pi))
                palm = Vector((-side * 0.35, -0.6, -0.85))
            elif ph < 0.6:  # lift to the mouth
                t = smooth((ph - 0.35) / 0.25)
                w = (ground[side] + Vector((0, 0.0008, 0))).lerp(mouth[side], t)
                op = 0.0
                palm = Vector((-side * 0.35, -0.6, -0.85)).lerp(Vector((-side * 0.9, 0.1, 0.25)), t)
            elif ph < 0.8:  # feed: fingers open at the mouthparts
                t = (ph - 0.6) / 0.2
                w = mouth[side]
                op = 0.25 * math.sin(math.pi * t)
                palm = Vector((-side * 0.9, 0.1, 0.25))
            else:  # back down
                t = smooth((ph - 0.8) / 0.2)
                w = mouth[side].lerp(ground[side], t)
                op = 0.3 * t
                palm = Vector((-side * 0.9, 0.1, 0.25)).lerp(Vector((-side * 0.35, -0.6, -0.85)), t)
            # The wrist target is in the body's frame; the body is tipped, so lift the ground point
            # back to where the tipped claw reaches the rock.
            p.wrist[side] = w
            p.palm[side] = palm
            p.open[side] = op
        p.eye_swivel = {1: 0.25 * math.sin(2 * math.pi * f / frames), -1: -0.25 * math.sin(2 * math.pi * f / frames + 1)}
        return p

    clip(rig, 'graze', frames, pose, step=2)


HOP_FRAMES = 54
HOP_TAKEOFF, HOP_LAND = 14, 30  # frames


def hop(rig, name, direction):
    """Crouch, spring sideways (direction +1 to its left, -1 to its right), tuck the legs in the air,
    then absorb the landing. The clip stays in place; the game carries the crab through the air
    between HOP_TAKEOFF and HOP_LAND."""
    frames, T0, T1 = HOP_FRAMES, HOP_TAKEOFF, HOP_LAND

    def pose(f):
        p = Pose()
        crouch = track(f, [(0, 0.0), (T0 - 2, 0.0030), (T0, 0.0), (T1, -0.001), (T1 + 4, 0.0028), (frames, 0.0)])
        p.body_loc = Vector((0, 0, -crouch))
        air = math.sin(math.pi * (f - T0) / (T1 - T0)) if T0 < f < T1 else 0.0
        for leg in LEGS:
            foot = rest_foot(leg)
            if T0 < f < T1:
                # Legs draw in under the body and dangle while airborne.
                c = coxa(leg)
                tuck = Vector((lerp(foot.x, c.x, 0.35), lerp(foot.y, c.y, 0.2), BODY_Z - crouch - 0.004 * air))
                p.feet[leg] = foot.lerp(tuck, air)
                p.lift[leg] = -0.3 * air
            else:
                p.feet[leg] = foot
        p.body_rot = (-0.08 * air, 0.12 * air * direction, 0.0)
        for side in (1, -1):
            p.wrist[side] = REST_WRIST[side] + Vector((0, 0.0012 * air, 0.0014 * air - crouch * 0.4))
        p.eye_raise = 1.0 - 0.4 * air
        return p

    clip(rig, name, frames, pose, step=1, loop=False)


def duck(rig):
    """Startled: drop flat against the rock, legs splayed wide, claws folded under the front and the
    eyestalks laid down into their grooves. Hold the last frame while hiding."""
    frames = 12

    def pose(f):
        u = 1 - (1 - f / frames) ** 2.2
        p = Pose()
        p.body_loc = Vector((0, 0, -0.0042 * u))
        for leg in LEGS:
            foot = rest_foot(leg)
            c = coxa(leg)
            out = Vector((foot.x - c.x, foot.y - c.y, 0))
            p.feet[leg] = foot + out * 0.28 * u
            p.lift[leg] = 0.35 * u
        for side in (1, -1):
            p.wrist[side] = REST_WRIST[side].lerp(Vector((side * 0.0028, -CL - 0.0012, 0.0055)), u)
            p.palm[side] = REST_PALM[side].lerp(Vector((-side * 0.9, 0.15, -0.2)), u)
        p.eye_raise = 1.0 - 1.25 * u
        p.eye_swivel = {1: 0.5 * u, -1: -0.5 * u}
        return p

    clip(rig, 'duck', frames, pose, step=1, loop=False)


def display(rig):
    """Threat or rival display: rise high on straightened legs, tip back, raise both claws wide and
    open; hold with a little sway; settle."""
    frames = 120

    def pose(f):
        u = track(f, [(0, 0.0), (16, 1.0), (96, 1.0), (120, 0.0)])
        sway = 0.02 * math.sin(2 * math.pi * f / 40) * u
        p = Pose()
        p.body_loc = Vector((0, 0, 0.0018 * u))
        p.body_rot = (-0.18 * u, sway, 0.0)
        for leg in LEGS:
            foot = rest_foot(leg)
            c = coxa(leg)
            p.feet[leg] = foot - Vector((foot.x - c.x, foot.y - c.y, 0)) * 0.10 * u
        for side in (1, -1):
            p.wrist[side] = REST_WRIST[side].lerp(Vector((side * 0.0075, -CL - 0.0022, 0.0135)), u)
            p.palm[side] = REST_PALM[side].lerp(Vector((side * 0.15, -0.55, 0.85)), u)
            p.open[side] = 0.5 * u * (0.8 + 0.2 * math.sin(2 * math.pi * f / 20 + side))
        p.eye_swivel = {1: 0.1 * u, -1: -0.1 * u}
        return p

    clip(rig, 'display', frames, pose, step=2, loop=False)


def build_animations(rig):
    idle(rig)
    gait_clip(rig, 'walk_left', WALK, 1, 0.0)
    gait_clip(rig, 'walk_right', WALK, -1, 0.0)
    gait_clip(rig, 'run_left', RUN, 1, 0.0012)
    gait_clip(rig, 'run_right', RUN, -1, 0.0012)
    graze(rig)
    hop(rig, 'hop_left', 1)
    hop(rig, 'hop_right', -1)
    duck(rig)
    display(rig)
    for act in bpy.data.actions:
        tr = rig.animation_data.nla_tracks.new()
        tr.name = act.name
        strip = tr.strips.new(act.name, int(act.frame_range[0]), act)
        strip.name = act.name
    rig.animation_data.action = None


def export(rig):
    rig['gait_speed'] = CRAB_GAIT_SPEED
    rig['run_speed'] = CRAB_RUN_SPEED
    rig['carapace_half_extents'] = [CW, CL]
    rig['body_height'] = BODY_Z
    rig['hop_takeoff'] = HOP_TAKEOFF / FPS
    rig['hop_land'] = HOP_LAND / FPS
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT), export_format='GLB', export_yup=True, export_apply=False,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True, export_morph=False,
        export_materials='EXPORT', export_texcoords=True, export_image_format='JPEG', export_jpeg_quality=90,
        export_extras=True, export_def_bones=False)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes; walk', round(CRAB_GAIT_SPEED, 4),
          'm/s, run', round(CRAB_RUN_SPEED, 4), 'm/s')


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    mats = make_materials()
    rig = build_armature()
    chains = rest_chains()
    build_mesh(rig, mats, chains)
    build_animations(rig)
    export(rig)


if __name__ == '__main__':
    main()

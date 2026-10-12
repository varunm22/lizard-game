"""Generate a lava heron (Butorides sundevalli), the Galapagos' own small heron -> src/assets/heron.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/heron.py [out.glb]

Real size, like the iguana it hunts (the juvenile lizard is ~0.19 m): about 0.36 m from bill tip to
tail tip with the neck drawn in, standing about 0.25 m tall hunched and 0.3 m with the neck up. Slate
grey all over with a faint green-blue sheen on the back and wings, the wing coverts edged paler, a
short shaggy crest, a long dark dagger bill, yellow eyes and yellow-orange legs. Lava herons stand
hunched and still at the water's edge or on mangrove roots, walk slowly crouched with the neck
stretched, then stab with a lightning lunge of the neck: the game does all of that (src/lagoon/herons.ts).

Conventions (Blender space, Z up, exported Y up): the heron faces -Y (+Z in glTF), +X is its left,
standing with its toes on z = 0, the middle of its body over the origin. There are no clips: the
game poses every bone itself, so they are all unparented and the game places each directly:

- `body`: the body, tail and folded wings, rigid.
- `neck_0`..`neck_4`: joints along the neck from the shoulders to the back of the head; each neck
  vertex is shared by the two joints either side of it.
- `head`: head, crest, eyes and bill, rigid.
- `tibia_L/R` (joint at the hip, inside the body), `tarsus_L/R` (joint at the backward-bending
  ankle), `foot_L/R` (joint where the toes spread).

Extras on the armature, in glTF space (Y up, +Z forward): `joints` (each bone's joint, by name),
`bill_tip` (the tip of the bill), `eye` (the left eye), `neck_length` (along the neck's joints),
`bill_length` (head joint to bill tip), `body_height` (the body's centre above the ground at rest).
"""

import math
import os
import sys

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import check_winding, lerp, srgb  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(HERE, '..', 'src', 'assets', 'heron.glb')

COLORS = {
    'Slate': srgb('#3f464d'),
    'Back': srgb('#353d40'),
    'Sheen': srgb('#3a4744'),
    'Edge': srgb('#7d8279'),
    'Throat': srgb('#6d6a62'),
    'Belly': srgb('#4a5056'),
    'Cap': srgb('#23282c'),
    'Bill': srgb('#1f2022'),
    'BillBase': srgb('#5c5a48'),
    'Eye': srgb('#e6c43a'),
    'Pupil': srgb('#0c0c0c'),
    'Legs': srgb('#d39a35'),
    'Claws': srgb('#2a2622'),
}

# ---------------------------------------------------------------------------------------------
# Shape (Blender space, metres).
# ---------------------------------------------------------------------------------------------
BODY_Z = 0.125
# Body loft along Y (forward is -Y): (y, half width, half height, centre z).
LOFT = [
    (-0.078, 0.004, 0.005, 0.1430),
    (-0.070, 0.014, 0.016, 0.1410),
    (-0.055, 0.025, 0.028, 0.1350),
    (-0.030, 0.033, 0.036, 0.1280),
    (0.000, 0.035, 0.036, 0.1240),
    (0.030, 0.031, 0.030, 0.1260),
    (0.058, 0.022, 0.019, 0.1310),
    (0.080, 0.012, 0.010, 0.1350),
    (0.092, 0.003, 0.003, 0.1370),
]
# The neck from the shoulders to the back of the head, drawn up in a short S.
NECK = [(0, -0.060, 0.1510), (0, -0.074, 0.1780), (0, -0.088, 0.2010), (0, -0.101, 0.2180), (0, -0.112, 0.2290)]
NECK_R = [0.018, 0.0145, 0.0125, 0.0115, 0.011]
HEAD = Vector((0, -0.112, 0.2290))
HEAD_C = Vector((0, -0.124, 0.2330))
HEAD_R = (0.0125, 0.020, 0.0135)
EYE = Vector((0.0098, -0.131, 0.2380))
EYE_R = 0.0033
# The bill: a straight dagger from the gape to the tip, a little down-pointing.
BILL = [(0, -0.136, 0.2325), (0, -0.152, 0.2310), (0, -0.170, 0.2295), (0, -0.186, 0.2275), (0, -0.196, 0.2260)]
BILL_R = [(0.0050, 0.0060), (0.0038, 0.0046), (0.0026, 0.0032), (0.0014, 0.0018), (0.0003, 0.0004)]
# Legs (left; the right mirrors): the hip inside the body, the ankle behind the knee line, the foot.
HIP = Vector((0.016, 0.004, 0.105))
ANKLE = Vector((0.017, 0.012, 0.056))
FOOT = Vector((0.016, 0.000, 0.006))
TOES = [(-0.55, 0.040), (0.0, 0.046), (0.55, 0.038)]  # splay from straight ahead (radians), length
HALLUX = 0.020
TOE_R = 0.0021
SIDES = {'_L': 1, '_R': -1}


class MeshBuilder:
    def __init__(self):
        self.verts, self.weights, self.faces, self.face_mats = [], [], [], []
        self.mark = 0

    def vert(self, co, weights):
        self.verts.append(Vector(co))
        self.weights.append(weights)
        return len(self.verts) - 1

    def face(self, idx, mat):
        self.faces.append(list(idx))
        self.face_mats.append(mat)

    def begin(self):
        self.mark = len(self.faces)

    def end(self):
        """A piece is closed: turn its faces outward if they came out inside-out."""
        vol = 0.0
        for f in self.faces[self.mark:]:
            vs = [self.verts[i] for i in f]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6
        if vol < 0:
            for i in range(self.mark, len(self.faces)):
                self.faces[i].reverse()


def loft_at(y):
    pts = LOFT
    if y <= pts[0][0]:
        return pts[0][1:]
    for a, b in zip(pts, pts[1:]):
        if y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            return tuple(lerp(p, q, t) for p, q in zip(a[1:], b[1:]))
    return pts[-1][1:]


def body_mat(co, k, sides):
    """Which plumage a body face shows: darker sheen on the back, the folded wings' pale-edged
    coverts in rows along the flanks, a paler belly."""
    a = 2 * math.pi * k / sides  # 0 = top, pi = belly
    up = math.cos(a)
    if up < -0.55:
        return 'Belly'
    if up > 0.6:
        return 'Sheen' if co.y > -0.03 else 'Back'
    if co.y > -0.045 and up > -0.3:
        # Wing coverts: pale fringes in bands along the folded wing.
        band = (co.y + 0.045) / 0.012
        return 'Edge' if (band % 1.0) < 0.22 and co.y < 0.06 else 'Back'
    return 'Slate'


def build_body(mb):
    mb.begin()
    sides = 14
    rings = []
    ys = [LOFT[0][0] + (LOFT[-1][0] - LOFT[0][0]) * i / 22 for i in range(23)]
    for y in ys:
        w, h, cz = loft_at(y)
        rings.append([mb.vert((w * math.sin(2 * math.pi * k / sides), y, cz + h * math.cos(2 * math.pi * k / sides)), {'body': 1.0}) for k in range(sides)])
    front = mb.vert((0, LOFT[0][0] - 0.002, LOFT[0][3]), {'body': 1.0})
    back = mb.vert((0, LOFT[-1][0] + 0.002, LOFT[-1][3]), {'body': 1.0})
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face([front, rings[0][k2], rings[0][k]], 'Slate')
        mb.face([back, rings[-1][k], rings[-1][k2]], 'Slate')
    for i in range(len(rings) - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            c = (mb.verts[rings[i][k]] + mb.verts[rings[i + 1][k2]]) / 2
            mb.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], body_mat(c, k + 0.5, sides))
    mb.end()


def blob(mb, centre, radii, weights, mat, rings=6, sides=10):
    mb.begin()
    cx, cy, cz = centre
    rx, ry, rz = radii
    top = mb.vert((cx, cy, cz + rz), weights)
    bottom = mb.vert((cx, cy, cz - rz), weights)
    layers = []
    for i in range(1, rings):
        th = math.pi * i / rings
        layers.append([mb.vert((cx + rx * math.sin(th) * math.cos(2 * math.pi * k / sides),
                                cy + ry * math.sin(th) * math.sin(2 * math.pi * k / sides),
                                cz + rz * math.cos(th)), weights) for k in range(sides)])
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face([top, layers[0][k], layers[0][k2]], mat(Vector(centre), 1) if callable(mat) else mat)
        mb.face([bottom, layers[-1][k2], layers[-1][k]], mat(Vector(centre), -1) if callable(mat) else mat)
        for a, b in zip(layers, layers[1:]):
            mb.face([a[k], b[k], b[k2], a[k2]], mat(Vector(centre), 0) if callable(mat) else mat)
    mb.end()


def tube(mb, path, radii, weights_at, mat, sides=8):
    """A closed tube through `path`; radii are (across, up) pairs or single numbers."""
    mb.begin()
    rings = []
    n = len(path)
    for i, (c, r) in enumerate(zip(path, radii)):
        c = Vector(c)
        axis = (Vector(path[min(i + 1, n - 1)]) - Vector(path[max(i - 1, 0)])).normalized()
        side = axis.cross(Vector((0, 0, 1)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(axis).normalized()
        rx, rz = (r, r) if not isinstance(r, tuple) else r
        rings.append([mb.vert(c + rx * math.cos(2 * math.pi * k / sides) * side + rz * math.sin(2 * math.pi * k / sides) * up,
                              weights_at(i / (n - 1))) for k in range(sides)])
    for i in range(n - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            mb.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat)
    start = mb.vert(path[0], weights_at(0.0))
    end = mb.vert(path[-1], weights_at(1.0))
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face([rings[0][k2], rings[0][k], start], mat)
        mb.face([rings[-1][k], rings[-1][k2], end], mat)
    mb.end()


def neck_arcs():
    arcs = [0.0]
    for a, b in zip(NECK, NECK[1:]):
        arcs.append(arcs[-1] + (Vector(b) - Vector(a)).length)
    return arcs


def neck_weights(s):
    arcs = neck_arcs()
    if s <= 0:
        return {'neck_0': 1.0}
    for i in range(len(arcs) - 1):
        if s <= arcs[i + 1]:
            t = (s - arcs[i]) / (arcs[i + 1] - arcs[i])
            return {f'neck_{i}': 1 - t, f'neck_{i + 1}': t}
    return {f'neck_{len(arcs) - 1}': 1.0}


def build_neck(mb):
    """The neck: a tube along a smooth curve through the joints, starting inside the chest and
    ending inside the head; a paler streaked throat down its front."""
    mb.begin()
    arcs = neck_arcs()
    sides = 12
    steps = 16
    # Run the curve a little into the chest so the joint stays covered as the neck bends.
    pts = [Vector(NECK[0]) + Vector((0, 0.012, -0.012))] + [Vector(p) for p in NECK] + [HEAD + Vector((0, -0.006, 0.002))]
    ss = [-0.017] + arcs + [arcs[-1] + 0.006]
    rr = [0.020] + NECK_R + [NECK_R[-1] * 0.95]
    rings = []
    for j in range(steps + 1):
        u = j / steps * (len(pts) - 1)
        i = min(int(u), len(pts) - 2)
        t = u - i
        c = pts[i].lerp(pts[i + 1], t)
        s = lerp(ss[i], ss[i + 1], t)
        r = lerp(rr[i], rr[i + 1], t)
        axis = (pts[i + 1] - pts[i]).normalized()
        side = Vector((1, 0, 0))
        up = side.cross(axis).normalized()
        w = neck_weights(s)
        if s < 0:
            w = {'body': min(1.0, -s / 0.017), 'neck_0': 1 - min(1.0, -s / 0.017)}
        rings.append((s, [mb.vert(c + r * (math.cos(2 * math.pi * k / sides) * side + math.sin(2 * math.pi * k / sides) * up * 1.05), w) for k in range(sides)]))
    for (sa, ra), (sb, rb) in zip(rings, rings[1:]):
        for k in range(sides):
            k2 = (k + 1) % sides
            a = 2 * math.pi * (k + 0.5) / sides
            # -up is the front of the neck (it leans forward): the pale throat stripe runs there.
            front = math.sin(a) < -0.7
            mat = 'Throat' if front and sa > 0.004 else ('Cap' if math.sin(a) > 0.75 and sa > arcs[-1] - 0.01 else 'Slate')
            mb.face([ra[k], ra[k2], rb[k2], rb[k]], mat)
    first = mb.vert(pts[0], {'body': 1.0})
    last = mb.vert(pts[-1], {'head': 1.0})
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face([rings[0][1][k2], rings[0][1][k], first], 'Slate')
        mb.face([rings[-1][1][k], rings[-1][1][k2], last], 'Slate')
    mb.end()


def build_head(mb):
    h = {'head': 1.0}
    blob(mb, HEAD_C, HEAD_R, h, lambda c, zone: 'Cap' if zone > 0 else 'Slate', rings=7, sides=12)
    # Dark cap down to the eyes, lengthening into a short shaggy crest over the nape.
    for k, (dx, dz, ln) in enumerate([(0.0, 0.0, 0.034), (0.004, -0.002, 0.028), (-0.004, -0.002, 0.028), (0.0, -0.004, 0.024)]):
        start = HEAD_C + Vector((dx, 0.004, 0.010 + dz))
        mid = start + Vector((dx * 0.4, ln * 0.55, 0.002))
        tip = start + Vector((dx * 0.8, ln, -0.006))
        tube(mb, [start, mid, tip], [0.0045, 0.0032, 0.0008], lambda t: h, 'Cap', sides=6)
    # The bill: upper part dark, a paler base where it meets the face.
    tube(mb, BILL, BILL_R, lambda t: h, 'Bill', sides=8)
    tube(mb, [BILL[0], Vector(BILL[0]) + Vector((0, 0.008, 0.001)), Vector(BILL[0]) + Vector((0, 0.015, 0.002))],
         [(0.0058, 0.0066), (0.0062, 0.0068), (0.004, 0.004)], lambda t: h, 'BillBase', sides=8)
    for s in (1, -1):
        e = Vector((EYE.x * s, EYE.y, EYE.z))
        blob(mb, e, (EYE_R * 0.7, EYE_R, EYE_R), h, 'Eye', rings=5, sides=8)
        blob(mb, e + Vector((0.0018 * s, -0.0003, 0.0002)), (EYE_R * 0.32, EYE_R * 0.42, EYE_R * 0.42), h, 'Pupil', rings=4, sides=6)


def build_tail(mb):
    """A short square tail under the wing tips, and the wing tips crossed over it."""
    mb.begin()
    w = {'body': 1.0}
    top, bot = [], []
    for y, hw, z in [(0.060, 0.016, 0.129), (0.085, 0.019, 0.126), (0.112, 0.020, 0.121), (0.124, 0.019, 0.119)]:
        top.append((mb.vert((-hw, y, z + 0.0025), w), mb.vert((hw, y, z + 0.0025), w)))
        bot.append((mb.vert((-hw, y, z - 0.0025), w), mb.vert((hw, y, z - 0.0025), w)))
    for (a, b), (c, d) in zip(top, top[1:]):
        mb.face([a, b, d, c], 'Back')
    for (a, b), (c, d) in zip(bot, bot[1:]):
        mb.face([a, c, d, b], 'Slate')
    for (ta, tb), (ba, bb), (tc, td), (bc, bd) in zip(top, bot, top[1:], bot[1:]):
        mb.face([ta, tc, bc, ba], 'Slate')
        mb.face([tb, bb, bd, td], 'Slate')
    mb.face([top[0][0], bot[0][0], bot[0][1], top[0][1]], 'Slate')
    mb.face([top[-1][0], top[-1][1], bot[-1][1], bot[-1][0]], 'Slate')
    mb.end()
    for s in (1, -1):
        # The folded primaries: long flat blades from the flank back over the tail, crossing.
        path = [(s * 0.030, -0.005, 0.133), (s * 0.026, 0.040, 0.137), (s * 0.012, 0.085, 0.135), (-s * 0.004, 0.112, 0.132)]
        tube(mb, path, [(0.004, 0.014), (0.004, 0.013), (0.003, 0.010), (0.001, 0.003)], lambda t: w, 'Back', sides=8)


def leg_weights(s, part):
    return lambda t: {f'{part}{s}': 1.0}


def build_legs(mb):
    for suffix, s in SIDES.items():
        hip = Vector((HIP.x * s, HIP.y, HIP.z))
        ankle = Vector((ANKLE.x * s, ANKLE.y, ANKLE.z))
        foot = Vector((FOOT.x * s, FOOT.y, FOOT.z))
        # Feathered thigh blending into the bare yellow tibia, which meets the tarsus at the ankle.
        mid = hip.lerp(ankle, 0.45)
        tube(mb, [hip, mid], [0.010, 0.0065], lambda t: {f'tibia{suffix}': 1.0}, 'Slate', sides=8)
        tube(mb, [mid - (ankle - hip).normalized() * 0.004, ankle], [0.0042, 0.0036], lambda t: {f'tibia{suffix}': 1.0}, 'Legs', sides=7)
        blob(mb, ankle, (0.0042, 0.0042, 0.0045), {f'tibia{suffix}': 0.5, f'tarsus{suffix}': 0.5}, 'Legs', rings=4, sides=7)
        tube(mb, [ankle, foot.lerp(ankle, 0.5), foot], [0.0034, 0.0032, 0.0031], lambda t: {f'tarsus{suffix}': 1.0}, 'Legs', sides=7)
        fw = {f'foot{suffix}': 1.0}
        blob(mb, foot, (0.0040, 0.0040, 0.0032), fw, 'Legs', rings=4, sides=7)
        for ang, ln in TOES:
            d = Vector((math.sin(ang) * s, -math.cos(ang), 0))
            pts = [foot + d * 0.002 + Vector((0, 0, -0.002)), foot + d * ln * 0.5 + Vector((0, 0, -0.0035)), foot + d * ln + Vector((0, 0, -0.0042))]
            tube(mb, pts, [TOE_R * 1.1, TOE_R, TOE_R * 0.7], lambda t: fw, 'Legs', sides=6)
            tube(mb, [pts[-1] - d * 0.002, pts[-1] + d * 0.0035 + Vector((0, 0, -0.0008))], [TOE_R * 0.6, 0.0003], lambda t: fw, 'Claws', sides=5)
        back = Vector((0, 1, 0))
        tube(mb, [foot + Vector((0, 0, -0.002)), foot + back * HALLUX + Vector((0, 0, -0.0042))], [TOE_R, TOE_R * 0.7], lambda t: fw, 'Legs', sides=6)


def build_mesh(rig, mats):
    mb = MeshBuilder()
    build_body(mb)
    build_neck(mb)
    build_head(mb)
    build_tail(mb)
    build_legs(mb)
    me = bpy.data.meshes.new('HeronMesh')
    me.from_pydata([tuple(v) for v in mb.verts], [], mb.faces)
    names = list(COLORS)
    for n in names:
        me.materials.append(mats[n])
    for poly, mat in zip(me.polygons, mb.face_mats):
        poly.material_index = names.index(mat)
        poly.use_smooth = True
    me.validate()
    me.update()
    check_winding(me)
    obj = bpy.data.objects.new('HeronBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones}
    for i, ws in enumerate(mb.weights):
        for bone, w in ws.items():
            if w > 1e-4:
                groups[bone].add([i], w, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


def joints():
    out = {'body': Vector((0, 0, BODY_Z)), 'head': HEAD}
    for i, p in enumerate(NECK):
        out[f'neck_{i}'] = Vector(p)
    for suffix, s in SIDES.items():
        out[f'tibia{suffix}'] = Vector((HIP.x * s, HIP.y, HIP.z))
        out[f'tarsus{suffix}'] = Vector((ANKLE.x * s, ANKLE.y, ANKLE.z))
        out[f'foot{suffix}'] = Vector((FOOT.x * s, FOOT.y, FOOT.z))
    return out


def build_armature():
    data = bpy.data.armatures.new('HeronRig')
    rig = bpy.data.objects.new('Heron', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, p in joints().items():
        b = data.edit_bones.new(name)
        b.head = p
        b.tail = p + Vector((0, 0, 0.01))
        b.roll = 0.0
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def make_materials():
    mats = {}
    for name, rgb in COLORS.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = 0.8
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        mats[name] = m
    return mats


def gltf(v):
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def export(rig):
    js = joints()
    rig['joints'] = {k: gltf(v) for k, v in js.items()}
    rig['bill_tip'] = gltf(Vector(BILL[-1]))
    rig['eye'] = gltf(EYE)
    rig['neck_length'] = round(neck_arcs()[-1], 5)
    rig['bill_length'] = round((Vector(BILL[-1]) - HEAD).length, 5)
    rig['body_height'] = BODY_Z
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT), export_format='GLB', export_yup=True, export_apply=False,
        export_animations=False, export_skins=True, export_morph=False,
        export_materials='EXPORT', export_texcoords=False, export_extras=True, export_def_bones=False)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = make_materials()
    rig = build_armature()
    build_mesh(rig, mats)
    export(rig)


if __name__ == '__main__':
    main()

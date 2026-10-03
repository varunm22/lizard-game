"""Generate the player lizard: low-poly toon mesh, armature and animation clips -> src/assets/lizard.glb.

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/lizard.py

Conventions (Blender space, Z up): the lizard faces -Y, which the glTF exporter turns into +Z forward,
Y up. Units are metres; the lizard is ~0.15 m from snout to tail tip and its feet rest on z = 0.
"""

import math
import os

import bpy
from mathutils import Vector

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'lizard.glb')
FPS = 30

# ---------------------------------------------------------------------------------------------
# Shape. Body cross-sections along the spine: (y, half_width, half_height, centre_z).
# Snout at -Y, tail tip at +Y. Big head and short body keep it cute.
# ---------------------------------------------------------------------------------------------
PROFILE = [
    (-0.064, 0.0014, 0.0012, 0.0080),
    (-0.061, 0.0055, 0.0040, 0.0084),
    (-0.056, 0.0085, 0.0058, 0.0090),
    (-0.048, 0.0104, 0.0070, 0.0096),
    (-0.040, 0.0098, 0.0066, 0.0094),
    (-0.033, 0.0066, 0.0050, 0.0086),
    (-0.025, 0.0084, 0.0058, 0.0082),
    (-0.012, 0.0104, 0.0064, 0.0080),
    (0.000, 0.0104, 0.0064, 0.0078),
    (0.010, 0.0086, 0.0056, 0.0076),
    (0.020, 0.0058, 0.0044, 0.0072),
    (0.035, 0.0040, 0.0034, 0.0064),
    (0.055, 0.0027, 0.0025, 0.0054),
    (0.075, 0.0015, 0.0015, 0.0044),
    (0.092, 0.0004, 0.0004, 0.0036),
]
RING = 14  # vertices around each cross-section
STEPS = 48  # cross-sections along the body

SHOULDER_Y, HIP_Y = -0.022, 0.010
LEG_ATTACH_X, LEG_ATTACH_Z = 0.0080, 0.0068

def srgb(hex_colour):
    """'#rrggbb' as linear RGB, which is what glTF base colours are."""
    return tuple(((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5))


COLORS = {
    'Skin': srgb('#35a884'),
    'Belly': srgb('#f3dfa0'),
    'Spots': srgb('#1f7259'),
    'Eye': srgb('#151a1c'),
    'Shine': srgb('#ffffff'),
}

# Spine bones in order from snout to tail tip, used both to build the armature and to skin the body.
SPINE = [
    ('head', -0.064, -0.036, None),
    ('neck', -0.036, -0.022, None),
    ('chest', -0.022, -0.004, None),
    ('hips', -0.004, 0.012, None),
    ('tail1', 0.012, 0.032, None),
    ('tail2', 0.032, 0.052, None),
    ('tail3', 0.052, 0.072, None),
    ('tail4', 0.072, 0.092, None),
]


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


def make_materials():
    mats = {}
    for name, rgb in COLORS.items():
        m = bpy.data.materials.new(name)
        m.diffuse_color = (*rgb, 1.0)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.8
        mats[name] = m
    return mats


# ---------------------------------------------------------------------------------------------
# Mesh building. Everything is one mesh so it skins to one armature; parts are tagged with a
# `part` so the skinning step knows which bone owns them.
# ---------------------------------------------------------------------------------------------
class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.face_mats, self.vert_part = [], [], [], []

    def add_vert(self, co, part):
        self.verts.append(Vector(co))
        self.vert_part.append(part)
        return len(self.verts) - 1

    def add_face(self, idx, mat):
        self.faces.append(idx)
        self.face_mats.append(mat)


def build_body(mb):
    rings = []
    y0, y1 = PROFILE[0][0], PROFILE[-1][0]
    for i in range(STEPS):
        y = lerp(y0, y1, i / (STEPS - 1))
        hw, hh, cz = profile_at(y)
        ring = []
        for k in range(RING):
            a = 2 * math.pi * k / RING
            s, c = math.sin(a), math.cos(a)
            # Flatter belly than back: squash the lower half.
            z = cz + hh * c * (1.0 if c > 0 else 0.7)
            ring.append(mb.add_vert((hw * s, y, z), ('spine', y)))
        rings.append(ring)

    for i in range(STEPS - 1):
        y = lerp(y0, y1, (i + 0.5) / (STEPS - 1))
        for k in range(RING):
            a = 2 * math.pi * (k + 0.5) / RING
            belly = math.cos(a) < -0.45
            # Darker spots on the back: a few bands on the body and rings down the tail.
            spot = math.cos(a) > 0.5 and (
                (-0.02 < y < 0.012 and int((y + 0.1) / 0.008) % 2 == 0 and abs(math.sin(a)) > 0.15)
                or (y > 0.03 and int(y / 0.012) % 2 == 1)
            )
            mat = 'Belly' if belly else 'Spots' if spot else 'Skin'
            k2 = (k + 1) % RING
            mb.add_face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat)

    # Close the snout and the tail tip with fans.
    for ring, y, flip in ((rings[0], y0 - 0.001, True), (rings[-1], y1 + 0.0005, False)):
        cz = profile_at(y0 if flip else y1)[2]
        tip = mb.add_vert((0, y, cz), ('spine', y))
        for k in range(RING):
            k2 = (k + 1) % RING
            face = [ring[k], tip, ring[k2]] if flip else [ring[k2], tip, ring[k]]
            mb.add_face(face, 'Skin')


def tube(mb, a, b, r0, r1, part_a, part_b, mat, sides=8):
    """A tapered tube from a to b. Returns the end ring indices."""
    a, b = Vector(a), Vector(b)
    axis = (b - a).normalized()
    side = axis.cross(Vector((0, 0, 1)))
    if side.length < 1e-6:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(axis).normalized()
    rings = []
    for t, r, part in ((0.0, r0, part_a), (0.5, lerp(r0, r1, 0.5), part_b), (1.0, r1, part_b)):
        c = a.lerp(b, t)
        rings.append([
            mb.add_vert(c + r * (math.cos(2 * math.pi * k / sides) * side + math.sin(2 * math.pi * k / sides) * up), part)
            for k in range(sides)
        ])
    for i in range(2):
        for k in range(sides):
            k2 = (k + 1) % sides
            mb.add_face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat)
    return rings


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


def leg_points(side, front):
    """Shoulder/hip, elbow/knee and foot positions for one leg. side = +1 (left, +X) or -1."""
    y = SHOULDER_Y if front else HIP_Y
    reach = -0.004 if front else 0.004  # front feet plant ahead of the shoulder, hind feet behind the hip
    root = (side * LEG_ATTACH_X, y, LEG_ATTACH_Z)
    knee = (side * 0.0170, y + reach * 0.3, 0.0092)
    foot = (side * 0.0205, y + reach, 0.0016)
    return root, knee, foot


def leg_name(side, front):
    return ('front' if front else 'hind') + ('_L' if side > 0 else '_R')


def build_legs(mb):
    for front in (True, False):
        for side in (1, -1):
            n = leg_name(side, front)
            root, knee, foot = leg_points(side, front)
            r = 0.0024 if front else 0.0028
            tube(mb, root, knee, r, r * 0.85, ('bone', 'upper_' + n), ('bone', 'upper_' + n), 'Skin')
            tube(mb, knee, foot, r * 0.85, r * 0.7, ('bone', 'lower_' + n), ('bone', 'lower_' + n), 'Skin')
            # A flat, wide foot pad, splayed slightly outward.
            fx, fy, fz = foot
            blob(mb, (fx + side * 0.0015, fy - 0.0012, 0.0012), (0.0032, 0.0034, 0.0011), ('bone', 'lower_' + n), 'Skin')


def build_eyes(mb):
    for side in (1, -1):
        c = (side * 0.0074, -0.050, 0.0128)
        blob(mb, c, (0.0036, 0.0036, 0.0036), ('bone', 'head'), 'Eye')
        blob(mb, (c[0] + side * 0.0016, c[1] - 0.0020, c[2] + 0.0016), (0.0011, 0.0011, 0.0011), ('bone', 'head'), 'Shine', 4, 6)


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
    for poly, mat in zip(me.polygons, mb.face_mats):
        poly.material_index = names.index(mat)
        poly.use_smooth = True
    me.validate()
    me.update()

    obj = bpy.data.objects.new('LizardBody', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones if b.name != 'root'}
    for i, part in enumerate(mb.vert_part):
        kind, val = part
        weights = skin_weights(val) if kind == 'spine' else {val: 1.0}
        for bone, w in weights.items():
            groups[bone].add([i], w, 'REPLACE')
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    return obj


# ---------------------------------------------------------------------------------------------
# Animation. Spine, tail and head are posed directly (rotation_mode XYZ, bone-local): with roll 0
# a spine bone's local Z is world up, so Z rotation bends it sideways and X pitches it.
# Grounded clips place the feet with IK targets on the ground and bake the result to plain keys,
# so planted feet never slide or sink. Airborne clips pose the legs directly.
# ---------------------------------------------------------------------------------------------
LEGS = [leg_name(s, f) for f in (True, False) for s in (1, -1)]
TAIL = ['tail1', 'tail2', 'tail3', 'tail4']

# Gait timing. Body speed at playback rate 1 = 2 * stride / (half the cycle). The game scales
# playback rate by (ground speed / these speeds) so feet don't skate; keep LIZARD_GAIT_SPEED in
# src/player/lizardModel.ts in sync.
WALK = dict(frames=12, stride=0.009, lift=0.0035)  # 0.4 s cycle -> 0.09 m/s
RUN = dict(frames=8, stride=0.012, lift=0.0050)  # 0.267 s cycle -> 0.18 m/s


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


def gait(rig, targets, name, frames, stride, lift, spine_bend, tail_bend, bob):
    """A looping trot: diagonal leg pairs move together while the spine and tail wave side to side."""
    new_action(rig, name)
    phase = {'front_L': 0.0, 'hind_R': 0.0, 'front_R': 0.5, 'hind_L': 0.5}
    for f in range(frames + 1):
        w = 2 * math.pi * f / frames
        rot = {
            # The chest swings toward the side whose front foot is planted furthest forward.
            'chest': (0, 0, -spine_bend * math.cos(w)),
            'hips': (0, 0, spine_bend * 0.6 * math.cos(w)),
            'neck': (0, 0, spine_bend * 0.7 * math.cos(w)),
            'head': (0, 0, spine_bend * 0.3 * math.cos(w)),
        }
        for i, tb in enumerate(TAIL):
            rot[tb] = (0, 0, tail_bend * (1 + 0.3 * i) * math.cos(w - 0.9 * (i + 1)))
        key(rig, f, rot, {'root': (0, bob * abs(math.sin(w)), 0)})  # root's local Y is world up

    def foot_at(leg, f):
        p = (f / frames + phase[leg]) % 1.0
        rest = rest_foot(rig, leg)
        if p < 0.5:  # stance: planted, sliding back under the body from front (-Y) to back
            y = lerp(-stride, stride, p / 0.5)
            z = 0.0
        else:  # swing: lift and reach forward again
            q = (p - 0.5) / 0.5
            y = lerp(stride, -stride, 0.5 - 0.5 * math.cos(math.pi * q))
            z = lift * math.sin(math.pi * q)
        return Vector((rest.x, rest.y + y, rest.z + z))

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


def build_animations(rig):
    targets = setup_ik(rig)
    idle(rig, targets)
    gait(rig, targets, 'walk', spine_bend=0.12, tail_bend=0.12, bob=0.0005, **WALK)
    gait(rig, targets, 'run', spine_bend=0.2, tail_bend=0.18, bob=0.0010, **RUN)
    jump(rig)
    pose_air(rig, 'fall', frames=16, legs_fwd=0.5, tail_up=0.25, head_up=0.15, wiggle=0.15)
    land(rig, targets)
    swim(rig, **SWIM)
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


def export(rig):
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
        export_texcoords=False,
        export_def_bones=False,
    )
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


def main():
    reset_scene()
    mats = make_materials()
    rig = build_armature()
    build_mesh(rig, mats)
    build_animations(rig)
    export(rig)


if __name__ == '__main__':
    main()

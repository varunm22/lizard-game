"""Shared math, color and Blender helpers; species-specific geometry stays in each generator."""


def lerp(a, b, t):
    return a + (b - a) * t


def srgb_lin(c):
    return tuple(v ** 2.2 for v in c)


def leg_name(side, front):
    return ('front' if front else 'hind') + ('_L' if side > 0 else '_R')


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


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


def blur(a, n=2):
    import numpy as np
    for _ in range(n):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
    return a


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


def srgb(hex_colour):
    """'#rrggbb' as linear RGB, which is what glTF vertex colours are."""
    return tuple(((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5))


def make_materials(colors, make_texture):
    import bpy
    mats = {}
    tex = make_texture()
    for name, rgb in colors.items():
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


class MeshBuilder:
    """Vertices with bone weights and faces with material names, built piece by piece; each piece
    is closed and turned outward when it ends (inside-out pieces render see-through in the game)."""

    def __init__(self):
        self.verts, self.weights, self.faces, self.face_mats = [], [], [], []
        self.mark = 0

    def vert(self, co, weights):
        from mathutils import Vector
        self.verts.append(Vector(co))
        self.weights.append(weights)
        return len(self.verts) - 1

    def face(self, idx, mat):
        self.faces.append(list(idx))
        self.face_mats.append(mat)

    def begin(self):
        self.mark = len(self.faces)

    def end(self):
        vol = 0.0
        for f in self.faces[self.mark:]:
            vs = [self.verts[i] for i in f]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6
        if vol < 0:
            for i in range(self.mark, len(self.faces)):
                self.faces[i].reverse()

    def ring_loft(self, rings, mat_at, cap_start=True, cap_end=True):
        """Join rings of vertex indices (each the same length) into a closed tube; mat_at(i, k) names
        the material of the quad between ring i and i + 1 at side k."""
        n = len(rings[0])
        for i in range(len(rings) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                self.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat_at(i, k))
        for ring, rev in ((rings[0], True), (rings[-1], False)):
            if (rev and not cap_start) or (not rev and not cap_end):
                continue
            c = sum((self.verts[v] for v in ring), self.verts[ring[0]] * 0) / n
            ci = self.vert(c, self.weights[ring[0]])
            for k in range(n):
                k2 = (k + 1) % n
                self.face([ring[k2], ring[k], ci] if rev else [ring[k], ring[k2], ci], mat_at(0 if rev else len(rings) - 2, k))


def build_skinned(name, rig, mb, colors, mats):
    """A mesh object from a MeshBuilder, skinned to `rig` by the builder's weights."""
    import bpy
    me = bpy.data.meshes.new(name + 'Mesh')
    me.from_pydata([tuple(v) for v in mb.verts], [], mb.faces)
    names = list(colors)
    for n in names:
        me.materials.append(mats[n])
    for poly, mat in zip(me.polygons, mb.face_mats):
        poly.material_index = names.index(mat)
        poly.use_smooth = True
    me.validate()
    me.update()
    check_winding(me)
    obj = bpy.data.objects.new(name + 'Body', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones}
    for i, ws in enumerate(mb.weights):
        for bone, w in ws.items():
            if w > 1e-4:
                groups[bone].add([i], w, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


def build_free_rig(name, joints):
    """An armature of unparented bones, one at each joint (Blender space), all pointing up: the game
    places every bone itself, from the joints written on the armature (see `gltf_point`)."""
    import bpy
    from mathutils import Vector
    data = bpy.data.armatures.new(name + 'Rig')
    rig = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for bone, p in joints.items():
        b = data.edit_bones.new(bone)
        b.head = p
        b.tail = Vector(p) + Vector((0, 0, 0.01))
        b.roll = 0.0
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def flat_materials(colors, roughness=0.8):
    import bpy
    mats = {}
    for name, rgb in colors.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        mats[name] = m
    return mats


def gltf_point(v):
    """A Blender-space point in glTF space (Y up, +Z forward for a model facing -Y)."""
    return [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


def export_skinned(out, skins=True):
    import os
    import bpy
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(out), export_format='GLB', export_yup=True, export_apply=not skins,
        export_animations=False, export_skins=skins, export_morph=False,
        export_materials='EXPORT', export_texcoords=False, export_extras=True, export_def_bones=False)
    print('wrote', os.path.abspath(out), os.path.getsize(out), 'bytes')

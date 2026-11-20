"""Helpers for the beach stage's creatures (sea lions, penguin, flightless cormorant): one skinned
mesh in flat colours on a "free" rig, whose bones have no parents so the game poses each one
directly in the model's space (src/render/freePose.ts). Species shapes stay in each generator.

Blender space, Z up, the animal facing -Y; the glTF exporter turns that into +Z forward, Y up.
"""

import math
import random

import bpy  # noqa: I001 (bpy has to load before mathutils)
from mathutils import Vector

from common import check_winding, lerp


def gltf_point(v):
    """A Blender-space point in glTF space (+Z forward, Y up)."""
    return [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


def noise3(seed):
    """Smooth value noise in 3D (about -1..1), a sum of a few random plane waves: cheap and seamless."""
    rnd = random.Random(seed)
    waves = [(Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized() * rnd.uniform(0.7, 1.4),
              rnd.uniform(0, 2 * math.pi)) for _ in range(9)]

    def f(p, scale):
        q = Vector(p) / scale
        return sum(math.sin(d.dot(q) + ph) for d, ph in waves) / 3.0
    return f


class Builder:
    """Vertices (each with bone weights), faces with a material name, and closed pieces."""

    def __init__(self):
        self.verts, self.weights, self.faces, self.mats = [], [], [], []

    def vert(self, co, weights):
        self.verts.append(Vector(co))
        total = sum(weights.values())
        self.weights.append({k: v / total for k, v in weights.items() if v > 1e-4})
        return len(self.verts) - 1

    def face(self, idx, mat):
        self.faces.append(list(idx))
        self.mats.append(mat)

    def mark(self):
        return len(self.faces)

    def outward(self, start):
        """Turn the faces since `start` (one closed piece) outward if they face in."""
        vol = 0.0
        ids = {i for f in self.faces[start:] for i in f}
        o = sum((self.verts[i] for i in ids), Vector()) / len(ids)
        for f in self.faces[start:]:
            vs = [self.verts[i] - o for i in f]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1]))
        if vol < 0:
            for i in range(start, len(self.faces)):
                self.faces[i].reverse()

    def loft(self, rings, mat_at, cap_start=None, cap_end=None):
        """Join closed rings (each the same count, going round the same way) into a tube; caps are
        (point, weights) fans closing the ends. `mat_at(i, k)` names each quad's material."""
        n = len(rings[0])
        for i in range(len(rings) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                self.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat_at(i, k))
        if cap_start:
            c = self.vert(*cap_start)
            for k in range(n):
                self.face([rings[0][(k + 1) % n], rings[0][k], c], mat_at(0, k))
        if cap_end:
            c = self.vert(*cap_end)
            for k in range(n):
                self.face([rings[-1][k], rings[-1][(k + 1) % n], c], mat_at(len(rings) - 2, k))

    def ellipsoid(self, centre, radii, weights, mat, rings=6, sides=10, axes=None, wobble=None):
        """A closed ellipsoid, optionally along other axes (x, y, z unit vectors) and wobbled by `wobble(p)`."""
        start = self.mark()
        c = Vector(centre)
        ax = axes or (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        top = self.vert(c + ax[2] * radii[2], weights)
        grid = []
        for i in range(1, rings):
            phi = math.pi * i / rings
            row = []
            for k in range(sides):
                th = 2 * math.pi * k / sides
                d = ax[0] * (radii[0] * math.sin(phi) * math.cos(th)) + ax[1] * (radii[1] * math.sin(phi) * math.sin(th)) + ax[2] * (radii[2] * math.cos(phi))
                if wobble:
                    d *= 1 + wobble(c + d)
                row.append(self.vert(c + d, weights))
            grid.append(row)
        bottom = self.vert(c - ax[2] * radii[2], weights)
        mat_at = mat if callable(mat) else (lambda i, k: mat)
        for k in range(sides):
            self.face([top, grid[0][(k + 1) % sides], grid[0][k]], mat_at(0, k))
        self.loft(grid, lambda i, k: mat_at(i + 1, k))
        for k in range(sides):
            self.face([grid[-1][k], grid[-1][(k + 1) % sides], bottom], mat_at(rings - 1, k))
        self.outward(start)

    def paddle(self, path, widths, thick, weights_at, mat, normal, sides=8, tip_mat=None):
        """A flat, tapered limb (flipper, wing, foot) through `path`, `widths` across and `thick`
        thick, its flat face toward `normal`. Closed with a cap at each end."""
        start = self.mark()
        pts = [Vector(p) for p in path]
        n = len(pts)
        rings = []
        for i, p in enumerate(pts):
            axis = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            across = normal.cross(axis).normalized()
            up = axis.cross(across).normalized()
            w = weights_at(i / (n - 1))
            rings.append([self.vert(p + across * (widths[i] * math.cos(2 * math.pi * k / sides)) + up * (thick[i] * math.sin(2 * math.pi * k / sides)), w)
                          for k in range(sides)])
        m = (lambda i, k: (tip_mat if tip_mat and i >= n - 2 else mat))
        self.loft(rings, m, cap_start=(pts[0], weights_at(0)), cap_end=(pts[-1], weights_at(1)))
        self.outward(start)


def flat_materials(colors, roughness=0.8):
    mats = {}
    for name, rgb in colors.items():
        m = bpy.data.materials.new(name)
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        m.diffuse_color = (*rgb, 1.0)
        mats[name] = m
    return mats


def free_rig(name, bones):
    """An armature whose bones have no parents: `bones` maps a name to (head, tail)."""
    data = bpy.data.armatures.new(name + 'Rig')
    rig = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for bname, (head, tail) in bones.items():
        b = data.edit_bones.new(bname)
        b.head, b.tail = Vector(head), Vector(tail)
        b.roll = 0.0
    bpy.ops.object.mode_set(mode='OBJECT')
    rig['joints'] = {b: gltf_point(h) for b, (h, _) in bones.items()}
    return rig


def skin(name, rig, mb, mats, offset=(0, 0, 0)):
    """The builder's mesh as one smooth-shaded skinned object on `rig`, checked for inside-out pieces."""
    me = bpy.data.meshes.new(name + 'Mesh')
    me.from_pydata([tuple(v + Vector(offset)) for v in mb.verts], [], mb.faces)
    names = list(mats)
    for m in names:
        me.materials.append(mats[m])
    for poly, m in zip(me.polygons, mb.mats):
        poly.material_index = names.index(m)
        poly.use_smooth = True
    me.validate()
    me.update()
    check_winding(me)
    obj = bpy.data.objects.new(name + 'Body', me)
    bpy.context.collection.objects.link(obj)
    obj.parent = rig
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones}
    for i, w in enumerate(mb.weights):
        for bone, x in w.items():
            groups[bone].add([i], x, 'REPLACE')
    obj.modifiers.new('Armature', 'ARMATURE').object = rig
    return obj


def blend(t, stops):
    """Bone weights along a body: `stops` is [(t, bone), ...] in order; between two stops the weight
    passes smoothly from one bone to the next."""
    if t <= stops[0][0]:
        return {stops[0][1]: 1.0}
    for (t0, b0), (t1, b1) in zip(stops, stops[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0)
            u = u * u * (3 - 2 * u)
            return {b0: 1 - u, b1: u} if b0 != b1 else {b0: 1.0}
    return {stops[-1][1]: 1.0}


def export(out):
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_yup=True, export_apply=False, export_animations=False,
        export_skins=True, export_morph=False, export_materials='EXPORT', export_extras=True, export_def_bones=False)


__all__ = ['Builder', 'blend', 'export', 'flat_materials', 'free_rig', 'gltf_point', 'lerp', 'noise3', 'skin']

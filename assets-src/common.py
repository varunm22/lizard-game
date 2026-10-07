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

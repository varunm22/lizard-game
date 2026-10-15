"""Generate the lava tunnels' rock -> src/assets/tunnels.glb, its light -> src/assets/tunnels-light.bin,
and the layout the game reads -> src/assets/tunnels.json.

Run headless with the `bpy` pip package (Blender as a Python module) and scikit-image:

    python3 assets-src/tunnels.py

The tunnels are two floors of lava tubes under a lava field, small enough for a hatchling-sized
lizard: the lower floor's ground is the game's heightfield at y = 0 (FLOOR[0]); the upper floor
is rock at FLOOR[1]. The rock is one mesh, the boundary of a signed distance field (negative in the
air) meshed by marching cubes and decimated: tubes with a flat floor and an arched roof, shafts
through the rock between them (drop holes in the upper floor, the ceiling holes over rubble piles),
skylights up to the surface, and a jameo, a wide collapse open to the sky, at the end. The game
uses the same mesh to draw the rock and as its collider, so what you see is what you stand on.

Coordinates here are the game's (x east, y up, z south), metres. Unlike the other generators this
one builds its mesh in game space and only swaps axes for Blender's Z-up on the way out.

Light is baked into a coarse 3D grid of two channels: `sun` (the sky seen straight up along the
sun's slant, so a skylight throws a slanted patch of sunlight on the floor) and `glow` (light that
has spread through the air from the sunlit cells, dimming with distance round corners). The game
colours the rock and the floor from it and lights the lizard by it.
"""

import json
import math
import os
import sys

import numpy as np
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '..', 'src', 'assets')
OUT_GLB = os.path.join(ASSETS, 'tunnels.glb')
OUT_LIGHT = os.path.join(ASSETS, 'tunnels-light.bin')
OUT_JSON = os.path.join(ASSETS, 'tunnels.json')

# Floors (m): the lower floor is the heightfield, the upper one rock; the lava field on top.
FLOOR = [0.0, 0.42]
TOP = 0.96
# Tube heights on each floor (m) and the default half-width.
HEIGHT = [0.3, 0.32]
HALF = 0.22
# Marching cubes cell (m) and the box it fills; FLOOR[1] falls on a grid plane so that floor is flat.
CELL = 0.03
X0, X1 = -5.0, 5.0
Y0, Y1 = -0.27, TOP + 0.09
# The light grid takes every LIGHT_STRIDE-th cell.
LIGHT_STRIDE = 2
# Where the sun is, from the point it lights (the game's SUN_OFFSET): sunlight slants down along -SUN.
SUN = (2.5, 5.0, 1.7)

# ---------------------------------------------------------------------------------------------
# The layout. Tubes are polylines on a floor (0 lower, 1 upper); `half` overrides HALF. Rooms are
# round chambers. Holes are shafts down through the upper floor into a lower tube: a round `drop`
# hole, or a `gap` that cuts right across a tube (jump it at a run). Ramps are rubble piles in a
# lower tube rising under a hole in its ceiling into an upper alcove: `foot` to `top` (x, z), the
# top flush with the upper floor. Skylights open a room or tube to the sky.

START = {'x': -3.95, 'z': 0.0, 'yaw': math.pi / 2}

TUBES = [
    # Upper floor: from the start east to the first fork.
    {'floor': 1, 'name': 'entry', 'pts': [(-3.9, 0.0), (-2.5, 0.0)]},
    {'floor': 1, 'name': 'entry-side', 'pts': [(-3.2, 0.0), (-3.2, 1.3)]},
    # North from the fork, then east along the gap.
    {'floor': 1, 'name': 'north', 'pts': [(-2.5, 0.0), (-2.5, -1.9), (0.6, -1.9), (1.8, -1.9)]},
    {'floor': 1, 'name': 'north-end', 'pts': [(-2.5, -1.9), (-2.5, -3.3)]},
    # An alcove off the north tube over the gap's rubble pile.
    {'floor': 1, 'name': 'gap-alcove', 'pts': [(-1.7, -1.9), (-1.7, -1.05)]},
    # From the second fork: a dead end ending in a hole, and east and south to the last chamber.
    {'floor': 1, 'name': 'pocket', 'pts': [(1.8, -1.9), (1.8, -3.45)]},
    {'floor': 1, 'name': 'east', 'pts': [(1.8, -1.9), (3.4, -1.9), (3.4, -0.5)]},
    # An alcove off the east tube over the south network's rubble pile.
    {'floor': 1, 'name': 'south-alcove', 'pts': [(1.2, -1.9), (1.2, -0.22)]},
    # South from the first fork to a sunny chamber with a hole in its floor.
    {'floor': 1, 'name': 'south', 'pts': [(-2.5, 0.0), (-2.5, 2.0), (-1.0, 2.0)]},
    # Lower floor: under the gap, back west to its rubble pile.
    {'floor': 0, 'name': 'under-gap', 'pts': [(-0.6, -2.15), (-0.6, -0.7), (-1.7, -0.7), (-1.7, -1.8)]},
    # Under the pocket's hole: east, then south to join the last drop.
    {'floor': 0, 'name': 'under-pocket', 'pts': [(1.8, -3.0), (1.8, -3.45), (2.7, -3.45), (2.7, -1.2), (3.55, -0.3)]},
    # From the last chamber's hole south to the jameo.
    {'floor': 0, 'name': 'last', 'pts': [(3.55, -0.3), (3.55, 1.7), (3.3, 2.6)]},
    # Under the south chamber's hole: east to a fork; north to the rubble pile, south through the flooded stretch.
    {'floor': 0, 'name': 'under-south', 'pts': [(-0.75, 2.2), (0.9, 2.2)]},
    {'floor': 0, 'name': 'south-up', 'pts': [(0.9, 2.2), (1.2, 1.1), (1.2, -1.15)]},
    {'floor': 0, 'name': 'flooded', 'pts': [(0.9, 2.2), (0.9, 3.4), (2.5, 3.4), (3.3, 2.6)]},
]

ROOMS = [
    {'floor': 1, 'name': 'start', 'x': -3.9, 'z': 0.0, 'r': 0.42, 'height': 0.4},
    {'floor': 1, 'name': 'north-end', 'x': -2.5, 'z': -3.35, 'r': 0.36, 'height': 0.38},
    {'floor': 1, 'name': 'south', 'x': -1.0, 'z': 2.0, 'r': 0.42, 'height': 0.4},
    {'floor': 1, 'name': 'last', 'x': 3.4, 'z': -0.45, 'r': 0.42, 'height': 0.4},
    {'floor': 0, 'name': 'jameo', 'x': 3.3, 'z': 2.6, 'r': 0.8, 'height': 0.45},
]

HOLES = [
    # The gap across the north tube, along the tube below it.
    {'kind': 'gap', 'name': 'gap', 'a': (-0.6, -2.2), 'b': (-0.6, -1.6), 'r': 0.1},
    {'kind': 'drop', 'name': 'pocket', 'x': 1.8, 'z': -3.27, 'r': 0.14},
    {'kind': 'drop', 'name': 'south', 'x': -0.72, 'z': 2.2, 'r': 0.13},
    {'kind': 'drop', 'name': 'last', 'x': 3.55, 'z': -0.22, 'r': 0.13},
]

# A rubble pile's steps: STEPS risers of RISER (m, under the controller's 7.5 cm climb) a TREAD apart.
STEPS = 7
RISER = (FLOOR[1] - FLOOR[0]) / STEPS
TREAD = 0.17
RAMPS = [
    {'name': 'gap', 'foot': (-1.7, -0.62), 'dir': (0, -1)},
    {'name': 'south', 'foot': (1.2, 0.02), 'dir': (0, -1)},
]
for _r in RAMPS:
    _r['top'] = (_r['foot'][0] + _r['dir'][0] * STEPS * TREAD, _r['foot'][1] + _r['dir'][1] * STEPS * TREAD)

SKYLIGHTS = [
    {'name': 'start', 'x': -4.0, 'z': 0.06, 'r': 0.22},
    {'name': 'north-end', 'x': -2.5, 'z': -3.4, 'r': 0.18},
    {'name': 'south', 'x': -1.05, 'z': 1.95, 'r': 0.2},
    {'name': 'last', 'x': 3.35, 'z': -0.55, 'r': 0.2},
]
JAMEO = {'x': 3.3, 'z': 2.6, 'r': 0.62}
FINISH = {'x': 3.3, 'z': 2.6, 'r': 0.45}
# The flooded stretch: a dip in the lower floor (centre, radius across and along the tube, bed depth below the water),
# its banks gentle enough to walk in and out.
POOLS = [{'x': 0.9, 'z': 2.85, 'rx': 0.3, 'rz': 0.65, 'depth': 0.065}]

# ---------------------------------------------------------------------------------------------

nx = int(round((X1 - X0) / CELL)) + 1
ny = int(round((Y1 - Y0) / CELL)) + 1
xs = X0 + CELL * np.arange(nx)
ys = Y0 + CELL * np.arange(ny)
zs = xs.copy()
assert abs((FLOOR[1] - Y0) / CELL - round((FLOOR[1] - Y0) / CELL)) < 1e-6


def smin(a, b, k):
    h = np.maximum(k - np.abs(a - b), 0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smoothstep(a, b, t):
    t = np.clip((t - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 32767.5 - 1.0


def vnoise(x, y, z, seed=1):
    """Value noise in [-1, 1] on a unit lattice (broadcast arrays)."""
    x, y, z = np.broadcast_arrays(x, y, z)
    xi, yi, zi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64), np.floor(z).astype(np.int64)
    fx, fy, fz = x - xi, y - yi, z - zi
    ux, uy, uz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    out = 0
    for dx in (0, 1):
        wx = ux if dx else 1 - ux
        for dy in (0, 1):
            wy = uy if dy else 1 - uy
            for dz in (0, 1):
                wz = uz if dz else 1 - uz
                out = out + wx * wy * wz * _hash(xi + dx, yi + dy, zi + dz, seed)
    return out


def box(x0, x1, z0, z1, y0=Y0, y1=Y1):
    """Index slices of the grid covering a box (m)."""
    i0, i1 = max(0, int((x0 - X0) / CELL) - 1), min(nx, int((x1 - X0) / CELL) + 2)
    k0, k1 = max(0, int((z0 - X0) / CELL) - 1), min(nx, int((z1 - X0) / CELL) + 2)
    j0, j1 = max(0, int((y0 - Y0) / CELL) - 1), min(ny, int((y1 - Y0) / CELL) + 2)
    return (slice(i0, i1), slice(j0, j1), slice(k0, k1))


def coords(sl):
    return xs[sl[0]][:, None, None], ys[sl[1]][None, :, None], zs[sl[2]][None, None, :]


def seg_dist(X, Z, a, b):
    ax, az = a
    bx, bz = b
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    t = np.zeros_like(X + Z) if l2 == 0 else np.clip(((X - ax) * dx + (Z - az) * dz) / l2, 0, 1)
    return np.hypot(X - (ax + t * dx), Z - (az + t * dz))


def tube_sdf(X, Y, Z, a, b, floor, half, height):
    """A lava tube's air: an arched roof over a flat floor. Below the floor its walls drop straight
    down (the lower floor's ground is the heightfield, the upper floor is cut flat afterwards)."""
    s = seg_dist(X, Z, a, b)
    v = np.maximum(Y - floor, 0)
    c, h = 0.45 * height, 0.55 * height
    return (np.sqrt((s / half) ** 2 + ((v - c) / h) ** 2) - 1) * min(half, h)


def stamp(F, sl, d, k):
    F[sl] = smin(F[sl], d, k)


def build_field():
    F = [np.full((nx, ny, nx), 1.0, np.float32) for _ in FLOOR]
    for t in TUBES:
        fl = t['floor']
        half = t.get('half', HALF)
        for a, b in zip(t['pts'], t['pts'][1:]):
            sl = box(min(a[0], b[0]) - half - 0.1, max(a[0], b[0]) + half + 0.1,
                     min(a[1], b[1]) - half - 0.1, max(a[1], b[1]) + half + 0.1)
            X, Y, Z = coords(sl)
            stamp(F[fl], sl, tube_sdf(X, Y, Z, a, b, FLOOR[fl], half, HEIGHT[fl]), 0.06)
    for r in ROOMS:
        fl = r['floor']
        sl = box(r['x'] - r['r'] - 0.1, r['x'] + r['r'] + 0.1, r['z'] - r['r'] - 0.1, r['z'] + r['r'] + 0.1)
        X, Y, Z = coords(sl)
        p = (r['x'], r['z'])
        stamp(F[fl], sl, tube_sdf(X, Y, Z, p, p, FLOOR[fl], r['r'], r['height']), 0.1)
    # Rough walls and roofs, the floors left flat.
    sl = (slice(None), slice(None), slice(None))
    X, Y, Z = coords(sl)
    for fl in (0, 1):
        n = vnoise(X / 0.11, Y / 0.11, Z / 0.11, 3 + fl) * 0.6 + vnoise(X / 0.04, Y / 0.04, Z / 0.04, 9 + fl) * 0.25
        mask = smoothstep(0.0, 0.07, Y - FLOOR[fl])
        F[fl] += (0.016 * n * mask).astype(np.float32)
    # The upper floor cut flat; nothing of it below.
    F[1] = np.maximum(F[1], (FLOOR[1] - Y) + 0 * X + 0 * Z)
    G = np.minimum(F[0], F[1])
    del F

    def shaft(d_xz, y0, y1, sl):
        X, Y, Z = coords(sl)
        n = vnoise(X / 0.06, Y / 0.06, Z / 0.06, 21) * 0.008
        return np.maximum(np.maximum(d_xz(X, Z), y0 - Y), Y - y1) + n

    for h in HOLES:
        if h['kind'] == 'gap':
            a, b, r = h['a'], h['b'], h['r']
            sl = box(min(a[0], b[0]) - r - 0.1, max(a[0], b[0]) + r + 0.1, min(a[1], b[1]) - r - 0.1, max(a[1], b[1]) + r + 0.1)
            d = shaft(lambda X, Z: seg_dist(X, Z, a, b) - r, 0.12, FLOOR[1] + 0.12, sl)
        else:
            p, r = (h['x'], h['z']), h['r']
            sl = box(p[0] - r - 0.1, p[0] + r + 0.1, p[1] - r - 0.1, p[1] + r + 0.1)
            d = shaft(lambda X, Z: seg_dist(X, Z, p, p) - r, 0.12, FLOOR[1] + 0.12, sl)
        stamp(G, sl, d, 0.03)
    for rp in RAMPS:
        # The ceiling hole over the pile's upper part.
        f, t = np.array(rp['foot']), np.array(rp['top'])
        a = tuple(f + (t - f) * 0.25)
        b = tuple(t + (t - f) / np.linalg.norm(t - f) * 0.02)
        r = 0.14
        sl = box(min(a[0], b[0]) - r - 0.1, max(a[0], b[0]) + r + 0.1, min(a[1], b[1]) - r - 0.1, max(a[1], b[1]) + r + 0.1)
        stamp(G, sl, shaft(lambda X, Z: seg_dist(X, Z, a, b) - r, 0.12, FLOOR[1] + 0.12, sl), 0.03)
    for s in SKYLIGHTS + [JAMEO]:
        p, r = (s['x'], s['z']), s['r']
        sl = box(p[0] - r - 0.15, p[0] + r + 0.15, p[1] - r - 0.15, p[1] + r + 0.15)
        y0 = FLOOR[1] + 0.2 if s is not JAMEO else FLOOR[0] + 0.2
        stamp(G, sl, shaft(lambda X, Z: seg_dist(X, Z, p, p) - r, y0, Y1 + 1, sl), 0.05)
    # The lava field: air above TOP, the rims rounded.
    X, Y, Z = coords(sl := (slice(None), slice(None), slice(None)))
    G = smin(G, (TOP - Y) + 0 * X + 0 * Z, 0.05).astype(np.float32)
    # Rubble piles: a stair of fallen slabs from the lower floor up to flush with the upper one, each
    # riser low enough for the lizard to scramble up and each tread deep enough to lie on (the body
    # capsule stays level, so it can't stand on a steep slope). The risers wander a little.
    for rp in RAMPS:
        f, t = np.array(rp['foot']), np.array(rp['top'])
        u = (t - f) / np.linalg.norm(t - f)
        sl = box(min(f[0], t[0]) - 0.4, max(f[0], t[0]) + 0.4, min(f[1], t[1]) - 0.4, max(f[1], t[1]) + 0.4)
        X, Y, Z = coords(sl)
        along = (X - f[0]) * u[0] + (Z - f[1]) * u[1]
        side = (X - f[0]) * -u[1] + (Z - f[1]) * u[0]
        end = STEPS * TREAD + 0.3
        for n in range(STEPS):
            wobble = vnoise(side / 0.07, n * 3.1 + 0 * Y, 0 * side, 41) * 0.012
            start = n * TREAD + wobble
            top = FLOOR[0] + (n + 1) * RISER
            # Exact box distance in (along, side, y): along from start to end, |side| < 0.21, y below top.
            qa = np.maximum(start - along, along - end)
            qs = np.abs(side) - 0.21
            qy = np.maximum(Y - top, Y0 - 1 - Y)
            q = np.stack(np.broadcast_arrays(qa, qs, qy))
            d = np.linalg.norm(np.maximum(q, 0), axis=0) + np.minimum(np.max(q, axis=0), 0)
            G[sl] = -smin(-G[sl], d, 0.012)
    return G


def plan(G, path):
    """Top-down picture of both floors' air (at each floor's knee height) and the rubble, for checking."""
    from PIL import Image
    rows = []
    for fl in (0, 1):
        j = int(round((FLOOR[fl] + 0.08 - Y0) / CELL))
        air = G[:, j, :] < 0
        img = np.zeros((nx, nx, 3), np.uint8)
        img[...] = (40, 34, 30)
        img[air] = (200, 190, 160) if fl else (150, 170, 200)
        sky = G[:, ny - 4, :] < 0
        img[sky & air] = (255, 230, 120)
        rows.append(img.transpose(1, 0, 2))
    Image.fromarray(np.concatenate(rows, axis=1)).resize((nx * 4, nx * 2), Image.NEAREST).save(path)


def shift(a, n, axis):
    """`a` moved n cells along an axis, zeros coming in (np.roll would wrap the sky round to the bottom)."""
    out = np.zeros_like(a)
    src = [slice(None)] * a.ndim
    dst = [slice(None)] * a.ndim
    if n > 0:
        src[axis], dst[axis] = slice(0, -n), slice(n, None)
    elif n < 0:
        src[axis], dst[axis] = slice(-n, None), slice(0, n)
    else:
        return a.copy()
    out[tuple(dst)] = a[tuple(src)]
    return out


def bake_light(G):
    """The two light channels on every LIGHT_STRIDE-th cell; see the module notes."""
    air = G[::LIGHT_STRIDE, ::LIGHT_STRIDE, ::LIGHT_STRIDE] < 0.004
    lnx, lny, lnz = air.shape
    step = CELL * LIGHT_STRIDE
    sun = np.zeros(air.shape, np.float32)
    sun[:, -1, :] = air[:, -1, :]
    # Down a layer, the sunlit patch shifts away from the sun by this many cells (each under one).
    sx, sz = -SUN[0] / SUN[1], -SUN[2] / SUN[1]
    for j in range(lny - 2, -1, -1):
        # The layer above, slid away from the sun by a fraction of a cell (bilinear).
        shifted = (1 - abs(sx)) * sun[:, j + 1, :] + abs(sx) * shift(sun[:, j + 1, :], int(np.sign(sx)), 0)
        shifted = (1 - abs(sz)) * shifted + abs(sz) * shift(shifted, int(np.sign(sz)), 1)
        sun[:, j, :] = shifted * air[:, j, :]
    sun = np.clip(sun, 0, 1)
    # Glow: spread from the sunlit air through the air, dimming as it goes.
    glow = sun.copy()
    decay = math.exp(-step / 0.7)
    for _ in range(120):
        n = glow.copy()
        for axis in (0, 1, 2):
            n = np.maximum(n, shift(glow, 1, axis) * decay)
            n = np.maximum(n, shift(glow, -1, axis) * decay)
        glow = np.where(air, n, 0)
    # A cell or two into the rock, so surfaces between cells read the air's light.
    for chan in (sun, glow):
        for _ in range(2):
            n = chan.copy()
            for axis in (0, 1, 2):
                n = np.maximum(n, shift(chan, 1, axis))
                n = np.maximum(n, shift(chan, -1, axis))
            chan[...] = np.where(air, chan, n)
            air = air | (n > 0)
    # Soften the sun patches' edges.
    for _ in range(2):
        sun = (sun * 2 + shift(sun, 1, 0) + shift(sun, -1, 0) + shift(sun, 1, 2) + shift(sun, -1, 2)) / 6
    data = np.stack([np.clip(sun, 0, 1), np.clip(glow, 0, 1)], axis=-1)
    # Stored x fastest, then z, then y: index ((j * lnz) + k) * lnx + i, two bytes per cell.
    out = np.round(data.transpose(1, 2, 0, 3) * 255).astype(np.uint8)
    return out, {'origin': [X0, Y0, X0], 'cell': step, 'size': [lnx, lny, lnz]}


def mesh(G):
    verts, faces, normals, _ = measure.marching_cubes(G, level=0.0, spacing=(CELL, CELL, CELL))
    verts += np.array([X0, Y0, X0])
    # Faces must face the air (where G < 0): flip if the first few disagree with the field's gradient.
    tri = verts[faces]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    centre = tri.mean(axis=1)
    gx, gy, gz = np.gradient(G, CELL)
    idx = np.clip(np.round((centre - np.array([X0, Y0, X0])) / CELL).astype(int), 0, [nx - 1, ny - 1, nx - 1])
    grad = np.stack([g[idx[:, 0], idx[:, 1], idx[:, 2]] for g in (gx, gy, gz)], axis=-1)
    agree = np.sum(np.sum(fn * grad, axis=1) < 0)
    if agree < len(faces) / 2:
        faces = faces[:, ::-1]
    print('marching cubes:', len(verts), 'verts', len(faces), 'faces; facing air', max(agree, len(faces) - agree), '/', len(faces))
    return verts, faces


def export(verts, faces, target_faces):
    import bpy  # noqa: I001
    bpy.ops.wm.read_factory_settings(use_empty=True)
    me = bpy.data.meshes.new('rock')
    # Game space (x, y up, z) to Blender's (x, -z, y); the glTF exporter maps it back.
    bverts = [(float(x), float(-z), float(y)) for x, y, z in verts]
    me.from_pydata(bverts, [], [tuple(int(i) for i in f) for f in faces])
    me.validate()
    me.update()
    ob = bpy.data.objects.new('rock', me)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    mod = ob.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = min(1.0, target_faces / len(faces))
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='decimate')
    for p in ob.data.polygons:
        p.use_smooth = True
    print('decimated to', len(ob.data.polygons), 'faces,', len(ob.data.vertices), 'verts')
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT_GLB),
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_materials='NONE',
        export_texcoords=False,
        export_extras=False,
    )
    print('wrote', os.path.abspath(OUT_GLB), os.path.getsize(OUT_GLB), 'bytes')


def layout(light_meta):
    def xz(p):
        return {'x': p[0], 'z': p[1]}

    return {
        'floors': FLOOR,
        'top': TOP,
        'heights': HEIGHT,
        'start': START,
        'finish': FINISH,
        'jameo': JAMEO,
        'tubes': [{'floor': t['floor'], 'name': t['name'], 'pts': [xz(p) for p in t['pts']], 'half': t.get('half', HALF)} for t in TUBES],
        'rooms': ROOMS,
        'holes': [
            {'kind': h['kind'], 'name': h['name'], 'a': xz(h.get('a', (h.get('x'), h.get('z')))),
             'b': xz(h.get('b', (h.get('x'), h.get('z')))), 'r': h['r']}
            for h in HOLES
        ],
        'ramps': [{'name': r['name'], 'foot': xz(r['foot']), 'top': xz(r['top'])} for r in RAMPS],
        'steps': {'count': STEPS, 'riser': RISER, 'tread': TREAD},
        'skylights': SKYLIGHTS,
        'pools': POOLS,
        'light': light_meta,
    }


def main():
    G = build_field()
    if '--plan' in sys.argv:
        plan(G, sys.argv[sys.argv.index('--plan') + 1])
        return
    light, meta = bake_light(G)
    light.tofile(OUT_LIGHT)
    print('wrote', os.path.abspath(OUT_LIGHT), light.nbytes, 'bytes', meta)
    with open(OUT_JSON, 'w') as f:
        json.dump(layout(meta), f, indent=1)
    verts, faces = mesh(G)
    export(verts, faces, 110_000)


if __name__ == '__main__':
    main()

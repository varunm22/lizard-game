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
Y0, Y1 = -0.3, TOP + 0.09
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
# The flooded stretch: a dip in the lower floor (centre, radius across and along the tube, bed depth below the water),
# its banks gentle enough to walk in and out.
POOLS = [{'x': 0.9, 'z': 2.85, 'rx': 0.3, 'rz': 0.65, 'depth': 0.065}]

# The way out: from the jameo a big tube runs south-east and opens in a sea cliff onto a small cove,
# where the tube's flooded end (the sea pool, see layout.ts) runs out into the sea. The cove's back
# wall is the cliff at z = cove_z(x) (the same curve as `coveZ` in layout.ts); everything south of it
# is open air down to the sea. Across the water to the south lies the outer islet.
MOUTH = {'floor': 0, 'name': 'mouth', 'pts': [(3.3, 2.6), (3.72, 3.3), (3.85, 3.95), (3.8, 4.4)],
         'halves': [0.46, 0.5, 0.6, 0.75], 'heights': [0.46, 0.55, 0.66, 0.75]}
TUBES.append(MOUTH)
FINISH = {'x': 4.48, 'z': 4.32, 'r': 0.24}
ISLET = {'x': 5.2, 'z': 13.4, 'r': 3.9}


def cove_z(x):
    """The cove's cliff line (z, m) at x: south of it is open to the sky. Mirrors `coveZ` in layout.ts."""
    s = lambda a, b, t: np.clip((t - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((t - a) / (b - a), 0, 1))  # noqa: E731
    return 3.95 + 0.08 * np.sin(5.1 * x + 0.7) + 0.05 * np.sin(11.3 * x - 1.2) + 1.6 * s(3.25, 2.55, x) + 1.6 * s(4.55, 5.15, x)


# Barn owls' roosts: a ledge high in the shaft of a skylight, on its shady side (away from the sun),
# where an owl sits by day listening to the tube below.
ROOSTS = []
for _name in ('south', 'last'):
    _sk = next(sk for sk in SKYLIGHTS if sk['name'] == _name)
    _d = np.array([-SUN[0], -SUN[2]]) / math.hypot(SUN[0], SUN[2])
    ROOSTS.append({'name': _name, 'x': round(_sk['x'] + _d[0] * _sk['r'] * 0.8, 3), 'y': FLOOR[1] + 0.15,
                   'z': round(_sk['z'] + _d[1] * _sk['r'] * 0.8, 3), 'dx': round(float(_d[0]), 4), 'dz': round(float(_d[1]), 4)})

# Fallen blocks of roof ("breakdown") on the floors to clamber over, and keep-clear lanes for them:
# the routes the tests walk, the holes, the rubble piles and the start. Each lane is a segment
# (x, z) to (x, z) on a floor, with a radius.
KEEP_CLEAR = [
    (1, (-3.95, 0.0), (-3.6, 0.0), 0.2),
    (1, (-1.8, -1.9), (0.3, -1.9), 0.16),
    (1, (3.4, -0.7), (3.55, -0.2), 0.16),
    (0, (0.9, 2.0), (0.9, 3.7), 0.2),
    (0, (3.55, 1.2), (3.3, 2.7), 0.18),
    (0, (4.3, 3.7), (4.5, 4.4), 0.25),
    (0, (2.5, 3.4), (3.3, 2.6), 0.16),
    (0, (3.3, 2.6), (3.85, 3.4), 0.2),
]

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


def seg_t(X, Z, a, b):
    """Distance from (X, Z) to the segment a-b, how far along it (0 to 1), and the signed distance from its line (+ on the right)."""
    ax, az = a
    bx, bz = b
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    if l2 == 0:
        return np.hypot(X - ax, Z - az), np.zeros_like(X + Z), np.zeros_like(X + Z)
    t = np.clip(((X - ax) * dx + (Z - az) * dz) / l2, 0, 1)
    side = ((X - ax) * dz - (Z - az) * dx) / math.sqrt(l2)
    return np.hypot(X - (ax + t * dx), Z - (az + t * dz)), t, side


def warp(X, Z):
    """Plan-view wander for the tubes' walls (m): real tubes meander and bulge rather than run straight."""
    return X + 0.04 * vnoise(X / 0.55, 0.3, Z / 0.55, 51), Z + 0.04 * vnoise(X / 0.55, 7.1, Z / 0.55, 52)


def tube_sdf(X, Y, Z, a, b, floor, half, height, seed, benches=True):
    """A lava tube's air: an arched roof over a flat floor, its width and height swelling and pinching
    along it, with lava benches here and there along its walls (the shelves a falling lava stream
    leaves as it drains). Below the floor its walls drop straight down (the lower floor's ground is
    the heightfield, the upper floor is cut flat afterwards). `half` and `height` may be pairs, from
    a to b."""
    Xw, Zw = warp(X, Z)
    s, t, side = seg_t(Xw, Zw, a, b)
    if isinstance(half, tuple):
        half = half[0] + (half[1] - half[0]) * t
        height = height[0] + (height[1] - height[0]) * t
    half = half * (1 + 0.2 * vnoise(Xw / 0.5, 0.0, Zw / 0.5, seed))
    height = height * (1 + 0.16 * vnoise(Xw / 0.6, 1.7, Zw / 0.6, seed + 1))
    v = np.maximum(Y - floor, 0)
    c, h = 0.45 * height, 0.55 * height
    d = (np.sqrt((s / half) ** 2 + ((v - c) / h) ** 2) - 1) * np.minimum(half, h)
    if benches:
        for sgn, k in ((1, 7), (-1, 8)):
            w = 0.085 * smoothstep(-0.1, 0.25, vnoise(Xw / 0.42, 3.3, Zw / 0.42, seed + k))
            top = 0.07 + 0.03 * vnoise(Xw / 0.3, 5.1, Zw / 0.3, seed + k + 20) + 0.005 * vnoise(X / 0.04, Y / 0.04, Z / 0.04, 77)
            bench = np.maximum(half - w - sgn * side, (Y - floor) - top)
            d = -smin(-d, bench, 0.012)
    return d


def stamp(F, sl, d, k):
    F[sl] = smin(F[sl], d, k)


def around(th_x, th_z, seed, k=1.3):
    """Smooth noise round a circle, by the direction (th_x, th_z) from its centre: for ragged rims."""
    n = np.hypot(th_x, th_z) + 1e-9
    return vnoise(th_x / n * k + 5, th_z / n * k - 3, 0.5, seed)


def block_sdf(X, Y, Z, b):
    """A fallen slab of roof: a box turned by `yaw`, its top tilted a little, bedded below `bottom`,
    its top edges broken off in chamfers, its faces rough."""
    c, s = math.cos(b['yaw']), math.sin(b['yaw'])
    px, pz = X - b['x'], Z - b['z']
    lx, lz = px * c - pz * s, px * s + pz * c
    top = b['top'] + b['tx'] * lx + b['tz'] * lz
    q = np.stack(np.broadcast_arrays(np.abs(lx) - b['hx'], np.maximum(Y - top, b['bottom'] - Y), np.abs(lz) - b['hz']))
    d = np.linalg.norm(np.maximum(q, 0), axis=0) + np.minimum(np.max(q, axis=0), 0) - 0.004
    # Broken top edges: a chamfer along each side, deeper on some than others.
    for (ax, az), cut in zip(((1, 0), (-1, 0), (0, 1), (0, -1)), b['chips']):
        e = (lx * ax + lz * az) - (b['hx'] if ax else b['hz'])
        d = np.maximum(d, 0.7 * e + 0.7 * (Y - top) + cut)
    return d + 0.004 * vnoise(X / 0.035, Y / 0.035, Z / 0.035, b['seed'])


def lane_clear(fl, x, z, r):
    """Whether a block of radius r at (x, z) on floor fl keeps out of the lanes, holes and rubble piles."""
    for f, a, b, rad in KEEP_CLEAR:
        if f == fl and seg_t(np.array(x), np.array(z), a, b)[0] < rad + r:
            return False
    for h in HOLES:
        a, b = h.get('a', (h.get('x'), h.get('z'))), h.get('b', (h.get('x'), h.get('z')))
        if seg_t(np.array(x), np.array(z), a, b)[0] < h['r'] + r + 0.08:
            return False
    for rp in RAMPS:
        f, t = np.array(rp['foot']), np.array(rp['top'])
        u = (t - f) / np.linalg.norm(t - f)
        if seg_t(np.array(x), np.array(z), tuple(f - u * 0.3), tuple(t + u * 0.25))[0] < 0.26 + r:
            return False
    for p in POOLS:
        if math.hypot((x - p['x']) / (p['rx'] + 0.1), (z - p['z']) / (p['rz'] + 0.1)) < 1.2:
            return False
    return True


def make_blocks():
    """Breakdown along the tubes and in the rooms: mostly low slabs near the walls, a few to climb
    onto in the middle of wide spots, collapse piles in the start chamber and round the jameo."""
    rng = np.random.default_rng(17)
    out = []

    def add(fl, x, z, hx, hz, h, yaw=None, base=None):
        floor = FLOOR[fl] if base is None else base
        b = {'floor': fl, 'x': x, 'z': z, 'hx': hx, 'hz': hz, 'top': floor + h, 'bottom': floor - 0.06,
             'yaw': rng.uniform(0, math.pi) if yaw is None else yaw,
             'tx': rng.uniform(-0.08, 0.08), 'tz': rng.uniform(-0.08, 0.08),
             'chips': list(rng.uniform(-0.004, 0.016, 4)), 'seed': int(rng.integers(100, 999))}
        out.append(b)
        return b

    def fits(fl, x, z, r):
        if not lane_clear(fl, x, z, r):
            return False
        return all(b['floor'] != fl or math.hypot(b['x'] - x, b['z'] - z) > r + math.hypot(b['hx'], b['hz']) - 0.01 for b in out)

    # The owls' ledges, sticking out of the shaft wall into the light.
    for ro in ROOSTS:
        b = add(1, ro['x'] + ro['dx'] * 0.12, ro['z'] + ro['dz'] * 0.12, 0.17, 0.065, 0, yaw=math.atan2(-ro['dz'], ro['dx']), base=ro['y'])
        b.update(bottom=ro['y'] - 0.07, tx=0, tz=0, chips=[0.004, 0.012, 0.006, 0.008])
    # Authored piles first. The start chamber: a slab and a block on it, two steps up.
    add(1, -3.86, -0.27, 0.085, 0.06, 0.05, yaw=0.3)
    add(1, -3.95, -0.33, 0.05, 0.045, 0.1, yaw=0.9)
    add(1, -3.7, 0.3, 0.06, 0.05, 0.04, yaw=1.2)
    # The jameo: a ring of big fallen blocks round its edge, stepping up toward the wall.
    for ang, rr, h in [(-2.6, 0.62, 0.06), (-2.2, 0.7, 0.11), (-1.9, 0.55, 0.05), (2.2, 0.6, 0.055), (2.6, 0.7, 0.1),
                       (0.2, 0.62, 0.05), (0.55, 0.72, 0.1), (-0.5, 0.66, 0.06)]:
        x, z = JAMEO['x'] + rr * math.cos(ang), JAMEO['z'] + rr * math.sin(ang)
        if lane_clear(0, x, z, 0.05):
            add(0, x, z, rng.uniform(0.07, 0.11), rng.uniform(0.05, 0.09), h)
    # Under the skylights: the debris of the collapse that opened them.
    for sk in SKYLIGHTS:
        for _ in range(3):
            ang = rng.uniform(0, 2 * math.pi)
            x, z = sk['x'] + 0.3 * math.cos(ang), sk['z'] + 0.3 * math.sin(ang)
            hx, hz = rng.uniform(0.04, 0.08), rng.uniform(0.035, 0.06)
            if fits(1, x, z, math.hypot(hx, hz)):
                add(1, x, z, hx, hz, rng.uniform(0.025, 0.06))
    # Scattered along every tube, often in little heaps: a slab with smaller pieces against it.
    for t in TUBES:
        fl = t['floor']
        if t['name'] == 'mouth':
            continue
        half = t.get('half', HALF)
        for a, b in zip(t['pts'], t['pts'][1:]):
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            ux, uz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
            for _ in range(int(length / 0.2 + rng.random())):
                u = rng.uniform(0.05, 0.95) * length
                hx, hz = rng.uniform(0.04, 0.11), rng.uniform(0.035, 0.07)
                r = math.hypot(hx, hz)
                mid = rng.random() < 0.3
                off = rng.uniform(-0.06, 0.06) if mid else rng.choice([-1, 1]) * rng.uniform(half - 0.11, half - 0.02)
                x, z = a[0] + ux * u - uz * off, a[1] + uz * u + ux * off
                if not fits(fl, x, z, r):
                    continue
                h = rng.uniform(0.03, 0.06) if mid else rng.uniform(0.025, 0.07)
                add(fl, x, z, hx, hz, h)
                if rng.random() < 0.5:
                    # A smaller piece leaning on it, lower or a step higher toward the wall.
                    ang = rng.uniform(0, 2 * math.pi)
                    x2, z2 = x + 0.8 * r * math.cos(ang), z + 0.8 * r * math.sin(ang)
                    hx2, hz2 = rng.uniform(0.03, 0.06), rng.uniform(0.025, 0.05)
                    if lane_clear(fl, x2, z2, math.hypot(hx2, hz2)):
                        add(fl, x2, z2, hx2, hz2, min(0.12, h + rng.uniform(-0.03, 0.05)))
    return out


def build_field():
    F = [np.full((nx, ny, nx), 1.0, np.float32) for _ in FLOOR]
    for ti, t in enumerate(TUBES):
        fl = t['floor']
        half = t.get('half', HALF)
        pts = t['pts']
        for si, (a, b) in enumerate(zip(pts, pts[1:])):
            if 'halves' in t:
                hw = (t['halves'][si], t['halves'][si + 1])
                ht = (t['heights'][si], t['heights'][si + 1])
                pad = max(hw) * 1.3 + 0.1
            else:
                hw, ht, pad = half, HEIGHT[fl], half * 1.3 + 0.1
            sl = box(min(a[0], b[0]) - pad, max(a[0], b[0]) + pad, min(a[1], b[1]) - pad, max(a[1], b[1]) + pad)
            X, Y, Z = coords(sl)
            stamp(F[fl], sl, tube_sdf(X, Y, Z, a, b, FLOOR[fl], hw, ht, 100 + ti * 10 + si, 'halves' not in t), 0.06)
    for r in ROOMS:
        fl = r['floor']
        sl = box(r['x'] - r['r'] - 0.15, r['x'] + r['r'] + 0.15, r['z'] - r['r'] - 0.15, r['z'] + r['r'] + 0.15)
        X, Y, Z = coords(sl)
        p = (r['x'], r['z'])
        stamp(F[fl], sl, tube_sdf(X, Y, Z, p, p, FLOOR[fl], r['r'], r['height'], 300 + len(r['name']), False), 0.1)
    # Rough walls and roofs: big lumps and hollows, then smaller knobs; the floors left flat.
    sl = (slice(None), slice(None), slice(None))
    X, Y, Z = coords(sl)
    for fl in (0, 1):
        n = (vnoise(X / 0.28, Y / 0.2, Z / 0.28, 13 + fl) * 0.042 + vnoise(X / 0.1, Y / 0.1, Z / 0.1, 3 + fl) * 0.015
             + vnoise(X / 0.04, Y / 0.04, Z / 0.04, 9 + fl) * 0.005)
        mask = smoothstep(0.0, 0.08, Y - FLOOR[fl])
        F[fl] += (n * mask).astype(np.float32)
    # The upper floor cut flat but for shallow sags in the ropy lava; nothing of it below.
    sag = -0.006 * (0.5 + 0.5 * vnoise(X / 0.3, 0.0, Z / 0.3, 31))
    F[1] = np.maximum(F[1], (FLOOR[1] + sag - Y) + 0 * X + 0 * Z)
    G = np.minimum(F[0], F[1])
    del F

    def shaft(d_xz, y0, y1, sl):
        X, Y, Z = coords(sl)
        n = vnoise(X / 0.06, Y / 0.06, Z / 0.06, 21) * 0.01
        return np.maximum(np.maximum(d_xz(X, Y, Z), y0 - Y), Y - y1) + n

    for h in HOLES:
        if h['kind'] == 'gap':
            # A crack across the tube: its rims ragged toward the walls but true where the lizard crosses.
            a, b, r = h['a'], h['b'], h['r']
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            sl = box(min(a[0], b[0]) - r - 0.15, max(a[0], b[0]) + r + 0.15, min(a[1], b[1]) - r - 0.15, max(a[1], b[1]) + r + 0.15)

            def dg(X, Y, Z, a=a, b=b, r=r, mid=mid):
                d, t, side = seg_t(X, Z, a, b)
                ragged = 0.035 * vnoise(Z / 0.06, np.sign(side) * 3 + Y * 0, X * 0, 23) * smoothstep(0.07, 0.16, np.abs(Z - mid[1]))
                return d - r - ragged
            d = shaft(dg, 0.12, FLOOR[1] + 0.12, sl)
        else:
            # A drop hole: a broken, lobed outline, not a circle.
            p, r = (h['x'], h['z']), h['r']
            sl = box(p[0] - 1.4 * r - 0.1, p[0] + 1.4 * r + 0.1, p[1] - 1.4 * r - 0.1, p[1] + 1.4 * r + 0.1)

            def dd(X, Y, Z, p=p, r=r, seed=len(h['name'])):
                dx, dz = X - p[0], Z - p[1]
                rr = r * (1 + 0.3 * around(dx, dz, 40 + seed) + 0.12 * around(dx, dz, 50 + seed, 3.1))
                return np.hypot(dx, dz) - rr
            d = shaft(dd, 0.12, FLOOR[1] + 0.12, sl)
        stamp(G, sl, d, 0.03)
    for rp in RAMPS:
        # The ceiling hole over the pile's upper part.
        f, t = np.array(rp['foot']), np.array(rp['top'])
        a = tuple(f + (t - f) * 0.25)
        b = tuple(t + (t - f) / np.linalg.norm(t - f) * 0.02)
        r = 0.14
        sl = box(min(a[0], b[0]) - r - 0.15, max(a[0], b[0]) + r + 0.15, min(a[1], b[1]) - r - 0.15, max(a[1], b[1]) + r + 0.15)

        def dr(X, Y, Z, a=a, b=b, r=r):
            d, _, side = seg_t(X, Z, a, b)
            return d - r * (1 + 0.25 * vnoise(X / 0.08, side * 0, Z / 0.08, 27))
        stamp(G, sl, shaft(dr, 0.12, FLOOR[1] + 0.12, sl), 0.03)
    for i, s in enumerate(SKYLIGHTS + [JAMEO]):
        # Skylights are collapses: ragged, and opening wider toward the surface.
        p, r = (s['x'], s['z']), s['r']
        sl = box(p[0] - 2 * r - 0.15, p[0] + 2 * r + 0.15, p[1] - 2 * r - 0.15, p[1] + 2 * r + 0.15)
        y0 = FLOOR[1] + 0.2 if s is not JAMEO else FLOOR[0] + 0.2

        def ds(X, Y, Z, p=p, r=r, y0=y0, i=i):
            dx, dz = X - p[0], Z - p[1]
            rr = r * (1 + 0.28 * around(dx, dz, 60 + i) + 0.1 * around(dx, dz, 70 + i, 3.3)) * (1 + 0.45 * smoothstep(y0, TOP + 0.05, Y))
            return np.hypot(dx, dz) - rr
        stamp(G, sl, shaft(ds, y0, Y1 + 1, sl), 0.05)
    # The lava field: air above TOP, the rims rounded.
    X, Y, Z = coords(sl := (slice(None), slice(None), slice(None)))
    G = smin(G, (TOP - Y) + 0 * X + 0 * Z, 0.05).astype(np.float32)
    # The cove: open air south of the cliff line, the cliff overhanging and receding, knobbly and cracked.
    sl = box(2.0, X1, 3.4, X1)
    X, Y, Z = coords(sl)
    cliff = (cove_z(X) - 0.1 * smoothstep(0.1, TOP, Y) + 0.06 * vnoise(X / 0.22, Y / 0.18, Z / 0.22, 61)
             + 0.02 * vnoise(X / 0.07, Y / 0.07, Z / 0.07, 62)) - Z
    stamp(G, sl, cliff.astype(np.float32), 0.08)
    # Rubble piles: a stair of fallen slabs from the lower floor up to flush with the upper one, each
    # riser low enough for the lizard to scramble up and each tread deep enough to lie on (the body
    # capsule stays level, so it can't stand on a steep slope). Each step is two or three slabs side
    # by side, their fronts skewed and broken, their tops a few millimetres apart.
    rng = np.random.default_rng(5)
    for rp in RAMPS:
        f, t = np.array(rp['foot']), np.array(rp['top'])
        u = (t - f) / np.linalg.norm(t - f)
        sl = box(min(f[0], t[0]) - 0.4, max(f[0], t[0]) + 0.4, min(f[1], t[1]) - 0.4, max(f[1], t[1]) + 0.4)
        X, Y, Z = coords(sl)
        along = (X - f[0]) * u[0] + (Z - f[1]) * u[1]
        side = (X - f[0]) * -u[1] + (Z - f[1]) * u[0]
        end = STEPS * TREAD + 0.3
        for n in range(STEPS):
            # Cut where the lizard doesn't walk up the middle: the slabs' seams are off to the sides.
            cuts = sorted(rng.choice([-1, 1]) * rng.uniform(0.06, 0.13, int(rng.integers(1, 3))))
            edges = [-0.22] + list(cuts) + [0.22]
            for e0, e1 in zip(edges, edges[1:]):
                sc = (e0 + e1) / 2
                last = n == STEPS - 1 and e0 <= 0 <= e1
                skew = rng.uniform(-0.15, 0.15)
                start = n * TREAD + rng.uniform(-0.012, 0.012) + (side - sc) * skew
                top = FLOOR[0] + (n + 1) * RISER + (0 if last else rng.uniform(-0.004, 0.003))
                # Exact box distance in (along, side, y): along from start to end, across the slab, y below top.
                qa = np.maximum(start - along, along - end)
                qs = np.abs(side - sc) - (e1 - e0) / 2 - 0.006
                qy = np.maximum(Y - top, Y0 - 1 - Y)
                q = np.stack(np.broadcast_arrays(qa, qs, qy))
                d = np.linalg.norm(np.maximum(q, 0), axis=0) + np.minimum(np.max(q, axis=0), 0)
                # The front's top edge broken off.
                d = np.maximum(d, 0.7 * (start - along) + 0.7 * (Y - top) + rng.uniform(0.003, 0.008))
                d = d + 0.003 * vnoise(X / 0.03, Y / 0.03, Z / 0.03, 80 + n)
                G[sl] = -smin(-G[sl], d, 0.008)
    # Breakdown blocks on the floors.
    for b in BLOCKS:
        r = math.hypot(b['hx'], b['hz']) + 0.05
        sl = box(b['x'] - r, b['x'] + r, b['z'] - r, b['z'] + r, b['bottom'] - 0.05, b['top'] + 0.05)
        X, Y, Z = coords(sl)
        G[sl] = -smin(-G[sl], block_sdf(X, Y, Z, b), 0.01)
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


def occlusion(G, pts, normals):
    """Ambient occlusion at points on the rock (game space), 0 shut in to 1 open: how far the air
    reaches out along each normal, from the field. Darkens the hollows between lumps, under benches and
    round fallen blocks, so the rock's shape reads in the unlit, light-baked look."""
    from scipy.ndimage import map_coordinates
    ao = np.ones(len(pts))
    for d, w in ((0.015, 0.3), (0.035, 0.3), (0.07, 0.25), (0.12, 0.15)):
        q = pts + normals * d
        idx = ((q - np.array([X0, Y0, X0])) / CELL).T
        g = map_coordinates(G, idx, order=1, mode='nearest')
        ao -= w * np.clip((d + g) / d, 0, 1)
    return np.clip(ao, 0, 1)


def export(verts, faces, target_faces, G):
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
    # Occlusion per vertex, in a colour attribute (all three channels): Blender's (x, y, z) is the game's (x, -z, y).
    me = ob.data
    co = np.array([v.co for v in me.vertices])
    nm = np.array([v.normal for v in me.vertices])
    pts = np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1)
    nrm = np.stack([nm[:, 0], nm[:, 2], -nm[:, 1]], axis=1)
    # The mesh faces the air, so the normals point out of the rock.
    ao = occlusion(G, pts, nrm)
    print('occlusion: mean', round(float(ao.mean()), 3), 'min', round(float(ao.min()), 3))
    attr = me.color_attributes.new('ao', 'BYTE_COLOR', 'POINT')
    attr.data.foreach_set('color', np.repeat(ao, 4).astype(np.float32) * np.tile([1, 1, 1, 0], len(ao)) + np.tile([0, 0, 0, 1], len(ao)))
    me.color_attributes.active_color = attr
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT_GLB),
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_materials='NONE',
        export_texcoords=False,
        export_extras=False,
        export_vertex_color='ACTIVE',
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
        'islet': ISLET,
        'roosts': ROOSTS,
        'light': light_meta,
    }


def main():
    global BLOCKS
    BLOCKS = make_blocks()
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
    export(verts, faces, 160_000, G)


if __name__ == '__main__':
    main()

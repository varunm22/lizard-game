"""Generate the mangrove lagoon's own props and animals -> src/assets/lagoon.glb (the lava rocks and
the driftwood come from props.glb, shared with the island).

Run headless with the `bpy` pip package (Blender as a Python module):

    python3 assets-src/lagoon.py

Same conventions as props.py (Blender space, Z up, exported Y up; each object at its real size in
metres, coloured per vertex, standing on z = 0 at the origin). Objects:

- red_mangrove_0/1/2: red mangrove (Rhizophora mangle), the lagoon's edge tree: a trunk standing up
  off the mud on a cage of arching prop roots, under a dark glossy crown. Extras `trunk_radius`,
  `trunk_bottom` and `trunk_height` (the solid trunk), `reach` (how far out the root feet go) and
  `roots`: each prop root as a flat list of points (x, y, z in glTF space, Y up) followed by its
  radius at the top and at the foot, so the game can give every root its own collider.
- sapling: a young red mangrove standing in the shallows on a few roots; extras as above.
- black_mangrove: black mangrove (Avicennia germinans), further back on the mud: a plain trunk
  from the ground, grey-green crown. Extras `trunk_radius`, `trunk_height`. Its breathing roots
  (`pneumatophore`) stick up out of the mud round it, placed by the game by the hundred.
- propagule: the pencil-shaped seedling a red mangrove drops, ~13 cm, found floating and stuck
  upright in the mud.
- shark_pup: a newborn blacktip reef shark pup (Carcharhinus melanopterus), 0.38 m and slim, nose
  along +Z in glTF. Bronze-grey above, white below, black-tipped fins, big eyes. The game sends a
  wave down its body.
- golden_ray: a young golden cownose ray (Rhinoptera steindachneri), 0.24 m across, 0.22 m long with the
  tail; nose along +Z in glTF. The game flaps its wings in a wave and trails its tail.
"""

import math
import os
import random
import sys

import bpy  # noqa: I001 (bpy has to load before bmesh and mathutils)
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import srgb  # noqa: E402
from props import MeshBuilder, blob, make_object, mix, path, tube  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'lagoon.glb')

C = {
    'bark': srgb('#5b4a3c'),
    'bark_light': srgb('#7d6a58'),
    'root': srgb('#806a55'),
    'root_wet': srgb('#3e3428'),
    'barnacle': srgb('#b8b0a0'),
    'leaf': srgb('#2f5a24'),
    'leaf_light': srgb('#5a8a36'),
    'leaf_yellow': srgb('#b8b040'),
    'bm_bark': srgb('#4a4640'),
    'bm_leaf': srgb('#5f7a52'),
    'bm_leaf_light': srgb('#8ca37a'),
    'pneu': srgb('#6e6152'),
    'pneu_tip': srgb('#a39886'),
    'propagule': srgb('#4f6a2a'),
    'propagule_cap': srgb('#7a5a2a'),
    'shark_top': srgb('#5e5747'),
    'shark_belly': srgb('#ece8de'),
    'fin_tip': srgb('#141414'),
    'ray_top': srgb('#c49a4c'),
    'ray_dark': srgb('#8a6a32'),
    'ray_belly': srgb('#f0ece2'),
}


def bezier(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append(p0 * u * u * u + p1 * 3 * u * u * t + p2 * 3 * u * t * t + p3 * t * t * t)
    return out


def gltf(v):
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


def root_colour(co, s):
    # Dark and wet near the mud, a band of barnacle-pale just above, weathered brown higher up.
    z = co[2]
    c = mix(C['root_wet'], C['root'], min(1.0, max(0.0, (z - 0.01) / 0.06)))
    return mix(c, C['barnacle'], 0.35 * max(0.0, 1 - abs(z - 0.035) / 0.015))


def red_mangrove(rng, height, n_roots, reach, crown):
    """Trunk on stilts: roots arch out from the trunk's lower part and from low branches, down into
    the mud all round. The trunk stops at the highest root junction's level below; nothing is under
    it but roots."""
    mb = MeshBuilder()
    roots = []
    bottom = rng.uniform(0.24, 0.3) * height / 1.5
    lean = Vector((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 1)).normalized()
    trunk = path(Vector((0, 0, bottom - 0.02)), lean, height * 0.55, 6, wobble=0.03, rng=rng)
    r0 = 0.034 * height / 1.5
    tube(mb, trunk, lambda s: r0 * (1 - 0.35 * s), lambda co, s: mix(C['bark'], C['bark_light'], 0.3 + 0.3 * noise.noise(Vector(co) * 20)), sides=8)
    for i in range(n_roots):
        a = 2 * math.pi * (i + rng.uniform(-0.35, 0.35)) / n_roots
        out = Vector((math.cos(a), math.sin(a), 0))
        # Most leave the trunk's foot; some come off higher, as drop roots from the stem.
        high = rng.random() < 0.3
        z0 = bottom + (rng.uniform(0.1, 0.35) * height / 1.5 if high else rng.uniform(-0.01, 0.08))
        k = min(len(trunk) - 1, int((z0 - trunk[0].z) / (trunk[-1].z - trunk[0].z) * (len(trunk) - 1)))
        start = Vector((trunk[k].x, trunk[k].y, z0)) + out * r0 * 0.6
        d = reach * rng.uniform(0.55, 1.0)
        foot = out * d + Vector((rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), -0.03))
        # Out first, nearly level or rising a little, then curving down steeply into the mud.
        p1 = start + out * d * 0.45 + Vector((0, 0, rng.uniform(0.0, 0.06)))
        p2 = foot + Vector((0, 0, (z0 + 0.05) * rng.uniform(0.5, 0.8))) - out * d * 0.08
        pts = bezier(start, p1, p2, foot, 6)
        rt, rf = 0.0105 * height / 1.5, 0.0075 * height / 1.5
        tube(mb, pts, lambda s, rt=rt, rf=rf: rt + (rf - rt) * s, root_colour, sides=6)
        roots.append(pts + [rt, rf])
        # Now and then a fork near the foot, a second leg into the mud.
        if rng.random() < 0.35:
            j = 3
            side = Vector((-out.y, out.x, 0)) * rng.choice((-1, 1))
            foot2 = pts[j] + side * 0.07 + out * 0.05
            foot2.z = -0.03
            pts2 = bezier(pts[j], pts[j] + side * 0.03 + out * 0.03, foot2 + Vector((0, 0, pts[j].z * 0.5)), foot2, 4)
            tube(mb, pts2, lambda s, rf=rf: rf * (1 - 0.15 * s), root_colour, sides=5)
            roots.append(pts2 + [rf, rf * 0.85])
    # Branches into a broad crown of glossy leaf clumps.
    top = trunk[-1]
    leaf = lambda c, r: mix(mix(C['leaf'], C['leaf_light'], r * 0.6), C['leaf_yellow'], 0.25 if r > 0.93 else 0.0)
    for i in range(6):
        a = 2 * math.pi * i / 6 + rng.uniform(-0.4, 0.4)
        out = Vector((math.cos(a), math.sin(a), 0))
        start = trunk[rng.randint(4, len(trunk) - 1)]
        br = path(start, out + Vector((0, 0, 0.7)), crown * rng.uniform(0.7, 1.0), 4, bend=out * 0.4 - Vector((0, 0, 0.3)), wobble=0.12, rng=rng)
        tube(mb, br, lambda s: r0 * 0.45 * (1 - 0.6 * s), lambda co, s: C['bark'], sides=5)
        for j in range(4):
            c = br[-1].lerp(br[2], j / 4) + Vector((rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), rng.uniform(0.0, 0.08)))
            sz = crown * rng.uniform(0.2, 0.3)
            blob(mb, c, (sz, sz, sz * 0.6), leaf, rng)
        # A thin aerial root hanging from the branch, not yet reaching the water.
        if rng.random() < 0.5:
            hang = [br[2], br[2] - Vector((0, 0, br[2].z * rng.uniform(0.3, 0.6)))]
            tube(mb, hang, lambda s: 0.004 * (1 - 0.5 * s), lambda co, s: C['root'], sides=4)
    for k in range(16):
        a = rng.uniform(0, 2 * math.pi)
        dd = rng.uniform(0.0, crown * 0.85)
        c = top + Vector((math.cos(a) * dd, math.sin(a) * dd, rng.uniform(0.0, crown * 0.5) - dd * 0.25))
        sz = crown * rng.uniform(0.22, 0.32)
        blob(mb, c, (sz, sz, sz * 0.6), leaf, rng)
    extras = {
        'trunk_radius': round(r0, 4),
        'trunk_bottom': round(bottom, 4),
        'trunk_height': round(trunk[-1].z, 4),
        'reach': round(reach, 4),
        'roots': [[c for p in r[:-2] for c in gltf(p)] + [round(r[-2], 4), round(r[-1], 4)] for r in roots],
    }
    return mb, extras


def black_mangrove(rng):
    mb = MeshBuilder()
    h = 1.3
    trunk = path(Vector((0, 0, -0.02)), Vector((0.03, 0.02, 1)), h * 0.6, 6, wobble=0.04, rng=rng)
    r0 = 0.03
    col = lambda co, s: mix(C['bm_bark'], C['bark_light'], 0.2 + 0.25 * (noise.noise(Vector(co) * 25) * 0.5 + 0.5))
    tube(mb, trunk, lambda s: r0 * (1 - 0.4 * s) + r0 * 0.5 * math.exp(-s * 12), col, sides=8)
    leaf = lambda c, r: mix(C['bm_leaf'], C['bm_leaf_light'], r * 0.7)
    for i in range(5):
        a = 2 * math.pi * i / 5 + rng.uniform(-0.4, 0.4)
        out = Vector((math.cos(a), math.sin(a), 0))
        br = path(trunk[rng.randint(3, 6)], out + Vector((0, 0, 1.2)), 0.4, 4, bend=out * 0.4, wobble=0.1, rng=rng)
        tube(mb, br, lambda s: 0.013 * (1 - 0.6 * s), col, sides=5)
        blob(mb, br[-1], (0.2, 0.2, 0.13), leaf, rng)
    for k in range(7):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.0, 0.3)
        blob(mb, trunk[-1] + Vector((math.cos(a) * d, math.sin(a) * d, rng.uniform(-0.05, 0.25))), (0.2, 0.2, 0.12), leaf, rng)
    return mb, r0, trunk[-1].z


def pneumatophore(rng):
    mb = MeshBuilder()
    h = 0.07
    pts = path(Vector((0, 0, -0.01)), Vector((0.05, 0, 1)), h, 4, wobble=0.05, rng=rng)
    tube(mb, pts, lambda s: 0.0045 * (1 - 0.55 * s), lambda co, s: mix(C['pneu'], C['pneu_tip'], s * s), sides=5)
    return mb


def propagule(rng):
    mb = MeshBuilder()
    pts = path(Vector((0, 0, 0)), Vector((0, 0, 1)), 0.13, 5, bend=Vector((0.15, 0, 0)), rng=rng)
    tube(mb, pts, lambda s: 0.0055 * (0.5 + 0.5 * math.sin(math.pi * (0.15 + 0.85 * s))) + 0.0012, lambda co, s: C['propagule'], sides=6)
    blob(mb, pts[-1] + Vector((0, 0, 0.004)), (0.005, 0.005, 0.007), lambda c, r: C['propagule_cap'], rng, detail=1)
    return mb


def fin(mb, base, tip_up, chord, thick, colour, tip_colour, sweep):
    """A thin triangular fin: base points a (front) and b (back) along the body, tip out along
    `tip_up`, its outer third coloured `tip_colour`."""
    a = base - Vector((0, chord / 2, 0)) * 1
    b = base + Vector((0, chord / 2, 0))
    tip = base + tip_up + Vector((0, sweep, 0))
    n = tip_up.normalized()
    side = n.cross(Vector((0, 1, 0))).normalized() * thick
    # A low wedge: two triangles either side, closed along the edges.
    mid = lambda p, q, t: p.lerp(q, t)
    ca, cb, ct = a, b, tip
    pts_front = [mb.vert(ca + side, colour), mb.vert(ca - side, colour)]
    pts_back = [mb.vert(cb + side, colour), mb.vert(cb - side, colour)]
    ma = mid(ca, ct, 0.62)
    mbk = mid(cb, ct, 0.62)
    m1 = [mb.vert(ma + side * 0.5, tip_colour), mb.vert(ma - side * 0.5, tip_colour)]
    m2 = [mb.vert(mbk + side * 0.5, tip_colour), mb.vert(mbk - side * 0.5, tip_colour)]
    t = mb.vert(ct, tip_colour)
    for s in (0, 1):
        o = (lambda *f: mb.face(*f)) if s == 0 else (lambda *f: mb.face(*reversed(f)))
        o(pts_front[s], pts_back[s], m2[s], m1[s])
        o(m1[s], m2[s], t)
    mb.face(pts_front[0], m1[0], m1[1], pts_front[1])
    mb.face(pts_back[1], m2[1], m2[0], pts_back[0])
    mb.face(m1[0], t, m1[1])
    mb.face(m2[1], t, m2[0])
    mb.face(pts_front[1], pts_back[1], pts_back[0], pts_front[0])


def shark_pup(rng):
    """A newborn pup, slim and supple: fusiform body along -Y (nose first), a short rounded snout,
    big eyes, the first dorsal over the pectorals. Rings every couple of centimetres so the body can
    bend in a smooth wave from head to tail."""
    mb = MeshBuilder()
    L = 0.38
    sides = 12
    # (y from the snout, half width, half height, centre z): about 7.5 times as long as it is deep.
    loft = [(0.0, 0.002, 0.002, 0.0), (0.008, 0.011, 0.008, 0.0), (0.02, 0.017, 0.014, 0.001), (0.04, 0.021, 0.019, 0.002),
            (0.065, 0.024, 0.023, 0.003), (0.095, 0.025, 0.026, 0.003), (0.125, 0.024, 0.026, 0.003), (0.155, 0.022, 0.024, 0.003),
            (0.185, 0.019, 0.021, 0.003), (0.215, 0.016, 0.018, 0.004), (0.245, 0.012, 0.014, 0.005), (0.27, 0.009, 0.011, 0.006),
            (0.29, 0.007, 0.009, 0.007), (0.305, 0.005, 0.007, 0.008), (0.318, 0.003, 0.004, 0.009)]
    rings = []
    for y, w, h, cz in loft:
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            up = math.cos(a)
            co = Vector((w * math.sin(a), y - L / 2, cz + h * up))
            col = mix(C['shark_belly'], C['shark_top'], min(1.0, max(0.0, up * 1.8 + 0.6)))
            ring.append(mb.vert(co, col))
        rings.append(ring)
    nose = mb.vert((0, -L / 2 - 0.001, 0), C['shark_top'])
    tail = mb.vert((0, loft[-1][0] - L / 2 + 0.002, 0.009), C['shark_top'])
    # Wound to face out (the ring runs from the back over to +x).
    for k in range(sides):
        k2 = (k + 1) % sides
        mb.face(nose, rings[0][k2], rings[0][k])
        mb.face(tail, rings[-1][k], rings[-1][k2])
    for ra, rb in zip(rings, rings[1:]):
        for k in range(sides):
            k2 = (k + 1) % sides
            mb.face(ra[k], ra[k2], rb[k2], rb[k])
    y = lambda s: s - L / 2
    # Big dark eyes, a pup's.
    for s in (1, -1):
        blob(mb, Vector((s * 0.0155, y(0.03), 0.007)), (0.0035, 0.0035, 0.0035), lambda c, r: C['fin_tip'], rng)
    # First dorsal, a little behind the pectorals; the second dorsal and the anal fin small, far back.
    fin(mb, Vector((0, y(0.125), 0.025)), Vector((0, 0.02, 0.045)), 0.045, 0.0025, C['shark_top'], C['fin_tip'], 0.014)
    fin(mb, Vector((0, y(0.262), 0.016)), Vector((0, 0.008, 0.014)), 0.02, 0.002, C['shark_top'], C['fin_tip'], 0.004)
    fin(mb, Vector((0, y(0.258), -0.006)), Vector((0, 0.008, -0.013)), 0.017, 0.002, C['shark_top'], C['fin_tip'], 0.004)
    for s in (1, -1):
        fin(mb, Vector((s * 0.018, y(0.085), -0.012)), Vector((s * 0.055, 0.03, -0.022)), 0.04, 0.002, C['shark_top'], C['fin_tip'], 0.02)
        fin(mb, Vector((s * 0.011, y(0.215), -0.012)), Vector((s * 0.02, 0.014, -0.01)), 0.02, 0.0015, C['shark_top'], C['shark_top'], 0.006)
    # The tail: the upper lobe long and swept up, the lower short.
    fin(mb, Vector((0, y(0.322), 0.011)), Vector((0, 0.05, 0.045)), 0.024, 0.002, C['shark_top'], C['fin_tip'], 0.014)
    fin(mb, Vector((0, y(0.315), 0.003)), Vector((0, 0.024, -0.03)), 0.02, 0.002, C['shark_top'], C['fin_tip'], 0.007)
    return mb


def golden_ray(rng):
    """A young ray: a flat diamond disc, wider than long, the head a notched lobe in front, a whip
    tail behind. Built along -Y nose first; wings out along +-X, with columns enough for the wave
    that runs back along each wing as it flaps."""
    mb = MeshBuilder()
    span = 0.12
    length = 0.135
    cols, rows = 18, 10
    top, bot = [], []
    for i in range(rows + 1):
        v = i / rows  # 0 nose, 1 back
        rt, rb = [], []
        for j in range(cols + 1):
            u = j / cols * 2 - 1  # -1 right wingtip, 1 left
            # Outline: the leading edge sweeps back to the tips at ~40% of the length, the trailing
            # edge in toward the tail.
            yfront = -length * 0.45 + abs(u) ** 1.6 * length * 0.48
            yback = length * 0.42 - abs(u) * length * 0.38
            yy = yfront + (yback - yfront) * v
            x = u * span * min(1.0, 0.35 + 0.65 * math.sin(math.pi * (0.1 + 0.8 * v)))
            thick = 0.009 * (1 - abs(u) ** 1.3) * math.sin(math.pi * (0.06 + 0.9 * v)) + 0.001
            co = Vector((x, yy, 0))
            spot = 0.5 + 0.5 * noise.noise(Vector((x * 50, yy * 50, 3)))
            ctop = mix(C['ray_top'], C['ray_dark'], 0.25 * spot + 0.3 * abs(u) ** 2)
            rt.append(mb.vert(co + Vector((0, 0, thick)), ctop))
            rb.append(mb.vert(co - Vector((0, 0, thick * 0.6)), C['ray_belly']))
        top.append(rt)
        bot.append(rb)
    for i in range(rows):
        for j in range(cols):
            mb.face(top[i][j], top[i][j + 1], top[i + 1][j + 1], top[i + 1][j])
            mb.face(bot[i][j], bot[i + 1][j], bot[i + 1][j + 1], bot[i][j + 1])
    # Close the rim.
    for j in range(cols):
        mb.face(top[0][j + 1], top[0][j], bot[0][j], bot[0][j + 1])
        mb.face(top[rows][j], top[rows][j + 1], bot[rows][j + 1], bot[rows][j])
    for i in range(rows):
        mb.face(top[i][0], top[i + 1][0], bot[i + 1][0], bot[i][0])
        mb.face(top[i + 1][cols], top[i][cols], bot[i][cols], bot[i + 1][cols])
    # The cownose head lobe and the eyes on its sides.
    blob(mb, Vector((0, -length * 0.47, 0.003)), (0.017, 0.0145, 0.0078), lambda c, r: C['ray_top'], rng)
    for s in (1, -1):
        blob(mb, Vector((s * 0.0145, -length * 0.42, 0.006)), (0.0024, 0.0024, 0.0024), lambda c, r: C['fin_tip'], rng)
    # Whip tail, in more pieces so it can trail behind a turn.
    tpts = [Vector((0, length * (0.38 + 0.1 * k), 0.003 * (1 - k / 8))) for k in range(9)]
    tube(mb, tpts, lambda s: 0.0027 * (1 - 0.85 * s), lambda co, s: C['ray_dark'], sides=5)
    return mb


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(71)
    mat = bpy.data.materials.new('Prop')
    objects = []
    for i, (h, n, reach, crown) in enumerate(((1.5, 16, 0.42, 0.5), (1.25, 13, 0.36, 0.42), (1.7, 18, 0.48, 0.56))):
        mb, ex = red_mangrove(rng, h, n, reach, crown)
        objects.append(make_object(f'red_mangrove_{i}', mb, mat, extras=ex))
    mb, ex = red_mangrove(rng, 0.42, 6, 0.13, 0.12)
    objects.append(make_object('sapling', mb, mat, extras=ex))
    mb, r, h = black_mangrove(rng)
    objects.append(make_object('black_mangrove', mb, mat, extras={'trunk_radius': r, 'trunk_height': round(h, 4)}))
    objects.append(make_object('pneumatophore', pneumatophore(rng), mat))
    objects.append(make_object('propagule', propagule(rng), mat))
    objects.append(make_object('shark_pup', shark_pup(rng), mat))
    objects.append(make_object('golden_ray', golden_ray(rng), mat))
    for i, obj in enumerate(objects):
        obj.location.x = i * 2.0  # spread out for inspection in Blender; the game ignores placement

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_materials='EXPORT',
        export_vertex_color='ACTIVE',
        export_texcoords=False,
        export_extras=True,
    )
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

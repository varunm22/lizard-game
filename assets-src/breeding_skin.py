"""Paint the marine iguana's breeding colours -> src/assets/iguana-breeding.jpg, a second skin for
the lizard's model (assets-src/lizard.py's texture atlas, same layout), worn by the adult males on
the beach stage. lizard.glb itself is unchanged.

    python3 assets-src/breeding_skin.py

The colours are the Española males' in the breeding season (the "Christmas iguana"), checked
against iNaturalist photos: the flanks, jowls and legs a salmon to brick red, blotched with
black; the spine's crest, the shoulders and the forelegs a pale turquoise green; the head still
grey under its white salt crust; the belly and the end of the tail dark.
"""

import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lizard as L  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'iguana-breeding.jpg')

RED = (0.66, 0.29, 0.29)
PINK = (0.78, 0.45, 0.43)
TEAL = (0.36, 0.62, 0.58)
PALE_TEAL = (0.50, 0.72, 0.68)
BLACK = (0.10, 0.10, 0.11)


def paint_body():
    rows, cols = L.BODY_ROWS[1], L.TEX_W
    t = (np.arange(cols) - 1 + 0.5) / (cols - 2)
    a = (np.arange(rows) - 1 + 0.5) / (rows - 2) * 2 * math.pi
    y0, y1 = L.SNOUT_TIP, L.PROFILE[-1][0]
    yy = np.broadcast_to(L.lerp(y0, y1, t)[None, :], (rows, cols))
    aa = np.broadcast_to(a[:, None], (rows, cols))
    prof = np.array([L.profile_at(max(v, L.PROFILE[0][0])) for v in L.lerp(y0, y1, t)])
    girth = np.broadcast_to((math.pi * (prof[:, 0] + prof[:, 1] * 0.85))[None, :], (rows, cols))
    c = np.cos(aa)
    side = 1 - np.abs(c)

    img = np.broadcast_to(np.asarray(L.PALETTE['skin']), (rows, cols, 3)).copy()
    tone = L.fbm(yy, aa, 1, 0.03, 2)
    img = L.mix(img, L.PALETTE['dark'], L.smoothstep(-0.30, -0.36, tone) * 0.6)
    img = L.mix(img, L.PALETTE['belly'], L.smoothstep(-0.40, -0.46, c) * 0.6)

    # From the jowls back to the hips, and fading down the tail.
    body = L.smoothstep(-0.056, -0.048, yy) * L.smoothstep(0.075, 0.035, yy)
    # Red over the flanks and jowls, pinker in broad washes.
    red = L.smoothstep(-0.6, -0.35, c + 0.25 * L.fbm(yy, aa, 12, 0.02, 3)) * body
    img = L.mix(img, RED, red)
    img = L.mix(img, PINK, red * L.smoothstep(0.1, 0.3, L.fbm(yy, aa, 13, 0.015, 3)) * 0.8)
    # Turquoise along the spine and over the shoulders, ragged where it meets the red.
    teal = L.smoothstep(0.84, 0.92, c + 0.12 * L.fbm(yy, aa, 22, 0.012, 3)) * L.smoothstep(-0.05, -0.03, yy) * L.smoothstep(0.06, 0.02, yy)
    shoulder = np.exp(-((yy + 0.03) / 0.008) ** 2) * L.smoothstep(0.0, 0.2, L.fbm(yy, aa, 23, 0.01, 3) + side * 0.4 - 0.2)
    img = L.mix(img, TEAL, np.clip(teal + shoulder * 0.8, 0, 1) * 0.9)
    # Black blotches all over the colour.
    blot = L.smoothstep(0.35, 0.42, L.fbm(yy, aa, 31, 0.01, 4)) * body
    img = L.mix(img, BLACK, blot * 0.85)
    # Dark down the end of the tail, with faint bands.
    bands = L.smoothstep(0.30, 0.38, np.sin(yy * 2 * math.pi / 0.016 + L.fbm(yy, aa, 33, 0.03, 1) * 0.8))
    img = L.mix(img, L.PALETTE['dark'], bands * L.smoothstep(0.03, 0.06, yy) * 0.5)

    # Scales, as the plain skin has them.
    head = L.smoothstep(-0.044, -0.048, yy)
    fine_edge, _ = L.scales(yy, aa, girth, 0.0010, 52, 41)
    big_edge, _ = L.scales(yy, aa, girth, 0.0019, 26, 42)
    edge = np.where(head > 0.5, big_edge, fine_edge)
    img *= (1 - np.where(head > 0.5, 0.22, 0.10) * edge)[..., None]

    # The head's salt crust and grey, the mouth and nostrils, as on the plain skin.
    salt = L.smoothstep(-0.050, -0.0625, yy) + c * 0.9 + L.fbm(yy, aa, 51, 0.004, 5) * 0.35 - 1.6
    salt *= L.smoothstep(-0.0652, -0.0638, yy)
    img = L.mix(img, L.PALETTE['salt'], L.smoothstep(0.0, 0.06, salt) * head * (c > 0.0))
    mouth_t = L.smoothstep(-0.0657, -0.052, yy)
    mouth_a = 1.90 - 0.18 * mouth_t
    on_mouth = L.smoothstep(0.07, 0.03, np.minimum(np.abs(aa - mouth_a), np.abs(aa - (2 * math.pi - mouth_a))))
    img = L.mix(img, (0.06, 0.06, 0.06), on_mouth * L.smoothstep(-0.0495, -0.0515, yy))
    for na in (1.15, 2 * math.pi - 1.15):
        d = np.hypot((yy + 0.0633) / 0.0004, (aa - na) / 0.10)
        img = L.mix(img, (0.04, 0.04, 0.04), L.smoothstep(1.0, 0.6, d))
    return np.clip(img, 0, 1)


def paint_limbs():
    rows, cols = L.LIMB_ROWS[1], L.LIMB_COLS
    t = (np.arange(cols) - 1 + 0.5) / (cols - 2)
    a = (np.arange(rows) - 1 + 0.5) / (rows - 2) * 2 * math.pi
    yy = np.broadcast_to((t * 0.022)[None, :], (rows, cols))
    aa = np.broadcast_to(a[:, None], (rows, cols))
    girth = np.full((rows, cols), 0.016)
    img = np.broadcast_to(np.asarray(PALE_TEAL), (rows, cols, 3)).copy()
    # Pale turquoise legs mottled with red, black toward the toes.
    img = L.mix(img, RED, L.smoothstep(0.0, 0.1, L.fbm(yy, aa, 62, 0.008, 2) - 0.2) * 0.85)
    img = L.mix(img, BLACK, L.smoothstep(0.3, 0.38, L.fbm(yy, aa, 64, 0.006, 2)) * 0.7)
    img = L.mix(img, L.PALETTE['dark'], L.smoothstep(0.7, 0.92, t) * 0.8)
    edge, _ = L.scales(yy, aa, girth, 0.0009, 16, 63)
    img *= (1 - 0.10 * edge)[..., None]
    return np.clip(img, 0, 1)


def main():
    atlas = np.zeros((L.TEX_H, L.TEX_W, 3))
    atlas[:, :] = L.PALETTE['skin']
    atlas[L.BODY_ROWS[0]:L.BODY_ROWS[0] + L.BODY_ROWS[1], :] = paint_body()
    atlas[L.LIMB_ROWS[0]:L.LIMB_ROWS[0] + L.LIMB_ROWS[1], :L.LIMB_COLS] = paint_limbs()
    # Blender's rows start at the bottom; an image file's at the top. Colours are sRGB values, as
    # the plain skin's are written.
    Image.fromarray((np.flipud(atlas) * 255 + 0.5).astype(np.uint8)).save(OUT, quality=88)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Generate TuneBridge.icns — waveform icon on a dark background.
Usage: python scripts/make_icon.py
Output: static/TuneBridge.icns  (committed to repo so create_app.sh can use it)
"""
import math, os, shutil, subprocess, tempfile
from PIL import Image, ImageDraw

# ── Design constants ──────────────────────────────────────────────────────────
BG      = (15, 15, 25)          # near-black navy
RED1    = (255, 62,  85)        # bright red (centre bars)
RED2    = (180, 30, 55)         # deep red (edge bars)
WHITE   = (255, 255, 255)

# Waveform bar heights as fractions of the available vertical space
# Symmetric, tallest in the middle — classic playback waveform shape
BAR_HEIGHTS = [0.22, 0.38, 0.60, 0.82, 1.00, 0.82, 0.60, 0.38, 0.22]

# iconset entries: (pixel size, filename suffix)
ICONSET = [
    (16,   '16x16'),
    (32,   '16x16@2x'),
    (32,   '32x32'),
    (64,   '32x32@2x'),
    (128,  '128x128'),
    (256,  '128x128@2x'),
    (256,  '256x256'),
    (512,  '256x256@2x'),
    (512,  '512x512'),
    (1024, '512x512@2x'),
]

def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + t * (c2[i] - c1[i])) for i in range(3))

def render(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-rect background (iOS-style ~22% radius)
    r = int(size * 0.22)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG + (255,))

    # Waveform geometry
    n         = len(BAR_HEIGHTS)
    pad       = size * 0.16          # left/right padding
    avail_w   = size - 2 * pad
    avail_h   = size * 0.58          # max bar height
    center_y  = size * 0.52          # slightly below centre (optical balance)
    bar_w     = avail_w / (n * 1.75) # bar width
    step      = avail_w / n          # spacing

    for i, h in enumerate(BAR_HEIGHTS):
        bar_h = avail_h * h
        x0 = pad + i * step + (step - bar_w) / 2
        x1 = x0 + bar_w
        y0 = center_y - bar_h / 2
        y1 = center_y + bar_h / 2
        br = bar_w / 2              # fully rounded bar caps

        # Colour: deep red at edges → bright red at centre
        t = 1 - abs(i - (n - 1) / 2) / ((n - 1) / 2)
        colour = lerp_color(RED2, RED1, t) + (255,)

        draw.rounded_rectangle([x0, y0, x1, y1], radius=br, fill=colour)

    return img

def build_icns(output_path):
    tmpdir   = tempfile.mkdtemp()
    iconset  = os.path.join(tmpdir, 'TuneBridge.iconset')
    os.makedirs(iconset)

    cache = {}
    for px, name in ICONSET:
        if px not in cache:
            cache[px] = render(px)
        cache[px].save(os.path.join(iconset, f'icon_{name}.png'))

    subprocess.run(
        ['iconutil', '-c', 'icns', iconset, '-o', output_path],
        check=True
    )
    shutil.rmtree(tmpdir)
    print(f'  Icon written → {output_path}')

if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'static', 'TuneBridge.icns')
    out = os.path.normpath(out)
    build_icns(out)

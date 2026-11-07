#!/usr/bin/env python3
"""Embed a 38x40, 256-colour terminal raster from the iOS WelcomeLogo.png.

Run with: uv run --with pillow scripts/art/generate-welcome.py /path/to/WelcomeLogo.png
The generated data is embedded in sp-welcome; Pillow is never needed on the pod.
"""
import sys
from pathlib import Path
from PIL import Image

# Crop away the original icon's empty border. Two vertical pixels per terminal
# cell preserve the logo's proportions without doubling the terminal width.
image = Image.open(sys.argv[1]).convert('RGB')
image = image.crop((230, 180, 800, 800))
# Alpha-weight the edge before downsampling, avoiding a dark fringe from the
# source image's black background on light or coloured terminal themes.
image.putalpha(Image.eval(image.convert('HSV').getchannel('V'), lambda v: 255 if v >= 45 else 0))
image = image.resize((38, 40), Image.Resampling.BOX)
levels = [0, 95, 135, 175, 215, 255]
palette = [(r, g, b) for r in levels for g in levels for b in levels]
palette += [(v, v, v) for v in range(8, 239, 10)]
rows = []
for y in range(40):
    row = []
    for x in range(38):
        red, green, blue, alpha = image.getpixel((x, y))
        rgb = (red, green, blue)
        # Remove the image's dark grain instead of painting a black rectangle
        # over the user's terminal background. Keep the blue mattress shading.
        if alpha < 128:
            row.append('-')
        else:
            index = min(range(len(palette)), key=lambda i: sum((a-b)**2 for a, b in zip(rgb, palette[i])))
            row.append(str(index + 16))
    rows.append(' '.join(row))
path = Path(__file__).resolve().parents[1] / 'bin/sp-welcome'
source = path.read_text()
start = source.index("  cat <<'PIXELS'\n") + len("  cat <<'PIXELS'\n")
end = source.index('PIXELS\n', start)
path.write_text(source[:start] + '\n'.join(rows) + '\n' + source[end:])

#!/usr/bin/env python3
"""Embed matching ASCII and 38x40, 256-colour terminal art from the iOS WelcomeLogo.png.

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
# The ASCII fallback uses exactly the same silhouette and orientation as the
# coloured raster. Average only visible pixels, so the crescent edge stays clear.
ascii_rows = []
for y in range(0, 40, 2):
    line = ""
    for x in range(38):
        visible = [image.getpixel((x, yy))[:3] for yy in (y, y + 1)
                   if image.getpixel((x, yy))[3] >= 128]
        if not visible:
            line += " "
            continue
        brightness = sum(0.2126*r + 0.7152*g + 0.0722*b for r, g, b in visible) / len(visible)
        ramp = ".:-=+*#%@"
        line += ramp[min(len(ramp) - 1, int(brightness / 256 * len(ramp)))]
    ascii_rows.append(line.rstrip())
for tag, lines in (("ART", ascii_rows), ("PIXELS", rows)):
    start = source.index("  cat <<'" + tag + "'\n") + len("  cat <<'" + tag + "'\n")
    end = source.index(tag + "\n", start)
    source = source[:start] + "\n".join(lines) + "\n" + source[end:]
path.write_text(source)

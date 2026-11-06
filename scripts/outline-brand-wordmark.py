"""Optional typography regeneration; requires fonttools and brotli.

The checked-in outlined SVG lets normal icon generation run with Node alone.
Geist is licensed under OFL-1.1; see packages/site/assets/licenses/geist.txt.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

root = Path(__file__).resolve().parent.parent
font = TTFont(root / 'packages/site/assets/geist-latin.woff2')
if 'fvar' in font:
    font = instantiateVariableFont(font, {'wght': 600}, inplace=True)
glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
bounds, advance, positioned = BoundsPen(glyphs), 0, []
for character in 'SessionGraph':
    glyph = glyphs[cmap[ord(character)]]
    glyph.draw(TransformPen(bounds, (1, 0, 0, 1, advance, 0)))
    positioned.append((glyph, advance))
    advance += glyph.width - font['head'].unitsPerEm * .025
x0, y0, x1, y1 = bounds.bounds
scale = 420 / (x1 - x0)
pen = SVGPathPen(glyphs, ntos=lambda value: f'{value:.3f}'.rstrip('0').rstrip('.'))
for glyph, x in positioned:
    glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, (x - x0) * scale, y1 * scale)))
height = (y1 - y0) * scale
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 {height:.3f}"><title>SessionGraph — Geist SemiBold</title><g><path d="{pen.getCommands()}"/></g></svg>\n'
destination = root / 'assets/brand/wordmark.svg'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(svg)
print(destination)

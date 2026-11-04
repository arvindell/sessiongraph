import * as gifenc from 'gifenc';
import { gifFrameDelay } from '@sessiongraph/core/playback';

// Vite resolves the ESM build; Node's test runner resolves the CommonJS bundle.
const fallback = gifenc.default;
const { GIFEncoder, quantize } = ('GIFEncoder' in gifenc ? gifenc : fallback) as typeof gifenc;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function mapPalette(rgba: Uint8Array, palette: number[][], width: number) {
  const indices = new Uint8Array(rgba.length / 4), cache = new Map<number, number>();
  const nearest = (r: number, g: number, b: number) => {
    const key = r | (g << 8) | (b << 16), saved = cache.get(key);
    if (saved !== undefined) return saved;
    let best = 0, distance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const color = palette[i], dr = r - color[0], dg = g - color[1], db = b - color[2];
      const error = dr * dr + dg * dg + db * db;
      if (error < distance) { best = i; distance = error; if (!error) break; }
    }
    cache.set(key, best); return best;
  };
  for (let pixel = 0, offset = 0; pixel < indices.length; pixel++, offset += 4) {
    const r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
    let index = nearest(r, g, b);
    const color = palette[index], error = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
    if (Math.max(r, g, b) < 128 && error > 2) {
      // Tiny, spatially fixed shadow dithering softens bands without random
      // frame-to-frame noise. Exact flat colors and bright text stay untouched.
      const noise = (BAYER[((pixel / width | 0) & 3) * 4 + (pixel % width & 3)] - 7.5) / 7.5 * Math.min(3, Math.sqrt(error / 3));
      index = nearest(Math.max(0, Math.min(255, Math.round(r + noise))), Math.max(0, Math.min(255, Math.round(g + noise))), Math.max(0, Math.min(255, Math.round(b + noise))));
    }
    indices[pixel] = index;
  }
  return indices;
}

export function createGifEncoder() {
  const gif = GIFEncoder();
  let frame = 0;
  return {
    add(rgba: Uint8Array, width: number, height: number) {
      if (rgba.length !== width * height * 4) throw new Error('Incomplete GIF frame.');
      const palette = quantize(rgba, 256, { format: 'rgb565' });
      // Full RGB cache keys preserve nearby shadow colors; RGB565 lookup keys
      // incorrectly map whole dark gradients to the first pixel in each bucket.
      gif.writeFrame(mapPalette(rgba, palette, width), width, height, { palette, delay: gifFrameDelay(frame++), repeat: 0, dispose: 1 });
    },
    finish() { gif.finish(); return gif.bytes(); },
  };
}

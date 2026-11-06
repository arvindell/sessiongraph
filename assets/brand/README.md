# Switchback

SessionGraph's mark is a mint S-shaped session trail with three nodes.

- Geometry and canvas rendering: `packages/core/src/brand.ts`.
- Outlined Geist SemiBold wordmark: `assets/brand/wordmark.svg`.
- Transparent mark and lockups: `public/brand/` and `packages/site/assets/brand/`.
- Dark app tile: `brand/icon.svg`; the same tile supplies both favicons and native icons.
- Colors: mint `#b0e9d6`, ink `#080e13`, off-white `#dbe7e3`.

Run `node scripts/generate-brand-assets.mjs` with Node 24+ after changing the
geometry. This regenerates both web copies, ICO and Apple touch icons, and the
full Tauri icon set (macOS, Windows, Linux, iOS, and Android). Generated web and
native assets are checked in; builds need no additional tools or font loading.

Use `mark.svg` next to live text, `lockup.svg` on dark backgrounds,
`lockup-light.svg` on light backgrounds, and `icon.svg` for a square app tile.
`mark-mono.svg` is for single-color/inline uses. Keep the mark's clear space;
do not add glow or stretch it. GIF/MP4 exports draw the same geometry directly
on their canvas so the watermark never depends on an asynchronous image load.

Only when changing typography, run `python3 scripts/outline-brand-wordmark.py`
(requires `fonttools` and `brotli`) before regenerating assets. The wordmark is
outlined from the bundled Geist font, licensed under OFL-1.1; see
`packages/site/assets/licenses/geist.txt`.

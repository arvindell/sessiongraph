# SessionGraph landing page

Static HTML, CSS, and JavaScript. No dependencies or build step.

Production: https://sessiongraph.vercel.app/

## Preview

From this directory, run `python3 -m http.server 5190 --bind 127.0.0.1`.

## Deploy

The Vercel project is `sessiongraph` in the personal workspace `alex-vilchis-projects` (team `team_waeOFlnxtrwvNtf4PhnLFclP`, project `prj_TVLX7DNhTN8703vX0bVwHyNOtR2C`).

The project is connected to `arvindell/sessiongraph` on GitHub, with `site` as its root directory. Push to `main` to publish the landing page; other branches receive preview deployments. Install and build commands are disabled because the site is static.

Only this directory is served. `vercel.json` configures static hosting and response headers. Download links follow the latest desktop release on GitHub. The repository’s existing `main` workflow also creates desktop releases; see [release behavior](../docs/releases.md).

The screenshot and video are derived from the repository’s public, synthetic demo assets. Fonts are self-hosted subsets of Geist and IBM Plex Mono; their licenses are in `assets/licenses/`. Source marks are reused from `public/sources/`.

After `sessiongraph.ai` is purchased, attach the apex and `www` domains to this project, redirect `www` to the apex, and update the canonical, Open Graph URLs, and sitemap to the verified production domain.

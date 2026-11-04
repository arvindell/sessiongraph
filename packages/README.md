# Workspace packages

| Package | Responsibility |
| --- | --- |
| [`core`](core/) (`@sessiongraph/core`) | Shared session types, layout, timeline, preferences, Three.js scene, public-data contract, and public viewer |
| [`site`](site/README.md) (`sessiongraph-site`) | Website, profile/account UI, hosted API, Prisma schema, and API integration tests |

The root `sessiongraph` package owns the desktop/browser application, local importer/backend, native shell, and npm launcher. Both applications consume `@sessiongraph/core` through workspace dependencies. Shared code has no dependency on either application or their storage/authentication layers.

Packages expose TypeScript source for the application bundlers; they are private and are not published independently. Native `sessiongraph-app-*` packages are generated release outputs under `release/`, not workspace source packages.

Run commands from the repository root:

```sh
pnpm typecheck
pnpm --filter @sessiongraph/core typecheck
pnpm --filter sessiongraph-site typecheck
pnpm --filter sessiongraph-site build
```

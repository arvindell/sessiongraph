# SessionGraph website

Vite builds the landing page, public profile viewer, and account UI. The Vercel API uses Prisma with Aurora DSQL. The public graph contract and renderer are shared with the desktop preview through the `@sessiongraph/core` workspace package in `../core/`.

Production: https://sessiongraph.ai/

## Local development

Use Node.js 24+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm --filter sessiongraph-site dev
pnpm --filter sessiongraph-site typecheck
pnpm --filter sessiongraph-site build
```

Vite serves the UI at `http://127.0.0.1:5190`, including `/explore`, `/account`, and `/@username`. The gallery and public graph read API use the local PostgreSQL database below. Authenticated flows still require a separately configured API; Vite does not mount account or publication mutations.

### Local PostgreSQL

From the repository root, start the database dependency with Docker Compose:

```sh
docker compose up -d --wait
pnpm --filter sessiongraph-site dev:setup
```

This runs PostgreSQL 17 on `127.0.0.1:55439` with two databases:

| Database | Connection URL |
| --- | --- |
| Development | `postgresql://sessiongraph@127.0.0.1:55439/sessiongraph_dev` |
| API tests | `postgresql://sessiongraph@127.0.0.1:55439/sessiongraph_test` |

The local-only stack uses passwordless authentication and binds its published port to loopback. Set `SESSIONGRAPH_POSTGRES_PORT` to use a different host port, and update your connection URLs accordingly. Data lives in a Docker-managed named volume; `docker compose down` stops the stack and retains it. The initialization SQL creates the test database when the volume is first initialized.

`dev:setup` initializes an empty development database without replacing existing data. The website defaults to the development URL above; `SESSIONGRAPH_DEV_DATABASE_URL` can override the local port. A new database shows an empty public gallery. Synthetic test fixtures are never presented as real community publications. The gallery reads only publications, not local imported histories.

Run the API integration tests against the test database:

```sh
TEST_DATABASE_URL=postgresql://sessiongraph@127.0.0.1:55439/sessiongraph_test pnpm --filter sessiongraph-site test
```

Tests rebuild their application tables and refuse non-loopback addresses or database names other than `sessiongraph_test`. CI provisions its own database automatically. Tests translate DSQL's asynchronous index syntax for PostgreSQL; they do not contact production. The Compose stack supplies the database only; local website API routing and authentication still need a development server setup.

## Runtime configuration

Set these only in the hosting provider's server-side environment settings:

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth application; callback is `<site origin>/api/auth/callback` |
| `AUTH_SECRET` | Random signing secret of at least 32 characters |
| `DSQL_ENDPOINT`, `DSQL_REGION`, `DSQL_USER` | Database connection settings |
| `AWS_ROLE_ARN` | Least-privilege database role assumed through Vercel OIDC |
| `CRON_SECRET` | Authenticates the daily expired-record cleanup |
| `SITE_ORIGIN` | Optional canonical HTTPS origin; defaults to `https://sessiongraph.ai` |

Never use a `VITE_` prefix for these values. Infrastructure provisioning, IAM policies, account/project identifiers, credentials, and deployment runbooks are managed outside this public repository. The Prisma schema and migrations here describe the application's data model only.

The schema uses DSQL-compatible UUIDs and application-managed relationships. Mutating transactions retry optimistic concurrency conflicts. Migrations require a separate administrative connection; the runtime role only needs application-schema CRUD access. Index builds must finish before serving traffic. Expired logins, device grants, invitations, and rate-limit records are removed in bounded daily batches.

## Public-page performance

`/explore` is rendered by the API using Vite's compiled HTML template. The first twelve cards, search form, sort selection, and pagination link are usable without JavaScript. The small client script enhances search and sorting, cancels superseded requests, and appends later pages. The gallery never loads Three.js. Profile pages download their interactive renderer concurrently with their graph snapshot.

Publishing computes counts and a bounded SVG thumbnail once and stores them in `PublicationPreview`, atomically with the graph. Gallery queries read scalar metadata, apply username substring search and a global sort, then paginate. Unknown/hidden token totals remain null and sort last. Thumbnails read the stored SVG without decompressing or laying out the graph.

Public HTML, JSON, and SVG responses are cached on Vercel for five minutes and tagged by gallery/profile. Browsers must revalidate; intermediary CDNs are not allowed to cache these snapshots. Publish, unpublish, and GitHub username changes await the foreground tag-eviction request. No stale-while-revalidate grace period is configured, but Vercel's asynchronous edge propagation can briefly serve the previous response after a successful mutation; the purge acknowledgement is not a global consistency barrier. Errors and authenticated account data remain uncached. Cache tags and their actual regional eviction must be verified in a deployment.

Page-route failures return a minimal branded HTML response with the correct error status and a recovery link, independent of the database and compiled page template. API failures remain JSON. Missing/stale previews or an unavailable preview table fall back to current publication links with unknown statistics omitted; these responses are not cached. Unknown counts sort last. Thumbnails fall back to an inert placeholder only after confirming the graph is still published. A failed interactive renderer leaves a profile's summary and static thumbnail available.

### Existing-publication migration

Apply `202611270001_publication_previews`, wait for its indexes, grant the runtime database role `SELECT, INSERT, UPDATE, DELETE` on the new table, and backfill **before routing traffic to this version**:

```sh
pnpm --filter sessiongraph-site generate
pnpm --filter sessiongraph-site db:backfill-publications
```

Run the command in the existing server-side database environment. It uses bounded batches, preserves original publication timestamps, and does not overwrite newer derived records. Quiesce publication writes during the cutover, or repeat the backfill after old application instances drain. Reads tolerate incomplete derived data, but uploads still require the preview table so each acknowledged upload has matching statistics and a thumbnail saved atomically. The local `dev:setup` command also applies this additive migration and backfills existing public snapshots.

The build moves the compiled Explore template into `dist-api/explore.html`, which is explicitly included in the Function bundle. Do not restore a public `dist/explore.html` that could shadow the dynamic route.

### Verification and measurements

```sh
TEST_DATABASE_URL=postgresql://sessiongraph@127.0.0.1:55439/sessiongraph_test \
  pnpm --filter sessiongraph-site test:browser
```

This rebuilds only the dedicated test database and uses synthetic publications. Set `PERF_BASELINE=547db1f` to compare the previous API on the same fixture. Results and screenshots stay under ignored `tmp/performance/public/`. See [performance measurements](../../docs/performance.md#public-pages).

## Deployment hold

This feature is PR-only until explicitly approved. Preview deployments are paused in the hosting project, and `vercel.json` also disables Git deployments for `feat/public-profiles`. Merging to `main` triggers website deployment and the repository's desktop/npm release workflow; see [release behavior](../../docs/releases.md).

Before an approved rollout, configure the project for the build in `vercel.json`, root directory `packages/site`, Node.js 24, and access to sources outside the root directory. Set the maintenance secret, verify database readiness, then exercise the real GitHub callback and desktop approval flow. These end-to-end production checks cannot be completed while deployment is held.

## Data and assets

Only explicitly confirmed snapshots are public. Imports stay local; disabled publication fields are omitted and rejected by the server if supplied. Profiles use GitHub usernames while ownership uses immutable GitHub IDs. Organizations provide membership and invitation groundwork; they do not grant access to anyone's local history. See [privacy details](../../PRIVACY.md).

The screenshot and video use synthetic demo data. The site self-hosts Katagami Sans (landing page), Geist, and IBM Plex Mono web fonts, with licenses in `assets/licenses/`. Source marks are reused from `../../public/sources/`. The canonical domain is `sessiongraph.ai`; `www` redirects to the apex.

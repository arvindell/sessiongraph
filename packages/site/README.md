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

Vite serves the UI at `http://127.0.0.1:5190`, including `/account` and `/@username` rewrites. It does not emulate the serverless API. UI fixtures or a separately configured API are needed for authenticated flows.

API integration tests use a dedicated local PostgreSQL database named `sessiongraph_test`. They rebuild its application tables and refuse non-loopback database addresses. CI provisions this database automatically. Run locally with `TEST_DATABASE_URL` set, then `pnpm --filter sessiongraph-site test`. Tests translate DSQL's asynchronous index syntax for PostgreSQL; they do not contact production.

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

## Deployment hold

This feature is PR-only until explicitly approved. Preview deployments are paused in the hosting project, and `vercel.json` also disables Git deployments for `feat/public-profiles`. Merging to `main` triggers website deployment and the repository's desktop/npm release workflow; see [release behavior](../../docs/releases.md).

Before an approved rollout, configure the project for the build in `vercel.json`, root directory `packages/site`, Node.js 24, and access to sources outside the root directory. Set the maintenance secret, verify database readiness, then exercise the real GitHub callback and desktop approval flow. These end-to-end production checks cannot be completed while deployment is held.

## Data and assets

Only explicitly confirmed snapshots are public. Imports stay local; disabled publication fields are omitted and rejected by the server if supplied. Profiles use GitHub usernames while ownership uses immutable GitHub IDs. Organizations provide membership and invitation groundwork; they do not grant access to anyone's local history. See [privacy details](../../PRIVACY.md).

The screenshot and video use synthetic demo data. Fonts are self-hosted Geist and IBM Plex Mono subsets, with licenses in `assets/licenses/`. Source marks are reused from `../../public/sources/`. The canonical domain is `sessiongraph.ai`; `www` redirects to the apex.

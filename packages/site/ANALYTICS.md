# Website visitor analytics

The public website uses PostHog for cookieless page views and estimated daily visitors.
The desktop/local app, account and sign-in flows, localhost, and preview deployments
are excluded. There is no user identification, session replay, autocapture, error
capture, or form capture. Do Not Track and Global Privacy Control skip initialization.
Profile URLs are grouped as `/@:username`; queries, fragments and referrer paths are
not sent. Event properties are allowlisted, not just redacted after ingestion.

## Configuration

Set `VITE_POSTHOG_PROJECT_TOKEN` and `VITE_POSTHOG_HOST` at build time in Vercel's
**Production** environment. The token is the public, write-only project token, not
a personal API key. Never commit real values. See `.env.example`.
Missing values disable analytics without breaking builds or website functionality.

The host is `/ingest`. The two rewrites in `vercel.json` proxy US Cloud ingestion
and optional static assets through the website origin, preserving the existing
Content Security Policy. The SDK disables optional external dependency loading.
If moving PostHog regions, update both rewrites and `ui_host` together.

In PostHog, add the production website to **Web analytics domains** and enable
**Cookieless tracking** under **Settings → Project → Web analytics**.
This project-side setting is required: otherwise cookieless events are discarded.
Leave replay, autocapture, heatmaps and performance capture disabled.

Open **Web analytics** in the PostHog project to see visitors and page views,
then choose a date range. Counts start when the configured build is deployed;
past website traffic cannot be recovered. Cookieless visitors are estimates,
and the same person on different days can have different anonymous identifiers.
Blocked JavaScript, privacy signals and ad blockers can reduce the counts.
Cookieless tracking alone is not a guarantee of regulatory compliance.

## Verification

Run the website typecheck, tests, and build. In a production browser, confirm
`/ingest/e/` succeeds, the PostHog activity stream receives `$pageview` events,
and **Web analytics** shows ingested data. Inspect event properties to confirm
that private queries, URL fragments and profile usernames are absent. Confirm
the account flow sends no analytics and no analytics cookies or storage appear.

References:

- [Cookieless tracking](https://posthog.com/tutorials/cookieless-tracking)
- [JavaScript configuration](https://posthog.com/docs/libraries/js/config)

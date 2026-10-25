# Porto

A personal RSS inbox for opening stories and clearing unread items. Built with Next.js, Supabase, and Vercel.

## Reading

- Open a headline in a new tab to mark it seen, or dismiss it without opening.
- Filter by source or folder, show excerpts, and mark the current view as read.
- Undo recent changes during the current browser session.
- Import/export subscriptions as OPML. Feed errors remain visible in Manage feeds.
- Keyboard: J/K to move, O or Enter to open, D/E to dismiss, Z to undo, ? for help.

## Local setup

Use Node.js 24 or newer, then run `npm ci`. Copy `.env.example` to `.env.local` and configure:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Dedicated Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe Supabase key |
| `SUPABASE_SECRET_KEY` | Server-only key for ingestion and validated source management |
| `OWNER_EMAIL` | The one email allowed to use this reader |
| `NEXT_PUBLIC_APP_URL` | Exact application origin, such as `http://localhost:3000` |
| `CRON_SECRET` | Random secret protecting the background refresh endpoint |

Apply the SQL in `supabase/migrations/20261024215242_initial_reader.sql` once to the dedicated Supabase database. Create the owner in Supabase Auth with the same email as `OWNER_EMAIL`. Add the application's exact `/auth/finish` URL to the Supabase Auth redirect allowlist and set its Site URL to the production application origin. The built-in sign-in form uses Supabase's default email template and sends a passwordless link that can be opened in any browser. Supabase verifies the one-time link and returns the session through a URL fragment; the finish page immediately clears the fragment, validates and persists the session in cookies, and checks server-side owner authorization before opening the inbox. The `/auth/callback` route also supports earlier PKCE links.

Run `npm run dev`. If port 3000 is occupied, use `npm run dev -- --port 3001` and update both `NEXT_PUBLIC_APP_URL` and the Supabase callback allowlist to match. Link the intended Vercel project before working against shared resources. Keep `.env.local`, `.vercel/`, and the OPML export out of Git.

## Deployment

Connect this repository to a Vercel Next.js project using Node.js 24, then configure the variables above in that project's Production environment. Keep the server key and cron secret encrypted and server-only. Preview deployments intentionally receive no production credentials.

The app refreshes on opening and on request, with a five-minute minimum interval per source. The server claims sources atomically and fetches at most ten at a time. An interrupted refresh releases its lease after ten minutes. Refresh routes allow up to 300 seconds.

For collection while the app is closed, use Supabase Cron to invoke `/api/cron/refresh` every 15 minutes. `supabase/schedule.sql` contains the repeatable setup. Before running it, create the `porto_origin` and `porto_cron_secret` entries in Supabase Vault; the secret must match Vercel's `CRON_SECRET`. Do not place actual values in the repository. This uses Supabase's scheduler so frequent polling does not depend on a paid Vercel Cron plan. Check job outcomes through Supabase Cron and the temporary `net._http_response` log.

## Lightweight state

There are two application tables: `sources` and `item_state`.

Unread items retain only their headline, link, excerpt, and basic timestamps until handled. Ingestion uses stable fingerprints and never resets seen state. Seen items retain display metadata for a one-day undo window; subsequent refreshes clear it. Fingerprints remain while items appear in the publisher's feed, and are pruned only after a successful full feed response confirms they have been absent for over 30 days. Failed refreshes and 304 responses never remove unread items. Old posts republished after their fingerprint expires can appear again.

Supabase row-level policies restrict each user's rows. Client roles cannot insert sources or modify ingestion metadata; validated server routes do that. Outbound feed fetching validates and pins public DNS addresses, rechecks redirects, limits response sizes and timeouts, and accepts RSS, RDF, and Atom. Article HTML is rendered only as plain text excerpts.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Optional live parser tests: set `PORTO_LIVE_FEEDS=1` and run `npm test -- tests/feeds/live-smoke.test.ts`. `tests/data/contracts.sql` and `tests/data/rls_contracts.sql` verify ingestion, seen/undo, retention, and access policies in rollback-only fixture transactions. They do not add migrations or keep test rows.

No feed reader can recover articles removed from a publisher's feed between successful polls. Background polling reduces that gap; unread articles already collected remain until handled.

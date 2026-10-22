# status-check

**Live status of 246 cloud, SaaS and AI providers for your agents, over MCP.**

On Oct 21, 2026 Railway paused builds platform-wide for over a day. Agents kept retrying deploys, reading logs and "fixing" code that wasn't broken. A human would have opened the status page. status-check gives agents that status page: one MCP call tells them that Railway is in a major outage, since when, which components are affected, and what the vendor's latest update says.

```
> check_stack(["railway", "vercel", "supabase", "github"])

2 of 4 have problems:
Railway (railway): MAJOR_OUTAGE since 2026-10-21 07:24 UTC — Railway Platform Outage
• Railway Platform Outage [major_outage, identified] started 2026-10-21 07:24 UTC · affects: US West / Builds, EU West / Builds, …
    2026-10-22 11:47 UTC identified: Deployment wait times are coming down as we work through the queue…
Supabase (supabase): PARTIAL_OUTAGE since 2026-10-22 03:53 UTC — Partial System Outage
• Elevated Mgmt API Error Rates in Multiple Regions [partial_outage, monitoring] started 2026-10-22 11:29 UTC
GitHub (github): OPERATIONAL — All Systems Operational
Vercel (vercel): OPERATIONAL — All Systems Operational
```

## How it works

Two processes share one Postgres database:

```
 vendor status pages ──► worker ──► Postgres ◄── MCP server ◄── agents
 (Statuspage, incident.io,  polls every      current status,   check_stack, list_incidents,
  status.io, AWS, GCP, …)   minute           incidents, history get_status, get_history, …
```

- **Worker** polls every provider once a minute from its official feed, normalizes it into one model (status, affected components, active incidents with their updates) and writes it to Postgres.
- **MCP server** answers agents from Postgres. It never calls a vendor, so each tool call is a couple of indexed queries.

Agents always get the same shape no matter how the vendor publishes, and one worker serves any number of agents without hammering status pages.

### Efficiency

- **Conditional requests**: the worker sends `If-None-Match` / `If-Modified-Since` and reuses the parsed body on `304`.
- **Write only on change**: every snapshot gets a fingerprint. An unchanged feed costs one batched `UPDATE … checked_at` for the whole tick, not one write per provider.
- **Bounded concurrency** (16 by default) with a 10 s timeout per request. A full tick over 246 providers takes about 6 s.
- **Compact output**: tools return plain text with one fact per line, cap incidents per provider, and truncate long updates, so a whole stack fits in a few hundred tokens.

## Tools

| Tool | What it answers |
| --- | --- |
| `check_stack(providers[])` | "Is anything I depend on down?" Status of each named service plus its active incidents. Takes names, ids or aliases (`gh`, `claude`, `Fly.io`). |
| `list_incidents(category?, minimum?)` | "Is anything down right now?" Every degraded or down provider, optionally for one category. |
| `get_status(provider)` | The why: affected components and each active incident with its latest five updates. |
| `get_history(provider, days?)` | Status changes and incidents (active and resolved) over the last N days. |
| `search_providers(query?, category?)` | Find ids, or list categories. |

The server's instructions tell agents to call `check_stack` when a deploy, build, API call or login fails in a way their change does not explain.

## Run it

You need Docker and a Postgres database (any version from 13 up).

```bash
git clone <this repo> && cd status-check
cp .env.example .env        # set DATABASE_URL
docker compose up -d --build
```

No Postgres yet? `docker compose --profile db up -d --build` starts one alongside, matching the default `DATABASE_URL`.

The worker creates its tables on start (`src/store/schema.sql`, idempotent) and syncs the provider catalog. The MCP server listens on port 3000 at `/mcp`, and `/health` returns 503 when the data is more than 5 minutes old.

Without Docker you need Node 24 or newer, which runs the TypeScript sources directly:

```bash
npm ci
DATABASE_URL=postgres://localhost/status npm run worker
DATABASE_URL=postgres://localhost/status npm run mcp
```

### Connect an agent

Claude Code:

```bash
claude mcp add --transport http status-check https://status.example.com/mcp
```

Cursor, Windsurf and other clients take a URL entry such as:

```json
{ "mcpServers": { "status-check": { "url": "https://status.example.com/mcp" } } }
```

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string |
| `POLL_CONCURRENCY` | `16` | Parallel requests per tick |
| `REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout |
| `TICK_MS` | `15000` | How often the worker looks for due providers (each provider is polled every 60 s) |
| `USER_AGENT` | `status-check/0.1` | Sent to status pages. Add a contact URL if you run a public instance. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | MCP listener |
| `ALLOWED_HOSTS` | | Hostnames the MCP server answers to (DNS-rebinding protection) |
| `MCP_USE_ANONYMIZED_TELEMETRY` | `false` | mcp-use's own anonymous telemetry, off unless you set `true` |

The MCP server only reads. In production give it a read-only role:

```sql
create role status_reader login password '…';
grant select on all tables in schema public to status_reader;
```

## Sources

| Source | Covers |
| --- | --- |
| `statuspage` | Atlassian Statuspage and incident.io pages (`/api/v2/summary.json`): 187 providers |
| `betterstack`, `instatus`, `statusio` | Pages hosted on Better Stack, Instatus and status.io |
| `aws`, `google`, `railway`, `slack`, `heroku` | Vendors with their own formats (AWS Health, Google Cloud / Firebase / Workspace, Railway's new status page) |
| `feed` | RSS/Atom incident feeds (Azure, Stripe, PayPal, Hetzner, …). An entry is active when it is recent and its latest text does not say it is resolved. |
| `probe` | Synthetic HTTP check for services without a public feed (Instantly, Mistral, Fastly, …). Any answer below 500 means up. The agent is told the status is synthetic. |

For AWS and Google Cloud, a single region or product event marks the platform `partial_outage`, never `major_outage`.

## Providers

| Category | # | Providers |
| --- | --- | --- |
| ai | 32 | Anthropic (Claude), AssemblyAI, Baseten, Bolt.new, Browserbase, Cerebras, Cohere, Cursor, Deepgram, DeepSeek, E2B, ElevenLabs, Exa, fal.ai, Firecrawl, Fireworks AI, Groq, Hugging Face, LangSmith, Lovable, Mistral AI, Modal, OpenAI, Perplexity, Retell AI, RunPod, Stability AI, Tavily, Together AI, Vapi, Windsurf, xAI (Grok) |
| analytics | 9 | Amplitude, Fathom Analytics, FullStory, Heap, Hotjar, Mixpanel, Plausible, PostHog, Segment |
| auth | 5 | Clerk, Descope, Kinde, Stytch, WorkOS |
| cdn | 4 | Akamai, Bunny.net, Cloudflare, Fastly |
| ci | 6 | Buildkite, CircleCI, Codecov, Depot, Expo, Travis CI |
| cloud | 10 | AWS, Civo, DigitalOcean, Google Cloud, Hetzner, Linode (Akamai Cloud), Microsoft Azure, Scaleway, UpCloud, Vultr |
| cms | 5 | Contentful, DatoCMS, Hygraph, Prismic, Sanity |
| commerce | 2 | BigCommerce, Shopify |
| comms | 17 | 100ms, Ably, Bird (MessageBird), Daily, Discord, Knock, LiveKit, OneSignal, Plivo, Pusher, Sendbird, Sinch, Slack, Stream, Telnyx, Twilio, Zoom |
| crm | 4 | Apollo.io, Attio, Gong, HubSpot |
| database | 21 | Aiven, ClickHouse Cloud, CloudAMQP, CockroachDB Cloud, Confluent Cloud, Convex, Databricks, Elastic Cloud, Firebase, MongoDB Atlas, Neon, Pinecone, PlanetScale, Prisma, Qdrant Cloud, SingleStore, Snowflake, Supabase, Tinybird, Turso, Upstash |
| devtools | 16 | Bitbucket, CodeSandbox, GitHub, GitLab, HashiCorp, Inngest, LaunchDarkly, Liveblocks, Mapbox, ngrok, Postman, Pulumi, Retool, Statsig, Temporal Cloud, Trigger.dev |
| dns | 3 | DNSimple, Gandi, GoDaddy |
| email | 14 | beehiiv, Brevo, Customer.io, Instantly, Kit (ConvertKit), Loops, Mailchimp, MailerSend, Mailgun, Mailjet, Postmark, Resend, SendGrid, SparkPost |
| hosting | 15 | Fly.io, Framer, Ghost(Pro), Heroku, Kinsta, Koyeb, Netlify, Northflank, Pantheon, Railway, Render, Replit, Squarespace, Vercel, Webflow |
| media | 6 | Cloudinary, Filestack, imgix, Mux, Uploadcare, Vimeo |
| monitoring | 19 | Atlassian Statuspage, Axiom, Better Stack, Bugsnag, Datadog, Grafana Cloud, Honeybadger, Honeycomb, incident.io, Loggly, LogRocket, Mezmo, New Relic, Opsgenie, PagerDuty, Rollbar, Rootly, Sentry, Sumo Logic |
| payments | 15 | Braintree, Chargebee, Coinbase, GoCardless, Lemon Squeezy, Mollie, Paddle, PayPal, Plaid, Polar, Recurly, RevenueCat, Square, Stripe, Wise |
| productivity | 23 | Airtable, Asana, Atlassian, Basecamp, Calendly, Canva, Coda, Confluence, Figma, Google Workspace, Grammarly, Jira, Linear, Loom, Make, Miro, monday.com, Notion, PandaDoc, Todoist, Trello, Typeform, Zapier |
| registry | 5 | Docker Hub, JFrog, npm, PyPI, RubyGems |
| security | 5 | 1Password, Doppler, Let's Encrypt, Snyk, Tailscale |
| social | 3 | Epic Games, Reddit, Twitch |
| storage | 4 | Backblaze B2, Box, Dropbox, Wasabi |
| support | 3 | Front, Help Scout, Intercom |

## Add a provider

```bash
npm run discover -- https://status.example.com
```

It detects the feed format and prints the `source` and `config` for a line in [`src/catalog/providers.ts`](src/catalog/providers.ts). Before opening a PR, run `npm run check` (typecheck and tests) and `npm run verify -- <id>` (polls the feed live). For a vendor with no feed, add a `probe` entry pointing at an API endpoint that answers without credentials, even with a 401.

New source formats are one file in `src/sources/` that implements `StatusSource`: take the config, return a `Snapshot`.

## Project layout

```
src/
  domain/    status scale, types, ports (no I/O)
  sources/   one adapter per status-page format
  catalog/   the built-in provider list
  infra/     HTTP client with timeouts and conditional requests
  store/     Postgres schema, reader and writer
  worker/    polling loop (entry: worker/main.ts)
  mcp/       MCP tools built with mcp-use (entry: mcp/main.ts)
```

The `providers` table has an `owner` column, unused for now, so user-defined checks can live next to the built-in catalog later.

## License

MIT

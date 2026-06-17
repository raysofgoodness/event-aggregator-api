# Event Aggregator API

Edge-deployed REST API for ingesting and querying analytics events from multiple sites. Runs as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) on [Hono](https://hono.dev/), stores events in [Supabase PostgreSQL](https://supabase.com/).

This is a **standalone repository** in a two-repo architecture. The companion project — `event-aggregator-dashboard` (Next.js + Auth.js + D1) — calls this API server-side to display events to administrators.

```
┌─────────────┐     POST/GET /api/events      ┌──────────────────┐
│  Site A/B   │ ── Bearer API_TOKEN ────────► │  CF Worker       │
│  (tracking) │                               │  event-aggregator│
└─────────────┘                               │  -api            │
                                              └────────┬─────────┘
┌─────────────┐     GET /api/events (server)            │
│  Dashboard  │ ── Bearer API_TOKEN ────────────────────┤
│  (Next.js)  │                                         │
└─────────────┘                                         ▼
                                              ┌──────────────────┐
                                              │  Supabase        │
                                              │  table: events   │
                                              └──────────────────┘
```

---

## Table of Contents

- [Features](#features)
- [Stack](#stack)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Supabase Setup](#supabase-setup)
- [API](#api)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [CI/CD (GitLab)](#cicd-gitlab)
- [Security](#security)
- [Dashboard Integration](#dashboard-integration)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## Features

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | `GET` | Health check — `Event Aggregator API v1.1` |
| `/api/events` | `POST` | Insert a new event + geo enrichment |
| `/api/events` | `GET` | List events with filters and pagination |

- **Bearer auth** on all `/api/*` routes
- **CORS** for cross-origin requests (configured via `CORS_ORIGIN`)
- **Geo enrichment** — country from `request.cf.country` (Cloudflare edge)
- **Auto-fill** `ip` and `user_agent` from `cf-connecting-ip` / `user-agent` headers when omitted from the body
- **Filters** by site, event type, and date range
- **Sorting** `created_at DESC`, default limit `100`, max `1000`

---

## Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Framework | Hono 4.x |
| Database | Supabase PostgreSQL (REST via `@supabase/supabase-js`) |
| Tooling | Wrangler 4.x, TypeScript 5.x |
| CI | GitLab CI (typecheck + deploy) |

The Worker **does not use** D1, KV, or R2 — only secrets + Supabase REST API.

---

## Requirements

- **Node.js** 20+
- **npm** (or a compatible package manager)
- [Cloudflare](https://dash.cloudflare.com/) account with Workers enabled
- [Supabase](https://supabase.com/) project with an `events` table (see below)
- For CI: GitLab Runner + variables `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://git.qix.sx/next-dev-illia-skoropad/event-aggregator-api.git
cd event-aggregator-api

# 2. Install dependencies
npm ci

# 3. Create local secrets (gitignored file)
cp .dev.vars.example .dev.vars   # or create manually — see section below

# 4. Start dev server
npm run dev
# → http://localhost:8787
```

Smoke test:

```bash
curl http://localhost:8787/
# Event Aggregator API v1.1 🚀

curl -X POST http://localhost:8787/api/events \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site":"example.com","event_type":"pageview","url":"https://example.com/"}'
```

---

## Environment Variables

### Local — `.dev.vars`

This file is **not committed** to git (see `.gitignore`). Wrangler loads it automatically when running `npm run dev`.

```ini
# .dev.vars — example (fill in real values)
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...   # service_role key
API_TOKEN=your-secure-token-min-32-chars-url-safe
CORS_ORIGIN=http://localhost:3000
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_KEY` | ✅ | **service_role** key — server-side only, bypasses RLS |
| `API_TOKEN` | ✅ | Shared Bearer token for API and Dashboard |
| `CORS_ORIGIN` | ⚠️ | CORS origin. If empty — falls back to `*` (unsafe for prod) |

### Production — Wrangler secrets

Secrets are **not** stored in GitLab CI. Set them once on the Worker:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler secret put API_TOKEN
wrangler secret put CORS_ORIGIN
```

### Generating `API_TOKEN`

- Minimum 32 characters, URL-safe
- Hono bearer regex: `[A-Za-z0-9._~+/-]+=*`

```bash
# Example
openssl rand -base64 32
```

**Important:** the same `API_TOKEN` must be set in the Dashboard (`API_TOKEN` env) for server-side fetch.

---

## Supabase Setup

Run this migration in the Supabase SQL Editor to create the `events` table:

```sql
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  site        TEXT NOT NULL,
  session_id  UUID,
  visitor_id  UUID,
  event_type  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  url         TEXT,
  referrer    TEXT,
  gclid       TEXT,
  metadata    JSONB,
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_site       ON events(site);
CREATE INDEX idx_events_event_type ON events(event_type);
CREATE INDEX idx_events_timestamp  ON events(timestamp);
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | BIGSERIAL | auto | Primary key |
| `site` | TEXT | ✅ | Source identifier (domain or slug) |
| `session_id` | UUID | — | Visitor session ID |
| `visitor_id` | UUID | — | Persistent visitor ID |
| `event_type` | TEXT | — | Event type (`pageview`, `click`, `purchase`…) |
| `ip` | TEXT | — | IP (from body or `cf-connecting-ip`) |
| `user_agent` | TEXT | — | User-Agent |
| `url` | TEXT | — | Page URL |
| `referrer` | TEXT | — | Referrer |
| `gclid` | TEXT | — | Google Click ID |
| `metadata` | JSONB | — | Arbitrary data + `geo.country` from Worker |
| `timestamp` | TIMESTAMPTZ | default NOW() | Event time (from client) |
| `created_at` | TIMESTAMPTZ | default NOW() | Record insertion time |

### Geo enrichment

On `POST /api/events`, the Worker **always** adds the country to metadata:

```json
{
  "plan": "pro",
  "geo": {
    "country": "UA"
  }
}
```

Source: `request.cf?.country` (available on Cloudflare edge only; may be `null` locally).

---

## API

Base URL:

| Environment | URL |
|-------------|-----|
| Local | `http://localhost:8787` |
| Production | `https://event-aggregator-api.<account>.workers.dev` |

### Authentication

All `/api/*` routes require:

```http
Authorization: Bearer <API_TOKEN>
```

| Response | Condition |
|----------|-----------|
| `401 Unauthorized` | Missing or invalid token |
| `403` | — (bearer middleware) |

Public route without auth: `GET /`.

### `POST /api/events`

Insert a new event.

**Headers:**

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

**Request body:**

```json
{
  "site": "example.com",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "visitor_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "event_type": "pageview",
  "ip": "203.0.113.1",
  "user_agent": "Mozilla/5.0 ...",
  "url": "https://example.com/pricing",
  "referrer": "https://google.com",
  "gclid": "abc123",
  "metadata": { "plan": "pro" },
  "timestamp": "2026-06-16T10:00:00Z"
}
```

**Validation:**

| Field | Rule |
|-------|------|
| `site` | Required, non-empty string |
| All others | Optional |
| Body | Valid JSON object (not an array) |

**Response `201 Created`:**

```json
{
  "id": 42,
  "created_at": "2026-06-16T10:00:01.123Z"
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| `400` | Invalid JSON, missing `site` |
| `401` | Invalid Bearer token |
| `500` | Supabase error (generic message, no DB details exposed) |

**curl example:**

```bash
curl -X POST "$API_URL/api/events" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "site": "example.com",
    "event_type": "pageview",
    "url": "https://example.com/pricing",
    "metadata": { "plan": "pro" }
  }'
```

---

### `GET /api/events`

List events with filters.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `site` | string | Exact match on `site` column |
| `event_name` | string | Match on `event_type` column |
| `date_from` | ISO 8601 | `created_at >= date_from` |
| `date_to` | ISO 8601 | `created_at <= date_to` |
| `limit` | integer | Default `100`, max `1000` |

All filters are optional. Without `site`, returns events from all sites (up to `limit`) — acceptable because the token is used server-side only in the Dashboard.

**Response `200 OK`:**

```json
{
  "data": [
    {
      "id": 42,
      "site": "example.com",
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "visitor_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "event_type": "pageview",
      "ip": "203.0.113.1",
      "user_agent": "Mozilla/5.0 ...",
      "url": "https://example.com/pricing",
      "referrer": "https://google.com",
      "gclid": null,
      "metadata": {
        "plan": "pro",
        "geo": { "country": "UA" }
      },
      "timestamp": "2026-06-16T10:00:00Z",
      "created_at": "2026-06-16T10:00:01.123Z"
    }
  ],
  "count": 1
}
```

- `data` — array of records (up to `limit`)
- `count` — total rows matching filters (may be > `data.length`)
- Sort order: `created_at DESC`

**Errors:**

| Code | Condition |
|------|-----------|
| `400` | Invalid `limit`, `date_from`, or `date_to` |
| `401` | Invalid Bearer token |
| `500` | Supabase error |

**Examples:**

```bash
# All events for one site
curl "$API_URL/api/events?site=example.com" \
  -H "Authorization: Bearer $API_TOKEN"

# Filter by type and date range
curl "$API_URL/api/events?site=example.com&event_name=pageview&date_from=2026-06-01T00:00:00Z&date_to=2026-06-30T23:59:59Z&limit=50" \
  -H "Authorization: Bearer $API_TOKEN"
```

---

### Middleware pipeline

Processing order for `/api/*`:

1. **CORS** — `origin` from `CORS_ORIGIN` (or `*`), methods `GET`, `POST`, `OPTIONS`
2. **Bearer auth** — validates `API_TOKEN`
3. **Route handler** — insert or select

Global `onError`:

- `HTTPException` → corresponding status + message
- Other errors → `500` + `{ "error": "Internal Server Error" }` (details logged via `console.error` only)

---

## Local Development

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Wrangler dev server at `http://localhost:8787` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy` | Deploy to Cloudflare (`wrangler deploy --minify`) |
| `npm run cf-typegen` | Generate `CloudflareBindings` types from wrangler config |

### Typecheck before push

```bash
npm ci
npm run typecheck
```

### Developer notes

- Read bindings via `c.env.*`, not `process.env`
- Supabase client is created **per-request** with `persistSession: false`
- `console.error` works via `@cloudflare/workers-types` (do not add `"dom"` to `tsconfig`)
- `bearerAuth` requires a generic: `bearerAuth<{ Bindings: Bindings }>(...)`

---

## Deployment

### Order (with Dashboard)

```
1. Deploy API          → save production URL as API_URL
2. wrangler secret put → SUPABASE_*, API_TOKEN, CORS_ORIGIN
3. Deploy Dashboard    → API_URL + same API_TOKEN
4. GET /api/setup      → one-time D1 migration (in dashboard repo)
5. Smoke test          → curl POST/GET on production
```

### Manual deploy

```bash
# Authenticate (once)
npx wrangler login

# Secrets (once per Worker)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler secret put API_TOKEN
wrangler secret put CORS_ORIGIN   # production dashboard URL, not *

# Deploy
npm run deploy
```

After deploy, Wrangler prints a URL like:

```
https://event-aggregator-api.<subdomain>.workers.dev
```

### Production smoke test

```bash
export API_URL="https://event-aggregator-api.<subdomain>.workers.dev"
export API_TOKEN="your-token"

curl "$API_URL/"

curl -X POST "$API_URL/api/events" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site":"smoke-test","event_type":"deploy_check"}'

curl "$API_URL/api/events?site=smoke-test&limit=1" \
  -H "Authorization: Bearer $API_TOKEN"
```

---

## CI/CD (GitLab)

Repository: `https://git.qix.sx/next-dev-illia-skoropad/event-aggregator-api.git`  
Deploy branch: **`master`**

### Pipeline (`.gitlab-ci.yml`)

| Stage | Job | When |
|-------|-----|------|
| `verify` | `typecheck` | MR + push to `master` |
| `deploy` | `deploy` | Push to `master` only |

### GitLab CI/CD Variables

| Variable | Purpose |
|----------|---------|
| `CLOUDFLARE_API_TOKEN` | Token with Workers deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

### Runtime secrets

CI deploys **code only**. `SUPABASE_*`, `API_TOKEN`, and `CORS_ORIGIN` are set via `wrangler secret put` separately — deploy will succeed without them, but the API won't work in prod.

### GitLab Runner

Self-hosted GitLab requires an active runner. Without one, jobs stay `pending`:

`Project → Settings → CI/CD → Runners`

---

## Security

| Practice | Status |
|----------|--------|
| Secrets not in git (`.dev.vars` gitignored) | ✅ |
| Bearer auth on `/api/*` | ✅ |
| Parameterized Supabase queries (supabase-js) | ✅ |
| DB errors — generic message to client | ✅ |
| `service_role` key — Worker only | ✅ required |
| `CORS_ORIGIN` in prod — specific dashboard URL | ⚠️ not `*` |
| `API_TOKEN` in browser client | ❌ never |

### MVP limitations (out of scope)

- Rate limiting
- Body size validation (Zod)
- CSV export endpoint
- Multi-tenant dashboard

---

## Dashboard Integration

The Dashboard (`event-aggregator-dashboard`) calls this API **server-side only**:

```typescript
const res = await fetch(`${process.env.API_URL}/api/events?${params}`, {
  headers: {
    Authorization: `Bearer ${process.env.API_TOKEN}`,
  },
});
```

| Dashboard variable | API relationship |
|--------------------|------------------|
| `API_URL` | URL of this Worker |
| `API_TOKEN` | Same token as the `API_TOKEN` secret on the API Worker |

Dashboard user auth (email/password) is handled separately in D1 via Auth.js and is unrelated to this API.

---

## Troubleshooting

### `401 Unauthorized`

- Check `Authorization: Bearer <token>` (space after Bearer)
- Locally: token in `.dev.vars` must match the one in curl
- Prod: `wrangler secret put API_TOKEN` on the correct Worker

### `500 Database error`

- `events` table exists in Supabase
- `SUPABASE_KEY` is **service_role**, not `anon`
- `SUPABASE_URL` has no trailing slash

### CORS errors from browser

- Set `CORS_ORIGIN` to the exact dashboard origin (with protocol)
- Preflight: API allows `OPTIONS` on `/api/*`

### `geo.country` always `null` locally

Expected behavior — `request.cf` is available on Cloudflare edge, not in `wrangler dev` without emulation.

### Pipeline `pending` in GitLab

No active GitLab Runner — register one in project settings.

### TypeScript: `console` is not defined

Ensure `tsconfig.json` has `"types": ["@cloudflare/workers-types"]` and **does not** include `"dom"`.

---

## Project Structure

```
event-aggregator-api/
├── src/
│   └── index.ts          # Hono app: routes, middleware, Supabase
├── wrangler.jsonc        # Worker config (name, compatibility_date)
├── package.json
├── tsconfig.json
├── .gitlab-ci.yml        # typecheck + deploy
├── .dev.vars             # local secrets (not in git)
└── README.md
```

### Wrangler config

```jsonc
{
  "name": "event-aggregator-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-17",
  "compatibility_flags": ["nodejs_compat"]
}
```

---

## Additional Documentation

Detailed doc extracts and architectural decisions live in the parent workspace (if cloned together):

| File | Contents |
|------|----------|
| `NOTES.md` | Hono, Supabase, CF patterns, pitfalls |
| `PLAN.md` | Full implementation plan |
| `context/project-decisions.md` | Locked architectural decisions |

### Useful links

- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Hono Bearer Auth](https://hono.dev/docs/middleware/builtin/bearer-auth)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Supabase JS Client](https://supabase.com/docs/reference/javascript/introduction)
- [Cloudflare Workers `request.cf`](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)

---

## License

Public repository. Specify a license in repo settings if needed.

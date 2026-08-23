# NexusPrice

A token price lookup and history tool for ERC-20 tokens. Looks up the current
and historical price of a token via Alchemy's Prices API, caches results in
Redis, persists daily historical prices to MongoDB, and can backfill a
token's full price history in the background via a BullMQ worker.

This README describes what the code actually does, not an aspirational
architecture - see "Known limitations" at the bottom for what's genuinely
missing.

## Stack

| Layer | Tech | Notes |
|---|---|---|
| App | Next.js 15 (App Router) | API routes under `src/app/api/`, no separate Express server |
| Cache | Redis | Single-flight + stale-while-revalidate, see `src/lib/priceCache.ts` |
| Database | MongoDB (Mongoose) | Daily price history, one document per (token, network, day) |
| Queue | BullMQ | Backfill jobs, run by a standalone worker process |
| Upstream data | Alchemy Prices API + Node RPC | Free tier is capped at 300 `token_price` requests/hour - worth knowing before load testing |

There is no Express server, no `src/pages/` directory, and no daemon
monitoring Redis for cache misses - all API logic lives in Next.js route
handlers, and the worker only does what's explicitly scheduled via
`POST /api/schedule`.

## Architecture

Two independent deployable processes:

1. **The Next.js app** (`npm run dev` / `npm run build && npm start`) -
   serves the dashboard UI and all API routes. Stateless; can run on
   Vercel or anywhere Node runs.
2. **The worker** (`npm run worker`, `src/worker/priceWorker.ts`) - a
   long-running process that consumes the `price-history-queue` BullMQ
   queue and performs token backfills. Cannot run on Vercel (it's not a
   request/response process); needs somewhere that runs long-lived Node
   processes.

Both talk to the same Redis and MongoDB instances.

### Data flow

- `POST /api/price` - current + historical price for one token at one
  timestamp. Checks Redis (single-flight, so concurrent requests for the
  same key don't stampede Alchemy) → Alchemy. Falls back to
  linear interpolation between the nearest known prices if the exact
  timestamp isn't available, and to the current price if interpolation
  also fails. Every response includes `degraded: true` when it couldn't
  resolve a usable price, even though it still returns HTTP 200 - HTTP
  status alone doesn't tell you whether the response is useful.
- `POST /api/historical-prices` - a price series over a time range (1w
  through 3y) for charting. Resolves each bucket as **Redis → MongoDB →
  Alchemy**: if a day was already backfilled into MongoDB, it's served
  from there with zero Alchemy calls. Each point is tagged with
  `method: "cache" | "db" | "alchemy"` so you can see where it came from.
- `POST /api/schedule` - enqueues a backfill job for a token: resolves the
  token's first on-chain transfer, then fetches its full price history in
  up-to-365-day windows (Alchemy's `tokens/historical` endpoint accepts a
  date range and caps at 365 days/365 points per call - confirmed
  empirically), storing one price per day in MongoDB. A 3-year-old token is
  ~3 Alchemy calls, not ~1,095 daily calls. Deterministic job IDs mean
  re-submitting the same token/network while a job is already pending is a
  no-op, not a duplicate job.
- `GET /api/schedule/status?coinId=&network=` - job state and progress for
  a scheduled backfill.

### Cache policy

Two TTL profiles, not a single blanket TTL:

- **Current price**: soft TTL 30s, hard TTL 5 minutes. Volatile, so it's
  revalidated frequently; stale-while-revalidate means a request never
  blocks on a slow Alchemy call just because the soft TTL passed.
- **Historical price**: soft/hard TTL 30 days. A price at a fixed past
  timestamp doesn't change once known, so it's cached long and mostly
  never revalidated.

Redis is not a hard dependency: if it's unreachable (timeout or error),
`getWithSingleFlight` falls through to calling Alchemy directly
(`source: "bypass"`) rather than failing the request.

## Folder structure

```
src/
  middleware.ts             # next-auth route protection for /dashboard/*
  app/
    (app)/dashboard/       # UI: playground (lookup) and stats (charts) pages
    (auth)/signup/          # redirects to /api/auth/signin - no self-service registration
    api/
      price/                route.ts           - current + historical price for one timestamp
      historical-prices/     route.ts           - price series for charting
      schedule/               route.ts           - enqueue a backfill job
                              status/route.ts     - poll a backfill job's status
      auth/[...nextauth]/     route.ts           - next-auth handler (dashboard login)
  worker/
    priceWorker.ts          # entrypoint: starts the BullMQ Worker
    priceProcessor.ts       # the actual job logic (kept separate so it's importable in tests with no side effects)
  lib/
    priceCache.ts           # single-flight + stale-while-revalidate cache primitive
    redisConnect.ts         # Redis client singleton
    dbConnect.ts             # Mongoose connection
    priceHistoryQueue.ts     # BullMQ Queue singleton
    analytics.ts             # % change / volatility / SMA over a price series
    priceAggregations.ts      # same statistics, computed via MongoDB aggregation pipelines instead of in Node
    dateRange.ts               # UTC-anchored date helpers - see "Known limitations" on why this exists
    alchemyRateLimiter.ts       # Redis-backed distributed pacer for Alchemy's token_price quota - see "Running the worker"
    networks.ts                 # app network name -> Alchemy network slug
    jobId.ts                     # deterministic BullMQ job IDs
    apiAuth.ts                    # x-api-key + dashboard-session authentication - see "Authentication and rate limiting"
    authOptions.ts                 # next-auth config (Credentials provider, single admin account)
    rateLimit.ts                    # per-identity Redis fixed-window rate limiting
    validation.ts                    # token address format validation
    routeGuard.ts                     # combines the four above into the one check every route runs first
    logger.ts                          # level-gated logger for route handlers, silent by default under NODE_ENV=test
  model/
    price.model.ts           # Mongoose schema for daily prices, unique on (tokenAddress, network, date)
scripts/
  benchmark.mjs              # P50/P95/P99 latency + availability, cold vs warm vs cache-bypassed - see "Benchmarking"
  tokens/
    mainnet-top20.json         # ~20 real, verified mainnet ERC-20 addresses benchmark.mjs uses by default
  load-test.mjs               # staged concurrency ramp to find the breaking point (synthetic addresses)
  load-test-real-tokens.mjs    # same ramp methodology, against real tokens instead of synthetic ones
  migrate-price-schema.mjs     # one-time migration for the price.model.ts schema change
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values (MongoDB URI,
   Redis connection, Alchemy API key, `API_KEYS`, `DASHBOARD_USERNAME`/
   `PASSWORD`, `NEXTAUTH_SECRET` - see "Authentication and rate limiting").
3. `npm run dev` - starts the Next.js app.
4. `npm run worker` - starts the BullMQ worker, in a separate terminal.
   Only needed if you're using `POST /api/schedule`.
5. `npm test` - runs the test suite (Vitest). `npm run test:tz-adversarial`
   runs a separate suite that deliberately runs under a non-UTC,
   DST-observing timezone - see "Known limitations".

## Running the worker

Two independent levers control backfill throughput, both read from `.env`
(see `.env.example`):

- **`WORKER_CONCURRENCY`** (default 5) - how many jobs *one worker process*
  runs at once. Does not bound Alchemy traffic by itself - see below.
- **`ALCHEMY_RPS`** (default: the exact fraction `300/3600`, i.e. Alchemy's
  real free-tier ceiling of 300 `token_price` requests/hour, computed in
  code rather than written as a rounded decimal) - paces every Alchemy call
  that draws from that quota, via a Redis-backed distributed rate limiter
  (`src/lib/alchemyRateLimiter.ts`), shared across every worker process.
  Raise this if you're on a paid Alchemy tier with a higher limit.

**Why a Redis pacer instead of BullMQ's own queue-wide `limiter` option**
(which this project used until this changed): BullMQ's limiter paces *job
dispatch*, not the Alchemy calls made *inside* an already-running job. Since
a job now issues anywhere from zero calls (every window already backfilled)
to ~9-11 (an old token backfilled from scratch) - and that count isn't known
until the job is already running, since it depends on the token's actual age
- a dispatch-rate limiter can't precisely bound the real thing that matters
(Alchemy calls/second) once the calls-per-job ratio is variable. Sizing it
for the worst case would throttle every job as if it always needed the
maximum, wasting most of the real budget on the common case. The Redis
pacer bounds the actual constrained resource directly: every call to
Alchemy's `tokens/historical` endpoint, from any job, in any worker
process, waits its turn via a single Redis key incremented atomically via a
Lua script, evenly spread rather than bursty. `WORKER_CONCURRENCY` now only
controls how many jobs are in flight (and therefore how many might be
concurrently *waiting their turn* in the pacer); it has no bearing on
Alchemy's actual request rate.

**Sub-1 requests/second, correctly encoded**: `300/3600 ≈ 0.083` req/s
cannot be expressed as an integer `max` in a `{max, duration}`-style rate
limiter without rounding it away to nothing. It's encoded as *one request
every N milliseconds* instead - `rateToIntervalMs(300/3600)` returns
`12000`, i.e. one request per 12 seconds - which generalizes correctly to
any rate, not just sub-1 ones.

To run more than one worker process (more throughput than one process's
`WORKER_CONCURRENCY` alone allows), just start `npm run worker` again in
another terminal, another container, etc. - BullMQ handles multiple
consumers on one queue with no code changes required, and the Redis pacer
already coordinates Alchemy's rate across all of them; this is a
deployment/ops decision, not something the code needs to know about.

## Authentication and rate limiting

Every API route runs the same check first (`guardRoute`, `src/lib/routeGuard.ts`):
authenticate → optionally require admin scope → rate-limit by whoever that
identity turned out to be.

**Authentication - two mechanisms, one identity type:**

- **`x-api-key` header** - checked against an env-var allowlist
  (`API_KEYS`, `src/lib/apiAuth.ts`), for external/programmatic callers.
  Format: comma-separated `key` or `key:admin` pairs; a bare key defaults
  to `read` scope. Chosen over hashed keys in Mongo because this project
  has no user accounts, no self-service key issuance, and no demonstrated
  multi-tenant need - a Mongo-backed store would mean building issuance,
  storage, and revocation infrastructure for a need that doesn't exist
  yet. The tradeoff: keys are plaintext in `.env` (same as
  `MONGODB_URI`/`ALCHEMY_API_KEY` already are) and rotating one means a
  redeploy, not an API call. Right for single-tenant use; wrong the
  moment this needs self-service issuance or a per-key audit trail.
- **Dashboard session** (next-auth, `CredentialsProvider`,
  `src/lib/authOptions.ts`) - for the dashboard UI's own same-origin
  fetch calls, which don't carry an `x-api-key`. A single hardcoded
  credential pair (`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`) - there's
  no self-service registration (`/signup` just redirects to
  `/api/auth/signin`), and any valid session is treated as `admin` scope
  since there's exactly one account. `src/middleware.ts` gates
  `/dashboard/*` on having a session, redirecting to sign-in otherwise.
  next-auth was kept (not removed as an unused dependency) specifically
  because the dashboard needed *some* way to call its own now-locked-down
  API routes, and a session cookie is the correct mechanism for a
  same-origin browser client - baking a static API key into client-side
  code would leak it to anyone who opens devtools.

**Admin scope**: `POST /api/schedule` requires an admin-scoped API key or
a dashboard session (`requireAdmin: true` in its `guardRoute` call) -
scheduling a backfill spends Alchemy quota and shouldn't be callable by
every `read`-scoped key. `/api/metrics` and `/api/schedule/all` don't
exist in this codebase yet, so there's nothing to gate on them.

**Rate limiting** (`src/lib/rateLimit.ts`): per-identity fixed-window
counting via Redis `INCR`+`EXPIRE`. The Redis key is
`ratelimit:<routeName>:<identity>:<windowBucket>` - `routeName` (e.g.
`"price"`, `"schedule-status"`) is a required field on every route's
`guardRoute` call specifically so two different routes can never collide
on the same counter for the same caller; `identity` is the API key or
`session:<email>` that authenticated the request, so different callers on
the same route never share a budget either. Exceeding the limit returns
`429` with a `Retry-After` header; every response (successful or not)
carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset`.

**Fail-open vs. fail-closed on a Redis error** is a per-route choice
(`failClosedOnRedisError` in each route's `guardRoute` options), not a
single blanket policy:

- `POST /api/price` and `POST /api/historical-prices` call Alchemy
  *directly*, and `priceCache`'s single-flight cache also fails open
  during the same Redis outage (bypasses straight to Alchemy) - so
  fail-open on the rate limiter, combined with that, would mean every
  single request becomes a real, unthrottled Alchemy call for as long as
  Redis is down. Against a 300/hour free-tier quota, that's exhausted by
  a modest concurrent load in seconds, and the resulting outage (every
  caller blocked for up to the remainder of the hour) far outlasts a
  typical Redis blip. Both routes fail **closed** instead: a Redis error
  returns `503` (not `429` - the request wasn't rejected for exceeding a
  quota, the limiter itself couldn't be checked) with a short
  `Retry-After: 10`.
- `POST /api/schedule` fails closed for the same reason (it triggers a
  real backfill, which spends the same quota) - though in practice a real
  Redis outage would likely also fail `priceHistoryQueue.add()` itself,
  since BullMQ needs Redis; the guard isn't relying on that as the only
  backstop.
- `GET /api/schedule/status` fails **open**: it's a single read-only
  BullMQ lookup that never calls Alchemy, so there's no quota at risk,
  and blocking status polling during a Redis blip would add an outage
  with no corresponding benefit. This is consistent with the rest of the
  codebase's default Redis-optionality stance (cache, pacer).

| Route | Limit | Admin only? | On Redis error | Why |
|---|---|---|---|---|
| `POST /api/price` | 60 / 60s | No | Fail closed (503) | Cheap normally (1-2 Alchemy calls), but cache also fails open on the same outage |
| `POST /api/historical-prices` | 20 / 60s | No | Fail closed (503) | Can amplify to ~36 sequential Alchemy calls when nothing is cached |
| `POST /api/schedule` | 10 / hour | Yes | Fail closed (503) | Triggers a real backfill; deterministic job IDs already dedupe re-submits, so this bounds *distinct* scheduling requests |
| `GET /api/schedule/status` | 120 / 60s | No | Fail open | Read-only, one BullMQ lookup, no Alchemy call - safe to poll frequently, nothing to protect during an outage |

**Address validation**: every route accepting a token address validates
it against `/^0x[a-fA-F0-9]{40}$/` (`src/lib/validation.ts`) before doing
any work, returning `400` on a malformed address rather than passing it
through to Alchemy/Mongo.

## Benchmarking

`scripts/benchmark.mjs` measures `POST /api/price` latency and
usable-response availability against a real, running instance - see the
comment block at the top of the script for the full methodology. Results
from actual runs, with commit SHA and machine/network conditions, are
committed in `BENCHMARKS.md`.

```
node scripts/benchmark.mjs --confirm-quota-spend
node scripts/benchmark.mjs --confirm-quota-spend --bypass-cache
node scripts/benchmark.mjs --synthetic --tokens 50 --confirm-quota-spend
```

**Real tokens by default**: uses `scripts/tokens/mainnet-top20.json` - ~20
well-known mainnet ERC-20 addresses (WETH, USDC, DAI, etc.), each verified
against an external source (Uniswap's token list, CoinGecko's contract
API, or 1inch's token list) before being committed, not hand-typed and
trusted. Real addresses matter here specifically because they're what
makes cold/bypass latency numbers mean anything - Alchemy has no price
data for a synthetic address, so a synthetic run mostly measures "how fast
does this return `degraded:true` for garbage input," not real upstream
latency. Pass `--tokens-file <path>` to use a different set (same `{
"address", "network" }` shape), or `--synthetic --tokens N` to fall back
to the old generated-address behavior, which is still the right tool for
`load-test.mjs`-style breaking-point tests where unique cache keys (not
realism) are what's needed.

**Authentication**: every request needs a valid `x-api-key` now that Task
7 locked these routes down. Read from the `API_KEY` env var by default
(`--api-key` is accepted too, but env is preferred for the same reason
`API_KEYS`/`ALCHEMY_API_KEY` are env vars elsewhere in this project - it
keeps the key out of shell history and process listings).

**`--bypass-cache`**: sends `x-bypass-cache: 1` on cold/bypass-phase
requests, which `/api/price` only honors when the server has
`ALLOW_CACHE_BYPASS=true` set (see `.env.example`) - unset, the header is
a silent no-op. This is what turns "first request per token" (cold, which
still pays Redis GET/lock-acquire overhead on the way to a miss) into a
true no-cache-at-all baseline, so the cache's actual contribution can be
measured as warm-vs-bypass, not inferred from cold alone. The script
verifies at least one bypass response actually carries `cache:
"bypass-header"` and prints a loud warning (not a silent pass) if the
server wasn't actually configured to honor it - a misconfigured
`ALLOW_CACHE_BYPASS` would otherwise produce "bypass" numbers that are
quietly just normal cached numbers.

**Quota discipline**: cold and bypass requests spend real Alchemy
`token_price` quota (300/hour free tier, shared with anything the worker
is doing). The script computes the full plan - token count x phases x
worst/best-case Alchemy calls per request - and prints it *before* running
anything; the quota-spending phases (cold, bypass) only execute with an
explicit `--confirm-quota-spend` flag. Warm requests never call Alchemy
(cache hit) but still count against the server's per-request-key rate
limit (60/60s on this route - see the table above), so the script
self-throttles every phase to stay under that limit via a client-side
`RateGovernor` mirroring the server's own fixed-window scheme; this bounds
wall-clock time for a large `--requestsPerToken`, not quota.

## Local-first development

Use a local Redis for day-to-day development rather than pointing `.env` at
a cloud instance. This isn't just a preference: a free-tier Redis Cloud
instance used earlier in this project was reclaimed after a period of
inactivity - the hostname stopped resolving entirely, with no warning,
breaking every code path that touched the cache until a new instance was
provisioned and `.env` was updated. That's a real operational failure mode
of free-tier cloud Redis, not a hypothetical one, and it's the reason to
default to local: nothing about a local instance can be reclaimed out from
under you.

A cloud instance (Redis Cloud, ElastiCache, etc.) is still the right choice
for anything shared - staging, a deployed worker, multiple developers
hitting the same cache - just don't make it the only place development
happens.

## Known limitations

- `/api/metrics` and `/api/schedule/all` don't exist in this codebase -
  there's nothing to protect or document for routes that were never built.
- Alchemy's free tier caps at 300 `token_price` requests/hour - this is
  usually the first thing to break under load, not the app itself.
- Date computations throughout the app (the historical-prices range switch,
  the worker's day-window walk) are UTC-anchored on purpose, not by
  accident - `src/lib/dateRange.ts`'s local-time equivalents used to
  silently shift computed boundaries depending on the server process's
  timezone (wrong calendar month near a month boundary under a negative
  UTC offset; drifting off UTC-midnight across a DST transition). `npm run
  test:tz-adversarial` runs a suite specifically under
  `TZ=America/Los_Angeles` to catch a regression of this class of bug -
  it's deliberately not part of the default `npm test`, which pins
  `TZ=UTC` for reproducibility.

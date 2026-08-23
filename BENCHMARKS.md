# Benchmarks

Numbers produced by `scripts/benchmark.mjs` against a real, running instance
of this app (`npm run dev`, real Redis, real MongoDB, real Alchemy key) - see
the comment block at the top of that script for exact methodology, and the
README's "Benchmarking" section for how to reproduce a run.

**What's recorded per run**: date, commit SHA, machine, network conditions,
token set, concurrency, request count, and P50/P95/P99 for each path
measured (cold / warm / bypass), plus the usable-response rate as the
harness defines it: HTTP 200 AND `degraded: false` AND a non-null price.
Numbers are reported as measured - not rounded to look cleaner, not
re-run to chase a specific figure.

**Cold** = first request per token (cache miss, but still pays Redis
GET/lock-acquire overhead). **Warm** = repeat request for the same
(token, network, startTime) tuple (cache hit). **Bypass** = cache
infrastructure skipped entirely via `x-bypass-cache` (only measured when
`ALLOW_CACHE_BYPASS=true` is set server-side) - the true no-cache
baseline that cold/warm is compared against.

---

## Runs

### Run 1 — 2026-08-18 — DISCARDED (not reported)

Discarded before any numbers were recorded, for two independent reasons.
Recording it here because a discarded run with its cause documented is more
useful than a silently clean file — both failures are ones a future run
should guard against.

1. **The `x-bypass-cache` header never reached the server process.**
   `ALLOW_CACHE_BYPASS=true` had been set as a shell export in the terminal
   the operator *thought* was running `npm run dev`, but the actual server
   process didn't have it in its environment (shell exports only reach
   processes launched from that same shell). So `/api/price` treated the
   header as the intended silent no-op, and all 20 bypass-phase requests
   went through the normal cache path instead of bypassing. The harness's
   own bypass self-verification caught this — every "bypass" response came
   back tagged `cache: "stale"` rather than `cache: "bypass-header"`, and
   the run aborted rather than reporting cache-path latencies mislabeled as
   an uncached baseline. **Fix:** put `ALLOW_CACHE_BYPASS=true` as a literal
   line in `.env` (not a shell export) and fully restart the server.

2. **The discarded bypass phase also silently spent quota via background
   revalidation.** Because those 20 requests hit the *normal* path against
   current-price keys that the cold+warm phases had populated and let
   soft-expire (30s soft TTL), each one served stale data immediately and
   fired a fire-and-forget background revalidation — ~20 upstream Alchemy
   calls that never showed up as request latency, on top of the cold
   phase's own ~40–80 calls. This is not a bug in the bypass implementation
   itself (a genuinely-bypassing request calls `currentPrice()` /
   `fetchHistoryWithFallback()` directly and never enters
   `getWithSingleFlight`, so it can't trigger revalidation — confirmed by
   reading `src/app/api/price/route.ts`); the invisible spend was a
   downstream consequence of failure (1), i.e. of the requests silently
   falling back to the cached path.

A third, unrelated harness defect surfaced too: the orchestration script
only wrote results at the very end, so aborting on the bypass check
destroyed the already-collected (and already-quota-spending) cold and warm
data. Run 2's script fixes all three: a 1-request bypass **smoke test**
runs before any quota-spending phase (so a misconfigured
`ALLOW_CACHE_BYPASS` costs 1 request to detect, not 20 + a lost cold
phase), per-phase results are **persisted to disk immediately** after each
phase, and the benchmark tokens' keys are **flushed before the bypass phase
too**, not only before cold.

**Rough quota spent by the discarded run 1:** ~45–105 Alchemy calls (cold
~40–80, background revalidations ≤~20, warm 0). Well under the 300/hour
ceiling — disclosed rather than treated as free, since it can't be measured
exactly (the app exposes no per-call Alchemy counter).

### Run 2 — 2026-08-18 — DISCARDED (not reported)

The config fix from run 1 worked — the bypass smoke test confirmed
`cache: "bypass-header"`, so the header now reaches the server. Cold (n=20)
and warm (n=50) completed at a nominal 100% usable-response rate and were
persisted to disk. But inspecting the persisted per-request data before
reporting surfaced a **methodology defect in the benchmark itself**, so
these numbers are discarded rather than reported:

- **`startTime` was set to `now`, for which the history path cannot
  resolve.** Alchemy has no indexed price for the current instant, and the
  interpolation fallback needs an "after" data point that lies in the
  future — so `fetchHistoryWithFallback` threw on *every* request. The
  route caught it and fell back to using the *current* price as the history
  value (`method: "current fallback"`, which it does not flag as
  `degraded`). So "100% usable" was counting current-price fallbacks, not
  real historical resolutions — every response's `History.cache` was
  `undefined` (never set on the throw path), the tell that gave this away.
- **Consequence 1 — "warm" was never a real cache hit.** Because history
  never resolved, it never got cached, so every warm request re-ran the
  doomed history path (~3 failing Alchemy calls each). Warm's measured
  ~2.6s is "current-price cache hit + 3 wasted upstream history attempts,"
  not cache-hit latency.
- **Consequence 2 — the invisible history calls exhausted the quota.** The
  warm phase, planned as free (0 Alchemy calls, all cache hits), actually
  spent ~150 calls (50 requests × ~3 failing history attempts). That, on
  top of cold (~80) and run 1's spend, blew through the 300/hour
  `token_price` ceiling. The bypass phase then failed 100% — not for the
  header reason (the smoke test had passed) but because Alchemy had started
  refusing `token_price` calls: current price came back `null` on both
  normal and bypass paths, confirmed by a follow-up diagnostic request.

**Fix for run 3:** use a fixed *past* `startTime` (30 days ago for
cold/warm, 60 for bypass, 90 for the probe) where Alchemy has real
historical data on both sides, so the history path resolves and caches —
making warm a genuine cache hit and cutting quota back to the planned
budget. (Confirmed viable by an earlier one-off diagnostic: a 2023
timestamp resolves history via interpolation cleanly.)

**Rough quota spent by discarded run 2:** ~230+ `token_price` calls (cold
~80, warm ~150 unplanned, smoke/bypass remainder) — the run that pushed
cumulative usage past the hourly ceiling.

### Run 3 — 2026-08-20 — RECORDED

| Field | Value |
|---|---|
| Date | 2026-08-20 (UTC) |
| Commit | `d679b95` (working tree; benchmark tooling + Task 7 auth uncommitted at run time) |
| Machine | AMD Ryzen 5 4600H (12 logical cores), 16.6 GB RAM, Windows 11 (10.0.26200), Node v22.16.0 |
| Network | Home broadband. Alchemy reached over WAN; **Redis is a remote/cloud instance, not local** — this matters for the cold-path result below. |
| Server mode | `next dev` (development). **Dev-mode latency overstates a production build substantially** — Next.js dev does no route optimization and compiles on demand. Treat every absolute number here as an upper bound; the *relative* comparison (warm vs bypass) is the durable finding, not the raw milliseconds. |
| Token set | `scripts/tokens/mainnet-top20.json` — 20 real, externally-verified mainnet ERC-20s |
| `startTime` | Fixed past timestamps (30 days ago cold/warm, 60 bypass) so the history path resolves and caches — see run 2's discard for why `now` was wrong |
| Concurrency | 5 (cold), 8 (warm), 5 (bypass) |
| Rate-limit handling | Window boundary waited between phases; no client-side governor; 0 rate-limit (429) responses observed |

**Results** (latency in ms; "usable" = HTTP 200 AND `degraded:false` AND non-null price):

| Phase | N | P50 | P95† | min | max | mean | usable | errors |
|---|---|---|---|---|---|---|---|---|
| **Cold** (cache miss, populates cache) | 20 | 4167 | 5165 | 3459 | 5260 | 4293 | 100% | 0 |
| **Warm** (cache hit) | 50 | 817 | 883 | 720 | 1014 | 812 | 100% | 0 |
| **Bypass** (cache skipped, `x-bypass-cache`) | 20 | 2238 | 3162 | 1641 | 3738 | 2366 | 100% | 0 |

† **No P99 reported.** The cold and bypass phases are N=20; at that size a
P95 is already just "the second-worst of 20 samples" and a P99 would be
indistinguishable from the max. Reporting one would imply a precision the
sample size doesn't support.

**Headline — warm vs bypass (cache hit vs. no cache at all):**

> **Warm P95 883 ms vs bypass P95 3162 ms — the cache hit is 72.1% faster
> (the uncached path is 3.58× slower). At P50: 817 ms vs 2238 ms, 63.5%
> faster.**

This is the clean measure of what the cache buys, because warm and bypass
differ only in whether the cache is consulted — bypass provably does zero
cache I/O (verified: all 20 bypass responses tagged `cache:"bypass-header"`),
so it's the true "just call Alchemy every time" baseline.

**The surprising result — cold is slower than bypass (4167 ms vs 2238 ms
P50), even though neither benefits from a cache hit.** This is
counterintuitive (a cache miss looks *worse* than having no cache) and worth
understanding rather than glossing. It was isolated, not guessed: firing
bypass requests at cold's *own* 30-day timestamp still returned ~1700–4100 ms
(median ~2783 ms) — the same range as the 60-day bypass phase — so the gap is
**not** a timestamp artifact. The cause is the single-flight cache machinery
itself: a cold request does the full Redis dance (GET miss → `SET NX` lock →
`SET` write → `EVAL` release) for *both* the current-price and history keys,
~8–10 round trips to a **remote/cloud Redis**, on top of the same Alchemy
calls bypass makes alone. Bypass skips all of it. So the single-flight design
trades ~1.8 s of extra miss-path latency for stampede protection and fast
hits — an excellent trade for a high-hit-rate workload (warm is 5× faster
than cold), a net latency cost for mostly-unique-key traffic (though the
stampede protection still has value there). This is a real property of the
architecture, surfaced by the benchmark, not a defect.

**Distribution notes:**
- **Warm is tight and unimodal** (720–1014 ms, P95 only 1.08× the min) —
  cache hits are consistent, as expected; the ~0.8 s floor is itself remote-
  Redis round-trip time, not compute.
- **Cold shows a first-request effect**: the first 4 requests (5165, 4804,
  5260, 5070 ms) are the slowest, settling to ~4000 ms after — consistent
  with dev-mode on-demand compilation of the route on first hit.
- **Bypass has the widest spread** (1641–3738 ms) — pure Alchemy latency
  variance with no cache to smooth it.

**Honest limitations.** This is a low-concurrency latency benchmark (5–8) on
a single machine from a single location, against a `next dev` server whose
absolute latencies run well above a production build, with a *remote* Redis
that inflates every cache-path round trip (a local Redis would shrink the
cold penalty and the warm floor substantially). The N=20 cold/bypass phases
give coarse percentiles — a P95 there is the second-worst sample. The
usable-response rate is measured over this run's own generated traffic in its
own short window; it is **not** a production availability figure, which would
require continuous instrumentation over real traffic. The numbers are
reported exactly as measured — one recorded run, no phase re-run to shop for
a rounder figure (the two earlier discarded runs were thrown out for
methodology/config defects documented above, not for producing unflattering
numbers).

### Tooling verification (not a benchmark run)

Before any live run, the harness itself was verified with dry runs
(`--confirm-quota-spend` omitted, so no requests were sent):

- Plan computation for the default real-token set (20 tokens,
  `requestsPerToken=10`): 20 cold + 180 warm + 0 bypass = 200 requests,
  40-80 worst/best-case Alchemy calls (13.3%-26.7% of the 300/hour quota).
- Plan computation with `--bypass-cache` added: 20 cold + 180 warm + 20
  bypass = 220 requests, 80-160 worst/best-case Alchemy calls
  (26.7%-53.3% of quota).
- `--synthetic --tokens N` and `--tokens-file <path>` both load and
  validate correctly; a malformed address in a tokens file is rejected
  before any request is sent, not discovered mid-run.
- Missing `API_KEY` (env or `--api-key`) fails fast with exit code 1
  before attempting to load tokens or contact the server.
- `src/app/api/price/route.test.ts` covers the server-side half of
  `--bypass-cache`: the header is a no-op unless `ALLOW_CACHE_BYPASS=true`,
  a bypassed request never writes a cache entry, and the bypass header is
  not an auth bypass (still 401s without a valid key/session).

#!/usr/bin/env node
// Latency/availability benchmark harness for POST /api/price.
//
// Run this against a *real, running* instance of the app (e.g. `npm run dev`
// in one terminal, this script in another) - it cannot be run standalone,
// and it deliberately does not mock anything: the numbers it prints are only
// as honest as the environment you point it at.
//
// Usage:
//   node scripts/benchmark.mjs --confirm-quota-spend
//   node scripts/benchmark.mjs --confirm-quota-spend --bypass-cache
//   node scripts/benchmark.mjs --synthetic --tokens 50 --confirm-quota-spend
//   node scripts/benchmark.mjs --tokens-file ./my-tokens.json --confirm-quota-spend
//
// Auth: since Task 7 locked these routes down, every request needs a valid
// x-api-key. Read from the API_KEY env var by default (chosen over a
// required --api-key flag so the key never lands in shell history or a
// `ps`/process-list snapshot - the same reasoning the rest of this codebase
// applies to ALCHEMY_API_KEY/MONGODB_URI). --api-key is still accepted as an
// explicit override for one-off runs where that tradeoff is acceptable.
//
// What it measures:
//   - "cold" requests: the first request for a given (token, network, startTime)
//     tuple - guaranteed cache miss, so this is your uncached-path latency
//     (but still pays Redis GET/lock-acquire overhead on the way to the miss).
//   - "warm" requests: every subsequent request for the same tuple - these hit
//     the single-flight cache and should land in the "fresh" or "stale" path.
//   - "bypass" requests (only with --bypass-cache, and only if the server has
//     ALLOW_CACHE_BYPASS=true set): skip the cache layer entirely via the
//     x-bypass-cache header, calling Alchemy directly on every request, not
//     just the first. This is the true no-cache-infrastructure-at-all
//     baseline - the "before" number the cold/warm comparison is measured
//     against.
//   - availability: fraction of requests that returned a *usable* price
//     (HTTP 200, not `degraded`, no thrown/network error) - not just HTTP 200,
//     since this API returns 200 even when it has nothing useful to say.
//
// Quota discipline: cold and bypass requests spend real Alchemy token_price
// quota (300/hour free tier, shared with the worker's own backfill traffic).
// This script computes and prints the full request/quota plan up front and
// refuses to run the quota-spending phases (cold, bypass) without an
// explicit --confirm-quota-spend flag - see printPlan() below. Warm requests
// don't call Alchemy at all (cache hit), but they DO count against the
// server's per-key rate limit (60/60s on this route, regardless of cache
// hit/miss), so this script self-throttles every phase - cold, warm, and
// bypass alike - to stay under that limit. See RateGovernor.
//
// A single run of this script measures availability over ITS OWN window
// (the duration of the run against the traffic it generated). That is not
// the same claim as "99.9% availability" in production, which requires
// continuous instrumentation over real traffic - see the accompanying
// writeup for why these are different claims.

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOKENS_FILE = path.join(__dirname, "tokens", "mainnet-top20.json");

// Mirrors the route's own validation (src/lib/validation.ts) - duplicated
// rather than imported because this is a plain .mjs script and that file is
// TypeScript; kept in sync by inspection, not by a build step.
const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

// Must match (or stay under) src/app/api/price/route.ts's RATE_LIMIT.limit
// (60 per 60s at the time of writing). Set below that, not at it, so clock
// skew between this process and the server, or a slightly-early window
// rollover, doesn't tip a request over the server's real ceiling and turn
// into a 429 that corrupts the latency samples (a 429 is fast and would
// otherwise silently pull percentiles down while also being reported as
// unusable - misleading in both directions at once).
const DEFAULT_RATE_LIMIT_PER_MINUTE = 55;

// Worst/best case Alchemy calls per cold or bypass /api/price request - see
// route.ts: 1 call for currentPrice, plus for history either 1 call (exact
// match on the tight 60s window) or 3 calls (failed exact match + parallel
// before/after interpolation fetches).
const BEST_CASE_CALLS_PER_REQUEST = 2;
const WORST_CASE_CALLS_PER_REQUEST = 4;
const ALCHEMY_HOURLY_QUOTA = 300;

function parseArgs(argv) {
  const args = {
    url: "http://localhost:3000",
    tokensFile: DEFAULT_TOKENS_FILE,
    synthetic: false,
    tokens: undefined, // undefined = use every token in the file; required (with a default) for --synthetic
    requestsPerToken: 10,
    concurrency: 10,
    apiKey: process.env.API_KEY,
    bypassCache: false,
    confirmQuotaSpend: false,
    rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
    network: "ethereum", // only used by --synthetic
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--synthetic") {
      args.synthetic = true;
      continue;
    }
    if (arg === "--bypass-cache") {
      args.bypassCache = true;
      continue;
    }
    if (arg === "--confirm-quota-spend") {
      args.confirmQuotaSpend = true;
      continue;
    }
    const key = arg?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) {
      args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i++;
    }
  }
  if (args.tokens !== undefined) args.tokens = Number(args.tokens);
  args.requestsPerToken = Number(args.requestsPerToken);
  args.concurrency = Number(args.concurrency);
  args.rateLimitPerMinute = Number(args.rateLimitPerMinute);
  return args;
}

function loadRealTokens(filePath, limit) {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${filePath} must contain a non-empty JSON array of { address, network } objects`);
  }
  const tokens = parsed.map((entry, i) => {
    if (!entry || typeof entry.address !== "string" || typeof entry.network !== "string") {
      throw new Error(`${filePath}[${i}] must have string "address" and "network" fields, got: ${JSON.stringify(entry)}`);
    }
    if (!TOKEN_ADDRESS_PATTERN.test(entry.address)) {
      throw new Error(`${filePath}[${i}].address "${entry.address}" is not a valid 0x + 40 hex char address`);
    }
    return { address: entry.address, network: entry.network, symbol: entry.symbol };
  });
  return limit ? tokens.slice(0, limit) : tokens;
}

function generateSyntheticTokens(count, network) {
  // Synthetic but distinct addresses so each gets its own cache key - the
  // right tool for load testing (unique keys are the point), the wrong tool
  // for realistic latency numbers (Alchemy has no data for these, so every
  // request short-circuits to degraded:true almost immediately instead of
  // exercising the real upstream call path).
  return Array.from({ length: count }, (_, i) => ({
    address: "0x" + i.toString(16).padStart(40, "0"),
    network,
  }));
}

function percentile(sortedLatencies, p) {
  if (sortedLatencies.length === 0) return NaN;
  const idx = Math.min(
    sortedLatencies.length - 1,
    Math.ceil((p / 100) * sortedLatencies.length) - 1
  );
  return sortedLatencies[Math.max(0, idx)];
}

function summarize(label, samples) {
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const usable = samples.filter((s) => s.usable).length;
  const httpOk = samples.filter((s) => s.httpOk).length;
  const errorKinds = {};
  for (const s of samples) {
    if (s.errorKind) errorKinds[s.errorKind] = (errorKinds[s.errorKind] || 0) + 1;
  }
  console.log(`\n--- ${label} (n=${samples.length}) ---`);
  if (samples.length === 0) {
    console.log("  no samples");
    return;
  }
  console.log(`  P50: ${percentile(latencies, 50).toFixed(1)}ms`);
  console.log(`  P95: ${percentile(latencies, 95).toFixed(1)}ms`);
  console.log(`  P99: ${percentile(latencies, 99).toFixed(1)}ms`);
  console.log(`  max: ${latencies[latencies.length - 1].toFixed(1)}ms`);
  console.log(`  HTTP 200 rate: ${((httpOk / samples.length) * 100).toFixed(2)}% (this alone is NOT availability - see below)`);
  console.log(`  usable-response availability: ${((usable / samples.length) * 100).toFixed(2)}% (HTTP 200 AND degraded:false AND a non-null price)`);
  if (Object.keys(errorKinds).length) {
    console.log(`  error breakdown: ${JSON.stringify(errorKinds)}`);
  }
}

// Self-throttles to the server's own per-key fixed-window rate limit
// (src/lib/rateLimit.ts) so this script's own traffic never trips a 429
// against itself - a 429 would be fast (no upstream call) and would
// corrupt both the latency percentiles and the usable-response rate with a
// failure mode that has nothing to do with what's actually being measured.
class RateGovernor {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.windowBucket = null;
    this.countInWindow = 0;
  }
  async acquire() {
    for (;;) {
      const bucket = Math.floor(Date.now() / 1000 / 60);
      if (bucket !== this.windowBucket) {
        this.windowBucket = bucket;
        this.countInWindow = 0;
      }
      if (this.countInWindow < this.maxPerMinute) {
        this.countInWindow++;
        return;
      }
      const msUntilNextWindow = (bucket + 1) * 60 * 1000 - Date.now() + 50;
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, msUntilNextWindow)));
    }
  }
}

async function fireRequest(url, apiKey, coinId, network, startTime, { bypass } = {}) {
  const start = performance.now();
  let httpOk = false;
  let usable = false;
  let errorKind = null;
  let cacheSource = { current: undefined, history: undefined };
  try {
    const headers = { "Content-Type": "application/json", "x-api-key": apiKey };
    if (bypass) headers["x-bypass-cache"] = "1";
    const res = await fetch(`${url}/api/price`, {
      method: "POST",
      headers,
      body: JSON.stringify({ coinId, network, startTime }),
      signal: AbortSignal.timeout(15000),
    });
    httpOk = res.status === 200;
    if (httpOk) {
      const data = await res.json();
      usable =
        data.success === true &&
        data.degraded !== true &&
        (data.History?.price !== null && data.History?.price !== undefined);
      if (!usable) errorKind = "degraded-200";
      cacheSource = { current: data.Current?.cache, history: data.History?.cache };
    } else {
      errorKind = `http-${res.status}`;
    }
  } catch (err) {
    errorKind = err?.name === "TimeoutError" ? "timeout" : "network-error";
  }
  const latencyMs = performance.now() - start;
  return { latencyMs, httpOk, usable, errorKind, cacheSource };
}

async function runPool(tasks, concurrency) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function printPlan(args, tokens) {
  const coldCount = tokens.length;
  const warmCount = tokens.length * (args.requestsPerToken - 1);
  const bypassCount = args.bypassCache ? tokens.length : 0;
  const quotaSpendingRequests = coldCount + bypassCount;

  const bestCase = quotaSpendingRequests * BEST_CASE_CALLS_PER_REQUEST;
  const worstCase = quotaSpendingRequests * WORST_CASE_CALLS_PER_REQUEST;

  console.log("=== Benchmark plan ===");
  console.log(`  tokens:            ${tokens.length} (${args.synthetic ? "synthetic" : args.tokensFile})`);
  console.log(`  cold requests:     ${coldCount} (1 per token - quota-spending)`);
  console.log(`  warm requests:     ${warmCount} (cache hit - free, 0 Alchemy calls)`);
  console.log(`  bypass requests:   ${bypassCount}${args.bypassCache ? " (1 per token - quota-spending, every request)" : " (--bypass-cache not set)"}`);
  console.log(`  total requests:    ${coldCount + warmCount + bypassCount}`);
  console.log("");
  console.log(`  upstream Alchemy calls = quota-spending requests (${quotaSpendingRequests}) x calls-per-request:`);
  console.log(`    best case  (exact historical match hits): ${quotaSpendingRequests} x ${BEST_CASE_CALLS_PER_REQUEST} = ${bestCase} calls`);
  console.log(`    worst case (falls back to interpolation): ${quotaSpendingRequests} x ${WORST_CASE_CALLS_PER_REQUEST} = ${worstCase} calls`);
  console.log(`  Alchemy free-tier ceiling: ${ALCHEMY_HOURLY_QUOTA}/hour (shared with any running worker backfill)`);
  console.log(
    `  worst-case usage: ${worstCase}/${ALCHEMY_HOURLY_QUOTA} = ${((worstCase / ALCHEMY_HOURLY_QUOTA) * 100).toFixed(1)}% ` +
      `(${ALCHEMY_HOURLY_QUOTA - worstCase} calls of headroom remaining for the worker's pacer and anything else)`
  );
  console.log(
    `  self-throttled to ${args.rateLimitPerMinute} requests/60s to stay under the server's own per-key rate limit ` +
      `(this bounds wall-clock time, not quota - see RateGovernor)`
  );
  console.log("=======================\n");

  return { coldCount, warmCount, bypassCount, quotaSpendingRequests, worstCase };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.apiKey) {
    console.error(
      "No API key provided. Set the API_KEY env var (recommended) or pass --api-key <key>. " +
        "This must be one of the values configured in the server's API_KEYS env var."
    );
    process.exit(1);
  }

  const tokens = args.synthetic
    ? generateSyntheticTokens(args.tokens ?? 20, args.network)
    : loadRealTokens(args.tokensFile, args.tokens);

  console.log(`Benchmarking ${args.url}/api/price`);
  console.log(`requestsPerToken=${args.requestsPerToken} concurrency=${args.concurrency} bypassCache=${args.bypassCache}\n`);

  const plan = printPlan(args, tokens);

  if (plan.quotaSpendingRequests > 0 && !args.confirmQuotaSpend) {
    console.log(
      "Quota-spending phases (cold" + (args.bypassCache ? ", bypass" : "") + ") were NOT run.\n" +
        "Re-run with --confirm-quota-spend once this plan has been reviewed and approved."
    );
    return;
  }

  const governor = new RateGovernor(args.rateLimitPerMinute);
  const paced = (task) => async () => {
    await governor.acquire();
    return task();
  };

  const coldTasks = [];
  const warmTasks = [];
  const bypassTasks = [];

  for (const token of tokens) {
    const startTime = Math.floor(Date.now() / 1000).toString();
    coldTasks.push(paced(() => fireRequest(args.url, args.apiKey, token.address, token.network, startTime)));
    for (let r = 1; r < args.requestsPerToken; r++) {
      warmTasks.push(paced(() => fireRequest(args.url, args.apiKey, token.address, token.network, startTime)));
    }
    if (args.bypassCache) {
      // Distinct startTime from the cold/warm tuple above so a bypass
      // request can never be served by a cache entry the cold request just
      // wrote - it's measuring "no cache in the picture", not "cache miss
      // because of a fresh key that happens to also be untouched by bypass".
      const bypassStartTime = (Math.floor(Date.now() / 1000) - 3600).toString();
      bypassTasks.push(
        paced(() => fireRequest(args.url, args.apiKey, token.address, token.network, bypassStartTime, { bypass: true }))
      );
    }
  }

  // Cold requests first (and pooled, not per-token-sequential) so every
  // token's first hit is a genuine miss before any warm requests for that
  // same token are issued.
  const coldResults = await runPool(coldTasks, args.concurrency);
  const warmResults = await runPool(warmTasks, args.concurrency);

  let bypassResults = [];
  if (args.bypassCache) {
    bypassResults = await runPool(bypassTasks, args.concurrency);
    const confirmedBypass = bypassResults.filter(
      (r) => r.cacheSource.current === "bypass-header" || r.cacheSource.history === "bypass-header"
    ).length;
    if (confirmedBypass === 0) {
      console.error(
        "\n⚠️  WARNING: none of the bypass-phase responses show cache:\"bypass-header\". " +
          "The server likely does not have ALLOW_CACHE_BYPASS=true set, so the x-bypass-cache header " +
          "was silently ignored and these 'bypass' numbers are actually just normal cached/cold requests - " +
          "do not report them as an uncached baseline."
      );
    } else if (confirmedBypass < bypassResults.length) {
      console.error(
        `\n⚠️  WARNING: only ${confirmedBypass}/${bypassResults.length} bypass-phase responses confirm cache:"bypass-header" - ` +
          "the rest may have hit an error path before reaching the cache-source assignment. Inspect before reporting."
      );
    }
  }

  summarize("COLD (cache miss - first request per token)", coldResults);
  summarize("WARM (cache hit - repeat requests)", warmResults);
  if (args.bypassCache) {
    summarize("BYPASS (cache skipped entirely - x-bypass-cache)", bypassResults);
  }
  summarize("ALL", [...coldResults, ...warmResults, ...bypassResults]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

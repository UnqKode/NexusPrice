#!/usr/bin/env node
// Latency/availability benchmark harness for POST /api/price.
// Run this against a *real, running* instance of the app 
// Usage:
//   node scripts/benchmark.mjs --confirm-quota-spend
//   node scripts/benchmark.mjs --confirm-quota-spend --bypass-cache
//   node scripts/benchmark.mjs --synthetic --tokens 50 --confirm-quota-spend
//   node scripts/benchmark.mjs --tokens-file ./my-tokens.json --confirm-quota-spend
//
// What it measures:
//   - "cold" requests: the first request for a given (token, network, startTime)
//   - "warm" requests: every subsequent request for the same tuple 
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


// Architecture Diagram for this file
//Command line
//      ↓
// parseArgs()
//      ↓
// Configuration
//      ↓
// Load/generate tokens
//      ↓
// printPlan()
//      ↓
// RateGovernor
//      ↓
// Create tasks
//      ↓
// ┌──────────────┬──────────────┬──────────────┐
// │     COLD     │     WARM     │    BYPASS    │
// │ cache miss   │ cache hit    │ no cache     │
// └──────────────┴──────────────┴──────────────┘
//      ↓
// runPool()
//      ↓
// fireRequest()
//      ↓
// Collect latency/results
//      ↓
// summarize()
//      ↓
// P50 / P95 / P99 / availability
// | Percentile | Meaning                        |
// | ---------- | ------------------------------ |
// |   P50      | 50% of requests ≤ this latency |
// |   P95      | 95% of requests ≤ this latency |
// |   P99      | 99% of requests ≤ this latency |


import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOKENS_FILE = path.join(__dirname, "tokens", "mainnet-top20.json");
const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 55;

// Worst/best case Alchemy calls per cold or bypass /api/price request - see
// route.ts: 1 call for currentPrice, plus for history either 1 call (exact
// match on the tight 60s window) or 3 calls (failed exact match + parallel
// before/after interpolation fetches).
const BEST_CASE_CALLS_PER_REQUEST = 2;
const WORST_CASE_CALLS_PER_REQUEST = 4;
const ALCHEMY_HOURLY_QUOTA = 300;

// a custom argument parser for command line inputs
function parseArgs(argv) {
  const args = {
    url: "http://localhost:3000",
    tokensFile: DEFAULT_TOKENS_FILE, // file in public folder and token subfolder
    synthetic: false, 
    tokens: undefined, // undefined = use every token in the file; required for --synthetic
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
      args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; // the replace function converts --requests-per-token to requestsPerToken
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
  //functiont to read file from scripts/tokens/mainnet-top20.json
  //read LIMIT token and return them to main functions
  const raw = readFileSync(filePath, "utf-8"); // converts the file into string because of utf-8
  const parsed = JSON.parse(raw); // converts it back to json array
  if (!Array.isArray(parsed) || parsed.length === 0) { // check wether file is in array format or not
    throw new Error(`${filePath} must contain a non-empty JSON array of { address, network } objects`);
  }
  const tokens = parsed.map((entry, i) => { // a validation function for all tokens in file
    if (!entry || typeof entry.address !== "string" || typeof entry.network !== "string") {
      throw new Error(`${filePath}[${i}] must have string "address" and "network" fields, got: ${JSON.stringify(entry)}`);
    }
    if (!TOKEN_ADDRESS_PATTERN.test(entry.address)) {//check valid address pattern that is 0x and then 40 chars
      throw new Error(`${filePath}[${i}].address "${entry.address}" is not a valid 0x + 40 hex char address`);
    }
    return { address: entry.address, network: entry.network, symbol: entry.symbol };
  });
  return limit ? tokens.slice(0, limit) : tokens;
}

function generateSyntheticTokens(count, network) {
  // Synthetic but distinct addresses so each gets its own cache key 
  return Array.from({ length: count }, (_, i) => ({
    address: "0x" + i.toString(16).padStart(40, "0"),
    network,
  }));
}

//a basic function to print the whole plan about what we're about to do, before benchmarking it 
function printPlan(args, tokens) {
  const coldCount = tokens.length;
  const warmCount = tokens.length * (args.requestsPerToken - 1); // the number of requests that happen after the first request for each token, where the result is expected to already be in the cache.
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

//A rate Limiter, make sure program doesnt perform more than maxPerMinute operation in a given minute
class RateGovernor {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.windowBucket = null;
    this.countInWindow = 0;
  }

  async acquire() {
    for (;;) {
      const bucket = Math.floor(Date.now() / 1000 / 60);
      // each minute is a different bucket
      if (bucket !== this.windowBucket) {
        this.windowBucket = bucket;
        this.countInWindow = 0;
      }
      if (this.countInWindow < this.maxPerMinute) {
        this.countInWindow++;
        return;
      }
      const msUntilNextWindow = (bucket + 1) * 60 * 1000 - Date.now() + 50;
      //how many milisecons untill the next minute begins
      //50 added because it adds a small buffer , so no timing precision error occurs
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, msUntilNextWindow)));
      //sleep untill next window
    }
  }
}

//A simple function to fire api call and measure latency, errorKin etc
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
      signal: AbortSignal.timeout(15000), // dont let this request run longer than 15 sec
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

async function main() {
  const args = parseArgs(process.argv.slice(2)); //because the general script starts like node scripts/benchmark.mjs --synthetic --tokens 50 --confirm-quota-spend so we slice to start after benchmark.mjs
  //parseArgs is a function created above
  // it returns something like this 
  //  const args = {
  //   url: "http://localhost:3000",
  //   tokensFile: DEFAULT_TOKENS_FILE, 
  //   synthetic: false, 
  //   tokens: undefined, 
  //   requestsPerToken: 10,
  //   concurrency: 10,
  //   apiKey: process.env.API_KEY,
  //   bypassCache: false,
  //   confirmQuotaSpend: false,
  //   rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
  //   network: "ethereum", 
  // };
  if (!args.apiKey) {
    console.error(
      "No API key provided. Set the API_KEY env var (recommended) or pass --api-key <key>. " +
        "This must be one of the values configured in the server's API_KEYS env var."
    );
    process.exit(1);
  }

  const tokens = args.synthetic ? generateSyntheticTokens(args.tokens ?? 20, args.network) : loadRealTokens(args.tokensFile, args.tokens);
  //token looks like this
  // [{ address: "....", network: "....", symbol: "...." }]

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

  const governor = new RateGovernor(args.rateLimitPerMinute); // creating an object of class RateGorvernor

  //paced() is a function that takes another function as a inpute and return a new function.
  const paced = (task) => async () => {
    await governor.acquire();
    return task();
  };

  const coldTasks = [];
  const warmTasks = [];
  const bypassTasks = [];

  for (const token of tokens) {
    const startTime = Math.floor(Date.now() / 1000).toString();
    coldTasks.push(paced(() => fireRequest(args.url, args.apiKey, token.address, token.network, startTime))); // pushed fucntion in array coldTasks
    for (let r = 1; r < args.requestsPerToken; r++) {
      warmTasks.push(paced(() => fireRequest(args.url, args.apiKey, token.address, token.network, startTime)));  // pushed fucntion in array warmTasks
    }
    if (args.bypassCache) {
      // it's measuring "no cache in the picture", not "cache miss
      // because of a fresh key that happens to also be untouched by bypass".
      const bypassStartTime = (Math.floor(Date.now() / 1000) - 3600).toString();
      bypassTasks.push(
        paced(() => fireRequest(args.url, args.apiKey, token.address, token.network, bypassStartTime, { bypass: true }))
      );  // pushed fucntion in array bypassStartTime
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

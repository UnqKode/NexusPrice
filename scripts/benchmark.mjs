#!/usr/bin/env node
// Latency/availability benchmark harness for POST /api/price.
//
// Run this against a *real, running* instance of the app (e.g. `npm run dev`
// in one terminal, this script in another) - it cannot be run standalone,
// and it deliberately does not mock anything: the numbers it prints are only
// as honest as the environment you point it at.
//
// Usage:
//   node scripts/benchmark.mjs --url http://localhost:3000 --tokens 20 --requestsPerToken 10 --concurrency 10
//
// What it measures:
//   - "cold" requests: the first request for a given (token, network, startTime)
//     tuple - guaranteed cache miss, so this is your uncached-path latency.
//   - "warm" requests: every subsequent request for the same tuple - these hit
//     the single-flight cache and should land in the "fresh" or "stale" path.
//   - availability: fraction of requests that returned a *usable* price
//     (HTTP 200, not `degraded`, no thrown/network error) - not just HTTP 200,
//     since this API returns 200 even when it has nothing useful to say.
//
// A single run of this script measures availability over ITS OWN window
// (the duration of the run against the traffic it generated). That is not
// the same claim as "99.9% availability" in production, which requires
// continuous instrumentation over real traffic - see the accompanying
// writeup for why these are different claims.

import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const args = { url: "http://localhost:3000", tokens: 20, requestsPerToken: 10, concurrency: 10 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) args[key] = value;
  }
  args.tokens = Number(args.tokens);
  args.requestsPerToken = Number(args.requestsPerToken);
  args.concurrency = Number(args.concurrency);
  return args;
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
}

// Synthetic but distinct token addresses so each gets its own cache key.
function fakeTokenAddress(i) {
  return "0x" + i.toString(16).padStart(40, "0");
}

async function fireRequest(url, coinId, network, startTime) {
  const start = performance.now();
  let httpOk = false;
  let usable = false;
  try {
    const res = await fetch(`${url}/api/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    }
  } catch {
    httpOk = false;
    usable = false;
  }
  const latencyMs = performance.now() - start;
  return { latencyMs, httpOk, usable };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Benchmarking ${args.url}/api/price`);
  console.log(`tokens=${args.tokens} requestsPerToken=${args.requestsPerToken} concurrency=${args.concurrency}`);

  const coldTasks = [];
  const warmTasks = [];

  for (let t = 0; t < args.tokens; t++) {
    const coinId = fakeTokenAddress(t);
    const network = "ethereum";
    const startTime = Math.floor(Date.now() / 1000).toString();

    coldTasks.push(() => fireRequest(args.url, coinId, network, startTime));
    for (let r = 1; r < args.requestsPerToken; r++) {
      warmTasks.push(() => fireRequest(args.url, coinId, network, startTime));
    }
  }

  // Cold requests first and sequential-ish per token (still pooled across
  // tokens) so every token's first hit is a genuine miss before any warm
  // requests for that same token are issued.
  const coldResults = await runPool(coldTasks, args.concurrency);
  const warmResults = await runPool(warmTasks, args.concurrency);

  summarize("COLD (cache miss - first request per token)", coldResults);
  summarize("WARM (cache hit - repeat requests)", warmResults);
  summarize("ALL", [...coldResults, ...warmResults]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

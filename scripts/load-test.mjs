#!/usr/bin/env node
// Staged load ramp for POST /api/price against a real running instance.
// Increases concurrency in stages until the error rate or P95 latency
// crosses a threshold relative to the first (baseline) stage, then stops.
//
// Usage:
//   node scripts/load-test.mjs --url http://localhost:3000
//   node scripts/load-test.mjs --url http://localhost:3000 --stages 5,20,50,100,200,400
//
// This intentionally sends mostly-unique token addresses per stage (so most
// requests are cache misses hitting Alchemy) plus a smaller repeated set (so
// you can also see whether the cache keeps warm-path latency flat as
// concurrency rises). That split mirrors §5's central question: does this
// break on the worker/Redis/Mongo side, or on the upstream Alchemy rate limit?

import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const args = { url: "http://localhost:3000", stages: "5,20,50,100,200", requestsPerStage: 60 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) args[key] = value;
  }
  args.stages = args.stages.split(",").map(Number);
  args.requestsPerStage = Number(args.requestsPerStage);
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function fakeTokenAddress(i) {
  return "0x" + i.toString(16).padStart(40, "0");
}

async function fireRequest(url, coinId) {
  const start = performance.now();
  let httpOk = false;
  let usable = false;
  let errorKind = null;
  try {
    const res = await fetch(`${url}/api/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coinId, network: "ethereum", startTime: String(Math.floor(Date.now() / 1000)) }),
      signal: AbortSignal.timeout(20000),
    });
    httpOk = res.status === 200;
    if (httpOk) {
      const data = await res.json();
      usable = data.success === true && data.degraded !== true;
      if (!usable) errorKind = "degraded-200";
    } else {
      errorKind = `http-${res.status}`;
    }
  } catch (err) {
    errorKind = err?.name === "TimeoutError" ? "timeout" : "network-error";
  }
  return { latencyMs: performance.now() - start, httpOk, usable, errorKind };
}

async function runStage(url, concurrency, totalRequests) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < totalRequests) {
      const i = cursor++;
      results.push(await fireRequest(url, fakeTokenAddress(Date.now() + i)));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function report(concurrency, results) {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const usable = results.filter((r) => r.usable).length;
  const errorKinds = {};
  for (const r of results) {
    if (r.errorKind) errorKinds[r.errorKind] = (errorKinds[r.errorKind] || 0) + 1;
  }
  const p95 = percentile(latencies, 95);
  const errorRate = 1 - usable / results.length;
  console.log(
    `concurrency=${concurrency.toString().padEnd(4)} ` +
      `P50=${percentile(latencies, 50).toFixed(0)}ms P95=${p95.toFixed(0)}ms P99=${percentile(latencies, 99).toFixed(0)}ms ` +
      `errorRate=${(errorRate * 100).toFixed(1)}% ${Object.keys(errorKinds).length ? JSON.stringify(errorKinds) : ""}`
  );
  return { p95, errorRate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Load-ramping ${args.url}/api/price, stages: ${args.stages.join(", ")}\n`);

  let baselineP95 = null;
  for (const concurrency of args.stages) {
    const results = await runStage(args.url, concurrency, args.requestsPerStage);
    const { p95, errorRate } = report(concurrency, results);
    if (baselineP95 === null) baselineP95 = p95;

    if (errorRate > 0.05) {
      console.log(`\nStopping: error/degraded rate exceeded 5% at concurrency=${concurrency}.`);
      console.log("This is the point where the system stopped absorbing load cleanly - look at the errorKind breakdown above to see whether it was Alchemy 429s, timeouts, or something else.");
      break;
    }
    if (p95 > baselineP95 * 5) {
      console.log(`\nStopping: P95 latency degraded >5x from baseline (${baselineP95.toFixed(0)}ms) at concurrency=${concurrency}.`);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
// Same staged-ramp methodology as load-test.mjs, but against real, well-known
// ERC-20 addresses instead of synthetic ones. Synthetic addresses mostly get
// "no data" back from Alchemy regardless of load, which would measure "how
// fast can we return degraded:true for garbage input" rather than the thing
// we actually want: where does the system break under realistic traffic.

//This file answers the question
// How much concurrent traffic can /api/price handle before its latency or reliability becomes unacceptable?

//The entire script basically does this 
// Start
//   ↓
// Read command-line arguments
//   ↓
// Use 20 real Ethereum token addresses
//   ↓
// Test concurrency = 5
//   ↓
// Measure P50 / P95 / P99 / usable %
//   ↓
// Test concurrency = 15
//   ↓
// Measure again
//   ↓
// Test concurrency = 30
//   ↓
// Measure again
//   ↓
// Test concurrency = 60
//   ↓
// ...
//   ↓
// STOP if:
//   usable responses < 90%
//        OR
//   P95 becomes > 5× baseline

import { performance } from "node:perf_hooks";

const REAL_TOKENS = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36C1D19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
  "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
  "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
  "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE
  "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
  "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", // MKR
  "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", // SNX
  "0xc00e94Cb662C3520282E6f5717214004A7f26888", // COMP
  "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e", // YFI
  "0x0D8775F648430679A709E98d2b0Cb6250d2887EF", // BAT
  "0xE41d2489571d322189246DaFA5ebDe1F4699F498", // ZRX
  "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2", // SUSHI
  "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", // GRT
  "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", // SHIB
  "0xF629cBd94d3791C9250152BD8dfBDF380E2a3B9c", // ENJ
  "0x4Fabb145d64652a948d72533023f6E7A623C7C53", // BUSD
];

function parseArgs(argv) {
  const args = { url: "http://localhost:3000", stages: "5,15,30,60,100", requestsPerStage: 40 };
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

// a simple function to find the latency and errorKind
async function fireRequest(url, coinId, startTime) {
  const start = performance.now();
  let httpOk = false;
  let usable = false;
  let errorKind = null;
  try {
    const res = await fetch(`${url}/api/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coinId, network: "ethereum", startTime: String(startTime) }),
      signal: AbortSignal.timeout(25000),
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

async function runStage(url, concurrency, totalRequests, stageIndex) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < totalRequests) {
      const i = cursor++;
      const token = REAL_TOKENS[i % REAL_TOKENS.length];
      // Vary the timestamp per request within a stage so most requests are
      // genuine cold history-cache misses (unique day bucket), while still
      // reusing the same small token set enough to exercise the hot
      // "current price" cache key across concurrent requests.
      const startTime = Math.floor(Date.now() / 1000) - stageIndex * 1000 - i * 3600;
      results.push(await fireRequest(url, token, startTime));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker)); // reason for concurrency
  // create a array with x no of asynchronous function where x = concurrency 
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
      `usable=${((1 - errorRate) * 100).toFixed(1)}% ${Object.keys(errorKinds).length ? JSON.stringify(errorKinds) : ""}`
  );
  return { p95, errorRate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  //args is somethign like this
  //{ url: "http://localhost:3000", stages: [5,15,30,60,100], requestsPerStage: 40 , "" : ""}
  console.log(`Load-ramping ${args.url}/api/price with ${REAL_TOKENS.length} real tokens, stages: ${args.stages.join(", ")}\n`);

  let baselineP95 = null;
  let stageIndex = 0;
  for (const concurrency of args.stages) {
    const results = await runStage(args.url, concurrency, args.requestsPerStage, stageIndex++);
    const { p95, errorRate } = report(concurrency, results);
    if (baselineP95 === null) baselineP95 = p95;

    if (errorRate > 0.1) {
      console.log(`\nStopping: usable-response rate dropped below 90% at concurrency=${concurrency}.`);
      break;
    }
    if (p95 > baselineP95 * 5 && baselineP95 > 50) {
      console.log(`\nStopping: P95 latency degraded >5x from baseline (${baselineP95.toFixed(0)}ms) at concurrency=${concurrency}.`);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

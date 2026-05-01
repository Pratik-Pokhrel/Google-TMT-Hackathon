#!/usr/bin/env node
const { performance } = require('perf_hooks');

// Simple synthetic benchmark that models the extension's translation pipeline.
// It simulates: parsing -> splitting into sentences -> making API calls with
// a minimum request gap (rate limit). This helps estimate real-world throughput
// without hitting the actual TMT API.

const MIN_REQUEST_GAP_MS = 1000; // background.js enforces ~1s gap between request starts

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function simulateApiCall(meanLatencyMs) {
  // add small jitter +/-20%
  const jitter = (Math.random() * 0.4 - 0.2) * meanLatencyMs;
  const t = Math.max(5, Math.round(meanLatencyMs + jitter));
  return sleep(t);
}

function parseTextCost(chars) {
  // synthetic parsing cost: roughly linear in characters, but very small
  const start = performance.now();
  // cheap operations to simulate work
  const s = 'a'.repeat(chars);
  const sentences = s.split(/[.!?]+/).filter(Boolean);
  const dur = performance.now() - start;
  return { dur, sentences: sentences.length || 1 };
}

async function runScenario(numSentences, apiLatencyMs, minGapMs = MIN_REQUEST_GAP_MS) {
  const start = performance.now();
  let lastStart = 0;

  for (let i = 0; i < numSentences; i++) {
    // ensure minimum gap between request starts
    const now = performance.now();
    const sinceLast = now - lastStart;
    if (sinceLast < minGapMs) {
      await sleep(minGapMs - sinceLast);
    }
    lastStart = performance.now();
    // start API call (await simulated latency)
    await simulateApiCall(apiLatencyMs);
  }

  const total = performance.now() - start;
  return { total, perSentence: total / numSentences };
}

async function main() {
  const sentenceCounts = [1, 5, 10, 50, 100];
  const latencies = [100, 300, 800, 1500];

  console.log('TMT extension synthetic benchmark');
  console.log('Note: MIN_REQUEST_GAP_MS =', MIN_REQUEST_GAP_MS, 'ms (built-in rate limiting)');
  console.log('This script simulates network latency and the enforced request gap.');
  console.log('---');

  for (const chars of [100, 1000, 5000]) {
    const p = parseTextCost(chars);
    console.log(`Parsing ${chars} chars -> parseTime=${p.dur.toFixed(2)}ms, approxSentences=${p.sentences}`);
  }

  console.log('---');

  const results = [];
  for (const latency of latencies) {
    for (const n of sentenceCounts) {
      const r = await runScenario(n, latency, MIN_REQUEST_GAP_MS);
      results.push({ latency, n, totalMs: r.total, perSentenceMs: r.perSentence });
      console.log(`API latency~${latency}ms | sentences=${n} -> total=${r.total.toFixed(0)}ms | per-sentence=${r.perSentence.toFixed(0)}ms`);
    }
  }

  console.log('\nSummary and guidance:');
  console.log('- The extension enforces a ~1s gap between request STARTS, so maximum throughput is ~1 request/sec (60/min).');
  console.log('- When API latency is <1s, the MIN_REQUEST_GAP_MS dominates and per-sentence time ~= MIN_REQUEST_GAP_MS (1s).');
  console.log('- When API latency >> MIN_REQUEST_GAP_MS, the API latency becomes the bottleneck.');
  console.log('- For large pages, batching multiple sentences into a single request (if API supports) drastically reduces total requests and improves speed.');
  console.log('- C++ implementation will not improve network-bound throughput; it only helps if heavy local processing is required.');

  // compute an example: time to translate a page with 200 sentences under different latency scenarios
  const pageSentences = 200;
  for (const latency of [100, 300, 800, 1500]) {
    const per = Math.max(MIN_REQUEST_GAP_MS, latency);
    const totalSec = (per * pageSentences) / 1000;
    console.log(`Estimate: ${pageSentences} sentences @ api~${latency}ms -> ~${totalSec.toFixed(1)}s total (~${(totalSec/60).toFixed(2)} min)`);
  }

  console.log('\nAdvice: If you need faster user experience:');
  console.log('- Request batching (translate paragraphs/chunks rather than each sentence separately).');
  console.log('- Client-side caching of recent translations.');
  console.log('- Use smarter node selection: avoid translating tiny nodes, combine nearby nodes before sending.');
  console.log('- Only translate visible nodes (viewport) first, lazy-load the rest.');

}

main().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});

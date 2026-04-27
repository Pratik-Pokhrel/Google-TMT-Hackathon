import { API_KEY, API_ENDPOINT } from "./config.js";

function hasValidConfig() {
  return (
    typeof API_KEY === "string" &&
    API_KEY.trim().length > 0 &&
    typeof API_ENDPOINT === "string" &&
    API_ENDPOINT.startsWith("http")
  );
}

const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 55;
const RATE_LIMIT_BUFFER_MS = 250;
const requestTimestamps = [];
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestSlot() {
  while (true) {
    const now = Date.now();

    while (
      requestTimestamps.length > 0 &&
      now - requestTimestamps[0] >= RATE_WINDOW_MS
    ) {
      requestTimestamps.shift();
    }

    if (requestTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
      requestTimestamps.push(now);
      return;
    }

    const waitMs =
      RATE_WINDOW_MS - (now - requestTimestamps[0]) + RATE_LIMIT_BUFFER_MS;
    await sleep(waitMs);
  }
}

function runWithRequestLimit(task) {
  const run = requestQueue.then(async () => {
    await waitForRequestSlot();
    return task();
  });

  requestQueue = run.catch(() => {});
  return run;
}

async function fetchTranslation(text, srcLang, tgtLang, attempt = 0) {
  if (!hasValidConfig()) {
    console.error(
      "[TMT] Missing API configuration. Run: node scripts/generate-config.mjs",
    );
    return { success: false, text };
  }

  return runWithRequestLimit(async () => {
    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ text, src_lang: srcLang, tgt_lang: tgtLang }),
      });

      if (response.status === 429) {
        if (attempt < 2) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = Number(retryAfterHeader);
          const waitMs =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : RATE_WINDOW_MS + RATE_LIMIT_BUFFER_MS;

          console.warn(
            `[TMT] Rate limited by API. Retrying in ${Math.ceil(waitMs / 1000)}s.`,
          );
          await sleep(waitMs);
          return fetchTranslation(text, srcLang, tgtLang, attempt + 1);
        }

        console.error("[TMT] Rate limit reached after retries.");
        return { success: false, text };
      }

      const raw = await response.text();
      let data = null;

      try {
        data = JSON.parse(raw);
      } catch {
        const preview = raw.slice(0, 120).replace(/\s+/g, " ");
        console.error(
          `[TMT] API returned non-JSON response (HTTP ${response.status}): ${preview}`,
        );
        return { success: false, text };
      }

      if (!response.ok) {
        console.error(
          `[TMT] API error (HTTP ${response.status}): ${data?.message || "Unknown error"}`,
        );
        return { success: false, text };
      }

      if (data.message_type === "SUCCESS") {
        return { success: true, text: data.output };
      } else {
        console.warn("[TMT] API FAIL:", data.message, "| Input:", text);
        return { success: false, text };
      }
    } catch (error) {
      console.error("[TMT] Network error:", error);
      return { success: false, text };
    }
  });
}

const SEPARATOR = " ||||| ";
const MAX_CHUNK_CHARS = 300;
const CONCURRENT_REQUESTS = 4;

function buildChunks(indexedTexts) {
  const chunks = [];
  let current = { indices: [], texts: [], joined: "" };

  for (const { text, originalIndex } of indexedTexts) {
    const wouldBe = current.joined ? current.joined + SEPARATOR + text : text;

    if (current.joined && wouldBe.length > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = { indices: [originalIndex], texts: [text], joined: text };
    } else {
      current.indices.push(originalIndex);
      current.texts.push(text);
      current.joined = wouldBe;
    }
  }
  if (current.indices.length > 0) chunks.push(current);
  return chunks;
}

async function applyChunkResult(chunk, srcLang, tgtLang, results) {
  const result = await fetchTranslation(chunk.joined, srcLang, tgtLang);
  if (!result.success) return;

  const parts = result.text.split(SEPARATOR);

  // If separator-based splitting breaks, translate one by one to keep node mapping stable.
  if (parts.length !== chunk.indices.length) {
    await Promise.all(
      chunk.texts.map(async (originalText, idx) => {
        const single = await fetchTranslation(originalText, srcLang, tgtLang);
        if (!single.success) return;

        const origIdx = chunk.indices[idx];
        const translated = single.text?.trim();
        if (translated) results[origIdx] = translated;
      }),
    );
    return;
  }

  chunk.indices.forEach((origIdx, partIdx) => {
    const translated = parts[partIdx]?.trim();
    if (translated) results[origIdx] = translated;
  });
}

async function fetchBatchTranslation(texts, srcLang, tgtLang) {
  const results = [...texts];

  const indexedTexts = texts
    .map((text, i) => ({ text: text.trim(), originalIndex: i }))
    .filter((x) => x.text.length > 0);

  if (indexedTexts.length === 0) return results;

  const chunks = buildChunks(indexedTexts);

  for (let i = 0; i < chunks.length; i += CONCURRENT_REQUESTS) {
    const batch = chunks.slice(i, i + CONCURRENT_REQUESTS);

    await Promise.all(
      batch.map((chunk) => applyChunkResult(chunk, srcLang, tgtLang, results)),
    );

    // Small pause avoids bursty traffic and keeps the page responsive.
    if (i + CONCURRENT_REQUESTS < chunks.length) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  return results;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    fetchTranslation(request.text, request.srcLang, request.tgtLang)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, error: "Unexpected error" }));
    return true;
  }

  if (request.action === "translateBatch") {
    fetchBatchTranslation(request.texts, request.srcLang, request.tgtLang)
      .then((translated) => sendResponse({ success: true, texts: translated }))
      .catch((err) => {
        console.error("[TMT] Batch error:", err);
        sendResponse({ success: false, error: "Batch translation failed" });
      });
    return true;
  }
});

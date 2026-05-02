import { API_KEY, API_ENDPOINT } from "./config.js";

function hasValidConfig() {
  return (
    typeof API_KEY === "string" &&
    API_KEY.trim().length > 0 &&
    typeof API_ENDPOINT === "string" &&
    API_ENDPOINT.startsWith("http")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Adaptive request gap:
// - Start faster than 1s
// - Fall back to 1s when API rate limits
// - Recover to fast mode after stable successes
const FAST_REQUEST_GAP_MS = 600;
const SAFE_REQUEST_GAP_MS = 1000;
const RECOVERY_SUCCESS_COUNT = 8;

let currentRequestGapMs = FAST_REQUEST_GAP_MS;
let successfulRequestsSinceFallback = 0;
let backoffUntil = 0;
let lastRequestStartedAt = 0;

const requestQueue = [];
let isDrainingQueue = false;

const translationCache = new Map();

function getCacheKey(text, srcLang, tgtLang) {
  return `${srcLang}:${tgtLang}:${text}`;
}

function getCachedTranslation(text, srcLang, tgtLang) {
  const key = getCacheKey(text, srcLang, tgtLang);
  return translationCache.get(key) || null;
}

function setCachedTranslation(text, srcLang, tgtLang, translation) {
  const key = getCacheKey(text, srcLang, tgtLang);
  if (translationCache.size > 1000) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, translation);
}

function onRateLimit(waitMs) {
  currentRequestGapMs = SAFE_REQUEST_GAP_MS;
  successfulRequestsSinceFallback = 0;
  backoffUntil = Date.now() + waitMs;
  console.warn(
    `[TMT] Rate limited. Falling back to ${SAFE_REQUEST_GAP_MS}ms gap for now. Backing off ${Math.ceil(waitMs / 1000)}s.`,
  );
}

function onSuccessfulRequest() {
  if (currentRequestGapMs !== SAFE_REQUEST_GAP_MS) return;
  successfulRequestsSinceFallback += 1;
  if (successfulRequestsSinceFallback >= RECOVERY_SUCCESS_COUNT) {
    currentRequestGapMs = FAST_REQUEST_GAP_MS;
    successfulRequestsSinceFallback = 0;
    console.info(
      `[TMT] Stable again. Retrying fast mode at ${FAST_REQUEST_GAP_MS}ms gap.`,
    );
  }
}

async function waitForRequestGap() {
  const now = Date.now();
  const sinceLastStart = now - lastRequestStartedAt;
  if (sinceLastStart < currentRequestGapMs) {
    await sleep(currentRequestGapMs - sinceLastStart);
  }
}

function enqueueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    if (!isDrainingQueue) {
      drainQueue();
    }
  });
}

async function drainQueue() {
  isDrainingQueue = true;
  while (requestQueue.length > 0) {
    const now = Date.now();
    if (now < backoffUntil) {
      await sleep(backoffUntil - now);
    }

    await waitForRequestGap();

    const item = requestQueue.shift();
    if (!item) break;

    lastRequestStartedAt = Date.now();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }
  isDrainingQueue = false;
}

async function doFetch(text, srcLang, tgtLang) {
  const cached = getCachedTranslation(text, srcLang, tgtLang);
  if (cached) {
    return { success: true, text: cached };
  }

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
      const retryAfter = response.headers.get("Retry-After");
      const numericRetryAfter = Number(retryAfter);
      const dateRetryAfter = Date.parse(retryAfter || "");
      const serverWaitMs = Number.isFinite(numericRetryAfter)
        ? numericRetryAfter * 1000
        : Number.isFinite(dateRetryAfter)
          ? Math.max(0, dateRetryAfter - Date.now())
          : SAFE_REQUEST_GAP_MS;
      const waitMs = Math.max(SAFE_REQUEST_GAP_MS, serverWaitMs);
      onRateLimit(waitMs);
      return null;
    }

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(
        `[TMT] Non-JSON response (HTTP ${response.status}):`,
        raw.slice(0, 120),
      );
      return { success: false, text };
    }

    if (!response.ok) {
      console.error(`[TMT] API error (HTTP ${response.status}):`, data?.message);
      return { success: false, text };
    }

    if (data.message_type === "SUCCESS") {
      const translated = data.output;
      setCachedTranslation(text, srcLang, tgtLang, translated);
      onSuccessfulRequest();
      return { success: true, text: translated };
    }

    console.warn("[TMT] API FAIL:", data.message);
    return { success: false, text };
  } catch (err) {
    console.error("[TMT] Network error:", err);
    return { success: false, text };
  }
}

function translateOne(text, srcLang, tgtLang) {
  if (!hasValidConfig()) {
    console.error("[TMT] Missing config. Run: node scripts/generate-config.mjs");
    return Promise.resolve({ success: false, text });
  }

  return enqueueRequest(async () => {
    while (true) {
      const result = await doFetch(text, srcLang, tgtLang);
      if (result !== null) return result;

      const waitMs = Math.max(0, backoffUntil - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      await waitForRequestGap();
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    translateOne(request.text, request.srcLang, request.tgtLang)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, text: request.text }));
    return true;
  }

  if (request.action === "ping") {
    sendResponse({ alive: true });
  }
});

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

const REQUEST_GAP_MS = 1000;
let backoffUntil = 0;
let lastRequestStartedAt = 0;

const requestQueue = [];
let isDrainingQueue = false;

const translationCache = new Map();
const CACHE_STORAGE_KEY = "tmtTranslationCacheV1";
let cacheHydrated = false;
let persistTimer = null;

function getCacheKey(text, srcLang, tgtLang) {
  return `${srcLang}:${tgtLang}:${text}`;
}

function getCachedTranslation(text, srcLang, tgtLang) {
  const key = getCacheKey(text, srcLang, tgtLang);
  return translationCache.get(key) || null;
}

function scheduleCachePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries = [...translationCache.entries()];
    chrome.storage.session.set({ [CACHE_STORAGE_KEY]: entries }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[TMT] Cache persist failed:", chrome.runtime.lastError.message);
      }
    });
  }, 350);
}

function setCachedTranslation(text, srcLang, tgtLang, translation) {
  const key = getCacheKey(text, srcLang, tgtLang);
  if (translationCache.size > 1000) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, translation);
  scheduleCachePersist();
}

function hydrateCacheIfNeeded() {
  if (cacheHydrated) return Promise.resolve();
  cacheHydrated = true;

  return new Promise((resolve) => {
    chrome.storage.session.get([CACHE_STORAGE_KEY], (result) => {
      if (chrome.runtime.lastError) {
        console.warn("[TMT] Cache hydrate failed:", chrome.runtime.lastError.message);
        resolve();
        return;
      }

      const entries = result?.[CACHE_STORAGE_KEY];
      if (Array.isArray(entries)) {
        for (const [key, value] of entries) {
          if (typeof key === "string" && typeof value === "string") {
            translationCache.set(key, value);
          }
        }
      }

      resolve();
    });
  });
}

function onRateLimit(waitMs) {
  backoffUntil = Date.now() + waitMs;
  console.warn(
    `[TMT] Rate limited. Keeping ${REQUEST_GAP_MS}ms gap. Backing off ${Math.ceil(waitMs / 1000)}s.`,
  );
}

async function waitForRequestGap() {
  const now = Date.now();
  const sinceLastStart = now - lastRequestStartedAt;
  if (sinceLastStart < REQUEST_GAP_MS) {
    await sleep(REQUEST_GAP_MS - sinceLastStart);
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
  await hydrateCacheIfNeeded();

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
          : REQUEST_GAP_MS;
      const waitMs = Math.max(REQUEST_GAP_MS, serverWaitMs);
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

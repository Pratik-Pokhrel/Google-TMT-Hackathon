import { API_KEY, API_ENDPOINT } from "./config.js";

// Validate that the required API configuration is present. This prevents
// attempting network requests when the local config file is missing or
// malformed. Returns true only when both the key and endpoint appear valid.
function hasValidConfig() {
  return (
    typeof API_KEY === "string" &&
    API_KEY.trim().length > 0 &&
    typeof API_ENDPOINT === "string" &&
    API_ENDPOINT.startsWith("http")
  );
}

// Small utility to pause execution for the given number of milliseconds.
// Used to implement rate limiting and backoff delays without blocking the
// service worker event loop.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-TAB QUEUES
//
// Each tab gets its own isolated queue. Only the queue belonging to the
// currently active/focused tab is allowed to drain — all others are paused.
// This means:
//   • Switching tabs immediately stops spending API quota on the background tab
//   • Coming back to a tab resumes exactly where it left off
//   • Rate limit (60 req/min) is respected globally via MIN_REQUEST_GAP_MS
// ─────────────────────────────────────────────────────────────────────────────
const MIN_REQUEST_GAP_MS = 1000;
let backoffUntil = 0;
let activeTabId = null; // currently focused tab
let lastRequestStartedAt = 0;

// Map<tabId, { queue: Array, isRunning: boolean }>
const tabQueues = new Map();

// Return or create the per-tab queue object. Each tab has an isolated queue so
// background processing can be paused when the tab is not active and resumed
// when it becomes active again.
function getTabQueue(tabId) {
  if (!tabQueues.has(tabId)) {
    tabQueues.set(tabId, { queue: [], isRunning: false });
  }
  return tabQueues.get(tabId);
}

// Enqueue a function to run for the given tab. The function will be executed
// when the tab's queue is drained. Returns a promise that resolves with the
// function result.
function enqueueForTab(tabId, fn) {
  return new Promise((resolve, reject) => {
    const tq = getTabQueue(tabId);
    tq.queue.push({ fn, resolve, reject });
    if (!tq.isRunning) drainTab(tabId);
  });
}

// Ensure a minimum time gap between request starts to comply with rate
// limiting. If the last request started recently, wait the remaining time.
async function waitForRequestGap() {
  const now = Date.now();
  const sinceLastStart = now - lastRequestStartedAt;
  if (sinceLastStart < MIN_REQUEST_GAP_MS) {
    await sleep(MIN_REQUEST_GAP_MS - sinceLastStart);
  }
}

// Drain the queue for a specific tab. This function runs in a loop until the
// queue is empty. It pauses when the tab is not active and respects global
// backoff set after a 429 response. Each queued task is executed serially.
async function drainTab(tabId) {
  const tq = getTabQueue(tabId);
  tq.isRunning = true;

  while (tq.queue.length > 0) {
    // Pause if this tab is not the active one — poll every 300ms until it is
    while (tabId !== activeTabId) {
      await sleep(300);
      // If the tab was closed, discard its queue entirely
      if (!tabQueues.has(tabId)) {
        tq.isRunning = false;
        return;
      }
    }

    // Global 429 backoff
    const now = Date.now();
    if (now < backoffUntil) await sleep(backoffUntil - now);

    await waitForRequestGap();

    const item = tq.queue.shift();
    if (!item) break;

    try {
      lastRequestStartedAt = Date.now();
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }

  tq.isRunning = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB LIFECYCLE — track active tab, clean up closed tabs
// ─────────────────────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (tabs[0]) activeTabId = tabs[0].id;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabQueues.delete(tabId);
});

// Initialise activeTabId on service worker startup
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) activeTabId = tabs[0].id;
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — one text, one API call
// ─────────────────────────────────────────────────────────────────────────────
// Perform a single translation request to the configured API endpoint. The
// function sends the text and language parameters and returns a structured
// result. On HTTP 429 it sets a global backoff timestamp and returns null to
// indicate the caller should retry after backoff.
async function doFetch(text, srcLang, tgtLang) {
  try {
    try {
      console.debug("[TMT] background -> doFetch", {
        srcLang,
        tgtLang,
        text: text.slice(0, 120),
      });
    } catch (e) {}
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
          : 61000;
      // Some gateways send 0/invalid Retry-After; enforce a floor to avoid bursts.
      const waitMs = Math.max(5000, serverWaitMs);
      console.warn(
        `[TMT] Rate limited. Backing off ${Math.ceil(waitMs / 1000)}s.`,
      );
      backoffUntil = Date.now() + waitMs;
      // Re-queue and retry after backoff (uses same tabId via closure in caller)
      return null; // signal to caller to re-enqueue
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
      console.error(
        `[TMT] API error (HTTP ${response.status}):`,
        data?.message,
      );
      return { success: false, text };
    }

    if (data.message_type === "SUCCESS") {
      return { success: true, text: data.output };
    }

    console.warn("[TMT] API FAIL:", data.message, "| Input:", text);
    return { success: false, text };
  } catch (err) {
    console.error("[TMT] Network error:", err);
    return { success: false, text };
  }
}

function translateOne(tabId, text, srcLang, tgtLang) {
  if (!hasValidConfig()) {
    console.error(
      "[TMT] Missing config. Run: node scripts/generate-config.mjs",
    );
    return Promise.resolve({ success: false, text });
  }

  // Wrap the fetch attempt in the tab queue so requests are serialized per
  // tab. If the API signals rate limiting the attempt will wait for the
  // global backoff and then retry. The function returns a promise that
  // resolves with the translation result.
  const attempt = () =>
    enqueueForTab(tabId, async () => {
      while (true) {
        const result = await doFetch(text, srcLang, tgtLang);
        if (result !== null) return result;

        const waitMs = Math.max(0, backoffUntil - Date.now());
        if (waitMs > 0) await sleep(waitMs);
        await waitForRequestGap();
      }
    });

  return attempt();
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE LISTENER
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    const tabId = sender.tab?.id ?? activeTabId;
    try {
      console.debug("[TMT] background -> received translate", {
        tabId,
        src: request.srcLang,
        tgt: request.tgtLang,
        text: (request.text || "").slice(0, 120),
      });
    } catch (e) {}
    translateOne(tabId, request.text, request.srcLang, request.tgtLang)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, text: request.text }));
    return true;
  }
});

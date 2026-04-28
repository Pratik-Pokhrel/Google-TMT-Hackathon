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
const MIN_REQUEST_GAP_MS = 1100;   // ~54 req/min — safe under the 60/min limit
let lastRequestTime = 0;
let backoffUntil = 0;
let activeTabId = null;            // currently focused tab

// Map<tabId, { queue: Array, isRunning: boolean }>
const tabQueues = new Map();

function getTabQueue(tabId) {
  if (!tabQueues.has(tabId)) {
    tabQueues.set(tabId, { queue: [], isRunning: false });
  }
  return tabQueues.get(tabId);
}

function enqueueForTab(tabId, fn) {
  return new Promise((resolve, reject) => {
    const tq = getTabQueue(tabId);
    tq.queue.push({ fn, resolve, reject });
    if (!tq.isRunning) drainTab(tabId);
  });
}

async function drainTab(tabId) {
  const tq = getTabQueue(tabId);
  tq.isRunning = true;

  while (tq.queue.length > 0) {
    // Pause if this tab is not the active one — poll every 300ms until it is
    while (tabId !== activeTabId) {
      await sleep(300);
      // If the tab was closed, discard its queue entirely
      if (!tabQueues.has(tabId)) { tq.isRunning = false; return; }
    }

    // Global 429 backoff
    const now = Date.now();
    if (now < backoffUntil) await sleep(backoffUntil - now);

    // Global minimum gap between API requests
    const sinceLast = Date.now() - lastRequestTime;
    if (sinceLast < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - sinceLast);

    const item = tq.queue.shift();
    if (!item) break;

    lastRequestTime = Date.now();
    try {
      item.resolve(await item.fn());
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
async function doFetch(text, srcLang, tgtLang) {
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
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : 61000;
      console.warn(`[TMT] Rate limited. Backing off ${Math.ceil(waitMs / 1000)}s.`);
      backoffUntil = Date.now() + waitMs;
      // Re-queue and retry after backoff (uses same tabId via closure in caller)
      return null; // signal to caller to re-enqueue
    }

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(`[TMT] Non-JSON response (HTTP ${response.status}):`, raw.slice(0, 120));
      return { success: false, text };
    }

    if (!response.ok) {
      console.error(`[TMT] API error (HTTP ${response.status}):`, data?.message);
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
    console.error("[TMT] Missing config. Run: node scripts/generate-config.mjs");
    return Promise.resolve({ success: false, text });
  }

  const attempt = () =>
    enqueueForTab(tabId, async () => {
      const result = await doFetch(text, srcLang, tgtLang);
      // null = was rate-limited, retry
      if (result === null) return enqueueForTab(tabId, () => doFetch(text, srcLang, tgtLang));
      return result;
    });

  return attempt();
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE LISTENER
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    const tabId = sender.tab?.id ?? activeTabId;
    translateOne(tabId, request.text, request.srcLang, request.tgtLang)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, text: request.text }));
    return true;
  }
});

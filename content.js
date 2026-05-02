if (globalThis.__TMT_CONTENT_SCRIPT_LOADED__) {
  console.debug("[TMT] content script already loaded; skipping duplicate init");
  // ─────────────────────────────────────────────────────────────────────────────
  // CONTENT SCRIPT — handles translation of text nodes on the page.
  // This script listens for messages from the background script and manages
  // the translation process, including starting and stopping translations.
} else {
  globalThis.__TMT_CONTENT_SCRIPT_LOADED__ = true;

  let isTranslating = false;
  let translationEnabled = false;
  let translationRunId = 0;
  let translationQueue = Promise.resolve();
  let currentSrcLang = "en";
  let currentTgtLang = "ne";
  let mutationObserver = null;
  let progressLastSentAt = 0;
  const localTranslationCache = new Map();
  const inFlightTranslations = new Map();
  // Stores original nodeValue for every node we translate.
  // Used to restore the page without a reload when translation is toggled off.
  const originalTexts = new Map();

  // ─────────────────────────────────────────────────────────────────────────────
  // PROGRESS TRACKING
  // ─────────────────────────────────────────────────────────────────────────────
  let totalNodesToTranslate = 0;
  let nodesTranslated = 0;

  function updateProgressBar() {
    const percentage = totalNodesToTranslate > 0 
      ? (nodesTranslated / totalNodesToTranslate) * 100 
      : 0;

    const now = Date.now();
    if (now - progressLastSentAt < 120 && percentage < 100) return;
    progressLastSentAt = now;
    
    // Send progress update to popup
    try {
      chrome.runtime.sendMessage({
        action: "updateProgress",
        percentage: percentage,
      });
    } catch (e) {
      // Popup not open, ignore
    }
  }

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "CODE",
    "PRE",
    "KBD",
    "SAMP",
    "VAR",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "HEAD",
    "META",
    "LINK",
    "IFRAME",
    "SVG",
    "MATH",
    "CANVAS",
  ]);

  // ─────────────────────────────────────────────────────────────────────────────
  // BATCH TRANSLATION — keep each text node isolated for correctness.
  // ─────────────────────────────────────────────────────────────────────────────

  function batchNodes(nodes) {
    return nodes
      .map((node) => {
        const txt = (node.nodeValue || "").trim();
        if (!txt) return null;
        return { nodes: [node], texts: [txt], chars: txt.length };
      })
      .filter(Boolean);
  }

  function getNodePriority(node) {
    const el = node?.parentElement;
    if (!el) return 1;

    const inMainContent = el.closest("main, article, [role='main']");
    if (inMainContent) return 0;

    const inPeripheral = el.closest("nav, header, footer, aside");
    if (inPeripheral) return 2;

    return 1;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DOM HELPERS
  // ─────────────────────────────────────────────────────────────────────────────
  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(
      root || document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.nodeValue;
          if (!text || text.trim().length < 2) return NodeFilter.FILTER_SKIP;
          if (originalTexts.has(node)) return NodeFilter.FILTER_REJECT;
          let el = node.parentElement;
          while (el) {
            if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
            if (el.isContentEditable) return NodeFilter.FILTER_REJECT;
            if (el === document.body) break;
            el = el.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function markTranslated(node) {
    originalTexts.set(node, originalTexts.get(node) || node.nodeValue || "");
  }

  function unmarkTranslated() {
    // No DOM attributes are used anymore; originalTexts is the source of truth.
  }

  function getTranslationCacheKey(text, srcLang, tgtLang) {
    return `${srcLang}:${tgtLang}:${text}`;
  }

  function requestTranslation(text, srcLang, tgtLang) {
    const key = getTranslationCacheKey(text, srcLang, tgtLang);

    const cached = localTranslationCache.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    const inFlight = inFlightTranslations.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "translate", text, srcLang, tgtLang },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[TMT] Message error:", chrome.runtime.lastError);
            resolve(null);
            return;
          }

          if (response?.success && response.text) {
            localTranslationCache.set(key, response);
            if (localTranslationCache.size > 1500) {
              const oldestKey = localTranslationCache.keys().next().value;
              localTranslationCache.delete(oldestKey);
            }
            resolve(response);
            return;
          }

          resolve(response || null);
        },
      );
    }).finally(() => {
      inFlightTranslations.delete(key);
    });

    inFlightTranslations.set(key, promise);
    return promise;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RESTORE — revert every translated node to its saved original, in-place.
  // No reload needed.
  // ─────────────────────────────────────────────────────────────────────────────
  function restorePage() {
    if (mutationObserver) mutationObserver.disconnect();

    originalTexts.forEach((original, node) => {
      // Guard: node must still be in the document
      if (node.isConnected) node.nodeValue = original;
    });
    originalTexts.clear();

    unmarkTranslated();

    // Don't restart the observer — translation is off
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSLATE ONE BATCH — send multiple nodes as single request
  // ─────────────────────────────────────────────────────────────────────────────
  function translateOneBatch(batch, srcLang, tgtLang) {
    const { nodes, texts } = batch;
    if (nodes.length === 0) return Promise.resolve();

    // Save originals before translation
    for (const node of nodes) {
      if (!originalTexts.has(node)) {
        originalTexts.set(node, node.nodeValue);
      }
    }

    // Send all texts joined by spaces
    const payloadText = texts.join(" ");
    if (!payloadText || payloadText.trim().length === 0) {
      return Promise.resolve();
    }

    return requestTranslation(payloadText, srcLang, tgtLang).then((response) => {
      if (response?.success && response.text) {
        const translated = response.text;

        // Apply the translation to the single node in this batch.
        const firstNode = nodes[0];
        const firstOriginal = originalTexts.get(firstNode) || firstNode.nodeValue || "";
        const leading = firstOriginal.match(/^\s*/)?.[0] || "";
        const trailing = firstOriginal.match(/\s*$/)?.[0] || "";

        firstNode.nodeValue = leading + translated + trailing;
        markTranslated(firstNode);
        nodesTranslated++;

        updateProgressBar();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSLATE A LIST OF NODES — by batch (reduced API calls)
  // ─────────────────────────────────────────────────────────────────────────────
  let _pageNodes = [];

  async function translateNodes(nodes, srcLang, tgtLang, runId) {
    const batches = batchNodes(nodes);

    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      // Bail out if translation was toggled off or restarted
      if (!translationEnabled || runId !== translationRunId) break;
      await translateOneBatch(batch, srcLang, tgtLang);

      // Yield occasionally so the page remains responsive while translating.
      if (i > 0 && i % 20 === 0) {
        await sleep(0);
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function enqueueTranslation(nodes, srcLang, tgtLang, runId) {
    translationQueue = translationQueue
      .then(async () => {
        if (!translationEnabled || runId !== translationRunId) return;
        await translateNodes(nodes, srcLang, tgtLang, runId);
      })
      .catch(() => {
        // Keep queue chain alive even if a batch fails.
      });
    return translationQueue;
  }

  async function translatePage(srcLang, tgtLang, runId) {
    if (isTranslating) return;
    isTranslating = true;

    _pageNodes = getTextNodes(document.body);
    const highPriorityNodes = [];
    const mediumPriorityNodes = [];
    const lowPriorityNodes = [];

    for (const node of _pageNodes) {
      const priority = getNodePriority(node);
      if (priority === 0) highPriorityNodes.push(node);
      else if (priority === 2) lowPriorityNodes.push(node);
      else mediumPriorityNodes.push(node);
    }

    totalNodesToTranslate = _pageNodes.length;
    nodesTranslated = 0;
    updateProgressBar();

    // Translate main content first for better perceived speed.
    const firstWave = [...highPriorityNodes, ...mediumPriorityNodes];
    await enqueueTranslation(firstWave, srcLang, tgtLang, runId);

    // Defer peripheral UI translation to background so browsing remains smooth.
    if (lowPriorityNodes.length > 0) {
      setTimeout(() => {
        if (!translationEnabled || runId !== translationRunId) return;
        enqueueTranslation(lowPriorityNodes, srcLang, tgtLang, runId);
      }, 0);
    }

    isTranslating = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MUTATION OBSERVER — only new nodes, debounced; with viewport awareness
  // ─────────────────────────────────────────────────────────────────────────────
  function startObserver(srcLang, tgtLang, runId) {
    if (mutationObserver) mutationObserver.disconnect();

    let debounceTimer = null;
    const pending = new Set();

    mutationObserver = new MutationObserver((mutations) => {
      if (!translationEnabled || runId !== translationRunId) return;

      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) {
            const text = added.nodeValue;
            if (text && text.trim().length > 1) {
              pending.add(added);
            }
          } else if (added.nodeType === Node.ELEMENT_NODE) {
            getTextNodes(added).forEach((n) => pending.add(n));
          }
        }
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (pending.size === 0) return;
        const nodes = [...pending];
        pending.clear();
        enqueueTranslation(nodes, srcLang, tgtLang, runId);
      }, 120);
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });
  }

  function stopObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MESSAGE LISTENER
  // ─────────────────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startTranslation") {
      const sameLanguages =
        translationEnabled &&
        request.srcLang === currentSrcLang &&
        request.tgtLang === currentTgtLang;
      if (sameLanguages) {
        sendResponse({ success: true });
        return;
      }

      translationEnabled = true;
      translationRunId += 1;
      const runId = translationRunId;
      currentSrcLang = request.srcLang;
      currentTgtLang = request.tgtLang;
      console.debug("[TMT] content -> startTranslation", {
        src: currentSrcLang,
        tgt: currentTgtLang,
      });

      translatePage(currentSrcLang, currentTgtLang, runId)
        .catch((err) => {
          console.warn("[TMT] Initial translation failed:", err);
        })
        .finally(() => {
          if (!translationEnabled || runId !== translationRunId) return;
          startObserver(currentSrcLang, currentTgtLang, runId);
        });
      sendResponse({ success: true });
    }

    if (request.action === "stopTranslation") {
      translationEnabled = false;
      translationRunId += 1;
      isTranslating = false;
      stopObserver();
      restorePage(); // revert all translations in-place — no reload
      inFlightTranslations.clear();
      sendResponse({ success: true });
    }

    if (request.action === "ping") {
      sendResponse({ alive: true });
    }
  });
}

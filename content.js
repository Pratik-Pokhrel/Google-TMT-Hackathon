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

  // ─────────────────────────────────────────────────────────────────────────────
  // PROGRESS TRACKING
  // ─────────────────────────────────────────────────────────────────────────────
  let totalNodesToTranslate = 0;
  let nodesTranslated = 0;

  function updateProgressBar() {
    const percentage = totalNodesToTranslate > 0 
      ? (nodesTranslated / totalNodesToTranslate) * 100 
      : 0;
    
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

  const TRANSLATED_ATTR = "data-tmt-done";
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
  // VIEWPORT AWARENESS — prioritize visible content
  // ─────────────────────────────────────────────────────────────────────────────
  const visibleNodes = new Set();
  const intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibleNodes.add(entry.target);
      } else {
        visibleNodes.delete(entry.target);
      }
    }
  }, { rootMargin: "200px" }); // 200px buffer for pre-loading

  function isNodeVisible(node) {
    const el = node.parentElement;
    return el && visibleNodes.has(el);
  }

  function prioritizeNodes(nodes) {
    // Sort: visible nodes first, then rest
    const visible = nodes.filter(isNodeVisible);
    const hidden = nodes.filter(n => !isNodeVisible(n));
    return [...visible, ...hidden];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BATCH TRANSLATION — translate individual nodes separately for correctness
  // ─────────────────────────────────────────────────────────────────────────────
  // Each node is translated independently to avoid proportional splitting errors.
  const MAX_BATCH_CHARS = 500; // not used for batching anymore, just a limit check

  function batchNodes(nodes) {
    // Each node becomes its own batch to ensure accurate translation
    return nodes.map((node) => ({
      nodes: [node],
      text: (node.nodeValue || "").trim(),
    }));
  }

  // Stores original nodeValue for every node we translate.
  // Used to restore the page without a reload when translation is toggled off.
  const originalTexts = new Map();

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
          let el = node.parentElement;
          while (el) {
            if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
            if (el.isContentEditable) return NodeFilter.FILTER_REJECT;
            if (el.hasAttribute(TRANSLATED_ATTR))
              return NodeFilter.FILTER_REJECT;
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
    let el = node.parentElement;
    while (el && el !== document.body) {
      const tag = el.tagName;
      if (
        [
          "P",
          "H1",
          "H2",
          "H3",
          "H4",
          "H5",
          "H6",
          "LI",
          "TD",
          "TH",
          "SPAN",
          "A",
          "LABEL",
          "BUTTON",
          "DIV",
        ].includes(tag)
      ) {
        el.setAttribute(TRANSLATED_ATTR, "1");
        return;
      }
      el = el.parentElement;
    }
    if (node.parentElement)
      node.parentElement.setAttribute(TRANSLATED_ATTR, "1");
  }

  function unmarkTranslated() {
    document
      .querySelectorAll(`[${TRANSLATED_ATTR}]`)
      .forEach((el) => el.removeAttribute(TRANSLATED_ATTR));
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
  // TRANSLATE ONE BATCH — translate a single node
  // ─────────────────────────────────────────────────────────────────────────────
  function translateOneBatch(batch, srcLang, tgtLang) {
    const { nodes, text } = batch;
    if (!text || nodes.length === 0) return Promise.resolve();

    const node = nodes[0]; // Each batch has exactly 1 node now

    // Save original before translation
    if (!originalTexts.has(node)) {
      originalTexts.set(node, node.nodeValue);
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "translate", text, srcLang, tgtLang },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[TMT] Message error:", chrome.runtime.lastError);
            resolve();
            return;
          }

          if (response?.success && response.text) {
            if (mutationObserver) mutationObserver.disconnect();

            // Apply translated text to the single node, preserving whitespace
            const original = originalTexts.get(node) || node.nodeValue || "";
            const leading = original.match(/^\s*/)?.[0] || "";
            const trailing = original.match(/\s*$/)?.[0] || "";

            node.nodeValue = leading + response.text + trailing;
            markTranslated(node);
            nodesTranslated++;
            updateProgressBar();

            if (mutationObserver && translationEnabled) {
              mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: false,
              });
            }
          }

          resolve();
        },
      );
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSLATE A LIST OF NODES — by batch (reduced API calls)
  // ─────────────────────────────────────────────────────────────────────────────
  let _pageNodes = [];

  async function translateNodes(nodes, srcLang, tgtLang, runId) {
    // Prioritize visible content first
    const sorted = prioritizeNodes(nodes);
    const batches = batchNodes(sorted);

    for (const batch of batches) {
      // Bail out if translation was toggled off or restarted
      if (!translationEnabled || runId !== translationRunId) break;
      await translateOneBatch(batch, srcLang, tgtLang);
    }
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
    totalNodesToTranslate = _pageNodes.length;
    nodesTranslated = 0;
    updateProgressBar();

    await enqueueTranslation(_pageNodes, srcLang, tgtLang, runId);

    isTranslating = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MUTATION OBSERVER — only new nodes, debounced; with viewport awareness
  // ─────────────────────────────────────────────────────────────────────────────
  function startObserver(srcLang, tgtLang, runId) {
    if (mutationObserver) mutationObserver.disconnect();

    // Observe all block elements for viewport detection
    const blocks = document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, div, article, section");
    blocks.forEach(el => {
      if (!visibleNodes.has(el)) {
        intersectionObserver.observe(el);
      }
    });

    let debounceTimer = null;
    const pending = new Set();

    mutationObserver = new MutationObserver((mutations) => {
      if (!translationEnabled || runId !== translationRunId) return;

      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) {
            const text = added.nodeValue;
            if (text && text.trim().length > 1) {
              const parent = added.parentElement;
              if (parent && !parent.hasAttribute(TRANSLATED_ATTR))
                pending.add(added);
            }
          } else if (added.nodeType === Node.ELEMENT_NODE) {
            // Observe new element for viewport detection
            if (added.tagName && ["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "DIV", "ARTICLE", "SECTION"].includes(added.tagName)) {
              intersectionObserver.observe(added);
            }
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
      }, 400);
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
    intersectionObserver.disconnect();
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

      translatePage(currentSrcLang, currentTgtLang, runId);
      startObserver(currentSrcLang, currentTgtLang, runId);
      sendResponse({ success: true });
    }

    if (request.action === "stopTranslation") {
      translationEnabled = false;
      translationRunId += 1;
      isTranslating = false;
      stopObserver();
      restorePage(); // revert all translations in-place — no reload
      sendResponse({ success: true });
    }

    if (request.action === "ping") {
      sendResponse({ alive: true });
    }
  });
}

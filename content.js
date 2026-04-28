let isTranslating = false;
let currentSrcLang = "en";
let currentTgtLang = "ne";
let mutationObserver = null;

const TRANSLATED_ATTR = "data-tmt-done";
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "KBD",
  "SAMP", "VAR", "TEXTAREA", "INPUT", "SELECT", "OPTION",
  "HEAD", "META", "LINK", "IFRAME", "SVG", "MATH", "CANVAS",
]);

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
          if (SKIP_TAGS.has(el.tagName))          return NodeFilter.FILTER_REJECT;
          if (el.isContentEditable)               return NodeFilter.FILTER_REJECT;
          if (el.hasAttribute(TRANSLATED_ATTR))   return NodeFilter.FILTER_REJECT;
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
    if (["P","H1","H2","H3","H4","H5","H6","LI","TD","TH",
         "SPAN","A","LABEL","BUTTON","DIV"].includes(tag)) {
      el.setAttribute(TRANSLATED_ATTR, "1");
      return;
    }
    el = el.parentElement;
  }
  if (node.parentElement) node.parentElement.setAttribute(TRANSLATED_ATTR, "1");
}

function unmarkTranslated() {
  document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((el) =>
    el.removeAttribute(TRANSLATED_ATTR)
  );
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
// TRANSLATE ONE NODE — single sendMessage, resolves in ~1.1s (queue gap)
// ─────────────────────────────────────────────────────────────────────────────
function translateOneNode(node, srcLang, tgtLang) {
  const original = node.nodeValue || "";
  const text = original.trim();
  if (!text) return Promise.resolve();

  // Save original before the first translation of this node
  if (!originalTexts.has(node)) originalTexts.set(node, original);

  const leading  = original.match(/^\s*/)?.[0]  || "";
  const trailing = original.match(/\s*$/)?.[0]  || "";

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: "translate", text, srcLang, tgtLang },
      (response) => {
        if (chrome.runtime.lastError) { resolve(); return; }
        if (response?.success && response.text && response.text !== text) {
          if (mutationObserver) mutationObserver.disconnect();
          node.nodeValue = leading + response.text + trailing;
          markTranslated(node);
          if (mutationObserver && isTranslating) {
            mutationObserver.observe(document.body, {
              childList: true, subtree: true, characterData: false,
            });
          }
        }
        resolve();
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSLATE A LIST OF NODES — sequentially
// ─────────────────────────────────────────────────────────────────────────────
let _pageNodes = [];

async function translateNodes(nodes, srcLang, tgtLang) {
  for (const node of nodes) {
    // Bail out immediately if translation was toggled off mid-run
    if (!isTranslating) break;
    await translateOneNode(node, srcLang, tgtLang);
  }
}

async function translatePage(srcLang, tgtLang) {
  if (isTranslating) return;
  isTranslating = true;

  _pageNodes = getTextNodes(document.body);
  await translateNodes(_pageNodes, srcLang, tgtLang);

  isTranslating = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION OBSERVER — only new nodes, debounced
// ─────────────────────────────────────────────────────────────────────────────
function startObserver(srcLang, tgtLang) {
  if (mutationObserver) mutationObserver.disconnect();

  let debounceTimer = null;
  const pending = new Set();

  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          const text = added.nodeValue;
          if (text && text.trim().length > 1) {
            const parent = added.parentElement;
            if (parent && !parent.hasAttribute(TRANSLATED_ATTR)) pending.add(added);
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
      translateNodes(nodes, srcLang, tgtLang);
    }, 400);
  });

  mutationObserver.observe(document.body, {
    childList: true, subtree: true, characterData: false,
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
    currentSrcLang = request.srcLang;
    currentTgtLang = request.tgtLang;
    translatePage(currentSrcLang, currentTgtLang);
    startObserver(currentSrcLang, currentTgtLang);
    sendResponse({ success: true });
  }

  if (request.action === "stopTranslation") {
    isTranslating = false;   // stops any in-progress translateNodes loop
    stopObserver();
    restorePage();            // revert all translations in-place — no reload
    sendResponse({ success: true });
  }

  if (request.action === "ping") {
    sendResponse({ alive: true });
  }
});

let isTranslating = false;
let currentSrcLang = "en";
let currentTgtLang = "ne";
let mutationObserver = null;

// We mark translated containers so later scans do not re-translate the same subtree.
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
          if (el.hasAttribute(TRANSLATED_ATTR)) return NodeFilter.FILTER_REJECT;
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
  if (node.parentElement) {
    node.parentElement.setAttribute(TRANSLATED_ATTR, "1");
  }
}

function translateNodes(nodes, srcLang, tgtLang) {
  if (nodes.length === 0) return;

  const texts = nodes.map((n) => n.nodeValue.trim());
  const wrappers = nodes.map((n) => {
    const original = n.nodeValue || "";
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    return { leading, trailing };
  });

  chrome.runtime.sendMessage(
    { action: "translateBatch", texts, srcLang, tgtLang },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("[TMT] Message error:", chrome.runtime.lastError.message);
        return;
      }
      if (!response || !response.success) return;

      response.texts.forEach((translated, i) => {
        const node = nodes[i];
        if (node && translated && translated !== texts[i]) {
          // Disconnect briefly so our own DOM updates are not treated as new content.
          if (mutationObserver) mutationObserver.disconnect();

          const { leading, trailing } = wrappers[i];
          node.nodeValue = leading + translated + trailing;
          markTranslated(node);

          if (mutationObserver && isTranslating) {
            mutationObserver.observe(document.body, {
              childList: true,
              subtree: true,
            });
          }
        }
      });
    },
  );
}

const NODES_PER_MESSAGE = 60;

async function translatePage(srcLang, tgtLang) {
  if (isTranslating) return;
  isTranslating = true;

  const allNodes = getTextNodes(document.body);
  if (allNodes.length === 0) {
    isTranslating = false;
    return;
  }

  for (let i = 0; i < allNodes.length; i += NODES_PER_MESSAGE) {
    const chunk = allNodes.slice(i, i + NODES_PER_MESSAGE);
    translateNodes(chunk, srcLang, tgtLang);
    await new Promise((r) => setTimeout(r, 50));
  }

  isTranslating = false;
}

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
            if (parent && !parent.hasAttribute(TRANSLATED_ATTR)) {
              pending.add(added);
            }
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

      for (let i = 0; i < nodes.length; i += NODES_PER_MESSAGE) {
        translateNodes(nodes.slice(i, i + NODES_PER_MESSAGE), srcLang, tgtLang);
      }
    }, 400);
  });

  // Ignore characterData changes to prevent observer feedback loops.
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startTranslation") {
    currentSrcLang = request.srcLang;
    currentTgtLang = request.tgtLang;
    translatePage(currentSrcLang, currentTgtLang);
    startObserver(currentSrcLang, currentTgtLang);
    sendResponse({ success: true });
  }

  if (request.action === "stopTranslation") {
    stopObserver();
    isTranslating = false;
    window.location.reload();
    sendResponse({ success: true });
  }

  if (request.action === "ping") {
    sendResponse({ alive: true });
  }
});

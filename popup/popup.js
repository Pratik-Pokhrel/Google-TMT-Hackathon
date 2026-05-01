const srcLangSelect = document.getElementById("srcLang");
const tgtLangSelect = document.getElementById("tgtLang");
const translateBtn = document.getElementById("translateBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const swapBtn = document.getElementById("swapBtn");
const chips = document.querySelectorAll(".chip");
const progressContainer = document.getElementById("progressContainer");
const progressFill = document.getElementById("progressFill");
const progressPercentage = document.getElementById("progressPercentage");
const toggleHint = document.getElementById("toggleHint");

let isTranslating = false;
let currentTabId = null;

// Update the visual status indicator in the popup.
function setStatus(type, message) {
  statusDot.className = "status-dot " + type;
  statusText.textContent = message;
}

// Visually mark the chip that matches the given source and target languages.
function setActiveChip(src, tgt) {
  chips.forEach((chip) => {
    chip.classList.toggle(
      "active",
      chip.dataset.src === src && chip.dataset.tgt === tgt,
    );
  });
}

// Update progress bar in real-time.
function updateProgress(percentage) {
  progressFill.style.width = percentage + "%";
  progressPercentage.textContent = Math.round(percentage) + "%";
}

// Update UI button states based on translation status.
function updateButtonUI(translating) {
  isTranslating = translating;
  translateBtn.disabled = translating;
  stopBtn.disabled = !translating;
  
  if (translating) {
    progressContainer.style.display = "block";
    toggleHint.textContent = "Translation in progress...";
  } else {
    progressContainer.style.display = "none";
    toggleHint.textContent = "Click to translate this page";
    updateProgress(0);
  }
}

// Check that the selected source and target languages are valid.
function validateLanguages() {
  const src = srcLangSelect.value;
  const tgt = tgtLangSelect.value;
  if (src === tgt) {
    setStatus("error", "Source and target must differ");
    return false;
  }
  return true;
}

// Handle progress updates from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "updateProgress") {
    updateProgress(request.percentage);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["srcLang", "tgtLang"], (data) => {
    if (data.srcLang) srcLangSelect.value = data.srcLang;
    if (data.tgtLang) tgtLangSelect.value = data.tgtLang;
    setActiveChip(srcLangSelect.value, tgtLangSelect.value);
    setStatus("ready", "Ready");
  });

  updateButtonUI(false);
});

// Translate button - start translation
translateBtn.addEventListener("click", async () => {
  if (!validateLanguages()) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("error", "No active tab found");
    return;
  }

  currentTabId = tab.id;
  updateButtonUI(true);
  setStatus("loading", "Injecting content script...");

  // Ensure content script is injected
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "ping" });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch (injectErr) {
      setStatus("error", "Can't inject on this page");
      updateButtonUI(false);
      return;
    }
  }

  // Send start translation message
  setStatus("loading", "Starting translation...");
  chrome.tabs.sendMessage(
    tab.id,
    {
      action: "startTranslation",
      srcLang: srcLangSelect.value,
      tgtLang: tgtLangSelect.value,
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        setStatus("error", "Failed to start translation");
        updateButtonUI(false);
      } else {
        setStatus("loading", "Translating page...");
        updateProgress(0);
      }
    },
  );
});

// Stop button - stop translation
stopBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  setStatus("loading", "Stopping translation...");
  chrome.tabs.sendMessage(tab.id, { action: "stopTranslation" }, () => {
    setStatus("ready", "Ready");
    updateButtonUI(false);
  });
});

swapBtn.addEventListener("click", () => {
  const tmp = srcLangSelect.value;
  srcLangSelect.value = tgtLangSelect.value;
  tgtLangSelect.value = tmp;
  setActiveChip(srcLangSelect.value, tgtLangSelect.value);
  chrome.storage.local.set({
    srcLang: srcLangSelect.value,
    tgtLang: tgtLangSelect.value,
  });
});

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    srcLangSelect.value = chip.dataset.src;
    tgtLangSelect.value = chip.dataset.tgt;
    setActiveChip(chip.dataset.src, chip.dataset.tgt);
    chrome.storage.local.set({
      srcLang: chip.dataset.src,
      tgtLang: chip.dataset.tgt,
    });
  });
});

srcLangSelect.addEventListener("change", () => {
  setActiveChip(srcLangSelect.value, tgtLangSelect.value);
  chrome.storage.local.set({ srcLang: srcLangSelect.value });
});

tgtLangSelect.addEventListener("change", () => {
  setActiveChip(srcLangSelect.value, tgtLangSelect.value);
  chrome.storage.local.set({ tgtLang: tgtLangSelect.value });
});

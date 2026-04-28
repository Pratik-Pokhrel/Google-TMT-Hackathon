const srcLangSelect = document.getElementById("srcLang");
const tgtLangSelect = document.getElementById("tgtLang");
const mainToggle = document.getElementById("mainToggle");
const statusLabel = document.getElementById("statusLabel");
const toggleHint = document.getElementById("toggleHint");
const toggleSection = document.querySelector(".toggle-section");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const swapBtn = document.getElementById("swapBtn");
const chips = document.querySelectorAll(".chip");

let isOn = false;

function setStatus(type, message) {
  statusDot.className = "status-dot " + type;
  statusText.textContent = message;
}

function setActiveChip(src, tgt) {
  chips.forEach((chip) => {
    chip.classList.toggle(
      "active",
      chip.dataset.src === src && chip.dataset.tgt === tgt,
    );
  });
}

function updateToggleUI(on) {
  isOn = on;
  mainToggle.checked = on;
  statusLabel.textContent = on ? "Translation ON" : "Translation OFF";
  statusLabel.classList.toggle("on", on);
  toggleSection.classList.toggle("active", on);
  toggleHint.textContent = on
    ? "Page is being translated..."
    : "Toggle to translate this page";
}

function validateLanguages() {
  const src = srcLangSelect.value;
  const tgt = tgtLangSelect.value;
  if (src === tgt) {
    setStatus("error", "Source and target must differ");
    return false;
  }
  return true;
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["isOn", "srcLang", "tgtLang"], (data) => {
    if (data.srcLang) srcLangSelect.value = data.srcLang;
    if (data.tgtLang) tgtLangSelect.value = data.tgtLang;
    updateToggleUI(!!data.isOn);
    setActiveChip(srcLangSelect.value, tgtLangSelect.value);

    if (data.isOn) {
      setStatus("success", "Translating page");
    } else {
      setStatus("ready", "Ready");
    }
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

mainToggle.addEventListener("change", async () => {
  const turnOn = mainToggle.checked;

  if (turnOn && !validateLanguages()) {
    mainToggle.checked = false;
    return;
  }

  updateToggleUI(turnOn);
  chrome.storage.local.set({ isOn: turnOn });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("error", "No active tab found");
    return;
  }

  // PDF pages (chrome-extension://.../.../pdf or chrome://pdf-viewer) use a
  // sandboxed viewer — content scripts cannot run inside them. We detect this
  // and tell the user to enable the setting instead.
  const isPdfViewer =
    tab.url?.startsWith("chrome-extension://") && tab.url?.includes("pdf") ||
    tab.url?.endsWith(".pdf");

  if (isPdfViewer) {
    setStatus("error", "Open PDF as text (not viewer) to translate");
    updateToggleUI(false);
    chrome.storage.local.set({ isOn: false });
    return;
  }

  // For file:// URLs the user must have "Allow access to file URLs" enabled
  // in chrome://extensions for this extension. We can detect it and warn.
  if (tab.url?.startsWith("file://")) {
    const extInfo = await chrome.management.getSelf().catch(() => null);
    // management API not always available; fall through and let injection fail naturally
    if (extInfo && !extInfo.hostPermissions?.includes("file://*/*")) {
      setStatus("error", 'Enable "Allow access to file URLs" in chrome://extensions');
      updateToggleUI(false);
      chrome.storage.local.set({ isOn: false });
      return;
    }
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: "ping" });
  } catch (e) {
    // Inject the content script when the page has not loaded it yet.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch (injectErr) {
      const isFile = tab.url?.startsWith("file://");
      setStatus(
        "error",
        isFile
          ? 'Enable "Allow access to file URLs" in chrome://extensions'
          : "Can't inject on this page",
      );
      updateToggleUI(false);
      chrome.storage.local.set({ isOn: false });
      return;
    }
  }

  if (turnOn) {
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
        } else {
          setStatus("success", "Translating page");
        }
      },
    );
  } else {
    setStatus("loading", "Restoring page...");
    chrome.tabs.sendMessage(tab.id, { action: "stopTranslation" }, () => {
      setStatus("ready", "Ready");
    });
  }
});

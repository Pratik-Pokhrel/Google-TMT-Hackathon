#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");

function fail(msg) {
  console.error("[FAIL]", msg);
  return false;
}

function ok(msg) {
  console.log("[OK]", msg);
  return true;
}

function checkFile(rel) {
  const p = path.join(root, rel);
  return fs.existsSync(p);
}

if (!fs.existsSync(manifestPath)) {
  console.error("manifest.json not found at project root");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error("Failed to parse manifest.json:", e.message);
  process.exit(1);
}

let allGood = true;

allGood = (manifest.manifest_version === 3 ? ok("manifest_version = 3") : fail("manifest_version should be 3")) && allGood;
allGood = (typeof manifest.name === "string" && manifest.name ? ok("name present") : fail("name missing in manifest")) && allGood;
allGood = (typeof manifest.version === "string" && manifest.version ? ok("version present") : fail("version missing in manifest")) && allGood;

// Background service worker
if (manifest.background && manifest.background.service_worker) {
  const bg = manifest.background.service_worker;
  allGood = (checkFile(bg) ? ok(`background worker found: ${bg}`) : fail(`background worker missing: ${bg}`)) && allGood;
} else {
  allGood = fail("background.service_worker missing in manifest") && allGood;
}

// Action / popup
if (manifest.action && manifest.action.default_popup) {
  allGood = (checkFile(manifest.action.default_popup) ? ok(`popup file present: ${manifest.action.default_popup}`) : fail(`popup missing: ${manifest.action.default_popup}`)) && allGood;
} else {
  allGood = fail("action.default_popup missing in manifest") && allGood;
}

// Content scripts
if (Array.isArray(manifest.content_scripts)) {
  for (const cs of manifest.content_scripts) {
    if (Array.isArray(cs.js)) {
      for (const js of cs.js) {
        allGood = (checkFile(js) ? ok(`content script present: ${js}`) : fail(`content script missing: ${js}`)) && allGood;
      }
    }
  }
} else {
  ok("no content_scripts declared (this may be fine)");
}

// Icons
if (manifest.icons) {
  for (const size of Object.keys(manifest.icons)) {
    const p = manifest.icons[size];
    allGood = (checkFile(p) ? ok(`icon present: ${p}`) : fail(`icon missing: ${p}`)) && allGood;
  }
}

// Helpful project files
allGood = (checkFile(path.join("scripts", "generate-config.mjs")) ? ok("generator script present") : fail("scripts/generate-config.mjs missing")) && allGood;
allGood = (checkFile(path.join(".env.example")) ? ok(".env.example present") : ok(".env.example not present — create one from README guidance")) && allGood;

// Config.js is generated; not required to be present in VCS. Warn if missing.
if (checkFile("config.js")) {
  ok("config.js present (ensure it contains your credentials if local)");
} else {
  console.warn("[WARN] config.js not found — run: node scripts/generate-config.mjs after creating .env");
}

console.log("");
if (allGood) {
  console.log("SUMMARY: All quick checks passed. The extension looks structurally sound.");
  process.exit(0);
} else {
  console.error("SUMMARY: Some checks failed. See messages above.");
  process.exit(1);
}

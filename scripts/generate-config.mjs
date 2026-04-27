import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const envPath = resolve(rootDir, ".env");
const outputPath = resolve(rootDir, "config.js");

function parseEnv(raw) {
  const env = {};
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function main() {
  let envRaw;

  try {
    envRaw = readFileSync(envPath, "utf8");
  } catch {
    console.error("[TMT] Missing .env file.");
    console.error("[TMT] Create .env from .env.example first.");
    process.exit(1);
  }

  const env = parseEnv(envRaw);
  const apiKey = env.TMT_API_KEY || "";
  const apiEndpoint = env.TMT_API_ENDPOINT || "";

  if (!apiKey || !apiEndpoint) {
    console.error("[TMT] Missing TMT_API_KEY or TMT_API_ENDPOINT in .env");
    process.exit(1);
  }

  const output = `// Generated from local .env by scripts/generate-config.mjs.\n// Keep this file local because it may include sensitive credentials.\n\nexport const API_KEY = ${JSON.stringify(apiKey)};\nexport const API_ENDPOINT = ${JSON.stringify(apiEndpoint)};\n`;

  writeFileSync(outputPath, output, "utf8");
  console.log("[TMT] Generated config.js from .env");
}

main();

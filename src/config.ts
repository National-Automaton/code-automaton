// Must come first: config.ts is a leaf module (only `node:` builtins), so this
// runs before the rest of the app — and the OpenAI SDK — is evaluated.
import { applyPunycodeShim } from "./punycode-shim.js";

applyPunycodeShim();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * First defined non-empty value among `names`. Lets newer CODA_* variables
 * take precedence while still honouring older DEEPSEEK_* ones.
 */
function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Load a .env file into process.env without overwriting existing vars.
 * Looks in the current working directory first, then the project root
 * (the directory containing this file's package), so `coda` works from
 * anywhere once linked globally.
 */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  ];

  for (const file of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return;
  }
}

export function loadConfig(): Config {
  loadDotEnv();

  // Any OpenAI-compatible endpoint works: DeepSeek, OpenRouter, Groq,
  // Together, a local Ollama/llama.cpp server, or OpenAI itself.
  const apiKey = env(
    "CODA_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    // Some setups export an Anthropic-shaped key that actually belongs to an
    // OpenAI-compatible endpoint. Only the key is borrowed here; the matching
    // ANTHROPIC_BASE_URL is never read (see below).
    "ANTHROPIC_API_KEY"
  );
  if (!apiKey) {
    console.error(
      "error: no API key found. Set CODA_API_KEY (or DEEPSEEK_API_KEY / " +
        "OPENAI_API_KEY / ANTHROPIC_API_KEY).\n" +
        "Copy .env.example to .env and fill it in, or export it in your shell."
    );
    process.exit(1);
  }

  // ANTHROPIC_BASE_URL is intentionally absent from this chain: values such as
  // https://api.deepseek.com/anthropic are Anthropic-shaped, not
  // OpenAI-compatible, so the client in agent.ts would fail against them.
  return {
    apiKey,
    baseURL:
      env("CODA_BASE_URL", "DEEPSEEK_BASE_URL", "OPENAI_BASE_URL") ??
      "https://api.deepseek.com",
    model: env("CODA_MODEL", "DEEPSEEK_MODEL", "OPENAI_MODEL") ?? "deepseek-chat",
  };
}

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
  /**
   * Model/endpoint used when a request contains an image. Each falls back to
   * its text counterpart, so text-only setups need no extra configuration.
   */
  visionModel: string;
  visionBaseURL: string;
  visionApiKey: string;
  /**
   * Whether to enable terminal mouse reporting. On (default) the wheel scrolls
   * the transcript, but the terminal stops doing its own drag-to-select while
   * coda runs (hold Shift to select). Off leaves drag-to-select alone and
   * gives up the wheel, for users who would rather select with the mouse.
   */
  mouse: boolean;
  /**
   * Whether independent read-only tool calls in one model response run
   * concurrently (default). When false every call runs in request order, which
   * is slower but gives strictly sequential semantics -- useful if a project's
   * shell commands assume they are the only thing running.
   */
  parallelTools: boolean;
  /**
   * Replace old turns with a summary once history passes the compaction
   * threshold, instead of waiting for the hard trim. Off by default: the
   * saving scales with input-token price, so it is worth enabling only on a
   * premium model. Set CODA_COMPACT=on to enable.
   */
  compact: boolean;
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
  const baseURL =
    env("CODA_BASE_URL", "DEEPSEEK_BASE_URL", "OPENAI_BASE_URL") ??
    "https://api.deepseek.com";
  const model = env("CODA_MODEL", "DEEPSEEK_MODEL", "OPENAI_MODEL") ?? "deepseek-chat";

  // Vision is optional: unset means "use the text endpoint", which keeps the
  // existing behaviour for anyone who never attaches an image. Sending an image
  // to a model without vision silently returns nonsense, so this is checked in
  // agent.ts rather than assumed.
  // Mouse reporting is on unless CODA_MOUSE is explicitly falsy. Only the
  // unambiguously-off spellings disable it, so a typo keeps the default rather
  // than silently turning the wheel off.
  const mouseEnv = (env("CODA_MOUSE") ?? "").toLowerCase();
  const mouse = !["0", "off", "false", "no", "none"].includes(mouseEnv);

  // Parallel tool calls are on unless CODA_PARALLEL_TOOLS says otherwise. Same
  // spellings as CODA_MOUSE, so one rule covers both.
  const parallelEnv = (env("CODA_PARALLEL_TOOLS") ?? "").toLowerCase();
  const parallelTools = !["0", "off", "false", "no", "none"].includes(parallelEnv);

  // History compaction is OFF by default and opted into with CODA_COMPACT=on.
  //
  // It is not automatic because the payoff depends entirely on input price:
  // measured against a real 285-turn session, compacting saved ~$0.30 on
  // deepseek-flash but ~$223 on claude-sonnet. Turning it on for everyone
  // would discard context and invalidate the provider's cache prefix to save
  // cents. Users on a premium model turn it on; the default costs nothing.
  const compactEnv = (env("CODA_COMPACT") ?? "").toLowerCase();
  const compact = ["1", "on", "true", "yes"].includes(compactEnv);

  return {
    apiKey,
    baseURL,
    model,
    visionModel: env("CODA_VISION_MODEL") ?? model,
    visionBaseURL: env("CODA_VISION_BASE_URL") ?? baseURL,
    visionApiKey: env("CODA_VISION_API_KEY") ?? apiKey,
    mouse,
    parallelTools,
    compact,
  };
}

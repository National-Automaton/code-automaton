// Must come first: config.ts is a leaf module (only `node:` builtins), so this
// runs before the rest of the app — and the OpenAI SDK — is evaluated.
import { applyPunycodeShim } from "./punycode-shim.js";

applyPunycodeShim();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * An alternative text endpoint, selectable from `/model`.
 *
 * The fields are the same three the default endpoint takes from `CODA_*`, plus
 * a name to show in the picker. `apiKey` is a *vault name*, never a key: the
 * value is read from `secrets.ts` when the endpoint is selected, so no
 * credential is ever written to `endpoints.json` or a session file.
 */
export interface Endpoint {
  /** Short label shown in the picker. Unique within the file. */
  name: string;
  baseURL: string;
  model: string;
  /**
   * Vault entry holding this endpoint's key. Optional when the endpoint
   * genuinely needs none (a local llama.cpp server accepts any bearer), in
   * which case an empty key is sent.
   */
  apiKey?: string;
}

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  /**
   * Additional text endpoints, in file order. The `CODA_*` endpoint is always
   * endpoint zero and is not listed here, so an empty array means "one
   * endpoint", which is the behaviour every existing setup already has.
   */
  endpoints: Endpoint[];
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

/**
 * Where `endpoints.json` lives.
 *
 * Beside the vault rather than in the working directory: endpoint *definitions*
 * are not secret (they name keys, they do not contain them), but they belong to
 * the user rather than to whichever project happens to be open, and a project
 * checkout is the wrong place for them -- `git clean` would remove them.
 *
 * `CODA_ENDPOINTS_FILE` overrides the whole path so tests never read the real
 * one.
 */
function endpointsPath(): string {
  const override = process.env.CODA_ENDPOINTS_FILE;
  if (override) return path.resolve(override);
  const base = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(base, "coda", "endpoints.json");
}

/**
 * Read `endpoints.json`, or return [] if it is absent or unusable.
 *
 * A malformed file warns and yields no endpoints rather than failing startup:
 * the `CODA_*` endpoint still works, so the user keeps a usable program and is
 * told why their extra endpoints are missing. Entries that are individually
 * invalid are skipped the same way -- one bad row must not remove the others.
 *
 * Nothing here reads a key. `apiKey` is recorded as a *name* for `secrets.ts` to
 * resolve later, so a malformed file can never echo a credential into a warning.
 */
export function loadEndpoints(): Endpoint[] {
  let raw: string;
  try {
    raw = fs.readFileSync(endpointsPath(), "utf8");
  } catch {
    return []; // absent is the normal case, not an error
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    console.error(`warning: ${endpointsPath()} is not valid JSON: ${e?.message ?? e}`);
    return [];
  }

  const rows = Array.isArray(parsed?.endpoints) ? parsed.endpoints : null;
  if (!rows) {
    console.error(`warning: ${endpointsPath()} has no "endpoints" array`);
    return [];
  }

  const out: Endpoint[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    const baseURL = typeof row?.baseURL === "string" ? row.baseURL.trim() : "";
    const model = typeof row?.model === "string" ? row.model.trim() : "";
    if (!name || !baseURL || !model) {
      console.error(`warning: ${endpointsPath()}: skipping an entry missing name, baseURL or model`);
      continue;
    }
    // Names address endpoints on the command line and in a saved session, so a
    // duplicate is ambiguous rather than harmless. The first one wins.
    if (seen.has(name)) {
      console.error(`warning: ${endpointsPath()}: duplicate endpoint "${name}" ignored`);
      continue;
    }
    seen.add(name);
    const apiKey = typeof row?.apiKey === "string" && row.apiKey.trim() ? row.apiKey.trim() : undefined;
    out.push({ name, baseURL, model, apiKey });
  }
  return out;
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
    endpoints: loadEndpoints(),
    visionModel: env("CODA_VISION_MODEL") ?? model,
    visionBaseURL: env("CODA_VISION_BASE_URL") ?? baseURL,
    visionApiKey: env("CODA_VISION_API_KEY") ?? apiKey,
    mouse,
    parallelTools,
    compact,
  };
}

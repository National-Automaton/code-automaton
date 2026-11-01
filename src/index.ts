#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { App } from "./app.js";
import { SESSIONS_DIR } from "./store.js";

/**
 * Read the version from package.json rather than hardcoding it, so `npm version`
 * is the only place it needs bumping. dist/index.js sits one level under the
 * package root in both a clone and a global install.
 */
const VERSION = (() => {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

const HELP = `Code Automaton — a terminal agentic coding tool with session recall.

Usage:
  coda [options]

Options:
  -h, --help      Show this help and exit.
  -v, --version   Print the version and exit.

Keys:
  Enter           Send the current line. While a turn is running, Enter folds
                  the text into it instead (the model sees it at its next
                  step, e.g. between tool calls).
  ←               Empty input: open session picker · else: move cursor
  →← / Home / End Move the cursor (Ctrl+A / Ctrl+E for line start / end)
  Ctrl+W / Alt+D  Delete previous / next word
  Ctrl+U / Ctrl+K Delete to start / end of line
  ↑ / ↓           Scroll transcript (PgUp / PgDn for a page, wheel also works)
  End             While scrolled back, return to the newest output
  Ctrl+R          Open the session picker:
                    type + Enter  = start a new session with that message
                    ↑/↓ + Enter   = open the highlighted session
                    d             = delete (asks y to confirm)
                    r             = rename the highlighted session
  Ctrl+T          New session
  Ctrl+X          Close current session
  Ctrl+C          Exit

Commands (typed into the input, sent with Enter):
  /quit, /exit        Exit and save sessions (same as quit / exit, or Ctrl+C)

Environment (any OpenAI-compatible endpoint works):
  CODA_API_KEY        (required) API key. Also reads DEEPSEEK_API_KEY /
                      OPENAI_API_KEY / ANTHROPIC_API_KEY, in that order.
  CODA_BASE_URL       API base URL (default: https://api.deepseek.com).
                      Also reads DEEPSEEK_BASE_URL / OPENAI_BASE_URL.
  CODA_MODEL          Model name (default: deepseek-chat)
  CODA_SESSIONS_DIR   Session storage (default: ~/.coda/sessions)

Images:
  /paste              Attach the image currently on the Windows clipboard
                      (WSL only). Copy a screenshot, then run /paste.
  /image <path>       Attach an image file to your next message. Messages
                      carrying an image are sent to the vision model.

  CODA_VISION_MODEL   Model used for image messages. Falls back to CODA_MODEL,
                      so a model without vision support will not see images.
  CODA_VISION_BASE_URL  Endpoint for the vision model. Falls back to
                      CODA_BASE_URL.
  CODA_VISION_API_KEY   Key for the vision model. Falls back to CODA_API_KEY.

Note: ANTHROPIC_BASE_URL is intentionally ignored. Anthropic-shaped URLs
(e.g. https://api.deepseek.com/anthropic) are not OpenAI-compatible.

coda starts on a new session. Your saved sessions are listed in the picker
(← or Ctrl+R) and stay one keypress away.

Sessions are saved to ${SESSIONS_DIR.replace(process.env.HOME ?? "", "~")}
and reloaded on start.`;

function parseArgs(argv: string[]): { help: boolean; version: boolean } {
  const out = { help: false, version: false };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "-v" || arg === "--version") out.version = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(`coda ${VERSION}`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("error: coda requires an interactive terminal (TTY).");
    process.exit(1);
  }

  const config = loadConfig();
  const app = new App(config);
  await app.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

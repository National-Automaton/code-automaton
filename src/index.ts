#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { App } from "./app.js";
import { SESSIONS_DIR } from "./store.js";
import { parseHeadlessArgs } from "./headless-args.js";
import { EXIT, runHeadless } from "./headless.js";

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
  coda [options]                 Open the interactive TUI.
  coda -p "prompt" [options]     Run one prompt unattended and exit.

Options:
  -h, --help      Show this help and exit.
  -v, --version   Print the version and exit.

Headless mode (for cron, Task Scheduler, CI):
  -p, --print     Run the prompt unattended, print the result, and exit. No
                  terminal is needed. The exit code reports the outcome:
                    0    success
                    1    the turn failed (API error, no final answer)
                    2    bad usage
                    3    a tool was refused by policy (see --allow)
                    124  the --timeout deadline passed
  --session NAME  Use the session titled NAME, creating it if there is none,
                  resuming the newest match otherwise.
  --no-resume     Always start a fresh session, even if NAME already exists.
                  Use this for a reproducible report: last week's errors do not
                  ride along in the history.
  --prompt-file F Read the prompt from F instead of the command line, for a
                  multi-line standing prompt.
  --report-path F Require F to be written by the run. If the model answered in
                  prose instead, the answer is saved there; a file left over
                  from an earlier run is a failure, not a success.
  --allow TOOLS   Comma-separated tools this run may use: read_file, write_file,
                  edit_file, list_dir, view_image, bash, new_session,
                  request_secret, use_secret, or "all". Default:
                  read_file,list_dir,view_image. Anything not listed is refused,
                  including the credentials vault and new sessions.
  --deny-ok       Treat a refused tool call as a failure. Off by default: the
                  model may have worked around a refusal successfully.
  --timeout D     Wall-clock limit for the turn, e.g. 30m, 90s, or 1800000ms.
                  Default 30m.
  --verbose       Stream the turn's text and tool calls to stderr.

  A headless run never prompts and never approves anything it was not told to.
  In particular write_file, edit_file, bash and use_secret are refused unless
  named in --allow, so a scheduled job can read the web and write its report
  without being able to touch the vault or spend a credential.

  Example — a weekly research report, Windows Task Scheduler:
    wsl.exe -d Ubuntu -- bash -lc 'cd ~/reports && coda -p --prompt-file prompt.md \\
      --session weekly-report --no-resume --allow read_file,write_file,bash \\
      --report-path "$(date +%F)-news.md" --timeout 45m'

Keys:
  Enter           Send the current line. While a turn is running, Enter folds
                  the text into it instead (the model sees it at its next
                  step, e.g. between tool calls).
  ←               Empty input: open session picker · else: move cursor
  →← / Home / End Move the cursor (Ctrl+A / Ctrl+E for line start / end)
  Ctrl+W / Alt+D  Delete previous / next word
  Ctrl+U / Ctrl+K Delete to start / end of line
  ↑ / ↓           Recall a previous prompt from this session, and edit it.
                  ↓ steps forward again, back to the half-typed draft.
  PgUp / PgDn     Scroll the transcript a page (the wheel scrolls too)
  End             While scrolled back, return to the newest output
  Ctrl+R          Open the session picker:
                    type + Enter  = start a new session with that message
                                    (a "/command" runs the command instead)
                    ↑/↓ + Enter   = open the highlighted session
                    Ctrl+X        = delete the highlighted session
                    Alt+R         = rename the highlighted session
  Ctrl+T          New session
  Ctrl+X          Close current session
  Alt+R           Rename the current session
  Ctrl+C          Exit

Commands (typed into the input, sent with Enter):
  /help, /?           Show the command and key reference
  /quit, /exit        Exit and save sessions (same as quit / exit, or Ctrl+C)
  /paste              Attach the image on the Windows clipboard (WSL)
  /image <path>       Attach an image file to your next message
  /rename <title>     Rename the current session. Without a title, opens the
                      interactive title editor (same as Alt+R).
  /prune-images       Delete cached screenshots no session refers to. The same
                      sweep runs at startup.

  A line starting with "/" that is not one of these is reported as an
  unknown command instead of being sent to the model.

Environment (any OpenAI-compatible endpoint works):
  CODA_API_KEY        (required) API key. Also reads DEEPSEEK_API_KEY /
                      OPENAI_API_KEY / ANTHROPIC_API_KEY, in that order.
  CODA_BASE_URL       API base URL (default: https://api.deepseek.com).
                      Also reads DEEPSEEK_BASE_URL / OPENAI_BASE_URL.
  CODA_MODEL          Model name (default: deepseek-chat)
  CODA_SESSIONS_DIR   Session storage (default: ~/.coda/sessions)
  CODA_IMAGES_DIR     Cached screenshots (default: ~/.coda/images)
  CODA_MOUSE          Mouse reporting (default: on). Set to "off" to leave the
                      mouse to the terminal, so drag-to-select works without
                      Shift; the wheel then scrolls the terminal, not coda.
  CODA_PARALLEL_TOOLS Tool calls (default: on). When the model requests several
                      independent read-only tools at once, they run
                      concurrently; anything that writes a file still runs in
                      order. Set to "off" for strict request order.

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

/** Whether argv asks for a headless run, judged before anything else. */
function wantsHeadless(argv: string[]): boolean {
  return argv.some((a) => a === "-p" || a === "--print" || a.startsWith("--print="));
}

async function main() {
  const argv = process.argv.slice(2);

  if (wantsHeadless(argv)) {
    const parsed = parseHeadlessArgs(argv, (p) => fs.readFileSync(p, "utf8"));
    if (parsed.help) {
      console.log(HELP);
      return;
    }
    if (parsed.version) {
      console.log(`coda ${VERSION}`);
      return;
    }
    if (parsed.error || parsed.missingPrompt || !parsed.options) {
      console.error(`error: ${parsed.error ?? "headless mode needs a prompt"}`);
      console.error(
        'usage: coda -p "prompt" [--session NAME] [--no-resume] [--report-path FILE]\n' +
          "                     [--allow TOOLS] [--timeout 30m] [--verbose]\n" +
          "       coda -p --prompt-file FILE ...   (see coda --help)"
      );
      process.exit(EXIT.usage);
    }
    process.exitCode = await runHeadless(parsed.options);
    return;
  }

  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(`coda ${VERSION}`);
    return;
  }

  // Headless runs need no terminal; the interactive TUI does. This check is
  // therefore only reached when no `-p`/`--print` was given.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("error: coda requires an interactive terminal (TTY).");
    console.error('For an unattended run, pass a prompt: coda -p "what to do"');
    process.exit(EXIT.usage);
  }

  const config = loadConfig();
  const app = new App(config);
  await app.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

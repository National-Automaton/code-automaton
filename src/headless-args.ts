/**
 * Command-line parsing for headless (`coda -p …`) runs.
 *
 * Kept separate from `headless.ts` -- which does the work -- so the parsing can
 * be tested on its own. It is a pure function of argv: no filesystem, no
 * environment, nothing that would make a test need a terminal or a network.
 *
 * Headless mode is triggered by `-p` / `--print`. Without that flag the rest is
 * parsed exactly as before, so `coda` with no arguments still opens the TUI and
 * a stray flag cannot silently turn an interactive session into a batch run.
 */

/** Tool names a headless run may use without asking. */
export const MUTATING_TOOLS = ["write_file", "edit_file", "bash"] as const;

export interface HeadlessOptions {
  /** The prompt, already resolved from `--prompt-file` if one was given. */
  prompt: string;
  /**
   * Session to name. Created if no session holds this title, otherwise the
   * newest one is resumed (see `--no-resume`).
   */
  session: string | null;
  /** Start a fresh session even if `session` matches an existing one. */
  noResume: boolean;
  /** Write the final assistant message here when the run succeeds. */
  reportPath: string | null;
  /** Hard wall-clock limit for the whole run, in ms. */
  timeoutMs: number;
  /**
   * Tools that may run unattended. Everything else is refused. `null` means
   * "no approvals at all" -- every gated tool refuses, which is the default for
   * anything the caller did not ask for.
   */
  allow: Set<string>;
  /** Whether a refusal should end the run with a failure. */
  failOnDenied: boolean;
  /** Print each step to stderr as it happens. */
  verbose: boolean;
}

export interface ParseResult {
  options?: HeadlessOptions;
  error?: string;
  /** The prompt was asked for but not supplied. */
  missingPrompt?: boolean;
  help?: boolean;
  version?: boolean;
}

/** Default wall-clock limit: long enough for a research turn, short enough that cron notices. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Tools allowed by default: the ones that only read. */
export const DEFAULT_ALLOW = ["read_file", "list_dir", "view_image"] as const;

const KNOWN_TOOLS = new Set<string>([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "view_image",
  "bash",
  "new_session",
  "request_secret",
  "use_secret",
]);

function parseMillis(raw: string, flag: string): number | string {
  // Accept a bare number of seconds ("1800") or a suffixed duration ("30m",
  // "2h", "90s"). Seconds is the common case for a timeout and keeps the
  // command line short; a missing suffix therefore reads as seconds, not
  // milliseconds, because a 1800ms deadline would be useless as a default.
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) return `${flag} expects a duration such as 30m, 90s, or 1800000ms`;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(n * factor);
  if (!Number.isFinite(ms) || ms <= 0) return `${flag} must be a positive duration`;
  return ms;
}

/**
 * Parse argv for a headless run.
 *
 * `readFile` is injected so the caller (and tests) can supply `--prompt-file`
 * contents; the parser itself never touches disk.
 */
export function parseHeadlessArgs(
  argv: string[],
  readFile: (path: string) => string
): ParseResult {
  const opts: HeadlessOptions = {
    prompt: "",
    session: null,
    noResume: false,
    reportPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allow: new Set(DEFAULT_ALLOW),
    failOnDenied: true,
    verbose: false,
  };
  let print = false;
  let promptParts: string[] = [];
  let promptFile: string | null = null;
  let allowTouched = false;

  // `--` ends flag parsing, so a prompt that starts with a dash can still be
  // passed literally.
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq !== -1 ? arg.slice(eq + 1) : null;
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined) return null;
      i++;
      return next;
    };

    if (endOfFlags) {
      promptParts.push(arg);
      continue;
    }

    switch (name) {
      case "--":
        endOfFlags = true;
        break;
      case "-h":
      case "--help":
        return { help: true };
      case "-v":
      case "--version":
        return { version: true };
      case "-p":
      case "--print":
        print = true;
        // `-p "prompt"` is the common form; `--print=prompt` also works.
        if (inline !== null) promptParts.push(inline);
        break;
      case "--session": {
        const v = value();
        if (v === null || !v.trim()) return { error: "--session needs a name" };
        opts.session = v.trim();
        break;
      }
      case "--no-resume":
        opts.noResume = true;
        break;
      case "--prompt-file": {
        const v = value();
        if (v === null || !v.trim()) return { error: "--prompt-file needs a path" };
        promptFile = v;
        break;
      }
      case "--report-path": {
        const v = value();
        if (v === null || !v.trim()) return { error: "--report-path needs a path" };
        opts.reportPath = v;
        break;
      }
      case "--timeout": {
        const v = value();
        if (v === null) return { error: "--timeout needs a duration" };
        const ms = parseMillis(v, "--timeout");
        if (typeof ms === "string") return { error: ms };
        opts.timeoutMs = ms;
        break;
      }
      case "--allow": {
        const v = value();
        if (v === null) return { error: "--allow needs a comma-separated list of tools" };
        // The first --allow replaces the default read-only set, so the flag can
        // be trusted to describe exactly what will run. `--allow=all` is the
        // explicit way to say "everything".
        if (!allowTouched) {
          opts.allow = new Set();
          allowTouched = true;
        }
        for (const raw of v.split(",")) {
          const t = raw.trim();
          if (!t) continue;
          if (t === "all") {
            for (const k of KNOWN_TOOLS) opts.allow.add(k);
            continue;
          }
          if (!KNOWN_TOOLS.has(t)) {
            return {
              error: `--allow: unknown tool "${t}". Known: ${[...KNOWN_TOOLS].join(", ")}, all`,
            };
          }
          opts.allow.add(t);
        }
        break;
      }
      case "--deny-ok":
        opts.failOnDenied = false;
        break;
      case "-V":
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") {
          return { error: `unknown option "${arg}"` };
        }
        promptParts.push(arg);
    }
  }

  if (!print) {
    // Not a headless run. Say so plainly rather than guessing: the caller opens
    // the TUI, and any flags seen here are the TUI's business.
    return { missingPrompt: false, options: undefined };
  }

  if (promptFile) {
    let text: string;
    try {
      text = readFile(promptFile);
    } catch (err: any) {
      return { error: `--prompt-file: cannot read ${promptFile}: ${err?.message ?? err}` };
    }
    if (promptParts.length) {
      return { error: "give the prompt inline or with --prompt-file, not both" };
    }
    opts.prompt = text;
  } else {
    opts.prompt = promptParts.join(" ").trim();
  }

  if (!opts.prompt.trim()) return { missingPrompt: true };
  return { options: opts };
}

/** One-line summary of what a headless run may do, for the log. */
export function describePolicy(opts: HeadlessOptions): string {
  const allowed = [...opts.allow].sort();
  const gated = [...KNOWN_TOOLS].filter((t) => !opts.allow.has(t)).sort();
  return (
    `allowed without asking: ${allowed.length ? allowed.join(", ") : "(none)"}; ` +
    `refused: ${gated.length ? gated.join(", ") : "(none)"}`
  );
}

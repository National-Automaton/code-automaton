import { promises as fs } from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { attachImage } from "./image.js";
import { containsSecret, getSecret, redact, trackSecret } from "./secrets.js";

const execAsync = promisify(exec);

export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from disk and return its contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given contents. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace the first occurrence of `old_string` with `new_string` in a file. `old_string` must match exactly.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path. Defaults to '.'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description:
        "Show an image file to yourself so you can see it. Use this for a " +
        "screenshot or diagram on disk, or to look again at an image from " +
        "earlier in the conversation ([image sent: <path>] in the history " +
        "means it was sent once and is no longer in view).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the image file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the current working directory and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_secret",
      description:
        "Ask the user for a credential and store it in the credentials vault. " +
        "Use this when a task needs a credential that is not stored yet: the user " +
        "is shown a prompt and types the value hidden, so it never reaches you. " +
        "Returns only whether it was saved. Do not ask for passwords in ordinary " +
        "chat -- a value typed into the conversation is in the transcript and " +
        "cannot be scrubbed. Supports several secrets in one call.",
      parameters: {
        type: "object",
        properties: {
          secrets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description:
                    "Vault name to store under: lowercase letters, digits, . _ -",
                },
                label: {
                  type: "string",
                  description:
                    "What to ask for, e.g. 'WordPress username for runningafever.com'.",
                },
                hidden: {
                  type: "boolean",
                  description:
                    "True (default) to mask the input. Set false for a non-secret " +
                    "like a username, so the user can see what they typed.",
                },
              },
              required: ["name", "label"],
            },
          },
        },
        required: ["secrets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_secret",
      description:
        "Run a command with credentials from the credentials vault, without the " +
        "values ever being shown to you. Write the command as a program and " +
        "arguments (no shell) and put `{{secret:NAME}}` where a value belongs; the " +
        "host substitutes it after you have finished writing, so you never see the " +
        "result. EVERY use is confirmed by the user before it runs, and output is " +
        "scrubbed of every known secret before it is returned.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
            description:
              "The program and its arguments as separate strings. No shell runs, " +
              "so there is no quoting, globbing, piping or redirection.",
          },
          stdin: {
            type: "string",
            description:
              "Optional text for the child's stdin. `{{secret:NAME}}` may be used " +
              "here too -- useful where a program reads a password from stdin " +
              "rather than an argument.",
          },
          secret: {
            type: "string",
            description:
              "Optional: a single vault secret to write to the child's stdin when " +
              "`stdin` is not given.",
          },
        },
        required: ["command"],
      },
    },
  },
];

export interface ToolResult {
  ok: boolean;
  output: string;
  /**
   * Image paths the tool wants shown to the model.
   *
   * A tool cannot return pixels: the chat-completions schema allows image parts
   * only on `user` messages, and a `tool` message's content is `string |
   * TextPart[]`. So a tool that needs the model to *see* something returns the
   * paths here, and the agent attaches them on a `user` message immediately
   * after the tool result.
   */
  attach?: string[];
  /** Set by `use_secret` to say what the user was asked to approve. */
  requiresConfirmation?: {
    /** Secret names referenced by the command, in order of first use. */
    secrets: string[];
    /** The command as the model wrote it, with no substituted values. */
    argv: string[];
    /** Human-readable summary for the prompt. */
    summary: string;
  };
}

/** Names of the `{{secret:NAME}}` placeholders in `text`. */
export function secretNamesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{secret:([a-z0-9][a-z0-9._-]*)\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Replace `{{secret:NAME}}` in `text` with the stored values.
 *
 * Returns null and a list of the names that are missing, so the caller can tell
 * the model which credential it needs instead of running a command with an
 * empty argument -- which would look like an auth failure and waste a turn.
 *
 * Every value that is substituted is `trackSecret`ed. That is not decoration:
 * `redact` only masks values this process knows about, so a secret loaded from
 * disk in a previous session would otherwise pass through the transcript
 * untouched.
 */
export function substituteSecrets(text: string): { ok: true; text: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\{\{secret:([a-z0-9][a-z0-9._-]*)\}\}/g, (_all, name: string) => {
    const value = getSecret(name);
    if (value === null) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    trackSecret(value);
    return value;
  });
  return missing.length ? { ok: false, missing } : { ok: true, text: out };
}

/**
 * Run a vault-backed command.
 *
 * Deliberately `execFile` and not `exec`: no shell is involved, so the argv
 * array is passed to the process as-is. That matters twice over -- it stops a
 * credential being re-parsed by a shell, and it keeps shell metacharacters in a
 * substituted value from being interpreted.
 *
 * `stdin` is used for credentials a program reads from its input, which keeps
 * the value out of `argv` entirely and therefore out of `ps`.
 */
export async function runWithSecrets(args: {
  command: string[];
  stdin?: string;
  secret?: string;
}): Promise<ToolResult> {
  const argv = Array.isArray(args.command) ? args.command.map(String) : null;
  if (!argv || argv.length === 0) {
    return { ok: false, output: "use_secret: `command` must be a non-empty array of strings" };
  }

  // Refuse before running if a *literal* value got into the command line as the
  // model wrote it: that would expose it via `ps`, which is the whole reason
  // this tool exists. Checked on the text *before* substitution -- the
  // substituted text necessarily contains the value, so checking after would
  // refuse every correct use.
  if (containsSecret(argv.join("\n"))) {
    return {
      ok: false,
      output:
        "use_secret: refused -- the command contains a known secret literally. " +
        "Use a {{secret:NAME}} placeholder instead.",
    };
  }

  // Substitute into argv and stdin, collecting anything missing.
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const part of argv) {
    const r = substituteSecrets(part);
    if (r.ok) resolved.push(r.text);
    else missing.push(...r.missing);
  }

  let stdin = args.stdin;
  if (typeof stdin === "string" && stdin !== "") {
    const r = substituteSecrets(stdin);
    if (r.ok) stdin = r.text;
    else missing.push(...r.missing);
  } else if (typeof args.secret === "string" && args.secret !== "") {
    const value = getSecret(args.secret);
    if (value === null) missing.push(args.secret);
    else {
      trackSecret(value);
      stdin = value;
    }
  }

  if (missing.length) {
    const list = [...new Set(missing)].join(", ");
    return {
      ok: false,
      output:
        `use_secret: missing credential(s): ${list}. ` +
        `Ask the user to run /secret add <name> for it.`,
    };
  }

  try {
    return await new Promise<ToolResult>((resolve) => {
      // `spawn`, not `execFile`: only `spawn` gives a writable stdin, and only
      // `spawn` guarantees no shell. The value is written to the child's input
      // so it never appears in the process table.
      const child = spawn(resolved[0], resolved.slice(1), {
        cwd: process.cwd(),
        shell: false,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });

      let out = "";
      let done = false;
      const cap = 10 * 1024 * 1024;
      const collect = (chunk: Buffer) => {
        if (out.length < cap) out += chunk.toString();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      // A hung child must not wedge the turn: this is the same budget `bash`
      // gets, after which the call fails with what was collected so far.
      const timer = setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, 120_000);

      const finish = (ok: boolean, extra = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const text = redact((out + (extra ? "\n" + extra : "")).trim() || "(no output)");
        resolve({ ok, output: clampOutput(text) });
      };

      child.on("error", (err: any) => finish(false, err?.message ?? String(err)));
      child.on("close", (code) => {
        finish(
          code === 0,
          code === 0 ? "" : `(exit code ${code})`
        );
      });

      if (stdin !== undefined && child.stdin) {
        child.stdin.on("error", () => {
          // The child may exit without reading its input; that is its business,
          // and the close handler above reports the real outcome.
        });
        child.stdin.end(stdin);
      }
    });
  } catch (err: any) {
    return { ok: false, output: redact(err?.message ?? String(err)) };
  }
}

/**
 * Cap on a single tool's output, in characters.
 *
 * A tool result is pushed into the conversation history and re-sent on every
 * later step of the loop, so one oversized result is not a one-off cost -- it
 * is charged again on each round trip, and it can permanently overflow the
 * model's context window (a 1M-token request against a 1M-token model fails
 * forever after). 200k characters is roughly 50k tokens: generous for any real
 * read, small enough that history stays bounded.
 */
export const MAX_TOOL_OUTPUT_CHARS = 200_000;

/** How much of a truncated output to keep from its head and its tail. */
const TRUNCATED_HEAD_CHARS = 150_000;
const TRUNCATED_TAIL_CHARS = 50_000;

/**
 * Clamp `text` to `MAX_TOOL_OUTPUT_CHARS`, keeping the head and the tail.
 *
 * Head *and* tail are kept because both carry meaning: the start of a file or
 * a command's output, and the end, where errors and summaries land. A note in
 * the middle says what was dropped and how to see it, so the model can react
 * (read a range, grep, narrow the command) instead of guessing from a stump.
 */
export function clampOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;

  // Size the note first and pay for it out of the head, so the result can never
  // exceed the limit however long the numbers in the note turn out to be.
  const tail = text.slice(-TRUNCATED_TAIL_CHARS);
  let note = "";
  let head = "";
  for (;;) {
    const headChars = Math.max(0, MAX_TOOL_OUTPUT_CHARS - tail.length - note.length);
    const dropped = text.length - headChars - tail.length;
    const next =
      `\n\n[... ${dropped} characters truncated by coda (output was ${text.length} chars, ` +
      `limit ${MAX_TOOL_OUTPUT_CHARS}); showing the first ${headChars} and last ` +
      `${tail.length} characters. Ask for a narrower read or command to see more.]\n\n`;
    if (next === note) break;
    note = next;
    head = text.slice(0, headChars);
  }
  return head + note + tail;
}

/**
 * True if `buf` is binary rather than text: any NUL byte, or invalid UTF-8.
 *
 * `read_file` used to return whatever `fs.readFile(..., "utf8")` produced, so
 * pointing it at a JPEG returned megabytes of mojibake -- and because tool
 * output is re-sent with the history, that one call wedged the session at the
 * model's context limit. Binary is detected and refused instead.
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  // A UTF-8 decode that is not round-trip clean means the bytes were not text.
  const text = buf.toString("utf8");
  return Buffer.byteLength(text, "utf8") !== buf.length || text.includes("\uFFFD");
}

/**
 * Tools that never write.
 *
 * `bash` is here deliberately, not by oversight: it *can* write, but the
 * alternative is parsing shell commands to decide, and a wrong guess is worse
 * than the serialised run it would avoid. Anyone who needs strict request order
 * can set `parallelTools` to false and every call runs serially again.
 */
const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "bash"]);

/**
 * The filesystem path a call touches, or null if it takes no path.
 *
 * `bash` takes a command, not a path, so it has none and is exempt from the
 * per-path rule -- two commands may hit the same file and there is no way to
 * know. Every path-taking tool is listed, readers included: two reads of one
 * file are harmless, but keeping the rule "one call per path" is what makes it
 * easy to reason about, and it already covers a writer if one is ever batched.
 */
function touchedPath(name: string, args: any): string | null {
  if (name === "read_file" || name === "write_file" || name === "edit_file") {
    return typeof args?.path === "string" ? path.resolve(args.path) : null;
  }
  return null;
}

/**
 * True if this call may change the working tree.
 *
 * Unknown tools count as writers, so a tool added later is serialised until it
 * is explicitly listed as read-only.
 */
export function writesSomething(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name);
}

/**
 * Indices of `calls` that can be started together, in a single batch.
 *
 * The model routinely asks for several tools in one response -- three
 * `read_file`s, or a `grep` and a `list_dir` -- and running those one after
 * another is pure waiting. The rule for batching is deliberately conservative:
 *
 *  - every call must be read-only. A writer forces the whole turn back to
 *    serial order, because `edit_file` and `write_file` both read-modify-write
 *    a file and a racing writer would clobber the other's result;
 *  - no two calls may name the same path, and a batch stops at the first
 *    repeat, so the order of a call's effect on a file stays predictable;
 *  - `bash` is treated as read-only (see READ_ONLY_TOOLS): it is batched
 *    rather than serialised, and the `parallelTools` config flag turns the
 *    whole feature off for anyone who would rather every call ran in order.
 *
 * Returns the indices of the longest leading run of calls that may be
 * parallelised. Everything after them runs serially, in order, which keeps the
 * transcript and the tool messages deterministic regardless of timing.
 */
export function parallelBatch(calls: Array<{ name: string; args: any }>): number[] {
  const batch: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < calls.length; i++) {
    const { name, args } = calls[i];
    if (writesSomething(name)) break;
    const target = touchedPath(name, args);
    if (target && seen.has(target)) break;
    if (target) seen.add(target);
    batch.push(i);
  }
  return batch;
}

export async function runTool(name: string, args: any): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file": {
        const buf = await fs.readFile(args.path);
        if (looksBinary(buf)) {
          return {
            ok: false,
            output:
              `refused to read ${args.path}: binary file (${buf.length} bytes). ` +
              `read_file returns text only. For an image, use view_image; for ` +
              `anything else, use a command such as \`file\`, \`head -c 256\`, or ` +
              `\`strings\`.`,
          };
        }
        return { ok: true, output: clampOutput(buf.toString("utf8")) };
      }
      case "view_image": {
        const img = await attachImage(args.path);
        return {
          ok: true,
          output: `showing ${img.path} (${img.mime}, ${(img.bytes / 1024).toFixed(1)} KB)`,
          attach: [img.absPath],
        };
      }
      case "write_file": {
        // A credential must not be persisted to disk by a tool. This catches
        // the accident (a secret pasted or substituted into file content), not
        // a deliberate exfiltration -- a subprocess redirecting its own output
        // never passes through here.
        if (containsSecret(String(args.content ?? ""))) {
          return {
            ok: false,
            output: "refused to write: the content contains a credential from the vault",
          };
        }
        await fs.mkdir(path.dirname(path.resolve(args.path)), { recursive: true });
        await fs.writeFile(args.path, args.content, "utf8");
        return { ok: true, output: `wrote ${args.content.length} bytes to ${args.path}` };
      }
      case "edit_file": {
        // Both halves are checked: the replacement may add a credential, and
        // the match text may be a credential already sitting in the file.
        if (
          containsSecret(String(args.new_string ?? "")) ||
          containsSecret(String(args.old_string ?? ""))
        ) {
          return {
            ok: false,
            output: "refused to edit: the change contains a credential from the vault",
          };
        }
        const original = await fs.readFile(args.path, "utf8");
        const idx = original.indexOf(args.old_string);
        if (idx === -1) {
          return { ok: false, output: "old_string not found in file" };
        }
        const updated =
          original.slice(0, idx) +
          args.new_string +
          original.slice(idx + args.old_string.length);
        await fs.writeFile(args.path, updated, "utf8");
        return { ok: true, output: `edited ${args.path}` };
      }
      case "list_dir": {
        const dir = args.path ?? ".";
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { ok: true, output: clampOutput(lines.join("\n")) };
      }
      case "bash": {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, output: clampOutput((stdout + stderr).trim() || "(no output)") };
      }
      case "use_secret": {
        // Confirmation is the agent's job (see `Agent.send`): this is a plain
        // runner and has no way to ask the user anything. The agent refuses the
        // call before reaching here when the user has not approved it.
        return await runWithSecrets(args);
      }
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { ok: false, output: `error: ${err?.message ?? String(err)}` };
  }
}

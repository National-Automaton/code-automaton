import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { attachImage } from "./image.js";

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
        await fs.mkdir(path.dirname(path.resolve(args.path)), { recursive: true });
        await fs.writeFile(args.path, args.content, "utf8");
        return { ok: true, output: `wrote ${args.content.length} bytes to ${args.path}` };
      }
      case "edit_file": {
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
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { ok: false, output: `error: ${err?.message ?? String(err)}` };
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

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
}

export async function runTool(name: string, args: any): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file": {
        const content = await fs.readFile(args.path, "utf8");
        return { ok: true, output: content };
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
        return { ok: true, output: lines.join("\n") };
      }
      case "bash": {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, output: (stdout + stderr).trim() || "(no output)" };
      }
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { ok: false, output: `error: ${err?.message ?? String(err)}` };
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Standing instructions the user wants applied to every session.
 *
 * `coda`'s system prompt was fixed: there was nowhere to record "always do X"
 * or "never do Y", so a preference had to be repeated in every conversation and
 * was forgotten the moment the history was trimmed. This module loads ordinary
 * markdown from two places and appends it to the system prompt.
 *
 * Two files, because the reasons differ:
 *
 *  - `~/.config/coda/INSTRUCTIONS.md` — global, applies to every project.
 *  - `<project>/.coda/INSTRUCTIONS.md` — per project, loadable from a repo and
 *    therefore shareable, which a personal file is not.
 *
 * Both are outside the session store and are never written by `coda`: these are
 * the user's words, and a tool that edits its own instructions can quietly
 * change its own rules.
 */

/** Cap on the combined instructions, in characters. */
export const MAX_INSTRUCTIONS_CHARS = 8_000;

/** The global instructions file. Overridable so tests never read the real one. */
export function globalInstructionsPath(): string {
  const override = process.env.CODA_INSTRUCTIONS;
  if (override) return path.resolve(override);
  const base = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(base, "coda", "INSTRUCTIONS.md");
}

/** The per-project instructions file for `cwd`. */
export function projectInstructionsPath(cwd = process.cwd()): string {
  return path.join(cwd, ".coda", "INSTRUCTIONS.md");
}

function readIfPresent(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * Text to append to the system prompt, or "" when nothing is configured.
 *
 * Each file is labelled with its path so the model can tell a global rule from
 * a project one -- "never merge a PR" and "use tabs here" carry different
 * weight, and the model should be able to say which it is following.
 *
 * Truncated at `MAX_INSTRUCTIONS_CHARS` with a note, because this text is
 * prepended to every request: an accidental paste of a large file would
 * otherwise be re-sent on every turn of every session.
 */
export function loadInstructions(cwd = process.cwd()): string {
  const parts: string[] = [];
  const global = readIfPresent(globalInstructionsPath());
  if (global) parts.push(`# Standing instructions (global, ${globalInstructionsPath()})\n\n${global}`);
  const project = readIfPresent(projectInstructionsPath(cwd));
  if (project) {
    parts.push(`# Project instructions (${projectInstructionsPath(cwd)})\n\n${project}`);
  }
  if (parts.length === 0) return "";

  let text = parts.join("\n\n");
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    text =
      text.slice(0, MAX_INSTRUCTIONS_CHARS) +
      `\n\n[... instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
  }
  return text;
}

/**
 * The system prompt for a session, with the user's instructions appended.
 *
 * Appended rather than prepended: the built-in prompt describes what the tool
 * is and can do, and the user's text is a set of constraints on top of that.
 * The trailing position also means a very long instructions file cannot push
 * the tool description out of the model's attention.
 */
export function systemPrompt(base: string, cwd = process.cwd()): string {
  const extra = loadInstructions(cwd);
  if (!extra) return base;
  return (
    base +
    "\n\nThe user has recorded standing instructions below. Follow them: they " +
    "are preferences that apply to every session unless a later message " +
    "overrides them.\n\n" +
    extra
  );
}

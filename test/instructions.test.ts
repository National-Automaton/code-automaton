/**
 * Standing instructions: the user's rules, loaded into the system prompt.
 *
 * The bug this prevents is subtle and was real: a rule can exist on disk and
 * still not reach the model. So the tests check the assembled *prompt text*,
 * not just that a file was read -- and they check that a missing or empty file
 * leaves the built-in prompt exactly as it was, since appending a stray header
 * would change behaviour for everyone who never uses the feature.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

const root = `${process.env.TMPDIR ?? "/tmp"}/coda-instr-test-${process.pid}`;
const globalFile = path.join(root, "INSTRUCTIONS.md");
const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });
process.env.CODA_INSTRUCTIONS = globalFile;

const {
  MAX_INSTRUCTIONS_CHARS,
  globalInstructionsPath,
  loadInstructions,
  projectInstructionsPath,
  systemPrompt,
} = await import("../src/instructions.js");
const { SYSTEM_PROMPT } = await import("../src/agent.js");

const BASE = "You are a test assistant.";
const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

// --- nothing configured: the prompt is untouched --------------------------

{
  assert.equal(globalInstructionsPath(), globalFile, "the override is honoured");
  assert.equal(loadInstructions(project), "", "no files means no instructions");
  assert.equal(
    systemPrompt(BASE, project),
    BASE,
    "an unused feature must not change the prompt at all"
  );
}

// --- global instructions reach the prompt ---------------------------------

{
  const RULE = "Never merge or close a pull request. Always let me merge.";
  write(globalFile, RULE);
  const text = loadInstructions(project);
  assert.ok(text.includes(RULE), "the rule is loaded");
  assert.ok(text.includes(globalFile), "the source file is named");

  const prompt = systemPrompt(BASE, project);
  assert.ok(prompt.startsWith(BASE), "the built-in prompt comes first");
  assert.ok(prompt.includes(RULE), "the rule is appended");
  assert.ok(
    /standing instructions/i.test(prompt),
    "the model is told these are instructions to follow"
  );
}

// --- project instructions are separate and labelled -----------------------

{
  const PROJECT_RULE = "This project uses tabs, not spaces.";
  write(projectInstructionsPath(project), PROJECT_RULE);
  const text = loadInstructions(project);
  assert.ok(text.includes("Standing instructions (global"), "global section is labelled");
  assert.ok(text.includes("Project instructions"), "project section is labelled");
  assert.ok(text.includes("Never merge") && text.includes(PROJECT_RULE), "both are present");
  // The model must be able to tell them apart: a global rule and a project
  // convention carry different weight.
  assert.ok(
    text.indexOf("Never merge") < text.indexOf(PROJECT_RULE),
    "global comes before project"
  );
}

// A project without its own file still gets the global rules.
{
  const other = path.join(root, "other");
  fs.mkdirSync(other, { recursive: true });
  const text = loadInstructions(other);
  assert.ok(text.includes("Never merge"), "global applies everywhere");
  assert.ok(!text.includes("tabs"), "another project's rules do not leak in");
}

// --- empty and whitespace-only files are ignored --------------------------

{
  const blank = path.join(root, "blank");
  process.env.CODA_INSTRUCTIONS = path.join(root, "empty.md");
  write(path.join(root, "empty.md"), "   \n\n\t\n");
  assert.equal(loadInstructions(blank), "", "a whitespace-only file is not instructions");
  assert.equal(systemPrompt(BASE, blank), BASE, "and does not touch the prompt");
}

// --- long instructions are capped -----------------------------------------

{
  process.env.CODA_INSTRUCTIONS = globalFile;
  write(globalFile, "x".repeat(MAX_INSTRUCTIONS_CHARS + 5_000));
  const text = loadInstructions(project);
  assert.ok(
    text.length <= MAX_INSTRUCTIONS_CHARS + 200,
    `instructions must be capped, got ${text.length}`
  );
  assert.ok(/truncated/.test(text), "the cap is explained, not silent");
}

// --- the real system prompt keeps its own text ----------------------------

{
  process.env.CODA_INSTRUCTIONS = globalFile;
  write(globalFile, "Rule: always answer in one sentence.");
  assert.ok(SYSTEM_PROMPT.includes("coding assistant"), "the exported prompt is the real one");
  const full = systemPrompt(SYSTEM_PROMPT, project);
  assert.ok(full.includes("coding assistant"), "the base survives");
  assert.ok(full.includes("always answer in one sentence"), "the rule is applied");
  // Order: instructions must not precede the description of the tool itself.
  assert.ok(
    full.indexOf("coding assistant") < full.indexOf("always answer"),
    "built-in prompt precedes user instructions"
  );
}

fs.rmSync(root, { recursive: true, force: true });
console.log("instructions.test.ts: ok");

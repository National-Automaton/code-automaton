/**
 * `run_interactive`: handing the terminal to a command that needs one.
 *
 * `gh auth login` and its like prompt, open a browser and print a code. Coda's
 * tools spawn children without a TTY, so those commands could not run at all.
 *
 * What this file can and cannot check: the real handover needs a terminal, so
 * the suspension and restore are pinned structurally (and by the app's own
 * invariants), while the decisions around it -- refusing to run blindly, and
 * never letting a credential travel through a command whose output is not
 * redacted -- are tested directly.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-interactive-"));
process.env.CODA_SECRETS_DIR = path.join(dir, "secrets");
process.env.CODA_SESSIONS_DIR = path.join(dir, "sessions");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { runTool } = await import("../src/tools.js");
const { setSecret } = await import("../src/secrets.js");
const { Agent } = await import("../src/agent.js");

const SECRET = "tok-CONFIDENTIAL-9f8e7d";

// --- the tool requests a handover rather than running ---------------------

{
  const r = await runTool("run_interactive", { command: ["gh", "auth", "login"] });
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(r.interactive, { argv: ["gh", "auth", "login"] },
    "the tool asks; nothing has run");
  // Proof nothing ran: a real invocation would have failed with gh absent or
  // printed something, and the output is deliberately empty here.
  assert.equal(r.output, "", "no output is claimed for a command that has not run");
}

// --- bad input is refused before the user is bothered ---------------------

for (const args of [{}, { command: [] }, { command: "gh auth login" }]) {
  const r = await runTool("run_interactive", args);
  assert.equal(r.ok, false, `${JSON.stringify(args)} is refused`);
  assert.equal(r.interactive, undefined);
}

// --- a credential must not travel through an uncaptured command ----------

{
  setSecret("deploy", SECRET);
  const r = await runTool("run_interactive", {
    command: ["git", "push", `https://x:${SECRET}@example.test/repo`],
  });
  assert.equal(r.ok, false, "a literal secret is refused");
  assert.ok(/use_secret/i.test(r.output), `points at the tool that redacts: ${r.output}`);
}

{
  // Placeholders are refused too: the substitution happens in `use_secret`,
  // which captures and redacts output. An interactive child writes straight to
  // the screen, where nothing masks what it prints.
  const r = await runTool("run_interactive", {
    command: ["deploy", "{{secret:deploy}}"],
  });
  assert.equal(r.ok, false, "a placeholder is refused for an interactive command");
  assert.ok(/not substituted/i.test(r.output), r.output);
}

// --- the agent asks before handing over ----------------------------------

{
  const cfg = {
    apiKey: "sk-test-placeholder",
    baseURL: "https://example.invalid",
    model: "m",
    visionModel: "",
    visionBaseURL: "https://example.invalid",
    visionApiKey: "sk-test-placeholder",
    endpoints: [],
    mouse: false,
    parallelTools: true,
    compact: false,
  } as any;
  const a: any = new Agent(cfg);

  let asked: string | null = null;
  let handed: string[] | null = null;
  a.setConfirm(async (summary: string) => {
    asked = summary;
    return "yes" as const;
  });
  a.setHandOver(async (argv: string[]) => {
    handed = argv;
    return { ok: true, output: "ran interactively and exited 0." };
  });

  const res: any = await a.runOneTool("run_interactive", { command: ["aws", "sso", "login"] }, () => {});
  assert.ok(asked, "the user is asked");
  assert.ok(/Hand the terminal/i.test(asked as any), `the prompt says what is happening: ${asked}`);
  assert.ok(/aws sso login/.test(asked as any), "and names the command");
  assert.deepEqual(handed, ["aws", "sso", "login"], "the handover runs the command as written");
  assert.equal(res.ok, true);
}

{
  // Declining must not hand over, and must not let the model retry blindly.
  const cfg = {
    apiKey: "sk-test-placeholder", baseURL: "https://example.invalid", model: "m",
    visionModel: "", visionBaseURL: "https://example.invalid",
    visionApiKey: "sk-test-placeholder", endpoints: [], mouse: false,
    parallelTools: true, compact: false,
  } as any;
  const a: any = new Agent(cfg);
  let handed = false;
  a.setConfirm(async () => "no" as const);
  a.setHandOver(async () => {
    handed = true;
    return { ok: true, output: "" };
  });

  const res: any = await a.runOneTool("run_interactive", { command: ["gh", "auth", "login"] }, () => {});
  assert.equal(handed, false, "a declined request never hands over");
  assert.equal(res.ok, false);
  assert.ok(/declined/i.test(res.output), res.output);
}

{
  // With no terminal to hand over (a headless run), refuse rather than pretend.
  const cfg = {
    apiKey: "sk-test-placeholder", baseURL: "https://example.invalid", model: "m",
    visionModel: "", visionBaseURL: "https://example.invalid",
    visionApiKey: "sk-test-placeholder", endpoints: [], mouse: false,
    parallelTools: true, compact: false,
  } as any;
  const a: any = new Agent(cfg);
  a.setConfirm(async () => "yes" as const);
  const res: any = await a.runOneTool("run_interactive", { command: ["gh", "auth", "login"] }, () => {});
  assert.equal(res.ok, false, "no handover callback means no handover");
  assert.ok(/cannot hand over/i.test(res.output), res.output);
}

console.log("interactive.test.ts: ok");

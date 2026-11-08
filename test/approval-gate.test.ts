/**
 * The approval gate on `use_secret`.
 *
 * A credential is spent only after the user says yes. What matters:
 *
 *  - the prompt names the secrets and the command as the model wrote it, so the
 *    decision can be made without showing any value;
 *  - a refusal is a readable tool result, not a thrown error -- the model must
 *    be able to adapt rather than have the turn fail;
 *  - nothing runs and no secret is read before the answer arrives;
 *  - approval is per session and per name: approving one credential must not
 *    approve another, and a new session starts over.
 *
 * `runOneTool` is private; these tests drive it through the public surface it
 * exposes for exactly this purpose (approvals, setConfirm, the gate itself).
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";

const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-gate-test-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { setSecret } = await import("../src/secrets.js");
const { Agent } = await import("../src/agent.js");

const config = {
  apiKey: "sk-test",
  baseURL: "https://text.example/v1",
  model: "deepseek-flash",
  visionModel: "gemini-3.6-flash",
  visionBaseURL: "https://vision.example/v1",
  visionApiKey: "sk-vision",
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

setSecret("wp", "wp-secret-value-123456");
setSecret("yt", "yt-secret-value-123456");

/** Reach the private gate; it is the unit under test. */
const gate = (a: any, name: string, args: any, emit: any = () => {}) =>
  (a as any).runOneTool(name, args, emit);

// --- no prompt installed: refuse rather than run ---------------------------

{
  const a: any = new Agent(config);
  const res = await gate(a, "use_secret", { command: ["sh", "-c", "echo {{secret:wp}}"] });
  assert.equal(res.ok, false, "a session with no way to ask must not spend a credential");
  assert.ok(/needs approval/.test(res.output), res.output);
  assert.ok(!res.output.includes("wp-secret-value"), "the value is not in the refusal");
}

// --- decline: readable result, and nothing ran ----------------------------

{
  const a: any = new Agent(config);
  let asked: { summary: string; secrets: string[] } | null = null;
  a.setConfirm(async (summary: string, secrets: string[]) => {
    asked = { summary, secrets };
    return "no";
  });

  const marker = `${dir}/should-not-exist`;
  const res = await gate(a, "use_secret", {
    command: ["sh", "-c", `touch ${marker}`, "{{secret:wp}}"],
  });

  assert.equal(res.ok, false, "a declined call fails");
  assert.ok(/declined/.test(res.output), res.output);
  assert.ok(/Do not try again/.test(res.output), "the model is told not to retry blindly");
  assert.ok(!existsSync(marker), "the command must not have run");

  // The prompt named what was at stake, without a value.
  assert.ok(asked, "the user was asked");
  assert.deepEqual((asked as any).secrets, ["wp"]);
  assert.ok((asked as any).summary.includes("{{secret:wp}}"), "the argv is shown as written");
  assert.ok(
    !(asked as any).summary.includes("wp-secret-value"),
    "the prompt must never contain the value"
  );
}

// --- approve once: runs, and the result is redacted -----------------------

{
  const a: any = new Agent(config);
  a.setConfirm(async () => "yes");
  const res = await gate(a, "use_secret", {
    command: ["sh", "-c", "printf %s \"$0\"", "{{secret:wp}}"],
  });
  assert.equal(res.ok, true, res.output);
  assert.ok(!res.output.includes("wp-secret-value"), "the value is scrubbed from the result");
  assert.ok(res.output.includes("[redacted]"), `expected redaction, got: ${res.output}`);
}

// --- "always" remembers for this session, per name ------------------------

{
  const a: any = new Agent(config);
  let calls = 0;
  a.setConfirm(async () => {
    calls++;
    return "always";
  });

  await gate(a, "use_secret", { command: ["sh", "-c", "true", "{{secret:wp}}"] });
  assert.equal(calls, 1, "the first use asks");

  await gate(a, "use_secret", { command: ["sh", "-c", "true", "{{secret:wp}}"] });
  assert.equal(calls, 1, "a second use of the same secret does not ask again");
  assert.deepEqual(a.approved, ["wp"], "the approval is recorded by name");

  // A *different* credential still needs its own approval.
  await gate(a, "use_secret", { command: ["sh", "-c", "true", "{{secret:yt}}"] });
  assert.equal(calls, 2, "another secret is not covered by the first approval");
}

// --- approval does not carry to another session ---------------------------

{
  const a: any = new Agent(config);
  const b: any = new Agent(config);
  a.setConfirm(async () => "always");
  await gate(a, "use_secret", { command: ["sh", "-c", "true", "{{secret:wp}}"] });

  let askedB = 0;
  b.setConfirm(async () => {
    askedB++;
    return "no";
  });
  const res = await gate(b, "use_secret", { command: ["sh", "-c", "true", "{{secret:wp}}"] });
  assert.equal(askedB, 1, "a new session asks again");
  assert.equal(res.ok, false);
}

// --- ordinary tools are untouched by the gate ----------------------------

{
  const a: any = new Agent(config);
  let asked = false;
  a.setConfirm(async () => {
    asked = true;
    return "no";
  });
  const res = await gate(a, "list_dir", { path: dir });
  assert.equal(res.ok, true, "a non-secret tool runs without prompting");
  assert.equal(asked, false, "and does not consult the user");
}

console.log("approval-gate.test.ts: ok");

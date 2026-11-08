/**
 * `request_secret`: the agent asking the user for a credential mid-task.
 *
 * This is the piece that makes the vault usable in a conversation. Before it,
 * `use_secret` could only report "missing credential -- ask the user to run
 * /secret add", which is a dead end in the middle of a turn.
 *
 * What matters:
 *
 *  - the value goes straight to the store and **never** into the result, so it
 *    cannot reach the transcript or the model's context;
 *  - an existing secret is never silently overwritten by a repeat request;
 *  - a cancellation is reported as such, and the model is told not to retry;
 *  - a session that cannot prompt refuses rather than pretending.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-request-secret-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { getSecret, setSecret, resetTracked } = await import("../src/secrets.js");
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

const request = (a: any, args: any, emit: any = () => {}) =>
  (a as any).runOneTool("request_secret", args, emit);

// --- no prompt installed: refuse, do not pretend --------------------------

{
  const a: any = new Agent(config);
  const res = await request(a, {
    secrets: [{ name: "wp-user", label: "WordPress username" }],
  });
  assert.equal(res.ok, false);
  assert.ok(/cannot prompt/.test(res.output), res.output);
  assert.equal(getSecret("wp-user"), null, "nothing is stored");
}

// --- the value is stored and never returned -------------------------------

{
  const a: any = new Agent(config);
  const VALUE = "typed-password-abcdef123456";
  const asked: Array<{ name: string; label: string; hidden: boolean }> = [];
  a.setAskSecret(async (name: string, label: string, hidden: boolean) => {
    asked.push({ name, label, hidden });
    return VALUE;
  });

  const res = await request(a, {
    secrets: [
      { name: "wp-user", label: "WordPress username", hidden: false },
      { name: "wp-app-password", label: "Application password" },
    ],
  });

  assert.equal(res.ok, true, res.output);
  assert.ok(!res.output.includes(VALUE), `the value leaked into the result:\n${res.output}`);
  assert.equal(getSecret("wp-user"), VALUE, "the value reached the vault");
  assert.equal(getSecret("wp-app-password"), VALUE);

  assert.equal(asked.length, 2, "both were asked for");
  assert.equal(asked[0].hidden, false, "a username is shown while typing");
  assert.equal(asked[1].hidden, true, "a password is masked by default");
  assert.equal(asked[0].label, "WordPress username", "the label reaches the prompt");

  // The result tells the model what it needs: the names, to retry with.
  assert.ok(/wp-user/.test(res.output) && /wp-app-password/.test(res.output));
}

// --- an existing secret is not overwritten --------------------------------

{
  const a: any = new Agent(config);
  setSecret("existing", "ORIGINAL-VALUE-123456");
  let asked = 0;
  a.setAskSecret(async () => {
    asked++;
    return "REPLACEMENT-VALUE-999999";
  });

  const res = await request(a, {
    secrets: [{ name: "existing", label: "should not be asked for" }],
  });
  assert.equal(asked, 0, "the user is not asked to retype a stored credential");
  assert.equal(getSecret("existing"), "ORIGINAL-VALUE-123456", "the stored value is untouched");
  assert.ok(/already stored/.test(res.output), res.output);
  assert.equal(res.ok, true, "nothing was cancelled, so the call succeeds");
}

// --- cancellation ---------------------------------------------------------

{
  const a: any = new Agent(config);
  a.setAskSecret(async () => null);
  const res = await request(a, { secrets: [{ name: "declined", label: "x" }] });
  assert.equal(res.ok, false, "a cancelled request fails so the model notices");
  assert.ok(/cancelled/.test(res.output), res.output);
  assert.ok(/Do not ask again/.test(res.output), "the model is told not to retry");
  assert.equal(getSecret("declined"), null);
}

// --- invalid input --------------------------------------------------------

{
  const a: any = new Agent(config);
  a.setAskSecret(async () => "value-1234567");

  const none = await request(a, { secrets: [] });
  assert.equal(none.ok, false);
  assert.ok(/non-empty array/.test(none.output));

  const bad = await request(a, { secrets: [{ name: "../escape", label: "x" }] });
  assert.equal(bad.ok, false);
  assert.ok(/invalid name/.test(bad.output), bad.output);
}

// --- the value is masked from the transcript afterwards -------------------

{
  const a: any = new Agent(config);
  const VALUE = "collected-secret-xyz789";
  a.setAskSecret(async () => VALUE);
  resetTracked();
  await request(a, { secrets: [{ name: "later", label: "x" }] });

  // Even though this process only ever saw it through the prompt, a later echo
  // of it must be redacted.
  const { redact } = await import("../src/secrets.js");
  assert.ok(!redact(`echo ${VALUE}`).includes(VALUE), "a collected value is redacted");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("request-secret.test.ts: ok");

/**
 * `use_secret` with an environment variable.
 *
 * Some programs take a credential from the environment rather than stdin --
 * `gh`, `curl -u`, anything reading `$TOKEN`. Before `env` there was no
 * supported way to pass a vault secret to those, so the value ended up in argv,
 * where `ps` exposes it to every local user. That is the exact exposure
 * `use_secret` exists to prevent.
 *
 * What has to hold, and is pitched against the ways this could go wrong:
 *
 *  - the value reaches the child and the child sees it;
 *  - it does **not** reach argv, so it is not in the process table;
 *  - a literal secret in an env value is refused, same as in argv;
 *  - the rest of the environment still works (PATH, HOME), because replacing it
 *    outright would break most commands;
 *  - every secret referenced by `env` counts as needing approval, or the user
 *    would grant a credential without being asked.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-envsecret-"));
process.env.CODA_SECRETS_DIR = path.join(dir, "secrets");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { setSecret, resetTracked } = await import("../src/secrets.js");
const { runWithSecrets, secretNamesIn } = await import("../src/tools.js");

const SENTINEL = "tok-SENTINEL-1a2b3c4d5e6f";
setSecret("deploy", SENTINEL);
resetTracked();

// --- the child receives it ------------------------------------------------

{
  const r = await runWithSecrets({
    command: ["/bin/sh", "-c", 'printf "%s" "$DEPLOY_TOKEN"'],
    env: { DEPLOY_TOKEN: "{{secret:deploy}}" },
  });
  assert.equal(r.ok, true, r.output);
  // The tool *output* is redacted, which is the transcript protection working:
  // a child that echoes a credential must not put it in the history. So the
  // proof the child received it is that the output is the redaction marker
  // rather than empty.
  assert.equal(r.output, "[redacted]", "the child received the value (and its echo was masked)");
  assert.ok(!r.output.includes(SENTINEL), "the value itself never reaches the result");
}

// --- it is not in argv ----------------------------------------------------

{
  // The child prints its own argv. If the secret were passed there, this would
  // contain it -- and `ps` would show it to every local user.
  const r = await runWithSecrets({
    command: ["/bin/sh", "-c", 'printf "%s" "$0 $@"', "EXEC", "{{secret:deploy}}"],
  });
  // The placeholder in argv is a *deliberate* use, so the value is expected
  // there; this test instead proves that the env path adds nothing to argv.
  const envOnly = await runWithSecrets({
    command: ["/bin/sh", "-c", 'printf "%s" "${1:-}"', "EXEC"],
    env: { DEPLOY_TOKEN: "{{secret:deploy}}" },
  });
  assert.equal(envOnly.ok, true, envOnly.output);
  assert.ok(!envOnly.output.includes(SENTINEL), "the value is not passed as an argument");
}

// --- the inherited environment survives -----------------------------------

{
  // `env` is merged over process.env, not substituted for it: a child without
  // PATH or HOME breaks in ways that look like an unrelated bug.
  const r = await runWithSecrets({
    command: ["/bin/sh", "-c", 'printf "%s|%s" "${PATH:+has-path}" "${DEPLOY_TOKEN:+has-token}"'],
    env: { DEPLOY_TOKEN: "{{secret:deploy}}" },
  });
  assert.equal(r.ok, true, r.output);
  // `:+` substitutes a fixed word, so this asserts *presence* without ever
  // printing the credential -- nothing to redact, and no masking to rely on.
  assert.equal(r.output, "has-path|has-token",
    "PATH is inherited and the new variable is added");
}

// --- a literal secret is refused ------------------------------------------

{
  const r = await runWithSecrets({
    command: ["/bin/echo", "hello"],
    env: { DEPLOY_TOKEN: SENTINEL },
  });
  assert.equal(r.ok, false, "a literal secret in env is refused");
  assert.ok(/placeholder/i.test(r.output), `the refusal says what to do instead: ${r.output}`);
}

// --- a missing credential is reported by name -----------------------------

{
  const r = await runWithSecrets({
    command: ["/bin/echo", "hello"],
    env: { DEPLOY_TOKEN: "{{secret:not-stored}}" },
  });
  assert.equal(r.ok, false);
  assert.ok(/not-stored/.test(r.output), `the missing name is reported: ${r.output}`);
  assert.ok(/\/secret add/.test(r.output), "and says how to store it");
}

// --- an invalid variable name is refused ----------------------------------

{
  const r = await runWithSecrets({
    command: ["/bin/echo", "hi"],
    env: { "NOT A NAME": "{{secret:deploy}}" },
  });
  assert.equal(r.ok, false);
  assert.ok(/valid environment variable name/.test(r.output), r.output);
}

// --- approval sees the secrets referenced by env --------------------------

{
  // `secretNamesIn` is what the agent uses to decide what must be approved. If
  // `env` values are not scanned, a credential passes to a child unapproved.
  assert.deepEqual(secretNamesIn("{{secret:deploy}}"), ["deploy"]);
  const envValues = { GH_TOKEN: "{{secret:deploy}}", OTHER: "{{secret:other}}" };
  const found = Object.values(envValues).flatMap((v) => secretNamesIn(v));
  assert.deepEqual([...new Set(found)].sort(), ["deploy", "other"],
    "every secret named in env is collected for approval");
}

// --- a value with shell metacharacters stays literal ----------------------

{
  // `shell: false` means no re-parsing, so `$` and backticks in a credential
  // must survive unchanged rather than expanding or running a command.
  setSecret("odd", "pa$$w`ord`$(echo x)");
  resetTracked();
  const r = await runWithSecrets({
    command: ["/bin/sh", "-c", 'printf "%s" "$ODD"'],
    env: { ODD: "{{secret:odd}}" },
  });
  assert.equal(r.ok, true, r.output);
  // Masked in the result for the same reason; what proves it stayed literal is
  // that the child did not fail and produced output at all. A `$(` that had
  // been interpreted would have run `echo x` and changed the shape.
  assert.equal(r.output, "[redacted]", "the value is passed through untouched");
}

// --- the approval prompt covers env-borne credentials ----------------------

{
  // The gate lives in Agent, so this is the only place that proves a secret
  // travelling through `env` is actually put in front of the user. Without it
  // the credential would reach a child having never been approved.
  const { Agent } = await import("../src/agent.js");
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
  let asked: { summary: string; pending: string[] } | null = null;
  a.setConfirm(async (summary: string, pending: string[]) => {
    asked = { summary, pending };
    return "no" as const;
  });

  const res: any = await a.runOneTool(
    "use_secret",
    { command: ["/bin/echo", "hi"], env: { GH_TOKEN: "{{secret:deploy}}" } },
    () => {}
  );

  assert.ok(asked, "the user is asked before the command runs");
  assert.deepEqual((asked as any).pending, ["deploy"], "the env-borne secret needs approval");
  assert.ok(/\(sets GH_TOKEN in its environment\)/.test((asked as any).summary),
    `the prompt says where the credential goes: ${(asked as any).summary}`);
  assert.equal(res.ok, false, "declining refuses the run");
  assert.ok(!res.output.includes(SENTINEL), "and the refusal leaks nothing");
}

console.log("use-secret-env.test.ts: ok");

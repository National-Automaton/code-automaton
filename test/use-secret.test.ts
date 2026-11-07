/**
 * `use_secret`: spending a vault credential without exposing it.
 *
 * The properties worth pinning are the ones that would leak the value:
 *
 *  1. **Not in argv.** A credential on a command line is visible to any local
 *     user via `/proc/<pid>/cmdline`. The tool must pass it on stdin, and this
 *     checks the child's own view of its arguments.
 *  2. **Not in the result.** A child that echoes its input back must still
 *     produce a redacted tool result -- that output is the transcript.
 *  3. **Not in a write.** `write_file`/`edit_file` refuse content containing a
 *     tracked value, so the easy accident cannot persist a credential.
 *  4. **Missing credentials fail loudly** with the name, rather than running a
 *     command with an empty argument that looks like an auth failure.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-usesecret-test-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { setSecret, resetTracked, trackSecret, hasSecret } = await import("../src/secrets.js");
const { runWithSecrets, secretNamesIn, substituteSecrets, runTool } = await import(
  "../src/tools.js"
);

const SECRET = "pw-SUPER-SECRET-abcdef123456";
setSecret("wp", SECRET);
resetTracked(); // prove track-on-read, not track-on-write

// --- placeholder parsing ---------------------------------------------------

assert.deepEqual(secretNamesIn("a {{secret:wp}} b"), ["wp"]);
assert.deepEqual(secretNamesIn("{{secret:a}} {{secret:b}} {{secret:a}}"), ["a", "b"], "deduplicated");
assert.deepEqual(secretNamesIn("no placeholders"), []);
assert.deepEqual(secretNamesIn("{{secret:Bad Name}}"), [], "names obey the vault's rules");

// Substitution happens host-side and tracks the value for redaction.
{
  resetTracked();
  const r = substituteSecrets("pw={{secret:wp}}");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.text, `pw=${SECRET}`);
  // The point of tracking: `redact` must now mask it even though this process
  // never called setSecret for it.
  const { redact } = await import("../src/secrets.js");
  assert.ok(!redact(`echo ${SECRET}`).includes(SECRET), "a loaded value is redacted after tracking");
}

// A missing secret is reported by name, not substituted as empty.
{
  const r = substituteSecrets("{{secret:nope}}");
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok === false && r.missing, ["nope"]);
}

// --- the credential is not in argv ----------------------------------------

{
  // The child prints its own /proc view of its arguments. If the value were on
  // the command line, it would appear here.
  const res = await runWithSecrets({
    command: ["sh", "-c", 'cat /proc/self/cmdline | tr "\\0" " "; echo; echo "stdin=$(cat)"'],
    stdin: "{{secret:wp}}\n",
  });
  assert.equal(res.ok, true, res.output);
  assert.ok(!res.output.includes(SECRET), `the secret appeared in output:\n${res.output}`);
  assert.ok(
    res.output.includes("[redacted]"),
    `stdin should have been read and redacted, got:\n${res.output}`
  );
}

// The `secret` shorthand puts the value on stdin without substitution.
{
  const res = await runWithSecrets({ command: ["sh", "-c", "cat"], secret: "wp" });
  assert.equal(res.ok, true);
  assert.ok(!res.output.includes(SECRET), "the shorthand must be redacted too");
}

// --- failures are readable and redacted -----------------------------------

{
  const res = await runWithSecrets({ command: ["sh", "-c", "echo oops >&2; exit 3"] });
  assert.equal(res.ok, false, "a non-zero exit is reported as failure");
  assert.ok(res.output.includes("oops"), "stderr is returned");
  assert.ok(/exit code 3/.test(res.output), "the exit code is included");
}

{
  const res = await runWithSecrets({ command: ["definitely-not-a-real-binary-xyz"] });
  assert.equal(res.ok, false, "a missing program fails rather than throwing");
}

{
  const res = await runWithSecrets({ command: [] as string[] });
  assert.equal(res.ok, false);
  assert.ok(/non-empty array/.test(res.output));
}

{
  const res = await runWithSecrets({ command: ["echo", "{{secret:missing-one}}"] });
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("missing-one"), "the missing name is named");
  assert.ok(
    /\/secret add/.test(res.output),
    "the model is told how the user can fix it"
  );
}

// A literal secret in the command is refused: that would put it in argv.
{
  resetTracked();
  trackSecret(SECRET);
  const res = await runWithSecrets({ command: ["echo", SECRET] });
  assert.equal(res.ok, false);
  assert.ok(/refused/.test(res.output), `expected a refusal, got: ${res.output}`);
  assert.ok(!res.output.includes(SECRET), "the refusal must not repeat the secret");
}

// --- write guards ----------------------------------------------------------

{
  const target = `${dir}/out.txt`;
  fs.mkdirSync(dir, { recursive: true });
  resetTracked();
  trackSecret(SECRET);

  const w = await runTool("write_file", { path: target, content: `token=${SECRET}` });
  assert.equal(w.ok, false, "write_file must refuse a credential");
  assert.ok(!fs.existsSync(target), "nothing is written");

  fs.writeFileSync(target, "clean contents\n");
  const e = await runTool("edit_file", {
    path: target,
    old_string: "clean",
    new_string: SECRET,
  });
  assert.equal(e.ok, false, "edit_file must refuse to insert a credential");
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "clean contents\n",
    "the file is untouched"
  );

  // With nothing tracked, ordinary writes are unaffected.
  resetTracked();
  const ok = await runTool("write_file", { path: target, content: "plain text" });
  assert.equal(ok.ok, true, "an ordinary write still works");
}

// --- cleanup ---------------------------------------------------------------

fs.rmSync(dir, { recursive: true, force: true });
assert.equal(hasSecret("wp"), false, "cleanup removed the vault");

console.log("use-secret.test.ts: ok");

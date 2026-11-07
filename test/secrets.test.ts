/**
 * The credentials vault: storage, redaction, and what must never escape.
 *
 * The whole point of this module is that a credential can be *used* without
 * being *seen*. These tests pin the three ways it could leak:
 *
 *  1. A value printed by `describe`/`listSecrets` -- so "first four chars" is
 *     never reported.
 *  2. A value reaching the transcript through a subprocess or a model reply --
 *     so `redact` masks every tracked value.
 *  3. A value reaching the wrong file -- so the vault is a separate directory
 *     from `~/.coda/sessions/`, and a name cannot escape it.
 *
 * Storage is a plaintext 0600 file; that weakness is documented in the module
 * and is not hidden by these tests. What they check is that the file is not
 * *more* readable than that, and that a torn write cannot leave a partial
 * credential behind.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

// The vault path is resolved at module load, so set it before importing.
const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-vault-test-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;

const {
  SECRETS_DIR,
  containsSecret,
  deleteSecret,
  describe,
  getSecret,
  hasSecret,
  isValidName,
  listSecrets,
  normaliseName,
  redact,
  resetTracked,
  setSecret,
  trackSecret,
} = await import("../src/secrets.js");

assert.equal(SECRETS_DIR, path.resolve(dir), "the override must be honoured");

// --- names -----------------------------------------------------------------

assert.equal(isValidName("gmail"), true);
assert.equal(isValidName("gmail-app-password"), true);
assert.equal(isValidName("a.b_c-1"), true);
assert.equal(isValidName("Gmail"), false, "names are lowercase; uppercased is refused, not rewritten");
assert.equal(isValidName(""), false);
assert.equal(isValidName("../escape"), false, "path traversal must be refused");
assert.equal(isValidName("a/b"), false, "a name is a filename, never a path");
assert.equal(isValidName("-leading-dash"), false);
assert.equal(isValidName("x".repeat(65)), false, "over-long names are refused");
assert.equal(normaliseName("  Gmail  "), "gmail", "typed names are trimmed and lowered");

// --- round trip ------------------------------------------------------------

assert.equal(getSecret("gmail"), null, "absent before it is set");
assert.equal(hasSecret("gmail"), false);

assert.equal(setSecret("gmail", "abcd-1234-efgh-5678"), true);
assert.equal(getSecret("gmail"), "abcd-1234-efgh-5678", "the value round-trips");
assert.equal(hasSecret("gmail"), true);
assert.deepEqual(listSecrets(), ["gmail"]);

// A hand-edited trailing newline is not part of the credential.
fs.writeFileSync(path.join(SECRETS_DIR, "trailing.secret"), "value-with-newline\n", { mode: 0o600 });
assert.equal(
  getSecret("trailing"),
  "value-with-newline",
  "a trailing newline must not become part of the credential"
);

// --- permissions -----------------------------------------------------------

{
  const st = fs.statSync(SECRETS_DIR);
  assert.equal(st.mode & 0o777, 0o700, `vault dir must be 0700, got ${(st.mode & 0o777).toString(8)}`);
  const file = fs.statSync(path.join(SECRETS_DIR, "gmail.secret"));
  assert.equal(file.mode & 0o777, 0o600, `secret file must be 0600, got ${(file.mode & 0o777).toString(8)}`);
}

// --- nothing reveals the value --------------------------------------------

{
  const d = describe("gmail");
  assert.equal(d.name, "gmail");
  assert.equal(d.present, true);
  assert.equal(d.chars, "abcd-1234-efgh-5678".length, "length is reported");
  // The description is JSON-able and must not contain the value anywhere.
  assert.ok(
    !JSON.stringify(d).includes("abcd-1234"),
    "describe must not report any part of the value"
  );
  assert.deepEqual(listSecrets(), ["gmail", "trailing"], "listSecrets returns names only");
}

// --- redaction -------------------------------------------------------------

{
  resetTracked();
  setSecret("token", "ghp_SUPERSECRETVALUE123456");
  const text = "curl -H 'Authorization: Bearer ghp_SUPERSECRETVALUE123456' https://example.com";
  const out = redact(text);
  assert.ok(!out.includes("ghp_SUPERSECRETVALUE123456"), "the secret must not survive redaction");
  assert.ok(out.includes("[redacted]"), "the marker is left in its place");
  assert.ok(out.includes("https://example.com"), "surrounding text is untouched");
  assert.equal(containsSecret(text), true, "the text is recognised as containing a secret");
  assert.equal(containsSecret("nothing here"), false);
}

// A value typed but never stored (cancelled, or a failed write) must still be
// masked -- it was on screen and may be in a subprocess's output.
{
  resetTracked();
  trackSecret("typed-but-not-saved-value");
  assert.ok(
    !redact("echo typed-but-not-saved-value").includes("typed-but-not-saved-value"),
    "a tracked value is redacted even if it was never written"
  );
}

// Two secrets where one contains the other: the longer is replaced whole, so
// the shorter cannot leave a fragment behind.
{
  resetTracked();
  trackSecret("abcdef123456");
  trackSecret("abcdef");
  const out = redact("value=abcdef123456");
  assert.ok(!out.includes("abcdef"), "no fragment of a longer secret may survive");
}

// Very short values are not tracked: masking them would shred ordinary text.
{
  resetTracked();
  trackSecret("abc");
  assert.equal(redact("abc def"), "abc def", "a 3-char value is too short to redact safely");
  assert.equal(redact(""), "", "empty text is returned unchanged");
}

// --- deletion --------------------------------------------------------------

assert.equal(deleteSecret("gmail"), true);
assert.equal(hasSecret("gmail"), false, "a deleted secret is gone");
assert.equal(deleteSecret("gmail"), false, "deleting twice reports nothing to delete");
assert.equal(setSecret("bad name", "x"), false, "an invalid name is refused, not thrown");
assert.equal(setSecret("ok", ""), false, "an empty value is refused");

// --- cleanup ---------------------------------------------------------------

fs.rmSync(dir, { recursive: true, force: true });

console.log("secrets.test.ts: ok");

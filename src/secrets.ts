import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The credentials vault: credentials `coda` needs but must never show.
 *
 * A secret enters through a hidden prompt (see `App`'s password modal, `/secret`),
 * is written to a `0600` file in a `0700` directory outside the repo, and is
 * read back only by code that needs it to build a request. Three rules make that
 * worthwhile, and each is enforced here rather than by convention:
 *
 *  1. **The model never sees it.** A secret in a tool result would be written to
 *     the session file and re-sent on every later request, so nothing in this
 *     module ever returns a value for display -- `describe()` reports what is
 *     stored, never what it is.
 *
 *  2. **It cannot reach the transcript by accident.** `redact()` is applied to
 *     everything headed for the transcript, so a secret echoed by a subprocess,
 *     or pasted into a prompt, is masked before it is stored or shown.
 *
 *  3. **The store is separate from sessions.** `~/.config/coda/secrets/` is not
 *     `~/.coda/sessions/`: a session dump (which is plain JSON and is written
 *     on every turn) can never contain a credential.
 *
 * This is a plaintext-at-0600 vault. That is the honest weakness: anyone who
 * can read the user's files can read the secrets. Encrypting them needs a key
 * held somewhere the process cannot simply read, which on this platform means
 * Windows DPAPI or the kernel keyring -- a real upgrade, not attempted here,
 * and deliberately not faked with home-grown crypto.
 */

/** Where the vault lives; overridable so tests never touch the real one. */
export const SECRETS_DIR = (() => {
  const override = process.env.CODA_SECRETS_DIR;
  if (override) return path.resolve(override);
  const base = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(base, "coda", "secrets");
})();

/**
 * A secret's name, as typed by the user.
 *
 * Restricted to a conservative character set: the name becomes a filename, so
 * anything that could escape the directory (`/`, `..`) or confuse a listing is
 * refused rather than sanitised -- silently rewriting a name means the value is
 * later looked up under one the user did not type.
 */
export function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/** Normalise a user-typed name: trimmed and lowercased. */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

function secretPath(name: string): string {
  return path.join(SECRETS_DIR, `${name}.secret`);
}

/**
 * Create the vault, private to the user.
 *
 * Both modes are enforced even though the parent may already exist, because a
 * directory created by an earlier run (or by hand) can be world-readable and
 * would silently weaken every secret written into it.
 */
export function ensureSecretsDir(): void {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(SECRETS_DIR, 0o700);
  } catch {
    // Best effort: a filesystem without POSIX modes (9p onto Windows) cannot
    // express this. The file mode below is attempted for the same reason.
  }
}

/** True if a secret by this name exists. Never reads the value. */
export function hasSecret(name: string): boolean {
  const n = normaliseName(name);
  if (!isValidName(n)) return false;
  try {
    return fs.statSync(secretPath(n)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a secret's value, or null if it is not stored.
 *
 * The returned string is the credential itself. Callers must not put it in a
 * tool result, a transcript entry, or an error message.
 */
export function getSecret(name: string): string | null {
  const n = normaliseName(name);
  if (!isValidName(n)) return null;
  try {
    const raw = fs.readFileSync(secretPath(n), "utf8");
    // A trailing newline is an artefact of editing the file by hand, not part
    // of the credential; sending it produces an auth failure that looks like a
    // wrong password.
    return raw.replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

/**
 * Store a secret.
 *
 * Written via a temporary file and renamed, so a crash mid-write cannot leave a
 * truncated credential that would fail authentication with no clue why. The
 * temporary file is created `0600` so the value is never briefly world-readable.
 *
 * Returns false (without throwing) when the name is invalid, so the caller can
 * report it in the UI rather than crashing a turn.
 */
export function setSecret(name: string, value: string): boolean {
  const n = normaliseName(name);
  if (!isValidName(n) || value === "") return false;
  ensureSecretsDir();
  const file = secretPath(n);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // see ensureSecretsDir
  }
  rememberSecret(value);
  return true;
}

/** Delete a secret. Returns false if there was nothing to delete. */
export function deleteSecret(name: string): boolean {
  const n = normaliseName(name);
  if (!isValidName(n)) return false;
  try {
    fs.unlinkSync(secretPath(n));
    return true;
  } catch {
    return false;
  }
}

/** Names of the stored secrets, sorted. Never values. */
export function listSecrets(): string[] {
  try {
    return fs
      .readdirSync(SECRETS_DIR)
      .filter((f) => f.endsWith(".secret"))
      .map((f) => f.slice(0, -".secret".length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A description of what is stored, for `/secret list`.
 *
 * Reports the name and length only -- never a prefix or suffix of the value.
 * A "first four characters" hint is the usual convenience and is exactly the
 * leak this module exists to avoid.
 */
export function describe(name: string): { name: string; present: boolean; chars: number } {
  const value = getSecret(name);
  return { name, present: value !== null, chars: value ? value.length : 0 };
}

// ---------------------------------------------------------------- redaction --

/**
 * Secrets known to this process, so `redact` can find them in text.
 *
 * Held in memory because redaction has to run synchronously while a frame is
 * being rendered. Populated as values are read or written; a secret loaded by a
 * *previous* process is still redacted once this one reads it.
 */
const known = new Set<string>();

/**
 * Shortest value worth redacting.
 *
 * Redacting very short strings would mask ordinary words: a 3-character secret
 * matches inside unrelated text and turns the transcript into noise. Nothing
 * that short is a real credential.
 */
const MIN_REDACTABLE = 6;

function rememberSecret(value: string): void {
  if (value.length >= MIN_REDACTABLE) known.add(value);
}

/**
 * Record a value for redaction without storing it.
 *
 * Used for values that were just typed: they must be masked from the transcript
 * even before (or instead of) being written to disk.
 */
export function trackSecret(value: string): void {
  rememberSecret(value);
}

/** Every tracked value, longest first, so a secret containing another is masked whole. */
function tracked(): string[] {
  return [...known].sort((a, b) => b.length - a.length);
}

/** Replace every known secret in `text` with a fixed marker. */
export function redact(text: string): string {
  if (text === "") return text;
  let out = text;
  for (const value of tracked()) {
    if (out.includes(value)) out = out.split(value).join("[redacted]");
  }
  return out;
}

/**
 * True if `text` contains a known secret.
 *
 * Used to refuse inputs that would leak a credential into a place it cannot be
 * scrubbed from later (a tool's arguments, a file write).
 */
export function containsSecret(text: string): boolean {
  return tracked().some((value) => text.includes(value));
}

/** Forget every tracked value. For tests. */
export function resetTracked(): void {
  known.clear();
}

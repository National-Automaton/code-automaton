/**
 * A pasted multi-line block must arrive as one paste, not as one message per
 * line.
 *
 * The session that prompted this pasted the raw source of an email -- full
 * headers, DKIM signatures, base64. It arrived in the transcript as ninety
 * separate `(mid-turn)` messages, each a fragment of the email:
 *
 *   "atch-scheduler (aws-cli) with instanceType m5.4xlarge, minCount=3D8, maxCou="
 *   "nt=3D8, tagged only Application=3Dbatch =E2=80=94 no Environment/CostCenter="
 *
 * "batch" split across two messages is the tell: the line had wrapped in the
 * terminal mid-paste, and every newline in the paste was taken as Enter.
 *
 * The cause is not the paste handler -- that strips newlines correctly -- but
 * that it never ran. Bracketed paste was never switched on, so the terminal
 * wrapped nothing in ESC[200~ ... ESC[201~ and the pasted newlines hit the
 * Enter path one after another.
 *
 * Turning it on is only half the fix. Even with the framing present, the reader
 * lost it whenever the paste spanned more than one `stdin` chunk, which a large
 * paste always does: a 50KB paste in 8KB chunks produced 0 paste events and
 * 50,000 single characters. And with no terminator it waited forever, so every
 * later keypress was swallowed into the paste buffer and the UI went dead.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { KeyReader } from "../src/keys.js";
import { Screen } from "../src/screen.js";

/** Feed `chunks` to a reader and collect what it emitted. */
function collect(chunks: string[]): string[] {
  const reader = new KeyReader() as unknown as { feed(s: string): void };
  const got: string[] = [];
  (reader as unknown as { onKey(f: (k: unknown) => void): void }).onKey((k) => {
    const key = k as { type: string; ch?: string; text?: string };
    if (key.type === "paste") got.push(`paste[${key.text!.length}]`);
    else if (key.type === "char") got.push(key.ch!);
    else got.push(key.type);
  });
  for (const c of chunks) reader.feed(c);
  return got;
}

/** Split `s` into chunks of at most `n` bytes, as stdin delivers them. */
function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// --- a complete bracketed paste arrives as one paste ----------------------

{
  const got = collect([PASTE_START + "a\nb\nc" + PASTE_END, "\x1b[A"]);
  assert.deepEqual(got, ["paste[5]", "up"], "one bracketed paste, then the arrow");
}

// --- a paste split across chunks is still one paste ----------------------
//
// This is the regression that matters for a real email: it is far larger than
// one read() from the terminal, so the framing is split at an arbitrary point
// -- inside the start sequence, inside the body, inside the end sequence.

{
  const body = "x".repeat(50_000);
  const framed = PASTE_START + body + PASTE_END;
  const got = collect([...chunk(framed, 8192), "\x1b[A"]);
  const pastes = got.filter((g) => g.startsWith("paste"));
  const chars = got.filter((g) => g.length === 1);
  assert.deepEqual(pastes, ["paste[50000]"], `expected one 50k paste, got ${pastes.length}`);
  assert.equal(chars.length, 0, `paste leaked ${chars.length} characters as keystrokes`);
  assert.equal(got[got.length - 1], "up", "the key after the paste must still be read");
}

// --- the start and end sequences themselves may be split ------------------

{
  // "\x1b[20" | "0~hello\x1b[20" | "1~"
  const got = collect(["\x1b[20", "0~hello\x1b[20", "1~", "\x1b[A"]);
  assert.deepEqual(got, ["paste[5]", "up"], "framing split mid-sequence");
}

// --- a paste containing the Enter key still yields no Enter --------------
//
// The whole point: newlines inside a paste must not submit anything.
{
  const email = "Subject: test\r\nFrom: a@b.c\r\n\r\nbody\r\n";
  const got = collect([PASTE_START + email + PASTE_END]);
  assert.deepEqual(got, [`paste[${email.length}]`], "pasted newlines must not emit enter");
  assert.ok(!got.includes("enter"), "a pasted newline must not submit the line");
}

// --- no terminator must not wedge the reader -----------------------------
//
// If the tail of a paste is lost (a dropped write, a terminal quirk), waiting
// for the end marker forever swallows every later keypress: the caret stops
// moving and the arrows do nothing, with no way back except Ctrl+C. The reader
// must recover -- flush what it has as a paste and carry on reading -- once the
// buffer grows past a sane paste size.
{
  // Above the reader's MAX_PASTE_CHARS: the point is that a *lost* terminator
  // is eventually given up on, not that an ordinary large paste is cut short.
  const huge = PASTE_START + "y".repeat(9_000_000);
  const got = collect([huge, "\x1b[A", "z"]);
  assert.ok(
    got.some((g) => g.startsWith("paste")),
    "an oversized, unterminated paste must be flushed as a paste, not held forever"
  );
  assert.ok(got.includes("up"), "keys after an unterminated paste must be read again");
  assert.ok(got.includes("z"), "typing after an unterminated paste must work again");
}

// --- bracketed paste is switched on, and off again -----------------------

{
  const stdout = process.stdout as unknown as { write: unknown };
  const realWrite = stdout.write;
  const writes: string[] = [];
  stdout.write = (chunk: string) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    for (const mouse of [true, false]) {
      writes.length = 0;
      const screen = new Screen(mouse, "1.9.0");
      (screen as unknown as { start(): void }).start();
      (screen as unknown as { stop(): void }).stop();
      const all = writes.join("");
      assert.ok(all.includes("\x1b[?2004h"), "start() must enable bracketed paste");
      assert.ok(all.includes("\x1b[?2004l"), "stop() must disable bracketed paste");
    }
  } finally {
    stdout.write = realWrite;
  }
}

console.log("paste: pasted blocks stay whole");

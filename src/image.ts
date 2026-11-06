/**
 * Image attachment support.
 *
 * The chat-completions API only accepts image parts in `user` messages, so
 * images are attached to a message rather than returned from a tool. That is a
 * schema constraint, not a design choice: a `tool` message's content is
 * `string | TextPart[]`, which cannot carry pixels.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** Media types the API accepts for image parts. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Refuse anything larger, before base64 inflates it by ~4/3. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface AttachedImage {
  /** Path as the user gave it, used in the transcript and for reloading. */
  path: string;
  /** Absolute path, for reading the bytes. */
  absPath: string;
  mime: string;
  bytes: number;
}

export class ImageError extends Error {}

/** Errors unless the extension is a supported image type. */
function mimeFor(p: string): string {
  const mime = MIME_BY_EXT[path.extname(p).toLowerCase()];
  if (!mime) {
    const supported = Object.keys(MIME_BY_EXT).join(", ");
    throw new ImageError(`unsupported image type "${path.extname(p) || "(none)"}" (supported: ${supported})`);
  }
  return mime;
}

/**
 * Where cached copies of attached images live.
 *
 * Clipboard captures are written to the OS temp directory, which is cleaned up
 * routinely -- that is why two of the sessions on this machine carry
 * `[image: ...]` placeholders whose files are long gone, so the screenshot
 * cannot be shown again even though the conversation records that one was sent.
 * Keeping a copy under `~/.coda` makes an attachment survivable, which is what
 * lets `view_image` re-read it later.
 *
 * `CODA_IMAGES_DIR` overrides it, the same way `CODA_SESSIONS_DIR` does.
 */
export const IMAGES_DIR = process.env.CODA_IMAGES_DIR
  ? path.resolve(process.env.CODA_IMAGES_DIR)
  : path.join(os.homedir(), ".coda", "images");

/** Content-addressed name for an image, so a repeated capture is stored once. */
function cacheName(bytes: Buffer, ext: string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32) + ext;
}

/**
 * Copy an image into `IMAGES_DIR` and return the cached path.
 *
 * Content-addressed, so attaching the same screenshot twice costs one file.
 * Best-effort: if the copy fails the original path is returned and everything
 * still works, minus the ability to re-read the image after the original goes
 * away.
 */
export async function cacheImage(absPath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(absPath);
    const ext = path.extname(absPath).toLowerCase() || ".png";
    const dest = path.join(IMAGES_DIR, cacheName(bytes, ext));
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    // `wx` would fail on a second attach of the same bytes; the content is the
    // name, so an existing file is already the right one.
    await fs.writeFile(dest, bytes, { flag: "wx" }).catch((err) => {
      if (err?.code !== "EEXIST") throw err;
    });
    return dest;
  } catch {
    return absPath;
  }
}

/**
 * Cached images younger than this are never pruned.
 *
 * A screenshot is written to the cache when it is attached, but the session
 * that references it is not saved until the turn ends -- and if coda is killed
 * in between, the file is on disk with no session mentioning it yet. The guard
 * keeps a prune that runs in those seconds from deleting an image that is about
 * to be referenced.
 */
const PRUNE_MIN_AGE_MS = 60 * 60 * 1000;

/** Both marker spellings that name an image: stored and detached. */
const IMAGE_MARKER = /^\[image(?: sent)?: (.+)\]$/;

/**
 * Every image path mentioned anywhere in a session's messages.
 *
 * Cheap by construction: it walks content arrays looking at text parts, without
 * re-reading or re-parsing any session file. Callers pass records they already
 * have -- `App.start()` gets them from `loadAll()` -- so the scan costs a couple
 * of milliseconds across the whole corpus rather than a second pass over it.
 */
export function imagePathsIn(
  messages: Array<{ content?: unknown }>
): string[] {
  const found: string[] = [];
  for (const message of messages) {
    const content = (message as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = typeof (part as any)?.text === "string" ? (part as any).text : null;
      if (!text) continue;
      const m = IMAGE_MARKER.exec(text.trim());
      if (m) found.push(m[1]);
    }
  }
  return found;
}

/**
 * Delete cached images no session refers to any more.
 *
 * The cache is content-addressed, so one file can be referenced by several
 * sessions: deleting the file when a session is deleted would pull the image
 * out from under every other session that attached the same screenshot. That is
 * why this works from references rather than from deletions, and why it is a
 * sweep rather than a hook on the delete button.
 *
 * `referenced` should be every path mentioned by every session on disk. Files
 * not in that set and older than `PRUNE_MIN_AGE_MS` are removed. Returns the
 * paths that were deleted, for logging and for tests.
 */
export async function pruneImageCache(referenced: Set<string>): Promise<string[]> {
  let names: string[];
  try {
    // Skip the whole thing when nothing has been cached -- the common case.
    names = await fs.readdir(IMAGES_DIR);
  } catch {
    return []; // no cache directory yet
  }

  const now = Date.now();
  const removed: string[] = [];
  for (const name of names) {
    const full = path.join(IMAGES_DIR, name);
    if (referenced.has(full)) continue;
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < PRUNE_MIN_AGE_MS) continue;
      await fs.unlink(full);
      removed.push(full);
    } catch {
      // Vanished between readdir and stat, or unreadable: leave it.
    }
  }
  return removed;
}

/** Check a path can be attached, without reading the whole file. */
export async function attachImage(p: string): Promise<AttachedImage> {
  const absPath = path.resolve(p);
  const mime = mimeFor(p);

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new ImageError(`no such file: ${p}`);
  }
  if (!stat.isFile()) throw new ImageError(`not a file: ${p}`);
  if (stat.size === 0) throw new ImageError(`empty file: ${p}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw new ImageError(`image too large: ${mb(stat.size)} MB (limit ${mb(MAX_IMAGE_BYTES)} MB)`);
  }

  // Keep a durable copy. The path recorded on the message points at it rather
  // than at the caller's file, which for a clipboard capture is a temp file the
  // OS will delete -- taking the screenshot with it and leaving the session
  // unable to show what was sent.
  const cached = await cacheImage(absPath);
  return { path: cached, absPath: cached, mime, bytes: stat.size };
}

/** Read an attached image as a `data:` URL. */
export async function toDataUrl(img: AttachedImage): Promise<string> {
  const buf = await fs.readFile(img.absPath);
  return `data:${img.mime};base64,${buf.toString("base64")}`;
}

/**
 * Image parts for a chat message.
 *
 * `image_url` is the only part type that carries pixels, so this is what a
 * vision-capable model needs in order to actually see the attachment.
 */
export async function imageParts(
  images: AttachedImage[]
): Promise<Array<{ type: "image_url"; image_url: { url: string } }>> {
  const parts = [];
  for (const img of images) {
    parts.push({ type: "image_url" as const, image_url: { url: await toDataUrl(img) } });
  }
  return parts;
}

/**
 * Replace answered images with a marker so the session can go back to the text
 * model.
 *
 * The pixels are only needed until the turn that carried them is answered. Left
 * in the history they keep `Agent.needsVision()` true, which routes every later
 * request to the vision model for the rest of the session's life. The path is
 * kept in the marker so `view_image` can pull the image back when it is wanted.
 */
export function detachAnsweredImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const detached = content.map((part: any) => {
    if (part && part.type === "image_url") {
      changed = true;
      const label = typeof part.image_path === "string" ? part.image_path : "(image)";
      return { type: "text", text: `[image sent: ${label}]` };
    }
    return part;
  });
  // Same array back when nothing changed, so callers can compare by identity.
  return changed ? detached : content;
}

/** True if a message's content contains an image part. */
export function hasImagePart(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (part: any) => part && typeof part === "object" && part.type === "image_url"
  );
}

/**
 * Replace image parts with a text placeholder, for session persistence.
 *
 * Base64 images would otherwise be written into every session file forever
 * (a 1 MB screenshot is ~1.4 MB of JSON). The path is kept so the attachment
 * can be found again -- by `view_image`, when the model wants to look at it.
 *
 * These placeholders are *not* turned back into pixels on load; see
 * `keepImagePlaceholders`.
 */
export function stripImagesForStorage(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (part && part.type === "image_url") {
      const url: string = part.image_url?.url ?? "";
      const label = typeof part.image_path === "string" ? part.image_path : "(image)";
      return { type: "text", text: `[image: ${label}]` };
    }
    return part;
  });
}

/** What the Windows clipboard currently holds. */
export interface ClipboardContents {
  image: boolean;
  text: boolean;
}

/**
 * Report which kinds of data the Windows clipboard holds.
 *
 * A clipboard can hold both at once -- copying a chart from Excel or an image
 * with a URL puts an image and text on it together -- so callers need the
 * distinction rather than just "is there an image".
 */
export async function clipboardContents(): Promise<ClipboardContents | null> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "Write-Output ('img=' + [System.Windows.Forms.Clipboard]::ContainsImage()); " +
    "Write-Output ('txt=' + [System.Windows.Forms.Clipboard]::ContainsText())";
  const out = await runPowerShell(script);
  if (out === null) return null;
  return { image: /img=True/i.test(out), text: /txt=True/i.test(out) };
}

/**
 * Save the Windows clipboard image to a temp file and return its path, or null
 * when the clipboard holds no image.
 *
 * Only meaningful under WSL. Windows Terminal cannot put image data into a
 * terminal's paste stream, so the clipboard has to be read from the Windows
 * side via PowerShell -- which is also why this shells out rather than reading
 * any terminal escape sequence.
 */
export async function clipboardImagePath(): Promise<string | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img) { $p = Join-Path $env:TEMP ('coda-clip-' + [guid]::NewGuid() + '.png');",
    "$img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output $p }",
  ].join("; ");

  const winPath = await runPowerShell(script);
  if (!winPath) return null;
  // Translate C:\... to /mnt/c/... so the rest of coda can read it.
  return toWslPath(winPath.trim());
}

/** Run a PowerShell snippet, returning stdout (or null if it failed). */
async function runPowerShell(script: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
    let out = "";
    ps.stdout.on("data", (d) => (out += String(d)));
    ps.on("error", () => resolve(null));
    ps.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** Translate a Windows path to its WSL equivalent. */
async function toWslPath(winPath: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const p = spawn("wslpath", ["-u", winPath], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

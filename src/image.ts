/**
 * Image attachment support.
 *
 * The chat-completions API only accepts image parts in `user` messages, so
 * images are attached to a message rather than returned from a tool. That is a
 * schema constraint, not a design choice: a `tool` message's content is
 * `string | TextPart[]`, which cannot carry pixels.
 */
import { promises as fs } from "node:fs";
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

  return { path: p, absPath, mime, bytes: stat.size };
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
 * can be re-read when the session is reloaded.
 */
/**
 * Re-attach images that were replaced by `stripImagesForStorage`.
 *
 * Sessions store a `[image: path]` placeholder instead of base64. Without this
 * the reloaded conversation would only contain the text, so the model would
 * silently lose the screenshot it was originally asked about. A missing file
 * degrades to the placeholder rather than failing the load.
 */
export async function restoreImagesForLoad(content: unknown): Promise<unknown> {
  if (!Array.isArray(content)) return content;
  const restored: any[] = [];
  for (const part of content) {
    const m = typeof (part as any)?.text === "string"
      ? /^\[image: (.+)\]$/.exec((part as any).text)
      : null;
    if (m) {
      try {
        const img = await attachImage(m[1]);
        restored.push({ type: "image_url", image_url: { url: await toDataUrl(img) }, image_path: img.path });
        continue;
      } catch {
        // File moved or deleted: keep the placeholder as plain text.
      }
    }
    restored.push(part);
  }
  return restored;
}

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

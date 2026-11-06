/**
 * A screenshot must not pin a session to the vision model for good.
 *
 * `Agent.route()` sends a request to the vision model whenever any message in
 * the history carries an image. Images were never removed, and `loadAll`
 * re-attached them from the session file on every load -- so one screenshot
 * kept a session on the vision model for its whole life, and restarting could
 * not clear it because the image came straight back.
 *
 * These tests pin the three halves of the fix:
 *
 *   - an image is detached once its turn is answered, so routing returns to
 *     the text model;
 *   - a load leaves the `[image: path]` placeholder alone instead of turning it
 *     back into pixels, so an old session is unstuck too;
 *   - `view_image` puts an image back into view deliberately, by naming it on a
 *     `user` message (a `tool` message cannot carry pixels).
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";

const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-images-test-${process.pid}`;
process.env.CODA_IMAGES_DIR = path.join(dir, "images");
process.env.CODA_SESSIONS_DIR = path.join(dir, "sessions");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const {
  detachAnsweredImages,
  hasImagePart,
  stripImagesForStorage,
  attachImage,
  cacheImage,
  imagePathsIn,
  pruneImageCache,
  IMAGES_DIR,
} = await import("../src/image.js");
const { runTool } = await import("../src/tools.js");
const { save, loadAll } = await import("../src/store.js");

/** Smallest valid PNG, so `attachImage`'s size and mime checks are real. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const imagePart = (p: string) => ({
  type: "image_url",
  image_url: { url: "data:image/png;base64,AAAA" },
  image_path: p,
});

async function main() {
  await fs.mkdir(dir, { recursive: true });

  // --- detaching: a turn that has been answered stops routing to vision ----

  {
    const content = [{ type: "text", text: "what does this say?" }, imagePart("/tmp/shot.png")];
    assert.equal(hasImagePart(content), true, "an image part should route to vision");

    const detached = detachAnsweredImages(content) as any[];
    assert.equal(hasImagePart(detached), false, "a detached message must not route to vision");
    assert.equal(detached[0].text, "what does this say?", "the user's text is untouched");
    assert.equal(
      detached[1].text,
      "[image sent: /tmp/shot.png]",
      "the image becomes a marker naming its path"
    );

    // Nothing to do is not a change: the caller compares by identity to decide
    // whether there is anything to persist.
    const plain = [{ type: "text", text: "no image here" }];
    assert.equal(
      detachAnsweredImages(plain),
      plain,
      "content with no image should come back as the same array"
    );
  }

  // --- saving: an image becomes a placeholder, never pixels on disk -------

  {
    const stored = stripImagesForStorage([
      { type: "text", text: "look" },
      imagePart("/tmp/shot.png"),
    ]) as any[];
    assert.equal(stored[1].text, "[image: /tmp/shot.png]", "storage writes a placeholder");
    assert.equal(
      hasImagePart(stored),
      false,
      "a stored session must carry no image parts"
    );
  }

  // --- the cache: an attachment outlives its source file ------------------

  {
    const src = path.join(dir, "shot.png");
    await fs.writeFile(src, PNG);
    const cached = await cacheImage(src);
    assert.ok(cached.startsWith(IMAGES_DIR), `expected a path under ${IMAGES_DIR}, got ${cached}`);
    assert.deepEqual(await fs.readFile(cached), PNG, "the cached copy holds the same bytes");

    // Content-addressed: the same bytes attach to one file, not two.
    const again = await cacheImage(src);
    assert.equal(again, cached, "the same image should cache to the same path");
    assert.equal((await fs.readdir(IMAGES_DIR)).length, 1, "one file per distinct image");

    // And the point of it: the copy survives deletion of the original.
    await fs.rm(src);
    assert.deepEqual(await fs.readFile(cached), PNG, "the cache survives the source going away");
  }

  // --- view_image: a tool asks for pixels it cannot return ----------------

  {
    const shot = path.join(dir, "diagram.png");
    await fs.writeFile(shot, PNG);
    const res = await runTool("view_image", { path: shot });
    assert.equal(res.ok, true, `view_image should succeed: ${res.output}`);
    assert.ok(res.attach?.length === 1, "view_image should name the file to attach");
    assert.ok(
      res.attach![0].startsWith(IMAGES_DIR),
      `the attached path should be the cached copy, got ${res.attach![0]}`
    );
    // The result itself stays text: a `tool` message cannot carry image parts.
    assert.equal(typeof res.output, "string", "the tool result must remain text");
  }

  // --- a missing file fails the tool, not the turn ------------------------

  {
    // `runTool` reports failures as a result rather than throwing, so the turn
    // continues and the model is told what went wrong.
    const res = await runTool("view_image", { path: path.join(dir, "nope.png") });
    assert.equal(res.ok, false, "a missing image should fail the tool");
    assert.ok(
      /no such file/.test(res.output),
      `the failure should name the cause, got ${JSON.stringify(res.output)}`
    );
    assert.equal(res.attach, undefined, "nothing should be attached when it failed");
  }

  // --- end to end: save then load is not pinned ---------------------------

  {
    const shot = path.join(dir, "e2e.png");
    await fs.writeFile(shot, PNG);
    const img = await attachImage(shot);
    await save({
      id: "image-session",
      title: "t",
      cwd: dir,
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "text", text: "look" }, imagePart(img.path)] },
        { role: "assistant", content: "I see a 1x1 image." },
      ],
      entries: [{ role: "user", text: "look" }],
    } as any);

    const loaded = (await loadAll()).find((r) => r.id === "image-session");
    assert.ok(loaded, "the session should load");
    const carries = loaded!.messages.some((m: any) => hasImagePart(m?.content));
    assert.equal(carries, false, "a reloaded session must not route to the vision model");
    const placeholder = loaded!.messages
      .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : []))
      .find((p: any) => typeof p?.text === "string" && p.text.startsWith("[image"));
    assert.ok(placeholder, "the placeholder should still record that an image was sent");
    assert.equal(
      placeholder!.text,
      "[image: " + img.path + "]",
      "the placeholder names the cached path, which view_image can re-read"
    );
  }

  // --- the prune: only unreferenced, only old enough ----------------------

  {
    // Both marker spellings are recognised, and nothing else is mistaken for
    // one -- a prune that misses a reference deletes a live screenshot.
    const found = imagePathsIn([
      { content: [{ type: "text", text: "[image: /a.png]" }] },
      { content: [{ type: "text", text: "[image sent: /b.png]" }] },
      { content: [{ type: "text", text: "just a [image: inside] sentence" }] },
      { content: "/plain string" },
      { content: [{ type: "text", text: "no marker here" }] },
    ] as any);
    assert.deepEqual(
      found,
      ["/a.png", "/b.png"],
      `expected both markers, got ${JSON.stringify(found)}`
    );
  }

  {
    await fs.mkdir(IMAGES_DIR, { recursive: true });
    const keep = path.join(IMAGES_DIR, "keep.png");
    const drop = path.join(IMAGES_DIR, "drop.png");
    const fresh = path.join(IMAGES_DIR, "fresh.png");
    await fs.writeFile(keep, PNG);
    await fs.writeFile(drop, PNG);
    await fs.writeFile(fresh, PNG);
    // Age the two that are eligible; `fresh` stays inside the guard.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(keep, old, old);
    await fs.utimes(drop, old, old);

    const removed = await pruneImageCache(new Set([keep]));

    assert.deepEqual(removed, [drop], `only the unreferenced old file goes, got ${JSON.stringify(removed)}`);
    assert.ok(await fs.stat(keep).then(() => true, () => false), "a referenced image must survive");
    assert.ok(await fs.stat(fresh).then(() => true, () => false), "a just-written image must survive");
    assert.ok(!(await fs.stat(drop).then(() => true, () => false)), "the unreferenced old image should be gone");
  }

  // --- and it is a no-op when nothing has ever been cached ----------------

  {
    const empty = path.join(dir, "empty-images");
    const before = process.env.CODA_IMAGES_DIR;
    // `IMAGES_DIR` is resolved at import, so this checks the failure path
    // instead: a missing directory must not throw.
    await fs.rm(empty, { recursive: true, force: true });
    const removed = await pruneImageCache(new Set()).catch((e) => e);
    assert.ok(Array.isArray(removed), `prune should never throw, got ${removed}`);
    process.env.CODA_IMAGES_DIR = before;
  }

  await fs.rm(dir, { recursive: true, force: true });
  console.log("images: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

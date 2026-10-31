// `openai` pulls in node-fetch@2 -> whatwg-url@5 -> tr46, which does a bare
// `require('punycode')`. That resolves to Node's built-in module, which emits
// a DEP0040 deprecation warning every time coda starts.
//
// None of the clean-looking fixes work, because makeRequire() (the `require`
// handed to every CJS module) has a null prototype and consults only the
// loader's internal cache, checking built-in modules *before* it:
//   - an ESM resolve hook never sees the require (it is not on the hook chain);
//   - seeding `require.cache` / `Module._cache` is ignored for built-ins;
//   - `punycode/` cannot be mapped from a single entry point, and registering a
//     bundle-wide ESM loader hook would spawn a worker thread.
//
// So we patch `Module.prototype.require` itself for the one specifier we care
// about, resolving it to the (undeprecated) userland `punycode` package that
// we ship as a direct dependency. Its API is a superset of the built-in's, so
// callers are unaffected.
//
// This must run before the OpenAI SDK is evaluated. Note that an ESM entry
// point's own top-level code runs *after* its static imports, so calling this
// from index.ts would be too late; config.ts calls it instead, and config.ts is
// a leaf module that only imports `node:` builtins.

import Module from "node:module";
import { createRequire } from "node:module";

type PatchedModule = typeof Module & {
  prototype: {
    require: (id: string) => unknown;
    __codaPunycodePatched?: boolean;
  };
};

export function applyPunycodeShim(): void {
  const proto = (Module as unknown as PatchedModule).prototype;
  if (proto.__codaPunycodePatched) return;

  let userland: unknown;
  try {
    const req = createRequire(import.meta.url);
    // "punycode/" asks for the package rather than the deprecated built-in.
    userland = req(req.resolve("punycode/"));
  } catch {
    // If the dependency is unavailable, fall back to the built-in (and its
    // deprecation warning) rather than failing to start.
    return;
  }

  const original = proto.require;
  proto.require = function patchedRequire(this: unknown, id: string) {
    if (id === "punycode") return userland;
    return original.call(this, id);
  };
  proto.__codaPunycodePatched = true;
}

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { Config } from "./config.js";
import { parallelBatch, runTool, secretNamesIn, toolDefinitions } from "./tools.js";
import type { ToolResult } from "./tools.js";
import { hasSecret, isValidName, normaliseName, redact, setSecret, trackSecret } from "./secrets.js";
import { systemPrompt } from "./instructions.js";
import {
  AttachedImage,
  attachImage,
  detachAnsweredImages,
  hasImagePart,
  imageParts,
} from "./image.js";

/**
 * How many times one turn may be resumed after the connection drops mid-reply.
 *
 * Each resume keeps the text already received and asks the model to continue,
 * so a single drop costs nothing visible. A connection that dies every time
 * would otherwise spin forever, so the turn fails explicitly instead.
 */
const MAX_INTERRUPTIONS = 3;

export const SYSTEM_PROMPT = `You are a coding assistant running in a terminal.
You can read, write, and edit files, list directories, and run shell commands.
Prefer small, focused edits. Explain briefly what you are doing before using tools.
When you are done, give a short summary of what changed.`;

/**
 * How much history may be sent in one request, in characters.
 *
 * The whole history is re-sent on every step of the agent loop, so a session
 * that runs long enough eventually exceeds the model's context window -- and
 * once it does, every later request fails the same way ("maximum context
 * length is N tokens, however you requested M"), which strands the session
 * permanently. `~4 chars per token` makes 3.2M characters roughly 800k tokens:
 * comfortably inside a 1M-token window while leaving room for the reply and the
 * tool definitions. Override with CODA_MAX_CONTEXT_CHARS for a smaller model.
 */
export const MAX_CONTEXT_CHARS = (() => {
  const raw = Number(process.env.CODA_MAX_CONTEXT_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3_200_000;
})();

/** Rough token estimate for a message, counting tool calls and image parts. */
function messageChars(m: ChatCompletionMessageParam): number {
  const any = m as any;
  let n = typeof any.content === "string" ? any.content.length : 0;
  if (Array.isArray(any.content)) n += JSON.stringify(any.content).length;
  if (any.tool_calls) n += JSON.stringify(any.tool_calls).length;
  return n;
}

/**
 * Whether a tool call's `arguments` string is complete, parseable JSON.
 *
 * An absent or empty string is valid: a call that takes no arguments may
 * legitimately send either. Anything that fails to parse is treated as
 * truncated, which is what a provider cutting a reply off at the output-token
 * cap produces.
 */
export function isValidJson(args: unknown): boolean {
  if (args === undefined || args === null || args === "") return true;
  if (typeof args !== "string") return false;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the oldest messages until the history fits `maxChars`.
 *
 * The system prompt and the newest message are always kept: the system prompt
 * holds the instructions, and the newest message is the one being answered. The
 * cut is made at a turn boundary rather than mid-exchange, so the history never
 * begins with a `tool` message whose `assistant` tool_calls were dropped --
 * providers reject that outright.
 *
 * Dropping history loses context, so this is a floor, not a strategy: tool
 * output is capped at the source (see `MAX_TOOL_OUTPUT_CHARS`) and this only
 * has to catch the slow accumulation of many ordinary turns.
 */
export function trimHistory(
  messages: ChatCompletionMessageParam[],
  maxChars = MAX_CONTEXT_CHARS
): ChatCompletionMessageParam[] {
  let total = messages.reduce((n, m) => n + messageChars(m), 0);
  if (total <= maxChars || messages.length <= 2) return messages;

  const keep = [...messages];
  // Index 0 is the system prompt; never drop it. Drop from index 1 upward.
  while (total > maxChars && keep.length > 2) {
    const dropped = keep.splice(1, 1)[0];
    total -= messageChars(dropped);
    // A leading `tool` message belongs to an assistant turn that is now gone;
    // drop it too rather than send an orphan the provider will reject.
    while (keep.length > 2 && keep[1].role === "tool") {
      total -= messageChars(keep.splice(1, 1)[0]);
    }
  }
  return keep;
}

/**
 * Fraction of the ceiling at which compaction replaces old turns with a
 * summary. Below this, history is left alone: re-sending it is cheap when the
 * provider caches the prefix, and the recent turns are usually the ones that
 * matter.
 *
 * Measured against real sessions, history grows ~2.8k tokens/turn, so the
 * default ceiling is only reached after ~285 turns. That is why compaction is
 * off by default: for a cheap model it saves cents, and every compaction
 * discards context and invalidates the provider's cache prefix.
 */
export const DEFAULT_COMPACT_AT = 0.75;

/** Fraction of the kept history that stays verbatim after a compaction. */
const COMPACT_KEEP_FRACTION = 0.2;

/**
 * Split `messages` at a turn boundary near `splitAt`.
 *
 * Returns the messages that would be summarized and the ones kept verbatim.
 * The system prompt (index 0) always stays. The split never lands between an
 * `assistant` turn carrying tool_calls and its `tool` results, because most
 * providers reject an orphaned `tool` message outright.
 */
export function splitForCompaction(
  messages: ChatCompletionMessageParam[],
  splitAt: number
): { older: ChatCompletionMessageParam[]; keep: ChatCompletionMessageParam[] } {
  if (messages.length <= 2) return { older: [], keep: messages };

  let cut = Math.max(1, Math.min(splitAt, messages.length - 1));
  // Walk backwards to a `user` message: a turn starts there, so the kept tail
  // begins with a real request rather than a bare tool result.
  let guard = 0;
  while (cut > 1 && messages[cut].role !== "user" && guard++ < messages.length) cut--;
  if (cut <= 1) return { older: [], keep: messages };

  return { older: messages.slice(1, cut), keep: messages.slice(cut) };
}

/**
 * Replace the oldest part of the history with a summary message.
 *
 * The result is `[system, summary, ...recent]`. The summary is an ordinary
 * user-role message rather than a fake tool result or a second system message:
 * several OpenAI-compatible backends reject those shapes mid-array.
 *
 * `summarize` is injected so this can be tested without a model call.
 */
export async function compactHistory(
  messages: ChatCompletionMessageParam[],
  summarize: (older: ChatCompletionMessageParam[]) => Promise<string>,
  maxChars = MAX_CONTEXT_CHARS,
  compactAt = DEFAULT_COMPACT_AT
): Promise<ChatCompletionMessageParam[]> {
  const total = messages.reduce((n, m) => n + messageChars(m), 0);
  if (total <= maxChars * compactAt) return messages;

  // Keep roughly the last KEEP_FRACTION of the budget verbatim.
  const keepChars = Math.floor(maxChars * COMPACT_KEEP_FRACTION);
  let acc = 0;
  let splitIndex = messages.length;
  for (let i = messages.length - 1; i > 0; i--) {
    acc += messageChars(messages[i]);
    if (acc > keepChars) {
      splitIndex = i;
      break;
    }
  }

  const { older, keep } = splitForCompaction(messages, splitIndex);
  if (older.length === 0) return messages;

  let summary: string;
  try {
    summary = (await summarize(older)).trim();
  } catch {
    // A failed summary must not break the turn: fall back to the plain trim,
    // which is the existing behaviour and still prevents overflow.
    return trimHistory(messages, maxChars);
  }
  if (!summary) return trimHistory(messages, maxChars);

  return [
    messages[0],
    {
      role: "user",
      content:
        `Summary of earlier work in this session (original messages were ` +
        `compacted to save context):\n\n${summary}`,
    },
    ...keep,
  ];
}

/**
 * Events emitted while the agent works. The UI layer decides how to render
 * them; the agent never writes to stdout directly.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: any }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "steer"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** One tool call as the model asked for it, with its arguments parsed. */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: any;
}

/**
 * Run one response's tool calls, emitting `tool_start`/`tool_result` in
 * **request order** and returning results in that same order.
 *
 * Read-only calls are started together (see `parallelBatch`); the rest run
 * serially. Results are awaited in request order, so a slow first call still
 * holds back the later ones even if they finished long ago -- the alternative
 * is a transcript whose rows arrive out of the order the model wrote them in.
 *
 * `run` is injected rather than imported so this can be tested without
 * performing real tool calls; `Agent` passes `runTool`.
 */
export async function runToolCalls(
  calls: ParsedToolCall[],
  emit: (ev: AgentEvent) => void,
  run: (name: string, args: any) => Promise<ToolResult>,
  parallel = true,
  onRunning: (running: number) => void = () => {}
): Promise<
  Array<{
    id: string;
    name: string;
    ok: boolean;
    output: string;
    attach?: string[];
    newSession?: { title?: string; preamble?: string };
  }>
> {
  const batch = parallel ? parallelBatch(calls) : [];

  // Announce every call before any of them runs, so the transcript shows the
  // whole request even while the first result is still pending.
  for (const call of calls) emit({ type: "tool_start", name: call.name, args: call.args });

  // Start the batch now; do not await yet. Batched calls are in flight
  // immediately; the rest start one at a time below, in request order.
  const started = new Map<number, Promise<ToolResult>>();
  for (const i of batch) started.set(i, run(calls[i].name, calls[i].args));

  // How many calls are in flight right now. Reported through `onRunning` so
  // the status bar can show a live count -- including for a session the user
  // has switched away from, whose events never reach the current view.
  let running = batch.length;
  onRunning(running);

  const results: Array<{
    id: string;
    name: string;
    ok: boolean;
    output: string;
    attach?: string[];
    newSession?: { title?: string; preamble?: string };
  }> = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    let pending = started.get(i);
    if (!pending) {
      // Not batched: start it now, in order. Everything before it has already
      // finished, so it is the only call in flight.
      pending = run(call.name, call.args);
      running++;
      onRunning(running);
    }
    const result = await pending;
    running--;
    onRunning(running);
    emit({ type: "tool_result", name: call.name, ok: result.ok, output: result.output });
    results.push({
      id: call.id,
      name: call.name,
      ok: result.ok,
      output: result.output,
      ...(result.attach?.length ? { attach: result.attach } : {}),
      // Carried out of `runToolCalls` so the caller can act on it. Creating the
      // session needs the app's terminal; nothing at this level has one.
      ...(result.newSession ? { newSession: result.newSession } : {}),
    });
  }
  return results;
}

export class Agent {
  private client: OpenAI;
  messages: ChatCompletionMessageParam[];
  /**
   * Tool calls currently running in the turn in flight (0 when idle).
   *
   * The status bar needs this for *any* session, including one whose turn
   * started before the user switched to it -- that session's events never reach
   * the current view, so a counter maintained only from the event stream would
   * read 0. `runToolCalls` reports progress through `onRunning`, and the turn
   * resets it to 0 in `finally` so a failed turn cannot leave it stuck.
   */
  runningTools = 0;
  /**
   * Bumped every time `runningTools` changes. Lets the status bar tell "no
   * tools running, but this is the run that just finished" from "no tools
   * running because a new run has not started yet".
   */
  toolSeq = 0;
  /**
   * The most calls that have been in flight at once since tools went idle.
   *
   * Rendering is frame-based, so a batch can start and finish entirely between
   * two frames and `runningTools` never gets observed non-zero. The status bar
   * lingers a count after the tools finish, and this is the number it should
   * show: how many were in flight at the busiest moment of the run.
   *
   * Reset when a run starts -- `runningTools` going from 0 to non-zero -- so it
   * describes the current run rather than the whole turn.
   */
  toolPeak = 0;

  private visionClient: OpenAI;

  constructor(
    private config: Config,
    messages?: ChatCompletionMessageParam[]
  ) {
    // Use the runtime's built-in fetch rather than the SDK's default.
    //
    // openai@4 keeps a node-fetch@2 fallback for old Node versions and uses it
    // whenever no `fetch` is supplied. On Node 20.19.2 that combination breaks
    // streaming: node-fetch's chunked-response handling ends one chunk early
    // and raises `ERR_STREAM_PREMATURE_CLOSE` ("Premature close") at the end of
    // every reply -- plain and tool-calling alike. The text has already
    // streamed by then, but the turn is recorded as failed, so the tool never
    // runs and the unanswered prompt is re-sent on the next turn.
    //
    // Node 18+ has a global fetch (undici), which streams these responses
    // correctly and is what openai@5 uses by default. Passing it explicitly
    // keeps every supported Node version on the same code path.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      fetch: globalThis.fetch,
    });
    this.visionClient = new OpenAI({
      apiKey: config.visionApiKey,
      baseURL: config.visionBaseURL,
      fetch: globalThis.fetch,
    });
    // A resumed session already carries its system prompt, so the user's
    // instructions are not re-applied: the history is what it was, and
    // rewriting the first message would silently change a past conversation.
    this.messages = messages ?? [
      { role: "system", content: systemPrompt(SYSTEM_PROMPT) },
    ];
  }

  /**
   * True if any message so far carries an image. Routing is per request rather
   * than per session so one conversation can mix text and screenshots.
   *
   * Note this stays true for the rest of the session: once an image is in the
   * history it is re-sent with every request, so the vision model must keep
   * handling the conversation or the model would lose that context.
   */
  /**
   * Text the user typed while a turn was running, waiting to be folded into
   * the next request. The whole history is re-sent on every loop iteration, so
   * anything appended here reaches the model at the next checkpoint -- between
   * tool calls -- rather than waiting for the turn to finish.
   */
  private pendingSteers: string[] = [];

  /** Queue a mid-turn message for the running turn. */
  steer(text: string): void {
    const t = text.trim();
    if (t) this.pendingSteers.push(t);
  }

  /** Append queued steers to the history, returning the texts folded in. */
  private flushSteers(): string[] {
    if (!this.pendingSteers.length) return [];
    const queued = this.pendingSteers;
    this.pendingSteers = [];
    for (const text of queued) this.messages.push({ role: "user", content: text });
    return queued;
  }

  /**
   * Attach images a tool asked to show, on the `user` message carrying them.
   *
   * A tool cannot return pixels -- the schema allows image parts only on `user`
   * messages -- so `view_image` names the files and they are attached here,
   * right after the tool results. This is the one place an image re-enters the
   * history after a turn has been answered, and it is deliberate: the model
   * asked to see it, so this request belongs on the vision model.
   */
  private async attachForView(paths: string[]): Promise<void> {
    const parts: any[] = [{ type: "text", text: "[image shown]" }];
    for (const p of paths) {
      try {
        const img = await attachImage(p);
        for (const part of await imageParts([img])) {
          parts.push({ ...part, image_path: img.path });
        }
      } catch (err: any) {
        parts.push({ type: "text", text: `[could not show ${p}: ${err?.message ?? err}]` });
      }
    }
    if (parts.length > 1) this.messages.push({ role: "user", content: parts });
  }

  /**
   * Swap every answered image in the history for a text marker.
   *
   * Called when a turn ends. Until then the image must stay: the whole history
   * is re-sent on each step of the loop, so a turn that makes several tool
   * calls needs the pixels on every one. Once the turn is answered nothing
   * reads them again, and keeping them would keep `needsVision()` true for the
   * rest of the session -- every later text-only turn routed to the vision
   * model. `view_image` can bring an image back when it is actually wanted.
   */
  private detachImages(): void {
    for (const message of this.messages) {
      const any = message as any;
      const detached = detachAnsweredImages(any.content);
      if (detached !== any.content) any.content = detached;
    }
  }

  /**
   * Secrets the user has approved for this session, keyed by secret name.
   *
   * Per session because `coda` runs many at once: approving a credential for an
   * agent working on one project must not silently approve it for another. The
   * stored value is the approval, not the credential -- the name is all that is
   * needed to decide whether to ask again.
   */
  private approvedSecrets = new Set<string>();

  /**
   * Whether this conversation has already opened a session.
   *
   * Set when the user approves, before the app acts on it: the turn that
   * requested it may still make further tool calls, and each one must see the
   * request as spent. Never cleared -- a session that has handed off has handed
   * off, and the agent that set this is no longer the one being talked to.
   */
  openedSession = false;

  /** Names this session may spend without asking again. For the UI. */
  get approved(): string[] {
    return [...this.approvedSecrets];
  }

  /**
   * Run one tool call, gating `use_secret` behind the user's approval.
   *
   * The gate lives here rather than in `runTool` because `runTool` is a plain
   * function with no way to reach the user. It is deliberately *before* the
   * command runs and before any substitution: the prompt names the secrets and
   * the argv as the model wrote them, so nothing sensitive is needed to decide.
   *
   * A refusal returns a readable tool result instead of throwing, so the model
   * can adapt (ask the user, choose another route) rather than failing the turn.
   */
  private async runOneTool(
    name: string,
    args: any,
    emit: (ev: AgentEvent) => void
  ): Promise<ToolResult> {
    // `request_secret` asks the user for a credential the task needs. It is
    // gated too, but for a different reason than `use_secret`: not "may this be
    // spent" but "do not let this silently overwrite something already stored".
    if (name === "request_secret") return this.requestSecrets(args);

    // `new_session` is gated, and the gate is the whole feature: an agent that
    // can spawn sessions unasked could strand the user in a terminal that no
    // longer shows the conversation they were reading. The confirmation reuses
    // the `use_secret` prompt deliberately -- one approval UI, one habit.
    if (name === "new_session") return this.openNewSession(args);

    if (name !== "use_secret") return runTool(name, args);

    const argv: string[] = Array.isArray(args?.command) ? args.command.map(String) : [];
    const names = [
      ...new Set([
        ...argv.flatMap((part) => secretNamesIn(part)),
        ...(typeof args?.stdin === "string" ? secretNamesIn(args.stdin) : []),
        ...(typeof args?.secret === "string" ? [args.secret] : []),
      ]),
    ];

    // Which of those still need approval, in the order they appear.
    const pending = names.filter((n) => !this.approvedSecrets.has(n));

    if (pending.length) {
      const summary =
        `Use credential${pending.length > 1 ? "s" : ""} ${pending.join(", ")} to run:\n` +
        `  ${argv.join(" ") || "(no command)"}`;

      if (!this.confirm) {
        return {
          ok: false,
          output:
            `use_secret: needs approval for ${pending.join(", ")}, but this session ` +
            `cannot ask the user. Refused.`,
        };
      }

      const answer = await this.confirm(summary, pending);
      if (answer === "no") {
        return {
          ok: false,
          output:
            `use_secret: the user declined to approve ${pending.join(", ")}. ` +
            `Do not try again in this turn; ask them what they would like instead.`,
        };
      }
      for (const n of pending) this.approvedSecrets.add(n);
    }

    const result = await runTool(name, args);
    return { ...result, output: redact(result.output) };
  }

  /**
   * Ask the user before spending a credential.
   *
   * Injected by the caller (see `Session.run`) because `Agent` has no terminal.
   * Resolving `"no"` is a refusal and is never treated as an error.
   */
  private confirm:
    | ((summary: string, secrets: string[]) => Promise<"yes" | "no" | "always">)
    | null = null;

  /** Install the approval prompt. */
  setConfirm(
    fn: ((summary: string, secrets: string[]) => Promise<"yes" | "no" | "always">) | null
  ): void {
    this.confirm = fn;
  }

  /** Forget every approval. For tests. */
  clearApprovals(): void {
    this.approvedSecrets.clear();
  }

  /**
   * Open a new session, after the user agrees to it.
   *
   * The `App` owns sessions and the agent does not, so this method only decides
   * and reports: it returns `newSession` in the result, and the app turns that
   * into a session once the turn is over (see `App.afterTurn`). Keeping the
   * creation out of here is what lets `Agent` stay testable with no terminal.
   *
   * The prompt reuses the `use_secret` confirmation callback rather than adding
   * a second approval mechanism. It shows the title and the *length* of the
   * handover, not the handover itself: the text is about to be placed in front
   * of the user anyway, and a wall of prose in a yes/no box buries the question.
   */
  private async openNewSession(args: any): Promise<ToolResult> {
    // One session per conversation. The user is moved to a fresh session the
    // moment this is honoured, so a second request can only ever arrive from an
    // agent that has not noticed it already moved -- and acting on it would
    // switch the user out of *that* session too, again and again. The tool is
    // for handing work off, once; anything else is a loop, not a request.
    if (this.openedSession) {
      return {
        ok: false,
        output:
          "new_session: a session has already been opened from this one. Do not " +
          "open another; the user is in the new session now. Continue there.",
      };
    }
    const title =
      typeof args?.title === "string" && args.title.trim()
        ? args.title.trim().slice(0, 200)
        : undefined;
    const preamble =
      typeof args?.preamble === "string" && args.preamble.trim()
        ? args.preamble
        : undefined;

    if (!this.confirm) {
      return {
        ok: false,
        output:
          "new_session: this session cannot ask the user, so no session was " +
          "opened. Ask them to press Ctrl+T.",
      };
    }

    const summary = [
      title ? `Open a new session named "${title}"?` : "Open a new session?",
      preamble
        ? `  The new session's input will hold a ${preamble.length}-character ` +
          "handover, unsent, for you to review.\n" +
          "  You will move to the new session; this transcript stays in the list."
        : "  An empty session will be opened; this transcript stays in the list.",
    ].join("\n");

    const answer = await this.confirm(summary, []);
    if (answer === "no") {
      return {
        ok: false,
        output:
          "new_session: the user declined. Do not ask again in this turn; " +
          "continue in this session, or ask what they would like instead.",
      };
    }

    // Spend the request before reporting it: anything else this turn does must
    // not open a second session.
    this.openedSession = true;

    return {
      ok: true,
      output:
        `new_session: opening a session${title ? ` named "${title}"` : ""}` +
        (preamble ? " with the handover in its input." : "."),
      newSession: { title, preamble },
    };
  }


  /**
   * Collect credentials the task needs but the vault does not have.
   *
   * The values are typed by the user at a hidden prompt and go straight to
   * `setSecret`; they are never returned to the model, never put in a tool
   * result, and never in the transcript. What comes back is only which names
   * were saved, which is what the model needs to retry its `use_secret` call.
   *
   * Refuses to overwrite an existing secret: a model that asks again (or a
   * re-run of the same task) must not silently replace a working credential.
   * The user can still change one deliberately with /secret add --force.
   */
  private async requestSecrets(args: any): Promise<ToolResult> {
    const items: Array<{ name: string; label: string; hidden: boolean }> = Array.isArray(
      args?.secrets
    )
      ? args.secrets
          .filter((x: any) => x && typeof x.name === "string")
          .map((x: any) => ({
            name: String(x.name),
            label: String(x.label ?? x.name),
            hidden: x.hidden !== false,
          }))
      : [];

    if (!items.length) {
      return { ok: false, output: "request_secret: `secrets` must be a non-empty array" };
    }
    const invalid = items.filter((i) => !isValidName(normaliseName(i.name)));
    if (invalid.length) {
      return {
        ok: false,
        output:
          `request_secret: invalid name(s): ${invalid.map((i) => i.name).join(", ")}. ` +
          `Use lowercase letters, digits, . _ -`,
      };
    }
    if (!this.askSecret) {
      return {
        ok: false,
        output:
          "request_secret: this session cannot prompt the user, so the credential " +
          "could not be collected. Ask them to run /secret add <name>.",
      };
    }

    const saved: string[] = [];
    const kept: string[] = [];
    const cancelled: string[] = [];

    for (const item of items) {
      const n = normaliseName(item.name);
      if (hasSecret(n)) {
        kept.push(n);
        continue;
      }
      const value = await this.askSecret(n, item.label, item.hidden);
      if (value === null) {
        cancelled.push(n);
        continue;
      }
      // Tracked before storage so the value is masked even if the write fails.
      trackSecret(value);
      if (setSecret(n, value)) saved.push(n);
    }

    const parts: string[] = [];
    if (saved.length) parts.push(`saved: ${saved.join(", ")}`);
    if (kept.length) parts.push(`already stored (left unchanged): ${kept.join(", ")}`);
    if (cancelled.length) parts.push(`cancelled by the user: ${cancelled.join(", ")}`);

    const ok = cancelled.length === 0;
    return {
      ok,
      output:
        `request_secret: ${parts.join("; ")}. ` +
        (ok
          ? "The value(s) went straight into the vault and were not shown to you. " +
            "Retry with identical placeholder names."
          : parts.join("") === ""
            ? ""
            : "Do not ask again for a cancelled credential; ask the user what they would like instead."),
    };
  }

  /**
   * Ask the user to type a credential, injected by the UI.
   *
   * Resolves to the value, or null if the user cancelled. The value is used
   * immediately and never stored on the agent, so it cannot leak through agent
   * state.
   */
  private askSecret:
    | ((name: string, label: string, hidden: boolean) => Promise<string | null>)
    | null = null;

  /** Install the secret-collection prompt. */
  setAskSecret(
    fn: ((name: string, label: string, hidden: boolean) => Promise<string | null>) | null
  ): void {
    this.askSecret = fn;
  }

  private needsVision(): boolean {
    return this.messages.some((m) => hasImagePart((m as any).content));
  }

  /**
   * Models chosen for this session from the `/model` picker, overriding config.
   *
   * Held per `Agent` -- that is, per `Session` -- because `coda` runs many
   * sessions at once. A global switch would silently reroute a session the user
   * is not looking at, possibly mid-turn. Null means "use the config value",
   * which is also what `/model`'s "reset to config" leaves behind.
   *
   * The text and image choices are independent. They are not paired: the image
   * route is chosen by `needsVision()`, not by which text model is selected, so
   * tying one to the other would claim a relationship the routing does not have.
   */
  private modelOverride: string | null = null;
  private visionOverride: string | null = null;

  /** True if any message in the history carries an image. */
  hasImages(): boolean {
    return this.needsVision();
  }

  /**
   * The model and endpoint the next request will use, and why.
   *
   * Exposed so `/model` can state the routing decision rather than repeat the
   * configured names: when the history holds an image the vision model is used
   * whatever the text selection says, and a display that hid that would be
   * lying about which model answers.
   */
  currentRoute(): {
    model: string;
    visionModel: string;
    usingVision: boolean;
    textModel: string;
    textOverride: string | null;
    visionOverride: string | null;
  } {
    const usingVision = this.needsVision();
    return {
      model: usingVision ? this.visionModelName() : this.textModelName(),
      visionModel: this.visionModelName(),
      usingVision,
      textModel: this.textModelName(),
      textOverride: this.modelOverride,
      visionOverride: this.visionOverride,
    };
  }

  private textModelName(): string {
    return this.modelOverride ?? this.config.model;
  }

  private visionModelName(): string {
    return this.visionOverride ?? this.config.visionModel;
  }

  /** Choose this session's models. Null restores the configured value. */
  setModels(text: string | null, vision: string | null): void {
    this.modelOverride = text;
    this.visionOverride = vision;
  }

  /** The client and model to use for the next request. */
  private route(): { client: OpenAI; model: string } {
    return this.needsVision()
      ? { client: this.visionClient, model: this.visionModelName() }
      : { client: this.client, model: this.textModelName() };
  }

  /**
   * Summarize the older part of a history that is about to be compacted.
   *
   * Deliberately non-streaming: the caller needs the whole string before it can
   * splice it in, and the reply is not user-visible work in progress. Uses the
   * plain (non-vision) route -- summarising text needs no image support, and
   * routing images through here would send them to the vision model for no
   * reason.
   */
  private async summarize(older: ChatCompletionMessageParam[]): Promise<string> {
    const transcript = older
      .map((m) => {
        const any = m as any;
        const body =
          typeof any.content === "string"
            ? any.content
            : any.content
              ? JSON.stringify(any.content)
              : "";
        const calls = any.tool_calls
          ? ` [called ${any.tool_calls.map((c: any) => c.function?.name).join(", ")}]`
          : "";
        return `${m.role}${calls}: ${body}`;
      })
      .join("\n\n");

    const res = await this.client.chat.completions.create({
      model: this.textModelName(),
      messages: [
        {
          role: "system",
          content:
            "Summarise a coding session transcript so work can continue without " +
            "it. Preserve: files read or changed and why, decisions made and their " +
            "reasons, commands run and their outcomes, and anything still " +
            "outstanding. Drop pleasantries and superseded detail. Be dense and " +
            "concrete; under 400 words.",
        },
        { role: "user", content: transcript },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }

  /**
   * Send user input and stream the model's response through `emit`.
   * Resolves once the model has finished (no more tool calls).
   */
  async send(
    userInput: string,
    emit: (ev: AgentEvent) => void,
    images: AttachedImage[] = []
  ): Promise<{ newSession?: { title?: string; preamble?: string } }> {
    if (images.length) {
      // Image parts are only accepted in `user` messages; tool results cannot
      // carry them. Annotate each part with its path so the session store can
      // swap the pixels for a placeholder and re-read them on reload.
      const parts: any[] = [{ type: "text", text: userInput }];
      const imgParts = await imageParts(images);
      for (let i = 0; i < imgParts.length; i++) {
        parts.push({ ...imgParts[i], image_path: images[i].path });
      }
      this.messages.push({ role: "user", content: parts });
    } else {
      this.messages.push({ role: "user", content: userInput });
    }

    let interruptions = 0;

    try {
      // Loop until the model stops requesting tools.
      while (true) {
        // Fold in anything typed while the previous request was in flight, so a
        // mid-turn steer lands alongside the tool results rather than after the
        // turn ends.
        for (const text of this.flushSteers()) emit({ type: "steer", text });

        // Compaction runs here, at the top of the loop, so it happens once per
        // crossing rather than on every round trip. It only triggers once
        // history passes the threshold, so most turns pay nothing.
        if (this.config.compact) {
          const before = this.messages.length;
          this.messages = await compactHistory(this.messages, (older) =>
            this.summarize(older)
          );
          if (this.messages.length < before) {
            emit({
              type: "text",
              text: `\n[compacted ${before - this.messages.length} earlier messages into a summary]\n`,
            });
          }
        }

        const { client, model } = this.route();
        const stream = await this.createWithRetry(client, model, emit);

        let content = "";
        const toolCalls: ChatCompletionMessageToolCall[] = [];

        // A transport failure part-way through the stream. `terminated` --
        // undici's message for a socket closed under it -- carries no HTTP
        // status, so `createWithRetry` cannot help: it only retries failures of
        // the initial request. And by the time chunks have arrived the reply is
        // already partly on the user's screen, so re-sending the request would
        // show that text a second time.
        //
        // So keep what arrived and ask for the rest: the partial text is
        // committed below like any other content, and the continuation builds
        // on it instead of repeating it.
        let interrupted = false;
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              content += delta.content;
              emit({ type: "text", text: delta.content });
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    id: tc.id ?? "",
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                // Providers may attach opaque data to a tool call that must be
                // echoed back on the next request. Gemini returns a
                // `thought_signature` here and rejects the following turn without
                // it ("Function call is missing a thought_signature"). Preserve
                // whatever the provider sent rather than rebuilding the call from
                // only id/name/arguments.
                const extra = (tc as any).extra_content;
                if (extra) (toolCalls[idx] as any).extra_content = extra;
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments)
                  toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        } catch (err) {
          // Anything that is not a normal end of stream happened mid-reply.
          // Rethrow if nothing arrived: with no partial text there is nothing
          // to build on, and a clean retry of the whole request is both safe
          // and simpler.
          if (!content && !toolCalls.some(Boolean)) throw err;
          interrupted = true;
          emit({
            type: "text",
            text: `\n[connection dropped mid-reply; asking ${this.route().model} to continue]\n`,
          });
        }

        // The reply was cut short, so the turn is not finished. Commit the text
        // that did arrive and go round again: the model sees its own partial
        // answer in the history and continues from there rather than repeating
        // it. Any tool call captured so far is dropped -- the connection died
        // mid-stream, so its arguments are very likely half-written, and a
        // truncated call in the history breaks every later request (see below).
        //
        // Bounded, so a connection that dies repeatedly fails the turn instead
        // of looping forever.
        if (interrupted) {
          if (++interruptions > MAX_INTERRUPTIONS) {
            throw new Error(
              `connection dropped ${interruptions} times mid-reply; giving up on this turn`
            );
          }
          if (content) this.messages.push({ role: "assistant", content });
          continue;
        }

        // Never commit a call whose arguments were cut off. Providers validate
        // every tool call in the history on each request, so one truncated
        // `arguments` string makes every later send fail with a bare "400
        // invalid argument" -- the session can never be used again. Drop the
        // damaged call and keep whatever else the turn produced.
        const goodCalls = toolCalls.filter((c) =>
          isValidJson(c.function?.arguments)
        );
        if (goodCalls.length !== toolCalls.length) {
          const lost = toolCalls.length - goodCalls.length;
          emit({
            type: "text",
            text: `\n[dropped ${lost} truncated tool call${lost === 1 ? "" : "s"} at the output-token cap]\n`,
          });
          toolCalls.length = 0;
          toolCalls.push(...goodCalls);
        }

        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
        this.messages.push(assistantMsg);

        if (!toolCalls.length) {
          emit({ type: "done" });
          return {};
        }

        // Run the tools. Independent read-only calls (see `parallelBatch`) are
        // started together and awaited together, which is where the speed-up
        // comes from -- the model will happily ask for six `read_file`s and six
        // serial reads are six round-trips of waiting. Everything the caller sees
        // is still emitted in request order, so the transcript is deterministic
        // regardless of which call finishes first.
        const parsed = toolCalls.map((call) => {
          let args: any = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            args = {};
          }
          return {
            id: call.id,
            name: call.function.name,
            args,
          };
        });

        const results = await runToolCalls(
          parsed,
          emit,
          (name, args) => this.runOneTool(name, args, emit),
          this.config.parallelTools !== false,
          (running) => {
            if (running !== this.runningTools) this.toolSeq++;
            if (running > 0 && this.runningTools === 0) this.toolPeak = 0;
            this.runningTools = running;
            this.toolPeak = Math.max(this.toolPeak, running);
          }
        );
        // Every result is committed before anything else happens. A turn that
        // asked for four tools and got four results back must leave four `tool`
        // messages in the history: an `assistant` turn with unanswered tool
        // calls is rejected by every provider, which strands the session.
        //
        // The user approved a new session. Nothing more will ever be done in
        // *this* one -- the app is about to switch away from it -- so the turn
        // ends here and the request is returned to the caller. Continuing to
        // ask the model for more tool calls would spend tokens on a
        // conversation nobody is looking at.
        //
        // Note the return happens *after* the loop, not inside it. Returning
        // from the middle left the remaining results unwritten, so the turn
        // ended on a dangling `tool` message -- the exact shape that breaks
        // the following request. Only the first approval is honoured; a model
        // that asks twice still opens one session.
        let openedNewSession: { title?: string; preamble?: string } | undefined;
        for (const { id, output, newSession } of results) {
          this.messages.push({ role: "tool", tool_call_id: id, content: output });
          if (newSession && !openedNewSession) openedNewSession = newSession;
        }
        if (openedNewSession) return { newSession: openedNewSession };
        return {};
      }
    } finally {
      // A turn is over however it ended -- finished, threw, or was abandoned
      // part-way through a tool batch -- so the live count must never stay
      // non-zero once `send` has returned.
      if (this.runningTools !== 0) this.toolSeq++;
      this.runningTools = 0;
      // The turn is answered, so any screenshot it carried has been seen. Done
      // in `finally` so a failed or abandoned turn does not leave the session
      // pinned to the vision model either.
      this.detachImages();
    }
  }

  /**
   * Start a streaming completion, retrying transient upstream failures.
   *
   * Vision endpoints (notably Gemini's free tier) routinely return 503 "high
   * demand" or 429; without a retry an ordinary screenshot question fails and
   * looks like a bug in coda. Only the initial request is retried -- once the
   * stream has started, a mid-stream failure is surfaced rather than silently
   * re-run, which would duplicate partial output.
   */
  private async createWithRetry(
    client: OpenAI,
    model: string,
    emit: (ev: AgentEvent) => void
  ) {
    const attempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.chat.completions.create({
          model,
          messages: trimHistory(this.messages),
          tools: toolDefinitions,
          stream: true,
        });
      } catch (err: any) {
        const status = err?.status ?? err?.response?.status;
        const transient = status === 503 || status === 429 || status === 500;
        if (!transient || attempt >= attempts) throw err;
        const waitMs = 500 * 2 ** (attempt - 1);
        emit({
          type: "text",
          text: `\n[${model} returned ${status}, retrying in ${waitMs / 1000}s (${attempt}/${attempts - 1})]\n`,
        });
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
}

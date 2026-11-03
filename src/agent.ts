import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { Config } from "./config.js";
import { parallelBatch, runTool, toolDefinitions } from "./tools.js";
import type { ToolResult } from "./tools.js";
import {
  AttachedImage,
  hasImagePart,
  imageParts,
} from "./image.js";

const SYSTEM_PROMPT = `You are a coding assistant running in a terminal.
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
): Promise<Array<{ id: string; name: string; ok: boolean; output: string }>> {
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

  const results: Array<{ id: string; name: string; ok: boolean; output: string }> = [];
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
    results.push({ id: call.id, name: call.name, ok: result.ok, output: result.output });
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
    this.messages = messages ?? [{ role: "system", content: SYSTEM_PROMPT }];
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

  private needsVision(): boolean {
    return this.messages.some((m) => hasImagePart((m as any).content));
  }

  /** The client and model to use for the next request. */
  private route(): { client: OpenAI; model: string } {
    return this.needsVision()
      ? { client: this.visionClient, model: this.config.visionModel }
      : { client: this.client, model: this.config.model };
  }

  /**
   * Send user input and stream the model's response through `emit`.
   * Resolves once the model has finished (no more tool calls).
   */
  async send(
    userInput: string,
    emit: (ev: AgentEvent) => void,
    images: AttachedImage[] = []
  ): Promise<void> {
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

    try {
      // Loop until the model stops requesting tools.
      while (true) {
        // Fold in anything typed while the previous request was in flight, so a
        // mid-turn steer lands alongside the tool results rather than after the
        // turn ends.
        for (const text of this.flushSteers()) emit({ type: "steer", text });

        const { client, model } = this.route();
        const stream = await this.createWithRetry(client, model, emit);

        let content = "";
        const toolCalls: ChatCompletionMessageToolCall[] = [];

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

        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
        this.messages.push(assistantMsg);

        if (!toolCalls.length) {
          emit({ type: "done" });
          return;
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
          runTool,
          this.config.parallelTools !== false,
          (running) => {
            if (running !== this.runningTools) this.toolSeq++;
            if (running > 0 && this.runningTools === 0) this.toolPeak = 0;
            this.runningTools = running;
            this.toolPeak = Math.max(this.toolPeak, running);
          }
        );
        for (const { id, output } of results) {
          this.messages.push({ role: "tool", tool_call_id: id, content: output });
        }
      }
    } finally {
      // A turn is over however it ended -- finished, threw, or was abandoned
      // part-way through a tool batch -- so the live count must never stay
      // non-zero once `send` has returned.
      if (this.runningTools !== 0) this.toolSeq++;
      this.runningTools = 0;
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

import { Agent, AgentEvent } from "./agent.js";
import type { AttachedImage } from "./image.js";
import { Config } from "./config.js";
import {
  DEFAULT_TITLE,
  Entry,
  SessionRecord,
  deriveTitle,
  newId,
  remove,
  save,
} from "./store.js";

/**
 * A live session: one Agent, its transcript entries, and its current status.
 * Output is buffered here so switching away from a busy session and back
 * again shows everything that accumulated.
 */
export class Session {
  readonly id: string;
  title: string;
  readonly cwd: string;
  entries: Entry[];
  status: "idle" | "thinking" = "idle";
  createdAt: number;
  updatedAt: number;
  private agent: Agent;

  constructor(
    private config: Config,
    rec?: SessionRecord
  ) {
    this.id = rec?.id ?? newId();
    this.cwd = rec?.cwd ?? process.cwd();
    this.entries = rec?.entries ?? [];
    this.createdAt = rec?.createdAt ?? Date.now();
    this.updatedAt = rec?.updatedAt ?? Date.now();
    this.title = rec?.title ?? DEFAULT_TITLE;
    this.agent = new Agent(config, rec?.messages);
  }

  /**
   * Run a user turn. Emits changes via onUpdate so the UI can redraw.
   * Safe to call only when status === "idle".
   */
  /**
   * Fold text typed during a running turn into that turn. Lands at the next
   * point the agent re-sends history -- between tool calls -- so it shapes the
   * work in progress instead of waiting for the turn to end.
   */
  steer(text: string): void {
    this.agent.steer(text);
  }

  async run(
    input: string,
    onUpdate: () => void,
    images: AttachedImage[] = []
  ): Promise<void> {
    this.status = "thinking";
    // Show the attachment in the transcript so it is clear what was sent; the
    // pixels themselves never go in the entry list.
    const label = images.length
      ? input + (input ? " " : "") + images.map((i) => `[image: ${i.path}]`).join(" ")
      : input;
    this.entries.push({ role: "user", text: label });
    // Give an untitled session its title from the first user message. Existing
    // titles are left alone so a long-running session keeps its identity.
    if (this.title === DEFAULT_TITLE) {
      this.title = deriveTitle([{ role: "user", content: input }]);
    }
    onUpdate();

    let assistantBuf: Entry | null = null;

    const emit = (ev: AgentEvent) => {
      switch (ev.type) {
        case "text": {
          if (!assistantBuf) {
            assistantBuf = { role: "assistant", text: "" };
            this.entries.push(assistantBuf);
          }
          assistantBuf.text += ev.text;
          break;
        }
        case "tool_start": {
          assistantBuf = null; // next text starts a fresh assistant bubble
          this.entries.push({
            role: "tool",
            name: ev.name,
            text: JSON.stringify(ev.args),
          });
          break;
        }
        case "steer": {
          // Folded into the running turn: show it in the transcript so it is
          // clear the model was steered mid-flight, and start a fresh
          // assistant bubble for whatever it says next.
          assistantBuf = null;
          this.entries.push({ role: "user", text: `(mid-turn) ${ev.text}` });
          break;
        }
        case "tool_result": {
          const last = this.entries[this.entries.length - 1];
          if (last && last.role === "tool" && last.name === ev.name) {
            last.ok = ev.ok;
            last.text = ev.output;
          }
          break;
        }
        case "done":
        case "error": {
          assistantBuf = null;
          break;
        }
      }
      onUpdate();
    };

    try {
      await this.agent.send(input, emit, images);
    } catch (err: any) {
      this.entries.push({
        role: "assistant",
        text: `error: ${err?.message ?? String(err)}`,
      });
    } finally {
      this.status = "idle";
      this.updatedAt = Date.now();
      await this.persist();
      onUpdate();
    }
  }

  toRecord(): SessionRecord {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messages: this.agent.messages,
      entries: this.entries,
    };
  }

  /**
   * Give the session a user-chosen title. Clearing it to the default title
   * re-arms auto-titling, so the next turn names the session from its first
   * message again.
   */
  async rename(title: string): Promise<void> {
    const trimmed = title.trim();
    this.title = trimmed || DEFAULT_TITLE;
    this.updatedAt = Date.now();
    await this.persist();
  }

  async persist(): Promise<void> {
    // Nothing to save for a brand-new, untouched session.
    if (this.entries.length === 0) return;
    await save(this.toRecord());
  }

  async delete(): Promise<void> {
    await remove(this.id);
  }
}

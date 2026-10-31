import { Agent, AgentEvent } from "./agent.js";
import { Config } from "./config.js";
import {
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
    this.title = rec?.title ?? "new session";
    this.agent = new Agent(config, rec?.messages);
  }

  /**
   * Run a user turn. Emits changes via onUpdate so the UI can redraw.
   * Safe to call only when status === "idle".
   */
  async run(input: string, onUpdate: () => void): Promise<void> {
    this.status = "thinking";
    this.entries.push({ role: "user", text: input });
    // Give an untitled session its title from the first user message. Existing
    // titles are left alone so a long-running session keeps its identity.
    if (this.title === "new session") {
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
      await this.agent.send(input, emit);
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

  async persist(): Promise<void> {
    // Nothing to save for a brand-new, untouched session.
    if (this.entries.length === 0) return;
    await save(this.toRecord());
  }

  async delete(): Promise<void> {
    await remove(this.id);
  }
}

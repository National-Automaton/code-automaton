# Code Automaton

A terminal agentic coding tool with session recall. It runs against any
OpenAI-compatible API (DeepSeek by default), with a full-screen TUI and
multiple live sessions per terminal.

## Sessions

`coda` keeps several conversations open at once in a single terminal. Each
session streams independently: switch away from a busy session and its
response keeps accumulating, then switch back to see it.

`coda` starts on a **new session**, with the cursor already in the input — a
saved session is never opened for you. Your previous sessions are one keypress
away: press **←** (or `Ctrl+R`) to open the picker, and `Esc` returns you to the
new session. The picker has a text prompt:

- **Type a message and press Enter** → starts a brand-new session with that
  message as its first turn.
- **Type `/command` and press Enter** → runs that command (`/help`, `/rename`,
  …) instead of starting a session. An unknown command is reported in the
  picker and the picker stays open so you can fix it.
- **Press Enter with nothing typed** → opens the session highlighted with
  `↑`/`↓`.
- **`Ctrl+X`** deletes the highlighted session; **`Alt+R`** renames it.
- Typing does *not* filter the list — use `↑`/`↓` to move through it.

In the picker every printable key is text for the new session's message; no
letter is a shortcut, so a message can start with any character. Delete and
rename are the modifier chords `Ctrl+X` and `Alt+R`, so they never collide with
typing.

The picker takes over the whole terminal rather than sitting under the current
conversation, so the list gets every row the terminal has and nothing from the
previous session is left on screen to be misread as part of it.

The header line reads `Code Automaton <version>` in bold, followed by the
current session's position and title.

| Key | Action |
| --- | --- |
| `Enter` | Send the current line — or, mid-turn, fold it into the running turn |
| `←` | Empty input: open picker · non-empty: move cursor left |
| `→` / `Home` / `End` | Move the cursor |
| `Ctrl+A` / `Ctrl+E` | Jump to start / end of line |
| `Backspace` / `Delete` | Delete before / under the cursor |
| `Ctrl+W` / `Alt+Backspace` | Delete previous word |
| `Alt+D` | Delete next word |
| `Ctrl+U` / `Ctrl+K` | Delete to start / end of line |
| `Alt+B` / `Alt+F` | Move back / forward one word |
| `↑` / `↓` | Recall a previous prompt in this session (edit it, then Enter to resend) |
| `PgUp` / `PgDn` | Scroll transcript one page |
| Mouse wheel | Scroll transcript (3 lines per notch) |
| `End` (scrolled back) | Jump back to the newest output |
| `Ctrl+R` | Open the session picker |
| *type* (in picker) | `Enter` starts a **new** session with that text (does not filter the list). A `/command` runs the command instead |
| `↑` / `↓` (in picker) | Move through sessions |
| `Enter` with nothing typed | **Open** the highlighted session |
| `Ctrl+X` (in picker) | **Delete** the highlighted session |
| `Alt+R` (in picker) | **Rename** the highlighted session |
| `Esc` (in picker) | Close the picker |
| `Alt+R` | Rename the current session (Enter saves, Esc cancels) |
| `Ctrl+V` | Attach the clipboard image (image-only clipboard; see [Images](#images)) |
| `Ctrl+T` | New session |
| `Ctrl+X` | Close the current session |
| `Ctrl+C` | Exit |
| `/help` | Show the command and key reference |
| `/quit` · `/exit` | Exit (same as typing `quit` / `exit`; sessions are saved) |

Sessions are saved as JSON in `~/.coda/sessions/` (mode `600`) and reloaded the
next time you start `coda`.

Opening the picker re-reads that directory, so sessions started, renamed or
deleted in **another terminal** show up here too: new sessions are added,
renames and new messages are picked up, and sessions deleted elsewhere
disappear. A session that is still running a turn in this terminal is left
alone — its in-flight output has not been written yet, so it would be clobbered.

The picker is always sorted most-recently-updated first, so two terminals list
the sessions they can both see in the same order. A session that has not been
used yet is not on disk (an empty session is not saved), so it appears only in
the terminal that started it until its first message.

A session you open is **locked** for as long as this terminal is on it, so a
second terminal cannot open the same session and overwrite your work. The lock
is advisory — a small `<id>.lock` file beside the session, refreshed with a
heartbeat while `coda` runs — and is released when you switch away, close the
session, or quit. By default `coda` will not open the session at all while
another terminal holds it, and says which process does; that is the loss-proof
default, since two writers to one session silently overwrite each other. A lock
left by a terminal that crashed goes stale on its own (a dead process on the
same machine, or a heartbeat older than 30 seconds across machines) and is
taken over automatically.

### Recalling a prompt

**`↑`** brings back the last prompt you sent in this session, so you can tweak it
and press Enter again instead of retyping it. Press it again to walk further
back, and **`↓`** to walk forward again.

The half-typed message you had in the input is not lost: it is held as the
draft, and stepping `↓` past the newest prompt puts it back exactly as it was,
caret included. `Esc` clears the line and ends the walk. Prompts sent with an
image come back with the image re-attached.

- The list is rebuilt from the session's transcript, so it survives switching
  sessions — reopening a saved session recalls its prompts, not just the ones
  sent since `coda` started.
- Slash commands are not recalled: `/model` is a command, not a message, and
  recalling it into the input would present it as one.
- A prompt typed mid-turn (folded into a running turn with Enter) is recalled
  without the `(mid-turn)` label the transcript shows against it.
- Recall is per session; switching sessions starts a fresh list.

Scrolling is **`PgUp`/`PgDn`** and the wheel; see [Scrolling back](#scrolling-back).

### Scrolling back

Long answers and tool output scroll past the visible window. `coda` keeps the
whole transcript of the session and scrolls through it:

- **Mouse wheel** — scrolls the transcript a few lines per notch.
- **`PgUp`/`PgDn`** — a page at a time.
- **`End`** — returns to the newest output.

`↑`/`↓` are *not* scrolling: they recall previous prompts. See
[Recalling a prompt](#recalling-a-prompt).

The header shows `▲ scrolled back N` while you are reading history. Scrolling is
independent of streaming: a reply that is still arriving keeps appending at the
tail without yanking you back down, so you can read earlier output while the
model is still writing.

### Status line

The line under the input shows `○ idle` or `● thinking`, and how many tools are
in use — the session counts as one of them, and a single call is the session's own
work, so it does not raise the number:

| Situation | Status line |
| --- | --- |
| Session open, nothing else running | `○ idle · 1 tool` |
| One call in flight | `● thinking · 1 tool` |
| Two calls in flight at once | `● thinking · 2 tools` |
| A five-call batch that just finished | `● thinking · 5 tools` |

So the number rises only when several calls are in use **concurrently** (see
[Parallel tool calls](#parallel-tool-calls)), never past 1 for ordinary
one-at-a-time work.

A count above 1 **lingers** for about a second and a half after the calls
finish, rather than only appearing while they are actually running. Two reasons: a
fast command completes in a few milliseconds — too quick to be on screen when the
frame is drawn — and a sequence of calls is idle in the gaps between them, so a
strictly live count would blink up and down. It uses the peak for the run, so a
batch of five reads `5 tools` even if it finished between two frames. After the
linger expires it falls back to `1 tool` while the session stays open. While you
are scrolled back the line also shows `PgDn/End to return`.

The keyboard hints that used to sit here have moved to `/help` and the key table
above.

`coda` enables terminal mouse reporting (SGR, `1000`+`1006`) while it runs, so
the wheel scrolls *its* transcript — the whole session, not just what happens to
be on screen. The tradeoff is that the terminal stops doing its own wheel
scrollback and drag-to-select while `coda` is open; hold **`Shift`** while
dragging to select and copy text, which is the standard escape hatch in Windows
Terminal and most other emulators. Mouse reporting is switched off on exit,
including on `Ctrl+C` and `SIGTERM`.

If dragging to select is more important to you than the wheel, disable mouse
reporting entirely:

```bash
export CODA_MOUSE=off
```

`coda` then leaves the mouse alone — the terminal's own drag-to-select and wheel
scrollback work as usual — and the transcript is scrolled with **`PgUp`/`PgDn`**
and **`End`** instead. This is the fix when a terminal does not honour
Shift-to-select, or when Shift-drag selects unreliably.

`coda` also repaints its frame in place rather than erasing the screen on every
render. A full-screen erase per frame — and with a streaming reply there is one
per chunk — left the terminal with nothing to scroll. The screen is cleared once
at startup; after that each frame overwrites in place, and the last frame is
left on screen at exit so it stays in the terminal's own scrollback.

### Renaming a session

A session names itself after its first message. To rename it, press **`Alt+R`**
in the chat view — or type `/rename` — and the input line turns into a title
editor, pre-filled with the current title. Typing `/rename Some title` renames
it directly, without the editor. From the session picker, **`Alt+R`** renames the
session currently highlighted in the list.

- **Enter** saves. **Esc** cancels and keeps the old title.
- `←`/`→`, `Home`/`End`, `Backspace`, and the usual `Ctrl+A`/`Ctrl+E`/`Ctrl+W`
  and `Alt+B`/`Alt+F`/`Alt+D` editing keys all work while editing.
- Clearing the title and pressing Enter returns it to auto-titling, so the next
  message names the session again.

The new title is written to disk immediately and shows in the header and the
picker.

## Install

```bash
npm install -g code-automaton
```

The package is named `code-automaton`, but the command it installs is `coda`:

```bash
coda --version
coda --help
```

You need an API key. Export it in your shell, or put it in a `.env` file:

```bash
export CODA_API_KEY=sk-...
```

`.env` is optional and is read from the current directory, then from the
project root. `coda` parses it itself — there is nothing to `source` and no
`dotenv-cli` needed. Variables already set in your environment always win, so
an exported key takes precedence over `.env`.

The `-g` matters: a bare `npm install code-automaton` only links the `coda`
command into `./node_modules/.bin/`, which is not on your `PATH`.

## Develop

From a clone, install dependencies and run straight from the TypeScript
source — `tsx` compiles on the fly, so there is no build step:

```bash
npm install
cp .env.example .env   # then put your CODA_API_KEY in .env
npm run dev
```

Pass CLI flags through with `--`:

```bash
npm run dev -- --help
npm run dev -- --version
```

The globally installed `coda` runs the **compiled** output in `dist/`, which
only refreshes when you build:

```bash
npm run build
node dist/index.js
```

So `npm run dev` reflects your edits immediately and `coda` does not — rebuild
before testing a change through the global command.

## Steering a running turn

While a turn is running — which, with tool calls, can be a while — pressing
**Enter** does not queue your text for later. It folds it into the turn: the
message is appended to the conversation, and because the full history is
re-sent on every step of the agent loop, the model sees it at its next step,
typically between tool calls. It appears in the transcript as `(mid-turn) …`.

That means you can interrupt a long `bash` command or redirect a multi-step
task without waiting for it to finish. It is best-effort rather than an abort:
if the model was already composing its final answer, the steer arrives after
it. To stop a turn outright, close the session (`Ctrl+X`) or start a new one
(`Ctrl+T`).

## Images

Attach a screenshot to a message and the model can reason about it:

| Input | What it does |
| --- | --- |
| **Ctrl+V** | Attaches the clipboard image, if the clipboard holds an image and no text |
| `/paste` | Attaches the clipboard image regardless of any accompanying text |
| `/image <path>` | Attaches an image file (`png`, `jpeg`, `webp`, `gif`; max 5 MB) |

Ctrl+V only fires when the clipboard is image-only, so ordinary text pastes
still reach the terminal. A clipboard can hold an image *and* text at once —
copying a chart from a spreadsheet, or a browser image with its source URL —
and in that case text paste wins. Use `/paste` when you want the image anyway.

Messages carrying an image are routed to a vision model; everything else goes
to the text model. Both are configured separately (see [Config](#config)), so a
text-only setup keeps working unchanged.

Attachments are stored in the session as a `[image: path]` placeholder rather
than the image bytes: a 1 MB screenshot would otherwise put ~1.4 MB of base64
into every session file. The file is re-read when the session is reloaded, so a
moved or deleted image degrades to the placeholder.

**Clipboard access is WSL-only**, because Windows Terminal cannot pass image
data to a program through standard input — the clipboard is read from the
Windows side via PowerShell. On macOS/Linux use `/image <path>`.

## Tools

- `read_file` — read a file
- `write_file` — create/overwrite a file
- `edit_file` — replace the first occurrence of a string
- `list_dir` — list a directory
- `bash` — run a shell command

### Parallel tool calls

When the model asks for several tools in one response, the read-only ones run
concurrently instead of one after another — asking for five files takes about as
long as reading the slowest one, not the sum of all five. In the transcript the
tools still appear in the order the model requested them, and their results are
shown in that same order, so the transcript never interleaves.

Calls that write (`write_file`, `edit_file`) always run in order, and a batch
stops at the first such call: concurrent writers to one file would clobber each
other's read-modify-write. `bash` is treated as read-only, because deciding
whether an arbitrary command writes would mean parsing shell syntax and getting
it wrong occasionally — if you would rather have strict request order, set
`CODA_PARALLEL_TOOLS=off`.

## History compaction

Every request re-sends the whole conversation, so a long session costs more per
turn as it goes. Left alone, history grows at roughly 2,800 tokens per turn until
it reaches `CODA_MAX_CONTEXT_CHARS` (~800k tokens, around 285 turns), at which
point the oldest turns are dropped outright.

`CODA_COMPACT=on` changes what happens at the end of that budget: once history
passes 75% of it, the oldest turns are replaced with a model-written summary
instead of being dropped. The system prompt and roughly the last 20% of the
budget stay verbatim, and a failed summary falls back to the ordinary trim, so
compaction can never fail a turn that would otherwise have worked.

**It is off by default, and that is deliberate.** Two measured facts:

- Below the budget, compaction only costs you. The summary is a full-price call,
  and replacing the oldest turns changes the prompt prefix, which invalidates the
  provider's cache for the rest of the request.
- At the budget, not compacting is far worse than it looks. Once the hard trim
  starts evicting from the front *every turn*, the cache prefix changes every
  turn too, and prompt caching stops working entirely.

In a 60-turn test against DeepSeek, crossing that point cost 2.09M input tokens
at a 38% cache-hit rate; with compaction it was 1.26M tokens at 94%, about 85%
less money. Almost all of that came from keeping the session clear of the
ceiling, not from the tokens the summary saved.

So: turn it on if a session might reach the budget — that is, a long session on
a model with expensive input, or any session you run with a lowered
`CODA_MAX_CONTEXT_CHARS`. On a cheap model with short sessions, leave it off.

## Commands

Slash commands are typed into the input and sent with Enter.

| Command | What it does |
| --- | --- |
| `/help`, `/?` | Print the command and key reference into the transcript |
| `/quit`, `/exit` | Exit `coda` and save sessions. Same as typing `quit` / `exit`, or `Ctrl+C` |
| `/paste` | Attach the clipboard image (see [Images](#images)) |
| `/image <path>` | Attach an image file (see [Images](#images)) |
| `/rename <title>` | Rename the current session. With no title, opens the interactive title editor (same as `Alt+R`) |
| `/model` | Choose this session's text and image model (see [Models](#models)) |
| `/secret` | Manage the credentials vault (see [Credentials vault](#credentials-vault)) |
| `/instructions` | Show the standing instructions in force (see [Standing instructions](#standing-instructions)) |

### Standing instructions

Rules that should apply to every session — "never merge a pull request", "use
tabs in this repo" — go in a markdown file and are added to the system prompt.

| File | Applies to |
| --- | --- |
| `~/.config/coda/INSTRUCTIONS.md` | every session |
| `<project>/.coda/INSTRUCTIONS.md` | sessions started in that project |

```markdown
# Standing instructions

## Git and pull requests

- Never merge, squash, or close a pull request. Always let me merge.
  Open the PR, confirm CI is green, and stop there.
- This applies to release PRs too.
```

- Both files are read when a session starts, so a change takes effect in the
  **next** session, not the current one.
- The project file is labelled separately in the prompt, so the model can tell a
  global rule from a project convention.
- `/instructions` prints what is actually in force, with the paths — the failure
  this exists to prevent is a rule that was written but never loaded, and seeing
  the text is the only way to tell the difference.
- `coda` never writes these files. They are your rules; a tool that edits its
  own instructions can quietly change its own limits.
- Capped at 8,000 characters, because the text is prepended to every request.

A resumed session keeps the system prompt it was saved with: the history is what
it was, and rewriting the first message would change a past conversation.

### Credentials vault

`coda` needs credentials for things beyond the model API — an app password for
Gmail, a token for another service. The vault holds them so they can be used
without ever being shown.

```
/secret add gmail          # prompts; the value is typed hidden
/secret list               # names and lengths only
/secret remove gmail
/secret exists gmail
```

The value is entered at a masked prompt:

```
secret "gmail" — value hidden:
> ••••••••••••••••••••••
○ idle · 1 tool   secret · Enter save · Esc cancel · input hidden
```

**How it protects the value**

- **Typed hidden.** The field draws one `•` per character. The value is never
  echoed to the terminal, so it cannot reach a scrollback buffer, a screen
  recording, or a screenshot. Only the length is visible, which is unavoidable
  if the caret is to point anywhere.
- **Never printed.** `/secret list` reports names and character counts. There is
  no "first four characters" hint — that convenience is exactly the leak the
  vault exists to avoid.
- **Never in the transcript.** The transcript is plain JSON written to
  `~/.coda/sessions/` on every turn and re-sent to the model as history, so it
  is the most likely place for a credential to end up. Tool output, assistant
  replies, and system notes are all scrubbed: any tracked value is replaced with
  `[redacted]` on the way in.
- **Paste is refused** in the prompt. A pasted value also lands in the
  terminal's paste stream and the clipboard history, which defeats the point.
- **Separate store.** `~/.config/coda/secrets/` (mode `700`, files `600`) is not
  the session directory, so a session file can never contain a credential.

**What it does not do.** These are plaintext files with `0600` permissions.
Anyone who can read your user's files can read the vault. Encrypting it needs a
key held somewhere the process cannot simply read — Windows DPAPI or the kernel
keyring — which is a real upgrade and deliberately not faked with home-grown
crypto. Treat the file permissions as the boundary.

Names are lowercase letters, digits, `.`, `_` and `-` (max 64), because the name
becomes a filename. `--force` replaces an existing secret.

#### Asking for a credential: `request_secret`

The agent can ask you for a credential it needs mid-task. You get a prompt; the
value goes straight into the vault and is never returned to the model:

```
WordPress username for runningafever.com:      ← echoed, it is not secret
Application password for runningafever.com:    ← typed hidden
```

- A non-secret such as a username is shown while typing (`hidden: false`); a
  password is masked by default.
- **Never return the value to the model.** `request_secret` returns only which
  names were saved, so the model can retry its `use_secret` call.
- **Never overwrite.** A name already in the vault is left alone and reported as
  such; change it deliberately with `/secret add <name> --force`.
- A cancelled prompt is reported as cancelled, and the model is told not to ask
  again in that turn.

Ask for credentials through this, not in ordinary chat. A password typed as a
chat message is in the transcript before anything can scrub it.

#### Opening a session: `new_session`

The agent can open a new session, exactly as `Ctrl+T` does, with a name and a
handover already in the input:

```jsonc
{ "title": "release 1.14.0",
  "preamble": "Handover from the previous session:\n…" }
```

The reason this exists: standing instructions are read when a turn starts and
carry through a session's history, so **editing them does not reach a session
that is already running**. The only clean way to pick up new rules is a new
session — and the handover is the part that used to be retyped by hand.

- **You are always asked first.** The prompt shows the title and the *size* of the
  handover, not the text itself (it is about to be in front of you anyway).
  Anything that is not a yes opens nothing.
- **The handover is placed unsent.** It lands in the new session's input, so you
  can read it before it becomes the first message — and, because an untitled
  session takes its name from that first line, a title you passed is kept either
  way.
- **The old session is left alone**, not closed: if the new one is not what you
  wanted, it is still in the picker and `Ctrl+X` is there if you want it gone.
  Its turn is persisted before the switch.
- **The new session inherits the directory, not a new one.** Like `Ctrl+T`, the
  working directory belongs to the process, so this cannot move you to a
  different project — restart coda for that.

#### Spending a credential: `use_secret`

The agent can *use* a credential without seeing it. It writes the command with
`{{secret:NAME}}` where the value belongs, and the host substitutes it after the
model has finished writing:

```jsonc
{ "command": ["curl", "--user", "admin:{{secret:wp-app-password}}",
              "https://site.test/wp-json/wp/v2/posts"] }
```

- **No shell.** The command is a program and arguments, run with `spawn` and
  `shell: false`, so a substituted value cannot be re-parsed as shell syntax.
- **Never in `argv` when it can be avoided.** `stdin` and `secret` are available
  for programs that read a password from their input, which keeps the value out
  of `ps` entirely. A value that reaches the argument list *is* briefly visible
  in the process table — that is a limitation of programs that only accept
  credentials as arguments, not something the tool can hide.
- **Refuses literal secrets.** If the command contains a known value as written,
  the call fails and the model is told to use a placeholder.
- **Every use is confirmed.** The prompt names the secret and the command as
  written — never a value — and nothing runs until you answer:

  ```
  Use credential wp-app-password to run:
    curl --user admin {{secret:wp-app-password}} https://site.test/wp-json/…
  run with this credential?   y = once · a = always this session · n / Esc = no
  ```

  `y` approves this call, `a` approves that secret for the rest of the session,
  `n`/`Esc` declines. Anything that is not a yes declines, including Enter —
  this prompt is the only thing between the agent and a credential.
- **Approval is per session and per secret.** Approving one credential does not
  approve another, and a new session starts over.
- **Output is scrubbed.** A child that echoes its credential still produces a
  redacted tool result.

`write_file` and `edit_file` also refuse content containing a known secret. That
closes the easy accident; it does not stop a subprocess redirecting its own
output to a file, so it is not a sandbox.

### Models

`/model` opens a full-screen list of the models available on the configured
endpoints. The list is fetched from each endpoint's `/models` (every
OpenAI-compatible provider answers it) and falls back to the configured models
when an endpoint cannot be reached, so the picker still works offline.

```
Models  (↑/↓ text · ←/→ image · Enter select · Esc cancel)
──────────────────────────────────────────────────────────
    deepseek-flash                     gemini-2.5-flash
▸ ✓ deepseek-v4-pro                  ▸ gemini-3.6-flash
    gemini-2.5-pro                     gemini-2.5-pro
──────────────────────────────────────────────────────────
images in history: requests go to gemini-3.6-flash · from model endpoint
```

- **↑/↓** move between text models, **←/→** choose the image model, **Enter**
  applies the selection to this session, **Esc** cancels.
- The ✓ marks the text model the session is using and ▸ marks the row Enter
  will select. In the right-hand column, `▸` marks the image model ←/→ is on;
  it scrolls on its own, independently of the text list.
- The **choice is per session**, like everything else in `coda`: switching the
  model in one session does not reroute another, possibly mid-turn.
- Only chat-capable models are listed. Endpoints also serve embeddings, audio,
  transcription and image-generation models; selecting one would break the
  session on its next message, so they are filtered out.
- The image model is a separate setting, not a property of the row: `coda` has
  one image route, chosen whenever the history contains an image. The bottom
  line says so — **when an image is in the history the image model answers,
  whatever text model is ticked**.
- A model whose name advertises image support appears in the image column, as
  does any configured `CODA_VISION_MODEL`, which is trusted regardless of its
  name. When nothing image-capable exists the column is empty and ←/→ do
  nothing.

The selection is held in memory for the session's lifetime; the configured
`CODA_MODEL` / `CODA_VISION_MODEL` are what a new session starts from.

A line that begins with `/` but names no known command is **not** sent to the
model. Instead `coda` reports `unknown command: …` in the transcript and leaves
your text in the input so you can correct it (or press `Esc` to clear it). This
keeps a typo like `/quti` from being interpreted as a prompt. A bare `/` on its
own is exempt and is sent as ordinary text (e.g. a pasted absolute path).

## Config

| Env var | Default |
| --- | --- |
| `CODA_API_KEY` | (required; falls back to `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, then `ANTHROPIC_API_KEY`) |
| `CODA_BASE_URL` | `https://api.deepseek.com` (also reads `DEEPSEEK_BASE_URL` / `OPENAI_BASE_URL`) |
| `CODA_MODEL` | `deepseek-chat` (also reads `DEEPSEEK_MODEL` / `OPENAI_MODEL`) |
| `CODA_SESSIONS_DIR` | `~/.coda/sessions` (also reads the older `DSC_SESSIONS_DIR`) |
| `CODA_IMAGES_DIR` | `~/.coda/images` — cached copies of attached screenshots |
| `CODA_MOUSE` | `on` — set to `off` to leave mouse selection to the terminal (see [Scrolling back](#scrolling-back)) |
| `CODA_PARALLEL_TOOLS` | `on` — set to `off` to run tool calls strictly in the order the model requested them (see [Parallel tool calls](#parallel-tool-calls)) |
| `CODA_MAX_CONTEXT_CHARS` | `3200000` — the history budget for one request (~800k tokens). Lower it for a model with a smaller context window |
| `CODA_COMPACT` | `off` — set to `on` to summarize old turns once history reaches 75% of the budget, instead of letting the hard trim drop them (see [History compaction](#history-compaction)) |
| `CODA_VISION_MODEL` | the value of `CODA_MODEL` |
| `CODA_VISION_BASE_URL` | the value of `CODA_BASE_URL` |
| `CODA_VISION_API_KEY` | the value of `CODA_API_KEY` |

The `CODA_VISION_*` variables select the model used for messages containing an
image. They fall back to their text counterparts, but a model without vision
support will silently ignore the image rather than error — so set them
explicitly if you attach screenshots.

If no API key is found, `coda` exits with an error explaining the variable
names it looked for.

Note: `ANTHROPIC_BASE_URL` is intentionally **not** read. Anthropic-shaped URLs
(e.g. `https://api.deepseek.com/anthropic`) are not OpenAI-compatible and would
fail; only the *key* is borrowed from `ANTHROPIC_API_KEY`, so pair it with an
explicit `CODA_BASE_URL` if you rely on that fallback.

## Releasing

Releases are staged by CI on a version tag, then approved by hand. `main` is
protected, so the version bump must land through a pull request — a direct
`git push` to `main` is rejected by the repository rule, and a tag pushed before
the bump is merged would point at a commit that is not on the branch. The order
below keeps the two consistent:

```bash
# 1. Bump the version on a branch (npm version also builds dist/).
npm version patch                 # or minor / major — commits 1.4.3 + tags locally
git switch -c chore/release-$(node -p "require('./package.json').version")
git push -u origin chore/release-$(node -p "require('./package.json').version")

# 2. Open a PR and merge it. Do NOT squash: that rewrites the commit the
#    local version tag points at. Use a merge commit or fast-forward.
gh pr create --fill && gh pr merge --merge

# 3. Now push the tag, once its commit is on main.
git switch main && git pull --ff-only
git push origin v$(node -p "require('./package.json').version")
```

CI builds, checks the tag matches `package.json`, smoke-tests the artifact and
runs `npm stage publish --provenance`. It also creates a GitHub release.

Then approve the staged version in the **npm web UI** (account → Staged
packages). That approval is the 2FA proof-of-presence, so it stays manual — and
it is why the CI token needs no 2FA bypass. Once approved, mark the release
Latest:

```bash
gh release edit v1.4.3 --latest   # substitute the version just released
```

The release is created with `--latest=false` because a staged version is not
installable yet; "Latest" should follow what npm actually serves.

Before deciding to reuse a version number, check the **per-version** endpoint —
the top-level package document is cached and can lag:

```bash
curl -s https://registry.npmjs.org/code-automaton/<version>
```

## License

MIT — see [LICENSE](LICENSE).

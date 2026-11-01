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
- **Press Enter with nothing typed** → opens the session highlighted with
  `↑`/`↓`.
- Typing does *not* filter the list — use `↑`/`↓` to move through it.

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
| `↑` / `↓` | Scroll transcript one line |
| `PgUp` / `PgDn` | Scroll transcript one page |
| Mouse wheel | Scroll transcript (3 lines per notch) |
| `End` (scrolled back) | Jump back to the newest output |
| `Ctrl+R` | Open the session picker |
| *type* (in picker) | `Enter` starts a **new** session with that text (does not filter the list) |
| `↑` / `↓` (in picker) | Move through sessions |
| `Enter` with nothing typed | **Open** the highlighted session |
| `d` (in picker) | Delete highlighted session (asks for confirmation) |
| `r` (in picker) | Rename highlighted session (Enter saves, Esc cancels) |
| `y` | Confirm deletion (any other key cancels) |
| `Esc` (in picker) | Cancel |
| `Ctrl+V` | Attach the clipboard image (image-only clipboard; see [Images](#images)) |
| `Ctrl+T` | New session |
| `Ctrl+X` | Close the current session |
| `Ctrl+C` | Exit |
| `/quit` · `/exit` | Exit (same as typing `quit` / `exit`; sessions are saved) |

Sessions are saved as JSON in `~/.coda/sessions/` (mode `600`) and reloaded the
next time you start `coda`.

### Scrolling back

Long answers and tool output scroll past the visible window. `coda` keeps the
whole transcript of the session and scrolls through it:

- **Mouse wheel** — scrolls the transcript a few lines per notch.
- **`↑`/`↓`** — one line at a time; **`PgUp`/`PgDn`** — a page.
- **`End`** — returns to the newest output.

The header shows `▲ scrolled back N` while you are reading history. Scrolling is
independent of streaming: a reply that is still arriving keeps appending at the
tail without yanking you back down, so you can read earlier output while the
model is still writing.

`coda` enables terminal mouse reporting (SGR, `1000`+`1006`) while it runs, so
the wheel scrolls *its* transcript — the whole session, not just what happens to
be on screen. The tradeoff is that the terminal stops doing its own wheel
scrollback and drag-to-select while `coda` is open; hold **`Shift`** while
dragging to select and copy text, which is the standard escape hatch in Windows
Terminal and most other emulators. Mouse reporting is switched off on exit,
including on `Ctrl+C` and `SIGTERM`.

`coda` also repaints its frame in place rather than erasing the screen on every
render. A full-screen erase per frame — and with a streaming reply there is one
per chunk — left the terminal with nothing to scroll. The screen is cleared once
at startup; after that each frame overwrites in place, and the last frame is
left on screen at exit so it stays in the terminal's own scrollback.

### Renaming a session

A session names itself after its first message. To rename it, open the picker
and press **`r`** on the highlighted session: the entry field turns into a
title editor, pre-filled with the current title.

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

## Commands

Slash commands are typed into the input and sent with Enter. They are matched
exactly, so a message that merely *starts* with `/quit…` still reaches the
model.

| Command | What it does |
| --- | --- |
| `/quit`, `/exit` | Exit `coda` and save sessions. Same as typing `quit` / `exit`, or `Ctrl+C` |
| `/paste` | Attach the clipboard image (see [Images](#images)) |
| `/image <path>` | Attach an image file (see [Images](#images)) |

## Config

| Env var | Default |
| --- | --- |
| `CODA_API_KEY` | (required; falls back to `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, then `ANTHROPIC_API_KEY`) |
| `CODA_BASE_URL` | `https://api.deepseek.com` (also reads `DEEPSEEK_BASE_URL` / `OPENAI_BASE_URL`) |
| `CODA_MODEL` | `deepseek-chat` (also reads `DEEPSEEK_MODEL` / `OPENAI_MODEL`) |
| `CODA_SESSIONS_DIR` | `~/.coda/sessions` (also reads the older `DSC_SESSIONS_DIR`) |
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

Releases are staged by CI on a version tag, then approved by hand:

```bash
npm version patch          # or minor / major
git push && git push origin v$(node -p "require('./package.json').version")
```

CI builds, checks the tag matches `package.json`, smoke-tests the artifact and
runs `npm stage publish --provenance`. It also creates a GitHub release.

Then approve the staged version in the **npm web UI** (account → Staged
packages). That approval is the 2FA proof-of-presence, so it stays manual — and
it is why the CI token needs no 2FA bypass. Once approved, mark the release
Latest:

```bash
gh release edit v1.2.2 --latest
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

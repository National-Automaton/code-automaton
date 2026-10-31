# Code Automaton

A terminal agentic coding tool with session recall. It runs against any
OpenAI-compatible API (DeepSeek by default), with a full-screen TUI and
multiple live sessions per terminal.

## Sessions

`coda` keeps several conversations open at once in a single terminal. Each
session streams independently: switch away from a busy session and its
response keeps accumulating, then switch back to see it.

Press **←** (or `Ctrl+R`) at any time to open the session picker. The picker
has a text prompt:

- **Type a message and press Enter** → starts a brand-new session with that
  message as its first turn.
- **Press Enter with nothing typed** → opens the session highlighted with
  `↑`/`↓`.
- Typing also filters the list by title.

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
| `Ctrl+R` | Open the session picker |
| *type* (in picker) | Filter sessions; `Enter` starts a **new** session with that text |
| `↑` / `↓` (in picker) | Move through sessions |
| `Enter` with nothing typed | **Open** the highlighted session |
| `d` (in picker) | Delete highlighted session (asks for confirmation) |
| `y` | Confirm deletion (any other key cancels) |
| `Esc` (in picker) | Cancel |
| `Ctrl+V` | Attach the clipboard image (image-only clipboard; see [Images](#images)) |
| `Ctrl+T` | New session |
| `Ctrl+X` | Close the current session |
| `Ctrl+C` | Exit |

Sessions are saved as JSON in `~/.coda/sessions/` (mode `600`) and reloaded the
next time you start `coda`.

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

## License

MIT — see [LICENSE](LICENSE).

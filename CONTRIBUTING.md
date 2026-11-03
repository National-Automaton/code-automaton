# Contributing

## Branching

`main` is protected. All work happens on a short-lived branch and reaches `main`
through a pull request. Never commit directly to `main` — a `pre-push` hook
rejects it.

Name the branch after the kind of change:

| Prefix     | Use for                                          |
| ---------- | ------------------------------------------------ |
| `feature/` | new functionality                                |
| `fix/`     | bug fixes                                        |
| `docs/`    | documentation only                               |
| `chore/`   | tooling, deps, refactors with no behavior change |

The part after the slash is a short kebab-case slug, e.g. `fix/rename-caret-offset`.

```sh
git switch -c fix/rename-caret-offset
# ... make changes, commit ...
git push -u origin fix/rename-caret-offset
# open a pull request, then merge it
```

Keep branches focused on one change and rebase on `main` before opening a PR.

## One-time setup

This repo ships a shared git hook in `.githooks/` that blocks pushes to `main`.
Point git at it once per clone:

```sh
git config core.hooksPath .githooks
# or: npm run setup-hooks
```

The hook can be bypassed in an emergency with `ALLOW_MAIN_PUSH=1 git push ...`,
but that should be rare.

## Before you push

```sh
npm run typecheck   # type-checks src/ and test/
npm run build       # compiles to dist/
npm test            # renderer frame invariants
```

`npm test` runs `test/screen.test.ts` with `tsx` (no build needed). It captures
the bytes `Screen.render` writes and asserts the frame invariants — one paint per
frame, the frame fits the terminal, no row reaches the last column, and the caret
lands on the input row. Cases always walk chat → picker → chat, because the
interesting bugs live in the transitions, not in either frame on its own.

`tsconfig.test.json` exists so the tests are type-checked without being pulled
into the published build (`tsconfig.json` only includes `src/`).

## Releasing

Releases are cut from `main` with a version tag; see the notes at the top of
`.github/workflows/release.yml`.

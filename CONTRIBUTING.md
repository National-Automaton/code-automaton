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
npm run build     # type-checks and compiles
```

## Releasing

Releases are cut from `main` with a version tag; see the notes at the top of
`.github/workflows/release.yml`.

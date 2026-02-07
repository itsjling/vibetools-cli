# vibetools

`vibetools` is a cross-platform CLI for managing agent-agnostic skills and commands in a git-backed repo, then installing them into your locally installed AI agent tools via symlinks (with copy fallback).

## Quickstart

```sh
pnpm add -g vibetools
vibetools init
vibetools configure
vibetools pull
vibetools push
```

## Commands (MVP)

- `vibetools init [--repo <path>] [--remote <url>]`
- `vibetools configure`
- `vibetools status [--json] [--remote] [--agent <id>] [--type skills|commands]`
- `vibetools install [--dry-run] [--agent <id>] [--type skills|commands] [--policy prompt|repoWins|localWins] [--mode symlink|copy] [--force]`
- `vibetools collect [--dry-run] [--agent <id>] [--type skills|commands] [--policy prompt|repoWins|localWins] [--import-extras] [--force]`
- `vibetools pull [--rebase] [--dry-run]`
- `vibetools push [--message <msg>] [--dry-run]`
- `vibetools doctor`

## Repo layout (created by `vibetools init`)

```
.agents/
  skills/
  commands/
templates/
  AGENTS.md/
```

## Dev / Test

- Override vibetools home directory with `VIBETOOLS_HOME=/tmp/vibetools` (useful for tests/sandboxes).

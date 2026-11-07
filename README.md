# vessel

A terminal coding agent that carries your existing coding agents and routes each task to the best CLI/model combo.

vessel owns no model. It sits on top of the agent CLIs you already use (Claude Code, Codex, OpenCode, Pi, Droid) plus a small built-in API loop, and uses each CLI's own login. It never stores or proxies subscription credentials.

## Requirements

- [Bun](https://bun.sh)
- At least one supported CLI installed and logged in, or an API key for the built-in loop (set the env var named in `~/.vessel/config.json`)

## Install

```sh
bun install
bun link   # puts the `vessel` bin on your PATH
```

## Quick start

```sh
vessel roster                              # which routes are reachable, and why others are not
vessel run --dry-run "rename foo to bar"   # show the tier and ranked routes, run nothing
vessel run --verify "bun test" "fix the failing parser test"
vessel                                     # open the TUI
```

## How routing works

1. Classify the task into a tier: `trivial`, `standard` or `hard`.
2. Rank every reachable route (adapter + model + effort) using an evidence prior blended with your local outcomes for that route and tier, minus a cost and latency penalty.
3. Run the winner headless in your repo, falling back to the next route if it fails to start.
4. Verify with your command (exit 0 = pass).
5. Record the outcome, so the next ranking learns from it.

## Autonomy and safety

`--autonomy read|edit|full`, default `edit`.

- `read`: enforced by the backend, no edits or shell.
- `edit`: the agent can edit files and run a shell with your OS privileges. Only Codex is OS-sandboxed at this level. vessel prints a notice on every non-Codex `edit` run.
- `full`: bypasses each CLI's safeguards. Must be passed explicitly on every run; config cannot enable it.
- `--verify CMD` always runs. A `verify` command in a repo's `.vessel.json` runs only after you approve it with `vessel trust`, so a cloned repo cannot run arbitrary commands.

## Config and data

| Path | Purpose |
| --- | --- |
| `~/.vessel/` | Data dir (override with `VESSEL_HOME`) |
| `~/.vessel/config.json` | API providers for the built-in loop |
| `~/.vessel/evidence.json` | Per-model quality priors, seeded from `evidence.default.json`, user-editable |
| `~/.vessel/sessions/` | Event log per session |
| `~/.vessel/outcomes.jsonl` | Recorded pass/fail/unknown outcomes |
| `~/.vessel/trusted.json` | Hashes of trusted verify commands |
| `<repo>/.vessel.json` | Per-project config: `{"verify": "bun test"}` |

## Commands

| Command | Does |
| --- | --- |
| `vessel` / `vessel tui` | Open the TUI |
| `vessel run "<task>"` | Route and run a task (`--dry-run`, `--verify`, `--tier`, `--adapter`, `--model`, `--effort`, `--autonomy`, `--cwd`) |
| `vessel roster` | Show reachable routes and why others are unavailable |
| `vessel sessions` | List sessions |
| `vessel logs <id>` | Print a session's event log |
| `vessel resume <id> "<prompt>"` | Continue a session on the same route |
| `vessel rate <id> pass\|fail` | Label an outcome |
| `vessel trust [--cwd DIR]` | Trust the repo's `.vessel.json` verify command |
| `vessel help [command]` | Show usage |

## Development

```sh
bun test
bun run typecheck
```

Design details: [SPEC.md](SPEC.md).

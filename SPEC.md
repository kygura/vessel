# vessel — SPEC

## What it is

`vessel` is a terminal coding agent that does not own a model. It sits on top of the coding agents already installed on the machine (Claude Code, Codex, OpenCode, Pi, Droid) and on raw model APIs (Anthropic, any OpenAI-compatible endpoint, which covers open-weight providers). For each task it classifies complexity, ranks every reachable CLI+model combination, runs the winner headless in the user's repo, streams its progress, records the outcome, and learns from that outcome next time.

It uses whatever subscriptions the user is already logged into through each CLI's own auth. It never stores or proxies subscription credentials. API keys for the built-in loop are read from environment variables named in config.

## Glossary

- **Route**: one runnable combination `{adapter, model, effort}`.
- **Adapter**: wraps one execution backend behind a single interface. Six of them: `claude`, `codex`, `opencode`, `pi`, `droid`, and `loop` (the built-in agent loop).
- **Roster**: the routes reachable right now. Built at runtime from installed binaries, their auth status, and their model lists. Never hardcoded.
- **Tier**: task complexity, `trivial | standard | hard`.
- **Evidence**: static per-model quality priors (leaderboard scores, cost), stored in a user-editable JSON file.
- **Outcome**: the recorded result of one run (pass/fail/unknown, cost, latency) keyed by route and tier.
- **Session**: one task run, plus any resumes of it, with its event log.

## Stack

- Bun + TypeScript, single package (it is a CLI, not a web app, so no backend/frontend split).
- zod for every external boundary: config, evidence, CLI JSON events, LLM classifier output, API responses.
- TUI: Ink (React for terminals).
- Storage: plain JSON/JSONL files under `~/.vessel/` (override with `VESSEL_HOME`). No database.
- Tests: `bun test`.

## Core flows

### 1. `vessel run "<task>"` (also the TUI's main action)

1. **Roster**: probe each adapter: binary on PATH, auth check, model list (see `docs/cli-contracts.md`). Claude has no list command, so its models come from the evidence file entries whose provider is `anthropic`; aliases (`opus`, `sonnet`, ...) resolve to those ids and are not separate routes. `loop` routes come from `config.json` providers whose API key env var is set. Probes run in parallel, each with a timeout, and results are cached for 10 minutes in `~/.vessel/roster.json`.
2. **Classify**: deterministic heuristic first (prompt length, scope verbs such as refactor/migrate/design/architecture vs rename/typo/fix, number of referenced paths, tests mentioned, repo size bucket from `git ls-files | wc -l`). Output `{tier, confidence, reasons}`. If confidence is under 0.6 and a cheap route exists, ask that route's model once through the `loop` adapter for a zod-validated `{tier, reasons}`. If the LLM call fails, keep the heuristic result. `--tier` overrides.
3. **Evaluate**: score each roster route for the tier:
   ```
   prior   = evidence score for model (0..1), 0.5 if unknown
   local   = (passes + 1) / (runs + 2)          # labeled outcomes only, this route+tier
   w       = runs / (runs + 5)
   quality = (1 - w) * prior + w * local
   score   = quality - λc[tier] * normCost - λl[tier] * normLatency
   ```
   Routes that are Pareto-dominated (another route has prior ≥ and cost ≤, at least one strictly; pins on adapter or model bypass this, an effort pin does not) are dropped before ranking, so weak expensive models cannot stretch the normalization range. Cost and latency are then min-max normalized across the remaining candidates; unknown cost uses the median. `--dry-run` disables exploration so its table is deterministic. Defaults: λc = {trivial 0.4, standard 0.15, hard 0.02}, λl = {trivial 0.1, standard 0.05, hard 0}. Effort comes from the tier: trivial→low, standard→medium, hard→high. Tie-break: CLI adapter over `loop`. Exploration: with 5% probability on non-hard tiers, pick the route with the fewest runs among those within 0.1 of the best score. `--adapter`, `--model` and `--effort` pin choices. `--dry-run` prints the ranked table and stops.
4. **Execute**: spawn the adapter in the target cwd (default: current dir) at the selected autonomy level, parse its stream into normalized events, and append each event to `~/.vessel/sessions/<id>.jsonl`. If the route fails to start (spawn error, auth error, exit before any assistant event), fall back to the next-ranked route (at most 3 fallbacks) and record the failure in the session log. Start failures are availability problems, not quality signals, so they are not written to `outcomes.jsonl`; if every route fails to start, one `unknown` outcome is written for the last route so the session can still be listed and rated.
5. **Verify + record**: if a verify command is set (`--verify "bun test"` or `verify` in the project's `.vessel.json`), run it after the agent finishes. Exit 0 = pass, non-zero = fail. Without a verify command the outcome is `unknown` and is excluded from `local` until the user labels it with `vessel rate <id> pass|fail`. An exit code of 0 from the agent alone never counts as a pass. Append to `~/.vessel/outcomes.jsonl`.

### 2. Sessions

- `vessel sessions` lists id, time, task (truncated), route, tier, outcome and cost.
- `vessel logs <id>` prints the normalized event log.
- `vessel resume <id> "<prompt>"` continues on the same route using the adapter's native resume. Adapters without resume report that it is unsupported.
- `vessel rate <id> pass|fail` labels an outcome.

### 3. Roster and evidence

- `vessel roster` shows the reachable routes and why each unreachable adapter is unavailable (not installed / not logged in / no models).
- Evidence lives in `~/.vessel/evidence.json` (`{models: {[id]: {provider, score, costPerTask?, source, reviewed}}}`), seeded on first run from `evidence.default.json` in the repo. vessel never hardcodes model ids in code; new models appear because a CLI lists them, and get prior 0.5 until evidence is added.

### 4. TUI (`vessel` with no args, or `vessel tui`)

A sessions list, a prompt input, a routing-decision panel (tier, reasons, ranked candidates with scores, chosen route), and a live event log for the running or selected session. The layout and interaction come from `DESIGN.md`.

## Adapter contract

```ts
interface Adapter {
  id: AdapterId
  capabilities: { resume: boolean; cost: boolean; listModels: boolean }
  probe(): Promise<{ available: boolean; reason?: string; models: ModelRef[] }>
  run(req: RunRequest, signal: AbortSignal): AsyncIterable<RouterEvent>
  resume?(nativeSessionId: string, req: RunRequest, signal: AbortSignal): AsyncIterable<RouterEvent>
}
```

`RouterEvent` is one zod discriminated union, and every event an adapter emits is validated against it (an invalid event becomes an `error` event). Native CLI events are parsed defensively because their shapes drift between CLI versions; probe outputs that are JSON are parsed with zod. `session` (native session id), `text`, `tool` (name, input summary, status, output summary), `usage` (tokens, costUsd?), `error`, `done` (ok, finalText). Each CLI adapter maps its native events onto this union per `docs/cli-contracts.md`. Unknown native events are ignored. Malformed JSON lines become a single `error` event, not a crash. Adapters are tested against recorded fixture JSONL, not against live CLIs.

## Built-in loop (`loop` adapter)

The fallback adapter for providers with no CLI. Kept deliberately small:

- Two wire formats over `fetch`: Anthropic Messages and OpenAI Chat Completions (OpenAI-compatible base URL). No SDKs.
- Four tools: `read_file`, `write_file`, `edit_file` (exact string replace), `bash` (timeout 120s, cwd-locked). Every path is resolved and rejected if it falls outside the session cwd.
- Turn cap of 50 by default, with token usage summed into `usage` events.
- Providers are configured in `~/.vessel/config.json`: `{providers: {[name]: {kind: "anthropic"|"openai", baseUrl, apiKeyEnv, models: string[]}}}`.

## Autonomy

`--autonomy read|edit|full`, default `edit`. Per-adapter flags are in `docs/cli-contracts.md`. `full` maps to each CLI's bypass flag and needs the explicit `--autonomy full` on every run; config cannot make it the default. The prompt is always passed after `--` so it can never be parsed as a flag.

- `read` must be enforced by the backend, not just requested: claude disallows Edit/Write/Bash/NotebookEdit, opencode gets an explicit deny config, `loop` exposes only `read_file`.
- `edit` includes a shell for claude, opencode, pi and `loop`, so the agent runs commands with the user's OS privileges. Only codex `edit` is OS-sandboxed. `vessel roster` and the start of every non-codex `edit` run print a one-line notice saying so. This is the accepted v1 tradeoff: an autonomous coding agent that cannot run tests is not useful.
- `loop` hardening: bash gets an allowlisted environment (PATH, HOME, LANG, TERM, TMPDIR, USER, SHELL) rather than a scrubbed copy; writes under `.git/` are denied; API requests use `redirect: "error"`; `baseUrl` must be https or loopback; `apiKeyEnv` must look like an env var name; known secret values are redacted from every error and from tool output before it is logged.

## Verify trust

`--verify CMD` is always honored. A `verify` from the repo's `.vessel.json` runs only if the SHA-256 of that command string is in `~/.vessel/trusted.json`; otherwise the run prints the command and `vessel trust` instructions and records `unknown`. `vessel trust [--cwd DIR]` shows the command and adds its hash. This stops a cloned repo, or an agent that edits `.vessel.json`, from turning a later run into arbitrary command execution.

## Out of scope for v1

- An HTTP proxy that exposes OpenAI/Anthropic-compatible endpoints to other tools (v2, reusing the evaluator).
- Live web refresh of evidence (the file is user-editable).
- Parallel multi-route races, cost budgets across sessions, and remote/cloud sessions.

## Done

1. `bun install && bun test` passes: adapter fixture parsing for all five CLIs, classifier cases, evaluator ranking and exploration (seeded RNG), loop tools including path-escape rejection, loop wire formats against a local mock HTTP server, and session store round-trip.
2. `bun run typecheck` is clean.
3. `bun src/cli.ts roster` lists the claude adapter as available on this machine and explains why codex/opencode/pi/droid are unavailable.
4. `bun src/cli.ts run --dry-run "rename foo to bar in utils.ts"` prints tier `trivial` and a ranked table, and `"design and implement a plugin system with migrations"` prints tier `hard`.
5. A live `bun src/cli.ts run --verify "test -f hello.txt" "create hello.txt containing hi"` in a temp git repo routes to claude, streams events, records outcome `pass`, and shows up in `vessel sessions`.
6. The `loop` adapter completes one tool-using task against the mock OpenAI-compatible server end to end.
7. The TUI starts, shows the sessions list and roster, and runs a `--dry-run` routing decision from the prompt input without crashing.

# TASKS

Harness: Claude Code. Planner: claude-opus-5-5 (high).
Roster reachable: native claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5. Codex (binary missing), Droid (unauthenticated), Pi (no providers) unreachable, so provider diversity is limited to model-family diversity.

| Role | Model | Effort | Access |
|---|---|---|---|
| planner | claude-opus-5-5 | high | session |
| heavy | claude-opus-5-5 | high | native |
| worker / grunt | claude-sonnet-5-5 | medium | native |
| discussion | claude-sonnet-5-5 | high | native |
| reviewer | opus for sonnet-written tasks, sonnet for opus-written tasks | high | native |
| designer (degraded: no visual evidence) | claude-fable-5-1 | high | native |
| ui-impl / drift-check | claude-sonnet-5-5 | medium / low | native |

Evidence basis: Terminal-Bench 4.0 (Vals, 2026-11-05): opus-5-5 65.15% $12.04, sonnet-5-5 64.14% $10.75 (inside 4-pt band, cheaper → worker), fable-5-1 58.08%, haiku-5-5 36.36%.

Destination: `router` CLI+TUI that routes coding tasks to the best reachable CLI/model and passes the SPEC "Done" list.

## Decisions so far
- Stack Bun+TS (user). Execution: CLI adapters + built-in loop (user). Done = SPEC Done list (user).
- "Proxy" = session manager; HTTP proxy is v2 (discussion).
- Classifier = heuristic + LLM fallback under 0.6 confidence; evaluator = shrinkage prior/local formula in SPEC (discussion).
- Roles re-resolved on Terminal-Bench 4.0 after model refresh (user asked).
- Pass label = verify command or manual rating only; agent exit 0 never counts (discussion).
- T1 done: core types/paths/config/proc in src/core; evidence seed moved from TB2.1 to TB4.0 in T4.
- D1 done: DESIGN.md 4-band layout, App + useRun containers, 9 presentational components.

## Tasks

| id | task | deps | role/model | status |
|---|---|---|---|---|
| T1 | Scaffold, core types/schemas, storage paths, spawn+JSONL helper, evidence.default.json | — | grunt opus@medium | done (ce1c6a4) |
| T2a | Adapters claude, codex, opencode + fixtures/tests | T1 | worker sonnet@medium | done (aca8753) |
| T2b | Adapters pi, droid + fixtures/tests | T1 | worker sonnet@medium | done (f5f2842, 6e11b6b) |
| T3 | `loop` adapter: wire formats, 4 tools, path guard, mock-server tests | T1 | heavy opus@high | done (31c6bf6) |
| T4 | Roster probe/cache, classifier, evaluator (TDD) | T1 | worker sonnet@medium | done (0188b58) |
| T5 | Adapter registry, run orchestrator (fallback, verify, outcomes), sessions store, CLI commands | T2a T2b T3 T4 | worker sonnet@medium | done (c49cd34) |
| D1 | DESIGN.md for TUI | SPEC | designer fable | done |
| T6a | TUI presentational components | D1 | ui-impl sonnet@medium | done (e2161b8) |
| T6b | useRun hook + reducer | T5 D1 | ui-impl sonnet@medium | done (6505fde) |
| T6c | App.tsx + index.tsx wiring | T6a T6b | ui-impl sonnet@medium | done (155e547) |
| V | Verification gate (review lenses, finalizer, ponytail-review, spec review, drift, live done checks) | T6 | reviewer opus/sonnet (cross-model) + lenses | done (2 loops) |

## Review round 1 (fixes dispatched in parallel to original authors)
- R-loop (opus): env allowlist, .git write deny, redirect:error, key redaction everywhere, https/loopback baseUrl, apiKeyEnv shape.
- R-adapters (sonnet): `--` before prompt, enforced read for claude/opencode, exit-code-after-done, claude session id, droid probe in empty tmp dir.
- R-routing (sonnet): prefix-stripped evidence lookup, Pareto pruning, explore flag, roster cache/timeout, classifier word/path fixes.
- R-run (sonnet): resume outcome merge, abort during verify, verify trust + `router trust`, fallback cap 3, cwd validation, rate guard, resume flags, shell-privilege notice, `.only` gate.
- Decisions: Opus pick on "create hello.txt" was weak expensive outliers squeezing cost normalization + classifier miss, not a formula bug → Pareto pruning (SPEC). Loop/claude/pi `edit` with shell = user privileges accepted for v1, surfaced as notice (SPEC).
- R-adapters done. Verify at gate: opencode yargs positional after `--` (unverified); done now emitted only after process exit.
- R-loop done (0400671). Open: typecheck TS2366 in src/tui/state.ts:32 — likely RunUpdate/Phase union grew in run.ts fix; resolve after R-run lands.
- R-routing done (7820a3d). Tier picks with TB4 evidence: trivial→haiku-5-5, standard→sonnet-5-5, hard→opus-5-5 (planner expectation 'trivial→sonnet' was wrong; math verified).
- Gate loop 1 launched in parallel: live Done, finalizer, ponytail-review, spec+standards, drift, resilience+TUI reliability (all report-only).
- Gate L1 resilience: MAJOR useRun mount throws on bad evidence/unwritable home; orphan CLI child when consumer stops (no kill in streamCli finally); verify `sh -c` grandchildren hold pipe → hang past timeout. MINOR roster cache write uncaught, refresh() unhandled rejection, session log reads grow w/ history + pastEvents uncapped, stderr unbounded, plan ignores abort pre-createSession, no idle watchdog.
- Gate L1 drift: MAJOR sessions rows missing time/route/tier/outcome word/cost; recorded decision fabricates 100% confidence + empty table (fix: persist classification+top candidates in session record); focus indicator lacks reverse-video row; log key hints missing j/k; classifying note never "asking <model>". MINOR height rows-1, collapse thresholds, empty-state wording, roster overlay word "unavailable", silent noRoutes submit.
- Gate L1 finalizer: MAJOR fallback line never yielded to TUI; verifying header lacks command; LLM classifier ignores timeout/abort (complete() no signal); roster cache key ignores config.json + apiKeyEnv presence. MINOR persist decision on SessionRecord (dup of drift #2), note "asking <model>", verify output not shown in TUI, `r` swallowed in prompt focus, all-start-fail writes no outcome, explored marker unshown, droid "not found" wording, two cost formatters.
- Gate L1 spec+standards: start failures out of outcomes (SPEC clarified), effort pin must not bypass Pareto, droid probe `--`, dead PROVIDER_OF.codex, zod on emitted events + JSON probe outputs (SPEC clarified), malformed .router.json notice. Docs committed (471188c). One flaky test seen once in 153 — gate loop 2 reruns suite 5x to find it.
- Gate loop 1 fixes dispatched in parallel: A=core+adapters (opus), B=run/cli/routing/format.ts (sonnet), C=tui (sonnet).
- L1 C done (8e733fc). Accepted deviation: `r` opens roster on empty prompt only when no routes (else it would eat first letter of 'refactor...').
- L1 A done (7717282, 61c6867): 170 tests, typecheck clean. Accepted: loop keeps own provider/model split (resolve's last-slash split breaks openrouter/meta-llama/x).
- Gate loop 2 launched in parallel: live Done + 5x suite flake hunt + abort/orphan check; fresh delta review (reliability/resilience/risk); TUI drift recheck.
- L2 drift: all 5 prior majors fixed. Remaining minor (accepted): 80-col compact session rows, roster '+N more' truncation, cosmetic 140-col alignment.
- L2 delta review: MAJOR verify output head-truncated (fix: keep tail). MINOR buffered stdout dropped after exit grace, start-fail outcome skews latency/credit (startFailed flag), Ctrl-C can't reach detached groups (exit-time group registry), abort before createSession, timer not cleared, spawnJsonl grandchildren survive (group kill), stale test fakes. Dispatched to A + B in parallel.
- L2 live: Done #1-7 PASS, suite 5x 170/170 (no flake reproduced), abort leaves no orphan, recorded decision renders, help works. Found: raw Ctrl+D (\x04) ignored in TUI → sent to C. Noted: wrapped claude inherits user's Claude Code output style/hooks (environment, not router). Duplicate rate row deduped by readOutcomes later-wins.
- Gate PASSED after 2 fix loops: typecheck clean, 178/178 x2, Done #1-7 live, Ctrl-C leaves no orphan.

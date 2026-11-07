# router — TUI DESIGN

Design brief for the Ink (React for terminals, Bun) interface described in SPEC.md section 4. The TUI is a thin consumer of the core modules (`roster`, `classify`, `evaluate`, `run`, `sessions`); it holds UI state only and never re-implements routing logic.

## Layout

Minimum terminal is 80 columns by 24 rows. The screen is a fixed-height column with four horizontal bands:

1. **Status bar** (1 row, top). Roster summary: reachable adapters as `glyph name` pairs, then a muted count of unavailable adapters. Example text: `OK claude  OK loop  -- codex (not installed)  -- pi (not logged in)`. Long rosters truncate with `+N more`; the full list is readable in the roster panel (key `r`).
2. **Body** (all remaining rows). Split left/right. Left column is the **sessions list**, 26 columns wide at 80 columns, growing to 34 at 120 and capped at 40. Right column holds the **decision panel** on top and the **event log** below, separated by a single-line divider. The decision panel is 8 rows at 24 rows tall and grows to a maximum of 14 rows as the terminal gets taller; the event log takes whatever is left and is never shorter than 6 rows.
3. **Prompt input** (3 rows, bottom: 1 border, 1 input line, 1 border). Spans full width. Shows a `>` marker, the typed text, and a right-aligned mode tag `[dry-run]` or `[run]`.
4. **Key hint line** (1 row, below the input). Context-sensitive list of the active keybindings for the focused region.

At widths over 120 the candidates table in the decision panel shows all columns (rank, score, cost, adapter, model, effort). Under 100 columns `cost` and `effort` collapse into a short suffix on the model cell (`sonnet  $0.04 med`). Under 90 columns the sessions list shows id and outcome glyph only; the task preview is dropped. Nothing ever wraps inside a table row; cells are truncated with an ellipsis.

The sessions list and event log scroll independently. The decision panel does not scroll; if the roster has more candidates than fit, it shows the top N and a muted `+N more` footer. Everything above the fold is the chosen route.

## Hierarchy

The eye should land on the **decision panel's first line**: `tier  confidence  chosen route`. That is the product. Everything else supports it.

- **Idle**: no decision yet. The decision panel shows a one-line muted hint (`Type a task and press Enter`). The sessions list is the strongest region because it carries real data. The prompt input has focus and a visible cursor.
- **Running**: the decision panel keeps the decision pinned (chosen route marked, candidates dimmed) and the event log becomes the loudest region, with a `running` state glyph and an elapsed-time counter in its header. The prompt input is disabled and shows `running... (Esc to abort)`.
- **Selected past session**: the sessions list row is inverted (reverse video), the decision panel shows that session's recorded decision with a `recorded` tag in its header, and the event log replays its JSONL. The prompt input is visible but reads `resume: ` as a prefix when the user presses `R`, so the user knows the next submit is a resume, not a new run.

Headers of every panel are bold; body text is normal weight; secondary data (timestamps, costs, reasons) is muted. Only one region uses reverse video at a time: the focused list row or the chosen candidate row.

## Color and theme

Palette is ANSI-16 only, so it renders on any terminal and respects the user's theme. Semantic roles, each with a glyph so color is never load-bearing:

| Role | Glyph + text | ANSI color |
| --- | --- | --- |
| pass | `OK pass` | green |
| fail | `XX fail` | red |
| unknown | `?? unknown` | yellow |
| running | `>> running` (spinner cycles `|/-\\` in the header only) | cyan |
| chosen route | `* ` prefix on the row | bold, no color |
| error event | `!! ` prefix | red |
| muted | no glyph | dim (SGR 2), falling back to default color |

Never use bright-black (ANSI 8) for muted text; it is invisible on many light themes. Use `dim` on the default foreground instead. Never set a background color; the terminal background is the user's. Bold is used for headers and the chosen route only.

When `NO_COLOR` is set (any value) or stdout is not a TTY, every color is dropped and the glyph/text pairs carry the full meaning. Bold and dim are kept because they are weight, not color. This path is the same component tree with the theme switched to a no-op, so it is exercised by the same tests.

## Interaction

Keybindings (global unless noted):

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Cycle focus: prompt -> sessions -> event log -> prompt |
| `Enter` (prompt focused) | Submit the prompt. Runs a dry-run or a run depending on the mode toggle. |
| `Ctrl+D` | Toggle dry-run mode. Reflected immediately in the input's mode tag. |
| `Up` / `Down` or `j` / `k` (sessions focused) | Move selection. Selecting loads that session's decision and log. |
| `Enter` (sessions focused) | Focus the event log for the selected session. |
| `R` (session selected) | Prefix the prompt with `resume: ` and focus it. Submit resumes on the same route. Adapters without resume show an inline error. |
| `p` / `f` (session selected, outcome unknown) | Rate pass / fail. Writes through `sessions.rate` and updates the row glyph. |
| `r` | Toggle the roster panel (an overlay listing every adapter, its state and unavailable reason). `Esc` closes it. |
| `Esc` | Abort a running session (sends the AbortSignal), close overlays, or clear the prompt, in that priority. |
| `q` / `Ctrl+C` | Quit. If a session is running, the first press aborts; the second quits. |

State machine for one submission, driven by the core and mirrored in UI state:

`idle -> classifying -> ranked -> running -> verifying -> done | failed`

Dry-run stops at `ranked`. What each region shows per state:

- **classifying**: decision panel header shows `>> classifying`, body empty except a one-line `heuristic...` or `asking <model>...` note. Event log unchanged. Prompt disabled.
- **ranked**: decision panel fills: line 1 tier, confidence as a percentage, chosen route; lines 2-3 reasons as a comma-joined muted list; then the candidates table with the chosen row marked `*`. In dry-run the prompt re-enables and the hint line reads `Enter to run this decision, Ctrl+D to leave dry-run`.
- **running**: event log appends normalized events as they arrive. `text` events render as plain lines, `tool` events as one line (`tool  read_file  src/x.ts  OK`) with status glyph, `usage` events update a right-aligned token/cost counter in the log header rather than adding a line, `error` events render as `!! ` red lines, `done` renders a final `== done ok` or `== done failed` line. A fallback to the next-ranked route appears as an `!! fallback: <reason> -> <route>` line and the decision panel re-marks the chosen row.
- **verifying**: event log header shows `>> verifying: <command>`; the sessions list row for the new session already exists with `??`.
- **done / failed**: the sessions list row updates its glyph and cost. The event log header shows the final outcome and total cost. Focus returns to the prompt, cleared.

Errors from the core (probe failures, adapter spawn errors, zod rejections) never crash the UI. They render as one red `!! ` line in the event log and, if no session exists yet, in the decision panel body. Full error detail is in the session JSONL for `router logs <id>`.

Empty states, each one short sentence of muted text centered in its region:

- No sessions: `No sessions yet. Run a task to create one.`
- No roster (every adapter unavailable): status bar shows `-- no routes reachable`, the decision panel shows `No reachable routes. Press r to see why.`, and submitting is blocked with that same line.
- Roster probing on startup: status bar shows `>> probing adapters...` until the parallel probes resolve or time out; the rest of the UI is usable meanwhile.
- Empty event log for a selected session: `No events recorded.`

## Component boundaries

Two containers, everything else presentational. Presentational components take plain data and callbacks, never core modules.

**Containers**

- `App` — owns the single UI state object: focus, mode (dry-run/run), selected session id, run state, and the decision/event buffers for the active run. Subscribes to `roster.get()` on mount, `sessions.list()` on mount and after each run, and consumes the `AsyncIterable<RouterEvent>` from `run`. Passes slices down.
- `RunController` — not a visual component; a hook (`useRun`) called by `App` that wraps `classify`, `evaluate` and `run` into the state machine above and exposes `{state, decision, events, submit, abort}`. This is the only place that imports core modules besides `App`. Keeping it a hook means the state machine is testable without rendering.

**Presentational** (props listed are the data they need from the core shapes)

- `StatusBar` — `roster: {adapter, available, reason?}[]`, `probing: boolean`.
- `SessionsList` — `sessions: {id, time, task, route, tier, outcome, costUsd?}[]`, `selectedId`, `focused`, `onSelect`.
- `DecisionPanel` — `state`, `decision?: {tier, confidence, reasons, candidates: {route, score, costUsd?, runs}[], chosen: route}`, `recorded: boolean`, `width`.
- `CandidatesTable` — the ranked table inside `DecisionPanel`; `candidates`, `chosen`, `width`. Owns the column-collapse rules.
- `EventLog` — `events: RouterEvent[]`, `state`, `elapsedMs`, `usage?`, `focused`, `height`.
- `PromptInput` — `value`, `mode`, `disabled`, `prefix?`, `onChange`, `onSubmit`.
- `RosterOverlay` — `roster` (same shape as `StatusBar`), `onClose`.
- `KeyHints` — `focus`, `state`, `hasSelection`.
- `Status` — tiny shared glyph+text+color renderer used by every region for pass/fail/unknown/running/error. The single source of the semantic table above.

All text comes from the core types; the TUI does not format scores, costs or tiers in more than one place. A `format.ts` helper (not a component) owns percentage, currency and duration formatting so the CLI tables and the TUI agree.

## Accessibility

No information is conveyed by color alone. Every status has a two-character glyph and a word. Running state uses a spinner plus the word `running`, so a screen reader or a monochrome terminal sees the same thing. Focus is shown by reverse video on the active row plus a bold panel header, and the key hint line always names the focused region. Column alignment uses spaces, not box-drawing glyphs inside tables, so copy-paste and screen readers keep the structure. Border characters are the ASCII fallback (`-`, `|`, `+`) when the locale is not UTF-8.

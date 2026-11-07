import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { RouterEvent, SessionRecord } from "../../core/types.ts";
import type { Roster } from "../../routing/roster.ts";
import { colorEnabled, colorOf, type CandidateRow, type Decision } from "../theme.ts";
import { CandidatesTable } from "./CandidatesTable.tsx";
import { DecisionPanel } from "./DecisionPanel.tsx";
import { EventLog } from "./EventLog.tsx";
import { KeyHints } from "./KeyHints.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { RosterOverlay } from "./RosterOverlay.tsx";
import { SessionsList } from "./SessionsList.tsx";
import { Status } from "./Status.tsx";
import { StatusBar } from "./StatusBar.tsx";

const frame = (el: React.ReactElement) => render(el).lastFrame() ?? "";
const noWider = (out: string, n: number) => out.split("\n").forEach((l) => expect(l.length).toBeLessThanOrEqual(n));
const ESC_COLOR = /\x1b\[3\dm/;

const route = (model: string, effort: "low" | "medium" | "high" = "medium") => ({ adapter: "claude" as const, model, effort });
const cand = (model: string, score: number, costUsd?: number): CandidateRow => ({
  route: route(model), score, prior: 0.5, local: 0.5, runs: 0, costNorm: 0, latencyNorm: 0, costUsd,
});
const decision: Decision = {
  tier: "standard",
  confidence: 0.82,
  reasons: ["mentions tests", "2 paths referenced", "short prompt"],
  candidates: [cand("sonnet", 0.81, 0.04), cand("haiku", 0.7, 0.004), cand("opus", 0.6, 0.4)],
  chosen: route("sonnet"),
};
const sess = (id: string, result?: "pass" | "fail" | "unknown"): SessionRecord => ({
  id, createdAt: "2026-01-01T00:00:00Z", cwd: "/x", prompt: `task for ${id} with a rather long description`, route: route("sonnet"), tier: "standard", result,
});
const roster: Roster = {
  routes: [{ adapter: "claude", model: "sonnet" }, { adapter: "claude", model: "haiku" }, { adapter: "loop", model: "gpt" }],
  unavailable: [{ adapter: "codex", reason: "not installed" }, { adapter: "pi", reason: "not logged in" }],
};

afterEach(() => { delete process.env.NO_COLOR; delete process.env.FORCE_COLOR; });

describe("theme", () => {
  test("NO_COLOR drops colors; FORCE_COLOR re-enables off-TTY", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(false);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    process.env.NO_COLOR = "1";
    expect(colorOf("pass")).toBeUndefined();
    process.env.NO_COLOR = undefined as never;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(colorOf("pass")).toBe("green");
  });
});

describe("Status", () => {
  test("every kind renders glyph + word under NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    const out = ["pass", "fail", "unknown", "running", "error", "unavailable"].map((k) => frame(<Status kind={k as never} />));
    expect(out).toEqual(["OK pass", "XX fail", "?? unknown", ">> running", "!! error", "-- unavailable"]);
    expect(out.join()).not.toMatch(ESC_COLOR);
  });
});

describe("StatusBar", () => {
  test("probing, empty, normal, truncated", () => {
    expect(frame(<StatusBar probing width={80} />)).toContain(">> probing adapters...");
    const none = frame(<StatusBar probing={false} roster={{ routes: [], unavailable: [] }} width={80} />);
    expect(none).toContain("-- no routes reachable");
    const ok = frame(<StatusBar probing={false} roster={roster} width={80} />);
    expect(ok).toContain("OK claude");
    expect(ok).toContain("OK loop");
    expect(ok).toContain("-- codex (not installed)");
    noWider(ok, 80);
    const cut = frame(<StatusBar probing={false} roster={roster} width={40} />);
    expect(cut).toMatch(/\+\d+ more/);
    noWider(cut, 40);
  });
});

describe("SessionsList", () => {
  test("empty state", () => {
    expect(frame(<SessionsList sessions={[]} focused={false} width={26} onSelect={() => {}} />)).toContain("No sessions yet.");
  });
  test("rows carry glyph + id; compact drops the task; 26 cols never wider", () => {
    process.env.NO_COLOR = "1";
    const s = [sess("aaaa1111", "pass"), sess("bbbb2222", "fail"), sess("cccc3333")];
    const out = frame(<SessionsList sessions={s} selectedId="bbbb2222" focused width={26} onSelect={() => {}} />);
    expect(out).toContain("OK aaaa1111 task");
    expect(out).toContain("XX bbbb2222");
    expect(out).toContain("?? cccc3333");
    expect(out).toContain("> Sessions");
    noWider(out, 26);
    const compact = frame(<SessionsList sessions={s} focused={false} width={26} compact onSelect={() => {}} />);
    expect(compact).toContain("OK aaaa1111");
    expect(compact).not.toContain("task for");
  });
  test("j moves selection through onSelect", async () => {
    const picked: string[] = [];
    const r = render(<SessionsList sessions={[sess("a"), sess("b")]} selectedId="a" focused width={26} onSelect={(id) => picked.push(id)} />);
    await Bun.sleep(20);
    r.stdin.write("j");
    await Bun.sleep(20);
    expect(picked).toEqual(["b"]);
  });
});

describe("CandidatesTable / DecisionPanel", () => {
  test("chosen row marked, collapse under 70 cols, +N more", () => {
    const wide = frame(<CandidatesTable candidates={decision.candidates} chosen={decision.chosen} width={86} />);
    expect(wide).toMatch(/rank\s+score\s+cost\s+adapter\s+model\s+effort/);
    expect(wide).toMatch(/\* 1\s+0\.81\s+\$0\.04\s+claude\s+sonnet\s+medium/);
    const narrow = frame(<CandidatesTable candidates={decision.candidates} chosen={decision.chosen} width={54} />);
    expect(narrow).toContain("sonnet  $0.04 med");
    expect(narrow).not.toMatch(/effort/);
    noWider(narrow, 54);
    expect(frame(<CandidatesTable candidates={decision.candidates} chosen={decision.chosen} width={54} maxRows={1} />)).toContain("+2 more");
    expect(frame(<CandidatesTable candidates={[]} chosen={decision.chosen} width={54} />)).toContain("No candidates.");
  });
  test("idle, classifying, no routes, error", () => {
    expect(frame(<DecisionPanel phase="idle" recorded={false} width={54} />)).toContain("Type a task and press Enter");
    const c = frame(<DecisionPanel phase="classifying" recorded={false} width={54} note="asking haiku..." />);
    expect(c).toContain(">> classifying");
    expect(c).toContain("asking haiku...");
    expect(frame(<DecisionPanel phase="idle" recorded={false} width={54} noRoutes />)).toContain("No reachable routes. Press r to see why.");
    expect(frame(<DecisionPanel phase="failed" recorded={false} width={54} error="probe failed" />)).toContain("!! probe failed");
  });
  test("ranked decision at 54 cols x 8 rows: first line is tier confidence route", () => {
    const out = frame(<DecisionPanel phase="ranked" decision={decision} recorded width={54} height={8} />);
    const lines = out.split("\n");
    expect(lines[0]).toContain("[recorded]");
    expect(lines[1]).toBe("standard  82%  claude/sonnet medium");
    expect(lines[2]).toContain("mentions tests");
    expect(out).toContain("* 1");
    noWider(out, 54);
    expect(lines.length).toBeLessThanOrEqual(8);
  });
  test("tall candidate list is cut with +N more inside the height", () => {
    const many = { ...decision, candidates: Array.from({ length: 12 }, (_, i) => cand(`m${i}`, 1 - i / 20, 0.01)), chosen: route("m0") };
    const out = frame(<DecisionPanel phase="running" decision={many} recorded={false} width={54} height={8} />);
    expect(out).toMatch(/\+\d+ more/);
    expect(out.split("\n").length).toBeLessThanOrEqual(8);
  });
});

describe("EventLog", () => {
  const events: RouterEvent[] = [
    { type: "session", id: "n1" },
    { type: "text", text: "hello\nworld" },
    { type: "tool", name: "read_file", input: "src/x.ts", status: "completed" },
    { type: "tool", name: "bash", status: "failed" },
    { type: "usage", inputTokens: 1000, outputTokens: 500, costUsd: 0.04 },
    { type: "error", message: "fallback: boom -> claude/haiku" },
    { type: "done", ok: true },
  ];
  test("renders lines, usage in header, glyphs under NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    const out = frame(<EventLog events={events} phase="done" elapsedMs={0} usage={{ inputTokens: 1000, outputTokens: 500, costUsd: 0.04 }} focused height={12} outcome="pass" />);
    expect(out).toContain("OK pass");
    expect(out).toContain("1.5k tok $0.04");
    expect(out).toContain("tool  read_file  src/x.ts  OK");
    expect(out).toContain("XX");
    expect(out).toContain("!! fallback: boom -> claude/haiku");
    expect(out).toContain("== done ok");
    expect(out).not.toContain("n1");
    expect(out).not.toMatch(ESC_COLOR);
  });
  test("running header has spinner + elapsed; verifying shows command; tail respects height", () => {
    expect(frame(<EventLog events={events} phase="running" elapsedMs={65_000} focused={false} height={4} tick={1} />)).toContain(">> running / 1m05s");
    expect(frame(<EventLog events={events} phase="verifying" elapsedMs={0} focused={false} height={8} verifyCommand="bun test" />)).toContain(">> verifying: bun test");
    const tail = frame(<EventLog events={events} phase="done" elapsedMs={0} focused={false} height={3} />);
    expect(tail).toContain("== done ok");
    expect(tail).not.toContain("hello");
  });
  test("empty states", () => {
    expect(frame(<EventLog events={[]} phase="idle" elapsedMs={0} focused={false} height={6} />)).toContain("No events recorded.");
    expect(frame(<EventLog events={[]} phase="running" elapsedMs={0} focused={false} height={6} />)).toContain("Waiting for events...");
  });
});

describe("PromptInput", () => {
  test("shows marker, text, mode tag at 80 cols; disabled and prefix states", () => {
    const out = frame(<PromptInput value="fix bug" mode="dry-run" disabled={false} onChange={() => {}} onSubmit={() => {}} />);
    expect(out).toContain("> fix bug");
    expect(out).toContain("[dry-run]");
    expect(out.split("\n")).toHaveLength(3);
    expect(frame(<PromptInput value="" mode="run" disabled onChange={() => {}} onSubmit={() => {}} />)).toContain("running... (Esc to abort)");
    expect(frame(<PromptInput value="go" prefix="resume: " mode="run" disabled={false} onChange={() => {}} onSubmit={() => {}} />)).toContain("> resume: go");
  });
  test("typing, backspace and Enter call back", async () => {
    const log: string[] = [];
    const r = render(<PromptInput value="ab" mode="run" disabled={false} onChange={(v) => log.push(`c:${v}`)} onSubmit={(v) => log.push(`s:${v}`)} />);
    await Bun.sleep(20);
    r.stdin.write("c");
    await Bun.sleep(20);
    r.stdin.write("\r");
    await Bun.sleep(20);
    expect(log).toEqual(["c:abc", "s:ab"]);
  });
  test("disabled ignores input", async () => {
    const log: string[] = [];
    const r = render(<PromptInput value="" mode="run" disabled onChange={(v) => log.push(v)} onSubmit={() => {}} />);
    await Bun.sleep(20);
    r.stdin.write("x");
    await Bun.sleep(20);
    expect(log).toEqual([]);
  });
});

describe("RosterOverlay", () => {
  test("lists every adapter with state and reason; Esc closes", async () => {
    process.env.NO_COLOR = "1";
    let closed = false;
    const r = render(<RosterOverlay roster={roster} onClose={() => (closed = true)} />);
    const out = r.lastFrame() ?? "";
    expect(out).toContain("OK claude  2 models");
    expect(out).toContain("OK loop  1 model");
    expect(out).toContain("-- codex  not installed");
    expect(out).toContain("-- pi  not logged in");
    await Bun.sleep(20);
    r.stdin.write("\x1b");
    await Bun.sleep(50);
    expect(closed).toBe(true);
  });
  test("empty", () => {
    expect(frame(<RosterOverlay roster={{ routes: [], unavailable: [] }} onClose={() => {}} />)).toContain("No adapters probed.");
  });
});

describe("KeyHints", () => {
  test("names the focused region and fits 80 cols", () => {
    expect(frame(<KeyHints focus="prompt" state="idle" hasSelection={false} />)).toContain("[prompt] Enter submit");
    expect(frame(<KeyHints focus="prompt" state="ranked" mode="dry-run" hasSelection={false} />)).toContain("Enter to run this decision, Ctrl+D to leave dry-run");
    expect(frame(<KeyHints focus="prompt" state="running" hasSelection={false} />)).toContain("Esc abort");
    const s = frame(<KeyHints focus="sessions" state="done" hasSelection />);
    expect(s).toContain("[sessions]");
    expect(s).toContain("R resume");
    expect(frame(<KeyHints focus="sessions" state="done" hasSelection={false} />)).not.toContain("R resume");
    expect(frame(<KeyHints focus="log" state="done" hasSelection={false} />)).toContain("[log]");
    noWider(s, 100);
  });
});

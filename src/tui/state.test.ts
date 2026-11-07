import { expect, test } from "bun:test";
import type { Outcome, Route, RouterEvent } from "../core/types.ts";
import type { Candidate } from "../routing/evaluate.ts";
import type { RunUpdate } from "../run.ts";
import { MAX_EVENTS, type TuiRunState, initialRun, isBusy, reduce } from "./state.ts";

const A: Route = { adapter: "claude", model: "opus", effort: "high" };
const B: Route = { adapter: "codex", model: "gpt", effort: "medium" };
const cand = (route: Route) => ({ route }) as unknown as Candidate;
const fold = (us: RunUpdate[], s: TuiRunState = initialRun) => us.reduce(reduce, s);
const text = (t: string): RunUpdate => ({ type: "event", event: { type: "text", text: t } });

test("initial state is idle and not busy", () => {
  expect(initialRun.phase).toBe("idle");
  expect(isBusy(initialRun)).toBe(false);
});

test("phase updates set phase and message; busy only mid-run", () => {
  const s = fold([{ type: "phase", phase: "classifying" }]);
  expect(isBusy(s)).toBe(true);
  const d = reduce(s, { type: "phase", phase: "done", message: "dry run" });
  expect(d).toMatchObject({ phase: "done", message: "dry run", error: undefined });
  expect(isBusy(d)).toBe(false);
});

test("classification, ranked and chosen route", () => {
  const classification = { tier: "hard" as const, confidence: 0.9, reasons: ["big"] };
  const s = fold([
    { type: "classification", classification, source: "llm" },
    { type: "ranked", candidates: [cand(A), cand(B)] },
  ]);
  expect(s.classification).toBe(classification);
  expect(s.source).toBe("llm");
  expect(s.candidates).toHaveLength(2);
  expect(s.route).toEqual(A);
});

test("route re-points the chosen route", () => {
  const s = fold([
    { type: "ranked", candidates: [cand(A), cand(B)] },
    { type: "route", route: A },
    { type: "route", route: B },
  ]);
  expect(s.route).toEqual(B);
});

test("started records the session id", () => {
  expect(fold([{ type: "started", sessionId: "s1" }]).sessionId).toBe("s1");
});

test("events append in order and cap at MAX_EVENTS keeping the newest", () => {
  const us = Array.from({ length: MAX_EVENTS + 25 }, (_, i) => text(String(i)));
  const s = fold(us);
  expect(s.events).toHaveLength(MAX_EVENTS);
  expect((s.events[0] as Extract<RouterEvent, { type: "text" }>).text).toBe("25");
  expect((s.events.at(-1) as Extract<RouterEvent, { type: "text" }>).text).toBe(String(MAX_EVENTS + 24));
});

test("verify and outcome are stored", () => {
  const outcome = { sessionId: "s1", result: "pass" } as unknown as Outcome;
  const s = fold([
    { type: "verify", command: "bun test", ok: false, exitCode: 1, output: "boom" },
    { type: "outcome", outcome },
  ]);
  expect(s.verify).toEqual({ command: "bun test", ok: false, exitCode: 1, output: "boom" });
  expect(s.outcome).toBe(outcome);
});

test("failed phase sets error from message, defaulting to 'failed'; later non-failed phase keeps it", () => {
  expect(fold([{ type: "phase", phase: "failed", message: "aborted" }]).error).toBe("aborted");
  expect(fold([{ type: "phase", phase: "failed" }]).error).toBe("failed");
});

test("verify failure: failed phase after outcome keeps the outcome", () => {
  const outcome = { sessionId: "s1", result: "fail" } as unknown as Outcome;
  const s = fold([{ type: "outcome", outcome }, { type: "phase", phase: "failed" }]);
  expect(s.outcome).toBe(outcome);
  expect(s.phase).toBe("failed");
});

test("reduce never mutates its input", () => {
  const before = fold([text("a")]);
  const snap = structuredClone(before);
  reduce(before, text("b"));
  expect(before).toEqual(snap);
});

test("full dry-run walk", () => {
  const s = fold([
    { type: "phase", phase: "classifying" },
    { type: "classification", classification: { tier: "trivial", confidence: 1, reasons: [] }, source: "heuristic" },
    { type: "phase", phase: "ranked" },
    { type: "ranked", candidates: [cand(A)] },
    { type: "phase", phase: "done", message: "dry run" },
  ]);
  expect(s).toMatchObject({ phase: "done", route: A, message: "dry run" });
  expect(s.events).toEqual([]);
});

test("notices accumulate in order without duplicates", () => {
  const s = fold([{ type: "notice", message: "a" }, { type: "notice", message: "b" }, { type: "notice", message: "a" }]);
  expect(s.notices).toEqual(["a", "b"]);
  expect(initialRun.notices).toEqual([]);
});

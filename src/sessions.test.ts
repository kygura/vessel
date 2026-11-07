import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome } from "./core/types.ts";
import { appendEvent, appendOutcome, createSession, getSession, listSessions, readEvents, readOutcomes } from "./sessions.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "vessel-")); process.env.VESSEL_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.VESSEL_HOME; });

const route = { adapter: "claude", model: "m", effort: "low" } as const;
const outcome = (sessionId: string, result: Outcome["result"], costUsd?: number): Outcome =>
  ({ sessionId, ts: "t", route, tier: "trivial", result, costUsd, latencyMs: 5 });

test("session round-trip: events, native id, outcome merge, prefix lookup, listing", () => {
  const a = createSession({ cwd: "/x", prompt: "p1", route, tier: "trivial" });
  appendEvent(a.id, { type: "session", id: "native-1" });
  appendEvent(a.id, { type: "text", text: "hi" });
  expect(readEvents(a.id).map((e) => e.event.type)).toEqual(["session", "text"]);
  expect(getSession(a.id)).toMatchObject({ prompt: "p1", nativeSessionId: "native-1", result: undefined });
  expect(getSession(a.id.slice(0, 4))?.id).toBe(a.id);
  expect(getSession("nope")).toBeUndefined();

  appendOutcome(outcome(a.id, "unknown", 0.1));
  appendOutcome(outcome(a.id, "pass"));
  expect(readOutcomes()).toHaveLength(1);
  expect(getSession(a.id)).toMatchObject({ result: "pass" });

  const b = createSession({ cwd: "/x", prompt: "p2", route, tier: "hard" });
  expect(listSessions().map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  expect(listSessions().find((s) => s.id === a.id)).toMatchObject({ nativeSessionId: "native-1", result: "pass" });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, RouterEvent } from "./core/types.ts";
import { type RunOptions, type RunUpdate, rateSession, resumeTask, runTask } from "./run.ts";
import { getSession, listSessions, readEvents, readOutcomes } from "./sessions.ts";

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "router-"));
  cwd = mkdtempSync(join(tmpdir(), "router-cwd-"));
  process.env.ROUTER_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  delete process.env.ROUTER_HOME;
});

type Script = (n: number) => RouterEvent[] | Error;
const OK: RouterEvent[] = [{ type: "session", id: "native-1" }, { type: "text", text: "working" }, { type: "usage", costUsd: 0.5 }, { type: "done", ok: true, finalText: "ok" }];
const BOOT_FAIL: RouterEvent[] = [{ type: "error", message: "not logged in" }, { type: "done", ok: false }];

function fake(id: Adapter["id"], script: Script, resume = false): Adapter & { runs: number; resumed: string[] } {
  const a = {
    id, runs: 0, resumed: [] as string[],
    capabilities: { resume, cost: true, listModels: true },
    probe: async () => ({ available: true, models: [{ adapter: id, model: `${id}-m` }] }),
    async *run() {
      const r = script(a.runs++);
      if (r instanceof Error) throw r;
      yield* r;
    },
    async *resume(native: string) { a.resumed.push(native); yield* OK; },
  };
  return a as never;
}

const base = (adapters: Adapter[], o: RunOptions = {}): RunOptions => ({ adapters, cwd, tier: "trivial", llm: false, rng: () => 1, ...o });
async function collect(it: AsyncIterable<RunUpdate>) {
  const all: RunUpdate[] = [];
  for await (const u of it) all.push(u);
  return {
    all,
    phases: all.flatMap((u) => (u.type === "phase" ? [u.phase] : [])),
    last: all.findLast((u) => u.type === "phase") as Extract<RunUpdate, { type: "phase" }>,
    outcome: all.find((u) => u.type === "outcome")?.outcome,
  };
}

test("falls back to the next candidate on start failure (error events before any text)", async () => {
  const a = fake("claude", () => BOOT_FAIL);
  const b = fake("codex", () => OK);
  const r = await collect(runTask("do it", base([a, b])));
  expect(r.all.filter((u) => u.type === "fallback")).toHaveLength(1);
  expect(r.phases).toEqual(["classifying", "ranked", "running", "done"]);
  expect(r.outcome?.route.adapter).toBe("codex");
  expect(r.outcome?.costUsd).toBe(0.5);
  const s = listSessions()[0]!;
  expect(s.route.adapter).toBe("codex");
  expect(readEvents(s.id).some((e) => e.event.type === "error" && e.event.message.includes("falling back"))).toBe(true);
});

test("falls back when the adapter throws on spawn; fails when every route fails", async () => {
  const a = fake("claude", () => new Error("ENOENT"));
  const b = fake("codex", () => BOOT_FAIL);
  const r = await collect(runTask("do it", base([a, b])));
  expect(r.last.phase).toBe("failed");
  expect(r.last.message).toContain("not logged in");
  expect(a.runs).toBe(1);
  expect(b.runs).toBe(1);
  expect(r.outcome).toBeUndefined();
});

test("no fallback once the agent produced output, even if it then fails", async () => {
  const a = fake("claude", () => [{ type: "text", text: "starting" }, { type: "error", message: "boom" }, { type: "done", ok: false }]);
  const b = fake("codex", () => OK);
  const r = await collect(runTask("do it", base([a, b])));
  expect(b.runs).toBe(0);
  expect(r.outcome).toMatchObject({ result: "unknown", route: { adapter: "claude" } });
});

test("verify command decides pass/fail; agent success alone is unknown", async () => {
  const mk = () => fake("claude", () => OK);
  const pass = await collect(runTask("t", base([mk()], { verify: "true" })));
  expect(pass.outcome?.result).toBe("pass");
  expect(pass.phases).toContain("verifying");
  expect(pass.last.phase).toBe("done");

  const bad = await collect(runTask("t", base([mk()], { verify: "echo nope; exit 3" })));
  expect(bad.outcome?.result).toBe("fail");
  expect(bad.last.phase).toBe("failed");
  expect(bad.all.find((u) => u.type === "verify")).toMatchObject({ exitCode: 3, output: "nope" });

  const none = await collect(runTask("t", base([mk()])));
  expect(none.outcome?.result).toBe("unknown");
  expect(none.phases).not.toContain("verifying");
});

test(".router.json verify is used when --verify is absent", async () => {
  writeFileSync(join(cwd, ".router.json"), JSON.stringify({ verify: "false" }));
  const r = await collect(runTask("t", base([fake("claude", () => OK)])));
  expect(r.outcome?.result).toBe("fail");
});

test("dry-run stops after ranked: no session, no run, no outcome", async () => {
  const a = fake("claude", () => OK);
  const r = await collect(runTask("t", base([a], { dryRun: true })));
  expect(r.phases).toEqual(["classifying", "ranked", "done"]);
  expect(r.all.some((u) => u.type === "ranked")).toBe(true);
  expect(a.runs).toBe(0);
  expect(listSessions()).toHaveLength(0);
  expect(readOutcomes()).toHaveLength(0);
});

test("classification: --tier overrides, heuristic classifies otherwise; pins that match nothing fail", async () => {
  const a = fake("claude", () => OK);
  const t = await collect(runTask("rename foo to bar in utils.ts", base([a], { dryRun: true, tier: undefined })));
  expect(t.all.find((u) => u.type === "classification")).toMatchObject({ source: "heuristic", classification: { tier: "trivial" } });
  const o = await collect(runTask("x", base([a], { dryRun: true, tier: "hard" })));
  expect(o.all.find((u) => u.type === "classification")).toMatchObject({ source: "override", classification: { tier: "hard" } });
  const p = await collect(runTask("x", base([a], { dryRun: true, adapter: "droid" })));
  expect(p.last.phase).toBe("failed");
});

test("outcome is recorded and session stores the native id; rate supersedes; resume reuses native id", async () => {
  const a = fake("claude", () => OK, true);
  const r = await collect(runTask("t", base([a])));
  const id = r.all.find((u) => u.type === "started")!.sessionId;
  expect(readOutcomes()).toHaveLength(1);
  expect(getSession(id)).toMatchObject({ nativeSessionId: "native-1", result: "unknown", costUsd: 0.5 });

  rateSession(id, "pass");
  expect(readOutcomes()).toHaveLength(1);
  expect(getSession(id)).toMatchObject({ result: "pass", costUsd: 0.5 });

  const res = await collect(resumeTask(id, "more", { adapters: [a] }));
  expect(a.resumed).toEqual(["native-1"]);
  expect(res.last.phase).toBe("done");
});

test("resume reports unsupported adapters", async () => {
  const a = fake("claude", () => OK, false);
  const r = await collect(runTask("t", base([a])));
  const id = r.all.find((u) => u.type === "started")!.sessionId;
  const res = await collect(resumeTask(id, "more", { adapters: [a] }));
  expect(res.last).toMatchObject({ phase: "failed", message: expect.stringContaining("unsupported") });
});

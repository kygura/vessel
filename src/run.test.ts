import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, RouterEvent } from "./core/types.ts";
import { type RunOptions, type RunUpdate, rateSession, resumeTask, runTask, trustProject } from "./run.ts";
import { getSession, listSessions, readEvents, readOutcomes } from "./sessions.ts";

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vessel-"));
  cwd = mkdtempSync(join(tmpdir(), "vessel-cwd-"));
  process.env.VESSEL_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  delete process.env.VESSEL_HOME;
});

type Script = (n: number) => RouterEvent[] | Error;
const OK: RouterEvent[] = [{ type: "session", id: "native-1" }, { type: "text", text: "working" }, { type: "usage", costUsd: 0.5 }, { type: "done", ok: true, finalText: "ok" }];
const BOOT_FAIL: RouterEvent[] = [{ type: "error", message: "not logged in" }, { type: "done", ok: false }];

function fake(id: Adapter["id"], script: Script, resume = false): Adapter & { runs: number; resumed: string[]; autonomy: string[] } {
  const a = {
    id, runs: 0, resumed: [] as string[], autonomy: [] as string[],
    capabilities: { listModels: true },
    probe: async () => ({ available: true, models: [{ adapter: id, model: `${id}-m` }] }),
    async *run() {
      const r = script(a.runs++);
      if (r instanceof Error) throw r;
      yield* r;
    },
  };
  if (resume) Object.assign(a, { async *resume(native: string, req: { autonomy: string }) { a.resumed.push(native); a.autonomy.push(req.autonomy); yield* OK; } });
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
  expect(r.all.filter((u) => u.type === "event" && u.event.type === "error" && u.event.message === "fallback: not logged in -> codex/codex-m")).toHaveLength(1);
  expect(r.phases).toEqual(["classifying", "ranked", "running", "done"]);
  expect(r.outcome?.route.adapter).toBe("codex");
  expect(r.outcome?.costUsd).toBe(0.5);
  const s = listSessions()[0]!;
  expect(s.route.adapter).toBe("codex");
  expect(readEvents(s.id).some((e) => e.event.type === "error" && e.event.message.startsWith("fallback:"))).toBe(true);
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
  // all-fail: no per-route outcomes, just one `unknown` for the last tried route so the session can be rated
  expect(readOutcomes()).toMatchObject([{ result: "unknown", route: { adapter: "codex" }, startFailed: true }]);
  expect(rateSession(listSessions()[0]!.id, "fail").result).toBe("fail");
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

test(".vessel.json verify runs only once trusted; untrusted stays unknown with a notice", async () => {
  writeFileSync(join(cwd, ".vessel.json"), JSON.stringify({ verify: "false" }));
  const untrusted = await collect(runTask("t", base([fake("claude", () => OK)])));
  expect(untrusted.outcome?.result).toBe("unknown");
  expect(untrusted.phases).not.toContain("verifying");
  expect(untrusted.all.some((u) => u.type === "notice" && u.message.includes("vessel trust"))).toBe(true);

  expect(trustProject(cwd)).toEqual({ command: "false" });
  const trusted = await collect(runTask("t", base([fake("claude", () => OK)])));
  expect(trusted.outcome?.result).toBe("fail");

  // editing the command invalidates trust; explicit --verify is always honored
  writeFileSync(join(cwd, ".vessel.json"), JSON.stringify({ verify: "true" }));
  expect((await collect(runTask("t", base([fake("claude", () => OK)])))).outcome?.result).toBe("unknown");
  expect((await collect(runTask("t", base([fake("claude", () => OK)], { verify: "true" })))).outcome?.result).toBe("pass");
});

test("abort during the run or during verify fails with 'aborted' and records no outcome", async () => {
  for (const [verify, trigger] of [[undefined, "text"], ["sleep 30", "verifying"]] as const) {
    const ac = new AbortController();
    const all: RunUpdate[] = [];
    for await (const u of runTask("t", base([fake("claude", () => OK)], { verify, signal: ac.signal }))) {
      all.push(u);
      if ((u.type === "event" && u.event.type === trigger) || (u.type === "phase" && u.phase === trigger)) ac.abort();
    }
    expect(all.at(-1)).toMatchObject({ type: "phase", phase: "failed", message: "aborted" });
    expect(all.some((u) => u.type === "outcome")).toBe(false);
  }
  expect(readOutcomes()).toHaveLength(0);
});

test("start-failure fallbacks are capped at 3 (4 attempts)", async () => {
  const all = (["claude", "codex", "opencode", "pi", "droid"] as const).map((id) => fake(id, () => BOOT_FAIL));
  const r = await collect(runTask("t", base(all)));
  expect(r.all.filter((u) => u.type === "event" && u.event.type === "error" && u.event.message.startsWith("fallback:"))).toHaveLength(3);
  expect(all.map((a) => a.runs)).toEqual([1, 1, 1, 1, 0]);
  expect(r.last.phase).toBe("failed");
});

test("native session id comes only from the final route; rate refuses without an outcome", async () => {
  const a = fake("claude", () => [{ type: "session", id: "stale" }, { type: "error", message: "auth" }, { type: "done", ok: false }]);
  const b = fake("codex", () => [{ type: "text", text: "hi" }, { type: "done", ok: true }]);
  const r = await collect(runTask("t", base([a, b])));
  expect(getSession(r.all.find((u) => u.type === "started")!.sessionId)?.nativeSessionId).toBeUndefined();

  const ac = new AbortController();
  let id = "";
  for await (const u of runTask("t", base([fake("claude", () => OK)], { signal: ac.signal }))) {
    if (u.type === "started") id = u.sessionId;
    if (u.type === "event" && u.event.type === "text") ac.abort();
  }
  expect(() => rateSession(id, "pass")).toThrow("no outcome");
});

test("edit-mode notice for non-codex adapters only", async () => {
  const notices = async (id: Adapter["id"], autonomy: "edit" | "read") =>
    (await collect(runTask("t", base([fake(id, () => OK)], { autonomy })))).all.filter((u) => u.type === "notice");
  expect(await notices("claude", "edit")).toEqual([{ type: "notice", message: expect.stringContaining("no OS sandbox") }]);
  expect(await notices("codex", "edit")).toHaveLength(0);
  expect(await notices("claude", "read")).toHaveLength(0);
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
  // rated result survives a resume without verify; cost sums
  expect(res.outcome).toMatchObject({ result: "pass", costUsd: 1 });
  expect(res.outcome!.latencyMs).toBeGreaterThanOrEqual(readOutcomes()[0]!.latencyMs - 1);

  // a verify that re-runs on resume wins
  const again = await collect(resumeTask(id, "more", { adapters: [a], verify: "false" }));
  expect(again.outcome).toMatchObject({ result: "fail", costUsd: 1.5 });
});

test("resume reuses stored autonomy but never escalates to full without the flag", async () => {
  const a = fake("claude", () => OK, true);
  const mk = async (autonomy: "read" | "full") => {
    const r = await collect(runTask("t", base([a], { autonomy })));
    return r.all.find((u) => u.type === "started")!.sessionId;
  };
  await collect(resumeTask(await mk("read"), "p", { adapters: [a] }));
  await collect(resumeTask(await mk("full"), "p", { adapters: [a] }));
  const full = await mk("full");
  await collect(resumeTask(full, "p", { adapters: [a], autonomy: "full" }));
  expect(a.autonomy).toEqual(["read", "edit", "full"]);
});

test("resume reports unsupported adapters", async () => {
  const a = fake("claude", () => OK, false);
  const r = await collect(runTask("t", base([a])));
  const id = r.all.find((u) => u.type === "started")!.sessionId;
  const res = await collect(resumeTask(id, "more", { adapters: [a] }));
  expect(res.last).toMatchObject({ phase: "failed", message: expect.stringContaining("unsupported") });
});

test("routing decision is persisted on the session with top-5 candidates", async () => {
  const r = await collect(runTask("rename a to b in x.ts", base([fake("claude", () => OK)], { tier: undefined })));
  const s = getSession(r.all.find((u) => u.type === "started")!.sessionId)!;
  expect(s.decision).toMatchObject({ tier: "trivial", source: "heuristic", candidates: [{ adapter: "claude", model: "claude-m" }] });
  expect(s.decision!.candidates.length).toBeLessThanOrEqual(5);
});

test("abort before the session exists (during classification) creates no session", async () => {
  const ac = new AbortController();
  const llm = async () => { ac.abort(); throw new Error("aborted"); };
  const r = await collect(runTask("do something somewhat ambiguous", base([fake("claude", () => OK)], { tier: undefined, llm, signal: ac.signal })));
  expect(r.last).toMatchObject({ phase: "failed", message: "aborted" });
  expect(listSessions()).toHaveLength(0);
});

test("asking the classifier is announced; verifying carries the command", async () => {
  const llm = async () => ({ tier: "hard" as const, reasons: ["x"] });
  const r = await collect(runTask("do something somewhat ambiguous here", base([fake("claude", () => OK)], { tier: undefined, llm, verify: "true" })));
  expect(r.all.some((u) => u.type === "phase" && u.message === "asking classifier...")).toBe(true);
  expect(r.all.find((u) => u.type === "classification")).toMatchObject({ source: "llm" });
  expect(r.all.some((u) => u.type === "phase" && u.phase === "verifying" && u.message === "true")).toBe(true);
});

test("malformed .vessel.json yields a notice instead of silently running nothing", async () => {
  writeFileSync(join(cwd, ".vessel.json"), "{ nope");
  const r = await collect(runTask("t", base([fake("claude", () => OK)])));
  expect(r.all.some((u) => u.type === "notice" && u.message.startsWith("ignored .vessel.json:"))).toBe(true);
  expect(r.outcome?.result).toBe("unknown");
  writeFileSync(join(cwd, ".vessel.json"), JSON.stringify({ verify: 3 }));
  const r2 = await collect(runTask("t", base([fake("claude", () => OK)])));
  expect(r2.all.some((u) => u.type === "notice" && u.message.startsWith("ignored .vessel.json:"))).toBe(true);
});

test("abort right after ranked creates no session", async () => {
  const ac = new AbortController();
  const all: RunUpdate[] = [];
  for await (const u of runTask("t", base([fake("claude", () => OK)], { signal: ac.signal }))) {
    all.push(u);
    if (u.type === "ranked") ac.abort();
  }
  expect(all.at(-1)).toMatchObject({ phase: "failed", message: "aborted" });
  expect(all.some((u) => u.type === "started")).toBe(false);
  expect(listSessions()).toHaveLength(0);
});

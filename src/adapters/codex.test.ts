import { describe, expect, test } from "bun:test";
import type { RouterEvent, RunRequest } from "../core/types.ts";
import { RouterEvent as RouterEventSchema } from "../core/types.ts";
import { lineEvents, streamCli } from "./common.ts";
import { buildArgv, parseCodexLine } from "./codex.ts";

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const collect = async (it: AsyncIterable<RouterEvent>) => {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const replay = (file: string, exit = 0) =>
  collect(streamCli(["sh", "-c", `cat ${fx(file)}; exit ${exit}`], {}, parseCodexLine));
const req = (autonomy: RunRequest["autonomy"]): RunRequest => ({
  prompt: "do it", cwd: "/w", model: "gpt-5.5", effort: "high", autonomy,
});
const done = (evs: RouterEvent[]) => evs.filter((e) => e.type === "done");

describe("codex adapter", () => {
  test("unknown / junk json yields no events", () => {
    expect(parseCodexLine({ type: "nope" })).toEqual([]);
    expect(parseCodexLine(null)).toEqual([]);
    expect(parseCodexLine("str")).toEqual([]);
  });

  test("malformed line becomes one error event", () => {
    const evs = lineEvents({ raw: "not json" }, parseCodexLine);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("error");
  });

  test("fixture maps to normalized events, finalText = last agent_message", async () => {
    const evs = await replay("codex.jsonl");
    expect(evs).toEqual([
      { type: "session", id: "th-1" },
      { type: "tool", name: "command_execution", status: "started", input: "ls" },
      { type: "tool", name: "command_execution", status: "completed", input: "ls", output: "a.txt" },
      { type: "text", text: "first" },
      { type: "text", text: "final answer" },
      { type: "usage", inputTokens: 7, outputTokens: 3 },
      { type: "done", ok: true, finalText: "final answer" },
    ]);
    for (const e of evs) RouterEventSchema.parse(e);
  });

  test("turn.failed -> error + failed done", async () => {
    const evs = await replay("codex-failed.jsonl");
    expect(evs.map((e) => e.type)).toEqual(["session", "error", "done"]);
    expect(done(evs)[0]).toMatchObject({ ok: false });
  });

  test("done synthesized from exit code with last text", async () => {
    expect(done(await replay("codex-nodone.jsonl"))).toEqual([{ type: "done", ok: true, finalText: "last words" }]);
    const bad = await replay("codex-nodone.jsonl", 2);
    expect(done(bad)).toEqual([{ type: "done", ok: false, finalText: "last words" }]);
    expect(bad.some((e) => e.type === "error")).toBe(true);
  });

  test("argv per autonomy", () => {
    const a = (x: RunRequest["autonomy"]) => buildArgv(req(x));
    expect(a("read")).toEqual(expect.arrayContaining(["-s", "read-only"]));
    expect(a("edit")).toEqual(expect.arrayContaining(["-s", "workspace-write"]));
    expect(a("full")).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(a("full")).not.toContain("-s");
    expect(a("edit")).toEqual(expect.arrayContaining(["-C", "/w", "--skip-git-repo-check", "-m", "gpt-5.5", "--json"]));
    expect(a("edit")).toContain('model_reasoning_effort="high"');
    expect(a("edit").slice(0, 2)).toEqual(["codex", "exec"]);
    expect(a("edit").at(-1)).toBe("do it");
    expect(buildArgv(req("edit"), "th-1").slice(-3)).toEqual(["resume", "th-1", "do it"]);
  });
});

describe("streamCli error handling", () => {
  test("an error event before a successful done forces done.ok=false", async () => {
    const parse = (j: unknown): RouterEvent[] =>
      (j as any).t === "e" ? [{ type: "error", message: "x" }] : [{ type: "done", ok: true }];
    const evs = await collect(streamCli(["sh", "-c", `echo '{"t":"e"}'; echo '{"t":"d"}'`], {}, parse));
    expect(done(evs)).toEqual([{ type: "done", ok: false, finalText: undefined }]);
  });
});

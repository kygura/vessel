import { describe, expect, test } from "bun:test";
import type { RouterEvent, RunRequest } from "../core/types.ts";
import { RouterEvent as RouterEventSchema } from "../core/types.ts";
import { lineEvents, streamCli } from "./common.ts";
import { buildArgv, parseClaudeLine } from "./claude.ts";

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const collect = async (it: AsyncIterable<RouterEvent>) => {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const replay = (file: string, exit = 0) =>
  collect(streamCli(["sh", "-c", `cat ${fx(file)}; exit ${exit}`], {}, parseClaudeLine));
const req = (autonomy: RunRequest["autonomy"]): RunRequest => ({
  prompt: "do it", cwd: "/w", model: "sonnet", effort: "high", autonomy,
});
const done = (evs: RouterEvent[]) => evs.filter((e) => e.type === "done");

describe("claude adapter", () => {
  test("unknown / junk json yields no events", () => {
    expect(parseClaudeLine({ type: "nope" })).toEqual([]);
    expect(parseClaudeLine(null)).toEqual([]);
    expect(parseClaudeLine("str")).toEqual([]);
  });

  test("malformed line becomes one error event", () => {
    const evs = lineEvents({ raw: "not json" }, parseClaudeLine);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("error");
  });

  test("fixture maps to normalized events", async () => {
    const evs = await replay("claude.jsonl");
    expect(evs).toEqual([
      { type: "session", id: "s-1" },
      { type: "text", text: "Creating file" },
      { type: "tool", name: "Write", status: "started", input: '{"file_path":"hello.txt"}' },
      { type: "tool", name: "tool_result", status: "completed", output: "ok" },
      { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      { type: "done", ok: true, finalText: "Done" },
    ]);
    for (const e of evs) RouterEventSchema.parse(e);
  });

  test("error result gives error then failed done", async () => {
    const evs = await replay("claude-error.jsonl");
    expect(evs.map((e) => e.type)).toEqual(["session", "usage", "error", "done"]);
    expect(done(evs)[0]).toMatchObject({ ok: false });
  });

  test("done synthesized from exit code when CLI sent none", async () => {
    const evs = await replay("claude.jsonl", 0);
    expect(done(evs)).toHaveLength(1);
    const dead = await collect(streamCli(["sh", "-c", "echo oops >&2; exit 3"], {}, parseClaudeLine));
    expect(dead.map((e) => e.type)).toEqual(["error", "done"]);
    expect(done(dead)[0]).toMatchObject({ ok: false });
  });

  test("argv per autonomy", () => {
    const a = (x: RunRequest["autonomy"]) => buildArgv(req(x));
    expect(a("read")).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(a("edit")).toEqual(expect.arrayContaining(["acceptEdits", "--allowedTools", "Read Edit Write Bash Glob Grep"]));
    expect(a("full")).toContain("--dangerously-skip-permissions");
    expect(a("edit")).not.toContain("--dangerously-skip-permissions");
    expect(a("edit")).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "high"]));
    expect(buildArgv(req("edit"), "abc").slice(-2)).toEqual(["-r", "abc"]);
  });
});

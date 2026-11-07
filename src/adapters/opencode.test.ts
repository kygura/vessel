import { describe, expect, test } from "bun:test";
import type { RouterEvent, RunRequest } from "../core/types.ts";
import { RouterEvent as RouterEventSchema } from "../core/types.ts";
import { lineEvents, streamCli } from "./common.ts";
import { buildArgv, buildEnv, parseOpencodeLine } from "./opencode.ts";

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const collect = async (it: AsyncIterable<RouterEvent>) => {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const replay = (file: string, exit = 0) =>
  collect(streamCli(["sh", "-c", `cat ${fx(file)}; exit ${exit}`], {}, parseOpencodeLine));
const req = (autonomy: RunRequest["autonomy"]): RunRequest => ({
  prompt: "do it", cwd: "/w", model: "anthropic/claude-sonnet-5", effort: "high", autonomy,
});
const done = (evs: RouterEvent[]) => evs.filter((e) => e.type === "done");

describe("opencode adapter", () => {
  test("unknown / junk json yields no events", () => {
    expect(parseOpencodeLine({ type: "nope" })).toEqual([]);
    expect(parseOpencodeLine(null)).toEqual([]);
    expect(parseOpencodeLine("str")).toEqual([]);
  });

  test("malformed line becomes one error event", () => {
    const evs = lineEvents({ raw: "not json" }, parseOpencodeLine);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("error");
  });

  test("fixture maps to normalized events, session deduped", async () => {
    const evs = await replay("opencode.jsonl");
    expect(evs).toEqual([
      { type: "session", id: "ses_1" },
      { type: "tool", name: "bash", status: "completed", input: '{"command":"ls"}', output: "a.txt" },
      { type: "text", text: "all done" },
      { type: "usage", inputTokens: 9, outputTokens: 4, costUsd: 0.01 },
      { type: "done", ok: true, finalText: "all done" },
    ]);
    for (const e of evs) RouterEventSchema.parse(e);
  });

  test("done synthesized from exit code", async () => {
    const bad = await replay("opencode-error.jsonl", 1);
    expect(bad.map((e) => e.type)).toEqual(["session", "error", "error", "done"]);
    expect(done(bad)[0]).toMatchObject({ ok: false });
  });

  test("argv per autonomy", () => {
    const a = (x: RunRequest["autonomy"]) => buildArgv(req(x));
    expect(a("read")).not.toContain("--auto");
    expect(a("read")).not.toContain("--dangerously-skip-permissions");
    expect(a("edit")).toContain("--auto");
    expect(a("full")).toContain("--dangerously-skip-permissions");
    expect(a("full")).not.toContain("--auto");
    expect(a("edit")).toEqual(expect.arrayContaining(["--format", "json", "-m", "anthropic/claude-sonnet-5#high"]));
    expect(buildArgv(req("edit"), "ses_9")).toEqual(expect.arrayContaining(["-s", "ses_9"]));
  });

  test("prompt is a positional after --, even if it looks like a flag", () => {
    const argv = buildArgv({ ...req("edit"), prompt: "--dangerously-skip-permissions" });
    expect(argv.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
    expect(argv.indexOf("--dangerously-skip-permissions")).toBe(argv.length - 1);
  });

  test("read autonomy injects deny config; edit does not", () => {
    expect(JSON.parse(buildEnv(req("read")).OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { edit: "deny", bash: "deny" } });
    expect(buildEnv(req("read")).PWD).toBe("/w");
    expect(buildEnv(req("edit")).OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("error line with exit 0 still yields done.ok=false", async () => {
    const evs = await replay("opencode-error.jsonl", 0);
    expect(done(evs)[0]).toMatchObject({ ok: false });
  });

  test("abort mid-stream ends with a failed done", async () => {
    const ac = new AbortController();
    const evs: RouterEvent[] = [];
    const it = streamCli(["sh", "-c", `head -n 1 ${fx("opencode.jsonl")}; sleep 30`], { signal: ac.signal }, parseOpencodeLine);
    for await (const e of it) {
      evs.push(e);
      if (evs.length === 1) ac.abort();
    }
    expect(done(evs)).toHaveLength(1);
    expect(done(evs)[0]).toMatchObject({ ok: false });
  }, 10_000);

});

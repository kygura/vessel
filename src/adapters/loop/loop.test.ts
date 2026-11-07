import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RouterEvent, RunRequest } from "../../core/types.ts";
import { complete, createLoopAdapter, loopAdapter } from "./index.ts";
import { guardPath, runTool, toolsFor } from "./tools.ts";

const KEY = "sk-test-secret-123";
type Captured = { path: string; headers: Headers; body: any };
let captured: Captured[] = [];
let script: ((body: any) => Response)[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.json();
    captured.push({ path: new URL(req.url).pathname, headers: req.headers, body });
    const next = script.shift();
    return next ? next(body) : new Response("no script", { status: 500 });
  },
});
afterAll(() => server.stop(true));

let home: string;
let work: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loop-home-"));
  process.env.ROUTER_HOME = home;
  process.env.LOOP_TEST_KEY = KEY;
  const base = `http://localhost:${server.port}`;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        ant: { kind: "anthropic", baseUrl: base, apiKeyEnv: "LOOP_TEST_KEY", models: ["claude-x"] },
        oai: { kind: "openai", baseUrl: `${base}/v1/`, apiKeyEnv: "LOOP_TEST_KEY", models: ["gpt-x"] },
        nokey: { kind: "openai", baseUrl: base, apiKeyEnv: "LOOP_TEST_UNSET_KEY", models: ["m"] },
      },
    }),
  );
});
beforeEach(() => {
  captured = [];
  script = [];
  work = mkdtempSync(join(tmpdir(), "loop-work-"));
});

async function collect(it: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const req = (model: string, autonomy: RunRequest["autonomy"] = "edit"): RunRequest => ({
  prompt: "create hello.txt containing hi",
  cwd: work,
  model,
  effort: "medium",
  autonomy,
});

describe("wire formats end to end", () => {
  test("anthropic: tool_use -> tool_result -> done", async () => {
    script = [
      () =>
        Response.json({
          content: [
            { type: "text", text: "Writing." },
            { type: "tool_use", id: "tu1", name: "write_file", input: { path: "hello.txt", content: "hi" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      () => Response.json({ content: [{ type: "text", text: "Done." }], usage: { input_tokens: 20, output_tokens: 2 } }),
    ];
    const ev = await collect(loopAdapter.run(req("ant/claude-x"), new AbortController().signal));
    expect(readFileSync(join(work, "hello.txt"), "utf8")).toBe("hi");
    expect(ev.at(-1)).toEqual({ type: "done", ok: true, finalText: "Done." });
    expect(ev.filter((e) => e.type === "tool").map((e) => (e as any).status)).toEqual(["started", "completed"]);
    expect(ev.filter((e) => e.type === "usage")).toHaveLength(2);
    expect(captured[0]!.path).toBe("/v1/messages");
    expect(captured[0]!.headers.get("x-api-key")).toBe(KEY);
    expect(captured[0]!.body.tools.map((t: any) => t.name)).toEqual(["read_file", "write_file", "edit_file", "bash"]);
    const result = captured[1]!.body.messages[2];
    expect(result.role).toBe("user");
    expect(result.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1", is_error: false });
  });

  test("openai: tool_calls -> tool message -> done", async () => {
    script = [
      () =>
        Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"hello.txt","content":"hi"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      () => Response.json({ choices: [{ message: { content: "All done." } }] }),
    ];
    const ev = await collect(loopAdapter.run(req("oai/gpt-x"), new AbortController().signal));
    expect(readFileSync(join(work, "hello.txt"), "utf8")).toBe("hi");
    expect(ev.at(-1)).toEqual({ type: "done", ok: true, finalText: "All done." });
    expect(ev).toContainEqual({ type: "usage", inputTokens: 7, outputTokens: 3 });
    expect(captured[0]!.path).toBe("/v1/chat/completions");
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(captured[0]!.body.messages[0].role).toBe("system");
    const msgs = captured[1]!.body.messages;
    expect(msgs[2].tool_calls[0].id).toBe("c1");
    expect(msgs[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  test("non-2xx -> error event with status and snippet, key redacted", async () => {
    script = [() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 })];
    const ev = await collect(loopAdapter.run(req("oai/gpt-x"), new AbortController().signal));
    const err = ev.find((e) => e.type === "error") as { message: string };
    expect(err.message).toContain("401");
    expect(err.message).toContain("bad key");
    expect(err.message).not.toContain(KEY);
    expect(ev.at(-1)).toMatchObject({ type: "done", ok: false });
  });

  test("turn cap stops a looping model", async () => {
    const toolTurn = () =>
      Response.json({ content: [{ type: "tool_use", id: "t", name: "read_file", input: { path: "nope" } }] });
    script = [toolTurn, toolTurn, toolTurn];
    const ev = await collect(createLoopAdapter({ maxTurns: 2 }).run(req("ant/claude-x"), new AbortController().signal));
    expect(captured).toHaveLength(2);
    expect(ev).toContainEqual({ type: "error", message: "turn cap of 2 reached" });
  });

  test("aborted signal stops before calling the model", async () => {
    const ac = new AbortController();
    ac.abort();
    const ev = await collect(loopAdapter.run(req("ant/claude-x"), ac.signal));
    expect(captured).toHaveLength(0);
    expect(ev.at(-1)).toMatchObject({ type: "done", ok: false });
  });

  test("read autonomy: only read_file sent, write call rejected", async () => {
    script = [
      () => Response.json({ content: [{ type: "tool_use", id: "t", name: "write_file", input: { path: "x", content: "y" } }] }),
      () => Response.json({ content: [{ type: "text", text: "ok" }] }),
    ];
    await collect(loopAdapter.run(req("ant/claude-x", "read"), new AbortController().signal));
    expect(captured[0]!.body.tools.map((t: any) => t.name)).toEqual(["read_file"]);
    expect(existsSync(join(work, "x"))).toBe(false);
    expect(captured[1]!.body.messages[2].content[0].is_error).toBe(true);
  });

  test("complete() with schema parses JSON reply", async () => {
    script = [() => Response.json({ content: [{ type: "text", text: 'Sure: {"tier":"hard"}' }] })];
    expect(await complete("ant", "claude-x", "classify", z.object({ tier: z.string() }))).toEqual({ tier: "hard" });
    expect(captured[0]!.body.tools).toBeUndefined();
  });
});

describe("probe", () => {
  test("lists models for providers with key set", async () => {
    const p = await loopAdapter.probe();
    expect(p.available).toBe(true);
    expect(p.models.map((m) => m.model)).toEqual(["ant/claude-x", "oai/gpt-x"]);
  });
});

describe("path guard", () => {
  test("rejects .., absolute outside, symlink escape (existing and dangling)", () => {
    const outside = mkdtempSync(join(tmpdir(), "loop-out-"));
    symlinkSync(outside, join(work, "link"));
    symlinkSync(join(outside, "missing"), join(work, "dangling"));
    for (const p of ["../x", "a/../../x", "/etc/passwd", outside, "link/x", "link", "dangling", "\0"])
      expect(() => guardPath(work, p)).toThrow();
    expect(guardPath(work, "a/b/new.txt")).toBe(join(realpathSync(work), "a/b/new.txt"));
    expect(guardPath(work, join(work, "f"))).toBe(join(realpathSync(work), "f"));
  });

  test("write_file through symlink escape is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "loop-out-"));
    symlinkSync(outside, join(work, "link"));
    const r = await runTool("write_file", { path: "link/pwn", content: "x" }, "edit", { cwd: work });
    expect(r.isError).toBe(true);
    expect(existsSync(join(outside, "pwn"))).toBe(false);
  });
});

describe("tools", () => {
  test("edit_file requires exactly one match", async () => {
    writeFileSync(join(work, "f.txt"), "a b a");
    expect((await runTool("edit_file", { path: "f.txt", old_string: "zzz", new_string: "q" }, "edit", { cwd: work })).output).toContain("found 0");
    expect((await runTool("edit_file", { path: "f.txt", old_string: "a", new_string: "q" }, "edit", { cwd: work })).output).toContain("found 2");
    const ok = await runTool("edit_file", { path: "f.txt", old_string: "b", new_string: "$&" }, "edit", { cwd: work });
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(work, "f.txt"), "utf8")).toBe("a $& a");
  });

  test("read autonomy exposes only read_file", async () => {
    expect(toolsFor("read").map((t) => t.name)).toEqual(["read_file"]);
    expect((await runTool("bash", { command: "touch x" }, "read", { cwd: work })).isError).toBe(true);
    expect(existsSync(join(work, "x"))).toBe(false);
  });

  test("bash runs in cwd, hides key env, rejects bad args", async () => {
    mkdirSync(join(work, "sub"));
    const r = await runTool("bash", { command: 'ls; echo "k=$LOOP_TEST_KEY"' }, "edit", { cwd: work, hiddenEnv: ["LOOP_TEST_KEY"] });
    expect(r.output).toContain("sub");
    expect(r.output).toContain("k=\n");
    expect((await runTool("bash", {}, "edit", { cwd: work })).isError).toBe(true);
  });
});

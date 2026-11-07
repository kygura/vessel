import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RouterEvent, RunRequest } from "../../core/types.ts";
import { complete, createLoopAdapter, loopAdapter, providerProblem } from "./index.ts";
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

describe("provider validation", () => {
  const p = (baseUrl: string, apiKeyEnv = "OK_KEY") => ({ kind: "openai" as const, baseUrl, apiKeyEnv, models: [] });
  test("baseUrl must be https or loopback http; apiKeyEnv must be an env name", () => {
    for (const u of ["https://api.x.com", "http://localhost:1", "http://127.0.0.1", "http://[::1]:8080"])
      expect(providerProblem("n", p(u))).toBeUndefined();
    for (const u of ["http://api.x.com", "http://localhost.evil.com", "ftp://localhost", "nope", "https://u:pw@api.x.com"])
      expect(providerProblem("n", p(u))).toBeDefined();
    const bad = providerProblem("n", p("https://a.b", "sk-raw-value"));
    expect(bad).toBeDefined();
    expect(bad).not.toContain("sk-raw-value");
  });

  test("redirect is an error, not followed", async () => {
    script = [() => new Response(null, { status: 307, headers: { location: "http://example.invalid/" } })];
    const ev = await collect(loopAdapter.run(req("oai/gpt-x"), new AbortController().signal));
    expect(ev.find((e) => e.type === "error")).toBeDefined();
    expect(captured).toHaveLength(1);
  });

  test("key redacted in invalid-JSON error", async () => {
    script = [() => new Response(`not json ${KEY}`, { status: 200 })];
    const ev = await collect(loopAdapter.run(req("ant/claude-x"), new AbortController().signal));
    const err = ev.find((e) => e.type === "error") as { message: string };
    expect(err.message).toContain("invalid JSON");
    expect(err.message).not.toContain(KEY);
  });

  test("tool output events never carry the key", async () => {
    writeFileSync(join(work, "k.txt"), KEY);
    script = [
      () => Response.json({ content: [{ type: "tool_use", id: "t", name: "read_file", input: { path: "k.txt" } }] }),
      () => Response.json({ content: [{ type: "text", text: "done" }] }),
    ];
    const ev = await collect(loopAdapter.run(req("ant/claude-x"), new AbortController().signal));
    expect(JSON.stringify(ev)).not.toContain(KEY);
    expect(JSON.stringify(captured[1]!.body)).not.toContain(KEY);
  });
});

test("complete() honours its abort signal", async () => {
  script = [() => new Response(new ReadableStream({ start() {} }))]; // never finishes
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await expect(complete("ant", "claude-x", "x", z.object({}), { signal: ac.signal })).rejects.toThrow();
});

test("bash timeout/abort goes through runCapture (abort reports killed)", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await runTool("bash", { command: "sleep 30" }, "edit", { cwd: work, signal: ac.signal });
  expect(r).toMatchObject({ isError: true, output: expect.stringContaining("killed: aborted") });
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

  test("bash runs in cwd with allowlisted env only, rejects bad args", async () => {
    mkdirSync(join(work, "sub"));
    process.env.LOOP_TEST_OTHER = "other-env";
    const r = await runTool("bash", { command: 'ls; echo "k=$LOOP_TEST_KEY o=$LOOP_TEST_OTHER"; env | cut -d= -f1 | sort | tr "\\n" " "' }, "edit", { cwd: work });
    expect(r.output).toContain("sub");
    expect(r.output).toContain("k= o=\n");
    const names = r.output.trim().split("\n").at(-1)!.trim().split(" ");
    const allowed = ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "USER", "SHELL", "PWD", "SHLVL", "_", "OLDPWD"];
    expect(names.filter((n) => !allowed.includes(n))).toEqual([]);
    expect((await runTool("bash", {}, "edit", { cwd: work })).isError).toBe(true);
  });

  test("write_file/edit_file under .git/ denied", async () => {
    mkdirSync(join(work, ".git/hooks"), { recursive: true });
    writeFileSync(join(work, ".git/config"), "x");
    const w = await runTool("write_file", { path: ".git/hooks/pre-commit", content: "evil" }, "edit", { cwd: work });
    expect(w.isError).toBe(true);
    expect(existsSync(join(work, ".git/hooks/pre-commit"))).toBe(false);
    const e = await runTool("edit_file", { path: "./.git/config", old_string: "x", new_string: "y" }, "edit", { cwd: work });
    expect(e.isError).toBe(true);
    expect(readFileSync(join(work, ".git/config"), "utf8")).toBe("x");
    expect((await runTool("write_file", { path: "a.gitignore", content: "ok" }, "edit", { cwd: work })).isError).toBe(false);
  });

  test("O_NOFOLLOW: final-component symlink is not followed even past the guard", async () => {
    const { openSync, constants } = await import("node:fs");
    if (!constants.O_NOFOLLOW) return; // platform without O_NOFOLLOW
    const outside = mkdtempSync(join(tmpdir(), "loop-out-"));
    writeFileSync(join(outside, "t"), "secret");
    symlinkSync(join(outside, "t"), join(work, "s"));
    expect(() => openSync(join(work, "s"), constants.O_RDONLY | constants.O_NOFOLLOW)).toThrow();
    // in-cwd symlinks still work: the guard hands open() the realpath, not the link
    writeFileSync(join(work, "real.txt"), "inside");
    symlinkSync(join(work, "real.txt"), join(work, "in-link"));
    expect((await runTool("read_file", { path: "in-link" }, "edit", { cwd: work })).output).toBe("inside");
  });

  test("known secrets redacted from tool output", async () => {
    writeFileSync(join(work, "k.txt"), `key=${KEY}`);
    const r = await runTool("read_file", { path: "k.txt" }, "edit", { cwd: work, secrets: [KEY] });
    expect(r.output).toBe("key=[redacted]");
    const b = await runTool("bash", { command: "cat k.txt" }, "edit", { cwd: work, secrets: [KEY] });
    expect(b.output).not.toContain(KEY);
  });
});

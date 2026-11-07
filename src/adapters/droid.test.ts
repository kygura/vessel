import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterEvent, RunRequest } from "../core/types.ts";
import { buildDroidArgv, createDroidAdapter, parseDroidLine, parseDroidModels } from "./droid.ts";

const req: RunRequest = { prompt: "hi", cwd: tmpdir(), model: "claude-opus-4-8", effort: "medium", autonomy: "edit" };
const fixture = (n: string) => join(import.meta.dir, "fixtures", n);

function fakeBin(body: string) {
  const p = join(mkdtempSync(join(tmpdir(), "fakedroid-")), "droid");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
async function collect(it: AsyncIterable<RouterEvent>) {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const sig = () => new AbortController().signal;

test("fixture -> events (session deduped, completion -> done(finalText))", async () => {
  const evs = await collect(createDroidAdapter(fakeBin(`cat ${fixture("droid-basic.jsonl")}`)).run(req, sig()));
  expect(evs).toEqual([
    { type: "session", id: "droid-sess-1" },
    { type: "text", text: "Working on it" },
    { type: "tool", name: "Execute", status: "started", input: '{"command":"ls"}' },
    { type: "tool", name: "tool", status: "completed", output: "a.txt" },
    { type: "usage", inputTokens: 100, outputTokens: 20 },
    { type: "done", ok: true, finalText: "All done" },
  ]);
});

test("no completion -> done synthesized from exit code with last text; malformed -> single error", async () => {
  const ok = await collect(createDroidAdapter(fakeBin(`cat ${fixture("droid-noterminal.jsonl")}`)).run(req, sig()));
  expect(ok.at(-1)).toEqual({ type: "done", ok: true, finalText: "partial answer" });
  expect(ok.filter((e) => e.type === "done")).toHaveLength(1);
  const bad = await collect(createDroidAdapter(fakeBin(`echo 'garbage'; echo oops >&2; exit 1`)).resume!("sid", req, sig()));
  expect(bad.map((e) => e.type)).toEqual(["error", "done"]);
  expect(bad.at(-1)).toMatchObject({ ok: false });
  const crash = await collect(createDroidAdapter(fakeBin(`echo oops >&2; exit 1`)).run(req, sig()));
  expect(crash[0]).toMatchObject({ type: "error", message: expect.stringContaining("oops") });
});

test("defensive parsing: missing fields, unknown types, error shapes", () => {
  expect(parseDroidLine({ type: "nope" })).toEqual([]);
  expect(parseDroidLine("str")).toEqual([]);
  expect(parseDroidLine({ type: "tool_call" })).toEqual([{ type: "tool", name: "tool", status: "started", input: undefined }]);
  expect(parseDroidLine({ type: "tool_result", isError: true, toolName: "X" })).toMatchObject([{ status: "failed", name: "X" }]);
  expect(parseDroidLine({ type: "error", error: { message: "bad" } })).toEqual([{ type: "error", message: "bad" }]);
  expect(parseDroidLine({ type: "error", error: "bad2" })).toEqual([{ type: "error", message: "bad2" }]);
  expect(parseDroidLine({ type: "completion" })).toEqual([{ type: "done", ok: true, finalText: undefined }]);
});

test("argv per autonomy; resume uses -s", () => {
  const argv = (autonomy: RunRequest["autonomy"], sid?: string) => buildDroidArgv({ ...req, autonomy }, "droid", sid);
  const base = ["droid", "exec", "-o", "stream-json", "-m", "claude-opus-4-8", "-r", "medium", "--cwd", tmpdir()];
  expect(argv("read")).toEqual([...base, "--", "hi"]);
  expect(argv("edit")).toEqual([...base, "--auto", "medium", "--", "hi"]);
  expect(argv("full")).toEqual([...base, "--skip-permissions-unsafe", "--", "hi"]);
  expect(argv("read", "abc")).toEqual([...base, "-s", "abc", "--", "hi"]);
});

const HELP = `Options:\n  -m, --model <id>  Model ID\n\nAvailable built-in models: claude-opus-4-8, gpt-5, glm-4.6.\n\nExamples:\n  droid exec "x"\n`;

test("probe: model parsing and auth by FACTORY_API_KEY", async () => {
  expect(parseDroidModels(HELP)).toEqual([
    { adapter: "droid", model: "claude-opus-4-8" },
    { adapter: "droid", model: "gpt-5" },
    { adapter: "droid", model: "glm-4.6" },
  ]);
  expect(parseDroidModels("no list here")).toEqual([]);
  const bin = fakeBin(`printf '%s' '${HELP}'`);
  expect(await createDroidAdapter(bin, { FACTORY_API_KEY: "k" }).probe()).toMatchObject({ available: true, models: [{ model: "claude-opus-4-8" }, {}, {}] });
  expect(await createDroidAdapter(bin, {}).probe()).toMatchObject({ available: false, reason: "not logged in (FACTORY_API_KEY unset)" });
  expect(await createDroidAdapter("definitely-not-a-bin-xyz", {}).probe()).toMatchObject({ available: false });
  expect(createDroidAdapter().capabilities).toEqual({ resume: true, cost: false, listModels: true });
});

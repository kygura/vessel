import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterEvent, RunRequest } from "../core/types.ts";
import { buildPiArgv, createPiAdapter, parsePiLine, parsePiModels } from "./pi.ts";

const req: RunRequest = { prompt: "hi", cwd: "/tmp", model: "anthropic/sonnet", effort: "high", autonomy: "edit" };
const fixture = (n: string) => join(import.meta.dir, "fixtures", n);

function fakeBin(body: string) {
  const p = join(mkdtempSync(join(tmpdir(), "fakepi-")), "pi");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
async function collect(it: AsyncIterable<RouterEvent>) {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("fixture -> events (text from message_end only, one done with finalText)", async () => {
  const a = createPiAdapter(fakeBin(`cat ${fixture("pi-basic.jsonl")}`));
  const evs = await collect(a.run(req, new AbortController().signal));
  expect(evs).toEqual([
    { type: "session", id: "pi-sess-1" },
    { type: "tool", name: "bash", status: "started", input: '{"command":"ls"}' },
    { type: "tool", name: "bash", status: "completed", output: '{"content":[{"type":"text","text":"a.txt"}]}' },
    { type: "text", text: "Done." },
    { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.0042 },
    { type: "done", ok: true, finalText: "Done." },
  ]);
});

test("stopReason error -> error event and done ok=false", async () => {
  const a = createPiAdapter(fakeBin(`cat ${fixture("pi-error.jsonl")}`));
  const evs = await collect(a.run(req, new AbortController().signal));
  expect(evs.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "401 unauthorized" }]);
  expect(evs.at(-1)).toMatchObject({ type: "done", ok: false });
});

test("malformed line -> one error, no crash; missing agent_settled -> synthesized done from exit code", async () => {
  const evs = await collect(createPiAdapter(fakeBin(`echo 'not json'; exit 0`)).resume!("sid", req, new AbortController().signal));
  expect(evs.map((e) => e.type)).toEqual(["error", "done"]);
  expect(evs.at(-1)).toMatchObject({ ok: false });
  const ok = await collect(createPiAdapter(fakeBin(`echo '{"type":"session","id":"s"}'; exit 0`)).run(req, new AbortController().signal));
  expect(ok).toEqual([{ type: "session", id: "s" }, { type: "done", ok: true, finalText: undefined }]);
  const bad = await collect(createPiAdapter(fakeBin(`echo boom >&2; exit 2`)).run(req, new AbortController().signal));
  expect(bad.map((e) => e.type)).toEqual(["error", "done"]);
  expect(bad[0]).toMatchObject({ message: expect.stringContaining("boom") });
});

test("unknown / odd native events -> []", () => {
  expect(parsePiLine({ type: "whatever" })).toEqual([]);
  expect(parsePiLine(null)).toEqual([]);
  expect(parsePiLine({ type: "message_end", message: { role: "user" } })).toEqual([]);
  expect(parsePiLine({ type: "agent_settled", aborted: true })).toEqual([{ type: "done", ok: false }]);
});

test("argv per autonomy; resume uses --session; no --no-session", () => {
  const argv = (autonomy: RunRequest["autonomy"], sid?: string) => buildPiArgv({ ...req, autonomy }, "pi", sid);
  expect(argv("read")).toEqual(["pi", "-p", "--mode", "json", "--model", "anthropic/sonnet", "--thinking", "high", "--tools", "read,grep,find,ls", "--", "hi"]);
  expect(argv("edit")[9]).toBe("read,edit,write,bash,grep,find,ls");
  expect(argv("full")[9]).toBe("read,edit,write,bash,grep,find,ls");
  const r = argv("edit", "abc");
  expect(r.slice(r.indexOf("--session"), r.indexOf("--session") + 2)).toEqual(["--session", "abc"]);
  expect(r).not.toContain("--no-session");
});

const TABLE = `provider   model              context  max-out  thinking  images
anthropic  claude-sonnet-4-5  200K     64K      yes       yes
openai     gpt-5              400K     128K     yes       yes
`;

test("probe parsers", async () => {
  expect(parsePiModels(TABLE)).toEqual([
    { adapter: "pi", model: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
    { adapter: "pi", model: "openai/gpt-5", provider: "openai" },
  ]);
  expect(parsePiModels("No models available. Use /login to log into a provider.\n  /home/x/docs/models.md")).toEqual([]);
  const a = createPiAdapter(fakeBin(`printf '%s' '${TABLE}'`));
  expect(await a.probe()).toMatchObject({ available: true, models: [{ model: "anthropic/claude-sonnet-4-5" }, { model: "openai/gpt-5" }] });
  expect(await createPiAdapter(fakeBin("echo 'No models available.'")).probe()).toMatchObject({ available: false, models: [] });
  expect(await createPiAdapter("definitely-not-a-bin-xyz").probe()).toMatchObject({ available: false, reason: "not installed" });
});

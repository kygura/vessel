import { expect, test } from "bun:test";
import { runCapture, spawnJsonl, which } from "./proc.ts";

test("spawnJsonl yields json, raw for malformed, skips blanks, reports exit", async () => {
  const { lines, exit } = spawnJsonl(["sh", "-c", `printf '{"a":1}\\nnot json\\n\\n{"b":2}'; echo oops >&2; exit 3`]);
  const got = [];
  for await (const l of lines) got.push(l);
  expect(got).toEqual([{ json: { a: 1 }, raw: '{"a":1}' }, { raw: "not json" }, { json: { b: 2 }, raw: '{"b":2}' }]);
  expect(await exit).toEqual({ exitCode: 3, stderrTail: "oops\n" });
});

test("spawnJsonl abort kills process", async () => {
  const ac = new AbortController();
  const { lines, exit } = spawnJsonl(["sleep", "5"], { signal: ac.signal });
  ac.abort();
  for await (const _ of lines) {}
  expect((await exit).exitCode).toBeNull();
});

test("which + runCapture", async () => {
  expect(which("sh")).toBeTruthy();
  expect(which("definitely-not-a-bin-xyz")).toBeNull();
  expect(await runCapture(["sh", "-c", "echo hi"], 5000)).toMatchObject({ exitCode: 0, stdout: "hi\n" });
  expect(await runCapture(["sleep", "5"], 100)).toMatchObject({ exitCode: null, timedOut: true });
  expect((await runCapture(["definitely-not-a-bin-xyz"], 1000)).exitCode).toBeNull();
});

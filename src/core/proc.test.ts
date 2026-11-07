import { expect, test } from "bun:test";
import { runCapture, spawnJsonl } from "./proc.ts";

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

test("runCapture basics", async () => {
  expect(await runCapture(["sh", "-c", "echo hi"], 5000)).toMatchObject({ exitCode: 0, stdout: "hi\n" });
  expect(await runCapture(["sh", "-c", "pwd; echo $FOO"], 5000, { cwd: "/", env: { FOO: "bar", PATH: process.env.PATH } })).toMatchObject({ stdout: "/\nbar\n" });
  expect(await runCapture(["sleep", "5"], 100)).toMatchObject({ exitCode: null, timedOut: true });
  expect((await runCapture(["definitely-not-a-bin-xyz"], 1000)).exitCode).toBeNull();
});

test("runCapture timeout kills the whole process group", async () => {
  const t0 = Date.now();
  const r = await runCapture(["sh", "-c", "sleep 30 & echo $!; wait"], 200);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(5000);
  const grandchild = Number(r.stdout.trim());
  await Bun.sleep(50);
  expect(() => process.kill(grandchild, 0)).toThrow();
});

test("runCapture abort kills; backgrounded grandchild holding pipes cannot hang it", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  expect(await runCapture(["sleep", "30"], 10_000, { signal: ac.signal })).toMatchObject({ exitCode: null, timedOut: false });
  const t0 = Date.now();
  const r = await runCapture(["sh", "-c", "sleep 30 & echo started"], 10_000);
  expect(r).toMatchObject({ exitCode: 0, stdout: "started\n" });
  expect(Date.now() - t0).toBeLessThan(4000);
});

test("spawnJsonl kill + rolling stderr tail", async () => {
  const p = spawnJsonl(["sh", "-c", "head -c 5000 /dev/zero | tr '\\0' a >&2; echo end >&2; sleep 30"]);
  setTimeout(p.kill, 200);
  for await (const _ of p.lines) {}
  const e = await p.exit;
  expect(e.exitCode).toBeNull();
  expect(e.stderrTail.length).toBe(2000);
  expect(e.stderrTail.endsWith("end\n")).toBe(true);
});

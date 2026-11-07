import { expect, test } from "bun:test";
import { liveGroups, runCapture, spawnJsonl } from "./proc.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

test("runCapture keep: tail retains the end of large output", async () => {
  const cmd = "head -c 1500000 /dev/zero | tr '\\0' a; echo FAILED-SUMMARY";
  const tail = await runCapture(["sh", "-c", cmd], 10_000, { keep: "tail" });
  expect(tail.stdout.endsWith("FAILED-SUMMARY\n")).toBe(true);
  expect(tail.stdout.length).toBe(1_000_000);
  const head = await runCapture(["sh", "-c", cmd], 10_000);
  expect(head.stdout.includes("FAILED-SUMMARY")).toBe(false);
  expect(head.stdout.length).toBe(1_000_000);
});

test("runCapture: fast exit is never reported as timedOut", async () => {
  expect(await runCapture(["true"], 50)).toMatchObject({ exitCode: 0, timedOut: false });
});

test("spawnJsonl: slow consumer still gets the final line after exit + grace", async () => {
  const p = spawnJsonl(["sh", "-c", `for i in 1 2 3; do echo '{"n":'$i'}'; done; echo '{"type":"result"}'`]);
  const got: unknown[] = [];
  for await (const l of p.lines) {
    got.push(l.json);
    await Bun.sleep(1000); // > 3s total, past the 2s grace
  }
  expect(got.at(-1)).toEqual({ type: "result" });
  expect(got).toHaveLength(4);
}, 10_000);

test("spawnJsonl kill reaches a grandchild; registry empties after exit", async () => {
  const p = spawnJsonl(["sh", "-c", "sleep 30 & echo $!; wait"]);
  let gc = 0;
  for await (const l of p.lines) {
    gc = Number(l.raw);
    p.kill();
  }
  await p.exit;
  await Bun.sleep(50);
  expect(alive(gc)).toBe(false);
  const q = spawnJsonl(["true"]);
  for await (const _ of q.lines) {}
  await q.exit;
  await Bun.sleep(10);
  expect(liveGroups().size).toBe(0);
});

test("SIGINT kills live groups, then the default action still terminates us", async () => {
  const script = `import { spawnJsonl } from ${JSON.stringify(import.meta.dir + "/proc.ts")};
const p = spawnJsonl(["sh", "-c", "sleep 30 & echo $!; wait"]);
for await (const l of p.lines) { console.log(l.raw); }`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const gc = Number((await reader.read()).value?.trim());
  child.kill("SIGINT");
  await child.exited;
  expect(child.signalCode).toBe("SIGINT");
  await Bun.sleep(50);
  expect(alive(gc)).toBe(false);
});

import { expect, test } from "bun:test";
import type { RouterEvent } from "../core/types.ts";
import { claudeLoggedIn } from "./claude.ts";
import { parseCodexModels } from "./codex.ts";
import { streamCli } from "./common.ts";
import { opencodeHasAuth } from "./opencode.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function collect(it: AsyncIterable<RouterEvent>) {
  const out: RouterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("consumer stopping early kills the child", async () => {
  const pidFile = `${process.env.TMPDIR ?? "/tmp"}/streamcli-${process.pid}-${Date.now()}`;
  const parse = (j: unknown) => [{ type: "text" as const, text: JSON.stringify(j) }];
  for await (const _ of streamCli(["sh", "-c", `echo $$ > ${pidFile}; echo 1; exec sleep 30`], { signal: new AbortController().signal }, parse)) break;
  const pid = Number(await Bun.file(pidFile).text());
  await Bun.sleep(50);
  expect(alive(pid)).toBe(false);
});

test("idle watchdog kills a silent child and reports idle timeout", async () => {
  const t0 = Date.now();
  const evs = await collect(streamCli(["sleep", "30"], { idleMs: 100 }, () => []));
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(evs[0]).toMatchObject({ type: "error", message: expect.stringContaining("idle timeout") });
  expect(evs.at(-1)).toMatchObject({ type: "done", ok: false });
});

test("invalid events become error events naming the field; throwing parser does not crash", async () => {
  const bad = () => [{ type: "tool", name: "x", status: "weird" } as unknown as RouterEvent];
  const evs = await collect(streamCli(["sh", "-c", "echo '{}'"], {}, bad));
  expect(evs[0]).toMatchObject({ type: "error", message: expect.stringContaining("status") });
  expect(evs.at(-1)).toMatchObject({ type: "done", ok: false });
  const throws = () => {
    throw new Error("boom");
  };
  const evs2 = await collect(streamCli(["sh", "-c", "echo '{}'"], {}, throws));
  expect(evs2[0]).toMatchObject({ type: "error", message: "parser failed: boom" });
});

test("JSON probe outputs are schema-checked", () => {
  expect(claudeLoggedIn('{"loggedIn":true,"authMethod":"x"}')).toBe(true);
  expect(claudeLoggedIn('{"loggedIn":"yes"}')).toBe(false);
  expect(claudeLoggedIn("not json")).toBe(false);
  expect(parseCodexModels('{"models":[{"slug":"gpt-5"},{"slug":"h","visibility":"hide"},{"nope":1}]}')).toEqual([]);
  expect(parseCodexModels('{"models":[{"slug":"gpt-5","extra":1},{"slug":"h","visibility":"hide"}]}')).toEqual([{ adapter: "codex", model: "gpt-5" }]);
  expect(parseCodexModels("garbage")).toEqual([]);
  expect(opencodeHasAuth('[{"provider":"anthropic"}]')).toBe(true);
  expect(opencodeHasAuth("{}")).toBe(false);
  expect(opencodeHasAuth("[]")).toBe(false);
  expect(opencodeHasAuth("{broken")).toBe(false);
  expect(opencodeHasAuth("anthropic  oauth")).toBe(true);
});

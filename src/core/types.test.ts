import { expect, test } from "bun:test";
import { RouterEvent } from "./types.ts";

test("RouterEvent parses each variant", () => {
  for (const e of [
    { type: "session", id: "s1" },
    { type: "text", text: "hi" },
    { type: "tool", name: "bash", status: "completed", input: "ls", output: "a" },
    { type: "usage", inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
    { type: "error", message: "boom" },
    { type: "done", ok: true, finalText: "ok" },
  ]) expect(RouterEvent.parse(e)).toEqual(e as RouterEvent);
});

test("RouterEvent rejects unknown type and bad fields", () => {
  expect(RouterEvent.safeParse({ type: "nope" }).success).toBe(false);
  expect(RouterEvent.safeParse({ type: "tool", name: "x", status: "weird" }).success).toBe(false);
  expect(RouterEvent.safeParse({ type: "done" }).success).toBe(false);
});

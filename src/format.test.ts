import { expect, test } from "bun:test";
import { duration, pct, tokens, trunc, usd } from "./format.ts";

test("formatters", () => {
  expect([pct(0.256), usd(), usd(0.001), usd(1.234), duration(75_000), duration(4000), tokens(999), tokens(1500)]).toEqual(["26%", "-", "<$0.01", "$1.23", "1m15s", "4s", "999", "1.5k"]);
  expect([trunc("abcdef", 4), trunc("abc", 4), trunc("abc", 1), trunc("abc", 0)]).toEqual(["abc…", "abc", "…", ""]);
});

import type { Route } from "../core/types.ts";
import type { Candidate } from "../routing/evaluate.ts";

/** UI state machine for one submission (DESIGN.md "Interaction"). */
export type Phase = "idle" | "classifying" | "ranked" | "running" | "verifying" | "done" | "failed";
export type Mode = "dry-run" | "run";
export type Focus = "prompt" | "sessions" | "log";

/** Candidate plus the absolute cost the table shows (Candidate itself only carries normalized cost). */
export type CandidateRow = Candidate & { costUsd?: number };

export interface Decision {
  tier: string;
  confidence: number;
  reasons: string[];
  candidates: CandidateRow[];
  chosen: Route;
}

export type StatusKind = "pass" | "fail" | "unknown" | "running" | "error" | "unavailable";
type Color = "green" | "red" | "yellow" | "cyan";

/** Single source of the semantic table: glyph + word + ANSI-16 color (never bright-black). */
export const STATUS: Record<StatusKind, { glyph: string; label: string; color?: Color; dim?: boolean }> = {
  pass: { glyph: "OK", label: "pass", color: "green" },
  fail: { glyph: "XX", label: "fail", color: "red" },
  unknown: { glyph: "??", label: "unknown", color: "yellow" },
  running: { glyph: ">>", label: "running", color: "cyan" },
  error: { glyph: "!!", label: "error", color: "red" },
  unavailable: { glyph: "--", label: "unavailable", dim: true },
};

type Env = Record<string, string | undefined>;

/** Colors are off when NO_COLOR is set (any value) or stdout is not a TTY (FORCE_COLOR overrides the TTY check). */
export const colorEnabled = (env: Env = process.env, isTTY: boolean = !!process.stdout.isTTY): boolean =>
  env.NO_COLOR === undefined && (isTTY || !!env.FORCE_COLOR);

/** Color for a role, or undefined when colors are disabled. Bold/dim are weight, so they stay. */
export const colorOf = (kind: StatusKind): Color | undefined => (colorEnabled() ? STATUS[kind].color : undefined);

export const isUtf8 = (env: Env = process.env): boolean => /utf-?8/i.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "");

export const ASCII_BORDER = {
  topLeft: "+", top: "-", topRight: "+", left: "|", bottomLeft: "+", bottom: "-", bottomRight: "+", right: "|",
} as const;
export const borderStyle = () => (isUtf8() ? ("single" as const) : ASCII_BORDER);

export const SPINNER = "|/-\\";

// ---- formatting: the single place for percentage / currency / duration / truncation ----

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const usd = (x?: number): string =>
  x === undefined ? "-" : x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`;
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
export const tokens = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
export const trunc = (s: string, max: number): string =>
  max <= 0 ? "" : s.length <= max ? s : max === 1 ? "…" : `${s.slice(0, max - 1)}…`;
export const routeLabel = (r: Route): string => `${r.adapter}/${r.model}`;

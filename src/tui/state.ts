import type { RouterEvent, Route, Outcome } from "../core/types.ts";
import type { Classification } from "../routing/classify.ts";
import type { Candidate } from "../routing/evaluate.ts";
import type { Phase, RunUpdate } from "../run.ts";

export const MAX_EVENTS = 500;

export interface TuiRunState {
  phase: "idle" | Phase;
  /** Free-text from the latest `phase` update (e.g. "dry run", "aborted"). */
  message?: string;
  sessionId?: string;
  classification?: Classification;
  source?: "heuristic" | "llm" | "override";
  candidates: Candidate[];
  /** Route currently executing (re-set when a later route starts). */
  route?: Route;
  /** Last MAX_EVENTS events. */
  events: RouterEvent[];
  verify?: { command: string; ok: boolean; exitCode: number | null; output: string };
  outcome?: Outcome;
  /** User-facing notes from the run (edit-mode sandbox warning, untrusted .vessel.json verify), in order, deduped. */
  notices: string[];
  /** Set when the run ended `failed`, or by the hook for non-run errors (e.g. rate). */
  error?: string;
}

export const initialRun: TuiRunState = { phase: "idle", candidates: [], events: [], notices: [] };

export const isBusy = (s: TuiRunState) => s.phase !== "idle" && s.phase !== "done" && s.phase !== "failed";

/** Pure: fold one core update into UI state. Never mutates `s`. */
export function reduce(s: TuiRunState, u: RunUpdate): TuiRunState {
  switch (u.type) {
    case "phase":
      return { ...s, phase: u.phase, message: u.message, error: u.phase === "failed" ? (u.message ?? "failed") : s.error };
    case "started":
      return { ...s, sessionId: u.sessionId };
    case "classification":
      return { ...s, classification: u.classification, source: u.source };
    case "ranked":
      return { ...s, candidates: u.candidates, route: s.route ?? u.candidates[0]?.route };
    case "route":
      return { ...s, route: u.route };
    case "event": {
      const events = [...s.events, u.event];
      return { ...s, events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events };
    }
    case "verify":
      return { ...s, verify: { command: u.command, ok: u.ok, exitCode: u.exitCode, output: u.output } };
    case "outcome":
      return { ...s, outcome: u.outcome };
    case "notice":
      return s.notices.includes(u.message) ? s : { ...s, notices: [...s.notices, u.message] };
    default:
      return s; // roster/fallback-style updates are not UI state
  }
}

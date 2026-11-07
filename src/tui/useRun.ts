import { useCallback, useEffect, useRef, useState } from "react";
import { ADAPTERS } from "../adapters/index.ts";
import { loadEvidence } from "../core/config.ts";
import { type Roster, buildRoster } from "../routing/roster.ts";
import { type RunOptions, type RunUpdate, rateSession, resumeTask, runTask } from "../run.ts";
import type { SessionRecord } from "../core/types.ts";
import { listSessions } from "../sessions.ts";
import { type TuiRunState, initialRun, isBusy, reduce } from "./state.ts";

export interface UseRun {
  run: TuiRunState;
  busy: boolean;
  /** undefined while the startup probe is still running. */
  roster: Roster | undefined;
  sessions: SessionRecord[];
  start(prompt: string, o?: { dryRun?: boolean }): void;
  resume(id: string, prompt: string): void;
  rate(id: string, result: "pass" | "fail"): void;
  abort(): void;
}

/** Thin wrapper: all state transitions live in `reduce`. `base` carries test seams (adapters, llm, cwd...). */
export function useRun(base: RunOptions = {}): UseRun {
  const [run, setRun] = useState<TuiRunState>(initialRun);
  const [roster, setRoster] = useState<Roster>();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const ctl = useRef<AbortController>(undefined);
  const live = useRef(true);
  const busy = isBusy(run);
  // Latest state for the re-entrancy guard in `drive` without re-creating callbacks.
  const runRef = useRef(run);
  runRef.current = run;
  const refresh = useCallback(() => { if (live.current) setSessions(listSessions()); }, []);
  const fail = (e: unknown) => setRun((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));

  useEffect(() => {
    live.current = true;
    refresh();
    buildRoster(base.adapters ?? ADAPTERS, { evidence: loadEvidence() })
      .then((r) => live.current && setRoster(r))
      .catch(() => live.current && setRoster({ routes: [], unavailable: [] }));
    return () => { live.current = false; ctl.current?.abort(); };
  }, []);

  const drive = useCallback(async (phase: "classifying" | "running", iter: (signal: AbortSignal) => AsyncIterable<RunUpdate>) => {
    if (isBusy(runRef.current)) return;
    const c = (ctl.current = new AbortController());
    setRun({ ...initialRun, phase });
    try {
      for await (const u of iter(c.signal)) {
        if (!live.current) return;
        setRun((s) => reduce(s, u));
        if (u.type === "started") refresh();
      }
    } catch (e) {
      fail(e);
    } finally {
      refresh();
    }
  }, []);

  return {
    run, busy, roster, sessions,
    start: (prompt, o) => void drive("classifying", (signal) => runTask(prompt, { ...base, dryRun: o?.dryRun, signal })),
    resume: (id, prompt) => void drive("running", (signal) => resumeTask(id, prompt, { ...base, signal })),
    rate(id, result) {
      try { rateSession(id, result); refresh(); } catch (e) { fail(e); }
    },
    abort: () => ctl.current?.abort(),
  };
}

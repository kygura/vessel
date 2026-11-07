import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadEvidence } from "../core/config.ts";
import type { RouterEvent, SessionRecord } from "../core/types.ts";
import { resolve } from "../routing/evaluate.ts";
import type { RunOptions } from "../run.ts";
import { readEvents } from "../sessions.ts";
import { DecisionPanel } from "./components/DecisionPanel.tsx";
import { EventLog, type Usage } from "./components/EventLog.tsx";
import { KeyHints } from "./components/KeyHints.tsx";
import { PromptInput } from "./components/PromptInput.tsx";
import { RosterOverlay } from "./components/RosterOverlay.tsx";
import { SessionsList } from "./components/SessionsList.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { isUtf8, type CandidateRow, type Decision, type Focus, type Mode, type Phase } from "./theme.ts";
import { useRun } from "./useRun.ts";

export interface AppProps {
  /** Test seams forwarded to the core (adapters, llm, cwd, tier...). */
  options?: RunOptions;
  /** Overrides the stdout size (tests). */
  size?: { columns: number; rows: number };
  /** Called right before the app exits. */
  onQuit?: () => void;
}

const FOCUS: Focus[] = ["prompt", "sessions", "log"];
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lineCount = (events: RouterEvent[]) =>
  events.reduce((n, e) => n + (e.type === "text" ? e.text.split("\n").length : e.type === "tool" || e.type === "error" || e.type === "done" ? 1 : 0), 0);

function sumUsage(events: RouterEvent[]): Usage | undefined {
  let u: Usage | undefined;
  for (const e of events) {
    if (e.type !== "usage") continue;
    const add = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
    u = { inputTokens: add(u?.inputTokens, e.inputTokens), outputTokens: add(u?.outputTokens, e.outputTokens), costUsd: add(u?.costUsd, e.costUsd) };
  }
  return u;
}

export function App({ options, size, onQuit }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const measure = () => {
    const t = stdout as unknown as { columns?: number; rows?: number };
    return { columns: t.columns || 80, rows: t.rows || 24 };
  };
  const [dims, setDims] = useState(measure);
  useEffect(() => {
    const on = () => setDims(measure());
    stdout.on("resize", on);
    return () => void stdout.off("resize", on);
  }, [stdout]);
  const { columns: cols, rows } = size ?? dims;

  const r = useRun(options);
  const { run, busy, roster, sessions } = r;
  const [focus, setFocus] = useState<Focus>("prompt");
  const [mode, setMode] = useState<Mode>("run");
  const [prompt, setPrompt] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [resumeId, setResumeId] = useState<string>();
  const [overlay, setOverlay] = useState(false);
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const lastPrompt = useRef("");
  const quitArmed = useRef(false);
  const wasBusy = useRef(false);

  // Spinner/elapsed timer only runs while busy; focus returns to the prompt when a run ends.
  useEffect(() => {
    if (!busy) {
      quitArmed.current = false;
      if (wasBusy.current) setFocus("prompt");
      wasBusy.current = false;
      return;
    }
    wasBusy.current = true;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => { setTick((t) => t + 1); setElapsed(Date.now() - t0); }, 200);
    return () => clearInterval(id);
  }, [busy]);

  const evidence = useMemo(() => { try { return loadEvidence(); } catch { return undefined; } }, []);
  const costOf = (model: string) => evidence?.models[resolve(evidence, model)]?.costPerTask;

  const sel = sessions.find((s) => s.id === selectedId);
  // A past session is shown unless the live run is the thing selected (or nothing is).
  const recordedView = !!sel && (!busy || sel.id !== run.sessionId);
  const noRoutes = !!roster && roster.routes.length === 0;
  const dryRanked = run.phase === "done" && run.message === "dry run";

  const liveDecision: Decision | undefined =
    run.classification && run.candidates.length
      ? {
          tier: run.classification.tier,
          confidence: run.classification.confidence,
          reasons: run.classification.reasons,
          candidates: run.candidates.map((c): CandidateRow => ({ ...c, costUsd: costOf(c.route.model) })),
          chosen: run.route ?? run.candidates[0]!.route,
        }
      : undefined;
  // ponytail: the session record stores no confidence or candidates, so recorded decisions show 100% and an empty table.
  const recorded = (s: SessionRecord): Decision => ({
    tier: s.tier, confidence: 1, reasons: ["recorded route (confidence not stored)"], candidates: [], chosen: s.route,
  });
  const decision = recordedView ? recorded(sel!) : (liveDecision ?? (sel && run.phase !== "idle" ? recorded(sel) : undefined));

  const pastEvents = useMemo(() => {
    if (!recordedView || !sel) return [];
    try { return readEvents(sel.id).map((x) => x.event); } catch { return []; }
  }, [recordedView, sel?.id, sessions, busy]);
  const baseEvents = recordedView ? pastEvents : run.events;
  const events: RouterEvent[] =
    run.error && (recordedView || run.sessionId) ? [...baseEvents, { type: "error", message: run.error }] : baseEvents;

  // Layout: status(1) + body + prompt(3) + hints(1).
  const total = Math.max(10, rows - 1); // one row spare so Ink never clears the whole terminal each frame
  const bodyH = total - 5;
  const left = clamp(Math.round(26 + (cols - 80) * 0.2), 26, 40);
  const right = Math.max(20, cols - left - 1);
  const notices = recordedView ? [] : run.notices.slice(-2);
  const dh = clamp(Math.min(clamp(8 + (rows - 24), 8, 14), bodyH - 1 - notices.length - 6), 3, 14);
  const logH = Math.max(2, bodyH - dh - 1 - notices.length);

  const phase: Phase = recordedView ? "done" : run.phase;
  const maxOffset = Math.max(0, lineCount(events) - (logH - 1));
  const scroll = (d: number) => setOffset((o) => clamp(o + d, 0, maxOffset));
  const select = (id: string) => { setSelectedId(id); setOffset(0); };

  const quit = () => {
    if (busy && !quitArmed.current) { quitArmed.current = true; r.abort(); return; }
    onQuit?.();
    exit();
  };

  const submit = (raw: string) => {
    const v = raw.trim();
    if (busy) return;
    if (resumeId) {
      if (!v) return;
      r.resume(resumeId, v);
      setResumeId(undefined);
    } else if (!v) {
      // After a dry-run, an empty Enter runs the decision just shown.
      if (mode !== "dry-run" || !dryRanked || !lastPrompt.current) return;
      setSelectedId(undefined);
      r.start(lastPrompt.current, { dryRun: false });
    } else {
      if (noRoutes) return;
      lastPrompt.current = v;
      setSelectedId(undefined);
      r.start(v, { dryRun: mode === "dry-run" });
    }
    setPrompt("");
    setOffset(0);
    setFocus("prompt");
  };

  const typing = focus === "prompt" && !busy;
  useInput((input, key) => {
    if (key.ctrl && input === "c") return quit();
    if (key.tab) return setFocus((f) => FOCUS[(FOCUS.indexOf(f) + (key.shift ? 2 : 1)) % 3]!);
    if (key.ctrl && input === "d") return setMode((m) => (m === "run" ? "dry-run" : "run"));
    if (key.escape) {
      if (busy) r.abort();
      else if (!overlay) { setPrompt(""); setResumeId(undefined); } // the overlay closes itself
      return;
    }
    if (typing) return;
    if (input === "q") return quit();
    if (input === "r") return void (roster && setOverlay((o) => !o));
    if (focus === "sessions") {
      if (key.return) setFocus("log");
      else if (input === "R" && sel && !busy) { setResumeId(sel.id); setFocus("prompt"); }
      else if ((input === "p" || input === "f") && sel && (sel.result ?? "unknown") === "unknown") r.rate(sel.id, input === "p" ? "pass" : "fail");
    } else if (focus === "log") {
      if (key.upArrow || input === "k") scroll(1);
      else if (key.downArrow || input === "j") scroll(-1);
    }
  });

  const hintState: Phase = dryRanked ? "ranked" : phase;
  const rule = (isUtf8() ? "─" : "-").repeat(right);
  return (
    <Box flexDirection="column" width={cols} height={total}>
      <StatusBar roster={roster} probing={!roster} width={cols} />
      <Box height={bodyH} overflow="hidden">
        {overlay && roster ? (
          <Box flexGrow={1}><RosterOverlay roster={roster} onClose={() => setOverlay(false)} /></Box>
        ) : (
          <>
            <SessionsList
              sessions={sessions} selectedId={selectedId} focused={focus === "sessions"} width={left} height={bodyH}
              compact={cols < 90} onSelect={select}
            />
            <Box flexDirection="column" marginLeft={1} width={right}>
              <DecisionPanel
                phase={phase} decision={decision} recorded={recordedView} width={right} height={dh}
                error={run.error} noRoutes={noRoutes}
              />
              {notices.map((n, i) => <Text key={i} dimColor wrap="truncate-end">note: {n}</Text>)}
              <Text dimColor>{rule}</Text>
              <EventLog
                events={events} phase={phase} elapsedMs={elapsed} usage={sumUsage(events)} focused={focus === "log"}
                height={logH} tick={tick} verifyCommand={run.verify?.command}
                outcome={recordedView ? (sel!.result ?? "unknown") : run.outcome?.result} offset={offset}
              />
            </Box>
          </>
        )}
      </Box>
      <PromptInput
        value={prompt} mode={mode} disabled={busy} focused={focus === "prompt"}
        prefix={resumeId ? "resume: " : undefined} onChange={setPrompt} onSubmit={submit}
      />
      <KeyHints focus={focus} state={hintState} hasSelection={!!sel} mode={mode} />
    </Box>
  );
}

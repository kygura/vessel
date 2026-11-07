import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { OutcomeResult, RouterEvent } from "../../core/types.ts";
import { duration, SPINNER, tokens, usd, type Phase } from "../theme.ts";
import { Empty, Status } from "./Status.tsx";

export type Usage = Omit<Extract<RouterEvent, { type: "usage" }>, "type">;

export interface EventLogProps {
  events: RouterEvent[];
  phase: Phase;
  elapsedMs: number;
  usage?: Usage;
  focused: boolean;
  /** Rows available including the header. */
  height: number;
  /** Spinner frame counter; the spinner lives in the header only. */
  tick?: number;
  /** Shown in the header while verifying. */
  verifyCommand?: string;
  /** Final outcome shown in the header once done/failed. */
  outcome?: OutcomeResult;
  /** Lines scrolled up from the tail. */
  offset?: number;
}

const TOOL = { started: ">>", completed: "OK", failed: "XX" } as const;

function Header({ phase, elapsedMs, tick = 0, verifyCommand, outcome, usage, focused }: EventLogProps) {
  let status: ReactNode = null;
  if (phase === "running") status = <Status kind="running" label={`running ${SPINNER[tick % 4]} ${duration(elapsedMs)}`} />;
  else if (phase === "verifying") status = <Status kind="running" label={`verifying: ${verifyCommand ?? ""}`} />;
  else if (phase === "done" || phase === "failed") status = <Status kind={outcome ?? (phase === "failed" ? "fail" : "unknown")} />;
  const tok = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const counter = [tok ? `${tokens(tok)} tok` : "", usage?.costUsd !== undefined ? usd(usage.costUsd) : ""].filter(Boolean).join(" ");
  return (
    <Box justifyContent="space-between">
      <Text><Text bold>{focused ? "> " : ""}Events</Text> {status}</Text>
      <Text dimColor>{counter}</Text>
    </Box>
  );
}

function line(e: RouterEvent, i: number) {
  switch (e.type) {
    case "text":
      return e.text.split("\n").map((t, j) => <Text key={`${i}.${j}`} wrap="truncate-end">{t}</Text>);
    case "tool":
      return <Text key={i} wrap="truncate-end">tool  {e.name}  {e.input ?? ""}  {TOOL[e.status]}</Text>;
    case "error":
      return <Status key={i} kind="error" label={e.message} />;
    case "done":
      return <Text key={i} bold>== done {e.ok ? "ok" : "failed"}</Text>;
    default:
      return []; // `session` is bookkeeping; `usage` feeds the header counter
  }
}

export function EventLog(props: EventLogProps) {
  const rows = Math.max(1, props.height - 1);
  const lines = props.events.flatMap(line);
  const end = Math.max(0, lines.length - (props.offset ?? 0));
  return (
    <Box flexDirection="column" height={props.height} overflow="hidden">
      <Header {...props} />
      {lines.length === 0 ? (
        <Empty>{props.phase === "running" ? "Waiting for events..." : "No events recorded."}</Empty>
      ) : (
        lines.slice(Math.max(0, end - rows), end)
      )}
    </Box>
  );
}

import { Box, Text, useInput } from "ink";
import type { SessionRecord } from "../../core/types.ts";
import { STATUS, routeLabel, trunc, usd } from "../theme.ts";
import { Empty, Status } from "./Status.tsx";

export interface SessionsListProps {
  sessions: SessionRecord[];
  selectedId?: string;
  focused: boolean;
  width: number;
  /** Rows available including the header. */
  height?: number;
  /** Terminal under 90 columns: id and outcome glyph only, one row per session. */
  compact?: boolean;
  onSelect: (id: string) => void;
}

/** `HH:MM` for today, `MM-DD` otherwise (local time). */
function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return d.toDateString() === now.toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Dim second line: the task first (what you remember), then tier and route; the tail is what gets cut when narrow. */
function second(s: SessionRecord, w: number): string {
  const tail = `${s.tier} ${routeLabel(s.route)}`;
  const taskW = Math.max(10, w - tail.length - 1);
  return trunc(`${trunc(s.prompt.replace(/\s+/g, " "), taskW).padEnd(taskW)} ${tail}`, Math.max(0, w));
}

/**
 * Full rows take two lines so every DESIGN field fits in a 26-40 column list:
 * `glyph word id time  cost` then a dim `tier route task`. Cells are truncated, never wrapped.
 */
export function SessionsList({ sessions, selectedId, focused, width, height = 20, compact, onSelect }: SessionsListProps) {
  const sel = sessions.findIndex((s) => s.id === selectedId);
  useInput(
    (input, key) => {
      const step = key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : 0;
      if (!step) return;
      const next = sessions[Math.min(sessions.length - 1, Math.max(0, (sel < 0 ? (step > 0 ? -1 : 0) : sel) + step))];
      if (next) onSelect(next.id);
    },
    { isActive: focused && sessions.length > 0 },
  );
  const per = compact ? 1 : 2;
  const rows = Math.max(1, Math.floor((height - 1) / per));
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), sessions.length - rows));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text bold>{focused ? "> " : ""}Sessions</Text>
      {sessions.length === 0 ? (
        <Empty>No sessions yet. Run a task to create one.</Empty>
      ) : (
        sessions.slice(start, start + rows).map((s) => {
          const kind = s.result ?? "unknown";
          // Only one reversed region at a time: the selected row inverts while this list has focus, else it is bold.
          const on = s.id === selectedId;
          const style = { inverse: on && focused, bold: on && !focused };
          if (compact)
            return (
              <Text key={s.id} {...style} wrap="truncate-end">
                <Status kind={kind} label="" /> {s.id}
              </Text>
            );
          const head = `${STATUS[kind].glyph} ${STATUS[kind].label} ${s.id} ${when(s.createdAt)}`;
          const cost = usd(s.costUsd);
          const gap = width - head.length - cost.length;
          return (
            <Box key={s.id} flexDirection="column">
              <Text {...style} wrap="truncate-end">
                <Status kind={kind} /> {s.id} {when(s.createdAt)}
                {gap >= 1 ? `${" ".repeat(gap)}${cost}` : ""}
              </Text>
              <Text {...style} dimColor={!on} wrap="truncate-end">
                {"   "}{second(s, width - 3)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

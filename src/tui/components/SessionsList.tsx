import { Box, Text, useInput } from "ink";
import type { SessionRecord } from "../../core/types.ts";
import { trunc } from "../theme.ts";
import { Empty, Status } from "./Status.tsx";

export interface SessionsListProps {
  sessions: SessionRecord[];
  selectedId?: string;
  focused: boolean;
  width: number;
  /** Rows available including the header. */
  height?: number;
  /** Terminal under 90 columns: id and outcome glyph only. */
  compact?: boolean;
  onSelect: (id: string) => void;
}

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
  const rows = Math.max(1, height - 1);
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), sessions.length - rows));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text bold>{focused ? "> " : ""}Sessions</Text>
      {sessions.length === 0 ? (
        <Empty>No sessions yet. Run a task to create one.</Empty>
      ) : (
        sessions.slice(start, start + rows).map((s) => (
          <Text key={s.id} inverse={s.id === selectedId} wrap="truncate-end">
            <Status kind={s.result ?? "unknown"} label="" /> {s.id}
            {compact ? "" : ` ${trunc(s.prompt.replace(/\s+/g, " "), Math.max(0, width - 13))}`}
          </Text>
        ))
      )}
    </Box>
  );
}

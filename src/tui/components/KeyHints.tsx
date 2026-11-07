import { Text } from "ink";
import type { Focus, Mode, Phase } from "../theme.ts";

export interface KeyHintsProps {
  focus: Focus;
  state: Phase;
  hasSelection: boolean;
  /** Only used to word the dry-run hint. */
  mode?: Mode;
}

const BUSY: Phase[] = ["classifying", "running", "verifying"];

export function KeyHints({ focus, state, hasSelection, mode }: KeyHintsProps) {
  let keys: string;
  if (BUSY.includes(state)) keys = "Esc abort  Tab focus  r roster  q quit";
  else if (focus === "sessions")
    keys = `Up/Down move  Enter open log${hasSelection ? "  R resume  p pass  f fail" : ""}  Tab focus  r roster  q quit`;
  else if (focus === "log") keys = "Up/Down or j/k scroll  Tab focus  r roster  q quit";
  else if (state === "ranked" && mode === "dry-run") keys = "Enter to run this decision, Ctrl+D to leave dry-run";
  else keys = "Enter submit  Ctrl+D dry-run  Tab focus  Ctrl+C quit";
  return <Text dimColor wrap="truncate-end">[{focus}] {keys}</Text>;
}
